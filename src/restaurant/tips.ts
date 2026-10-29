import { applyBps, allocate, sum, type Cents } from '../lib/money.ts';
import { blocking, review, info, type Issue } from '../lib/issues.ts';
import type { CompanySettings, RoleTemplate } from '../industries/types.ts';
import { isEligibleForTipPool } from '../../engine/payroll/tipCredit.ts';

/**
 * Tip and service-charge distribution for a set of shifts, one calendar day
 * at a time. The order within a day is fixed and every step conserves cents:
 *
 *   1. card fee      a pro rata share of the processing fee comes off charged tips (only if the company turned it on)
 *   2. tip-outs      each mandatory tip-out moves money from one role's shifts to another's, by hours
 *   3. pool          shifts in pool roles put their remaining charged tips, plus any house-counted jar,
 *                    into one pot that is shared by hours or points
 *   4. service charge a mandatory service charge is wages, shared by hours among its configured roles
 *
 * A step that cannot be done honestly (nobody to receive a tip-out, an
 * ineligible role in the pool) raises an issue instead of guessing.
 */

export interface TipShift {
  shiftId: string;
  employeeId: string;
  workDate: string;
  roleKey: string;
  minutes: number;
  /** Tips the employer holds for the employee: card tips, and cash the house counted. Paid through payroll. */
  chargedTipsCents: Cents;
  /** Tips the employee kept and declared. Taxed, but never paid out by payroll. */
  cashTipsCents: Cents;
  salesCents: Cents;
}

export interface DayHouse {
  date: string;
  /** Tip jar or other tips the house collected and counted for the day. */
  houseTipsCents: Cents;
  serviceChargesCents: Cents;
}

export interface ShiftTips {
  shiftId: string;
  employeeId: string;
  workDate: string;
  /** Own charged tips left after the card fee, tip-outs paid and pool contribution. */
  keptCents: Cents;
  tipOutPaidCents: Cents;
  tipOutReceivedCents: Cents;
  poolShareCents: Cents;
  serviceChargeShareCents: Cents;
  cashTipsCents: Cents;
  cardFeeCents: Cents;
}

export interface TipDistribution {
  shifts: ShiftTips[];
  /** Cents the policy could not place (no eligible recipient). Left with the house, never invented. */
  undistributedCents: Cents;
  issues: Issue[];
}

export interface TipContext {
  settings: CompanySettings;
  /** Whether a tip credit is actually in effect (the company takes one and the state allows it). Controls who may share in a pool. */
  tipCreditInEffect: boolean;
}

function roleOf(settings: CompanySettings, key: string): RoleTemplate | undefined {
  return settings.roles.find((r) => r.key === key);
}

export function distributeTips(shifts: readonly TipShift[], house: readonly DayHouse[], ctx: TipContext): TipDistribution {
  const { settings, tipCreditInEffect } = ctx;
  const { policy } = settings;
  const issues: Issue[] = [];
  let undistributed = 0;

  const state = new Map<string, ShiftTips & { available: Cents }>();
  for (const s of shifts) {
    const fee = policy.cardFeeDeductionBps !== null ? applyBps(s.chargedTipsCents, policy.cardFeeDeductionBps) : 0;
    state.set(s.shiftId, {
      shiftId: s.shiftId,
      employeeId: s.employeeId,
      workDate: s.workDate,
      keptCents: s.chargedTipsCents - fee,
      available: s.chargedTipsCents - fee,
      tipOutPaidCents: 0,
      tipOutReceivedCents: 0,
      poolShareCents: 0,
      serviceChargeShareCents: 0,
      cashTipsCents: s.cashTipsCents,
      cardFeeCents: fee,
    });
  }

  const dates = [...new Set([...shifts.map((s) => s.workDate), ...house.map((h) => h.date)])].sort();
  const canShare = (r: RoleTemplate | undefined): boolean =>
    r !== undefined && isEligibleForTipPool({ isManagerOrSupervisor: r.manager, customarilyReceivesTips: r.tipped === 'customarily', employerTakesTipCredit: tipCreditInEffect });

  for (const date of dates) {
    const day = shifts.filter((s) => s.workDate === date);
    const dayHouse = house.find((h) => h.date === date);

    // 2. tip-outs
    for (const rule of policy.tipOuts) {
      const payers = day.filter((s) => s.roleKey === rule.fromRole);
      const recipients = day.filter((s) => s.roleKey === rule.toRole);
      if (payers.length === 0) continue;
      const toRole = roleOf(settings, rule.toRole);
      if (!canShare(toRole)) {
        issues.push(blocking('tip_out_recipient_ineligible', `Tip-out '${rule.id}' pays '${rule.toRole}', who may not receive tips${tipCreditInEffect ? ' while a tip credit is taken (only customarily tipped, non-management roles may)' : ' (managers and supervisors never may)'}. Change the rule or the role.`, { date }));
        continue;
      }
      const owed = payers.map((p) => {
        const want = rule.basis === 'percent_of_tips' ? applyBps(state.get(p.shiftId)!.available, rule.bps) : applyBps(p.salesCents, rule.bps);
        const take = Math.min(want, state.get(p.shiftId)!.available);
        if (take < want) {
          issues.push(review('tip_out_exceeds_card_tips', `A ${rule.fromRole}'s tip-out '${rule.id}' (${want}¢) is larger than the card tips they hold (${take}¢). Only the card tips were passed on. Settle the rest in cash outside payroll.`, { employeeId: p.employeeId, date }));
        }
        return take;
      });
      const pot = sum(owed);
      if (pot === 0) continue;
      if (recipients.length === 0) {
        issues.push(review('tip_out_no_recipient', `No ${rule.toRole} worked on ${date}, so tip-out '${rule.id}' (${pot}¢) was not taken from the ${rule.fromRole} shifts.`, { date }));
        continue;
      }
      payers.forEach((p, i) => {
        const st = state.get(p.shiftId)!;
        st.available -= owed[i];
        st.keptCents -= owed[i];
        st.tipOutPaidCents += owed[i];
      });
      const shares = allocate(pot, recipients.map((r) => r.minutes));
      recipients.forEach((r, i) => {
        state.get(r.shiftId)!.tipOutReceivedCents += shares[i];
      });
    }

    // 3. pool
    if (policy.pool.enabled) {
      const inPoolRole = day.filter((s) => policy.pool.roles.includes(s.roleKey));
      const ineligible = inPoolRole.filter((s) => !canShare(roleOf(settings, s.roleKey)));
      for (const s of ineligible) {
        issues.push(blocking('tip_pool_member_ineligible', `Role '${s.roleKey}' is in the tip pool but may not share in it${tipCreditInEffect ? ' while a tip credit is taken (only customarily tipped, non-management roles may)' : ' (managers and supervisors never may)'}. Remove the role from the pool or stop taking the tip credit.`, { employeeId: s.employeeId, date }));
      }
      const members = inPoolRole.filter((s) => canShare(roleOf(settings, s.roleKey)));
      const contributed = members.reduce((a, m) => a + state.get(m.shiftId)!.available, 0);
      const pot = contributed + (dayHouse?.houseTipsCents ?? 0);
      if (pot > 0) {
        const weights = members.map((m) => (policy.pool.basis === 'points' ? m.minutes * (roleOf(settings, m.roleKey)?.poolPoints ?? 0) : m.minutes));
        if (members.length === 0 || sum(weights) === 0) {
          // Nobody can receive it: members keep their own tips, the house jar stays undistributed.
          undistributed += dayHouse?.houseTipsCents ?? 0;
          if ((dayHouse?.houseTipsCents ?? 0) > 0) issues.push(review('house_tips_no_recipient', `House tips of ${dayHouse!.houseTipsCents}¢ on ${date} have no eligible pool member and were not distributed.`, { date }));
        } else {
          for (const m of members) {
            const st = state.get(m.shiftId)!;
            st.keptCents -= st.available;
            st.available = 0;
          }
          const shares = allocate(pot, weights);
          members.forEach((m, i) => {
            state.get(m.shiftId)!.poolShareCents += shares[i];
          });
        }
      }
    } else if ((dayHouse?.houseTipsCents ?? 0) > 0) {
      issues.push(blocking('house_tips_without_pool', `House tips were recorded on ${date} but this company has no tip pool to share them. Enable a pool or record the tips against employees.`, { date }));
      undistributed += dayHouse!.houseTipsCents;
    }

    // 4. service charge
    const charge = dayHouse?.serviceChargesCents ?? 0;
    if (charge > 0) {
      if (policy.serviceCharge === 'distribute_to_staff') {
        const takers = day.filter((s) => policy.serviceChargeRoles.includes(s.roleKey));
        if (takers.length === 0 || sum(takers.map((t) => t.minutes)) === 0) {
          undistributed += charge;
          issues.push(review('service_charge_no_recipient', `A service charge of ${charge}¢ on ${date} has no staff on the clock in its configured roles and was not distributed.`, { date }));
        } else {
          const shares = allocate(charge, takers.map((t) => t.minutes));
          takers.forEach((t, i) => {
            state.get(t.shiftId)!.serviceChargeShareCents += shares[i];
          });
        }
      } else {
        undistributed += charge;
        issues.push(info('service_charge_kept_by_house', `A service charge of ${charge}¢ on ${date} was kept as house revenue under the company's policy.`, { date }));
      }
    }
  }

  const out: ShiftTips[] = [...state.values()].map(({ available: _available, ...rest }) => rest);
  return { shifts: out, undistributedCents: undistributed, issues };
}
