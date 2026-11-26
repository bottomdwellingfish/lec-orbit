/**
 * 称号系统纯计算引擎（零外部时区库依赖，严格按 Asia/Shanghai UTC+8 自然日与考核周评估全部 11 个称号）。
 * 规则与原 LecPunch title-engine 保持 100% 等价。
 */
import { comprehensiveDurationSeconds, weeklyGoalSeconds } from './punch-shared.util.js';
import {
  TITLE_CATALOG,
  toMemberTitleBadge,
  type MemberTitleBadge,
  type TitleEvaluationItem,
} from './punch-title-catalog.js';

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const MAX_VALID_SESSION_SECONDS = 18_000;
const ONE_HOUR_SECONDS = 3_600;
const FOUR_HOURS_SECONDS = 4 * 3_600;
const FIVE_HOURS_SECONDS = 5 * 3_600;

const NEGATIVE_CARD_NAMES = new Set([
  '减时长',
  '顺手牵羊',
  '乐不思蜀',
  '铁索连环',
  '雷电',
  '兵粮寸断',
  '南蛮入侵',
  '红桃 K',
  '万箭穿心',
]);

export interface TitleEngineMember {
  id: string;
  enrollYear: number;
  createdAt?: Date;
  equippedTitleId?: string | null;
}

export interface TitleEngineSession {
  userId: string;
  checkInAt: Date;
  checkOutAt?: Date;
  durationSeconds?: number;
  status: 'active' | 'completed' | 'invalidated';
  weekKey: string;
}

export interface TitleEngineCardInteraction {
  actorId: string;
  targetId: string;
  polarity: 'positive' | 'negative';
  atMs: number;
}

export interface EvaluateTeamTitlesInput {
  now: Date;
  members: TitleEngineMember[];
  sessions: TitleEngineSession[];
  /** key 格式：`${userId}:${weekKey}` → 手动补正总秒数。 */
  manualAdjustmentsByUserWeek: Map<string, number>;
  /** key 格式：`${userId}:${weekKey}` → 卡牌娱乐时长 + 交易时长总秒数。 */
  entertainmentByUserWeek: Map<string, number>;
  /** 本周发生的跨人卡牌正/负面交互事件。 */
  currentWeekCardInteractions: TitleEngineCardInteraction[];
}

export interface MemberTitleEvaluation {
  equippedTitleId: string | null;
  displayTitles: MemberTitleBadge[];
  catalog: TitleEvaluationItem[];
}

/** 上海时区（UTC+8）日期分量结构。 */
interface ShanghaiParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  weekday: number; // 1=周一 .. 7=周日
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDayKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 将毫秒时间戳转为上海时间（UTC+8）分量。 */
export function getShanghaiParts(ms: number): ShanghaiParts {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const dow = shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: dow === 0 ? 7 : dow,
  };
}

/** 将上海自然日 YYYY-MM-DD（可选小时）转为对应 UTC 毫秒时间戳。 */
export function shanghaiDayStartMs(dayKey: string, hour = 0): number {
  const [y, m, d] = dayKey.split('-').map((v) => Number.parseInt(v, 10));
  return Date.UTC(y, m - 1, d, hour, 0, 0, 0) - SHANGHAI_OFFSET_MS;
}

/** 获取指定毫秒时间戳对应的上海自然日 YYYY-MM-DD。 */
export function shanghaiDayKeyOfMs(ms: number): string {
  const p = getShanghaiParts(ms);
  return formatDayKey(p.year, p.month, p.day);
}

/** 获取指定毫秒时间戳所在上海考核周的周一日期 YYYY-MM-DD。 */
export function shanghaiWeekKeyOfMs(ms: number): string {
  const p = getShanghaiParts(ms);
  const mondayUtcMs = Date.UTC(p.year, p.month - 1, p.day - (p.weekday - 1));
  const m = new Date(mondayUtcMs);
  return formatDayKey(m.getUTCFullYear(), m.getUTCMonth() + 1, m.getUTCDate());
}

/** 对上海自然日 YYYY-MM-DD 加减天数。 */
export function addShanghaiDays(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split('-').map((v) => Number.parseInt(v, 10));
  const next = new Date(Date.UTC(y, m - 1, d + delta));
  return formatDayKey(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** 返回指定年月的总天数（1..12）。 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 获取指定上海时间对应“上个月 1 号前一天 00:00”的 Date，用于拉取称号回溯会话。 */
export function getTitleLookbackStartDate(now: Date): Date {
  const p = getShanghaiParts(now.getTime());
  const prevYear = p.month === 1 ? p.year - 1 : p.year;
  const prevMonth = p.month === 1 ? 12 : p.month - 1;
  const prevMonthFirstKey = formatDayKey(prevYear, prevMonth, 1);
  return new Date(shanghaiDayStartMs(addShanghaiDays(prevMonthFirstKey, -1)));
}

/** 计算区间 [startMs, endMs] 与 [winStartMs, winEndMs] 的重叠秒数。 */
function overlapSeconds(startMs: number, endMs: number, winStartMs: number, winEndMs: number): number {
  const s = Math.max(startMs, winStartMs);
  const e = Math.min(endMs, winEndMs);
  return e > s ? Math.floor((e - s) / 1000) : 0;
}

/** 计算一组已满足条件的日期集合中，截止在 [anchorDay - maxEndAgeDays, anchorDay] 内的最长连续天数。 */
function bestRecentConsecutiveStreak(
  days: Set<string>,
  anchorDay: string,
  maxLookbackDays = 60,
  maxEndAgeDays = 1,
): { qualified3: boolean; currentStreak: number } {
  let currentStreak = 0;
  const startFrom = days.has(anchorDay) ? anchorDay : addShanghaiDays(anchorDay, -1);
  let cursor = startFrom;
  while (days.has(cursor) && currentStreak < maxLookbackDays) {
    currentStreak += 1;
    cursor = addShanghaiDays(cursor, -1);
  }

  let qualified3 = false;
  for (let age = 0; age <= maxEndAgeDays; age += 1) {
    const endDay = addShanghaiDays(anchorDay, -age);
    if (
      days.has(endDay) &&
      days.has(addShanghaiDays(endDay, -1)) &&
      days.has(addShanghaiDays(endDay, -2))
    ) {
      qualified3 = true;
      break;
    }
  }
  return { qualified3, currentStreak };
}

/** 将一条卡牌回执解析为跨人正/负面交互事件列表（用于「吕洞宾」称号判定）。 */
export function extractCardInteractionsFromReceipt(receipt: {
  actorId?: string;
  at?: string;
  result?: Record<string, unknown> | null;
  gift?: Record<string, unknown> | null;
}): TitleEngineCardInteraction[] {
  const actorId = receipt.actorId;
  if (!actorId || !receipt.at) return [];
  const atMs = Date.parse(receipt.at);
  if (Number.isNaN(atMs)) return [];

  const events: TitleEngineCardInteraction[] = [];
  const giftRecipientId =
    receipt.gift && typeof receipt.gift.recipientId === 'string'
      ? receipt.gift.recipientId
      : undefined;
  if (giftRecipientId && giftRecipientId !== actorId) {
    events.push({
      actorId,
      targetId: giftRecipientId,
      polarity: 'positive',
      atMs,
    });
  }

  const result = receipt.result as
    | {
        action?: string;
        actionCard?: { name?: string };
        effects?: Array<{
          target?: { id?: string };
          kind?: string;
          deltaSeconds?: number;
          outcome?: string;
        }>;
      }
    | undefined
    | null;

  if (!result || result.action !== 'use' || !Array.isArray(result.effects)) {
    return events;
  }

  const cardName = result.actionCard?.name ?? '';
  for (const effect of result.effects) {
    const targetId = effect.target?.id;
    if (!targetId || targetId === actorId) continue;

    if (effect.kind === 'time') {
      const delta = effect.deltaSeconds ?? 0;
      if (delta > 0) {
        events.push({ actorId, targetId, polarity: 'positive', atMs });
        continue;
      }
      if (delta < 0) {
        events.push({ actorId, targetId, polarity: 'negative', atMs });
        continue;
      }
    }

    if (cardName === '五谷丰登' && effect.outcome === 'applied') {
      events.push({ actorId, targetId, polarity: 'positive', atMs });
      continue;
    }

    if (NEGATIVE_CARD_NAMES.has(cardName)) {
      events.push({ actorId, targetId, polarity: 'negative', atMs });
    }
  }

  return events;
}

interface UserDailyMetrics {
  dailySeconds: Map<string, number>;
  nightOwlDays: Set<string>;
  earlyBirdDays: Set<string>;
  overnightSeconds: Map<string, number>;
  recordedByWeek: Map<string, number>;
  activeCurrentWeekSeconds: number;
}

function emptyMetrics(): UserDailyMetrics {
  return {
    dailySeconds: new Map(),
    nightOwlDays: new Set(),
    earlyBirdDays: new Set(),
    overnightSeconds: new Map(),
    recordedByWeek: new Map(),
    activeCurrentWeekSeconds: 0,
  };
}

/** 评估全团队所有成员的 11 项自动称号、展示亮牌与进度文案。 */
export function evaluateTeamTitles(
  input: EvaluateTeamTitlesInput,
): Map<string, MemberTitleEvaluation> {
  const nowMs = input.now.getTime();
  const nowParts = getShanghaiParts(nowMs);
  const todayKey = formatDayKey(nowParts.year, nowParts.month, nowParts.day);
  const currentWeekKey = shanghaiWeekKeyOfMs(nowMs);
  const currentWeekStartMs = shanghaiDayStartMs(currentWeekKey);
  const currentWeekEndMs = currentWeekStartMs + 7 * DAY_MS;
  const prevWeek1Key = addShanghaiDays(currentWeekKey, -7);
  const prevWeek2Key = addShanghaiDays(currentWeekKey, -14);
  const prevWeek1EndMs = currentWeekStartMs;

  const curMonthDaysCount = daysInMonth(nowParts.year, nowParts.month);
  const prevYear = nowParts.month === 1 ? nowParts.year - 1 : nowParts.year;
  const prevMonth = nowParts.month === 1 ? 12 : nowParts.month - 1;
  const prevMonthDaysCount = daysInMonth(prevYear, prevMonth);

  const currentWeekDayKeys = Array.from({ length: 7 }, (_, i) =>
    addShanghaiDays(currentWeekKey, i),
  );
  const prevWeek1DayKeys = Array.from({ length: 7 }, (_, i) => addShanghaiDays(prevWeek1Key, i));
  const curMonthDayKeys = Array.from({ length: curMonthDaysCount }, (_, i) =>
    formatDayKey(nowParts.year, nowParts.month, i + 1),
  );
  const prevMonthDayKeys = Array.from({ length: prevMonthDaysCount }, (_, i) =>
    formatDayKey(prevYear, prevMonth, i + 1),
  );

  const metricsByUser = new Map<string, UserDailyMetrics>();
  for (const member of input.members) {
    metricsByUser.set(member.id, emptyMetrics());
  }

  for (const session of input.sessions) {
    const metrics = metricsByUser.get(session.userId);
    if (!metrics) continue;
    if (session.status === 'invalidated') continue;

    const startMs = session.checkInAt.getTime();
    const startParts = getShanghaiParts(startMs);
    const startDayKey = formatDayKey(startParts.year, startParts.month, startParts.day);

    let effectiveEndMs: number;
    let validDuration: number;

    if (session.status === 'completed') {
      const dur = session.durationSeconds ?? 0;
      if (dur <= 0 || dur >= MAX_VALID_SESSION_SECONDS) continue;
      validDuration = dur;
      effectiveEndMs = session.checkOutAt ? session.checkOutAt.getTime() : startMs + dur * 1000;
      metrics.recordedByWeek.set(
        session.weekKey,
        (metrics.recordedByWeek.get(session.weekKey) ?? 0) + dur,
      );
    } else {
      const elapsed = Math.max(0, Math.floor((nowMs - startMs) / 1000));
      if (elapsed >= MAX_VALID_SESSION_SECONDS) continue;
      validDuration = elapsed;
      effectiveEndMs = nowMs;
      if (session.weekKey === currentWeekKey) {
        metrics.activeCurrentWeekSeconds += elapsed;
      }
    }

    // 1. 早起鸟：上海时间 05:00 <= checkIn < 09:00
    if (startParts.hour >= 5 && startParts.hour < 9) {
      metrics.earlyBirdDays.add(startDayKey);
    }

    // 按上海自然日拆分区间，统计日时长、夜猫子（21:00 后仍在岗）与 00:00~09:00 耐通窗口
    const endDayKey = shanghaiDayKeyOfMs(effectiveEndMs);
    let cursorDayKey = startDayKey;
    let guard = 0;

    while (cursorDayKey <= endDayKey && guard < 3) {
      guard += 1;
      const dStartMs = shanghaiDayStartMs(cursorDayKey, 0);
      const dEndMs = dStartMs + DAY_MS;

      const segSec =
        effectiveEndMs > startMs
          ? overlapSeconds(startMs, effectiveEndMs, dStartMs, dEndMs)
          : cursorDayKey === startDayKey
            ? validDuration
            : 0;
      if (segSec > 0) {
        metrics.dailySeconds.set(cursorDayKey, (metrics.dailySeconds.get(cursorDayKey) ?? 0) + segSec);
      }

      const nightStartMs = dStartMs + 21 * 3_600_000;
      if (effectiveEndMs >= nightStartMs && startMs < dEndMs) {
        if (effectiveEndMs > nightStartMs || startMs >= nightStartMs) {
          metrics.nightOwlDays.add(cursorDayKey);
        }
      }

      const dawnEndMs = dStartMs + 9 * 3_600_000;
      const dawnSec = overlapSeconds(startMs, effectiveEndMs, dStartMs, dawnEndMs);
      if (dawnSec > 0) {
        metrics.overnightSeconds.set(
          cursorDayKey,
          (metrics.overnightSeconds.get(cursorDayKey) ?? 0) + dawnSec,
        );
      }

      cursorDayKey = addShanghaiDays(cursorDayKey, 1);
    }
  }

  // 每个年级每天的最高打卡秒数（打卡之星）
  const gradeDailyMax = new Map<string, number>();
  for (const member of input.members) {
    const metrics = metricsByUser.get(member.id)!;
    for (const [dKey, sec] of metrics.dailySeconds.entries()) {
      if (sec <= 0) continue;
      const gKey = `${member.enrollYear}:${dKey}`;
      const prev = gradeDailyMax.get(gKey) ?? 0;
      if (sec > prev) gradeDailyMax.set(gKey, sec);
    }
  }

  // 吕洞宾：本周 A 对 B 使用过正面卡，随后 B 对 A 使用过负面卡 -> A 解锁
  const luDongbinUsers = new Set<string>();
  const sortedInteractions = [...input.currentWeekCardInteractions].sort((a, b) => a.atMs - b.atMs);
  const earliestPositiveAt = new Map<string, number>();
  for (const evt of sortedInteractions) {
    if (evt.actorId === evt.targetId) continue;
    if (evt.polarity === 'positive') {
      const pairKey = `${evt.actorId}->${evt.targetId}`;
      if (!earliestPositiveAt.has(pairKey)) {
        earliestPositiveAt.set(pairKey, evt.atMs);
      }
    } else if (evt.polarity === 'negative') {
      const reversePairKey = `${evt.targetId}->${evt.actorId}`;
      const helpedAt = earliestPositiveAt.get(reversePairKey);
      if (helpedAt !== undefined && evt.atMs > helpedAt) {
        luDongbinUsers.add(evt.targetId);
      }
    }
  }

  const getWeekTotal = (userId: string, weekKey: string, includeActive = false): number => {
    const metrics = metricsByUser.get(userId)!;
    const recorded =
      (metrics.recordedByWeek.get(weekKey) ?? 0) +
      (includeActive && weekKey === currentWeekKey ? metrics.activeCurrentWeekSeconds : 0);
    const manual = input.manualAdjustmentsByUserWeek.get(`${userId}:${weekKey}`) ?? 0;
    const ent = input.entertainmentByUserWeek.get(`${userId}:${weekKey}`) ?? 0;
    return comprehensiveDurationSeconds(recorded, manual, ent);
  };

  const results = new Map<string, MemberTitleEvaluation>();
  const remainingWeekSeconds = Math.max(0, Math.floor((currentWeekEndMs - nowMs) / 1000));

  for (const member of input.members) {
    const metrics = metricsByUser.get(member.id)!;
    const goalSeconds = weeklyGoalSeconds(member.enrollYear);

    // 1. 打卡之星
    const topGradeDays = new Set<string>();
    for (const [dKey, sec] of metrics.dailySeconds.entries()) {
      if (sec <= 0) continue;
      const maxSec = gradeDailyMax.get(`${member.enrollYear}:${dKey}`) ?? 0;
      if (maxSec > 0 && sec >= maxSec) {
        topGradeDays.add(dKey);
      }
    }
    const punchStarRes = bestRecentConsecutiveStreak(topGradeDays, todayKey, 30, 6);

    // 2. 全勤之星
    const curWeekDaysOver1h = currentWeekDayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= ONE_HOUR_SECONDS,
    ).length;
    const prevWeekDaysOver1h = prevWeek1DayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= ONE_HOUR_SECONDS,
    ).length;
    const weeklyPerfectUnlocked = curWeekDaysOver1h >= 7 || prevWeekDaysOver1h >= 7;

    // 3. 全勤之王
    const curMonthDaysOver1h = curMonthDayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= ONE_HOUR_SECONDS,
    ).length;
    const prevMonthDaysOver1h = prevMonthDayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= ONE_HOUR_SECONDS,
    ).length;
    const monthlyPerfectUnlocked =
      curMonthDaysOver1h >= curMonthDaysCount || prevMonthDaysOver1h >= prevMonthDaysCount;

    // 4. 夜猫子
    const nightOwlRes = bestRecentConsecutiveStreak(metrics.nightOwlDays, todayKey, 30, 1);

    // 5. 早起鸟
    const earlyBirdRes = bestRecentConsecutiveStreak(metrics.earlyBirdDays, todayKey, 30, 1);

    // 6. 传奇耐通王
    const allNighterDays = new Set<string>();
    for (const [dKey, sec] of metrics.overnightSeconds.entries()) {
      if (sec >= FOUR_HOURS_SECONDS) {
        allNighterDays.add(dKey);
      }
    }
    const allNighterRes = bestRecentConsecutiveStreak(allNighterDays, todayKey, 30, 6);

    // 7. 卡点王
    const prev1Total = getWeekTotal(member.id, prevWeek1Key);
    const prev2Total = getWeekTotal(member.id, prevWeek2Key);
    const prev1Hit = prev1Total >= goalSeconds && prev1Total <= goalSeconds + ONE_HOUR_SECONDS;
    const prev2Hit = prev2Total >= goalSeconds && prev2Total <= goalSeconds + ONE_HOUR_SECONDS;
    const deadlineMasterUnlocked = prev1Hit && prev2Hit;

    // 8. 金将军
    const curWeekDaysOver5h = currentWeekDayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= FIVE_HOURS_SECONDS,
    ).length;
    const prevWeekDaysOver5h = prevWeek1DayKeys.filter(
      (d) => (metrics.dailySeconds.get(d) ?? 0) >= FIVE_HOURS_SECONDS,
    ).length;
    const generalJinUnlocked = curWeekDaysOver5h >= 7 || prevWeekDaysOver5h >= 7;

    // 9. 想吃紫蛋了
    const existedLastWeek = !member.createdAt || member.createdAt.getTime() < prevWeek1EndMs;
    const purpleEggActive = existedLastWeek && prev1Total < goalSeconds;

    // 10. 吕洞宾
    const luDongbinUnlocked = luDongbinUsers.has(member.id);

    // 11. 相思了
    const currentWeekTotal = getWeekTotal(member.id, currentWeekKey, true);
    const remainingGoalSeconds = Math.max(0, goalSeconds - currentWeekTotal);
    const pressureRatio =
      remainingGoalSeconds <= 0
        ? 0
        : remainingWeekSeconds <= 0
          ? 1
          : remainingGoalSeconds / remainingWeekSeconds;
    const lovesickActive = remainingGoalSeconds > 0 && pressureRatio >= 0.3;

    const statusById: Record<string, { unlocked: boolean; progressText?: string }> = {
      'punch-star': {
        unlocked: punchStarRes.qualified3,
        progressText: punchStarRes.qualified3
          ? '已达成连续 3 天年级榜首'
          : `当前连霸 ${Math.min(3, punchStarRes.currentStreak)}/3 天`,
      },
      'monthly-perfect': {
        unlocked: monthlyPerfectUnlocked,
        progressText: monthlyPerfectUnlocked
          ? '已达成整月全勤'
          : `本月已达标 ${curMonthDaysOver1h}/${curMonthDaysCount} 天`,
      },
      'general-jin': {
        unlocked: generalJinUnlocked,
        progressText: generalJinUnlocked
          ? '已达成整周每日 5 小时'
          : `本周 ${curWeekDaysOver5h}/7 天超过 5 小时`,
      },
      'legend-allnighter': {
        unlocked: allNighterRes.qualified3,
        progressText: allNighterRes.qualified3
          ? '已达成连续 3 天通宵战绩'
          : `当前连续 ${Math.min(3, allNighterRes.currentStreak)}/3 天`,
      },
      'weekly-perfect': {
        unlocked: weeklyPerfectUnlocked,
        progressText: weeklyPerfectUnlocked
          ? '已达成整周每日 1 小时'
          : `本周 ${curWeekDaysOver1h}/7 天超过 1 小时`,
      },
      'deadline-master': {
        unlocked: deadlineMasterUnlocked,
        progressText: deadlineMasterUnlocked
          ? '已连续 2 周精准压线'
          : prev1Hit
            ? '上周已压线（1/2 周）'
            : `目标区间 ${Math.round(goalSeconds / 3600)}–${Math.round(goalSeconds / 3600) + 1} 小时`,
      },
      'lu-dongbin': {
        unlocked: luDongbinUnlocked,
        progressText: luDongbinUnlocked ? '本周惨遭恩将仇报' : '本周尚未触发卡牌背刺事件',
      },
      'early-bird': {
        unlocked: earlyBirdRes.qualified3,
        progressText: earlyBirdRes.qualified3
          ? '已连续 3 天 9 点前打卡'
          : `当前连续 ${Math.min(3, earlyBirdRes.currentStreak)}/3 天`,
      },
      'night-owl': {
        unlocked: nightOwlRes.qualified3,
        progressText: nightOwlRes.qualified3
          ? '已连续 3 天 21 点后在岗'
          : `当前连续 ${Math.min(3, nightOwlRes.currentStreak)}/3 天`,
      },
      lovesick: {
        unlocked: lovesickActive,
        progressText:
          remainingGoalSeconds <= 0
            ? '本周已达标，毫无相思'
            : `当前欠账占比 ${Math.min(100, Math.round(pressureRatio * 100))}%（≥ 30% 触发）`,
      },
      'purple-egg': {
        unlocked: purpleEggActive,
        progressText: purpleEggActive
          ? `上周完成 ${(prev1Total / 3600).toFixed(1)}h / ${Math.round(goalSeconds / 3600)}h`
          : existedLastWeek
            ? '上周已顺利达标'
            : '新成员首周免挂紫蛋',
      },
    };

    const unlockedNonForced = TITLE_CATALOG.filter(
      (def) => !def.forced && statusById[def.id]?.unlocked,
    ).sort((a, b) => b.priority - a.priority);

    const requestedEquip = member.equippedTitleId ?? null;
    const validEquipped = requestedEquip
      ? unlockedNonForced.find((def) => def.id === requestedEquip) ?? null
      : null;
    const activePrimary = validEquipped ?? unlockedNonForced[0] ?? null;

    const activeForced = TITLE_CATALOG.filter(
      (def) => def.forced && statusById[def.id]?.unlocked,
    ).sort((a, b) => b.priority - a.priority);

    const displayTitles: MemberTitleBadge[] = [
      ...(activePrimary ? [toMemberTitleBadge(activePrimary)] : []),
      ...activeForced.map(toMemberTitleBadge),
    ];

    const catalog: TitleEvaluationItem[] = TITLE_CATALOG.map((def) => {
      const st = statusById[def.id] ?? { unlocked: false };
      return {
        ...toMemberTitleBadge(def),
        unlocked: st.unlocked,
        equipped: Boolean(
          (activePrimary && activePrimary.id === def.id) || (def.forced && st.unlocked),
        ),
        progressText: st.progressText,
      };
    });

    results.set(member.id, {
      equippedTitleId: validEquipped?.id ?? null,
      displayTitles,
      catalog,
    });
  }

  return results;
}
