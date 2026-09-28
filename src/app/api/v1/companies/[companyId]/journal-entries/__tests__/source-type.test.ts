/**
 * The v1 voucher doors (POST /journal-entries and /journal-entries/batch-create)
 * accept only the source types a caller may author: 'manual' (the default)
 * and 'import' for history replayed from another system. Every other label
 * belongs to a dedicated producer; accepting it let a business voucher claim
 * that type's dimension-policy exemption ('system' skips every rule, 'accrual'
 * skips registry validation) and show a false source in the ledger.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/api/v1/owns-fiscal-period', () => ({
  ownsFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, createDraftEntry: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { createDraftEntry } from '@/lib/bookkeeping/engine'
import { POST as createDraft } from '../route'
import { POST as batchCreate } from '../batch-create/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockOwnsPeriod = ownsFiscalPeriod as ReturnType<typeof vi.fn>
const mockCreateDraft = createDraftEntry as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FISCAL_PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/**
 * company_members proves the key may touch this company; every other
 * single-row read (idempotency store, the post-create refetch) answers null.
 */
function makeSupabase() {
  const build = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          const row = table === 'company_members'
            ? { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' }
            : null
          return () => Promise.resolve({ data: row, error: null })
        }
        return () => build(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => build(table)) }
}

const ENTRY = {
  fiscal_period_id: FISCAL_PERIOD_ID,
  entry_date: '2026-05-12',
  description: 'Bankavgift maj 2026',
  lines: [
    { account_number: '6570', debit_amount: 50, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 50 },
  ],
}

const ENGINE_OWNED = [
  'system',
  'accrual',
  'storno',
  'correction',
  'year_end',
  'currency_revaluation',
  'credit_note',
  'supplier_credit_note',
  'opening_balance',
  'vat_settlement',
  'invoice_paid',
  'salary_payment',
]

function makeRequest(path: string, body: unknown, { auth = true } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': `idem${Math.floor(Math.random() * 1e6)}-1010-4abc-8def-1234567890ab`,
  }
  if (auth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  return new Request(`http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

type ErrorBody = { error: { code: string; details?: { issues?: Array<{ field: string; message: string }> } } }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(makeSupabase())
  mockOwnsPeriod.mockResolvedValue(true)
  mockCreateDraft.mockResolvedValue({ id: 'je-1', status: 'draft', voucher_series: 'A', voucher_number: 0 })
})

describe('POST /api/v1/companies/:companyId/journal-entries: source_type', () => {
  it('returns 401 without an API key', async () => {
    const res = await createDraft(makeRequest('', ENTRY, { auth: false }), routeParams)
    expect(res.status).toBe(401)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it.each(ENGINE_OWNED)('refuses the engine-owned source_type %s with 400 naming the allowed values', async (sourceType) => {
    const res = await createDraft(makeRequest('', { ...ENTRY, source_type: sourceType }), routeParams)
    const body = (await res.json()) as ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    const issue = body.error.details?.issues?.find((i) => i.field === 'source_type')
    expect(issue?.message).toContain('"manual" eller "import"')
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('returns 404 when the fiscal period is not the company\'s', async () => {
    mockOwnsPeriod.mockResolvedValue(false)
    const res = await createDraft(makeRequest('', ENTRY), routeParams)
    const body = (await res.json()) as ErrorBody

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('creates a manual draft when source_type is omitted', async () => {
    const res = await createDraft(makeRequest('', ENTRY), routeParams)

    expect(res.status).toBe(201)
    expect(mockCreateDraft).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ source_type: 'manual' })
    )
  })

  it('keeps accepting import for history replayed from another system', async () => {
    const res = await createDraft(makeRequest('', { ...ENTRY, source_type: 'import' }), routeParams)

    expect(res.status).toBe(201)
    expect(mockCreateDraft).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ source_type: 'import' })
    )
  })
})

describe('POST /api/v1/companies/:companyId/journal-entries/batch-create: source_type', () => {
  it('returns 401 without an API key', async () => {
    const res = await batchCreate(makeRequest('/batch-create', { journal_entries: [ENTRY] }, { auth: false }), routeParams)
    expect(res.status).toBe(401)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('refuses the whole batch with 400 when any item carries an engine-owned source_type', async () => {
    const res = await batchCreate(
      makeRequest('/batch-create', {
        journal_entries: [ENTRY, { ...ENTRY, source_type: 'system' }],
      }),
      routeParams,
    )
    const body = (await res.json()) as ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    const issue = body.error.details?.issues?.find((i) => i.field === 'journal_entries.1.source_type')
    expect(issue?.message).toContain('"manual" eller "import"')
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('returns 404 when a fiscal period in the batch is not the company\'s', async () => {
    mockOwnsPeriod.mockResolvedValue(false)
    const res = await batchCreate(makeRequest('/batch-create', { journal_entries: [ENTRY] }), routeParams)

    expect(res.status).toBe(404)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('creates manual and import drafts', async () => {
    const res = await batchCreate(
      makeRequest('/batch-create', {
        journal_entries: [ENTRY, { ...ENTRY, source_type: 'import' }],
      }),
      routeParams,
    )
    const body = (await res.json()) as { data: { summary: { succeeded: number } } }

    expect(res.status).toBe(200)
    expect(body.data.summary.succeeded).toBe(2)
    expect(mockCreateDraft.mock.calls.map((call) => (call[3] as { source_type: string }).source_type)).toEqual([
      'manual',
      'import',
    ])
  })
})
