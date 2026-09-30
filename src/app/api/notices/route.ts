import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getCompanyNotices } from '@/lib/notices'

/**
 * GET /api/notices: active degraded-state notices for the active company,
 * in priority order (lib/notices, the health sibling of /api/worklist/counts).
 *
 * Read-only; every predicate is one bounded query that soft-fails to null,
 * and per-user dismissals are already filtered out. No events are emitted,
 * so the route adds no module-level ensureInitialized(). withRouteContext
 * still wires the bus on every request (idempotent: one boolean check once
 * warm), so lib/init and the extension registry are in this polled route's
 * import graph and load on a cold start.
 *
 * Response: { data: { notices: Notice[] } }
 */
export const GET = withRouteContext('notices.list', async (_request, ctx) => {
  const { supabase, companyId, user } = ctx
  const notices = await getCompanyNotices(supabase, companyId, { userId: user.id })
  return NextResponse.json({ data: { notices } })
})
