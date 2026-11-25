import { describe, expect, it } from 'bun:test';
import { hasFeverOverlap } from '../src/modules/punch/punch-points.service.js';
import {
  assessmentEnrollYears,
  comprehensiveDurationSeconds,
  mondayKeyToIsoWeek,
  parseIsoWeekToMondayKey,
  signMemberKey,
  verifyMemberKey,
  weeklyGoalSeconds,
} from '../src/modules/punch/punch-shared.util.js';
import { CARD_CATALOG } from '../src/modules/punch/punch-cards.service.js';
import { TITLE_CATALOG } from '../src/modules/punch/punch-titles.service.js';

describe('LecPunch 融合模块核心规则与狂热时段判定', () => {
  it('狂热打卡扫描线：同时在岗达 8 人且重叠 >=1ms 触发狂热，7 人或零重叠不触发', () => {
    const start = new Date(0);
    const end = new Date(660_000);
    const buildRows = (count: number, overlapMs: number) => [
      { checkInAt: start, checkOutAt: end },
      ...Array.from({ length: count - 1 }, () => ({
        checkInAt: start,
        checkOutAt: new Date(1000),
      })),
      { checkInAt: new Date(1000 - overlapMs), checkOutAt: end },
    ];

    // 7 个早期成员 + 1 个新成员重叠 1ms => 共 8 人同时在岗 -> 狂热生效
    expect(hasFeverOverlap({ start, end }, buildRows(7, 1))).toBe(true);
    // 仅 6 + 1 = 7 人 -> 不触发
    expect(hasFeverOverlap({ start, end }, buildRows(6, 1))).toBe(false);
    // 7 个在 1000ms 签退，第 8 个恰好 1000ms 上卡（0ms 重叠）-> 不触发
    expect(hasFeverOverlap({ start, end }, buildRows(7, 0))).toBe(false);
  });

  it('综合时长、周目标与近两届考核年级判定准确', () => {
    expect(weeklyGoalSeconds(2025)).toBe(28 * 3600);
    expect(weeklyGoalSeconds(2024)).toBe(38 * 3600);
    expect(comprehensiveDurationSeconds(3600, 600, -1800)).toBe(2400);
    expect(() => comprehensiveDurationSeconds(-1, 0, 0)).toThrow();
    expect(assessmentEnrollYears([2023, 2024, 2025])).toEqual([2025, 2024]);
  });

  it('ISO 周与周一日期互相转换一致，memberKey 签名防篡改', () => {
    expect(parseIsoWeekToMondayKey('2026-W48')).toBe('2026-11-23');
    expect(mondayKeyToIsoWeek('2026-11-23')).toBe('2026-W48');

    const key = signMemberKey('6a0000000000000000000011', 'test-secret');
    expect(verifyMemberKey(key, 'test-secret')).toBe('6a0000000000000000000011');
    expect(verifyMemberKey(key + 'x', 'test-secret')).toBeNull();
  });

  it('卡池（21 张）与称号目录（11 项）定义完整无重复 ID', () => {
    expect(CARD_CATALOG).toHaveLength(21);
    expect(new Set(CARD_CATALOG.map((c) => c.id)).size).toBe(21);
    expect(TITLE_CATALOG).toHaveLength(11);
    expect(new Set(TITLE_CATALOG.map((t) => t.id)).size).toBe(11);
  });
});
