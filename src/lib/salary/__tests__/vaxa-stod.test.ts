import { describe, it, expect } from 'vitest'
import { isVaxaStodRefundMonth, vaxaStodRefundWarning, VAXA_STOD_REFUND_FROM } from '../vaxa-stod'

describe('isVaxaStodRefundMonth', () => {
  const win = { eligible: true, start: '2025-06-01', end: '2027-05-31' }

  it('is a refund month inside the window from 2026-01-01', () => {
    expect(isVaxaStodRefundMonth(win, VAXA_STOD_REFUND_FROM)).toBe(true)
    expect(isVaxaStodRefundMonth(win, '2026-09-25')).toBe(true)
    expect(isVaxaStodRefundMonth(win, '2027-05-31')).toBe(true)
  })

  it('is never one before 2026: that pay fell under the old reduced-sats law', () => {
    expect(isVaxaStodRefundMonth(win, '2025-12-25')).toBe(false)
  })

  it('respects the window and the eligibility flag', () => {
    expect(isVaxaStodRefundMonth(win, '2027-06-25')).toBe(false)
    expect(isVaxaStodRefundMonth({ ...win, start: '2026-10-01' }, '2026-09-25')).toBe(false)
    expect(isVaxaStodRefundMonth({ ...win, eligible: false }, '2026-09-25')).toBe(false)
    expect(isVaxaStodRefundMonth({ ...win, start: null }, '2026-09-25')).toBe(false)
  })

  it('treats a missing end date as an open window', () => {
    expect(isVaxaStodRefundMonth({ ...win, end: null }, '2028-01-25')).toBe(true)
  })
})

describe('vaxaStodRefundWarning', () => {
  it('is null when no employee has a växa-stöd month', () => {
    expect(vaxaStodRefundWarning([])).toBeNull()
  })

  it('names every employee and says the refund has to be applied for', () => {
    const warning = vaxaStodRefundWarning(['Anna Andersson', 'Bo Berg'])
    expect(warning).toContain('Anna Andersson, Bo Berg')
    expect(warning).toContain('redovisas utan växa-stöd')
    expect(warning).toContain('Ansök om återbetalning hos Skatteverket')
    expect(warning).toContain('senast ett år efter kalendermånaden')
  })
})
