import type { ReconciliationItem } from './schemas'

/**
 * The Avstämning overview's rows, with each verifikat shown once.
 *
 * A proposal is not a link, so the ledger bucket (get_unlinked_gl_lines on
 * a bank account, the unlinked 1630 entries on the skattekonto) still holds
 * the verifikat a row is proposed against. On the overview that listed it
 * twice: in the proposed pair, where "Koppla" settles it, and again under
 * "I bokföringen, saknas på banken", where the only button is "Granska" and
 * the page reads as if the bank never had the payment. This drops the second
 * listing, for a 1:1 proposal and for every verifikat of a covering set.
 *
 * Display only, on purpose. The unmatched_ledger bucket from the API keeps
 * the verifikat: "Matcha manuellt", MCP and v1 read it to override a
 * proposal. The status counts and the bridge keep counting it as unmatched
 * until the pair is linked, because the bank row and the verifikat are both
 * reconciling lines until then.
 */
export function dropProposedLedgerDuplicates(items: ReconciliationItem[]): ReconciliationItem[] {
  const proposed = new Set<string>()
  for (const item of items) {
    if (item.bucket !== 'proposed' || !item.proposal) continue
    proposed.add(item.proposal.journal_entry_id)
    for (const v of item.proposal.vouchers ?? []) proposed.add(v.journal_entry_id)
  }
  if (proposed.size === 0) return items
  return items.filter(
    (item) => !(item.bucket === 'unmatched_ledger' && item.item_type === 'journal_entry' && proposed.has(item.item_id)),
  )
}
