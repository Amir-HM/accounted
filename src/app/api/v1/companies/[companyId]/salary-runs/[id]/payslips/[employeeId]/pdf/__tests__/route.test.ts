/**
 * ASVS V8.2.1: the payslip PDF endpoint returns full personnummer-bearing
 * payroll data, so the binding between the API key's user and the
 * `[companyId]` path segment must be enforced server-side BEFORE any payslip
 * data is read. The check lives in withApiV1 (company_members lookup); these
 * tests pin it to this concrete route so a wrapper regression or a future
 * unwrapped rewrite of the route fails loudly here.
 *
 * Deliberate convention: the deny case is 404 (not 403) so an unauthorized
 * caller cannot probe which company ids exist (see DECISIONS.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>(
    '@/lib/api/idempotency',
  )
  return {
    ...actual,
    checkIdempotencyKey: vi.fn(),
    storeIdempotencyResponse: vi.fn(),
  }
})

// PDF rendering is irrelevant to the auth surface under test; keep the test
// hermetic (no @react-pdf font/layout machinery).
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn() }))
vi.mock('@/lib/salary/pdf/payslip-template', () => ({ PayslipPDF: vi.fn() }))
vi.mock('@/lib/salary/payslips/build-payslip-data', () => ({
  buildPayslipData: vi.fn(),
  payslipFileName: vi.fn(() => 'payslip.pdf'),
}))
vi.mock('@/lib/company/context', () => ({ getCompanyDisplayName: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { renderToBuffer } from '@react-pdf/renderer'
import { buildPayslipData } from '@/lib/salary/payslips/build-payslip-data'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_A = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333'

function makeSupabaseStub(membership: { company_id: string; role: string } | null) {
  const from = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: membership, error: null }),
        }),
      }),
    }),
  })
  return { from }
}

/** Every query resolves by table: select/eq chain to themselves, maybeSingle ends. */
function makeTableStub(rows: Record<string, unknown>) {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(async () => ({ data: rows[table] ?? null, error: null }))
    return chain
  })
  return { from }
}

function makeRequest(companyId: string, init?: RequestInit, query = '') {
  return new Request(
    `https://x.test/api/v1/companies/${companyId}/salary-runs/${RUN_ID}/payslips/${EMPLOYEE_ID}/pdf${query}`,
    init,
  )
}

function makeParams(companyId: string, id: string = RUN_ID, employeeId: string = EMPLOYEE_ID) {
  return { params: Promise.resolve({ companyId, id, employeeId }) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/v1/companies/[companyId]/salary-runs/[id]/payslips/[employeeId]/pdf', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest(COMPANY_A), makeParams(COMPANY_A))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 404 and reads no payslip data when the key user is not a member of the URL company', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      apiKeyId: 'key-1',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    const stub = makeSupabaseStub(null) // no membership in the URL company
    mockServiceClient.mockReturnValue(stub)

    const res = await GET(
      makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }),
      makeParams(COMPANY_A),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    // The deny fires in the wrapper: the handler's salary_runs /
    // salary_run_employees / companies queries must never have run.
    expect(stub.from.mock.calls.map((c) => c[0])).toEqual(['company_members'])
  })

  it('rejects non-UUID path ids with 400 before touching payroll tables', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      apiKeyId: 'key-1',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    const stub = makeSupabaseStub({ company_id: COMPANY_A, role: 'owner' })
    mockServiceClient.mockReturnValue(stub)

    const res = await GET(
      makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }),
      makeParams(COMPANY_A, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(stub.from.mock.calls.map((c) => c[0])).toEqual(['company_members'])
  })

  it('rejects an unknown audience with 400 before touching payroll tables', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      apiKeyId: 'key-1',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    const stub = makeSupabaseStub({ company_id: COMPANY_A, role: 'owner' })
    mockServiceClient.mockReturnValue(stub)

    const res = await GET(
      makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=auditor'),
      makeParams(COMPANY_A),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(stub.from.mock.calls.map((c) => c[0])).toEqual(['company_members'])
  })

  describe('audience', () => {
    const rows = {
      company_members: { company_id: COMPANY_A, role: 'owner' },
      salary_runs: { id: RUN_ID, period_year: 2026, period_month: 6, payment_date: '2026-06-25' },
      salary_run_employees: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] },
      companies: { name: 'Bolaget AB', org_number: '5560000000' },
      company_settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: true },
    }

    beforeEach(() => {
      mockValidate.mockResolvedValue({
        userId: 'user-1',
        apiKeyId: 'key-1',
        scopes: ['payroll:read'],
        mode: 'live',
      })
      vi.mocked(renderToBuffer).mockResolvedValue(Buffer.from('%PDF-fake'))
    })

    it('renders the employer view (every section) without an audience and never reads the switches', async () => {
      const stub = makeTableStub(rows)
      mockServiceClient.mockReturnValue(stub)

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('application/pdf')
      expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
        expect.objectContaining({ audience: { kind: 'employer' } }),
      )
      expect(stub.from.mock.calls.map((c) => c[0])).not.toContain('company_settings')
    })

    it('renders the employee copy with the company section switches for audience=employee', async () => {
      mockServiceClient.mockReturnValue(makeTableStub(rows))

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
        expect.objectContaining({
          audience: {
            kind: 'employee',
            settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: true },
          },
        }),
      )
    })
  })
})
