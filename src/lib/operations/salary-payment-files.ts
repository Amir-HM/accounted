/**
 * Salary payment files for agents, the step where the payroll month reaches
 * the bank:
 *
 *   salary-runs.payment-file         build the bank file for an approved run
 *   salary-runs.payment-files.list   the files a run has had, as archived
 *
 * MCP only. The v1 doors already exist as the hand-written routes
 * POST /salary-runs/{id}/payment-file and GET /salary-runs/{id}/payment-files
 * (same operation ids, scopes and risk); binding these operations to those
 * paths would change their public contract (the list answers a bare
 * paginated array there, and an operation's output must be an object). Both
 * doors run the same services in lib/salary/payment: buildSalaryPaymentFile
 * (the build, the archive row and the run stamp; a dry run does none of the
 * writes), listSalaryPaymentFiles, and salaryPaymentFileRefusal, which picks
 * the error code for both.
 *
 * Unlike the supplier betalfil download (supplier-payment-batches.ts has no
 * MCP binding for it), the file itself is handed to the agent as text: over
 * MCP the payroll month otherwise stops one step short of the bank. The file
 * names each employee with bank account and net pay, which the payroll tools
 * already show (gnubok_get_employee, gnubok_get_salary_run); it never
 * carries a personnummer.
 */
import { z } from 'zod'
import { MAX_LIMIT } from '@/lib/api/v1/pagination'
import { dbError } from '@/lib/errors/db-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { Logger } from '@/lib/logger'
import {
  buildSalaryPaymentFile,
  SALARY_PAYMENT_FILE_ALLOWED_STATUSES,
  SALARY_PAYMENT_FILE_FORMATS,
  salaryPaymentFileRefusal,
  type SalaryPaymentFileError,
  type SalaryPaymentFileErrorCode,
} from '@/lib/salary/payment/build-payment-file'
import { listSalaryPaymentFiles } from '@/lib/salary/payment/payment-file-archive'
import type { PendingOperationType } from '@/types'
import { defineOperation, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const EXAMPLE_RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EXAMPLE_FILE_ID = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
const EXAMPLE_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>…</CstmrCdtTrfInitn></Document>'

const SALARY_RUN_ID = z.string().uuid().describe('The salary run (salary_run_id, e.g. from gnubok_get_salary_run).')

const FORMAT = z.enum(SALARY_PAYMENT_FILE_FORMATS)
const CONTENT_TYPE = z.enum(['application/xml', 'text/plain'])
const CHARSET = z
  .enum(['utf-8', 'iso-8859-1'])
  .describe('Save content in this encoding: UTF-8 for pain001, ISO 8859-1 with CRLF line endings for bg_lb.')

const FILE_FIELDS = {
  payment_file_id: z.string().uuid().describe('The archived copy (salary_payment_files row).'),
  format: FORMAT,
  filename: z.string(),
  content_type: CONTENT_TYPE,
  charset: CHARSET,
  sha256: z.string().describe('Lowercase hex SHA-256 over the file bytes in charset.'),
  byte_size: z.number().int(),
  payment_date: z.string().describe('The execution date the file requests: the run\'s payment_date.'),
  employee_count: z.number().int().describe('Employees paid in the file (positive net payout).'),
  total_amount: z.number().describe('Sum of the net payouts in the file, SEK.'),
  generated_at: z.string(),
  content: z.string().describe('The whole file as text, exactly as generated: hand it over unchanged.'),
}

// ─────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────

const COMPANY_BANK_DETAIL_SV: Partial<Record<SalaryPaymentFileErrorCode, string>> = {
  SETTINGS_MISSING: 'företagsinställningarna saknas',
  IBAN_MISSING: 'IBAN',
  BIC_MISSING: 'BIC (varken sparad eller möjlig att härleda från clearingnummer eller banknamn)',
  BANKGIRO_MISSING: 'bankgironummer',
  BANKGIRO_INVALID: 'bankgironumret är ogiltigt',
}

/**
 * The registry sentence plus what the v1 envelope carries in details. The
 * MCP error envelope has no details, so the run's status, the missing company
 * detail and the employees concerned ride in the message instead.
 */
function refusalMessageSv(result: SalaryPaymentFileError, code: string): string | undefined {
  const sentence = getErrorEntry(code)?.message_sv
  if (!sentence) return undefined
  switch (result.code) {
    case 'RUN_NOT_READY':
      return `${sentence} Lönekörningen har status ${String(result.details.current_status)}.`
    case 'SETTINGS_MISSING':
    case 'IBAN_MISSING':
    case 'BIC_MISSING':
    case 'BANKGIRO_MISSING':
    case 'BANKGIRO_INVALID':
      return `${sentence} Det som saknas eller är fel: ${COMPANY_BANK_DETAIL_SV[result.code]}.`
    case 'EMPLOYEE_BANK_MISSING': {
      const employees = (result.details.employees ?? []) as Array<{ employee_id: string; name: string | null }>
      return `${sentence} Gäller: ${employees.map((e) => e.name ?? e.employee_id).join(', ')}.`
    }
    case 'EMPLOYEE_BANK_INVALID':
    case 'GENERATOR_FAILED':
      return typeof result.details.message === 'string' && result.details.message
        ? `${sentence} ${result.details.message}`
        : undefined
    default:
      return undefined
  }
}

function refusalOutcome(result: SalaryPaymentFileError, log: Logger): Extract<OperationOutcome<never>, { ok: false }> {
  const refusal = salaryPaymentFileRefusal(result)
  if (!refusal) {
    if (result.code === 'ARCHIVE_FAILED') {
      // The file is räkenskapsinformation and is never handed out unarchived.
      log.error('payment file archive failed; file withheld', { format: result.format, error: result.cause })
    }
    return { ok: false, code: 'INTERNAL_ERROR', error: dbError(result.cause) }
  }
  const messageSv = refusalMessageSv(result, refusal.code)
  return {
    ok: false,
    code: refusal.code,
    ...(refusal.details ? { details: refusal.details } : {}),
    ...(messageSv ? { messageSv } : {}),
  }
}

function stageTitle(input: Record<string, unknown>): string {
  const label = input.format === 'pain001' ? ' (pain.001)' : input.format === 'bg_lb' ? ' (Bankgirot LB)' : ''
  return `Skapa betalfil för lönekörningen${label}`
}

const PaymentFileCreated = z.object({
  salary_run_id: z.string().uuid(),
  ...FILE_FIELDS,
  payment_file_id: FILE_FIELDS.payment_file_id.describe(
    'The archived copy (salary_payment_files row); gnubok_list_salary_payment_files returns it again.',
  ),
  currency: z.literal('SEK'),
  warnings: z.array(z.string()).describe('Swedish notes to pass on: a derived BIC, the LB phase-out, employees left out at 0 kr.'),
})

export const salaryRunsPaymentFile = defineOperation({
  id: 'salary-runs.payment-file',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  // As on the v1 endpoint of the same id: a new build replaces the run's
  // stamp, and the archive rows are records, not effects on the books.
  reversible: true,
  docs: {
    summary: 'Build the bank payment file (pain.001 or Bankgirot LB) for an approved salary run.',
    description:
      'Builds the salary batch payment file for an approved, paid or booked run: ISO 20022 pain.001.001.03 XML (pain001, the default) or the Bankgirot LB text file (bg_lb). One credit transfer per employee with a positive net payout, dated on the run\'s payment_date, category purpose SALA. The file is archived as an immutable salary_payment_files row before it is returned (BFL 7 kap. 1 §) and the run is stamped with the format and time. Nothing is sent to the bank and the run is not marked paid. Dry-runnable: the dry run checks every precondition and builds the file in memory, and returns format, filename, payment_date, employee_count, total_amount and warnings without the content, without archiving and without stamping the run.',
    useWhen:
      'The run is approved and the user, or their payroll operator, needs the file to upload in the bank\'s file channel to pay the salaries.',
    doNotUseFor:
      'Marking the run paid or booking it (gnubok_book_salary_run), paying supplier invoices (supplier payment batches), or getting back a file generated earlier (gnubok_list_salary_payment_files returns it byte for byte).',
    pitfalls: [
      `Run status must be one of ${SALARY_PAYMENT_FILE_ALLOWED_STATUSES.join(', ')}: a draft or review run is refused with SALARY_RUN_PAYMENT_FILE_NOT_READY.`,
      'pain001 needs the company IBAN and a BIC (saved, or derived from the company clearing number or bank name); bg_lb needs a valid company bankgiro number. Otherwise SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS names what is missing.',
      'Every employee with a net payout needs clearing and account number: SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING or _EMPLOYEE_BANK_INVALID names the employees, never an account number. Fix them with gnubok_update_employee and stage again.',
      'Hand content to the user unchanged: saved under filename in charset (pain001 as UTF-8, bg_lb as ISO 8859-1 with CRLF line endings), then uploaded in the bank. Do not reformat the XML.',
      'Each approval builds, archives and stamps a new file; after a bank-detail change it is a different file. The archive (gnubok_list_salary_payment_files) is the record of what the bank received.',
      'Bankgirot LB is being retired by the banks during 2026: prefer pain001. format defaults to the company\'s preferred payment format, pain001 unless changed.',
      'Employees with a zero net payout are left out and need no bank account; employee_count and total_amount cover only the paid lines.',
      'The file always uses the run\'s payment_date as the execution date.',
    ],
    example: {
      request: { salary_run_id: EXAMPLE_RUN_ID, format: 'pain001' },
      response: {
        data: {
          salary_run_id: EXAMPLE_RUN_ID,
          payment_file_id: EXAMPLE_FILE_ID,
          format: 'pain001',
          filename: 'pain001_lon_2026-05.xml',
          content_type: 'application/xml',
          charset: 'utf-8',
          content: EXAMPLE_XML,
          sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          byte_size: 2731,
          payment_date: '2026-05-25',
          employee_count: 3,
          total_amount: 76500,
          currency: 'SEK',
          warnings: [],
          generated_at: '2026-05-20T08:00:00.000Z',
        },
        meta: META,
      },
    },
  },
  input: z.object({
    salary_run_id: SALARY_RUN_ID,
    format: FORMAT.optional().describe(
      'pain001 (ISO 20022, every Swedish bank) or bg_lb (Bankgirot LB, retired during 2026). Omit for the company\'s preferred format.',
    ),
  }),
  output: PaymentFileCreated,
  errorCodes: [
    'SALARY_RUN_NOT_FOUND',
    'SALARY_RUN_PAYMENT_FILE_NOT_READY',
    'COMPANY_NOT_FOUND',
    'SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS',
    'SALARY_RUN_NO_EMPLOYEES',
    'SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING',
    'SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_INVALID',
    'SALARY_RUN_PAYMENT_FILE_GENERATION_FAILED',
  ],
  mcp: {
    name: 'gnubok_create_salary_payment_file',
    title: 'Create Salary Payment File',
    description:
      'Stage building the bank payment file for an approved (or paid/booked) salary run: pain.001 XML or Bankgirot LB. Approval archives it and returns it as text (content) with filename, charset and totals for the user to upload in the bank. Moves no money.',
    keywords: [
      'betalfil lön',
      'lönefil',
      'löneutbetalning',
      'utbetalningsfil',
      'betala ut lön',
      'pain.001 lön',
      'bankgirot lb',
      'lönebetalning bank',
    ],
    stage: {
      // integrator: add to PendingOperationType
      pendingType: 'create_salary_payment_file' as PendingOperationType,
      title: stageTitle,
      // The commit builds the format the preview resolved (the company's
      // preference when none was given), not whatever the setting says at
      // approval time.
      pinParams: (input, preview) =>
        typeof preview.format === 'string' ? { ...input, format: preview.format } : input,
    },
  },
  run: async (ctx, { salary_run_id, format }, { dryRun }) => {
    const result = await buildSalaryPaymentFile(ctx.supabase, {
      companyId: ctx.companyId,
      runId: salary_run_id,
      userId: ctx.userId,
      format,
      dryRun,
    })
    if (!result.ok) return refusalOutcome(result, ctx.log)

    const summary = {
      salary_run_id,
      format: result.format,
      filename: result.filename,
      content_type: result.contentType,
      charset: result.charset,
      payment_date: result.paymentDate,
      employee_count: result.employeeCount,
      total_amount: result.totalAmount,
      currency: 'SEK' as const,
      warnings: result.warnings,
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          ...summary,
          would_stamp: {
            payment_file_format: result.format,
            payment_file_generated_at: 'now (server time) on approval',
          },
          note: 'Preconditions checked and the file built in memory; nothing was archived or stamped. Approval archives the file and returns it as content.',
        },
      }
    }

    if (!result.stamped) {
      // The archived row is the record; the stamp is bookkeeping about the
      // run, so a failed UPDATE is logged, never fatal.
      ctx.log.warn('payment file stamp failed; file returned anyway', {
        salaryRunId: salary_run_id,
        paymentFileId: result.paymentFileId,
        format: result.format,
      })
    }

    return {
      ok: true,
      created: true,
      data: {
        ...summary,
        payment_file_id: result.paymentFileId as string,
        content: result.content,
        sha256: result.sha256,
        byte_size: result.byteSize,
        generated_at: result.generatedAt ?? new Date().toISOString(),
      },
    }
  },
})

// ─────────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────────

const ArchivedPaymentFile = z.object({
  ...FILE_FIELDS,
  payment_file_id: FILE_FIELDS.payment_file_id.describe(
    'The archived row (the payment_file_id gnubok_create_salary_payment_file returned).',
  ),
})

export const salaryRunsPaymentFilesList = defineOperation({
  id: 'salary-runs.payment-files.list',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the archived bank payment files of a salary run, newest first.',
    description:
      'Every payment file generated for the run (ISO 20022 pain.001 or Bankgirot LB), newest first, with the file content inline. Each row is the immutable archive copy written when the file was generated (BFL 7 kap. 1 §, seven-year retention): what was handed to the bank, byte for byte. sha256 and byte_size are over content encoded as charset. Paginated newest first; pass next_cursor back as cursor until it is null.',
    useWhen:
      'The user needs a file generated earlier again (to re-upload, to check a checksum against the bank portal, or to see what the bank received) rather than a new build from the run\'s current data.',
    doNotUseFor:
      'Building a file (gnubok_create_salary_payment_file), marking the run paid or booking it (gnubok_book_salary_run), or supplier payment batches.',
    pitfalls: [
      'An empty list means no file has been generated for the run yet (or the run predates the archive): build one with gnubok_create_salary_payment_file.',
      'Rows are immutable and never deleted; a regeneration adds a row. The newest row is not necessarily the one uploaded to the bank: compare sha256 with the file that was actually sent.',
      'Every row carries the whole file, so keep limit small for runs with many regenerations.',
    ],
    example: {
      response: {
        data: {
          salary_run_id: EXAMPLE_RUN_ID,
          salary_payment_files: [
            {
              payment_file_id: EXAMPLE_FILE_ID,
              format: 'pain001',
              filename: 'pain001_lon_2026-05.xml',
              content_type: 'application/xml',
              charset: 'utf-8',
              sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
              byte_size: 2731,
              payment_date: '2026-05-25',
              employee_count: 3,
              total_amount: 76500,
              generated_at: '2026-05-20T08:00:00.000Z',
              content: EXAMPLE_XML,
            },
          ],
          next_cursor: null,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    salary_run_id: SALARY_RUN_ID,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(10)
      .describe(`Page size, 1-${MAX_LIMIT} (default 10: every row carries the whole file).`),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
  }),
  output: z.object({
    salary_run_id: z.string().uuid(),
    salary_payment_files: z.array(ArchivedPaymentFile),
    next_cursor: z.string().nullable(),
  }),
  errorCodes: ['SALARY_RUN_NOT_FOUND'],
  mcp: {
    name: 'gnubok_list_salary_payment_files',
    title: 'List Salary Payment Files',
    description:
      'The payment files generated for a salary run, newest first: each archived pain.001 or Bankgirot LB file as text (content) with filename, charset, sha256 and totals, exactly as handed to the bank. Paginate with cursor = next_cursor.',
    keywords: ['betalfiler lön', 'arkiverad betalfil', 'lönefil', 'utbetalningsfil', 'pain.001', 'bankgirot lb'],
  },
  run: async (ctx, { salary_run_id, limit, cursor }) => {
    const result = await listSalaryPaymentFiles(ctx.supabase, {
      companyId: ctx.companyId,
      salaryRunId: salary_run_id,
      limit,
      cursor,
    })
    if (!result.ok) {
      if (result.code === 'RUN_NOT_FOUND') return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
      return { ok: false, code: 'INTERNAL_ERROR', error: dbError(result.cause) }
    }
    return {
      ok: true,
      data: { salary_run_id, salary_payment_files: result.files, next_cursor: result.nextCursor },
    }
  },
})
