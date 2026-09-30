/**
 * Issue #3313: the year-end close splits next year's IB per project.
 *
 * The per-account totals must equal the one-line-per-account IB exactly (the
 * continuity check and every tag-blind reader depend on it); the per-project
 * lines carry each project's closing balance; a project archived during the
 * year must not block the close; and a failure of the split itself (it runs
 * after the period was closed) falls back to the per-account IB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryLineInput } from '@/types'

vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'ib-2027' })),
  reverseEntry: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { buildOpeningBalanceLines, fetchObjectClosingBalances } from '../opening-balance-split'
import { generateOpeningBalances } from '../year-end-service'

type Result = { data?: unknown; error?: unknown }

/** Table-routed FIFO client; rpc results keyed `rpc:<name>`. Records calls. */
function makeClient(queues: Record<string, Result[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const chain = (table: string, result: Result): unknown =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: null, error: null, ...result })
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            if (prop === 'single' || prop === 'maybeSingle') return Promise.resolve({ data: null, error: null, ...result })
            return chain(table, result)
          }
        },
      }
    )
  const take = (key: string): Result => queues[key]?.shift() ?? {}
  const client = {
    from: vi.fn((table: string) => chain(table, take(table))),
    rpc: vi.fn(async (name: string, args: unknown) => {
      calls.push({ table: `rpc:${name}`, method: 'rpc', args: [args] })
      return { data: null, error: null, ...take(`rpc:${name}`) }
    }),
  }
  return { client, calls }
}

function netByBag(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    const key = `${line.account_number}${line.dimensions ? ' ' + JSON.stringify(line.dimensions) : ''}`
    out[key] = Math.round(((out[key] ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100
  }
  return out
}

function netByAccount(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    out[line.account_number] = Math.round(((out[line.account_number] ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100
  }
  return out
}

const TB_ROWS = [
  { account_number: '1470', account_name: 'Pågående arbeten', account_class: 1, closing_debit: 2100, closing_credit: 0 },
  { account_number: '1510', account_name: 'Kundfordringar', account_class: 1, closing_debit: 500.004, closing_credit: 0 },
  { account_number: '1930', account_name: 'Företagskonto', account_class: 1, closing_debit: 0.004, closing_credit: 0 },
  { account_number: '2099', account_name: 'Årets resultat', account_class: 2, closing_debit: 0, closing_credit: 2600 },
  { account_number: '3010', account_name: 'Försäljning', account_class: 3, closing_debit: 0, closing_credit: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildOpeningBalanceLines', () => {
  const accounts = TB_ROWS.filter((r) => r.account_class <= 2).map((r) => ({
    account_number: r.account_number,
    account_name: r.account_name,
    net: r.closing_debit - r.closing_credit,
  }))

  it('keeps every account total exactly as the one-line-per-account IB booked it', () => {
    const lines = buildOpeningBalanceLines(accounts, new Map([
      ['1470', [{ dimensions: { '6': 'P1' }, amount: 1300 }, { dimensions: { '6': 'P2' }, amount: 500 }]],
      ['1510', [{ dimensions: { '6': 'P1' }, amount: 700 }]],
    ]))
    // The unsplit IB: 1470 2100, 1510 500 (öre-rounded), 1930 below tolerance, 2099 -2600.
    expect(netByAccount(lines)).toEqual({ '1470': 2100, '1510': 500, '2099': -2600 })
    expect(netByBag(lines)).toEqual({
      '1470 {"6":"P1"}': 1300,
      '1470 {"6":"P2"}': 500,
      '1470': 300,
      '1510 {"6":"P1"}': 700,
      '1510': -200,
      '2099': -2600,
    })
    expect(lines.every((l) => l.line_description?.startsWith('Ingående balans: '))).toBe(true)
  })

  it('is the per-account IB line for line when nothing is tagged', () => {
    expect(buildOpeningBalanceLines(accounts, new Map())).toEqual([
      { account_number: '1470', debit_amount: 2100, credit_amount: 0, line_description: 'Ingående balans: Pågående arbeten' },
      { account_number: '1510', debit_amount: 500, credit_amount: 0, line_description: 'Ingående balans: Kundfordringar' },
      { account_number: '2099', debit_amount: 0, credit_amount: 2600, line_description: 'Ingående balans: Årets resultat' },
    ])
  })

  it('carries offsetting projects on an account whose total is zero', () => {
    const lines = buildOpeningBalanceLines(
      [{ account_number: '1930', account_name: 'Företagskonto', net: 0.004 }],
      new Map([['1930', [{ dimensions: { '6': 'P1' }, amount: 40 }, { dimensions: { '6': 'P2' }, amount: -40 }]]])
    )
    expect(netByBag(lines)).toEqual({ '1930 {"6":"P1"}': 40, '1930 {"6":"P2"}': -40 })
    expect(netByAccount(lines)).toEqual({ '1930': 0 })
  })
})

describe('fetchObjectClosingBalances', () => {
  it('asks for the registry\'s accumulating dimensions and groups the rows per account', async () => {
    const { client, calls } = makeClient({
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{
        data: [
          { account_number: '1470', dimensions: { '6': 'P1' }, net: '1300.00' },
          { account_number: '1470', dimensions: { '6': 'P2' }, net: 500 },
          { account_number: '1510', dimensions: { '6': 'P1' }, net: 0 },
        ],
      }],
    })
    const result = await fetchObjectClosingBalances(client as never, 'co-1', 'fp-2026')
    expect(calls).toContainEqual({ table: 'dimensions', method: 'eq', args: ['resets_annually', false] })
    expect(client.rpc).toHaveBeenCalledWith('compute_object_closing_balances', {
      p_company_id: 'co-1',
      p_fiscal_period_id: 'fp-2026',
      p_dim_nos: ['6'],
    })
    expect([...result]).toEqual([
      ['1470', [{ dimensions: { '6': 'P1' }, amount: 1300 }, { dimensions: { '6': 'P2' }, amount: 500 }]],
    ])
  })

  it('does not call the RPC when no dimension accumulates', async () => {
    const { client } = makeClient({ dimensions: [{ data: [] }] })
    expect((await fetchObjectClosingBalances(client as never, 'co-1', 'fp')).size).toBe(0)
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('throws on a registry or RPC error (the caller decides the fallback)', async () => {
    const registryDown = makeClient({ dimensions: [{ error: { message: 'down' } }] })
    await expect(fetchObjectClosingBalances(registryDown.client as never, 'co-1', 'fp')).rejects.toThrow(/registry/)
    const rpcDown = makeClient({
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{ error: { message: 'timeout' } }],
    })
    await expect(fetchObjectClosingBalances(rpcDown.client as never, 'co-1', 'fp')).rejects.toThrow(/timeout/)
  })
})

describe('generateOpeningBalances: next year\'s IB split per project', () => {
  const NEXT = { id: 'fp-2027', name: '2027', period_start: '2027-01-01', period_end: '2027-12-31' }

  it('books the split IB with the replayed bags, so an archived project cannot block the close', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: TB_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
    const { client } = makeClient({
      fiscal_periods: [{ data: NEXT }, { error: null }],
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{
        data: [{ account_number: '1470', dimensions: { '6': 'P-ARKIV' }, net: 1300 }],
      }],
    })

    const entry = await generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')

    expect(entry).toEqual({ id: 'ib-2027' })
    const call = vi.mocked(createJournalEntry).mock.calls[0]
    const input = call[3]
    expect(input).toMatchObject({ fiscal_period_id: 'fp-2027', entry_date: '2027-01-01', source_type: 'opening_balance' })
    expect(netByBag(input.lines)).toEqual({
      '1470 {"6":"P-ARKIV"}': 1300,
      '1470': 800,
      '1510': 500,
      '2099': -2600,
    })
    expect(call[6]).toEqual({ replayDimensions: true })
  })

  it('falls back to one line per account when the split cannot be computed (never an IB-less closed year)', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: TB_ROWS, totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
    const { client } = makeClient({
      fiscal_periods: [{ data: NEXT }, { error: null }],
      dimensions: [{ data: [{ sie_dim_no: 6 }] }],
      'rpc:compute_object_closing_balances': [{ error: { message: 'statement timeout' } }],
    })

    await generateOpeningBalances(client as never, 'co-1', 'user-1', 'fp-2026', 'fp-2027')

    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.lines.every((l) => l.dimensions === undefined)).toBe(true)
    expect(netByBag(input.lines)).toEqual({ '1470': 2100, '1510': 500, '2099': -2600 })
  })
})
