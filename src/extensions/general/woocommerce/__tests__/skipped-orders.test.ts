import { describe, it, expect } from 'vitest'
import {
  SKIPPED_ORDERS_STATUS_LIMIT,
  mergeSkippedOrders,
  parseSkippedOrders,
  skippedOrdersChanged,
  skippedOrdersKey,
  skippedOrdersStatus,
  type SkippedCurrencyOrder,
  type SkippedSighting,
} from '../lib/skipped-orders'

function sighting(overrides: Partial<SkippedSighting> = {}): SkippedSighting {
  return {
    order_id: 7,
    order_number: '7',
    order_date: '2026-08-01',
    currency: '&euro;',
    ...overrides,
  }
}

const T1 = '2026-09-01T00:00:00.000Z'
const T2 = '2026-09-02T00:00:00.000Z'

describe('mergeSkippedOrders', () => {
  it('adds a sighted order with first and last seen set to now', () => {
    expect(mergeSkippedOrders([], { sighted: [sighting()], resolvedOrderIds: [] }, T1)).toEqual([
      {
        order_id: 7,
        order_number: '7',
        order_date: '2026-08-01',
        currency: '&euro;',
        first_seen_at: T1,
        last_seen_at: T1,
      },
    ])
  })

  it('dedupes by order id, keeping first_seen_at and refreshing the rest', () => {
    const first = mergeSkippedOrders([], { sighted: [sighting()], resolvedOrderIds: [] }, T1)
    const second = mergeSkippedOrders(
      first,
      { sighted: [sighting({ order_number: 'W-7', currency: '??' })], resolvedOrderIds: [] },
      T2,
    )
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({
      order_number: 'W-7',
      currency: '??',
      first_seen_at: T1,
      last_seen_at: T2,
    })
  })

  it('removes a resolved order and leaves the others', () => {
    const listed = mergeSkippedOrders(
      [],
      { sighted: [sighting(), sighting({ order_id: 8 })], resolvedOrderIds: [] },
      T1,
    )
    const after = mergeSkippedOrders(listed, { sighted: [], resolvedOrderIds: [7] }, T2)
    expect(after.map((o) => o.order_id)).toEqual([8])
  })

  it('treats an order reported as both sighted and resolved as resolved', () => {
    expect(
      mergeSkippedOrders([], { sighted: [sighting()], resolvedOrderIds: [7] }, T1),
    ).toEqual([])
  })

  it('orders the list by order date, then id', () => {
    const merged = mergeSkippedOrders(
      [],
      {
        sighted: [
          sighting({ order_id: 3, order_date: '2026-08-05' }),
          sighting({ order_id: 2, order_date: '2026-08-01' }),
          sighting({ order_id: 1, order_date: '2026-08-01' }),
        ],
        resolvedOrderIds: [],
      },
      T1,
    )
    expect(merged.map((o) => o.order_id)).toEqual([1, 2, 3])
  })

  it('truncates a runaway currency value', () => {
    const [entry] = mergeSkippedOrders(
      [],
      { sighted: [sighting({ currency: 'x'.repeat(500) })], resolvedOrderIds: [] },
      T1,
    )
    expect(entry.currency).toHaveLength(32)
  })
})

describe('skippedOrdersChanged', () => {
  it('sees additions, removals and refreshed fields, and nothing else', () => {
    const a = mergeSkippedOrders([], { sighted: [sighting()], resolvedOrderIds: [] }, T1)
    expect(skippedOrdersChanged(a, a.map((o) => ({ ...o })))).toBe(false)
    expect(skippedOrdersChanged(a, [])).toBe(true)
    expect(skippedOrdersChanged(a, [{ ...a[0], last_seen_at: T2 }])).toBe(true)
  })
})

describe('parseSkippedOrders', () => {
  it('drops malformed entries and tolerates a missing value', () => {
    const good: SkippedCurrencyOrder = {
      order_id: 7,
      order_number: '7',
      order_date: null,
      currency: 'kr',
      first_seen_at: T1,
      last_seen_at: T1,
    }
    expect(parseSkippedOrders({ orders: [good, { order_id: 'x' }, null] })).toEqual([good])
    expect(parseSkippedOrders(null)).toEqual([])
    expect(parseSkippedOrders({ orders: 'nope' })).toEqual([])
  })
})

describe('skippedOrdersStatus', () => {
  it('keeps the exact count but hands the panel a bounded slice', () => {
    const many = mergeSkippedOrders(
      [],
      {
        sighted: Array.from({ length: SKIPPED_ORDERS_STATUS_LIMIT + 5 }, (_, i) =>
          sighting({ order_id: i + 1 }),
        ),
        resolvedOrderIds: [],
      },
      T1,
    )
    const status = skippedOrdersStatus(many)
    expect(status.count).toBe(SKIPPED_ORDERS_STATUS_LIMIT + 5)
    expect(status.orders).toHaveLength(SKIPPED_ORDERS_STATUS_LIMIT)
  })
})

describe('skippedOrdersKey', () => {
  it('is per store scope, so a reconnect of the same store keeps the list', () => {
    expect(skippedOrdersKey('shop.example.se')).toBe('skipped_currency_orders:shop.example.se')
  })
})
