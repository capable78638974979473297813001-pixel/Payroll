import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptField } from '../lib/crypto.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';
import { employerContextFor } from '../domain/companies.ts';
import type { Company, Employee, PayRun, TaxDeposit } from '../domain/types.ts';

/**
 * Filings, deposits and an independent check, by MasteryTax.
 *
 * MasteryTax (the Python package in ../../masterytax) takes a payroll
 * register and recomputes every tax from it with the same engine Totali
 * calls. That gives two things a pay run alone cannot:
 *
 *   1. an independent check: MasteryTax's own computation is compared with
 *      what the pay run actually withheld, and every difference is reported;
 *   2. everything downstream of the withholding: the deposit calendar for
 *      each agency, Form 941 and 940 lines, W-2s with the 941 reconciliation,
 *      state wage reports, and payment instructions.
 *
 * Totali builds the register from approved pay runs, runs MasteryTax in a
 * temporary directory, and returns its JSON. MasteryTax never moves money and
 * never transmits a return; "payments" are instructions marked NOT TRANSMITTED.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = process.env.MASTERYTAX_ENGINE ?? join(ROOT, 'engine');

const dollars = (c: number) => (c / 100).toFixed(2);

const PRETAX_COLUMN: Record<string, string> = {
  deferral_401k: 'pretax_401k',
  deferral_403b: 'pretax_403b',
  deferral_457: 'pretax_457',
  deferral_simple: 'pretax_simple',
  section125: 'pretax_s125',
  hsa: 'pretax_hsa',
  fsa: 'pretax_fsa',
  dependent_care: 'pretax_dependent_care',
  commuter: 'pretax_commuter',
};

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export interface Register {
  payrollCsv: string;
  companiesJson: string;
  employeesJson: string;
  depositsCsv: string;
  warnings: string[];
}

/** Build MasteryTax's four input files from a company's approved pay runs. */
export function buildRegister(company: Company, employees: readonly Employee[], runs: readonly PayRun[], deposits: readonly TaxDeposit[]): Register {
  const warnings: string[] = [];
  const byId = new Map(employees.map((e) => [e.id, e]));
  const taxColumns = new Set<string>();
  const rows: Array<Record<string, string>> = [];

  for (const run of [...runs].sort((a, b) => a.checkDate.localeCompare(b.checkDate))) {
    for (const pc of run.paychecks) {
      const e = byId.get(pc.employeeId);
      if (!e) continue;
      let ssn = '';
      if (e.ssnEncrypted) {
        try {
          ssn = decryptField(e.ssnEncrypted);
        } catch {
          warnings.push(`Could not decrypt the SSN for ${pc.name}; MasteryTax will hold their rows.`);
        }
      }
      const supplemental = pc.earnings.filter((x) => x.category === 'supplemental').reduce((a, x) => a + x.amountCents, 0);
      const row: Record<string, string> = {
        company_id: company.id,
        employee_id: e.id,
        ssn,
        first_name: e.firstName,
        last_name: e.lastName,
        pay_date: run.checkDate,
        period_start: run.periodStart,
        period_end: run.periodEnd,
        pay_frequency: company.paySchedule.frequency,
        work_state: e.workState.code,
        gross_wages: dollars(pc.taxableWagesCents),
        supplemental_wages: supplemental ? dollars(supplemental) : '',
        hours_worked: pc.hours ? String(pc.hours) : '',
      };
      for (const d of pc.deductionLines) {
        const col = d.category ? PRETAX_COLUMN[d.category] : undefined;
        if (col) row[col] = dollars(Number(row[col] ? Math.round(Number(row[col]) * 100) : 0) + d.amountCents);
      }
      // What was actually withheld, tax by tax, under the engine's own tax ids.
      for (const t of pc.taxLines.filter((x) => x.payer === 'employee')) {
        taxColumns.add(t.id);
        row[t.id] = dollars(t.amount);
      }
      rows.push(row);
    }
  }

  const fixed = ['company_id', 'employee_id', 'ssn', 'first_name', 'last_name', 'pay_date', 'period_start', 'period_end', 'pay_frequency', 'work_state', 'gross_wages', 'supplemental_wages', 'hours_worked', ...Object.values(PRETAX_COLUMN)];
  const header = [...fixed, ...[...taxColumns].sort()];
  const payrollCsv = [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h] ?? '')).join(','))].join('\n') + '\n';

  const stateAccounts: Record<string, Record<string, string>> = {};
  for (const [code, a] of Object.entries(company.taxAccounts?.state ?? {})) {
    stateAccounts[code] = { ...(a.account ? { account: a.account } : {}), ...(a.suiRate !== undefined ? { sui_rate: String(a.suiRate) } : {}) };
  }
  for (const [code, rate] of Object.entries(employerContextFor(company)?.stateUnemploymentRate ?? {})) {
    stateAccounts[code] = { ...stateAccounts[code], sui_rate: String(rate) };
  }
  const companiesJson = JSON.stringify({
    companies: [
      {
        id: company.id,
        name: company.legalName,
        fein: company.ein,
        ...(company.taxAccounts?.federalSchedule ? { federal_schedule: company.taxAccounts.federalSchedule } : {}),
        ...(company.taxAccounts?.lookback941LiabilityDollars !== undefined ? { lookback_941_liability: String(company.taxAccounts.lookback941LiabilityDollars) } : {}),
        state_accounts: stateAccounts,
      },
    ],
  });
  const employeesJson = JSON.stringify({
    employees: employees.map((e) => ({
      company_id: company.id,
      employee_id: e.id,
      pay_frequency: company.paySchedule.frequency,
      federal_w4: e.federalW4,
      ...(e.workState.certificate ? { work_state_certificate: e.workState.certificate } : {}),
      residence_state: e.residenceState,
    })),
  });
  const depositsCsv = ['company_id,deposit_group,date,amount,reference', ...deposits.map((d) => [company.id, d.depositGroup, d.date, dollars(d.amountCents), csvCell(d.reference)].join(','))].join('\n') + '\n';
  return { payrollCsv, companiesJson, employeesJson, depositsCsv, warnings };
}

export type MasteryCommand = 'validate' | 'liabilities' | 'deposits' | '941' | '940' | 'w2' | 'payments' | 'state';

export interface MasteryResult {
  command: MasteryCommand;
  exitCode: number;
  result: unknown;
  stderr?: string;
  register: { paychecks: number; runs: number; warnings: string[] };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(conflict('masterytax_timeout', `MasteryTax did not finish within ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      rejectP(conflict('masterytax_unavailable', `Could not start ${cmd}: ${e.message}. MasteryTax needs Python 3.10+ and Node 22.18+ on the server.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function runMasteryTax(
  store: Store,
  companyId: string,
  command: MasteryCommand,
  opts: { year?: number; quarter?: number; state?: string; asOf?: string; timeoutMs?: number } = {},
): Promise<MasteryResult> {
  const company = store.companies.require(companyId, 'Company');
  const runs = store.payRuns.where((r) => r.companyId === companyId && ['approved', 'funding', 'funded', 'disbursing', 'completed'].includes(r.status));
  if (runs.length === 0) throw conflict('no_approved_runs', 'MasteryTax needs at least one approved pay run to work from.');
  const employees = store.employees.where((e) => e.companyId === companyId);
  const deposits = store.taxDeposits.where((d) => d.companyId === companyId);
  const reg = buildRegister(company, employees, runs, deposits);

  const dir = mkdtempSync(join(tmpdir(), 'totali-mt-'));
  try {
    const f = { payroll: join(dir, 'payroll.csv'), companies: join(dir, 'companies.json'), employees: join(dir, 'employees.json'), deposits: join(dir, 'deposits.csv') };
    writeFileSync(f.payroll, reg.payrollCsv);
    writeFileSync(f.companies, reg.companiesJson);
    writeFileSync(f.employees, reg.employeesJson);
    writeFileSync(f.deposits, reg.depositsCsv);

    const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
    const args = ['-m', 'masterytax', command, '--payroll', f.payroll, '--companies', f.companies, '--employees', f.employees, '--deposits', f.deposits, '--as-of', asOf, '--json'];
    if (command === '941' || command === 'state') {
      if (!opts.year || !opts.quarter) throw badRequest('year and quarter are required');
      args.push('--year', String(opts.year), '--quarter', String(opts.quarter));
    }
    if (command === '940' || command === 'w2') {
      if (!opts.year) throw badRequest('year is required');
      args.push('--year', String(opts.year));
    }
    if (command === 'state') {
      if (!opts.state) throw badRequest('state is required');
      args.push('--state', opts.state);
    }
    const out = await run(process.env.TOTALI_PYTHON ?? 'python3', args, { ...process.env, MASTERYTAX_ENGINE: ENGINE }, opts.timeoutMs ?? 90_000);
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.stdout);
    } catch {
      throw conflict('masterytax_failed', `MasteryTax returned no JSON (exit ${out.code}): ${(out.stderr || out.stdout).slice(0, 500)}`);
    }
    return {
      command,
      exitCode: out.code,
      result: parsed,
      ...(out.stderr ? { stderr: out.stderr.slice(0, 2000) } : {}),
      register: { paychecks: runs.reduce((a, r) => a + r.paychecks.length, 0), runs: runs.length, warnings: reg.warnings },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
