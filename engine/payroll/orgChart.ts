import type { Company, Employee } from './types.ts';
import { activeEmployeesFor } from './run.ts';

/**
 * Turns `Employee.managerId` — a plain id, purely descriptive, nothing in
 * payroll processing itself reads it (see payroll/types.ts's own doc
 * comment) — into the org chart / employee directory view README.md's own
 * Payroll processing section names as the natural consumer that hadn't
 * been built yet. A pure rollup over data this project already maintains,
 * the same "no new business logic" discipline payroll/reports.ts applies
 * to its own headcount and department breakdowns.
 *
 * Two real shapes a naive tree-builder gets wrong, both handled here
 * rather than left to crash or silently mis-render:
 *  - A DANGLING manager reference (managerId points to someone
 *    terminated, in another company, or simply not found) — treated as a
 *    root rather than dropped, since the employee still needs to appear
 *    SOMEWHERE in the chart.
 *  - A CYCLE (A manages B manages A, however indirect) — a real, if rare,
 *    data-entry mistake this function detects and reports rather than
 *    recursing forever; every employee caught in a cycle is excluded from
 *    the tree and returned separately, not silently dropped.
 */

export interface OrgChartNode {
  employeeId: string;
  name: string;
  jobTitle?: string;
  department?: string;
  reports: OrgChartNode[];
}

export interface OrgChartResult {
  /** Every employee with no resolvable manager — either genuinely top-level, or their own managerId didn't resolve to another active employee in this company. */
  roots: OrgChartNode[];
  /** Employee ids excluded from `roots` because following their own manager chain eventually loops back to themselves. */
  employeeIdsInCycles: string[];
}

/** Active (as of `asOfDate`) employees in `company`, arranged into a manager/report tree — see this module's own header for the dangling-reference and cycle handling. */
export function buildOrgChart(company: Company, employees: readonly Employee[], asOfDate: string): OrgChartResult {
  const active = activeEmployeesFor(company, employees, asOfDate);
  const byId = new Map(active.map((e) => [e.id, e]));

  // A cycle is only the ids that actually repeat, never the ancestors that
  // merely lead into one — walking A -> B -> C -> B must mark B and C, not
  // A, which has no back-reference of its own.
  const employeeIdsInCycles = new Set<string>();
  for (const employee of active) {
    const chain: string[] = [employee.id];
    let current: Employee = employee;
    while (current.managerId && byId.has(current.managerId)) {
      const managerId = current.managerId;
      const repeatIndex = chain.indexOf(managerId);
      if (repeatIndex !== -1) {
        for (const id of chain.slice(repeatIndex)) employeeIdsInCycles.add(id);
        break;
      }
      chain.push(managerId);
      current = byId.get(managerId)!;
    }
  }

  function nodeFor(employee: Employee): OrgChartNode {
    const reports = active
      .filter((e) => e.managerId === employee.id && !employeeIdsInCycles.has(e.id))
      .map(nodeFor)
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      employeeId: employee.id,
      name: `${employee.firstName} ${employee.lastName}`,
      jobTitle: employee.jobTitle,
      department: employee.department,
      reports,
    };
  }

  // A root is anyone with no manager, a manager who doesn't resolve to an
  // active employee at all, OR a manager who's IN a cycle — that last case
  // matters because a cycle member is never built as a node (it isn't in
  // `roots` and nothing recurses into it), so without this, someone whose
  // only path to the top runs through a cycle would silently vanish from
  // the chart entirely rather than surfacing somewhere.
  const roots = active
    .filter((e) => !employeeIdsInCycles.has(e.id) && (!e.managerId || !byId.has(e.managerId) || employeeIdsInCycles.has(e.managerId)))
    .map(nodeFor)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { roots, employeeIdsInCycles: [...employeeIdsInCycles].sort() };
}
