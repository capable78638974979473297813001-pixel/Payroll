import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditLogEntry } from './auditLog.ts';
import type { BenefitElection, BenefitPlan } from './benefits.ts';
import type { Contractor, ContractorPayment } from './contractors.ts';
import type { DirectDepositVerification } from './directDepositVerification.ts';
import type { EverifyCase } from './everify.ts';
import type { I9Record } from './i9.ts';
import type { Candidate, JobPosting } from './onboarding.ts';
import type { PtoBalance, PtoPolicy } from './pto.ts';
import type { PtoRequest } from './ptoRequest.ts';
import type { TimePunch } from './timeAndAttendance.ts';
import type { Company, Employee, PayRun } from './types.ts';

/**
 * A file-backed store for companies, employees and pay runs — the same
 * pattern site/lib/store.ts already uses for accounts and API keys, for
 * the same reason stated there: this project's Supabase instance isn't
 * linked to a live URL from this environment, so there's nothing to
 * connect to. db/payroll-schema.sql is the canonical, normalized target
 * this mirrors closely enough (one row per company/employee/pay run, no
 * denormalized blobs beyond what JSON columns in that schema already
 * allow) that swapping these functions for real queries later is
 * mechanical, not a redesign.
 *
 * Same boundary as site/lib/store.ts draws for payment methods: a real
 * system NEVER holds a bank account number in a plain JSON file on disk
 * the way this demo store does (see payroll/directDeposit.ts's own header
 * comment on that same boundary) — this file is the reference
 * implementation of the SHAPE of the data, not a production secret store.
 */

/** Resolved lazily on each call (not once at import) so a test or an isolated caller can point it elsewhere with PAYROLL_DB_DIR — the same override shape trades/store.ts uses. */
function dataDir(): string {
  return process.env.PAYROLL_DB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '.data');
}

interface DB {
  companies: Record<string, Company>;
  employees: Record<string, Employee>;
  payRuns: Record<string, PayRun>;
  benefitPlans: Record<string, BenefitPlan>;
  benefitElections: Record<string, BenefitElection>;
  jobPostings: Record<string, JobPosting>;
  candidates: Record<string, Candidate>;
  ptoPolicies: Record<string, PtoPolicy>;
  /** Keyed by `${employeeId}:${policyId}` — PtoBalance's own composite key, see db/payroll-schema.sql's pto_balance table. */
  ptoBalances: Record<string, PtoBalance>;
  timePunches: TimePunch[];
  i9Records: Record<string, I9Record>;
  contractors: Record<string, Contractor>;
  contractorPayments: ContractorPayment[];
  auditLog: AuditLogEntry[];
  /** Keyed by accountId — see payroll/directDepositVerification.ts. A real system's schema would allow more than one historical attempt per account; this demo store keeps only the current one. */
  directDepositVerifications: Record<string, DirectDepositVerification>;
  /** employeeId -> the ISO date this employer told the store its PRWORA new-hire report was actually filed — see payroll/newHireReporting.ts's own newHireReportingIssuesForCompany(). Filing itself (submission to a state workforce agency) is out of scope the same way every other e-filing is in this project; this only tracks that a human said it was done. */
  newHireReportsFiled: Record<string, string>;
  ptoRequests: Record<string, PtoRequest>;
  everifyCases: Record<string, EverifyCase>;
}

function emptyDb(): DB {
  return {
    companies: {},
    employees: {},
    payRuns: {},
    benefitPlans: {},
    benefitElections: {},
    jobPostings: {},
    candidates: {},
    ptoPolicies: {},
    ptoBalances: {},
    timePunches: [],
    i9Records: {},
    contractors: {},
    contractorPayments: [],
    auditLog: [],
    directDepositVerifications: {},
    newHireReportsFiled: {},
    ptoRequests: {},
    everifyCases: {},
  };
}

function ensureDataDir(): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function dbFile(): string {
  return join(dataDir(), 'payroll-db.json');
}

function load(): DB {
  ensureDataDir();
  const file = dbFile();
  if (!existsSync(file)) return emptyDb();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DB>;
    const base = emptyDb();
    return {
      companies: parsed.companies ?? base.companies,
      employees: parsed.employees ?? base.employees,
      payRuns: parsed.payRuns ?? base.payRuns,
      benefitPlans: parsed.benefitPlans ?? base.benefitPlans,
      benefitElections: parsed.benefitElections ?? base.benefitElections,
      jobPostings: parsed.jobPostings ?? base.jobPostings,
      candidates: parsed.candidates ?? base.candidates,
      ptoPolicies: parsed.ptoPolicies ?? base.ptoPolicies,
      ptoBalances: parsed.ptoBalances ?? base.ptoBalances,
      timePunches: parsed.timePunches ?? base.timePunches,
      i9Records: parsed.i9Records ?? base.i9Records,
      contractors: parsed.contractors ?? base.contractors,
      contractorPayments: parsed.contractorPayments ?? base.contractorPayments,
      auditLog: parsed.auditLog ?? base.auditLog,
      directDepositVerifications: parsed.directDepositVerifications ?? base.directDepositVerifications,
      newHireReportsFiled: parsed.newHireReportsFiled ?? base.newHireReportsFiled,
      ptoRequests: parsed.ptoRequests ?? base.ptoRequests,
      everifyCases: parsed.everifyCases ?? base.everifyCases,
    };
  } catch {
    return emptyDb();
  }
}

function save(db: DB): void {
  ensureDataDir();
  writeFileSync(dbFile(), JSON.stringify(db, null, 2), 'utf8');
}

export function withPayrollDb<T>(fn: (db: DB) => T): T {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

export function readPayrollDb<T>(fn: (db: DB) => T): T {
  return fn(load());
}

export function saveCompany(company: Company): void {
  withPayrollDb((db) => {
    db.companies[company.id] = company;
  });
}

export function getCompany(id: string): Company | null {
  return readPayrollDb((db) => db.companies[id] ?? null);
}

export function allCompanies(): Company[] {
  return readPayrollDb((db) => Object.values(db.companies));
}

export function saveEmployee(employee: Employee): void {
  withPayrollDb((db) => {
    db.employees[employee.id] = employee;
  });
}

export function saveEmployees(employees: readonly Employee[]): void {
  withPayrollDb((db) => {
    for (const e of employees) db.employees[e.id] = e;
  });
}

export function getEmployee(id: string): Employee | null {
  return readPayrollDb((db) => db.employees[id] ?? null);
}

export function employeesForCompany(companyId: string): Employee[] {
  return readPayrollDb((db) => Object.values(db.employees).filter((e) => e.companyId === companyId));
}

export function savePayRun(run: PayRun): void {
  withPayrollDb((db) => {
    db.payRuns[run.id] = run;
  });
}

export function getPayRun(id: string): PayRun | null {
  return readPayrollDb((db) => db.payRuns[id] ?? null);
}

export function payRunsForCompany(companyId: string): PayRun[] {
  return readPayrollDb((db) =>
    Object.values(db.payRuns)
      .filter((r) => r.companyId === companyId)
      .sort((a, b) => a.checkDate.localeCompare(b.checkDate)),
  );
}

// ----------------------------------------------------------------------------
// Benefits
// ----------------------------------------------------------------------------

export function saveBenefitPlan(plan: BenefitPlan): void {
  withPayrollDb((db) => {
    db.benefitPlans[plan.id] = plan;
  });
}

export function benefitPlansForCompany(companyId: string): BenefitPlan[] {
  return readPayrollDb((db) => Object.values(db.benefitPlans).filter((p) => p.companyId === companyId));
}

export function getBenefitPlan(id: string): BenefitPlan | null {
  return readPayrollDb((db) => db.benefitPlans[id] ?? null);
}

export function saveBenefitElection(election: BenefitElection): void {
  withPayrollDb((db) => {
    db.benefitElections[election.id] = election;
  });
}

export function benefitElectionsForEmployee(employeeId: string): BenefitElection[] {
  return readPayrollDb((db) => Object.values(db.benefitElections).filter((e) => e.employeeId === employeeId));
}

/** Every election belonging to any of these employee ids — for a company-wide rollup (payroll/benefits.ts's own renderCarrierEligibilityRoster()) where BenefitElection itself carries no companyId of its own to filter on directly. */
export function benefitElectionsForEmployeeIds(employeeIds: readonly string[]): BenefitElection[] {
  const idSet = new Set(employeeIds);
  return readPayrollDb((db) => Object.values(db.benefitElections).filter((e) => idSet.has(e.employeeId)));
}

// ----------------------------------------------------------------------------
// Recruiting / onboarding
// ----------------------------------------------------------------------------

export function saveJobPosting(posting: JobPosting): void {
  withPayrollDb((db) => {
    db.jobPostings[posting.id] = posting;
  });
}

export function jobPostingsForCompany(companyId: string): JobPosting[] {
  return readPayrollDb((db) => Object.values(db.jobPostings).filter((p) => p.companyId === companyId));
}

export function getJobPosting(id: string): JobPosting | null {
  return readPayrollDb((db) => db.jobPostings[id] ?? null);
}

export function saveCandidate(candidate: Candidate): void {
  withPayrollDb((db) => {
    db.candidates[candidate.id] = candidate;
  });
}

export function getCandidate(id: string): Candidate | null {
  return readPayrollDb((db) => db.candidates[id] ?? null);
}

export function candidatesForJobPosting(jobPostingId: string): Candidate[] {
  return readPayrollDb((db) => Object.values(db.candidates).filter((c) => c.jobPostingId === jobPostingId));
}

export function candidatesForCompany(companyId: string): Candidate[] {
  return readPayrollDb((db) => {
    const postingIds = new Set(Object.values(db.jobPostings).filter((p) => p.companyId === companyId).map((p) => p.id));
    return Object.values(db.candidates).filter((c) => postingIds.has(c.jobPostingId));
  });
}

// ----------------------------------------------------------------------------
// PTO
// ----------------------------------------------------------------------------

export function savePtoPolicy(policy: PtoPolicy): void {
  withPayrollDb((db) => {
    db.ptoPolicies[policy.id] = policy;
  });
}

export function ptoPoliciesForCompany(companyId: string): PtoPolicy[] {
  // PtoPolicy itself carries no companyId (see payroll/pto.ts) — callers
  // key it by their OWN company's known policy ids instead. This helper
  // exists anyway for the common case of one company, one shared policy
  // set, by returning every policy on file; a multi-company deployment
  // built on this store would need to add that column itself, the same
  // "extend the shape when you actually need it" convention this file
  // uses throughout rather than pre-building for a case with no caller yet.
  return readPayrollDb((db) => Object.values(db.ptoPolicies));
}

export function getPtoPolicy(id: string): PtoPolicy | null {
  return readPayrollDb((db) => db.ptoPolicies[id] ?? null);
}

function ptoBalanceKey(employeeId: string, policyId: string): string {
  return `${employeeId}:${policyId}`;
}

export function savePtoBalance(balance: PtoBalance): void {
  withPayrollDb((db) => {
    db.ptoBalances[ptoBalanceKey(balance.employeeId, balance.policyId)] = balance;
  });
}

export function getPtoBalance(employeeId: string, policyId: string): PtoBalance | null {
  return readPayrollDb((db) => db.ptoBalances[ptoBalanceKey(employeeId, policyId)] ?? null);
}

export function ptoBalancesForEmployee(employeeId: string): PtoBalance[] {
  return readPayrollDb((db) => Object.values(db.ptoBalances).filter((b) => b.employeeId === employeeId));
}

// ----------------------------------------------------------------------------
// Time & attendance
// ----------------------------------------------------------------------------

export function addTimePunch(punch: TimePunch): void {
  withPayrollDb((db) => {
    db.timePunches.push(punch);
  });
}

export function timePunchesForEmployee(employeeId: string): TimePunch[] {
  return readPayrollDb((db) => db.timePunches.filter((p) => p.employeeId === employeeId));
}

// ----------------------------------------------------------------------------
// I-9
// ----------------------------------------------------------------------------

export function saveI9Record(record: I9Record): void {
  withPayrollDb((db) => {
    db.i9Records[record.employeeId] = record;
  });
}

export function getI9Record(employeeId: string): I9Record | null {
  return readPayrollDb((db) => db.i9Records[employeeId] ?? null);
}

// ----------------------------------------------------------------------------
// 1099 contractors
// ----------------------------------------------------------------------------

export function saveContractor(contractor: Contractor): void {
  withPayrollDb((db) => {
    db.contractors[contractor.id] = contractor;
  });
}

export function getContractor(id: string): Contractor | null {
  return readPayrollDb((db) => db.contractors[id] ?? null);
}

export function contractorsForCompany(companyId: string): Contractor[] {
  return readPayrollDb((db) => Object.values(db.contractors).filter((c) => c.companyId === companyId));
}

export function saveContractorPayment(payment: ContractorPayment): void {
  withPayrollDb((db) => {
    db.contractorPayments.push(payment);
  });
}

export function paymentsForContractor(contractorId: string): ContractorPayment[] {
  return readPayrollDb((db) => db.contractorPayments.filter((p) => p.contractorId === contractorId));
}

// ----------------------------------------------------------------------------
// Audit log
// ----------------------------------------------------------------------------

export function addAuditLogEntry(entry: AuditLogEntry): void {
  withPayrollDb((db) => {
    db.auditLog.push(entry);
  });
}

/**
 * Newest first — the order an admin actually wants to read a log in.
 * `entityIds` is the caller's own list of ids it considers "this
 * company's" (the company id itself, its employee ids, its pay run ids,
 * ...) since an AuditLogEntry doesn't carry a companyId of its own — most
 * entity types it logs (Employee, PayRun, GarnishmentOrder) already
 * belong to exactly one company, so re-deriving that link here would
 * just duplicate what the caller already knows from its own records.
 */
export function auditLogForEntityIds(entityIds: readonly string[]): AuditLogEntry[] {
  const idSet = new Set(entityIds);
  return readPayrollDb((db) => db.auditLog.filter((e) => idSet.has(e.entityId)).sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
}

// ----------------------------------------------------------------------------
// Direct deposit verification
// ----------------------------------------------------------------------------

export function saveDirectDepositVerification(verification: DirectDepositVerification): void {
  withPayrollDb((db) => {
    db.directDepositVerifications[verification.accountId] = verification;
  });
}

export function getDirectDepositVerification(accountId: string): DirectDepositVerification | null {
  return readPayrollDb((db) => db.directDepositVerifications[accountId] ?? null);
}

// ----------------------------------------------------------------------------
// New-hire reporting
// ----------------------------------------------------------------------------

export function markNewHireReportFiled(employeeId: string, filedAt: string): void {
  withPayrollDb((db) => {
    db.newHireReportsFiled[employeeId] = filedAt;
  });
}

export function newHireReportFiledEmployeeIds(): Set<string> {
  return readPayrollDb((db) => new Set(Object.keys(db.newHireReportsFiled)));
}

// ----------------------------------------------------------------------------
// PTO requests
// ----------------------------------------------------------------------------

export function savePtoRequest(request: PtoRequest): void {
  withPayrollDb((db) => {
    db.ptoRequests[request.id] = request;
  });
}

export function getPtoRequest(id: string): PtoRequest | null {
  return readPayrollDb((db) => db.ptoRequests[id] ?? null);
}

export function ptoRequestsForEmployee(employeeId: string): PtoRequest[] {
  return readPayrollDb((db) => Object.values(db.ptoRequests).filter((r) => r.employeeId === employeeId));
}

/** Every PTO request for any of these employee ids — for a company-wide worklist, since PtoRequest carries no companyId of its own (same reason benefitElectionsForEmployeeIds() exists). */
export function ptoRequestsForEmployeeIds(employeeIds: readonly string[]): PtoRequest[] {
  const idSet = new Set(employeeIds);
  return readPayrollDb((db) => Object.values(db.ptoRequests).filter((r) => idSet.has(r.employeeId)));
}

// ----------------------------------------------------------------------------
// E-Verify
// ----------------------------------------------------------------------------

export function saveEverifyCase(everifyCase: EverifyCase): void {
  withPayrollDb((db) => {
    db.everifyCases[everifyCase.employeeId] = everifyCase;
  });
}

export function getEverifyCase(employeeId: string): EverifyCase | null {
  return readPayrollDb((db) => db.everifyCases[employeeId] ?? null);
}
