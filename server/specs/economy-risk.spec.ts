import { describe, expect, it } from 'bun:test';
import {
  generateAppSecret,
  openAppSecret,
  sealAppSecret,
} from '../src/common/utils/crypto-secret.js';
import { getShanghaiDayBounds, getShanghaiWeekKey } from '../src/common/utils/week-key.js';
import {
  assertZeroSumInvariant,
  computeBurnAndNetPayout,
  evaluateParticipantRisk,
} from '../src/modules/economy/economy.types.js';

describe('Economy 底层零和守恒、防刷风控、考核周与密钥加密', () => {
  it('零和守恒校验严禁任何凭空增发', () => {
    expect(() =>
      assertZeroSumInvariant([
        { userId: 'winner', delta: 30 },
        { userId: 'loser', delta: -30 },
      ]),
    ).not.toThrow();

    // 开启 2% 燃烧税：50 * 200 / 10000 = 1，胜者净得 49，输家 -50，净和 -1
    const payout = computeBurnAndNetPayout('coin', 50, 200);
    expect(payout).toEqual({ netWin: 49, burnAmount: 1 });
    expect(() =>
      assertZeroSumInvariant(
        [
          { userId: 'winner', delta: payout.netWin },
          { userId: 'loser', delta: -50 },
        ],
        payout.burnAmount,
      ),
    ).not.toThrow();

    // 企图凭空多发 1 币必须抛错
    expect(() =>
      assertZeroSumInvariant([
        { userId: 'winner', delta: 31 },
        { userId: 'loser', delta: -30 },
      ]),
    ).toThrow('零和守恒校验失败');

    // punch_minutes 永远不收燃烧税
    expect(computeBurnAndNetPayout('punch_minutes', 30, 500)).toEqual({
      netWin: 30,
      burnAmount: 0,
    });
  });

  it('防刷风控：拦住超单笔、超并发、超同对手频次、超日限额与未达打卡门槛', () => {
    // 1. 合法 coin 对局
    expect(
      evaluateParticipantRisk({
        asset: 'coin',
        amount: 30,
        maxPerOrder: 50,
        activeOrdersCount: 1,
        maxActiveOrders: 3,
        dailyCoinAbsVolume: 100,
        dailyCoinNetLimit: 200,
        weeklyCoinGain: 100,
        weeklyCoinGainLimit: 500,
        sameOpponentCount: 2,
        sameOpponentLimit: 5,
      }).ok,
    ).toBe(true);

    // 2. 超过今日 coin 交易限额
    expect(
      evaluateParticipantRisk({
        asset: 'coin',
        amount: 50,
        maxPerOrder: 50,
        activeOrdersCount: 0,
        maxActiveOrders: 3,
        dailyCoinAbsVolume: 180,
        dailyCoinNetLimit: 200,
      }).ok,
    ).toBe(false);

    // 3. punch_minutes 未达真实打卡门槛（防零打卡小号）
    const lowRecorded = evaluateParticipantRisk({
      asset: 'punch_minutes',
      amount: 20,
      maxPerOrder: 30,
      activeOrdersCount: 0,
      maxActiveOrders: 3,
      weeklyRecordedMinutes: 30,
      minRecordedMinutes: 60,
      weeklyPunchNetMinutes: 0,
      weeklyPunchGainLimit: 60,
      weeklyPunchLossLimit: 60,
    });
    expect(lowRecorded.ok).toBe(false);

    // 4. punch_minutes 若赢会超每周 +60 分钟净赢硬上限（防卷王送时间刷周考核）
    const exceedGain = evaluateParticipantRisk({
      asset: 'punch_minutes',
      amount: 30,
      maxPerOrder: 30,
      activeOrdersCount: 0,
      maxActiveOrders: 3,
      weeklyRecordedMinutes: 300,
      minRecordedMinutes: 60,
      weeklyPunchNetMinutes: 40,
      weeklyPunchGainLimit: 60,
      weeklyPunchLossLimit: 60,
    });
    expect(exceedGain.ok).toBe(false);

    // 5. punch_minutes 同对手每周限次 2 局
    const exceedOpp = evaluateParticipantRisk({
      asset: 'punch_minutes',
      amount: 20,
      maxPerOrder: 30,
      activeOrdersCount: 0,
      maxActiveOrders: 3,
      weeklyRecordedMinutes: 300,
      minRecordedMinutes: 60,
      weeklyPunchNetMinutes: 0,
      weeklyPunchGainLimit: 60,
      weeklyPunchLossLimit: 60,
      sameOpponentCount: 2,
      sameOpponentLimit: 2,
    });
    expect(exceedOpp.ok).toBe(false);
  });

  it('应用密钥 AES-256-GCM 静态加密与解密还原一致', () => {
    const { plain, prefix } = generateAppSecret();
    expect(plain.startsWith('lec_app_')).toBe(true);
    expect(prefix).toBe(plain.slice(0, 14));

    const masterKey = 'super-strong-master-key-for-orbit';
    const sealed = sealAppSecret(plain, masterKey);
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(sealed).not.toContain(plain);
    expect(openAppSecret(sealed, masterKey)).toBe(plain);
  });

  it('东八区考核周 weekKey 计算准确（周日归属本周，周一零点切换新周）', () => {
    // 2026-11-29 23:30 UTC+8（周日）= 2026-11-29T15:30:00Z -> 周一 2026-11-23
    expect(getShanghaiWeekKey(new Date('2026-11-29T15:30:00Z'))).toBe('2026-11-23');
    // 2026-11-30 00:05 UTC+8（周一）= 2026-11-29T16:05:00Z -> 周一 2026-11-30
    expect(getShanghaiWeekKey(new Date('2026-11-29T16:05:00Z'))).toBe('2026-11-30');

    const day = getShanghaiDayBounds(new Date('2026-11-25T13:00:00Z'));
    expect(day.dayKey).toBe('2026-11-25');
    expect(day.endUtc.getTime() - day.startUtc.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
