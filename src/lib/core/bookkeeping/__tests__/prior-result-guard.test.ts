import { describe, it, expect } from 'vitest'
import { movedOffCarry, remainingCarry, resultAccountLeftover } from '../prior-result-guard'

const row = (account_number: string, closing_debit: number, closing_credit: number) => ({
  account_number,
  closing_debit,
  closing_credit,
})

describe('resultAccountLeftover', () => {
  it('reports a prior profit still on 2099 before the close (PostHog PH 120)', () => {
    expect(resultAccountLeftover([row('1930', 50000, 0), row('2099', 0, 20000)], '2099')).toBe(20000)
  })

  it('reports a prior loss as a negative leftover', () => {
    expect(resultAccountLeftover([row('2099', 4000, 0)], '2099')).toBe(-4000)
  })

  it('is 0 when the result account is empty or absent', () => {
    expect(resultAccountLeftover([row('2099', 20000, 20000)], '2099')).toBe(0)
    expect(resultAccountLeftover([row('1930', 100, 0)], '2099')).toBe(0)
  })

  it('ignores öre-level noise', () => {
    expect(resultAccountLeftover([row('2069', 0, 0.004)], '2069')).toBe(0)
  })
})

describe('remainingCarry', () => {
  it('carries the whole IB when nothing was booked by hand', () => {
    expect(remainingCarry(30000, 0)).toBe(30000)
    expect(remainingCarry(-4000, 0)).toBe(-4000)
  })

  it('carries nothing when a hand booking moved it all (PostHog PH 108)', () => {
    expect(remainingCarry(30000, -30000)).toBe(0)
    expect(remainingCarry(-4000, 4000)).toBe(0)
  })

  it('carries only the rest after a partial hand booking', () => {
    expect(remainingCarry(30000, -10000)).toBe(20000)
    expect(remainingCarry(-4000, 1500)).toBe(-2500)
  })

  it('carries nothing when the hand booking moved more than was carried in', () => {
    expect(remainingCarry(30000, -45000)).toBe(0)
  })

  it('never carries more than the IB when a booking went the same direction', () => {
    expect(remainingCarry(30000, 5000)).toBe(30000)
  })

  it('carries nothing when there is no IB', () => {
    expect(remainingCarry(0, -5000)).toBe(0)
  })
})

describe('movedOffCarry', () => {
  const entry = (
    sourceType: string,
    voucher: string,
    lines: Array<[string, number, number]>,
  ) => ({
    sourceType,
    voucher,
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  })

  it('counts the automatic omföring', () => {
    const moved = movedOffCarry(
      [entry('result_appropriation', 'A2', [['2099', 20000, 0], ['2098', 0, 20000]])],
      '2099',
      ['2098', '2091'],
      20000,
    )
    expect(moved).toEqual({ net: -20000, vouchers: ['A2'] })
  })

  it('counts only the lines against the carry in a hand-booked disposition (PostHog PH 108)', () => {
    const moved = movedOffCarry(
      [
        entry('manual', 'A12', [
          ['2067', 0, 30000],
          ['2069', 30000, 0],
          ['2069', 0, 12000],
          ['2099', 12000, 0],
        ]),
      ],
      '2069',
      ['2068', '2067'],
      30000,
    )
    expect(moved).toEqual({ net: -30000, vouchers: ['A12'] })
  })

  it('ignores a storno, the opening balance and the closing entry', () => {
    const moved = movedOffCarry(
      [
        entry('storno', 'A16', [['2069', 0, 30000], ['2068', 30000, 0]]),
        entry('opening_balance', 'A10', [['2069', 0, 30000]]),
        entry('year_end', 'A14', [['2069', 0, 12000]]),
      ],
      '2069',
      ['2068', '2067'],
      30000,
    )
    expect(moved).toEqual({ net: 0, vouchers: [] })
  })

  it('does not count a 2099 booking that moves nothing to a disposition account', () => {
    const moved = movedOffCarry([entry('manual', 'A11', [['2099', 20000, 0], ['8999', 0, 20000]])], '2099', ['2098', '2091'], 20000)
    expect(moved).toEqual({ net: 0, vouchers: [] })
  })

  it('counts credits against a carried loss', () => {
    const moved = movedOffCarry([entry('manual', 'A5', [['2099', 0, 4000], ['2091', 4000, 0]])], '2099', ['2098', '2091'], -4000)
    expect(moved).toEqual({ net: 4000, vouchers: ['A5'] })
  })
})
