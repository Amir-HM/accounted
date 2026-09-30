import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams } from '@/tests/helpers'

// The route is wrapped in withRouteContext. Auth/company are injected via the
// mocked requireAuth + getActiveCompanyId; the PDF pipeline is fully stubbed.
const { SERVICE_CLIENT } = vi.hoisted(() => ({ SERVICE_CLIENT: { service: true } }))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyDisplayName: vi.fn().mockResolvedValue('Ny Firma AB'),
}))
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn(async () => Buffer.from('%PDF-fake')),
}))
vi.mock('@/lib/salary/pdf/payslip-template', () => ({ PayslipPDF: vi.fn(() => null) }))
vi.mock('@/lib/salary/payslips/build-payslip-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/payslips/build-payslip-data')>()
  return {
    ...actual,
    buildPayslipData: vi.fn(() => ({})),
    payslipFileName: vi.fn(() => 'lonespec_Test_2026-06.pdf'),
  }
})

vi.mock('@/lib/salary/payslips/section-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payslips/section-snapshot')>()),
  issuePayslipSections: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => SERVICE_CLIENT) }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getCompanyDisplayName } from '@/lib/company/context'
import { buildPayslipData } from '@/lib/salary/payslips/build-payslip-data'
import { issuePayslipSections } from '@/lib/salary/payslips/section-snapshot'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const NOT_ISSUED = {
  payslip_sections_issued_at: null,
  payslip_show_employer_cost: null,
  payslip_show_breakdown: null,
}

function authed() {
  const { supabase, enqueue, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueue, enqueueMany }
}

describe('GET /api/salary/runs/[id]/payslips/[employeeId]/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCompanyDisplayName).mockResolvedValue('Ny Firma AB')
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: true, snapshot: NOT_ISSUED })
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 404 when the run does not exist', async () => {
    const { enqueueMany } = authed()
    enqueueMany([{ data: null }])
    const response = await GET(
      createMockRequest('/api/salary/runs/run-x/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-x', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(404)
  })

  it('renders the payslip PDF with the current company name', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    // Employer name follows the current company_settings.company_name (resolved
    // by getCompanyDisplayName), not the frozen onboarding companies.name.
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ company: { name: 'Ny Firma AB', org_number: '5560000000' } }),
    )
  })

  it('renders the employer view with every section when no audience is given', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ audience: { kind: 'employer' } }),
    )
  })

  it('renders the employee copy with the company section switches for ?audience=employee', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: {
          kind: 'employee',
          settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false },
        },
      }),
    )
  })

  it('returns 500 instead of printing hidden sections when the switches cannot be read', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: null, error: { message: 'timeout' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(500)
    expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
  })

  it('renders the employee copy from the sections the run was issued with', async () => {
    const { enqueueMany } = authed()
    const run = { id: 'run-1', status: 'paid', period_year: 2026, period_month: 6, payment_date: '2026-06-25' }
    const hiddenNow = { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false }
    enqueueMany([
      { data: run },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: hiddenNow },
    ])
    const issuedShown = {
      payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
      payslip_show_employer_cost: true,
      payslip_show_breakdown: true,
    }
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: true, snapshot: issuedShown })

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    // Handing out the copy issues the run, through the service client (a
    // read-only member may download it) scoped to the active company.
    expect(vi.mocked(issuePayslipSections)).toHaveBeenCalledWith(SERVICE_CLIENT, {
      companyId: 'company-1',
      run,
      settings: hiddenNow,
    })
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ run: { ...run, ...issuedShown } }),
    )
  })

  it('returns 500 when the issued sections cannot be fixed', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: { salary_payslip_show_employer_cost: true, salary_payslip_show_breakdown: true } },
    ])
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: false, error: new Error('timeout') })

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(500)
    expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
  })

  it('never issues the run for the employer view', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'booked', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown audience', async () => {
    authed()
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'auditor' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(400)
    expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
  })

  it('falls back to companies.name when the resolver returns null', async () => {
    const { enqueueMany } = authed()
    vi.mocked(getCompanyDisplayName).mockResolvedValue(null)
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ company: { name: 'Bolaget AB', org_number: '5560000000' } }),
    )
  })
})
