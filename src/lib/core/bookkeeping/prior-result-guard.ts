import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'
import type { TrialBalanceRow } from '@/types'

/**
 * Two year-end guards on the form's "årets resultat" account (aktiebolag 2099,
 * ideell förening 2069; an enskild firma closes straight into 2010 and has no
 * such account). BAS: the account only ever holds the current year's result;
 * last year's result is moved off at year start and disposed after the annual
 * meeting (swedish-year-end-closing, pitfalls-and-rates.md 5).
 */

/**
 * Balance on the result account before the closing entry, credit-positive
 * (0 when within ORE_TOLERANCE or absent).
 *
 * Before a close this must be zero. A balance means a prior year's result is
 * still sitting there, typically carried in by imported opening balances that
 * no Accounted year-end ever moved. Closing on top of it adds this year's
 * result to it, and the balance sheet's "Årets resultat" then no longer
 * matches the income statement (PostHog PH 120).
 */
export function resultAccountLeftover(
  rows: Pick<TrialBalanceRow, 'account_number' | 'closing_debit' | 'closing_credit'>[],
  resultAccount: string,
): number {
  const row = rows.find((r) => r.account_number === resultAccount)
  if (!row) return 0
  const net = roundOre(row.closing_credit - row.closing_debit)
  return Math.abs(net) < ORE_TOLERANCE ? 0 : net
}

/**
 * How much of the carried-in prior result the automatic omföring still has to
 * move, credit-positive like `ibNet`, given the net effect on the result
 * account of dispositions the owner already booked by hand in the same period
 * (`handBookedNet`, also credit-positive).
 *
 * Returns 0 when the hand bookings already moved it all, or moved more than was
 * carried in (never add an omföring on top of that), and never more than was
 * carried in: a hand booking in the same direction as the carry is not a
 * disposition of it. Without this the omföring duplicated a disposition the
 * owner had booked before running the close (PostHog PH 108).
 */
export function remainingCarry(ibNet: number, handBookedNet: number): number {
  if (Math.abs(ibNet) < ORE_TOLERANCE) return 0
  const remaining = roundOre(ibNet + handBookedNet)
  if (Math.abs(remaining) < ORE_TOLERANCE) return 0
  if (Math.sign(remaining) !== Math.sign(ibNet)) return 0
  if (Math.abs(remaining) > Math.abs(ibNet)) return ibNet
  return remaining
}

/** One live journal entry in the period, with its lines on the equity accounts. */
export interface CarryEntry {
  sourceType: string | null
  /** e.g. "A12", for logs and messages. */
  voucher: string
  lines: Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }>
}

/** Entries the year-end machinery writes that never dispose of a carried result. */
const NOT_A_DISPOSITION = new Set(['opening_balance', 'year_end', 'storno'])

/**
 * Credit-positive amount the period's live entries moved off the carried-in
 * prior result (`ibNet`): the automatic omföring (result_appropriation) and
 * dispositions booked by hand, meaning entries that also touch one of
 * `dispositionAccounts` (the carry or balanserat resultat account).
 *
 * Only result-account lines that go against the carry count. A hand-booked
 * disposition often also re-homes this year's result onto the same account in
 * the same verifikat (PostHog PH 108: Dr 2069 for last year's result and
 * Cr 2069 for this year's), and that line is not a disposition of the
 * carry. A voided entry counts as none: the original is not live and its
 * storno is excluded.
 */
export function movedOffCarry(
  entries: CarryEntry[],
  resultAccount: string,
  dispositionAccounts: string[],
  ibNet: number,
): { net: number; vouchers: string[] } {
  if (Math.abs(ibNet) < ORE_TOLERANCE) return { net: 0, vouchers: [] }
  let net = 0
  const vouchers: string[] = []
  for (const entry of entries) {
    if (NOT_A_DISPOSITION.has(entry.sourceType ?? '')) continue
    const isOmforing = entry.sourceType === 'result_appropriation'
    if (!isOmforing && !entry.lines.some((l) => dispositionAccounts.includes(l.account_number))) continue
    let moved = 0
    for (const line of entry.lines) {
      if (line.account_number !== resultAccount) continue
      // A profit is carried as a credit and moved off with a debit; a loss the other way.
      moved += ibNet > 0 ? -Number(line.debit_amount) : Number(line.credit_amount)
    }
    if (Math.abs(moved) >= ORE_TOLERANCE) {
      net += moved
      vouchers.push(entry.voucher)
    }
  }
  return { net: roundOre(net), vouchers }
}
