/**
 * 周考核观测与自动结算纯计算引擎（完整等价迁移自 LecPunch assessment-engine.ts，零 luxon 依赖）：
 * - 严格基于 Asia/Shanghai 周一起止边界、5 分钟观测连续性阈值、周结束 + 5 小时结算延迟；
 * - 首次登记当周免考（new_member），停用成员豁免（disabled），非应考届豁免（outside_cohort）；
 * - complete / failed / exempt 一旦落定即不可变，pending 可待证据补齐后再结算。
 */
import {
  assessmentEnrollYears,
  comprehensiveDurationSeconds,
  requiresWeeklyAssessment,
} from './punch-shared.util.js';
import {
  addShanghaiDays,
  getShanghaiParts,
  shanghaiDayStartMs,
} from './punch-title-engine.js';

const OBSERVATION_GAP_MS = 5 * 60_000;
export const ASSESSMENT_SETTLEMENT_DELAY_MS = 5 * 3_600_000;

export interface AssessmentMemberSnapshot {
  userId: string;
  enrollYear?: number | null;
  goalSeconds: number | null;
  createdAt: number | null;
  joinedAt?: number | null;
  status: 'active' | 'disabled' | 'unknown';
}

export type AssessmentReason =
  | 'eligible'
  | 'new_member'
  | 'disabled'
  | 'before_enabled'
  | 'not_observed_at_start'
  | 'not_observed_continuously'
  | 'invalid_member_data'
  | 'outside_cohort';

export interface AssessmentRosterEntry {
  enrollYearSnapshot?: number | null;
  goalSeconds: number | null;
  eligible: boolean;
  reason: AssessmentReason;
  createdAtSnapshot: number | null;
  joinedAtSnapshot: number | null;
}

export interface AssessmentTotals {
  rawSeconds: number;
  manualSeconds: number;
  entertainmentSeconds: number;
}

export interface AssessmentOutcome {
  userId: string;
  status: 'complete' | 'failed' | 'exempt' | 'pending';
  reason: string;
  goalSeconds: number | null;
  rawSeconds: number | null;
  manualSeconds: number | null;
  entertainmentSeconds: number | null;
  comprehensiveSeconds: number | null;
  settledAt: number | null;
}

export interface AssessmentWeekState {
  version: 1;
  requiredEnrollYears?: number[];
  weekKey: string;
  startsAt: number;
  endsAt: number;
  enabledAt: number;
  firstObservedAt: number;
  lastObservedAt: number;
  coverageTrusted: boolean;
  roster: Record<string, AssessmentRosterEntry>;
  outcomes: Record<string, AssessmentOutcome>;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** 校验北京时间周一 YYYY-MM-DD 格式并返回该周起止毫秒时间戳。 */
export function parseMondayWeekBounds(weekKey: string): { startsAt: number; endsAt: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) {
    throw new Error('考核周必须是北京时间周一的 yyyy-MM-dd 日期');
  }
  const startsAt = shanghaiDayStartMs(weekKey, 0);
  if (!Number.isFinite(startsAt)) {
    throw new Error('考核周必须是北京时间周一的 yyyy-MM-dd 日期');
  }
  const parts = getShanghaiParts(startsAt);
  const formatted = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  if (formatted !== weekKey || parts.weekday !== 1) {
    throw new Error('考核周必须是北京时间周一的 yyyy-MM-dd 日期');
  }
  const endsAt = shanghaiDayStartMs(addShanghaiDays(weekKey, 7), 0);
  return { startsAt, endsAt };
}

/** 校验 ASSESSMENT_START_WEEK 配置（留空表示关闭自动考核）。 */
export function validateAssessmentStartWeek(value: unknown): {
  startWeek: string | null;
  enabledAt: number | null;
} {
  if (value === undefined || value === null || value === '') {
    return { startWeek: null, enabledAt: null };
  }
  if (typeof value !== 'string') {
    throw new Error('ASSESSMENT_START_WEEK 必须为北京时间周一 yyyy-MM-dd，留空表示关闭');
  }
  const trimmed = value.trim();
  if (!trimmed) return { startWeek: null, enabledAt: null };
  const { startsAt } = parseMondayWeekBounds(trimmed);
  return { startWeek: trimmed, enabledAt: startsAt };
}

function assertMembers(members: AssessmentMemberSnapshot[]): void {
  const ids = new Set<string>();
  for (const member of members) {
    if (
      !member.userId ||
      ids.has(member.userId) ||
      ['__proto__', 'prototype', 'constructor'].includes(member.userId)
    ) {
      throw new Error('成员稳定标识无效或重复');
    }
    ids.add(member.userId);
  }
}

function rosterEntry(
  member: AssessmentMemberSnapshot,
  state: Pick<AssessmentWeekState, 'startsAt' | 'enabledAt' | 'requiredEnrollYears'>,
  atStart: boolean,
): AssessmentRosterEntry {
  const goal = validSeconds(member.goalSeconds) && member.goalSeconds > 0 ? member.goalSeconds : null;
  const created = validTimestamp(member.createdAt) ? member.createdAt : null;
  const joined = validTimestamp(member.joinedAt) ? member.joinedAt : null;
  let reason: AssessmentReason = 'eligible';
  if (state.startsAt < state.enabledAt) {
    reason = 'before_enabled';
  } else if (
    Number.isInteger(member.enrollYear) &&
    !requiresWeeklyAssessment(member.enrollYear!, state.requiredEnrollYears ?? [])
  ) {
    reason = 'outside_cohort';
  } else if (member.status === 'disabled') {
    reason = 'disabled';
  } else if ((created !== null && created >= state.startsAt) || (joined !== null && joined >= state.startsAt)) {
    reason = 'new_member';
  } else if (!atStart) {
    reason = 'not_observed_at_start';
  } else if (
    !Number.isInteger(member.enrollYear) ||
    goal === null ||
    created === null ||
    joined === null ||
    member.status !== 'active'
  ) {
    reason = 'invalid_member_data';
  }
  return {
    enrollYearSnapshot: Number.isInteger(member.enrollYear) ? member.enrollYear : null,
    goalSeconds: goal,
    eligible: reason === 'eligible',
    reason,
    createdAtSnapshot: created,
    joinedAtSnapshot: joined,
  };
}

/** 建立当周首次观测快照。 */
export function createAssessmentWeek(
  weekKey: string,
  observedAt: number,
  members: AssessmentMemberSnapshot[],
  enabledAt: number,
  previousRequiredEnrollYears: number[] = [],
): AssessmentWeekState {
  const bounds = parseMondayWeekBounds(weekKey);
  if (
    !validTimestamp(observedAt) ||
    !validTimestamp(enabledAt) ||
    observedAt < bounds.startsAt ||
    observedAt >= bounds.endsAt
  ) {
    throw new Error('只能在该周内建立真实观测快照');
  }
  assertMembers(members);
  const state: AssessmentWeekState = {
    version: 1,
    weekKey,
    ...bounds,
    enabledAt,
    requiredEnrollYears: assessmentEnrollYears(
      members.map((m) => m.enrollYear),
      previousRequiredEnrollYears,
      Number(weekKey.slice(0, 4)),
    ),
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    coverageTrusted: observedAt <= bounds.startsAt + OBSERVATION_GAP_MS,
    roster: {},
    outcomes: {},
  };
  for (const member of members) {
    state.roster[member.userId] = rosterEntry(member, state, state.coverageTrusted);
  }
  return state;
}

/** 推进一次考核观测（全量团队名册）。 */
export function observeAssessmentWeek(
  state: AssessmentWeekState,
  observedAt: number,
  members: AssessmentMemberSnapshot[],
  previousRequiredEnrollYears: number[] = [],
): AssessmentWeekState {
  if (!validTimestamp(observedAt) || observedAt < state.lastObservedAt) {
    throw new Error('考核观测时间不能倒退');
  }
  assertMembers(members);
  const next = structuredClone(state);
  const coverageUntil = Math.min(observedAt, next.endsAt);
  if (coverageUntil - next.lastObservedAt > OBSERVATION_GAP_MS) {
    next.coverageTrusted = false;
  }
  next.lastObservedAt = Math.max(next.lastObservedAt, coverageUntil);
  if (observedAt >= next.endsAt) return next;

  next.requiredEnrollYears = assessmentEnrollYears(
    members.map((m) => m.enrollYear),
    [...(next.requiredEnrollYears ?? []), ...previousRequiredEnrollYears],
    Number(next.weekKey.slice(0, 4)),
  );
  const observed = new Map(members.map((m) => [m.userId, m]));
  for (const [userId, entry] of Object.entries(next.roster)) {
    if (next.outcomes[userId] && next.outcomes[userId].status !== 'pending') continue;
    const member = observed.get(userId);
    if (entry.enrollYearSnapshot === undefined && member) {
      entry.enrollYearSnapshot =
        typeof member.enrollYear === 'number' && Number.isInteger(member.enrollYear)
          ? member.enrollYear
          : null;
      if (entry.enrollYearSnapshot === null) {
        entry.eligible = false;
        entry.reason = 'invalid_member_data';
      }
    }
    if (
      typeof entry.enrollYearSnapshot === 'number' &&
      !requiresWeeklyAssessment(entry.enrollYearSnapshot, next.requiredEnrollYears)
    ) {
      entry.eligible = false;
      entry.reason = 'outside_cohort';
    }
    if (entry.reason === 'outside_cohort') continue;
    if (member?.status === 'disabled') {
      entry.eligible = false;
      entry.reason = 'disabled';
    } else if (!member && entry.eligible) {
      entry.eligible = false;
      entry.reason = 'not_observed_continuously';
    } else if (member?.status === 'unknown' && entry.eligible) {
      entry.eligible = false;
      entry.reason = 'invalid_member_data';
    }
  }
  for (const member of members) {
    if (!Object.prototype.hasOwnProperty.call(next.roster, member.userId)) {
      next.roster[member.userId] = rosterEntry(member, next, false);
    }
  }
  return next;
}

function comprehensive(totals: AssessmentTotals | undefined): number | null {
  if (
    !totals ||
    !validSeconds(totals.rawSeconds) ||
    totals.rawSeconds < 0 ||
    !validSeconds(totals.manualSeconds) ||
    !validSeconds(totals.entertainmentSeconds)
  ) {
    return null;
  }
  try {
    return comprehensiveDurationSeconds(
      totals.rawSeconds,
      totals.manualSeconds,
      totals.entertainmentSeconds,
    );
  } catch {
    return null;
  }
}

/** 周结束 + 5 小时后结算考核结果（complete / failed / exempt 不可逆）。 */
export function finalizeAssessmentWeek(
  state: AssessmentWeekState,
  now: number,
  totals: Record<string, AssessmentTotals | undefined>,
): AssessmentWeekState {
  if (!validTimestamp(now)) throw new Error('结算时间无效');
  const next = structuredClone(state);
  for (const [userId, entry] of Object.entries(next.roster)) {
    if (next.outcomes[userId] && next.outcomes[userId].status !== 'pending') continue;
    const result: AssessmentOutcome = {
      userId,
      status: 'pending',
      reason: 'settlement_window',
      goalSeconds: entry.goalSeconds,
      rawSeconds: null,
      manualSeconds: null,
      entertainmentSeconds: null,
      comprehensiveSeconds: null,
      settledAt: null,
    };
    if (now < next.endsAt + ASSESSMENT_SETTLEMENT_DELAY_MS) {
      next.outcomes[userId] = result;
      continue;
    }
    if (['new_member', 'disabled', 'before_enabled', 'outside_cohort'].includes(entry.reason)) {
      result.status = 'exempt';
      result.reason = entry.reason;
      result.settledAt = now;
    } else if (!entry.eligible) {
      result.reason = entry.reason;
    } else if (!Number.isInteger(entry.enrollYearSnapshot)) {
      result.reason = 'invalid_member_data';
    } else if (!next.coverageTrusted || next.lastObservedAt < next.endsAt - OBSERVATION_GAP_MS) {
      result.reason = 'incomplete_observation';
    } else {
      const data = totals[userId];
      const total = comprehensive(data);
      if (total === null || !validSeconds(entry.goalSeconds) || entry.goalSeconds <= 0) {
        result.reason = 'invalid_totals';
      } else {
        result.status = total >= entry.goalSeconds ? 'complete' : 'failed';
        result.reason = 'settled';
        result.rawSeconds = data!.rawSeconds;
        result.manualSeconds = data!.manualSeconds;
        result.entertainmentSeconds = data!.entertainmentSeconds;
        result.comprehensiveSeconds = total;
        result.settledAt = now;
      }
    }
    next.outcomes[userId] = result;
  }
  return next;
}
