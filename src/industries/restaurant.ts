import type { ChecklistItem, NicheProfile, RoleTemplate, TipPolicy } from './types.ts';

/**
 * Restaurant niches. Tip-out percentages and pool shapes are illustrative
 * starting points taken from common house practice, not rules: every house
 * sets its own, and a company edits them in its settings before its first run.
 */

const role = (r: Partial<RoleTemplate> & Pick<RoleTemplate, 'key' | 'label' | 'tipped'>): RoleTemplate => ({
  manager: false,
  pay: 'hourly',
  poolPoints: 1,
  ...r,
});

const WC_REST = 'NCCI 9082 (CA: WCIRB 9079)';
const WC_FAST = 'NCCI 9083 (CA: WCIRB 9079)';
const WC_BAR = 'NCCI 9084 (CA: WCIRB 9079)';

const gm = role({ key: 'general_manager', label: 'General manager', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_REST });
const dish = role({ key: 'dishwasher', label: 'Dishwasher', tipped: 'never', poolPoints: 0.5, workersCompHint: WC_REST });
const lineCook = role({ key: 'line_cook', label: 'Line cook', tipped: 'never', poolPoints: 1, workersCompHint: WC_REST });
const prepCook = role({ key: 'prep_cook', label: 'Prep cook', tipped: 'never', poolPoints: 0.75, workersCompHint: WC_REST });

const none: TipPolicy = {
  takesTipCredit: false,
  pool: { enabled: false, roles: [], basis: 'hours' },
  tipOuts: [],
  serviceCharge: 'none',
  serviceChargeRoles: [],
  cardFeeDeductionBps: null,
};

/** Items every restaurant gets. Niche lists add to these. */
const universal: ChecklistItem[] = [
  {
    id: 'tip_credit_notice',
    title: 'Give tipped employees the written tip-credit notice',
    detail:
      'Before taking a tip credit, tell each tipped employee the cash wage, the credit amount claimed, that the credit cannot exceed the tips they receive, and that all tips are theirs except in a valid pool (29 U.S.C. § 203(m)(2)(A)). Totali tracks the acknowledgement date on the employee record.',
    when: 'onboarding',
    coveredBy: 'src/domain/employees.ts (tipCreditNoticeDate)',
  },
  {
    id: 'tip_credit_makeup',
    title: 'Top up tipped workweeks that fall short of minimum wage',
    detail:
      'If cash wage plus tips do not reach the full minimum wage for the hours in a workweek, the employer owes the difference. Totali computes it per workweek on every run.',
    when: 'each_pay_run',
    coveredBy: 'src/restaurant/wages.ts + engine/payroll/tipCredit.ts',
  },
  {
    id: 'tip_pool_eligibility',
    title: 'Keep managers and supervisors out of tip pools',
    detail:
      'A manager or supervisor may never share in a tip pool. When a tip credit is taken, only employees who customarily and regularly receive tips may share. Totali enforces both when it distributes a pool.',
    when: 'each_pay_run',
    coveredBy: 'engine/payroll/tipCredit.ts isEligibleForTipPool',
  },
  {
    id: 'charged_tip_timing',
    title: 'Pay card tips by the regular payday',
    detail:
      'Tips customers add on a card belong to the employee and are generally due no later than the regular payday for the period in which the card payment was made. Totali pays charged tips in the same run as the shift they came from.',
    when: 'each_pay_run',
  },
  {
    id: 'service_charge_is_wages',
    title: 'Treat mandatory service charges as wages, not tips',
    detail:
      'A charge the customer must pay is not a tip. It is wages when it reaches an employee, so it is taxed and withheld like regular pay and does not count toward the tip credit. Totali books it under its own earning code.',
    when: 'each_pay_run',
  },
  {
    id: 'form_4070',
    title: 'Collect monthly tip reports (Form 4070 or equivalent)',
    detail:
      'An employee who receives $20 or more in cash tips in a month must report them to the employer by the 10th of the next month. Totali stores each shift’s declared cash tips and flags employees at or over $20 for the month.',
    when: 'ongoing',
    coveredBy: 'src/restaurant/tipReporting.ts',
  },
  {
    id: 'form_8027',
    title: 'File Form 8027 if you are a large food or beverage establishment',
    detail:
      'An establishment that normally employed more than 10 employees on a typical business day last year, where tipping is customary, files Form 8027 each year (due end of February on paper, March 31 electronically). Totali flags the headcount test; it does not file the form.',
    when: 'annual',
    coveredBy: 'src/restaurant/tipReporting.ts (form8027Applies)',
    notModelled: true,
  },
  {
    id: 'fica_tip_credit',
    title: 'Claim the FICA tip credit (Form 8846)',
    detail:
      'An employer may credit its share of Social Security and Medicare tax on tips above what is needed to bring pay up to the $5.15 federal minimum wage that was in effect on 1 January 2007. Totali computes the credit per quarter.',
    when: 'quarterly',
    coveredBy: 'src/restaurant/tipReporting.ts (ficaTipCredit)',
  },
  {
    id: 'minors',
    title: 'Check youth work hours and hazardous-task limits',
    detail:
      'Workers under 18 cannot operate meat slicers or most power-driven bakery machines or trash compactors (FLSA hazardous orders), and under-16s have hour limits. State rules can be stricter. Totali does not check this.',
    when: 'ongoing',
    notModelled: true,
  },
  {
    id: 'i9_new_hire',
    title: 'I-9 and new-hire reporting for every hire',
    detail: 'Complete Form I-9 within three business days of the start date and report the hire to the state directory.',
    when: 'onboarding',
    coveredBy: 'engine/payroll/i9.ts, engine/payroll/newHireReporting.ts',
  },
  {
    id: 'workers_comp',
    title: 'Keep workers’ compensation coverage with the right class codes',
    detail: 'Restaurants carry their own class codes (kitchen, bar, fast food). Your insurer assigns them; role templates carry a suggestion.',
    when: 'ongoing',
    coveredBy: 'engine/payroll/workersComp.ts',
  },
  {
    id: 'ca_meal_rest',
    title: 'California: pay a premium hour for missed meal or rest breaks',
    detail:
      'One hour of pay at the regular rate for a missed meal period and one for a missed rest period, each at most once per workday (Labor Code § 226.7). Mark the violation on the shift and Totali adds the premium.',
    when: 'each_pay_run',
    states: ['CA'],
    coveredBy: 'engine/payroll/mealRestBreaks.ts',
  },
  {
    id: 'ca_daily_overtime',
    title: 'California: daily overtime and double time',
    detail: 'Over 8 hours in a day is time and a half, over 12 is double time, and the seventh straight day of a workweek carries both. Totali applies this.',
    when: 'each_pay_run',
    states: ['CA'],
    coveredBy: 'src/restaurant/overtime.ts',
  },
  {
    id: 'daily_overtime_other_states',
    title: 'Daily overtime in AK, NV and CO',
    detail:
      'Alaska, Nevada and Colorado have daily overtime rules in addition to the weekly 40-hour rule. Totali applies only the weekly rule in these states and raises a review issue on every run until their daily rules are added.',
    when: 'each_pay_run',
    states: ['AK', 'NV', 'CO'],
    notModelled: true,
  },
  {
    id: 'ny_hospitality_pay',
    title: 'New York: spread-of-hours and call-in pay',
    detail:
      'The Hospitality Industry Wage Order adds pay when a workday spans more than 10 hours and when an employee is sent home early. Totali does not compute these yet.',
    when: 'each_pay_run',
    states: ['NY'],
    notModelled: true,
  },
  {
    id: 'ca_wage_statement',
    title: 'California: itemised wage statements',
    detail: 'Each pay stub must itemise hours, rates and every deduction (Labor Code § 226).',
    when: 'each_pay_run',
    states: ['CA'],
    coveredBy: 'engine/payroll/caWageStatement.ts',
  },
  {
    id: 'or_fair_work_week',
    title: 'Oregon: predictive scheduling for large food-service employers',
    detail: 'Covered employers owe written schedules in advance and premium pay for changes. Applies to employers with 500 or more employees worldwide.',
    when: 'ongoing',
    states: ['OR'],
    coveredBy: 'engine/payroll/orFairWorkWeek.ts',
  },
];

const driverItem: ChecklistItem = {
  id: 'driver_reimbursement',
  title: 'Reimburse delivery drivers’ vehicle costs',
  detail:
    'Delivery drivers’ vehicle costs cannot push their pay below minimum wage. Reimburse mileage or actual costs and record them as non-taxable reimbursement earnings. Totali pays and reports them separately from wages.',
  when: 'each_pay_run',
};

const serviceChargeItem: ChecklistItem = {
  id: 'service_charge_disclosure',
  title: 'Disclose service charges so customers know they are not tips',
  detail:
    'A charge a customer could reasonably take to be a gratuity is treated as one in some states (for example New York Labor Law § 196-d). Label it plainly and state where it goes.',
  when: 'ongoing',
  notModelled: true,
};

const multiStateItem: ChecklistItem = {
  id: 'multi_state_shifts',
  title: 'Events in more than one state',
  detail:
    'An employee who works in two states in one pay period needs withholding in both. Totali pays an employee in one work state per period and raises a review issue when shifts span two.',
  when: 'each_pay_run',
  notModelled: true,
};

export const restaurantNiches: NicheProfile[] = [
  {
    id: 'full_service',
    industry: 'restaurant',
    label: 'Full-service restaurant',
    tagline: 'Servers, bar, kitchen. Tips that move between roles.',
    description:
      'Table service with servers who tip out bussers, bartenders and hosts. Tipped staff are paid the tipped cash wage where the state allows it, and the pay run tops up any workweek where tips fall short of minimum wage. Tip-outs go only to customarily tipped roles, as the tip-credit rules require.',
    roles: [
      role({ key: 'server', label: 'Server', tipped: 'customarily', workersCompHint: WC_REST }),
      role({ key: 'bartender', label: 'Bartender', tipped: 'customarily', workersCompHint: WC_BAR }),
      role({ key: 'host', label: 'Host', tipped: 'sometimes', workersCompHint: WC_REST }),
      role({ key: 'busser', label: 'Busser', tipped: 'customarily', workersCompHint: WC_REST }),
      role({ key: 'food_runner', label: 'Food runner', tipped: 'customarily', workersCompHint: WC_REST }),
      lineCook,
      prepCook,
      dish,
      gm,
    ],
    policy: {
      ...none,
      takesTipCredit: true,
      tipOuts: [
        { id: 'server_busser', fromRole: 'server', toRole: 'busser', basis: 'percent_of_sales', bps: 150 },
        { id: 'server_bar', fromRole: 'server', toRole: 'bartender', basis: 'percent_of_sales', bps: 100 },
      ],
    },
    payFrequency: 'biweekly',
    workweekStartDay: 1,
    features: ['tips', 'tip_credit', 'tip_out', 'split_shifts', 'multi_role_employees'],
    checklist: universal,
    reports: ['tip_report', 'tip_credit_makeup', 'fica_tip_credit', 'labor_cost'],
  },
  {
    id: 'fine_dining',
    industry: 'restaurant',
    label: 'Fine dining',
    tagline: 'A shared tip pool weighted by role.',
    description:
      'Captains, servers, runners and bussers pool charged tips each night and split them by points and hours. The house pays full minimum wage in cash, so no tip credit is taken and no workweek needs a top-up.',
    roles: [
      role({ key: 'captain', label: 'Captain', tipped: 'customarily', poolPoints: 1.5, workersCompHint: WC_REST }),
      role({ key: 'server', label: 'Server', tipped: 'customarily', poolPoints: 1, workersCompHint: WC_REST }),
      role({ key: 'sommelier', label: 'Sommelier', tipped: 'customarily', poolPoints: 1.25, workersCompHint: WC_BAR }),
      role({ key: 'food_runner', label: 'Food runner', tipped: 'customarily', poolPoints: 0.7, workersCompHint: WC_REST }),
      role({ key: 'busser', label: 'Busser', tipped: 'customarily', poolPoints: 0.6, workersCompHint: WC_REST }),
      role({ key: 'host', label: 'Host', tipped: 'sometimes', poolPoints: 0.5, workersCompHint: WC_REST }),
      role({ key: 'bartender', label: 'Bartender', tipped: 'customarily', poolPoints: 1, workersCompHint: WC_BAR }),
      role({ key: 'sous_chef', label: 'Sous chef', tipped: 'never', pay: 'salary', poolPoints: 0, workersCompHint: WC_REST }),
      lineCook,
      prepCook,
      dish,
      role({ key: 'chef_de_cuisine', label: 'Chef de cuisine', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_REST }),
      gm,
    ],
    policy: {
      ...none,
      takesTipCredit: false,
      pool: { enabled: true, roles: ['captain', 'server', 'sommelier', 'food_runner', 'busser', 'host', 'bartender'], basis: 'points' },
    },
    payFrequency: 'biweekly',
    workweekStartDay: 1,
    features: ['tips', 'tip_pool', 'points_pool', 'salaried_kitchen'],
    checklist: universal,
    reports: ['tip_report', 'pool_distribution', 'fica_tip_credit', 'labor_cost'],
  },
  {
    id: 'quick_service',
    industry: 'restaurant',
    label: 'Quick service (QSR)',
    tagline: 'Counter and drive-thru. Hourly crews, optional tips.',
    description:
      'Counter, drive-thru and kitchen crews at hourly rates, weekly pay, and a shift-lead tier. Tips are rare, so none are pooled by default, and the full minimum wage is paid in cash.',
    roles: [
      role({ key: 'crew_member', label: 'Crew member', tipped: 'sometimes', workersCompHint: WC_FAST }),
      role({ key: 'cashier', label: 'Cashier', tipped: 'sometimes', workersCompHint: WC_FAST }),
      role({ key: 'drive_thru', label: 'Drive-thru', tipped: 'sometimes', workersCompHint: WC_FAST }),
      role({ key: 'cook', label: 'Cook', tipped: 'never', workersCompHint: WC_FAST }),
      role({ key: 'shift_lead', label: 'Shift lead', tipped: 'never', workersCompHint: WC_FAST }),
      role({ key: 'assistant_manager', label: 'Assistant manager', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_FAST }),
      role({ key: 'general_manager', label: 'General manager', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_FAST }),
    ],
    policy: { ...none },
    payFrequency: 'weekly',
    workweekStartDay: 1,
    features: ['high_turnover', 'minors', 'franchise_multi_unit'],
    checklist: universal,
    reports: ['labor_cost', 'tip_report'],
  },
  {
    id: 'fast_casual',
    industry: 'restaurant',
    label: 'Fast casual',
    tagline: 'Tip screen at the counter, shared with the kitchen.',
    description:
      'The POS tip screen collects tips and the house shares them by hours across counter staff and cooks. Because the house pays full minimum wage in cash and takes no tip credit, back-of-house staff may share in the pool.',
    roles: [
      role({ key: 'counter', label: 'Counter / cashier', tipped: 'customarily', workersCompHint: WC_FAST }),
      role({ key: 'cook', label: 'Cook', tipped: 'never', workersCompHint: WC_FAST }),
      role({ key: 'expo', label: 'Expo', tipped: 'never', workersCompHint: WC_FAST }),
      dish,
      role({ key: 'shift_lead', label: 'Shift lead', tipped: 'never', workersCompHint: WC_FAST }),
      role({ key: 'general_manager', label: 'General manager', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_FAST }),
    ],
    policy: {
      ...none,
      takesTipCredit: false,
      pool: { enabled: true, roles: ['counter', 'cook', 'expo', 'dishwasher', 'shift_lead'], basis: 'hours' },
    },
    payFrequency: 'biweekly',
    workweekStartDay: 1,
    features: ['tips', 'tip_pool', 'boh_in_pool'],
    checklist: universal,
    reports: ['tip_report', 'pool_distribution', 'labor_cost'],
  },
  {
    id: 'cafe_coffee',
    industry: 'restaurant',
    label: 'Café and coffee shop',
    tagline: 'Tip jar and card tips pooled by hours.',
    description:
      'Baristas and counter staff share the tip jar and card tips by hours worked. The house counts the jar and pays it through payroll, so the tips are taxed and reported.',
    roles: [
      role({ key: 'barista', label: 'Barista', tipped: 'customarily', workersCompHint: WC_FAST }),
      role({ key: 'cashier', label: 'Cashier', tipped: 'customarily', workersCompHint: WC_FAST }),
      role({ key: 'baker', label: 'Baker', tipped: 'never', workersCompHint: WC_REST }),
      role({ key: 'shift_supervisor', label: 'Shift supervisor', tipped: 'never', manager: true, poolPoints: 0, workersCompHint: WC_FAST }),
      role({ key: 'store_manager', label: 'Store manager', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_FAST }),
    ],
    policy: {
      ...none,
      takesTipCredit: false,
      pool: { enabled: true, roles: ['barista', 'cashier'], basis: 'hours' },
    },
    payFrequency: 'biweekly',
    workweekStartDay: 1,
    features: ['tips', 'tip_pool', 'house_counted_jar'],
    checklist: universal,
    reports: ['tip_report', 'pool_distribution', 'labor_cost'],
  },
  {
    id: 'bar_nightclub',
    industry: 'restaurant',
    label: 'Bar and nightclub',
    tagline: 'Bartenders tip out barbacks. Late shifts, cash tips.',
    description:
      'Bartenders and cocktail servers tip out barbacks on charged tips, cash tips are declared per shift, and shifts run past midnight and are assigned to the day they started.',
    roles: [
      role({ key: 'bartender', label: 'Bartender', tipped: 'customarily', workersCompHint: WC_BAR }),
      role({ key: 'cocktail_server', label: 'Cocktail server', tipped: 'customarily', workersCompHint: WC_BAR }),
      role({ key: 'barback', label: 'Barback', tipped: 'customarily', workersCompHint: WC_BAR }),
      role({ key: 'door_security', label: 'Door / security', tipped: 'never', workersCompHint: WC_BAR }),
      role({ key: 'bar_manager', label: 'Bar manager', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_BAR }),
    ],
    policy: {
      ...none,
      takesTipCredit: true,
      tipOuts: [
        { id: 'bartender_barback', fromRole: 'bartender', toRole: 'barback', basis: 'percent_of_tips', bps: 1500 },
        { id: 'cocktail_barback', fromRole: 'cocktail_server', toRole: 'barback', basis: 'percent_of_tips', bps: 1000 },
      ],
    },
    payFrequency: 'weekly',
    workweekStartDay: 1,
    features: ['tips', 'tip_credit', 'tip_out', 'overnight_shifts', 'cash_tips'],
    checklist: universal,
    reports: ['tip_report', 'tip_credit_makeup', 'fica_tip_credit', 'labor_cost'],
  },
  {
    id: 'food_truck',
    industry: 'restaurant',
    label: 'Food truck and pop-up',
    tagline: 'Small crew, seasonal, working events in different places.',
    description:
      'A small crew paid hourly with a shared tip jar, seasonal hiring, and events in different jurisdictions. The pay run pays each employee in one work state per period and flags shifts that span two.',
    roles: [
      role({ key: 'truck_lead', label: 'Truck lead', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_FAST }),
      role({ key: 'window', label: 'Window / cashier', tipped: 'customarily', workersCompHint: WC_FAST }),
      role({ key: 'cook', label: 'Cook', tipped: 'never', workersCompHint: WC_FAST }),
      role({ key: 'event_helper', label: 'Event helper', tipped: 'sometimes', workersCompHint: WC_FAST }),
    ],
    policy: {
      ...none,
      takesTipCredit: false,
      pool: { enabled: true, roles: ['window', 'cook', 'event_helper'], basis: 'hours' },
    },
    payFrequency: 'weekly',
    workweekStartDay: 1,
    features: ['tips', 'tip_pool', 'seasonal', 'multi_state_events'],
    checklist: [...universal, multiStateItem],
    reports: ['tip_report', 'pool_distribution', 'labor_cost'],
  },
  {
    id: 'catering_banquet',
    industry: 'restaurant',
    label: 'Catering and banquets',
    tagline: 'Per-event staffing with a mandatory service charge.',
    description:
      'Event crews paid by the shift. A mandatory service charge on each event is wages, not tips, and is shared among event staff by hours. Staff are on-call and the crew changes with each event.',
    roles: [
      role({ key: 'event_captain', label: 'Event captain', tipped: 'never', manager: true, poolPoints: 0, workersCompHint: WC_REST }),
      role({ key: 'banquet_server', label: 'Banquet server', tipped: 'customarily', workersCompHint: WC_REST }),
      role({ key: 'banquet_bartender', label: 'Banquet bartender', tipped: 'customarily', workersCompHint: WC_BAR }),
      role({ key: 'setup_crew', label: 'Set-up crew', tipped: 'never', workersCompHint: WC_REST }),
      role({ key: 'banquet_cook', label: 'Banquet cook', tipped: 'never', workersCompHint: WC_REST }),
      role({ key: 'executive_chef', label: 'Executive chef', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_REST }),
    ],
    policy: {
      ...none,
      takesTipCredit: false,
      serviceCharge: 'distribute_to_staff',
      serviceChargeRoles: ['banquet_server', 'banquet_bartender', 'setup_crew', 'banquet_cook'],
    },
    payFrequency: 'weekly',
    workweekStartDay: 1,
    features: ['service_charge', 'on_call_staff', 'per_event_shifts'],
    checklist: [...universal, serviceChargeItem],
    reports: ['service_charge_distribution', 'labor_cost'],
  },
  {
    id: 'pizzeria_delivery',
    industry: 'restaurant',
    label: 'Pizzeria and delivery',
    tagline: 'Counter, kitchen and drivers paid mileage.',
    description:
      'Drivers earn tips and are reimbursed for vehicle costs as non-taxable reimbursement, counter staff take orders, and the kitchen is hourly. Takes a tip credit where the state allows it.',
    roles: [
      role({ key: 'driver', label: 'Delivery driver', tipped: 'customarily', reimbursesVehicleExpenses: true, workersCompHint: WC_FAST }),
      role({ key: 'counter', label: 'Counter / phones', tipped: 'sometimes', workersCompHint: WC_FAST }),
      role({ key: 'pizza_cook', label: 'Pizza cook', tipped: 'never', workersCompHint: WC_FAST }),
      role({ key: 'server', label: 'Server', tipped: 'customarily', workersCompHint: WC_REST }),
      role({ key: 'shift_lead', label: 'Shift lead', tipped: 'never', workersCompHint: WC_FAST }),
      role({ key: 'general_manager', label: 'General manager', tipped: 'never', manager: true, pay: 'salary', poolPoints: 0, workersCompHint: WC_FAST }),
    ],
    policy: { ...none, takesTipCredit: true },
    payFrequency: 'weekly',
    workweekStartDay: 1,
    features: ['tips', 'tip_credit', 'delivery_drivers', 'vehicle_reimbursement'],
    checklist: [...universal, driverItem],
    reports: ['tip_report', 'tip_credit_makeup', 'driver_reimbursement', 'labor_cost'],
  },
];
