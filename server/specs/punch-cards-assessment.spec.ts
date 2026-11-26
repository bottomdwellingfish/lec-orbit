import { describe, expect, it } from 'bun:test';
import {
  advanceGameState,
  applyGameAction,
  CARD_CATALOG,
  CARD_PITY_LIMITS,
  COIN_COST_PER_DRAW,
  createGameState,
  getPlayerWeek,
  WEEKLY_MAX_PAID_DRAWS,
  type GameContext,
} from '../src/modules/punch/punch-card-engine.js';
import {
  ASSESSMENT_SETTLEMENT_DELAY_MS,
  createAssessmentWeek,
  finalizeAssessmentWeek,
  observeAssessmentWeek,
  parseMondayWeekBounds,
  validateAssessmentStartWeek,
} from '../src/modules/punch/punch-assessment-engine.js';

const PLAYERS = [
  { id: 'u1', username: 'alice', name: 'Alice', enrollYear: 2025 },
  { id: 'u2', username: 'bob', name: 'Bob', enrollYear: 2025 },
  { id: 'u3', username: 'carol', name: 'Carol', enrollYear: 2025 },
  { id: 'u4', username: 'dave', name: 'Dave', enrollYear: 2024 },
];

function makeCtx(overrides: Partial<GameContext> = {}): GameContext {
  return {
    week: '2026-11-23',
    now: Date.parse('2026-11-26T10:00:00+08:00'),
    players: PLAYERS,
    baseSeconds: { u1: 36_000, u2: 36_000, u3: 36_000, u4: 36_000 },
    actorCoinBalance: 500,
    random: () => 0.1,
    assessmentYears: [2025, 2024],
    ...overrides,
  };
}

describe('卡牌工坊 21 张卡完整引擎（对接新版 coin 乐币）', () => {
  it('免费 2 抽 + 赠礼抽优先，之后按 6 乐币/抽计费且校验余额与周上限 20 抽', () => {
    const state = createGameState();
    const w = getPlayerWeek(state, 'u1', '2026-11-23');
    w.bonusDraws = 1;

    // 10 连抽：消耗 2 免费 + 1 赠礼 + 7 付费 = 42 乐币
    const res = applyGameAction(
      state,
      'u1',
      { action: 'draw', count: 10 },
      makeCtx({ actorCoinBalance: 42 }),
    );
    expect(res.gainedCardIds).toHaveLength(10);
    expect(res.paidDraws).toBe(7);
    expect(res.spentCoins).toBe(7 * COIN_COST_PER_DRAW);
    const updatedW = state.members.u1.weeks['2026-11-23'];
    expect(updatedW.freeUsed).toBe(2);
    expect(updatedW.bonusDraws).toBe(0);
    expect(updatedW.paidDrawsUsed).toBe(7);

    // 余额不足拦截且不扣次数
    expect(() =>
      applyGameAction(state, 'u1', { action: 'draw', count: 1 }, makeCtx({ actorCoinBalance: 5 })),
    ).toThrow('可用乐币不足');
    expect(state.members.u1.weeks['2026-11-23'].paidDrawsUsed).toBe(7);

    // 超过每周付费上限 20 抽拦截
    state.members.u1.weeks['2026-11-23'].paidDrawsUsed = WEEKLY_MAX_PAID_DRAWS;
    expect(() =>
      applyGameAction(state, 'u1', { action: 'draw', count: 1 }, makeCtx({ actorCoinBalance: 100 })),
    ).toThrow('本周付费抽卡已达上限');
  });

  it('覆盖其余全部攻击/随机/赠送卡牌（减时长、赌枪、问号、神偷奶爸、天使、雷电、南蛮入侵、万箭穿心、赠卡）', () => {
    const state = createGameState();
    const week = '2026-11-23';
    for (const id of ['u1', 'u2', 'u3']) getPlayerWeek(state, id, week);

    // 1. 赠卡（同年级 & 跨年级均允许，禁止赠送给自己）
    state.members.u1.inventory['r-add'] = 2;
    applyGameAction(state, 'u1', { action: 'gift', cardId: 'r-add', targetId: 'u2' }, makeCtx());
    expect(state.members.u1.inventory['r-add']).toBe(1);
    expect(state.members.u2.inventory['r-add']).toBe(1);
    expect(state.members.u2.discovered).toContain('r-add');

    // 跨年级赠卡（2025 级 u1 -> 2024 级 u4）
    applyGameAction(state, 'u1', { action: 'gift', cardId: 'r-add', targetId: 'u4' }, makeCtx());
    expect(state.members.u1.inventory['r-add']).toBe(0);
    expect(state.members.u4.inventory['r-add']).toBe(1);
    expect(state.members.u4.discovered).toContain('r-add');

    // 禁止赠送给自己
    state.members.u1.inventory['r-add'] = 1;
    expect(() =>
      applyGameAction(state, 'u1', { action: 'gift', cardId: 'r-add', targetId: 'u1' }, makeCtx()),
    ).toThrow('请选择团队中的其他有效成员');
    state.members.u1.inventory['r-add'] = 0;

    // 2. 问号卡随机换卡（绝不抽出 r-mystery 自身）
    state.members.u1.inventory['r-mystery'] = 1;
    const mysRes = applyGameAction(state, 'u1', { action: 'use', cardId: 'r-mystery' }, makeCtx({ random: () => 0.91 }));
    expect(mysRes.gainedCardId).toBeDefined();
    expect(mysRes.gainedCardId).not.toBe('r-mystery');

    // 3. 减时长（随机选同年级其他玩家扣 30min）与仁王盾挡 N 级
    state.members.u1.inventory['n-reduce'] = 1;
    state.members.u2.inventory['n-shield'] = 1;
    const redRes = applyGameAction(state, 'u1', { action: 'use', cardId: 'n-reduce' }, makeCtx({ random: () => 0 }));
    expect(redRes.defenses?.[0]?.defenseCardId).toBe('n-shield');

    // 4. 赌枪（random >= 0.5 幸运 +30min）
    state.members.u1.inventory['n-gamble'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'n-gamble' }, makeCtx({ random: () => 0.8 }));
    expect(state.members.u1.weeks[week].entertainmentSeconds).toBe(1800);

    // 5. 神偷奶爸（从随机他人偷 30min 给指定接收方）
    state.members.u1.inventory['r-thief'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'r-thief', targetId: 'u2' }, makeCtx({ random: () => 0 }));
    expect(state.members.u2.weeks[week].entertainmentSeconds).toBe(1800);
    expect(state.members.u3.weeks[week].entertainmentSeconds).toBe(-1800);

    // 6. 天使卡（同年级全员 +30min）
    state.members.u1.inventory['sr-angel'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'sr-angel' }, makeCtx());
    expect(state.members.u1.weeks[week].entertainmentSeconds).toBe(3600);
    expect(state.members.u2.weeks[week].entertainmentSeconds).toBe(3600);
    expect(state.members.u3.weeks[week].entertainmentSeconds).toBe(0);

    // 7. 雷电（按用户名顺序首个命中扣 60min 并停止）
    state.members.u1.inventory['sr-lightning'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'sr-lightning' }, makeCtx({ random: () => 0.2 }));
    expect(state.members.u2.weeks[week].entertainmentSeconds).toBe(0);
    expect(state.members.u3.weeks[week].entertainmentSeconds).toBe(0);

    // 8. 南蛮入侵（有 N 卡随机弃 1 张，无 N 卡扣 15min）
    state.members.u1.inventory['sr-invasion'] = 1;
    state.members.u2.inventory['n-gamble'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'sr-invasion' }, makeCtx());
    expect(state.members.u2.inventory['n-gamble']).toBe(0);
    expect(state.members.u2.weeks[week].entertainmentSeconds).toBe(0);
    expect(state.members.u3.weeks[week].entertainmentSeconds).toBe(-900);

    // 9. 万箭穿心（群体扣 10% 上限 15min，指定目标额外扣损失总额一半）
    state.members.u1.inventory['ssr-arrows'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'ssr-arrows', targetId: 'u2' }, makeCtx());
    // u2 和 u3 各扣 900s，合计 1800s，指定目标 u2 再扣 900s -> u2 共 -1800s，u3 共 -1800s
    expect(state.members.u2.weeks[week].entertainmentSeconds).toBe(-1800);
    expect(state.members.u3.weeks[week].entertainmentSeconds).toBe(-1800);
  });

  it('SR 30 抽硬保底与 SSR 70 抽硬保底 + 十连辉光升级精确生效', () => {
    const state = createGameState();
    getPlayerWeek(state, 'u1', '2026-11-23');
    state.members.u1.pitySR = CARD_PITY_LIMITS.sr - 1;
    // random 始终给 0（通常落 N 权重），应被 SR 硬保底拉起为 SR
    const srRes = applyGameAction(state, 'u1', { action: 'draw', count: 1 }, makeCtx({ random: () => 0 }));
    const srCard = CARD_CATALOG.find((c) => c.id === srRes.gainedCardId)!;
    expect(srCard.rarity).toBe('SR');
    expect(state.members.u1.pitySR).toBe(0);

    // SSR 硬保底 + 十连触发辉光（random < 0.3）
    state.members.u1.pitySSR = CARD_PITY_LIMITS.ssr - 1;
    const radRes = applyGameAction(
      state,
      'u1',
      { action: 'draw', count: 10 },
      makeCtx({ random: () => 0.05 }),
    );
    expect(radRes.drawAnimation).toBe('radiance');
    expect(radRes.radianceCount).toBe(1);
    const ssrCount = radRes.gainedCardIds!.filter(
      (id) => CARD_CATALOG.find((c) => c.id === id)?.rarity === 'SSR',
    ).length;
    expect(ssrCount).toBeGreaterThanOrEqual(2);
  });

  it('仁王盾 / 名刀司命 / 反弹 / 无懈可击 24h 跨周保护与铁索连环传导完整生效', () => {
    const state = createGameState();
    const week = '2026-11-23';
    for (const id of ['u1', 'u2', 'u3']) getPlayerWeek(state, id, week);

    // 1. 铁索连环绑定 u2 & u3，随后 u1 对 u2 用加时卡，u2 与 u3 同步 +1800s，且连环触发后解除
    state.members.u1.inventory['sr-chain'] = 1;
    state.members.u1.inventory['r-add'] = 2;
    applyGameAction(
      state,
      'u1',
      { action: 'use', cardId: 'sr-chain', targetId: 'u2', secondTargetId: 'u3' },
      makeCtx(),
    );
    expect(state.links).toHaveLength(1);
    applyGameAction(state, 'u1', { action: 'use', cardId: 'r-add', targetId: 'u2' }, makeCtx());
    expect(state.members.u2.weeks[week].entertainmentSeconds).toBe(1800);
    expect(state.members.u3.weeks[week].entertainmentSeconds).toBe(1800);
    expect(state.links).toHaveLength(0);

    // 2. 反弹：u1 对 u2 用红桃 K，u2 持 sr-reflect 自动反弹扣 u1 1800s
    state.members.u1.inventory['sr-redking'] = 1;
    state.members.u2.inventory['sr-reflect'] = 1;
    const refRes = applyGameAction(
      state,
      'u1',
      { action: 'use', cardId: 'sr-redking', targetId: 'u2' },
      makeCtx(),
    );
    expect(refRes.defenses?.[0]?.outcome).toBe('reflected');
    expect(state.members.u1.weeks[week].entertainmentSeconds).toBe(-1800);
    expect(state.members.u2.weeks[week].entertainmentSeconds).toBe(1800);

    // 3. 名刀司命挡顺手牵羊（R 级）
    state.members.u1.inventory['r-steal'] = 1;
    state.members.u2.inventory['r-blade'] = 1;
    const bladeRes = applyGameAction(
      state,
      'u1',
      { action: 'use', cardId: 'r-steal', targetId: 'u2' },
      makeCtx(),
    );
    expect(bladeRes.defenses?.[0]?.defenseCardId).toBe('r-blade');
    expect(state.members.u2.weeks[week].entertainmentSeconds).toBe(1800);

    // 4. 无懈可击 24h 免疫跨周延续
    const sundayNight = Date.parse('2026-11-29T22:00:00+08:00');
    const mondayMorning = Date.parse('2026-11-30T09:00:00+08:00');
    state.members.u2.inventory['ssr-invincible'] = 1;
    applyGameAction(
      state,
      'u2',
      { action: 'use', cardId: 'ssr-invincible' },
      makeCtx({ now: sundayNight }),
    );
    advanceGameState(state, makeCtx({ week: '2026-11-30', now: mondayMorning }));
    expect(state.members.u2.weeks['2026-11-30'].immuneUntil).toBe(sundayNight + 24 * 3_600_000);
  });

  it('加速卡下次有效签退自动结算 +15%（上限 30min），并覆盖控制卡与群体卡', () => {
    const state = createGameState();
    const week = '2026-11-23';
    for (const id of ['u1', 'u2', 'u3', 'u4']) getPlayerWeek(state, id, week);

    const t0 = Date.parse('2026-11-26T10:00:00+08:00');
    state.members.u1.inventory['n-acceleration'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'n-acceleration' }, makeCtx({ now: t0 }));
    expect(state.members.u1.weeks[week].accelerationAt).toBe(t0);

    // 签退一条 4 小时（14400s）有效打卡 -> 15% = 2160s，封顶 1800s
    advanceGameState(
      state,
      makeCtx({
        now: t0 + 15_000_000,
        sessions: [
          {
            id: 's1',
            userId: 'u1',
            weekKey: week,
            checkOutAt: t0 + 14_400_000,
            durationSeconds: 14_400,
          },
        ],
      }),
    );
    expect(state.members.u1.weeks[week].accelerationAt).toBeUndefined();
    expect(state.members.u1.weeks[week].entertainmentSeconds).toBe(1800);

    // 乐不思蜀禁止目标 1h 主动用卡；兵粮寸断禁止目标 3h 抽卡与收赠卡
    state.members.u1.inventory['r-skip'] = 1;
    state.members.u1.inventory['sr-famine'] = 1;
    state.members.u2.inventory['r-add'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'r-skip', targetId: 'u2' }, makeCtx({ now: t0 }));
    expect(() =>
      applyGameAction(state, 'u2', { action: 'use', cardId: 'r-add', targetId: 'u2' }, makeCtx({ now: t0 + 1000 })),
    ).toThrow('乐不思蜀期间不能主动使用卡牌');

    applyGameAction(state, 'u1', { action: 'use', cardId: 'sr-famine', targetId: 'u3' }, makeCtx({ now: t0 }));
    expect(() =>
      applyGameAction(state, 'u3', { action: 'draw', count: 1 }, makeCtx({ now: t0 + 1000 })),
    ).toThrow('兵粮寸断期间不能获得新卡');

    // 五谷丰登（同年级全员 +2 抽）+ 慈善家（应考跨年级分摊 10%）
    state.members.u1.inventory['ssr-harvest'] = 1;
    state.members.u1.inventory['r-charity'] = 1;
    applyGameAction(state, 'u1', { action: 'use', cardId: 'ssr-harvest' }, makeCtx({ now: t0 }));
    expect(state.members.u1.weeks[week].bonusDraws).toBe(2);
    expect(state.members.u2.weeks[week].bonusDraws).toBe(2);
    expect(state.members.u4.weeks[week].bonusDraws).toBe(0); // 2024 级不同年级

    applyGameAction(state, 'u1', { action: 'use', cardId: 'r-charity' }, makeCtx({ now: t0 }));
    // u4 属于 2024 应考届，应该收到慈善家分摊
    expect(state.members.u4.weeks[week].entertainmentSeconds).toBeGreaterThan(0);
  });
});

describe('周考核自动观测与跨周结算引擎（60 秒定时任务核心逻辑）', () => {
  it('严格校验起算周必须为北京时间周一', () => {
    expect(validateAssessmentStartWeek('')).toEqual({ startWeek: null, enabledAt: null });
    expect(validateAssessmentStartWeek('2026-10-26').startWeek).toBe('2026-10-26');
    expect(() => validateAssessmentStartWeek('2026-10-27')).toThrow('周一');
  });

  it('完整覆盖开周观测、新成员/停用/非应考届豁免、5 小时延迟结算与防断档误判', () => {
    const weekKey = '2026-11-16';
    const { startsAt, endsAt } = parseMondayWeekBounds(weekKey);
    const enabledAt = parseMondayWeekBounds('2026-10-26').startsAt;
    const oldJoin = startsAt - 10 * 86_400_000;

    const members = [
      { userId: 'pass', enrollYear: 2025, goalSeconds: 28 * 3600, createdAt: oldJoin, joinedAt: oldJoin, status: 'active' as const },
      { userId: 'fail', enrollYear: 2025, goalSeconds: 28 * 3600, createdAt: oldJoin, joinedAt: oldJoin, status: 'active' as const },
      { userId: 'newbie', enrollYear: 2025, goalSeconds: 28 * 3600, createdAt: startsAt + 3600_000, joinedAt: startsAt + 3600_000, status: 'active' as const },
      { userId: 'senior', enrollYear: 2022, goalSeconds: 38 * 3600, createdAt: oldJoin, joinedAt: oldJoin, status: 'active' as const },
      { userId: 'disabled', enrollYear: 2024, goalSeconds: 38 * 3600, createdAt: oldJoin, joinedAt: oldJoin, status: 'disabled' as const },
    ];

    let state = createAssessmentWeek(weekKey, startsAt + 60_000, members, enabledAt, [2025, 2024, 2023]);
    expect(state.coverageTrusted).toBe(true);

    // 模拟周内持续观测至周结束（步长 4 分钟 <= 5 分钟间隔）
    for (let ts = startsAt + 4 * 60_000; ts <= endsAt; ts += 4 * 60_000) {
      state = observeAssessmentWeek(state, ts, members, [2025, 2024, 2023]);
    }
    state = observeAssessmentWeek(state, endsAt, members, [2025, 2024, 2023]);
    expect(state.coverageTrusted).toBe(true);

    // 未满 5 小时保持 pending
    const early = finalizeAssessmentWeek(state, endsAt + 3_600_000, {});
    expect(early.outcomes.pass.status).toBe('pending');
    expect(early.outcomes.pass.reason).toBe('settlement_window');

    // 满 5 小时后结算
    const settled = finalizeAssessmentWeek(state, endsAt + ASSESSMENT_SETTLEMENT_DELAY_MS, {
      pass: { rawSeconds: 29 * 3600, manualSeconds: 0, entertainmentSeconds: 0 },
      fail: { rawSeconds: 10 * 3600, manualSeconds: 0, entertainmentSeconds: 1800 },
    });
    expect(settled.outcomes.pass.status).toBe('complete');
    expect(settled.outcomes.fail.status).toBe('failed');
    expect(settled.outcomes.fail.comprehensiveSeconds).toBe(10 * 3600 + 1800);
    expect(settled.outcomes.newbie.status).toBe('exempt');
    expect(settled.outcomes.senior.status).toBe('exempt');
    expect(settled.outcomes.disabled.status).toBe('exempt');
  });
});
