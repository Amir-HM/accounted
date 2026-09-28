/**
 * The salary payment-file operations (lib/operations/salary-payment-files.ts):
 * MCP-only doors over the services the v1 routes run. The services are
 * mocked except where a test needs the real builder to prove what a dry run
 * writes (nothing).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import type { OperationContext } from '../types'

const mockBuild = vi.fn()
vi.mock('@/lib/salary/payment/build-payment-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/payment/build-payment-file')>()
  return { ...actual, buildSalaryPaymentFile: (...a: unknown[]) => mockBuild(...a) }
})
const mockList = vi.fn()
vi.mock('@/lib/salary/payment/payment-file-archive', () => ({
  listSalaryPaymentFiles: (...a: unknown[]) => mockList(...a),
}))

import { salaryRunsPaymentFile, salaryRunsPaymentFilesList } from '../salary-payment-files'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FILE_ID = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
const XML = '<?xml version="1.0" encoding="UTF-8"?><Document/>'

function ctx(supabase: unknown = {}): OperationContext & { log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } } {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return { supabase: supabase as never, companyId: COMPANY_ID, userId: 'user-1', log: log as never }
}

const BUILT = {
  ok: true,
  format: 'pain001',
  filename: 'pain001_lon_2026-04.xml',
  content: XML,
  contentType: 'application/xml',
  charset: 'utf-8',
  sha256: 'a'.repeat(64),
  byteSize: 51,
  paymentDate: '2026-04-24',
  periodLabel: '2026-04',
  employeeCount: 2,
  totalAmount: 45000,
  warnings: [],
  generatedAt: '2026-04-20T10:00:00.000Z',
  stamped: true,
  paymentFileId: FILE_ID,
}

/** Every key of every object in a JSON schema, to prove no bare `id` leaks. */
function schemaKeys(node: unknown, keys: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => schemaKeys(n, keys))
  else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (obj.properties && typeof obj.properties === 'object') keys.push(...Object.keys(obj.properties))
    Object.values(obj).forEach((v) => schemaKeys(v, keys))
  }
  return keys
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('salary-runs.payment-file (gnubok_create_salary_payment_file)', () => {
  it('is an MCP-only staged write reusing the v1 id, scope and risk', () => {
    const op = salaryRunsPaymentFile
    expect(op).toMatchObject({ id: 'salary-runs.payment-file', kind: 'write', scope: 'payroll:write', risk: 'medium' })
    expect(op.http).toBeUndefined()
    expect(op.mcp?.name).toBe('gnubok_create_salary_payment_file')
    expect(op.mcp?.visibility ?? 'search').toBe('search')
    expect(op.mcp?.description).toMatch(/\bStage\b/)
    expect(op.mcp!.description!.length).toBeLessThanOrEqual(280)
    expect(op.mcp?.stage?.pendingType).toBe('create_salary_payment_file')
    expect(op.mcp?.keywords?.some((k) => k.includes('betalfil'))).toBe(true)
    expect(schemaKeys(z.toJSONSchema(op.output))).not.toContain('id')
  })

  it('titles the approval in Swedish and pins the format the preview resolved', () => {
    const stage = salaryRunsPaymentFile.mcp!.stage!
    expect(stage.title({ salary_run_id: RUN_ID })).toBe('Skapa betalfil för lönekörningen')
    expect(stage.title({ salary_run_id: RUN_ID, format: 'bg_lb' })).toBe('Skapa betalfil för lönekörningen (Bankgirot LB)')
    // No format given: the commit must build the company's preferred format
    // as previewed, even if the setting changes before approval.
    const pinned = stage.pinParams!({ salary_run_id: RUN_ID }, { format: 'bg_lb' })
    expect(pinned).toEqual({ salary_run_id: RUN_ID, format: 'bg_lb' })
    expect(salaryRunsPaymentFile.input.safeParse(pinned).success).toBe(true)
  })

  it('takes no execution date: the file always uses the run payment_date', () => {
    // The MCP dispatch refuses unknown keys against the generated inputSchema;
    // the input itself names only the run and the format.
    const shape = (salaryRunsPaymentFile.input as unknown as z.ZodObject<z.ZodRawShape>).shape
    expect(Object.keys(shape)).toEqual(['salary_run_id', 'format'])
  })

  it('returns the file as text with filename, format and totals', async () => {
    mockBuild.mockResolvedValue(BUILT)

    const outcome = await salaryRunsPaymentFile.run(ctx(), { salary_run_id: RUN_ID, format: 'pain001' }, { dryRun: false })

    expect(mockBuild).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      userId: 'user-1',
      format: 'pain001',
      dryRun: false,
    })
    expect(outcome.ok && !outcome.dryRun).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    const data = salaryRunsPaymentFile.output.parse(outcome.data)
    expect(data).toEqual({
      salary_run_id: RUN_ID,
      payment_file_id: FILE_ID,
      format: 'pain001',
      filename: 'pain001_lon_2026-04.xml',
      content_type: 'application/xml',
      charset: 'utf-8',
      content: XML,
      sha256: 'a'.repeat(64),
      byte_size: 51,
      payment_date: '2026-04-24',
      employee_count: 2,
      total_amount: 45000,
      currency: 'SEK',
      warnings: [],
      generated_at: '2026-04-20T10:00:00.000Z',
    })
  })

  it('still returns the file when only the run stamp failed, and logs it', async () => {
    mockBuild.mockResolvedValue({ ...BUILT, stamped: false })
    const c = ctx()

    const outcome = await salaryRunsPaymentFile.run(c, { salary_run_id: RUN_ID }, { dryRun: false })

    expect(outcome.ok).toBe(true)
    expect(c.log.warn).toHaveBeenCalledWith('payment file stamp failed; file returned anyway', expect.any(Object))
  })

  describe('with the real builder', () => {
    const run = { id: RUN_ID, status: 'approved', period_year: 2026, period_month: 4, payment_date: '2026-04-24' }
    const company = { name: 'Bolaget AB', org_number: '556000-0000' }
    const settings = {
      company_name: 'Bolaget AB',
      iban: 'SE4550000000058398257466',
      bic: 'HANDSESS',
      clearing_number: '6000',
      bank_name: null,
      bankgiro: '5050-1055',
      preferred_payment_format: 'pain001',
    }
    const anna = {
      employee_id: 'emp-1',
      net_salary: 20000,
      tax_withheld: 6000,
      tax_withheld_override: null,
      employee: { first_name: 'Anna', last_name: 'A', clearing_number: '6000', bank_account_number: '1234567', specification_number: 1 },
    }

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('@/lib/salary/payment/build-payment-file')>(
        '@/lib/salary/payment/build-payment-file',
      )
      mockBuild.mockImplementation(actual.buildSalaryPaymentFile)
    })

    it('a dry run builds in memory, returns no content and records nothing', async () => {
      const { supabase, enqueueMany, calls } = createQueuedMockSupabase()
      enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna] }])

      const outcome = await salaryRunsPaymentFile.run(ctx(supabase), { salary_run_id: RUN_ID }, { dryRun: true })

      expect(outcome.ok && outcome.dryRun).toBe(true)
      if (!outcome.ok || !outcome.dryRun) return
      expect(outcome.preview).toMatchObject({
        salary_run_id: RUN_ID,
        format: 'pain001',
        filename: 'pain001_lon_2026-04.xml',
        employee_count: 1,
        total_amount: 20000,
      })
      expect(outcome.preview).not.toHaveProperty('content')
      // No archive row and no payment-file tracking stamp on the run.
      expect(calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toEqual([])
    })

    it('the approved run archives the file, stamps the run and hands over the same bytes', async () => {
      const { supabase, enqueueMany, calls } = createQueuedMockSupabase()
      enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna] }, { data: null }, { data: null }])

      const outcome = await salaryRunsPaymentFile.run(ctx(supabase), { salary_run_id: RUN_ID }, { dryRun: false })

      expect(outcome.ok && !outcome.dryRun).toBe(true)
      if (!outcome.ok || outcome.dryRun) return
      // parse() throws on a mismatch; `!` only drops the `| undefined` that
      // defineOperation infers for every write with a dry-run branch.
      const data = salaryRunsPaymentFile.output.parse(outcome.data)!
      expect(data.content).toContain('<Nm>Bolaget AB</Nm>')
      const writes = calls.filter((c) => c.method === 'insert' || c.method === 'update').map((c) => `${c.table}.${c.method}`)
      expect(writes).toEqual(['salary_payment_files.insert', 'salary_runs.update'])
      const archived = calls.find((c) => c.method === 'insert')!.args[0] as Record<string, unknown>
      expect(archived.content).toBe(data.content)
      expect(archived.id).toBe(data.payment_file_id)
    })
  })

  describe('refusals carry the v1 code, with the specifics in Swedish for MCP', () => {
    it('a draft run: SALARY_RUN_PAYMENT_FILE_NOT_READY naming the status', async () => {
      mockBuild.mockResolvedValue({
        ok: false,
        code: 'RUN_NOT_READY',
        format: null,
        details: { current_status: 'draft', allowed_statuses: ['approved', 'paid', 'booked'] },
      })

      const outcome = await salaryRunsPaymentFile.run(ctx(), { salary_run_id: RUN_ID }, { dryRun: true })

      expect(outcome).toMatchObject({
        ok: false,
        code: 'SALARY_RUN_PAYMENT_FILE_NOT_READY',
        details: { current_status: 'draft' },
        messageSv: expect.stringMatching(/Lönekörningen har status draft\.$/),
      })
    })

    it('a missing company IBAN: SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS naming IBAN', async () => {
      mockBuild.mockResolvedValue({ ok: false, code: 'IBAN_MISSING', format: 'pain001', details: { field: 'iban' } })

      const outcome = await salaryRunsPaymentFile.run(ctx(), { salary_run_id: RUN_ID }, { dryRun: true })

      expect(outcome).toMatchObject({
        ok: false,
        code: 'SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS',
        details: { format: 'pain001', problem: 'iban_missing' },
        messageSv: expect.stringMatching(/Det som saknas eller är fel: IBAN\.$/),
      })
    })

    it('employees without bank details: named in the message, never an account number', async () => {
      mockBuild.mockResolvedValue({
        ok: false,
        code: 'EMPLOYEE_BANK_MISSING',
        format: 'pain001',
        details: { employee_count: 2, employees: [{ employee_id: 'emp-1', name: 'Anna A' }, { employee_id: 'emp-2', name: null }] },
      })

      const outcome = await salaryRunsPaymentFile.run(ctx(), { salary_run_id: RUN_ID }, { dryRun: true })

      expect(outcome).toMatchObject({
        ok: false,
        code: 'SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING',
        messageSv: expect.stringMatching(/Gäller: Anna A, emp-2\.$/),
      })
    })

    it('an unknown run: SALARY_RUN_NOT_FOUND', async () => {
      mockBuild.mockResolvedValue({ ok: false, code: 'RUN_NOT_FOUND', format: null, details: {} })

      const outcome = await salaryRunsPaymentFile.run(ctx(), { salary_run_id: RUN_ID }, { dryRun: true })

      expect(outcome).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
    })

    it('a database failure keeps its SQLSTATE, so a timeout stays retryable', async () => {
      mockBuild.mockResolvedValue({
        ok: false,
        code: 'DB_ERROR',
        format: null,
        stage: 'run',
        details: {},
        cause: { code: '57014', message: 'canceling statement due to statement timeout' },
      })

      const outcome = await salaryRunsPaymentFile.run(ctx(), { salary_run_id: RUN_ID }, { dryRun: true })

      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(getStructuredError(outcome.error)).toMatchObject({ code: 'TRANSIENT_ERROR', retryable: true })
    })

    it('an archive failure withholds the file and is logged', async () => {
      mockBuild.mockResolvedValue({
        ok: false,
        code: 'ARCHIVE_FAILED',
        format: 'pain001',
        details: {},
        cause: { code: '23514', message: 'new row violates check constraint' },
      })
      const c = ctx()

      const outcome = await salaryRunsPaymentFile.run(c, { salary_run_id: RUN_ID }, { dryRun: false })

      expect(outcome).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
      expect(c.log.error).toHaveBeenCalledWith('payment file archive failed; file withheld', expect.any(Object))
    })
  })
})

describe('salary-runs.payment-files.list (gnubok_list_salary_payment_files)', () => {
  const FILE = {
    payment_file_id: FILE_ID,
    format: 'bg_lb',
    filename: 'bg_lb_lon_2026-04.txt',
    content_type: 'text/plain',
    charset: 'iso-8859-1',
    sha256: 'b'.repeat(64),
    byte_size: 44,
    payment_date: '2026-04-24',
    employee_count: 2,
    total_amount: 45000,
    generated_at: '2026-04-19T09:00:00.000Z',
    content: '11123456700000000000260325LÖN 2026-04\r\n',
  }

  it('is an MCP-only read reusing the v1 id and scope', () => {
    const op = salaryRunsPaymentFilesList
    expect(op).toMatchObject({ id: 'salary-runs.payment-files.list', kind: 'read', scope: 'payroll:read', risk: 'low' })
    expect(op.http).toBeUndefined()
    expect(op.mcp?.name).toBe('gnubok_list_salary_payment_files')
    expect(op.mcp?.stage).toBeUndefined()
    expect(op.mcp?.visibility ?? 'search').toBe('search')
    expect(schemaKeys(z.toJSONSchema(op.output))).not.toContain('id')
  })

  it('lists the archived files with their content, ten per page by default', async () => {
    mockList.mockResolvedValue({ ok: true, files: [FILE], nextCursor: 'next-1' })
    const input = salaryRunsPaymentFilesList.input.parse({ salary_run_id: RUN_ID })

    const outcome = await salaryRunsPaymentFilesList.run(ctx(), input, { dryRun: false })

    expect(mockList).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      limit: 10,
      cursor: undefined,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(salaryRunsPaymentFilesList.output.parse(outcome.data)).toEqual({
      salary_run_id: RUN_ID,
      salary_payment_files: [FILE],
      next_cursor: 'next-1',
    })
  })

  it('passes the cursor and a coerced limit through', async () => {
    mockList.mockResolvedValue({ ok: true, files: [], nextCursor: null })
    const input = salaryRunsPaymentFilesList.input.parse({ salary_run_id: RUN_ID, limit: '2', cursor: 'abc' })

    await salaryRunsPaymentFilesList.run(ctx(), input, { dryRun: false })

    expect(mockList).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 2, cursor: 'abc' }))
  })

  it('answers SALARY_RUN_NOT_FOUND for a run outside the company', async () => {
    mockList.mockResolvedValue({ ok: false, code: 'RUN_NOT_FOUND' })

    const outcome = await salaryRunsPaymentFilesList.run(ctx(), { salary_run_id: RUN_ID, limit: 10 }, { dryRun: false })

    expect(outcome).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
  })

  it('hands a database failure over with its SQLSTATE', async () => {
    mockList.mockResolvedValue({ ok: false, code: 'DB_ERROR', cause: { code: '57014', message: 'canceling statement due to statement timeout' } })

    const outcome = await salaryRunsPaymentFilesList.run(ctx(), { salary_run_id: RUN_ID, limit: 10 }, { dryRun: false })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(getStructuredError(outcome.error).retryable).toBe(true)
  })
})
