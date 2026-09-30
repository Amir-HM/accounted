import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getCompanyDisplayName } from '@/lib/company/context'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF } from '@/lib/salary/pdf/payslip-template'
import {
  buildPayslipData,
  parsePayslipAudienceParam,
  payslipFileName,
  type PayslipAudience,
} from '@/lib/salary/payslips/build-payslip-data'
import { contentDisposition } from '@/lib/api/content-disposition'

ensureInitialized()

/**
 * Generate pay slip PDF for a specific employee in a salary run.
 *
 * Per BFL: Pay slips are räkenskapsinformation/underlag linked to
 * posted journal entries. Subject to 7-year retention per BFL 7 kap.
 *
 * Data assembly is shared with the public token surface via
 * lib/salary/payslips/build-payslip-data — both must render identical PDFs.
 *
 * Without a query this is the employer's own view: every section printed.
 * `?audience=employee` renders the copy the employer hands out (the bulk ZIP
 * on the run page), which follows the company's payslip section switches
 * exactly like the emailed link does.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string; employeeId: string }> }>(
  'salary.run.payslip.pdf',
  async (request, ctx, { params }) => {
    const { id, employeeId } = await params
    const { supabase, companyId } = ctx

    const audienceKind = parsePayslipAudienceParam(new URL(request.url).searchParams.get('audience'))
    if (!audienceKind) {
      return NextResponse.json({ error: 'Ogiltig mottagare för lönespecifikationen' }, { status: 400 })
    }

    // Load salary run
    const { data: run } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    // Load salary run employee
    const { data: sre } = await supabase
      .from('salary_run_employees')
      .select('*, employee:employees(first_name, last_name, personnummer, personnummer_last4, employment_type, tax_table_number, tax_column, clearing_number, bank_account_number), line_items:salary_line_items(*)')
      .eq('salary_run_id', id)
      .eq('employee_id', employeeId)
      .single()

    if (!sre) {
      return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
    }

    // Load company
    const { data: company } = await supabase
      .from('companies')
      .select('name, org_number')
      .eq('id', companyId)
      .single()

    if (!company) {
      return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
    }

    const emp = sre.employee as {
      first_name: string; last_name: string; personnummer: string; personnummer_last4: string;
      employment_type: string; tax_table_number: number | null; tax_column: number;
      clearing_number: string | null; bank_account_number: string | null;
    }

    // Employer name on the payslip follows the current company name
    // (company_settings.company_name), not the frozen onboarding companies.name.
    const displayName = await getCompanyDisplayName(supabase, companyId)

    let audience: PayslipAudience = { kind: 'employer' }
    if (audienceKind === 'employee') {
      const { data: sectionSettings, error: settingsError } = await supabase
        .from('company_settings')
        .select('salary_payslip_show_employer_cost, salary_payslip_show_breakdown')
        .eq('company_id', companyId)
        .maybeSingle()
      // Fail closed: a failed read must not fall back to the defaults and
      // print sections the company has hidden from its employees.
      if (settingsError) {
        return NextResponse.json({ error: 'Kunde inte läsa lönespecifikationens inställningar' }, { status: 500 })
      }
      audience = { kind: 'employee', settings: sectionSettings }
    }

    const data = buildPayslipData({
      run,
      sre,
      employee: emp,
      company: { name: displayName ?? company.name, org_number: company.org_number },
      audience,
    })
    const fileName = payslipFileName(run, emp)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await renderToBuffer(PayslipPDF({ data }) as any)

    return new Response(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        // RFC 5987 dual form: employee names with non-Latin-1 characters
        // (e.g. NFD combining marks) would otherwise make undici reject
        // the header value and crash the response.
        'Content-Disposition': contentDisposition('inline', fileName),
      },
    })
  },
)
