/**
 * Argument aliases for the read-only report tools.
 *
 * The report tools name the same idea differently (period_id vs the
 * fiscal_period_id agents guess; from_date on the income statement, date_from
 * on query_journal), and prod telemetry shows a steady stream of calls
 * rejected for exactly those names. For READ-ONLY report tools a known
 * synonym is mapped to the tool's own parameter before the unknown-argument
 * guard runs. Nothing changes in tools/list: schemas stay strict and only
 * advertise the canonical names.
 *
 * Deliberately narrow: only read-only report tools (a wrong guess can at
 * worst return the wrong report, never write), only explicit per-tool
 * mappings (no fuzzy matching), and an alias that overlaps a parameter the
 * caller also sent is refused rather than resolved, so an ambiguous call
 * never silently picks a side.
 *
 * A mapping must never turn a loud rejection into a silent wrong answer. An
 * alias whose value the tool would not read the way the caller meant (a
 * voucher "A12B", a ledger account "19" fanned out to both range bounds)
 * therefore has a value guard: the rule's `map` returns null and the alias
 * stays in the arguments, so the unknown-parameter guard rejects the call
 * with a "Did you mean" hint instead.
 *
 * Every other tool gets suggestArgKey instead: the unknown-parameter error
 * names the parameter the caller most likely meant.
 */
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'

interface AliasRule {
  /** Every canonical key this alias may write (the tests check each is published). */
  to: readonly string[]
  /**
   * Value guard and transform in one: the canonical keys and values to write,
   * or null when the value has a shape this alias cannot map safely. Null
   * leaves the alias in the arguments, where the unknown-parameter guard
   * rejects it. Default: the value unchanged under every key in `to`.
   */
  map?: (value: unknown) => Record<string, unknown> | null
}

/** A single ledger account, as the string the ledger compares: "1930". */
function exactAccountNumber(value: unknown): string | null {
  const str =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isInteger(value)
        ? String(value)
        : null
  return str !== null && ACCOUNT_NUMBER_RE.test(str) ? str : null
}

// Same voucher reference shape resolveJournalEntryRef reads: series letters,
// an optional separator, the number ("A12", "A 12", "A-12").
const VOUCHER_REF_RE = /^([A-Za-z]+)\s*[-:/ ]?\s*(\d+)$/

/**
 * One voucher: an integer or a digit string is the number in any series;
 * "A12" is series A, number 12. Anything else is not mapped: query_journal
 * only filters on a number, so a value it cannot read used to return the
 * whole journal labelled as the voucher that was asked for.
 */
function mapVoucherNumber(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { voucher_number_from: value, voucher_number_to: value } : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    return { voucher_number_from: n, voucher_number_to: n }
  }
  const ref = VOUCHER_REF_RE.exec(trimmed)
  if (!ref) return null
  const n = Number(ref[2])
  return { voucher_series: ref[1].toUpperCase(), voucher_number_from: n, voucher_number_to: n }
}

const PERIOD = { fiscal_period_id: { to: ['period_id'] } }

export const REPORT_ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, AliasRule>>>> = {
  gnubok_get_income_statement: {
    ...PERIOD,
    date_from: { to: ['from_date'] },
    start_date: { to: ['from_date'] },
    date_to: { to: ['to_date'] },
    end_date: { to: ['to_date'] },
    as_of_date: { to: ['to_date'] },
  },
  gnubok_get_balance_sheet: {
    ...PERIOD,
    as_of: { to: ['as_of_date'] },
    to_date: { to: ['as_of_date'] },
    date_to: { to: ['as_of_date'] },
    end_date: { to: ['as_of_date'] },
  },
  gnubok_get_trial_balance: {
    ...PERIOD,
  },
  gnubok_get_general_ledger: {
    ...PERIOD,
    // Fanned out to both bounds, which the ledger compares as strings: only
    // an exact account is safe. "19" or "1930 Företagskonto" would return an
    // empty ledger instead of the account that was meant.
    account_number: {
      to: ['account_from', 'account_to'],
      map: (value) => {
        const account = exactAccountNumber(value)
        return account === null ? null : { account_from: account, account_to: account }
      },
    },
  },
  gnubok_get_kpi_report: {
    ...PERIOD,
    date_from: { to: ['from_date'] },
    start_date: { to: ['from_date'] },
    date_to: { to: ['to_date'] },
    end_date: { to: ['to_date'] },
    as_of_date: { to: ['to_date'] },
    metric: {
      to: ['metrics'],
      map: (value) => ({ metrics: Array.isArray(value) ? value : [value] }),
    },
  },
  gnubok_query_journal: {
    from_date: { to: ['date_from'] },
    start_date: { to: ['date_from'] },
    to_date: { to: ['date_to'] },
    end_date: { to: ['date_to'] },
    query: { to: ['text'] },
    search: { to: ['text'] },
    search_text: { to: ['text'] },
    // Passed through unchanged: `accounts` already reads a string, a
    // comma-separated list, a number or an array, and rejects anything else.
    account_number: { to: ['accounts'] },
    account: { to: ['accounts'] },
    voucher_number: {
      to: ['voucher_series', 'voucher_number_from', 'voucher_number_to'],
      map: mapVoucherNumber,
    },
  },
}

export interface AliasConflict {
  alias: string
  /** The canonical keys the alias would have written. */
  readsAs: string[]
  /** The parameter the caller also sent that sets one of those keys. */
  overlaps: string
}

export interface AliasNormalization {
  args: Record<string, unknown>
  /** alias -> canonical keys it was written to, for telemetry and tests. */
  applied: Array<{ alias: string; to: string[] }>
  /** Aliases refused because another parameter already sets their value. */
  conflicts: AliasConflict[]
}

/**
 * Rewrite known aliases to the tool's canonical parameter names. Tools
 * without an alias table get their args back untouched, and so does an alias
 * whose value its guard refuses.
 */
export function normalizeReportArgAliases(
  toolName: string,
  args: Record<string, unknown>,
): AliasNormalization {
  const table = Object.hasOwn(REPORT_ARG_ALIASES, toolName) ? REPORT_ARG_ALIASES[toolName] : undefined
  if (!table) return { args, applied: [], conflicts: [] }

  const out: Record<string, unknown> = { ...args }
  const applied: AliasNormalization['applied'] = []
  const conflicts: AliasConflict[] = []
  // canonical key -> the alias that wrote it, so two aliases for one key clash
  const writtenBy = new Map<string, string>()

  for (const [alias, rule] of Object.entries(table)) {
    if (!Object.hasOwn(args, alias)) continue
    const value = args[alias]
    const mapped = rule.map
      ? rule.map(value)
      : Object.fromEntries(rule.to.map((key) => [key, value]))
    if (mapped === null) continue

    const keys = Object.keys(mapped)
    const clash = keys.find((key) => Object.hasOwn(args, key) || writtenBy.has(key))
    if (clash !== undefined) {
      conflicts.push({
        alias,
        readsAs: keys,
        overlaps: Object.hasOwn(args, clash) ? clash : (writtenBy.get(clash) as string),
      })
      continue
    }
    for (const key of keys) {
      out[key] = mapped[key]
      writtenBy.set(key, alias)
    }
    delete out[alias]
    applied.push({ alias, to: keys })
  }
  return { args: out, applied, conflicts }
}

function quoteList(keys: readonly string[]): string {
  const quoted = keys.map((key) => `"${key}"`)
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

/**
 * The refusal text for overlapping parameters. Says what each alias is read
 * as and which parameter it collides with, which is true for every rule; a
 * multi-key alias such as voucher_number is not "the same thing" as either
 * bound it fills.
 */
export function describeAliasConflicts(conflicts: readonly AliasConflict[]): string {
  return conflicts
    .map((c) => `"${c.alias}" (read as ${quoteList(c.readsAs)}) overlaps "${c.overlaps}"`)
    .join('; ') + '. Send only one of each pair.'
}

/** Common synonyms, each with the canonical names it most likely means. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  fiscal_period_id: ['period_id', 'fiscal_period_id'],
  fiscal_year_id: ['period_id', 'fiscal_period_id'],
  date_from: ['from_date', 'date_from'],
  from_date: ['date_from', 'from_date'],
  start_date: ['from_date', 'date_from', 'period_start'],
  date_to: ['to_date', 'date_to'],
  to_date: ['date_to', 'to_date', 'as_of_date'],
  end_date: ['to_date', 'date_to', 'period_end'],
  as_of: ['as_of_date', 'to_date'],
  as_of_date: ['to_date', 'date_to', 'as_of'],
  query: ['text', 'query', 'search'],
  search: ['query', 'text', 'search'],
  search_text: ['text', 'query'],
  account: ['account_number', 'accounts', 'account_from'],
  account_number: ['accounts', 'account_from', 'account'],
  voucher_number: ['voucher_number_from'],
  metric: ['metrics'],
}

/**
 * The parameter an unknown key most likely meant, or null. Used to add a
 * "did you mean" hint to the unknown-parameter error on every tool. Own keys
 * only: "constructor" or "__proto__" must read as unknown, not as
 * Object.prototype members.
 */
export function suggestArgKey(unknownKey: string, validKeys: readonly string[]): string | null {
  if (!Object.hasOwn(SYNONYMS, unknownKey)) return null
  return SYNONYMS[unknownKey].find((key) => key !== unknownKey && validKeys.includes(key)) ?? null
}
