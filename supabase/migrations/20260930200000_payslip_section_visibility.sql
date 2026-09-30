-- Payslip section visibility for the employee copy (lönespecifikation).
--
-- The payslip PDF has always printed two employer-facing sections:
-- Arbetsgivarkostnad (arbetsgivaravgifter, semesteravsättning and the total
-- employer cost) and Beräkningsunderlag (every calculation step the engine
-- took). Neither is required on the employee's lönespecifikation, and some
-- employers do not want them in what the employee receives.
--
-- Two company switches decide whether each section is printed on the copy
-- the EMPLOYEE receives (the emailed payslip link and the API download).
-- The employer's own view of the payslip in the app always prints both.
--
-- DEFAULT true: every existing company keeps exactly the payslip it has
-- today until someone turns a section off.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS salary_payslip_show_employer_cost boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS salary_payslip_show_breakdown boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.company_settings.salary_payslip_show_employer_cost IS
  'Print the Arbetsgivarkostnad section on the payslip the employee receives. The employer view always prints it.';
COMMENT ON COLUMN public.company_settings.salary_payslip_show_breakdown IS
  'Print the Beräkningsunderlag section on the payslip the employee receives. The employer view always prints it.';

NOTIFY pgrst, 'reload schema';
