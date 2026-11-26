/**
 * LecPunch 核心领域共享常量、错误码与综合时长/考核周工具。
 * 与原 @lecpunch/shared 保持 100% 数值与契约一致。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';

export const ATTENDANCE_MAX_SECONDS = 5 * 60 * 60; // 18000s (5小时)
export const WARNING_THRESHOLD_SECONDS = ATTENDANCE_MAX_SECONDS - 15 * 60; // 17100s
export const ATTENDANCE_KEEPALIVE_INTERVAL_SECONDS = 30;
export const ATTENDANCE_KEEPALIVE_TIMEOUT_SECONDS = 180;
export const FEVER_ACTIVE_THRESHOLD = 8; // 同团队同时在岗达 8 人进入狂热打卡时段（签退 +10%）

export const PUNCH_ERROR_CODES = {
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  AUTH_REGISTRATION_NOT_ELIGIBLE: 'AUTH_REGISTRATION_NOT_ELIGIBLE',
  AUTH_REGISTRATION_REALNAME_MISMATCH: 'AUTH_REGISTRATION_REALNAME_MISMATCH',
  AUTH_REGISTRATION_STUDENT_ID_BLOCKED: 'AUTH_REGISTRATION_STUDENT_ID_BLOCKED',
  USER_DISABLED: 'USER_DISABLED',
  ATTENDANCE_ALREADY_CHECKED_IN: 'ATTENDANCE_ALREADY_CHECKED_IN',
  ATTENDANCE_NO_ACTIVE_SESSION: 'ATTENDANCE_NO_ACTIVE_SESSION',
  ATTENDANCE_NETWORK_NOT_ALLOWED: 'ATTENDANCE_NETWORK_NOT_ALLOWED',
  ATTENDANCE_SESSION_INVALIDATED: 'ATTENDANCE_SESSION_INVALIDATED',
  ATTENDANCE_CROSS_TEAM_FORBIDDEN: 'ATTENDANCE_CROSS_TEAM_FORBIDDEN',
} as const;

/** 生成与原 MongoDB ObjectId 兼容的 24 位十六进制 ID，便于历史数据零改写平滑共存。 */
export function newObjectIdHex(): string {
  return randomBytes(12).toString('hex');
}

/** 根据入学年份返回每周打卡目标秒数（2025 级起 28h，其余 38h）。 */
export function weeklyGoalSeconds(enrollYear: number): number {
  return enrollYear >= 2025 ? 28 * 3600 : 38 * 3600;
}

/** 校验入学年份合理性（支持按指定参考年份判定历史考核周）。 */
export function isValidEnrollmentYear(value: unknown, referenceYear?: number): value is number {
  const refYear =
    referenceYear ??
    Number(
      new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(
        new Date(),
      ),
    );
  return typeof value === 'number' && Number.isInteger(value) && value >= 2000 && value <= refYear + 1;
}

/** 计算综合时长（秒）：真实打卡 + 管理员调时 + 娱乐/交易增减时长。 */
export function comprehensiveDurationSeconds(
  recorded: number,
  manual = 0,
  entertainment = 0,
): number {
  if (![recorded, manual, entertainment].every(Number.isSafeInteger) || recorded < 0) {
    throw new Error('无效的周时长参数');
  }
  const total = recorded + manual + entertainment;
  if (!Number.isSafeInteger(total)) {
    throw new Error('周时长数值溢出');
  }
  return total;
}

/** 计算参与周考核的近两届入学年份（结合已持久化历史高水位，避免成员退出导致回退）。 */
export function assessmentEnrollYears(
  enrollYears: readonly (number | null | undefined)[],
  previous: readonly number[] = [],
  referenceYear?: number,
): number[] {
  const valid = [...enrollYears, ...previous].filter((y): y is number =>
    isValidEnrollmentYear(y, referenceYear),
  );
  if (valid.length === 0) return [];
  const latest = Math.max(...valid);
  return [latest, latest - 1];
}

/** 判断指定年级是否属于当周必考年级。 */
export function requiresWeeklyAssessment(
  enrollYear: number,
  requiredYears: readonly number[],
): boolean {
  return Number.isInteger(enrollYear) && requiredYears.includes(enrollYear);
}

/** 将 ISO 周标识（如 2026-W47）解析为周一日期 YYYY-MM-DD；若本身已是 YYYY-MM-DD 则直接校验返回。 */
export function parseIsoWeekToMondayKey(rawWeek?: string): string | null {
  if (!rawWeek || !rawWeek.trim()) {
    return getShanghaiWeekKey(new Date());
  }
  const s = rawWeek.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }
  const m = /^(\d{4})-W(\d{2})$/i.exec(s);
  if (!m) return null;
  const year = Number.parseInt(m[1], 10);
  const week = Number.parseInt(m[2], 10);
  if (week < 1 || week > 53) return null;
  // ISO 8601 第 1 周必包含 1 月 4 日
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // 1=周一 .. 7=周日
  const mondayMs = jan4.getTime() + ((week - 1) * 7 - (jan4Dow - 1)) * 86_400_000;
  const monday = new Date(mondayMs);
  const yyyy = monday.getUTCFullYear();
  const mm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 将周一日期 YYYY-MM-DD 转为 ISO 周字符串 YYYY-Www。 */
export function mondayKeyToIsoWeek(mondayKey: string): string {
  const [y, m, d] = mondayKey.split('-').map((n) => Number.parseInt(n, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  const thursday = new Date(date.getTime() + 3 * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const weekNum = Math.ceil(((thursday.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}

/** 为成员内部 userId 生成签名 memberKey（兼容 LecPunch 排行榜/个人详情隐私脱敏契约）。 */
export function signMemberKey(userId: string, secret: string): string {
  const key = secret || 'lec-punch-member-key-default';
  const sig = createHmac('sha256', key).update(userId).digest('base64url').slice(0, 16);
  return `${userId}.${sig}`;
}

/** 校验并解包签名 memberKey（同时兼容直接传 userId 以便内部/测试调用）。 */
export function verifyMemberKey(memberKey: string, secret: string): string | null {
  const trimmed = memberKey.trim();
  if (!trimmed) return null;
  const dot = trimmed.indexOf('.');
  if (dot < 0) return trimmed;
  const userId = trimmed.slice(0, dot);
  const expected = signMemberKey(userId, secret);
  return expected === trimmed ? userId : null;
}
