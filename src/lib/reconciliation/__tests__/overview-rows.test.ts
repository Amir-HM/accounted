import { describe, it, expect } from 'vitest'
import { dropProposedLedgerDuplicates } from '../overview-rows'
import type { ReconciliationItem, ReconciliationProposal } from '../schemas'

function bankRow(id: string, bucket: ReconciliationItem['bucket'], proposal: ReconciliationProposal | null = null): ReconciliationItem {
  return {
    item_id: id,
    item_type: 'transaction',
    side: 'external',
    bucket,
    date: '2026-08-02',
    description: 'KORTKÖP',
    amount: -1250,
    currency: 'SEK',
    proposal,
    actions: bucket === 'proposed' ? ['match', 'book', 'ignore'] : ['book', 'match', 'ignore'],
  }
}

function ledgerRow(entryId: string, voucherNumber: number): ReconciliationItem {
  return {
    item_id: entryId,
    item_type: 'journal_entry',
    side: 'ledger',
    bucket: 'unmatched_ledger',
    date: '2026-08-03',
    description: `Verifikat ${voucherNumber}`,
    amount: -1250,
    currency: 'SEK',
    voucher_number: voucherNumber,
    voucher_series: 'A',
    entry_status: 'posted',
    actions: ['match', 'review'],
  }
}

function proposalFor(entryId: string, extra: Partial<ReconciliationProposal> = {}): ReconciliationProposal {
  return {
    journal_entry_id: entryId,
    voucher_number: 12,
    voucher_series: 'A',
    entry_date: '2026-08-03',
    description: 'Kontorsvaror',
    entry_status: 'posted',
    confidence: 0.85,
    reasons: ['auto_date_range'],
    ...extra,
  }
}

const ids = (items: ReconciliationItem[]) => items.map((i) => i.item_id)

describe('dropProposedLedgerDuplicates', () => {
  it('lists a verifikat proposed 1:1 for a bank row only in its pair, and keeps every other ledger row', () => {
    const items = [
      bankRow('t-prop', 'proposed', proposalFor('e-2')),
      bankRow('t-open', 'unmatched_external'),
      ledgerRow('e-2', 12),
      ledgerRow('e-3', 13),
    ]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-prop', 't-open', 'e-3'])
  })

  it('drops every verifikat of a covering-set proposal', () => {
    const set = proposalFor('e-57', {
      reasons: ['exact_sum_same_date'],
      vouchers: [
        { journal_entry_id: 'e-57', voucher_number: 57, voucher_series: 'A', entry_date: '2026-07-31', description: 'Inbetalning 1', amount: 600 },
        { journal_entry_id: 'e-58', voucher_number: 58, voucher_series: 'A', entry_date: '2026-07-31', description: 'Inbetalning 2', amount: 400 },
      ],
    })
    const items = [bankRow('t-bg', 'proposed', set), ledgerRow('e-57', 57), ledgerRow('e-58', 58), ledgerRow('e-59', 59)]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-bg', 'e-59'])
  })

  it('keeps the verifikat when the row pointing at it is not a live proposal (ignored or already matched)', () => {
    // A stale potential_journal_entry_id on an ignored row never gets linked:
    // the verifikat is still work on the ledger side.
    const items = [
      bankRow('t-ign', 'ignored', proposalFor('e-2')),
      bankRow('t-link', 'matched', proposalFor('e-3')),
      ledgerRow('e-2', 12),
      ledgerRow('e-3', 13),
    ]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-ign', 't-link', 'e-2', 'e-3'])
  })

  it('never drops a bank row that shares an id with a proposed verifikat, only the ledger listing', () => {
    const items = [bankRow('t-prop', 'proposed', proposalFor('x-1')), bankRow('x-1', 'unmatched_external'), ledgerRow('x-1', 1)]
    expect(ids(dropProposedLedgerDuplicates(items))).toEqual(['t-prop', 'x-1'])
    expect(dropProposedLedgerDuplicates(items).find((i) => i.item_id === 'x-1')?.side).toBe('external')
  })

  it('returns the list untouched when nothing is proposed', () => {
    const items = [bankRow('t-open', 'unmatched_external'), ledgerRow('e-2', 12)]
    expect(dropProposedLedgerDuplicates(items)).toBe(items)
    expect(dropProposedLedgerDuplicates([])).toEqual([])
  })
})
