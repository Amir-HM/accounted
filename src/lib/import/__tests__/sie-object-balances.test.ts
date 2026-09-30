/**
 * Issue #3313: SIE #OIB/#OUB split the IB per project.
 *
 * Before, the parser counted object balance rows and dropped them ("balanser
 * per objekt stöds inte ännu"), and the IB verifikat got one untagged line
 * per account. Now each account's IB is split into one line per object of an
 * accumulating dimension plus an untagged remainder; the account total is
 * the #IB amount exactly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput } from '@/types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  replaceOpeningBalanceEntry: vi.fn(async () => ({
    newEntryId: 'ob-new',
    stornoEntryId: 'ob-storno',
    newVoucherNumber: 2,
    stornoVoucherNumber: 1,
  })),
}))

import { replaceOpeningBalanceEntry } from '@/lib/bookkeeping/engine'
import { parseSIEFile, getEffectiveObjectOpeningBalances } from '../sie-parser'
import { buildSIEOpeningBalanceEntry, resyncNextPeriodOpeningBalance, validateIBBalance } from '../sie-import'
import { planObjectBalances, splitBalanceLines } from '../sie-object-balances'
import { collectSIEDimensionUsage } from '../sie-dimensions'
import { toPrepared } from '../sie-job-preparation'
import type { ParsedSIEFile, SIEObjectBalance } from '../types'

const ACC6 = new Set(['6'])

function sie(...body: string[]): string {
  return ['#FLAGGA 0', '#SIETYP 4', '#RAR 0 20260101 20261231', '#RAR -1 20250101 20251231', ...body].join('\n')
}

function identity(parsed: ParsedSIEFile): Map<string, string> {
  return new Map(parsed.accounts.map((a) => [a.number, a.number]))
}

/** Net per (account, bag) of a line set: debit positive. */
function netByBag(lines: CreateJournalEntryLineInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    const key = `${line.account_number}${line.dimensions ? ' ' + JSON.stringify(line.dimensions) : ''}`
    out[key] = Math.round(((out[key] ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100
  }
  return out
}

function obRow(account: string, dimNo: string, code: string, amount: number): SIEObjectBalance {
  return { yearIndex: 0, account, dimNo, code, amount }
}

describe('parseSIEFile: #OIB / #OUB', () => {
  it('parses one object per row and warns on a row with none or several', () => {
    const parsed = parseSIEFile(
      sie(
        '#IB 0 1470 3000.00',
        '#OIB 0 1470 {6 "P1"} 1000.00 2',
        '#OIB 0 1470 {} 50.00',
        '#OIB 0 1470 {1 "K1" 6 "P2"} 50.00',
        '#OUB 0 1470 {"06" "P1"} 1200.00'
      )
    )
    expect(parsed.objectOpeningBalances).toEqual([
      { yearIndex: 0, account: '1470', dimNo: '6', code: 'P1', amount: 1000, quantity: 2 },
    ])
    expect(parsed.objectClosingBalances).toEqual([
      { yearIndex: 0, account: '1470', dimNo: '6', code: 'P1', amount: 1200 },
    ])
    const warnings = parsed.issues.filter((i) => i.severity === 'warning' && i.tag === 'OIB')
    expect(warnings).toHaveLength(2)
    expect(warnings[0].message).toContain('exakt ett objekt')
  })

  it('reports skipped rows by reason, with counts, never silently', () => {
    const parsed = parseSIEFile(
      sie(
        '#IB 0 1470 3000.00',
        '#IB 0 1510 500.00',
        '#OIB 0 1470 {6 "P1"} 1000.00',
        '#OIB 0 1510 {1 "K1"} 200.00',
        '#OIB 0 1510 {1 "K2"} 100.00',
        '#OIB 0 3010 {6 "P1"} -400.00'
      )
    )
    const messages = parsed.issues.filter((i) => i.tag === 'OIB').map((i) => i.message)
    expect(messages).toEqual([
      expect.stringMatching(/^1 objektbalanser \(#OIB\) fördelar den ingående balansen per projekt på 1 konton/),
      expect.stringMatching(/^1 objektbalanser \(#OIB\) på resultatkonton hoppas över/),
      expect.stringMatching(/^2 objektbalanser \(#OIB\) på dimensioner som nollställs vid årsskiftet/),
    ])
  })

  it('warns when #OUB 0 disagrees with #OIB 0 plus the tagged movements in the file', () => {
    const parsed = parseSIEFile(
      sie(
        '#IB 0 1470 1000.00',
        '#OIB 0 1470 {6 "P1"} 1000.00',
        '#OUB 0 1470 {6 "P1"} 1250.00',
        '#VER A 1 20260115 "Arbete"',
        '{',
        '#TRANS 1470 {6 "P1"} 200.00',
        '#TRANS 4010 {6 "P1"} -200.00',
        '}'
      )
    )
    const oub = parsed.issues.filter((i) => i.tag === 'OUB')
    expect(oub).toHaveLength(1)
    expect(oub[0].severity).toBe('warning')
    expect(oub[0].message).toContain('konto 1470 objekt 6 "P1"')

    const consistent = parseSIEFile(
      sie(
        '#IB 0 1470 1000.00',
        '#OIB 0 1470 {6 "P1"} 1000.00',
        '#OUB 0 1470 {6 "P1"} 1200.00',
        '#VER A 1 20260115 "Arbete"',
        '{',
        '#TRANS 1470 {6 "P1"} 200.00',
        '#TRANS 4010 {6 "P1"} -200.00',
        '}'
      )
    )
    expect(consistent.issues.some((i) => i.tag === 'OUB')).toBe(false)
  })

  it('says the rows go unused when the file has no IB to split', () => {
    const parsed = parseSIEFile(sie('#OIB 0 1470 {6 "P1"} 1000.00'))
    expect(parsed.issues.some((i) => i.tag === 'OIB' && i.message.includes('används inte'))).toBe(true)
  })
})

describe('planObjectBalances', () => {
  it('keeps accumulating dimensions on balance-sheet accounts and sums duplicates', () => {
    const plan = planObjectBalances(
      [obRow('1470', '6', 'P1', 600), obRow('1470', '6', 'P1', 400), obRow('1470', '6', 'P2', -50), obRow('1470', '6', 'P3', 0)],
      ACC6
    )
    expect(plan.byAccount.get('1470')).toEqual([
      { dimensions: { '6': 'P1' }, amount: 1000 },
      { dimensions: { '6': 'P2' }, amount: -50 },
    ])
    expect(plan.applied).toBe(4)
  })

  it('uses the registry, not the SIE number: a resetting dimension 6 carries nothing', () => {
    const plan = planObjectBalances([obRow('1470', '6', 'P1', 100), obRow('1470', '7', 'X', 100)], new Set(['7']))
    expect(plan.byAccount.get('1470')).toEqual([{ dimensions: { '7': 'X' }, amount: 100 }])
    expect(plan.skipped.resetting_dimension).toBe(1)
  })

  it('splits on projekt when an account has objects on two accumulating dimensions, and says so', () => {
    const plan = planObjectBalances([obRow('1470', '7', 'X', 100), obRow('1470', '6', 'P1', 300)], new Set(['6', '7']))
    expect(plan.byAccount.get('1470')).toEqual([{ dimensions: { '6': 'P1' }, amount: 300 }])
    expect(plan.skipped.second_dimension).toBe(1)
    expect(plan.multiDimensionAccounts).toEqual([{ account: '1470', usedDimNo: '6', ignoredDimNos: ['7'] }])
  })

  it('skips codes the registry cannot hold', () => {
    const plan = planObjectBalances([obRow('1470', '6', 'a"b', 100), obRow('1470', '6', 'x'.repeat(41), 1)], ACC6)
    expect(plan.byAccount.size).toBe(0)
    expect(plan.skipped.invalid_code).toBe(2)
  })
})

describe('splitBalanceLines', () => {
  it('books each object and the remainder, netting to the total in either sign', () => {
    const lines = splitBalanceLines('1470', 3000, [{ dimensions: { '6': 'P1' }, amount: 1000 }], 'IB 1470')
    expect(lines).toEqual([
      { account_number: '1470', debit_amount: 1000, credit_amount: 0, line_description: 'IB 1470', dimensions: { '6': 'P1' } },
      { account_number: '1470', debit_amount: 2000, credit_amount: 0, line_description: 'IB 1470' },
    ])
    // An object larger than the account: the remainder is negative.
    expect(netByBag(splitBalanceLines('1470', 100, [{ dimensions: { '6': 'P1' }, amount: 250 }], 'x'))).toEqual({
      '1470 {"6":"P1"}': 250,
      '1470': -150,
    })
  })

  it('omits a zero remainder and keeps offsetting objects on a zero total', () => {
    expect(splitBalanceLines('1470', 1000, [{ dimensions: { '6': 'P1' }, amount: 1000 }], 'x')).toHaveLength(1)
    expect(
      netByBag(
        splitBalanceLines('1470', 0, [
          { dimensions: { '6': 'P1' }, amount: 100 },
          { dimensions: { '6': 'P2' }, amount: -100 },
        ], 'x')
      )
    ).toEqual({ '1470 {"6":"P1"}': 100, '1470 {"6":"P2"}': -100 })
  })
})

describe('buildSIEOpeningBalanceEntry: the IB split per project', () => {
  it('books X tagged {"6":"P1"} and Y - X untagged on 1470 (the acceptance case)', () => {
    const parsed = parseSIEFile(
      sie('#IB 0 1470 5000.00', '#IB 0 2081 -5000.00', '#OIB 0 1470 {6 "P1"} 1200.00')
    )
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(netByBag(entry.lines)).toEqual({
      '1470 {"6":"P1"}': 1200,
      '1470': 3800,
      '2081': -5000,
    })
    // Account totals, and so the balance check, are the #IB amounts.
    expect(validateIBBalance(parsed, identity(parsed)).roundingAdjustment).toBe(0)
  })

  it('defaults to the SIE convention (projekt) when no registry set is passed', () => {
    const parsed = parseSIEFile(sie('#IB 0 1470 5000.00', '#IB 0 2081 -5000.00', '#OIB 0 1470 {6 "P1"} 1200.00'))
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099')!
    expect(netByBag(entry.lines)['1470 {"6":"P1"}']).toBe(1200)
  })

  it('leaves a kostnadsställe (#OIB on dimension 1) and a result account untagged', () => {
    const parsed = parseSIEFile(
      sie('#IB 0 1470 5000.00', '#IB 0 2081 -5000.00', '#OIB 0 1470 {1 "K1"} 1200.00', '#OIB 0 3010 {6 "P1"} -99.00')
    )
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(netByBag(entry.lines)).toEqual({ '1470': 5000, '2081': -5000 })
  })

  it('splits a derived IB (#UB -1, no #IB 0) on #OUB -1', () => {
    const parsed = parseSIEFile(
      sie('#UB -1 1470 800.00', '#UB -1 2081 -800.00', '#OUB -1 1470 {6 "P1"} 300.00', '#OUB 0 1470 {6 "P1"} 999.00')
    )
    expect(getEffectiveObjectOpeningBalances(parsed).source).toBe('prior_year_oub')
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(entry.description).toContain('härledda')
    expect(netByBag(entry.lines)).toEqual({ '1470 {"6":"P1"}': 300, '1470': 500, '2081': -800 })
  })

  it('books the objects of an account without an #IB row (a zero IB) with an offsetting remainder', () => {
    const parsed = parseSIEFile(
      sie(
        '#KONTO 1470 "Pågående arbeten"',
        '#IB 0 1930 100.00',
        '#IB 0 2081 -100.00',
        '#OIB 0 1470 {6 "P1"} 40.00',
        '#OIB 0 1470 {6 "P2"} -40.00'
      )
    )
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(netByBag(entry.lines)).toEqual({ '1930': 100, '2081': -100, '1470 {"6":"P1"}': 40, '1470 {"6":"P2"}': -40 })
  })

  it('is byte-identical to the per-account IB for a file without object balances', () => {
    const parsed = parseSIEFile(sie('#IB 0 1470 5000.00', '#IB 0 2081 -5000.00'))
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, identity(parsed), 0, 'M', '2099', { accumulating: ACC6 })!
    expect(entry.lines).toEqual([
      { account_number: '1470', debit_amount: 5000, credit_amount: 0, line_description: 'IB 1470' },
      { account_number: '2081', debit_amount: 0, credit_amount: 5000, line_description: 'IB 2081' },
    ])
  })
})

describe('collectSIEDimensionUsage: object balance codes', () => {
  it('registers the objects #OIB/#OUB reference, leaving out codes the registry cannot hold', () => {
    const parsed = parseSIEFile(
      sie('#IB 0 1470 100.00', '#OIB 0 1470 {6 "P1"} 100.00', '#OUB 0 1470 {6 "P2"} 100.00', '#OIB 0 1470 {6 "a{b"} 1.00')
    )
    const usage = collectSIEDimensionUsage(parsed)
    expect([...usage.values.keys()].sort()).toEqual(['6 P1', '6 P2'])
    expect(usage.invalidCodes.size).toBe(0)
    expect(usage.dims.get(6)?.name).toBe('Projekt')
  })
})

describe('toPrepared (resumable job path): nets per account and project bag', () => {
  it('keeps the split lines apart and nets untagged lines per account as before', () => {
    const prepared = toPrepared(
      {
        fiscal_period_id: 'fp-1',
        entry_date: '2026-01-01',
        description: 'Ingående balanser från SIE-import',
        source_type: 'opening_balance',
        voucher_series: 'M',
        lines: [
          { account_number: '1470', debit_amount: 1200, credit_amount: 0, dimensions: { '6': 'P1' } },
          { account_number: '1470', debit_amount: 3000, credit_amount: 0 },
          { account_number: '1470', debit_amount: 800, credit_amount: 0 },
          { account_number: '2081', debit_amount: 0, credit_amount: 5000 },
        ],
      },
      { id: 'job-1' },
      50_000,
      new Map([['1470', 'acc-1470']])
    )
    expect(prepared.sourceId).toBe('IB')
    expect(prepared.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.dimensions, l.sort_order])).toEqual([
      ['1470', 1200, 0, { '6': 'P1' }, 0],
      ['1470', 3800, 0, {}, 1],
      ['2081', 0, 5000, {}, 2],
    ])
  })
})

describe('resyncNextPeriodOpeningBalance: splits on #OUB 0', () => {
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('books the next IB per project from the year\'s closing object balances', async () => {
    enqueue({
      data: {
        id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, opening_balance_entry_id: 'ob-old', opening_balances_set: true,
      },
    }) // fiscal_periods
    enqueue({ data: { voucher_series: 'A' } }) // journal_entries: the old IB
    enqueue({ data: [{ sie_dim_no: 6 }] }) // dimensions: accumulating

    const parsed = {
      closingBalances: [
        { yearIndex: 0, account: '1470', amount: 1000 },
        { yearIndex: 0, account: '2081', amount: -1000 },
      ],
      objectClosingBalances: [{ yearIndex: 0, account: '1470', dimNo: '6', code: 'P1', amount: 700 }],
    } as unknown as ParsedSIEFile

    const result = await resyncNextPeriodOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', 'user-1', '2025-12-31', parsed, new Map(), '2099',
    )
    expect(result).toMatchObject({ resynced: true })
    const input = vi.mocked(replaceOpeningBalanceEntry).mock.calls[0][4] as { lines: CreateJournalEntryLineInput[] }
    expect(netByBag(input.lines)).toEqual({ '1470 {"6":"P1"}': 700, '1470': 300, '2081': -1000 })
  })

  it('does not read the registry when the file has no closing object balances', async () => {
    enqueue({
      data: {
        id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31',
        is_closed: false, locked_at: null, opening_balance_entry_id: 'ob-old', opening_balances_set: true,
      },
    })
    enqueue({ data: { voucher_series: 'A' } })

    const parsed = {
      closingBalances: [
        { yearIndex: 0, account: '1930', amount: 1000 },
        { yearIndex: 0, account: '2081', amount: -1000 },
      ],
    } as unknown as ParsedSIEFile
    await resyncNextPeriodOpeningBalance(
      supabase as unknown as SupabaseClient, 'co-1', 'user-1', '2025-12-31', parsed, new Map(), '2099',
    )
    expect(supabase.from).toHaveBeenCalledTimes(2)
    const input = vi.mocked(replaceOpeningBalanceEntry).mock.calls[0][4] as { lines: CreateJournalEntryLineInput[] }
    expect(input.lines.every((l) => l.dimensions === undefined)).toBe(true)
  })
})
