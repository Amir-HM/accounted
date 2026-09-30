'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { DefRow } from '@/components/ui/detail-section'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS, VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { SalaryBankList } from '@/lib/salary/payment/bank-list'
import { cn, formatCurrency } from '@/lib/utils'

type PaymentFormat = SalaryBankList['format']

interface PaymentBankListProps {
  salaryRunId: string
  format: PaymentFormat
}

/**
 * Banklista beside the payment-file download: the payments the file carries
 * for the chosen format, from the payment file builder itself (a dry run of
 * the same computation), with a PDF of the same list.
 */
export function PaymentBankList({ salaryRunId, format }: PaymentBankListProps) {
  const t = useTranslations('salary_payments')
  const locale = useLocale() as ErrorLocale
  const [open, setOpen] = useState(false)

  const base = `/api/salary/runs/${salaryRunId}/payment/bank-list`
  const { data, error, isLoading } = useSWR<SalaryBankList, Error>([base, format], async ([url, f]: [string, string]) => {
    const res = await fetch(`${url}?format=${f}`)
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(getErrorMessage(json, { context: 'salary', statusCode: res.status, locale }))
    return (json as { data: SalaryBankList }).data
  })

  if (isLoading) {
    return (
      <DefRow label={t('bank_list_label')}>
        <Skeleton className="h-4 w-48" />
      </DefRow>
    )
  }

  if (error || !data) {
    return (
      <DefRow label={t('bank_list_label')}>
        <span className="text-[12.5px] text-muted-foreground">
          {t('bank_list_unavailable', { reason: error?.message ?? '' })}
        </span>
      </DefRow>
    )
  }

  return (
    <>
      <DefRow label={t('bank_list_label')}>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="tabular-nums">
            {t('bank_list_summary', { count: data.employeeCount, total: formatCurrency(data.totalAmount) })}
          </span>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
            aria-expanded={open}
          >
            <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-180')} />
            {open ? t('bank_list_hide') : t('bank_list_show')}
          </button>
          <a
            href={`${base}/pdf?format=${format}`}
            target="_blank"
            rel="noopener noreferrer"
            className={QUIET_LINK_CLASS}
          >
            {t('bank_list_pdf')}
          </a>
        </div>
      </DefRow>

      {open && (
        <div className="overflow-x-auto pb-2">
          <table className="stagger-enter w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={VTH_CLASS}>{t('bank_list_th_payee')}</th>
                <th className={VTH_CLASS}>{t('bank_list_th_account')}</th>
                <th className={VTH_CLASS}>{t('bank_list_th_reference')}</th>
                <th className={cn(VTH_CLASS, 'pr-0 text-right')}>{t('bank_list_th_amount')}</th>
              </tr>
            </thead>
            <tbody>
              {data.payees.map((payee, i) => (
                <tr key={`${payee.employeeId}-${i}`}>
                  <td className={VTD_CLASS}>{payee.name}</td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap tabular-nums')}>{payee.maskedAccount}</td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                    {payee.reference}
                  </td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap pr-0 text-right tabular-nums')}>
                    {formatCurrency(payee.amount)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-2 pr-4 font-medium" colSpan={3}>
                  {t('bank_list_total')}
                </td>
                <td className="whitespace-nowrap py-2 text-right font-medium tabular-nums">
                  {formatCurrency(data.totalAmount)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
