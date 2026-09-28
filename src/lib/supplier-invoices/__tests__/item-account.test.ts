/**
 * Moving a supplier-invoice line to another account keeps its dimensions.
 *
 * The registration verifikat aggregates the cost per (account, dimensions
 * bag). The move used to add every replacement line untagged and, on an
 * aggregated verifikat, strike every line on the old account whatever its
 * bag: the moved cost lost its projekt, and the costs of OTHER items on the
 * same account were merged into one untagged rest line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const { strikeLines } = vi.hoisted(() => ({ strikeLines: vi.fn() }))
vi.mock('@/lib/core/bookkeeping/journal-entry-corrections', () => ({
  strikeJournalEntryLines: (...args: unknown[]) => strikeLines(...args),
}))
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

import { planAccountMove, bookedItemDimensions, moveSupplierInvoiceItemAccount } from '../item-account'

const line = (
  id: string,
  account_number: string,
  debit_amount: number,
  dimensions: Record<string, string> = {},
  line_description: string | null = 'Leverantörsfaktura F-1',
) => ({ id, account_number, debit_amount, credit_amount: 0, line_description, dimensions })

describe('planAccountMove keeps the moved cost tagged and leaves other bags alone', () => {
  it('exact, tagged: of two equal amounts on the account, the line with the item\'s bag is moved, bag and all', () => {
    const plan = planAccountMove(
      [line('l1', '6110', 100, { '6': 'P001' }), line('l2', '6110', 100, { '6': 'P002' }), line('l3', '2641', 50)],
      '6110', '6550', 100, 'Kablar', { '6': 'P002' },
    )

    expect(plan).toEqual({
      strike: ['l2'],
      add: [{ account_number: '6550', debit_amount: 100, credit_amount: 0, line_description: 'Leverantörsfaktura F-1', dimensions: { '6': 'P002' } }],
    })
  })

  it('exact, retagged after posting: the replacement keeps the struck line\'s current bag', () => {
    const plan = planAccountMove(
      [line('l1', '6110', 100, { '6': 'P009' }), line('l2', '2641', 25)],
      '6110', '6550', 100, 'Kablar', { '6': 'P001' },
    )

    expect(plan?.strike).toEqual(['l1'])
    expect(plan?.add).toEqual([expect.objectContaining({ account_number: '6550', debit_amount: 100, dimensions: { '6': 'P009' } })])
  })

  it('aggregate with two bags on the account: only the matching bag\'s line is split, the other stays', () => {
    // Items A (P001, 100) and C (P001, 200) were aggregated on one line; item
    // B (P002, 100) has its own. The old planner took B's line for A, since
    // it carries exactly A's amount.
    const plan = planAccountMove(
      [line('l1', '6110', 300, { '6': 'P001' }), line('l2', '6110', 100, { '6': 'P002' })],
      '6110', '6550', 100, 'Kablar', { '6': 'P001' },
    )

    expect(plan).toEqual({
      strike: ['l1'],
      add: [
        { account_number: '6110', debit_amount: 200, credit_amount: 0, line_description: 'Leverantörsfaktura F-1', dimensions: { '6': 'P001' } },
        { account_number: '6550', debit_amount: 100, credit_amount: 0, line_description: 'Kablar', dimensions: { '6': 'P001' } },
      ],
    })
  })

  it('an untagged item never takes a tagged neighbour\'s cost into its untagged rest line', () => {
    const plan = planAccountMove(
      [line('l1', '6110', 300), line('l2', '6110', 500, { '6': 'P001' })],
      '6110', '6550', 100, 'Kablar',
    )

    expect(plan).toEqual({
      strike: ['l1'],
      add: [
        { account_number: '6110', debit_amount: 200, credit_amount: 0, line_description: 'Leverantörsfaktura F-1' },
        { account_number: '6550', debit_amount: 100, credit_amount: 0, line_description: 'Kablar' },
      ],
    })
  })

  it('keys an account dimension rule added at booking stay on the moved line', () => {
    const plan = planAccountMove(
      [line('l1', '6110', 100, { '1': 'KS01', '6': 'P001' }), line('l2', '6110', 100, { '1': 'KS01', '6': 'P002' })],
      '6110', '6550', 100, 'Kablar', { '6': 'P001' },
    )

    expect(plan?.strike).toEqual(['l1'])
    expect(plan?.add[0]?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it('refuses rather than guesses when two other bags could each be the item\'s', () => {
    expect(
      planAccountMove(
        [line('l1', '6110', 100, { '6': 'P002' }), line('l2', '6110', 100, { '6': 'P003' })],
        '6110', '6550', 100, 'Kablar', { '6': 'P001' },
      ),
    ).toBeNull()
  })

  it('bookedItemDimensions merges the item\'s bag over the invoice default, as the registration did', () => {
    expect(bookedItemDimensions({ '1': 'KS01', '6': 'P001' }, { '6': 'P002' })).toEqual({ '1': 'KS01', '6': 'P002' })
    expect(bookedItemDimensions(null, null)).toEqual({})
  })
})

describe('moveSupplierInvoiceItemAccount carries the bag into the rättelse', () => {
  const invoiceRow = {
    id: 'inv-1',
    status: 'registered',
    registration_journal_entry_id: 'je-1',
    default_dimensions: { '1': 'KS01' },
  }
  const itemRow = { id: 'item-1', account_number: '6110', line_total: 100, description: 'Kablar', dimensions: { '6': 'P001' } }
  const verifikat = [
    line('l1', '6110', 300, { '1': 'KS01', '6': 'P001' }),
    line('l2', '6110', 100, { '1': 'KS01', '6': 'P002' }),
    line('l3', '2641', 100, { '1': 'KS01' }),
  ]
  const ctx = (supabase: unknown) => ({
    supabase: supabase as never,
    companyId: 'company-1',
    userId: 'user-1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('strikes only the item\'s line and adds the split lines with its bag', async () => {
    const { supabase } = createTableMockSupabase({
      supplier_invoices: { data: invoiceRow },
      supplier_invoice_items: [{ data: itemRow }, { data: [{ id: 'item-1' }] }],
      journal_entry_lines: { data: verifikat },
    })
    strikeLines.mockResolvedValue({ ok: true, data: {} })

    const outcome = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'item-1', '6550')

    expect(outcome).toEqual({ ok: true, data: { changed: true, corrected: true } })
    expect(strikeLines).toHaveBeenCalledWith(expect.anything(), 'je-1', {
      strike_line_ids: ['l1'],
      lines: [
        { account_number: '6110', debit_amount: 200, credit_amount: 0, line_description: 'Leverantörsfaktura F-1', dimensions: { '1': 'KS01', '6': 'P001' } },
        { account_number: '6550', debit_amount: 100, credit_amount: 0, line_description: 'Kablar', dimensions: { '1': 'KS01', '6': 'P001' } },
      ],
    })
  })

  it('the dry run shows the bag the moved cost keeps and hands the tagged lines to the rättelse preview', async () => {
    const { supabase } = createTableMockSupabase({
      supplier_invoices: { data: invoiceRow },
      supplier_invoice_items: { data: itemRow },
      journal_entry_lines: { data: verifikat },
    })
    strikeLines.mockImplementation(async (_ctx, _entryId, input) => ({ ok: true, dryRun: true, preview: { added_lines: input.lines } }))

    const outcome = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'item-1', '6550', { dryRun: true })

    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a dry-run preview')
    const preview = outcome.preview as {
      dimensions: Record<string, string>
      rattelse: { added_lines: Array<{ dimensions: Record<string, string> }> }
    }
    expect(preview.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(preview.rattelse.added_lines.map((l) => l.dimensions)).toEqual([
      { '1': 'KS01', '6': 'P001' },
      { '1': 'KS01', '6': 'P001' },
    ])
    expect(strikeLines).toHaveBeenCalledWith(expect.anything(), 'je-1', expect.objectContaining({ strike_line_ids: ['l1'] }), { dryRun: true })
  })

  it('reverts the item and answers SI_ITEM_ACCOUNT_NO_MATCHING_LINE when the lines are ambiguous', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      supplier_invoices: { data: { ...invoiceRow, default_dimensions: {} } },
      supplier_invoice_items: [{ data: itemRow }, { data: [{ id: 'item-1' }] }, { data: null }],
      journal_entry_lines: { data: [line('l1', '6110', 100, { '6': 'P002' }), line('l2', '6110', 100, { '6': 'P003' })] },
    })

    const outcome = await moveSupplierInvoiceItemAccount(ctx(supabase), 'inv-1', 'item-1', '6550')

    expect(outcome).toMatchObject({ ok: false, code: 'SI_ITEM_ACCOUNT_NO_MATCHING_LINE' })
    expect(strikeLines).not.toHaveBeenCalled()
    expect(findCalls('supplier_invoice_items', 'update').map((c) => c[0])).toEqual([
      { account_number: '6550' },
      { account_number: '6110' },
    ])
  })
})
