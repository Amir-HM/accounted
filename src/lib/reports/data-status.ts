import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { countUnbookedBankTransactions } from '@/lib/transactions/unbooked'
import { getLatestSignoffs } from '@/lib/reconciliation/signoff-store'
import { bankAccountKey } from '@/lib/reconciliation/schemas'

const log = createLogger('report-data-status')

/**
 * How far a report's numbers can be trusted, returned next to the numbers.
 *
 * A report tool used to answer "what is our result?" with a bare figure even
 * when half the month's bank rows had no verifikat, the bank feed had not
 * synced for a week, or the company uses kontantmetoden. Agents then rebuilt
 * the figure from raw journal lines or presented a preliminary number as
 * final. Every signal below already existed in a separate tool or resource;
 * this puts them on the report itself, over the report's own date range.
 *
 * Company-wide by design: on a report filtered by dimensions (kostnadsställe,
 * projekt) or an account range, every count still covers the whole company
 * over the date range, not only the filtered slice. An unbooked bank row
 * carries no dimension or account yet, so it cannot be attributed to a slice.
 *
 * Only signals that can change a figure belong here. A missing underlag does
 * not (the verifikat is already in the numbers); it stays in
 * gnubok_vat_close_check and the attention resource.
 */
export interface ReportDataStatus {
  computed_at: string
  /** The date range the counts below cover (the report's effective range). */
  range: { from: string; to: string }
  period: {
    period_id: string
    name: string
    /** State of the range end: closed period, locked (period or company lock date), or open. */
    status: 'open' | 'locked' | 'closed'
    /** YYYY-MM-DD: the date the period was locked, or the company lock date when that is what locks the range. */
    lock_date: string | null
  }
  accounting_method: 'accrual' | 'cash' | null
  /** Bank rows dated in the range with no verifikat (lib/transactions/unbooked.ts). */
  unbooked_transactions: number
  /** Draft journal entries dated in the range: not posted, not in the figures. */
  draft_entries: number
  bank: {
    /** Oldest last sync among the company's ACTIVE bank connections: the stalest feed, or null (no active feed). */
    last_sync_at: string | null
    /** Earliest sign-off date across the company's bank accounts; null when any is unsigned or there are none. */
    reconciled_through: string | null
  }
  /** True when the figures can still change: open range, unbooked rows or drafts. */
  preliminary: boolean
  /** Short sentences for the agent to draw on; mention the ones relevant to the question. */
  caveats: string[]
}

export type ReportDataStatusResult = ReportDataStatus | { unavailable: true; reason: string }

/** A bank feed older than this is called out when the range reaches past it. */
const STALE_SYNC_HOURS = 36

interface Options {
  periodId: string
  /** Inclusive range start; defaults to the period start. */
  fromDate?: string
  /** Inclusive range end; defaults to the period end. */
  toDate?: string
  now?: Date
}

/**
 * Build the data status for a report over [fromDate, toDate] inside a fiscal
 * period. Never throws: a report must still answer when a trust signal cannot
 * be read, so a failure comes back as { unavailable: true, reason }.
 */
export async function buildReportDataStatus(
  supabase: SupabaseClient,
  companyId: string,
  options: Options,
): Promise<ReportDataStatusResult> {
  try {
    return await build(supabase, companyId, options)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn('report data status unavailable', { companyId, reason })
    return { unavailable: true, reason }
  }
}

async function build(
  supabase: SupabaseClient,
  companyId: string,
  options: Options,
): Promise<ReportDataStatus> {
  const now = options.now ?? new Date()

  const [periodRes, settingsRes] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, locked_at')
      .eq('company_id', companyId)
      .eq('id', options.periodId)
      .single(),
    supabase
      .from('company_settings')
      .select('accounting_method, bookkeeping_locked_through')
      .eq('company_id', companyId)
      .maybeSingle(),
  ])
  if (periodRes.error || !periodRes.data) {
    throw new Error(`fiscal period read failed: ${periodRes.error?.message ?? 'not found'}`)
  }
  if (settingsRes.error) throw new Error(`company settings read failed: ${settingsRes.error.message}`)

  const period = periodRes.data as {
    id: string
    name: string
    period_start: string
    period_end: string
    is_closed: boolean | null
    locked_at: string | null
  }
  const settings = (settingsRes.data ?? null) as {
    accounting_method?: string | null
    bookkeeping_locked_through?: string | null
  } | null
  const from = options.fromDate ?? period.period_start
  const to = options.toDate ?? period.period_end

  const [unbooked, draftsRes, syncRes, recon] = await Promise.all([
    countUnbookedBankTransactions(supabase, companyId, { fromDate: from, toDate: to }),
    supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .gte('entry_date', from)
      .lte('entry_date', to),
    // The stalest ACTIVE feed is what leaves rows out of the figures; a
    // revoked or expired connection no longer feeds anything.
    supabase
      .from('bank_connections')
      .select('last_synced_at')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .not('last_synced_at', 'is', null)
      .order('last_synced_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    bankReconciliation(supabase, companyId),
  ])
  if (draftsRes.error) throw new Error(`draft entry count failed: ${draftsRes.error.message}`)
  if (syncRes.error && syncRes.error.code !== 'PGRST116') {
    throw new Error(`bank sync read failed: ${syncRes.error.message}`)
  }

  const lockThrough = settings?.bookkeeping_locked_through ?? null
  let status: ReportDataStatus['period']['status'] = 'open'
  let lockDate: string | null = null
  if (period.is_closed) {
    status = 'closed'
    lockDate = isoDate(period.locked_at)
  } else if (period.locked_at) {
    status = 'locked'
    lockDate = isoDate(period.locked_at)
  } else if (lockThrough && lockThrough >= to) {
    status = 'locked'
    lockDate = isoDate(lockThrough)
  }

  const method = settings?.accounting_method === 'cash' || settings?.accounting_method === 'accrual'
    ? settings.accounting_method
    : null
  const drafts = draftsRes.count ?? 0
  const lastSyncAt = (syncRes.data as { last_synced_at?: string | null } | null)?.last_synced_at ?? null

  const caveats: string[] = []
  if (status === 'open') {
    caveats.push(`Period ${period.name} is open: these figures can still change.`)
  }
  if (unbooked.total > 0) {
    caveats.push(`${unbooked.total} bank transaction(s) dated ${from} to ${to} have no verifikat yet, so they are not in these figures.`)
  }
  if (drafts > 0) {
    caveats.push(`${drafts} draft entr${drafts === 1 ? 'y' : 'ies'} in the range are not posted and not included.`)
  }
  if (method === 'cash') {
    // True for every report: the income statement leaves year-end entries out
    // while other reports include them, so "unpaid invoices are (not) in these
    // figures" would be wrong for one of them.
    caveats.push('Cash method (kontantmetoden): invoices are booked when paid; unpaid customer and supplier invoices enter the books only through the year-end (bokslut) entries.')
  }
  if (lastSyncAt) {
    const ageHours = (now.getTime() - new Date(lastSyncAt).getTime()) / 3_600_000
    if (ageHours > STALE_SYNC_HOURS && to >= lastSyncAt.slice(0, 10)) {
      caveats.push(`A bank feed last synced ${lastSyncAt.slice(0, 10)}: its transactions after that date are not imported yet.`)
    }
  }
  // Only for companies that sign off reconciliations at all (the adoption
  // gate countReconciliationDue uses): about 97% of companies with a bank
  // account never have, and a caveat on every answer would be noise. The
  // expected sign-off date is capped at the last month end before today, so a
  // current-year report is not measured against a period end in the future.
  if (recon.adopted && recon.hasBankAccounts) {
    const expectedThrough = to < lastMonthEnd(now) ? to : lastMonthEnd(now)
    if (recon.reconciledThrough === null) {
      caveats.push('At least one bank account has no reconciliation sign-off.')
    } else if (recon.reconciledThrough < expectedThrough) {
      caveats.push(`Bank reconciliation is signed off only through ${recon.reconciledThrough}.`)
    }
  }

  return {
    computed_at: now.toISOString(),
    range: { from, to },
    period: { period_id: period.id, name: period.name, status, lock_date: lockDate },
    accounting_method: method,
    unbooked_transactions: unbooked.total,
    draft_entries: drafts,
    bank: { last_sync_at: lastSyncAt, reconciled_through: recon.reconciledThrough },
    preliminary: status === 'open' || unbooked.total > 0 || drafts > 0,
    caveats,
  }
}

/** YYYY-MM-DD from a date or a timestamp (the UTC date of a timestamptz string). */
function isoDate(value: string | null): string | null {
  return value ? value.slice(0, 10) : null
}

/** The last day of the month before `now`, YYYY-MM-DD (UTC). */
function lastMonthEnd(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10)
}

/**
 * Reconciliation state of the company's enabled bank accounts:
 *   reconciledThrough: earliest active sign-off date across the live accounts
 *     (reconnect duplicates on the same IBAN + currency count once, the newest
 *     row, as on the Avstämning rail); null when any is unsigned or there are none.
 *   adopted: the company has at least one active sign-off on any account.
 */
async function bankReconciliation(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ reconciledThrough: string | null; hasBankAccounts: boolean; adopted: boolean }> {
  const [accountsRes, signoffs] = await Promise.all([
    supabase
      .from('cash_accounts')
      .select('id, iban, currency, updated_at')
      .eq('company_id', companyId)
      .eq('enabled', true),
    getLatestSignoffs(supabase, companyId),
  ])
  if (accountsRes.error) throw new Error(`cash account read failed: ${accountsRes.error.message}`)
  const accounts = (accountsRes.data ?? []) as Array<{ id: string; iban: string | null; currency: string | null; updated_at: string | null }>
  const adopted = signoffs.size > 0
  if (accounts.length === 0) return { reconciledThrough: null, hasBankAccounts: false, adopted }

  const live: string[] = []
  const byIban = new Map<string, (typeof accounts)[number]>()
  for (const a of accounts) {
    if (!a.iban) {
      live.push(a.id)
      continue
    }
    const key = `${a.iban}|${a.currency ?? 'SEK'}`
    const prev = byIban.get(key)
    if (!prev || (a.updated_at ?? '') > (prev.updated_at ?? '')) byIban.set(key, a)
  }
  for (const a of byIban.values()) live.push(a.id)

  let earliest: string | null = null
  for (const id of live) {
    const through = signoffs.get(bankAccountKey(id))?.through_date ?? null
    if (!through) return { reconciledThrough: null, hasBankAccounts: true, adopted }
    if (earliest === null || through < earliest) earliest = through
  }
  return { reconciledThrough: earliest, hasBankAccounts: true, adopted }
}
