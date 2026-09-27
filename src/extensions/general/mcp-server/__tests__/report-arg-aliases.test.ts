/**
 * Read-only report tools accept the parameter synonyms agents actually send
 * (prod telemetry: fiscal_period_id, date_from/date_to, start_date/end_date,
 * as_of_date, account_number, metric), mapped onto the tool's own names.
 * tools/list stays strict: no alias ever appears in a published schema.
 *
 * A mapping must never turn a loud rejection into a silent wrong answer, so
 * the aliases whose target would misread a value carry a value guard: an
 * unreadable value is left unmapped and the unknown-parameter guard rejects
 * it (the dispatcher side is in unknown-args-rejected.test.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  REPORT_ARG_ALIASES,
  describeAliasConflicts,
  normalizeReportArgAliases,
  suggestArgKey,
} from '../report-arg-aliases'
import { tools } from '../server'

describe('normalizeReportArgAliases', () => {
  it('renames a known alias to the canonical parameter', () => {
    const { args, applied, conflicts } = normalizeReportArgAliases('gnubok_get_income_statement', {
      fiscal_period_id: 'fp-1',
      date_from: '2026-01-01',
    })
    expect(args).toEqual({ period_id: 'fp-1', from_date: '2026-01-01' })
    expect(applied.map((a) => a.alias).sort()).toEqual(['date_from', 'fiscal_period_id'])
    expect(conflicts).toEqual([])
  })

  it('wraps a scalar metric into the metrics array', () => {
    const { args } = normalizeReportArgAliases('gnubok_get_kpi_report', { metric: 'cash_position' })
    expect(args).toEqual({ metrics: ['cash_position'] })
  })

  it('maps the query_journal free-text synonyms to text', () => {
    const { args } = normalizeReportArgAliases('gnubok_query_journal', { query: 'hyra', start_date: '2026-01-01' })
    expect(args).toEqual({ text: 'hyra', date_from: '2026-01-01' })
  })

  it('refuses an alias that collides with its canonical key instead of picking a side', () => {
    const { args, conflicts } = normalizeReportArgAliases('gnubok_get_kpi_report', {
      metric: 'cash_position',
      metrics: ['net_result'],
    })
    expect(conflicts).toEqual([{ alias: 'metric', readsAs: ['metrics'], overlaps: 'metrics' }])
    expect(args.metrics).toEqual(['net_result'])
  })

  it('refuses two aliases that land on the same canonical key, naming the other alias', () => {
    const { conflicts } = normalizeReportArgAliases('gnubok_get_balance_sheet', {
      to_date: '2026-06-30',
      end_date: '2026-07-31',
    })
    expect(conflicts).toEqual([{ alias: 'end_date', readsAs: ['as_of_date'], overlaps: 'to_date' }])
  })

  it('leaves tools without an alias table untouched', () => {
    const input = { fiscal_period_id: 'fp-1' }
    const { args, applied } = normalizeReportArgAliases('gnubok_close_period', input)
    expect(args).toBe(input)
    expect(applied).toEqual([])
  })

  it('only targets read-only tools, and every mapping lands on a published parameter', () => {
    for (const [toolName, table] of Object.entries(REPORT_ARG_ALIASES)) {
      const tool = tools.find((t) => t.name === toolName)
      expect(tool, toolName).toBeDefined()
      expect(tool!.annotations?.readOnlyHint, toolName).toBe(true)
      const published = Object.keys((tool!.inputSchema as { properties: Record<string, unknown> }).properties)
      for (const [alias, rule] of Object.entries(table)) {
        expect(published, `${toolName}: alias ${alias} must not be published`).not.toContain(alias)
        for (const target of rule.to) {
          expect(published, `${toolName}: ${alias} -> ${target}`).toContain(target)
        }
      }
    }
  })
})

describe('value guards: an alias value the target would misread stays unmapped', () => {
  describe('gnubok_get_general_ledger account_number (fanned out to both string bounds)', () => {
    it('maps an exact four-digit account to both bounds', () => {
      for (const value of ['1930', ' 1930 ', 1930]) {
        const { args } = normalizeReportArgAliases('gnubok_get_general_ledger', { account_number: value })
        expect(args, JSON.stringify(value)).toEqual({ account_from: '1930', account_to: '1930' })
      }
    })

    it('leaves a partial or labelled account unmapped, so the call is rejected rather than empty', () => {
      for (const value of ['19', '1930 Företagskonto', '19300', 193, 1930.5, null, ['1930']]) {
        const input = { account_number: value }
        const { args, applied, conflicts } = normalizeReportArgAliases('gnubok_get_general_ledger', input)
        expect(args, JSON.stringify(value)).toEqual(input)
        expect(applied).toEqual([])
        expect(conflicts).toEqual([])
      }
    })
  })

  describe('gnubok_query_journal account_number / account (read by the accounts parser)', () => {
    it('passes the value through unchanged, so a comma-separated list stays a list', () => {
      for (const alias of ['account_number', 'account']) {
        for (const value of ['1930,1940', ['1930', '1940'], 1930]) {
          const { args } = normalizeReportArgAliases('gnubok_query_journal', { [alias]: value })
          expect(args, `${alias}=${JSON.stringify(value)}`).toEqual({ accounts: value })
        }
      }
    })
  })

  describe('gnubok_query_journal voucher_number', () => {
    const map = (args: Record<string, unknown>) => normalizeReportArgAliases('gnubok_query_journal', args)

    it('reads an integer or a digit string as one voucher number', () => {
      expect(map({ voucher_number: 12 }).args).toEqual({ voucher_number_from: 12, voucher_number_to: 12 })
      expect(map({ voucher_number: '12' }).args).toEqual({ voucher_number_from: 12, voucher_number_to: 12 })
    })

    it('reads a series and number as the series plus that voucher', () => {
      for (const value of ['A12', 'A 12', 'a-12']) {
        expect(map({ voucher_number: value }).args, value).toEqual({
          voucher_series: 'A',
          voucher_number_from: 12,
          voucher_number_to: 12,
        })
      }
    })

    it('keeps an explicit voucher_series next to a bare number', () => {
      const { args, conflicts } = map({ voucher_number: 12, voucher_series: 'B' })
      expect(conflicts).toEqual([])
      expect(args).toEqual({ voucher_series: 'B', voucher_number_from: 12, voucher_number_to: 12 })
    })

    it('refuses a series reference next to an explicit voucher_series', () => {
      const { conflicts } = map({ voucher_number: 'A12', voucher_series: 'B' })
      expect(conflicts).toEqual([
        {
          alias: 'voucher_number',
          readsAs: ['voucher_series', 'voucher_number_from', 'voucher_number_to'],
          overlaps: 'voucher_series',
        },
      ])
    })

    it('refuses a voucher number next to either range bound', () => {
      const { conflicts } = map({ voucher_number: 12, voucher_number_to: 20 })
      expect(conflicts).toEqual([
        {
          alias: 'voucher_number',
          readsAs: ['voucher_number_from', 'voucher_number_to'],
          overlaps: 'voucher_number_to',
        },
      ])
    })

    it('leaves anything else unmapped, so the call is rejected rather than run unfiltered', () => {
      for (const value of ['A12B', 'twelve', '', '12-14', 12.5, true, null, { n: 12 }, [12]]) {
        const input = { voucher_number: value }
        const { args, applied, conflicts } = map(input)
        expect(args, JSON.stringify(value)).toEqual(input)
        expect(applied).toEqual([])
        expect(conflicts).toEqual([])
      }
    })
  })

  it('writes only keys each rule declares', () => {
    const samples: Record<string, unknown[]> = {
      account_number: ['1930', 1930],
      voucher_number: [12, '12', 'A12'],
      metric: ['cash_position', ['cash_position']],
    }
    for (const [toolName, table] of Object.entries(REPORT_ARG_ALIASES)) {
      for (const [alias, rule] of Object.entries(table)) {
        for (const value of samples[alias] ?? ['x']) {
          const { applied } = normalizeReportArgAliases(toolName, { [alias]: value })
          for (const entry of applied) {
            for (const key of entry.to) expect(rule.to, `${toolName}.${alias} wrote ${key}`).toContain(key)
          }
        }
      }
    }
  })
})

describe('Object.prototype names are never read as aliases or synonyms', () => {
  it('ignores a tool name or argument named like an Object.prototype member', () => {
    for (const toolName of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const input = { fiscal_period_id: 'fp-1' }
      const { args, applied } = normalizeReportArgAliases(toolName, input)
      expect(args, toolName).toBe(input)
      expect(applied).toEqual([])
    }
    const input = JSON.parse('{"constructor": "x", "__proto__": "y", "toString": "z"}') as Record<string, unknown>
    const { args, applied } = normalizeReportArgAliases('gnubok_query_journal', input)
    expect(args).toEqual(input)
    expect(applied).toEqual([])
  })

  it('suggests nothing for them instead of throwing', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(suggestArgKey(key, ['period_id', 'constructor', 'toString']), key).toBeNull()
    }
  })
})

describe('describeAliasConflicts', () => {
  it('says what each alias is read as and what it overlaps, without claiming synonymy', () => {
    const text = describeAliasConflicts([
      {
        alias: 'voucher_number',
        readsAs: ['voucher_number_from', 'voucher_number_to'],
        overlaps: 'voucher_number_to',
      },
      { alias: 'fiscal_period_id', readsAs: ['period_id'], overlaps: 'period_id' },
    ])
    expect(text).toBe(
      '"voucher_number" (read as "voucher_number_from" and "voucher_number_to") overlaps "voucher_number_to"; ' +
        '"fiscal_period_id" (read as "period_id") overlaps "period_id". Send only one of each pair.',
    )
  })

  it('joins three targets as "a", "b" and "c"', () => {
    expect(
      describeAliasConflicts([
        {
          alias: 'voucher_number',
          readsAs: ['voucher_series', 'voucher_number_from', 'voucher_number_to'],
          overlaps: 'voucher_series',
        },
      ]),
    ).toContain('(read as "voucher_series", "voucher_number_from" and "voucher_number_to")')
  })
})

describe('suggestArgKey', () => {
  it('names the parameter an unknown synonym most likely meant', () => {
    expect(suggestArgKey('fiscal_period_id', ['period_id', 'account'])).toBe('period_id')
    expect(suggestArgKey('date_from', ['from_date', 'to_date'])).toBe('from_date')
    expect(suggestArgKey('search', ['query', 'limit'])).toBe('query')
    expect(suggestArgKey('voucher_number', ['voucher_number_from', 'voucher_number_to'])).toBe(
      'voucher_number_from',
    )
    expect(suggestArgKey('account_number', ['period_id', 'account_from', 'account_to'])).toBe('account_from')
  })

  it('returns null when nothing close is valid', () => {
    expect(suggestArgKey('fiscal_period_id', ['invoice_id'])).toBeNull()
    expect(suggestArgKey('fromdate', ['from_date'])).toBeNull()
  })
})
