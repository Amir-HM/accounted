/**
 * pg-real tests for the salary_runs payslip section snapshot in
 * 20260930200000_payslip_section_visibility.sql.
 *
 * Verifies:
 *   - a new run carries no snapshot (all three columns NULL = not yet issued)
 *   - the snapshot is all-or-nothing and never shows the breakdown without
 *     the employer cost (CHECK salary_runs_payslip_sections_snapshot_shape)
 *   - once issued it is written once: any change is refused by
 *     salary_runs_payslip_sections_write_once, other run columns stay editable
 *   - the application's guarded first-issue update matches nothing on a run
 *     that is already issued, so a later send cannot overwrite it
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'

async function seedRun(): Promise<string> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 6, '2026-06-25', 'approved')`,
    [runId, companyId, userId],
  )
  return runId
}

async function snapshotOf(runId: string) {
  const { rows } = await getPool().query<{
    payslip_sections_issued_at: Date | null
    payslip_show_employer_cost: boolean | null
    payslip_show_breakdown: boolean | null
  }>(
    `SELECT payslip_sections_issued_at, payslip_show_employer_cost, payslip_show_breakdown
       FROM public.salary_runs WHERE id = $1`,
    [runId],
  )
  return rows[0]
}

/** The update issuePayslipSections sends: only a run without a snapshot matches. */
async function issue(runId: string, employerCost: boolean, breakdown: boolean): Promise<number> {
  const result = await getPool().query(
    `UPDATE public.salary_runs
        SET payslip_sections_issued_at = now(),
            payslip_show_employer_cost = $2,
            payslip_show_breakdown = $3
      WHERE id = $1 AND payslip_sections_issued_at IS NULL`,
    [runId, employerCost, breakdown],
  )
  return result.rowCount ?? 0
}

describe('salary_runs payslip section snapshot', () => {
  it('starts unissued: all three columns NULL', async () => {
    const runId = await seedRun()
    expect(await snapshotOf(runId)).toEqual({
      payslip_sections_issued_at: null,
      payslip_show_employer_cost: null,
      payslip_show_breakdown: null,
    })
  })

  it('refuses a partial snapshot', async () => {
    const runId = await seedRun()
    await expect(
      getPool().query(
        `UPDATE public.salary_runs SET payslip_sections_issued_at = now() WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.salary_runs SET payslip_show_employer_cost = true, payslip_show_breakdown = true WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a snapshot that shows the breakdown without the employer cost', async () => {
    const runId = await seedRun()
    await expect(issue(runId, false, true)).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps a run sent with sections shown: a later issue matches nothing', async () => {
    const runId = await seedRun()
    expect(await issue(runId, true, true)).toBe(1)
    const first = await snapshotOf(runId)

    // The company hides both sections and sends again.
    expect(await issue(runId, false, false)).toBe(0)
    expect(await snapshotOf(runId)).toEqual(first)
    expect(first.payslip_show_employer_cost).toBe(true)
    expect(first.payslip_show_breakdown).toBe(true)
  })

  it('refuses any change to an issued snapshot, for any caller', async () => {
    const runId = await seedRun()
    await issue(runId, true, false)

    await expect(
      getPool().query(
        `UPDATE public.salary_runs SET payslip_show_employer_cost = false, payslip_show_breakdown = false WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.salary_runs
            SET payslip_sections_issued_at = NULL, payslip_show_employer_cost = NULL, payslip_show_breakdown = NULL
          WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.salary_runs SET payslip_sections_issued_at = now() + interval '1 day' WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const after = await snapshotOf(runId)
    expect(after.payslip_show_employer_cost).toBe(true)
    expect(after.payslip_show_breakdown).toBe(false)
  })

  it('leaves the rest of an issued run editable', async () => {
    const runId = await seedRun()
    await issue(runId, true, true)

    await getPool().query(`UPDATE public.salary_runs SET status = 'paid', notes = 'betald' WHERE id = $1`, [runId])
    const { rows } = await getPool().query<{ status: string; notes: string }>(
      `SELECT status, notes FROM public.salary_runs WHERE id = $1`,
      [runId],
    )
    expect(rows[0]).toEqual({ status: 'paid', notes: 'betald' })
  })
})
