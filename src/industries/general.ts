import type { ChecklistItem, NicheProfile, RoleTemplate, TipPolicy } from './types.ts';

/**
 * The starting point for the industries that have no tip rules of their own: hotels and venues, trades and
 * construction, offices and studios, delivery and couriers. They run on the same pay engine as restaurants (hourly
 * and salaried pay, overtime by state, federal and state taxes, direct deposit), with their own roles. Each is a
 * starting point a company edits. The checklist items are reminders written from general knowledge, not checked
 * against a primary source: they say so, and Totali does not enforce them.
 */

const role = (r: Partial<RoleTemplate> & Pick<RoleTemplate, 'key' | 'label'>): RoleTemplate => ({
  tipped: 'never',
  manager: false,
  pay: 'hourly',
  poolPoints: 1,
  ...r,
});

const none: TipPolicy = {
  takesTipCredit: false,
  pool: { enabled: false, roles: [], basis: 'hours' },
  tipOuts: [],
  serviceCharge: 'none',
  serviceChargeRoles: [],
  cardFeeDeductionBps: null,
};

const reminder = (id: string, title: string, detail: string, when: ChecklistItem['when'], states?: string[]): ChecklistItem => ({ id, title, detail, when, ...(states ? { states } : {}), notModelled: true, verified: false });

const common: ChecklistItem[] = [
  reminder('i9_new_hire', 'Complete an I-9 within three business days of each start', 'Section 1 by the employee on their first day, Section 2 by you within three business days. Totali collects the information; you keep the documents you examined.', 'onboarding'),
  reminder('workers_comp', 'Carry workers’ compensation insurance', 'Most states require it once you have employees. Your insurer assigns the class codes and rates.', 'ongoing'),
];

export const generalNiches: NicheProfile[] = [
  {
    id: 'hotel_venue',
    industry: 'hotel_lodging',
    label: 'Hotel or venue',
    tagline: 'Departments, seasonal staff, service charges.',
    description: 'Front desk, housekeeping, banquets and maintenance, with departments, seasonal hiring and banquet service charges.',
    roles: [
      role({ key: 'general_manager', label: 'General manager', manager: true, pay: 'salary', poolPoints: 0 }),
      role({ key: 'front_desk', label: 'Front desk' }),
      role({ key: 'housekeeper', label: 'Housekeeper' }),
      role({ key: 'maintenance', label: 'Maintenance' }),
      role({ key: 'banquet_server', label: 'Banquet server', tipped: 'customarily' }),
      role({ key: 'bartender', label: 'Bartender', tipped: 'customarily' }),
      role({ key: 'events_coordinator', label: 'Events coordinator', pay: 'salary' }),
    ],
    policy: { ...none },
    payFrequency: 'biweekly',
    workweekStartDay: 0,
    features: ['Departments', 'Seasonal staff', 'Banquet service charges'],
    checklist: [
      ...common,
      reminder('service_charge_is_wages', 'A mandatory service charge is wages, not a tip', 'When a venue adds a mandatory service charge, the part paid to staff is wages for tax purposes. Totali treats a distributed service charge as wages.', 'each_pay_run'),
      reminder('seasonal_rehire', 'Track seasonal employees’ end dates', 'Seasonal workers may need to be reported to the state as separated and rehired. Totali lists who is due to end.', 'ongoing'),
    ],
    reports: ['Hours and cost by department', 'Seasonal staff ending soon'],
  },
  {
    id: 'trades_contractor',
    industry: 'construction_trades',
    label: 'Trades or construction',
    tagline: 'Crews, job costing, workers’ comp classes.',
    description: 'Crews on job sites, with hours coded to jobs and payroll grouped by workers’ compensation class.',
    roles: [
      role({ key: 'owner_manager', label: 'Owner or project manager', manager: true, pay: 'salary', poolPoints: 0 }),
      role({ key: 'foreman', label: 'Foreman' }),
      role({ key: 'journeyman', label: 'Journeyman' }),
      role({ key: 'apprentice', label: 'Apprentice' }),
      role({ key: 'laborer', label: 'Laborer' }),
      role({ key: 'office_admin', label: 'Office admin', pay: 'salary' }),
    ],
    policy: { ...none },
    payFrequency: 'weekly',
    workweekStartDay: 1,
    features: ['Job costing', 'Crews', 'Workers’ comp classes'],
    checklist: [
      ...common,
      reminder('prevailing_wage', 'Check whether any job pays prevailing wage', 'Public works jobs often require prevailing wages and certified payroll. Totali does not compute prevailing wage rates or certified payroll reports.', 'ongoing'),
    ],
    reports: ['Cost by job', 'Hours by crew', 'Payroll by workers’ comp class'],
  },
  {
    id: 'office_studio',
    industry: 'office_studios',
    label: 'Office or studio',
    tagline: 'Salaried and hourly staff, time off, more than one state.',
    description: 'A mix of salaried and hourly staff, with time off and people who work in different states.',
    roles: [
      role({ key: 'manager', label: 'Manager', manager: true, pay: 'salary', poolPoints: 0 }),
      role({ key: 'salaried_staff', label: 'Salaried staff', pay: 'salary' }),
      role({ key: 'hourly_staff', label: 'Hourly staff' }),
      role({ key: 'creative', label: 'Creative or specialist', pay: 'salary' }),
    ],
    policy: { ...none },
    payFrequency: 'semimonthly',
    workweekStartDay: 1,
    features: ['Salaried and hourly', 'Time off', 'Multi-state'],
    checklist: [
      ...common,
      reminder('exempt_salary', 'Check each salaried person against the exempt tests', 'Being paid a salary does not make someone exempt from overtime. Totali checks the federal salary level only; duties and higher state levels are yours to confirm.', 'onboarding'),
    ],
    reports: ['Team by state', 'Salaried and hourly cost'],
  },
  {
    id: 'courier_fleet',
    industry: 'delivery_couriers',
    label: 'Delivery or couriers',
    tagline: 'Trips, mileage, contractor drivers.',
    description: 'Employee drivers and dispatch, with contractor drivers kept apart from payroll.',
    roles: [
      role({ key: 'operations_manager', label: 'Operations manager', manager: true, pay: 'salary', poolPoints: 0 }),
      role({ key: 'driver', label: 'Driver (employee)', reimbursesVehicleExpenses: true }),
      role({ key: 'dispatcher', label: 'Dispatcher' }),
      role({ key: 'warehouse', label: 'Warehouse' }),
    ],
    policy: { ...none },
    payFrequency: 'weekly',
    workweekStartDay: 1,
    features: ['Trips', 'Mileage', 'Contractor drivers'],
    checklist: [
      ...common,
      reminder('misclassification', 'Check that contractor drivers are really contractors', 'How the work is controlled decides whether a driver is an employee or a contractor, not what the contract says. Totali does not decide this for you.', 'onboarding'),
    ],
    reports: ['Trips and mileage', 'Contractor payments'],
  },
];
