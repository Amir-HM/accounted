/**
 * Account dimension rules (dimensions PR10) — the policy layer over the
 * dimensions substrate. Rules live in account_dimension_rules
 * (20260703200000), one per (account, dimension):
 *
 *   'required'  the account cannot be POSTED without a value → enforced by
 *               assertMandatoryDimensions at commitEntry and, for the
 *               bulk_book_transactions RPC that bypasses the engine, by
 *               enforceBulkBookDimensionPolicy in every bulk-book door
 *               (lib/transactions/bulk-book.ts). Drafts may be incomplete by
 *               design; storno/correction paths never pass through
 *               commitEntry, so history always reverses regardless of policy.
 *   'default'   pre-applied to the line bag at draft creation when the key
 *               is absent (user-overridable).
 *   'fixed'     ALWAYS applied at draft creation (overwrites the caller's
 *               key) — the account is pinned to one value.
 *
 * Zero rules (every company by default) short-circuits everything — the
 * engine behaves exactly as before PR10. Rule fetches FAIL OPEN like the
 * soft registry validation: a transient DB error must not block bookkeeping,
 * and the write hits the same database anyway.
 *
 * Pure of next/server so it stays importable from anywhere the resolver is.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { JournalEntrySourceType } from '@/types'
import {
  MandatoryDimensionMissingError,
  type MandatoryDimensionViolation,
} from './dimension-errors'
import {
  normalizeLineDimensions,
  type DimensionAliasInput,
  type LineDimensions,
} from './dimension-resolver'

export interface AccountDimensionRule {
  account_number: string
  rule_type: 'required' | 'default' | 'fixed'
  /** Canonical SIE dimension number as a string key, e.g. '6'. */
  sie_dim_no: string
  dimension_name: string
  /** Value code for default/fixed rules; null for required. */
  value_code: string | null
}

interface RawRuleRow {
  account_number: string
  rule_type: 'required' | 'default' | 'fixed'
  dimensions: { sie_dim_no: number; name: string }
  dimension_values: { code: string } | null
}

/**
 * All ACTIVE rules for the company. Returns null on query failure (callers
 * fail open — same posture as validateEntryDimensions). The table is tiny
 * and indexed on (company_id, account_number); one fetch per booking is the
 * whole cost for rule-less companies.
 */
export async function fetchActiveDimensionRules(
  supabase: SupabaseClient,
  companyId: string
): Promise<AccountDimensionRule[] | null> {
  // try/catch on top of the error-result check: fail-open must also cover
  // thrown exceptions (broken client, network throw) — policy lookups are
  // never allowed to take bookkeeping down with them.
  try {
    const { data, error } = await supabase
      .from('account_dimension_rules')
      .select(
        'account_number, rule_type, dimensions!account_dimension_rules_dimension_id_company_id_fkey(sie_dim_no, name), dimension_values!account_dimension_rules_value_id_fkey(code)'
      )
      .eq('company_id', companyId)
      .eq('is_active', true)

    if (error) return null

    return ((data ?? []) as unknown as RawRuleRow[]).map((row) => ({
      account_number: row.account_number,
      rule_type: row.rule_type,
      sie_dim_no: String(row.dimensions.sie_dim_no),
      dimension_name: row.dimensions.name,
      value_code: row.dimension_values?.code ?? null,
    }))
  } catch {
    return null
  }
}

/**
 * Apply default/fixed rules onto entry lines before validation + insert.
 * Returns the same array when nothing applies (zero allocation on the
 * common path); otherwise a copy where affected lines carry the augmented
 * bag (aliases folded in first, so the returned lines are bag-authoritative).
 */
export function applyDimensionRules<
  T extends DimensionAliasInput & { account_number: string },
>(lines: T[], rules: AccountDimensionRule[]): T[] {
  const applicable = rules.filter(
    (r) => (r.rule_type === 'default' || r.rule_type === 'fixed') && r.value_code
  )
  if (applicable.length === 0) return lines

  const byAccount = new Map<string, AccountDimensionRule[]>()
  for (const rule of applicable) {
    const bucket = byAccount.get(rule.account_number) ?? []
    bucket.push(rule)
    byAccount.set(rule.account_number, bucket)
  }

  let anyChanged = false
  const result = lines.map((line) => {
    const forAccount = byAccount.get(line.account_number)
    if (!forAccount) return line

    const bag: LineDimensions = normalizeLineDimensions(line)
    let changed = false
    for (const rule of forAccount) {
      if (rule.rule_type === 'fixed') {
        if (bag[rule.sie_dim_no] !== rule.value_code) {
          bag[rule.sie_dim_no] = rule.value_code as string
          changed = true
        }
      } else if (!(rule.sie_dim_no in bag)) {
        bag[rule.sie_dim_no] = rule.value_code as string
        changed = true
      }
    }
    if (!changed) return line
    anyChanged = true
    // The bag now carries everything (aliases folded by normalize) — clear
    // the deprecated aliases so downstream normalization can't resurrect a
    // value a fixed rule just overwrote.
    return { ...line, dimensions: bag, cost_center: null, project: null }
  })

  return anyChanged ? result : lines
}

/**
 * Throw MandatoryDimensionMissingError when any ACTIVE 'required' rule is
 * unsatisfied. One violation per (account, dimension) regardless of how many
 * lines miss it — the Swedish message stays readable for multi-line entries.
 */
export function assertMandatoryDimensions(
  lines: Array<DimensionAliasInput & { account_number: string }>,
  rules: AccountDimensionRule[]
): void {
  const required = rules.filter((r) => r.rule_type === 'required')
  if (required.length === 0) return

  const byAccount = new Map<string, AccountDimensionRule[]>()
  for (const rule of required) {
    const bucket = byAccount.get(rule.account_number) ?? []
    bucket.push(rule)
    byAccount.set(rule.account_number, bucket)
  }

  const violations = new Map<string, MandatoryDimensionViolation>()
  for (const line of lines) {
    const forAccount = byAccount.get(line.account_number)
    if (!forAccount) continue
    const bag = normalizeLineDimensions(line)
    for (const rule of forAccount) {
      if (!bag[rule.sie_dim_no]) {
        violations.set(`${line.account_number} ${rule.sie_dim_no}`, {
          account_number: line.account_number,
          sie_dim_no: rule.sie_dim_no,
          dimension_name: rule.dimension_name,
        })
      }
    }
  }

  if (violations.size > 0) {
    throw new MandatoryDimensionMissingError([...violations.values()])
  }
}

export type DimensionRulePolicy = 'enforced' | 'exempt'

/**
 * Dimension-rule policy for EVERY journal source type. A Record over the
 * JournalEntrySourceType union, so a new source type fails the typecheck
 * (and dimension-rules.test.ts, which pins every value of the Zod enum)
 * until someone decides which bucket it belongs in. Nothing is exempt by
 * omission.
 *
 * ENFORCED: the new business events the policy exists for. A user authors
 * or reviews the lines and can tag them, or the producer carries the tags of
 * the document it books:
 *   - manual, bank_transaction, inbox_item: lines written in a booking form;
 *   - invoice_* and supplier_invoice_* registrations, payments and cash
 *     payments, salary_payment: flows a user drives from the document; the
 *     registrations carry the invoice's bags and payroll the employee's;
 *   - webshop_order, expense_claim: the order dialog and the claim lines
 *     take tags;
 *   - reminder_fee: new revenue (3990) of the reminded invoice; both legs
 *     carry that invoice's bag, so a required rule is met whenever the
 *     invoice was tagged, and a fee whose booking fails is not charged.
 *
 * EXEMPT: entries that carry no user-supplied tag and replay, derive or
 * settle something already decided. A required rule could never be
 * satisfied there, and a default/fixed rule would re-tag one side only:
 *   - opening_balance, import: historical/derived data must land verbatim;
 *     injecting defaults or refusing untagged history would falsify the
 *     record (BFL 5 kap);
 *   - year_end, result_appropriation, currency_revaluation: bokslut
 *     mechanics; a rule on a result account must not be able to block
 *     closing or opening the year;
 *   - storno, correction, credit_note, supplier_credit_note: HOW history
 *     gets fixed. Blocking them on entries that pre-date a rule would make
 *     old mistakes permanent. Credit notes COPY the original's bags (PR7) so
 *     the reversal nets against the same dimension cells: if the original
 *     satisfied the rules, so does the copy; if it pre-dates them, enforcing
 *     would demand an ASYMMETRIC tag (a credit in P001 with no original in
 *     P001), the project-P&L skew this feature exists to prevent;
 *   - system: asset disposals and skattekonto bookings, derived from the
 *     asset register and Skatteverket's rows;
 *   - accrual: dissolutions replay the schedule's bag on BOTH lines so the
 *     interim 17xx/29xx account nets per dimension. A default/fixed rule
 *     would re-tag one side only, and a required rule added after the
 *     schedule would strand every remaining installment (the daily cron
 *     retries the same impossible entry while the interim account stays
 *     overstated);
 *   - vat_settlement, rot_rut_payout, rot_rut_reclaim, expense_payout,
 *     stripe_payout: settlements computed from balances already booked
 *     (26xx, 1513, 2820/2893, the Stripe balance). Their only result lines
 *     (öresavrundning, Stripe fees) belong to no single project.
 */
export const DIMENSION_RULE_POLICY: Readonly<Record<JournalEntrySourceType, DimensionRulePolicy>> = {
  manual: 'enforced',
  bank_transaction: 'enforced',
  inbox_item: 'enforced',
  invoice_created: 'enforced',
  invoice_paid: 'enforced',
  invoice_cash_payment: 'enforced',
  supplier_invoice_registered: 'enforced',
  supplier_invoice_paid: 'enforced',
  supplier_invoice_cash_payment: 'enforced',
  supplier_invoice_privately_paid: 'enforced',
  salary_payment: 'enforced',
  webshop_order: 'enforced',
  expense_claim: 'enforced',
  reminder_fee: 'enforced',
  opening_balance: 'exempt',
  import: 'exempt',
  year_end: 'exempt',
  result_appropriation: 'exempt',
  currency_revaluation: 'exempt',
  storno: 'exempt',
  correction: 'exempt',
  credit_note: 'exempt',
  supplier_credit_note: 'exempt',
  system: 'exempt',
  accrual: 'exempt',
  vat_settlement: 'exempt',
  rot_rut_payout: 'exempt',
  rot_rut_reclaim: 'exempt',
  expense_payout: 'exempt',
  stripe_payout: 'exempt',
}

/** The exempt bucket of DIMENSION_RULE_POLICY, as a set. */
export const DIMENSION_RULE_EXEMPT_SOURCE_TYPES: ReadonlySet<string> = new Set(
  (Object.keys(DIMENSION_RULE_POLICY) as JournalEntrySourceType[]).filter(
    (sourceType) => DIMENSION_RULE_POLICY[sourceType] === 'exempt'
  )
)

export function isDimensionRuleExemptSource(sourceType: string | null | undefined): boolean {
  return sourceType != null && DIMENSION_RULE_EXEMPT_SOURCE_TYPES.has(sourceType)
}

/**
 * Source types exempt from the SOFT REGISTRY VALIDATION in
 * validateEntryDimensions (dimension-resolver.ts). Deliberately a SECOND and
 * much narrower set than DIMENSION_RULE_EXEMPT_SOURCE_TYPES above: that one
 * governs POLICY (required/default/fixed rules), this one governs whether a
 * tagged bag has to resolve against the registry at all.
 *
 * Only 'accrual' qualifies. A periodisering dissolution is the mechanical
 * continuation of a decision that was already approved and already posted:
 * the origin entry booked the net amount to the interim account (17xx/29xx)
 * and the schedule replays it month by month onto the P&L account. The
 * dissolution lines copy the ORIGIN's bag verbatim, so the storno argument
 * applies unchanged: the value may have been archived in the months since
 * the origin was posted, and rejecting the copy would leave every remaining
 * installment PENDING forever (the service records last_error and the daily
 * cron retries the same impossible entry). The deferred cost would never
 * reach its 5xxx/6xxx account, the interim account would stay overstated,
 * and the trial balance would still balance, so no year-end check fires.
 *
 * The tag itself is kept, never stripped: an archived value still exists in
 * the registry and the cost genuinely belongs to that project, so dropping
 * it would understate the project instead.
 *
 * Nothing else belongs here. import/opening_balance carry user-supplied
 * codes on a FIRST posting: skipping validation there would silently write
 * registry-orphaned tags that no dimension report can group.
 */
export const DIMENSION_VALIDATION_EXEMPT_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'accrual',
])

export function isDimensionValidationExemptSource(
  sourceType: string | null | undefined
): boolean {
  return sourceType != null && DIMENSION_VALIDATION_EXEMPT_SOURCE_TYPES.has(sourceType)
}
