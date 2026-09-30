/**
 * withRouteContext wires the event bus before it runs the handler.
 *
 * The bus (lib/events/bus.ts) returns early when an event type has no handler,
 * and only ensureInitialized() (lib/init.ts) registers the core handlers. The
 * session route that locks a period never called it, so 636 of 758 period
 * locks in production left no `period.locked` row in event_log. These tests
 * run the REAL ensureInitialized() and the REAL event_log handler: only the
 * auth/company plumbing, the service-role client and the extension loader
 * (covered by its own tests) are stubbed.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { makeFiscalPeriod } from '@/tests/helpers'

const insertMock = vi.hoisted(() => vi.fn(async () => ({ error: null })))

vi.mock('@/lib/auth/require-auth', async () => {
  const { createMockSupabase: mockSupabase } = await import('@/tests/helpers')
  return {
    requireAuth: vi.fn(async () => ({ user: { id: 'user-1' }, supabase: mockSupabase().supabase })),
  }
})

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn(async () => 'company-1'),
}))

// Handlers write through the cookieless service-role client. event_log inserts
// are recorded; every other table (the webhook fan-out lookup) reads empty.
vi.mock('@/lib/auth/api-keys', async () => {
  const { createMockSupabase: mockSupabase } = await import('@/tests/helpers')
  return {
    createServiceClientNoCookies: () => {
      const fallback = mockSupabase().supabase
      return {
        from: (table: string) => (table === 'event_log' ? { insert: insertMock } : fallback.from(table)),
      }
    },
  }
})

// Extension wiring is exercised by the extension registry tests; stubbing the
// loader keeps this file on the core handlers.
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))

import { withRouteContext } from '../with-route-context'
import { eventBus } from '@/lib/events/bus'

const EMPTY_PARAMS = { params: Promise.resolve({}) }

function lockPeriodRoute() {
  return withRouteContext(
    'period.lock',
    async (_request, { user, companyId }) => {
      // Stands in for lockPeriod(): the service emits on the shared bus.
      await eventBus.emit({
        type: 'period.locked',
        payload: { period: makeFiscalPeriod({ id: 'period-1' }), userId: user.id, companyId },
      })
      return NextResponse.json({ data: { id: 'period-1' } })
    },
  )
}

describe('withRouteContext: event bus initialisation', () => {
  it('persists an event the handler emits, with no ensureInitialized() in the route', async () => {
    // Precondition: nothing has wired the bus in this module graph yet, so an
    // emit outside a wrapped route is dropped, exactly as in production.
    await eventBus.emit({
      type: 'period.locked',
      payload: { period: makeFiscalPeriod({ id: 'period-0' }), userId: 'user-1', companyId: 'company-1' },
    })
    expect(insertMock).not.toHaveBeenCalled()

    const res = await lockPeriodRoute()(
      new Request('http://localhost/api/bookkeeping/fiscal-periods/period-1/lock', { method: 'POST' }),
      EMPTY_PARAMS,
    )

    expect(res.status).toBe(200)
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'period.locked',
        entity_id: 'period-1',
        user_id: 'user-1',
        company_id: 'company-1',
      }),
    )
  })

  it('wires the handlers once: later requests persist each event exactly once', async () => {
    insertMock.mockClear()
    const route = lockPeriodRoute()

    await route(new Request('http://localhost/api/x', { method: 'POST' }), EMPTY_PARAMS)
    await route(new Request('http://localhost/api/x', { method: 'POST' }), EMPTY_PARAMS)

    expect(insertMock).toHaveBeenCalledTimes(2)
  })
})
