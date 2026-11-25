/**
 * 考核周标识（weekKey）与自然日标识计算：
 * 统一以 Asia/Shanghai（UTC+8）为基准，返回所在 ISO 周一日期 YYYY-MM-DD，
 * 与 LecPunch 考核周口径严格一致。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function toShanghaiDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number; // 0=周日, 1=周一 ... 6=周六
} {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    dayOfWeek: shifted.getUTCDay(),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 计算给定时间在东八区所属自然周的周一日期（格式 YYYY-MM-DD）。 */
export function getShanghaiWeekKey(date: Date = new Date()): string {
  const { year, month, day, dayOfWeek } = toShanghaiDateParts(date);
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const mondayUtc = new Date(Date.UTC(year, month - 1, day + diffToMonday));
  return `${mondayUtc.getUTCFullYear()}-${pad2(mondayUtc.getUTCMonth() + 1)}-${pad2(mondayUtc.getUTCDate())}`;
}

/** 计算给定时间在东八区所属自然日（格式 YYYY-MM-DD），返回该日 UTC 起止时间区间。 */
export function getShanghaiDayBounds(date: Date = new Date()): {
  dayKey: string;
  startUtc: Date;
  endUtc: Date;
} {
  const { year, month, day } = toShanghaiDateParts(date);
  const startUtc = new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return {
    dayKey: `${year}-${pad2(month)}-${pad2(day)}`,
    startUtc,
    endUtc,
  };
}
