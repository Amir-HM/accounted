import type { SupabaseClient } from '@supabase/supabase-js'
import type { SkippedCurrencyOrder, SkippedOrdersStatus } from '../types'

export type { SkippedCurrencyOrder, SkippedOrdersStatus }

/**
 * Orders the sync skipped because their currency could not be resolved (see
 * lib/order-currency), kept durably per store until a later sync imports them.
 *
 * Why durable: the sync cursor moves past a skipped order (holding it would
 * stall the whole feed on data only the store can fix), so the per-run toast
 * and the log were the only trace of an affärshändelse that never reached the
 * Orders page. Every one of them has to reach the books (BFL), so the list
 * stays visible in the settings panel until the order imports.
 *
 * Storage: public.extension_data (extension_id 'woocommerce'), one row per
 * store. Keyed by the store scope, not the connection id, for the same reason
 * the external_id scheme is (lib/order-sync wooStoreScope): a reconnect after
 * a revoked key is a new connection row, and the list must survive it. The
 * sync writes on the service role; the panel reads through GET /status on
 * the user's client (extension_data_select: company members).
 */

export const WOO_EXTENSION_ID = 'woocommerce'

/** How many entries GET /status hands the panel; the count is always exact. */
export const SKIPPED_ORDERS_STATUS_LIMIT = 50

/** Longest raw currency value kept (it is plugin output, not trusted). */
const MAX_CURRENCY_LENGTH = 32

/** One sighting of an order whose currency could not be resolved. */
export interface SkippedSighting {
  order_id: number
  order_number: string
  order_date: string | null
  currency: string
}

/** Stored shape of the extension_data value. */
export interface SkippedOrdersValue {
  orders: SkippedCurrencyOrder[]
}

export function skippedOrdersKey(storeScope: string): string {
  return `skipped_currency_orders:${storeScope}`
}

function isEntry(value: unknown): value is SkippedCurrencyOrder {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.order_id === 'number' &&
    typeof v.order_number === 'string' &&
    (v.order_date === null || typeof v.order_date === 'string') &&
    typeof v.currency === 'string' &&
    typeof v.first_seen_at === 'string' &&
    typeof v.last_seen_at === 'string'
  )
}

/** Read a stored value defensively: anything malformed is dropped. */
export function parseSkippedOrders(value: unknown): SkippedCurrencyOrder[] {
  if (!value || typeof value !== 'object') return []
  const orders = (value as { orders?: unknown }).orders
  return Array.isArray(orders) ? orders.filter(isEntry) : []
}

function byOrderDate(a: SkippedCurrencyOrder, b: SkippedCurrencyOrder): number {
  const dateA = a.order_date ?? ''
  const dateB = b.order_date ?? ''
  if (dateA !== dateB) return dateA < dateB ? -1 : 1
  return a.order_id - b.order_id
}

/**
 * The list after one page of a sync: resolved orders leave, sighted orders
 * are added or refreshed (first_seen_at kept, the rest from the latest
 * sighting). An order reported as both is treated as resolved; the sync
 * never reports one order as both within a page.
 */
export function mergeSkippedOrders(
  existing: readonly SkippedCurrencyOrder[],
  change: { sighted: readonly SkippedSighting[]; resolvedOrderIds: readonly number[] },
  nowIso: string,
): SkippedCurrencyOrder[] {
  const resolved = new Set(change.resolvedOrderIds)
  const byId = new Map<number, SkippedCurrencyOrder>()
  for (const entry of existing) {
    if (!resolved.has(entry.order_id)) byId.set(entry.order_id, entry)
  }
  for (const sighting of change.sighted) {
    if (resolved.has(sighting.order_id)) continue
    const previous = byId.get(sighting.order_id)
    byId.set(sighting.order_id, {
      order_id: sighting.order_id,
      order_number: sighting.order_number,
      order_date: sighting.order_date,
      currency: sighting.currency.slice(0, MAX_CURRENCY_LENGTH),
      first_seen_at: previous?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
    })
  }
  return [...byId.values()].sort(byOrderDate)
}

/** Whether two lists differ in anything the panel or a later merge reads. */
export function skippedOrdersChanged(
  before: readonly SkippedCurrencyOrder[],
  after: readonly SkippedCurrencyOrder[],
): boolean {
  if (before.length !== after.length) return true
  return before.some((entry, i) => JSON.stringify(entry) !== JSON.stringify(after[i]))
}

/** The panel's slice of a stored list: exact count, oldest orders first. */
export function skippedOrdersStatus(orders: readonly SkippedCurrencyOrder[]): SkippedOrdersStatus {
  return { count: orders.length, orders: orders.slice(0, SKIPPED_ORDERS_STATUS_LIMIT) }
}

/**
 * Load the stored list. A read error is an error, never an empty list:
 * treating it as empty would let the next write erase every recorded order.
 */
export async function readSkippedOrders(
  supabase: SupabaseClient,
  companyId: string,
  storeScope: string,
): Promise<SkippedCurrencyOrder[]> {
  const { data, error } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', WOO_EXTENSION_ID)
    .eq('key', skippedOrdersKey(storeScope))
    .maybeSingle()
  if (error) {
    throw new Error(`skipped-orders read failed for ${storeScope}: ${error.message}`)
  }
  return parseSkippedOrders(data?.value)
}

/**
 * Persist the list; an empty list removes the row (value is NOT NULL and an
 * empty row would only be noise). Returns false on a failed write so the
 * caller can hold its cursor.
 */
export async function writeSkippedOrders(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  storeScope: string,
  orders: readonly SkippedCurrencyOrder[],
): Promise<boolean> {
  const key = skippedOrdersKey(storeScope)
  if (orders.length === 0) {
    const { error } = await supabase
      .from('extension_data')
      .delete()
      .eq('company_id', companyId)
      .eq('extension_id', WOO_EXTENSION_ID)
      .eq('key', key)
    return !error
  }
  const value: SkippedOrdersValue = { orders: [...orders] }
  const { error } = await supabase.from('extension_data').upsert(
    {
      user_id: userId,
      company_id: companyId,
      extension_id: WOO_EXTENSION_ID,
      key,
      value,
    },
    { onConflict: 'company_id,extension_id,key' },
  )
  return !error
}
