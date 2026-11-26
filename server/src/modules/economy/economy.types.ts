/**
 * Economy 底层通用协议类型、输入校验与零和/燃烧税纯函数。
 * 资产收敛为极简双资产：coin（乐币）+ punch_minutes（本周打卡时长），外加只读 lifetimeEarnedCoins。
 */
import { z } from 'zod';
import type { EconomyAsset } from './entities/economy-hold.entity.js';

export const EconomyAssetSchema = z.enum(['coin', 'punch_minutes']);

export const CreateWagerSchema = z.object({
  asset: EconomyAssetSchema,
  amount: z.number().int().min(1, '数额必须为正整数'),
  matchId: z.string().trim().min(1, '缺少对局标识 matchId').max(64, 'matchId 最长 64 字符'),
  opponentUserId: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().min(1, '请填写对局标题').max(64, '标题最长 64 字'),
  acceptTimeoutSeconds: z.number().int().min(60).max(7200).optional(),
});
export type CreateWagerInput = z.infer<typeof CreateWagerSchema>;

export const TipCoinSchema = z.object({
  toUserId: z.string().trim().min(1, '缺少收款成员 ID').max(64),
  amount: z.number().int().min(1, '打赏数额必须为正整数'),
  note: z.string().trim().min(1, '请填写打赏留言').max(120),
});
export type TipCoinInput = z.infer<typeof TipCoinSchema>;

export const SettleWagerS2SSchema = z.object({
  matchId: z.string().trim().min(1, '缺少 matchId').max(64),
  result: z.enum(['win', 'draw', 'refund']),
  winnerUserId: z.string().trim().max(64).optional(),
  summary: z.string().trim().max(200).optional(),
});
export type SettleWagerS2SInput = z.infer<typeof SettleWagerS2SSchema>;

/** 内部服务（如 Nakama 通用赌约房插件）触发赌约结算的请求结构。 */
export const InternalSettleWagerSchema = z.object({
  appId: z.string().trim().min(1).max(64).optional(),
  matchId: z.string().trim().min(1).max(64).optional(),
  result: z.enum(['win', 'draw', 'refund']),
  winnerUserId: z.string().trim().max(64).optional(),
  summary: z.string().trim().max(200).optional(),
});
export type InternalSettleWagerInput = z.infer<typeof InternalSettleWagerSchema>;

/** 内部服务（如 Nakama 通用赌约房插件）标记双方上报冲突进入争议仲裁的请求结构。 */
export const InternalDisputeWagerSchema = z.object({
  appId: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(1, '请提供争议原因').max(200),
});
export type InternalDisputeWagerInput = z.infer<typeof InternalDisputeWagerSchema>;

/** 队长后台裁决锁定/争议赌约单的请求结构（判胜、平局或流局退款）。 */
export const AdminResolveOrderSchema = z.object({
  result: z.enum(['win', 'draw', 'refund']),
  winnerUserId: z.string().trim().max(64).optional(),
  note: z.string().trim().max(200).optional(),
});
export type AdminResolveOrderInput = z.infer<typeof AdminResolveOrderSchema>;

export const IssueCredentialSchema = z.object({
  allowedAssets: z.array(EconomyAssetSchema).min(1, '至少授权一种资产'),
  maxCoinPerOrder: z.number().int().min(1).max(500).default(50),
  maxPunchPerOrder: z.number().int().min(1).max(60).default(30),
  dailyOrderLimit: z.number().int().min(1).max(2000).default(200),
});
export type IssueCredentialInput = z.infer<typeof IssueCredentialSchema>;

export const InternalMintSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  amount: z.number().int().min(1).max(100_000),
  reason: z.enum(['attendance', 'fever_bonus', 'admin_grant', 'migration_init']),
  title: z.string().trim().min(1).max(120),
  idempotencyKey: z.string().trim().min(1).max(128),
  appId: z.string().trim().min(1).max(64).default('lec-punch'),
  weekKey: z.string().trim().max(16).optional(),
  /** 可选同步更新成员当周真实打卡分钟数（用于 punch_minutes 参与门槛风控）。 */
  weeklyRecordedMinutes: z.number().int().min(0).max(10_080).optional(),
});
export type InternalMintInput = z.infer<typeof InternalMintSchema>;

export const InternalSpendSchema = z.object({
  userId: z.string().trim().min(1).max(64),
  amount: z.number().int().min(1).max(100_000),
  reason: z.enum(['card_draw', 'shop_spend']),
  title: z.string().trim().min(1).max(120),
  idempotencyKey: z.string().trim().min(1).max(128),
  appId: z.string().trim().min(1).max(64).default('lec-punch'),
});
export type InternalSpendInput = z.infer<typeof InternalSpendSchema>;

export interface WalletSummaryDTO {
  coinBalance: number;
  frozenCoins: number;
  lifetimeEarnedCoins: number;
  weeklyRecordedMinutes: number;
  weeklyTradeMinutes: number;
  punchAffectsAssessment: boolean;
  quotas: {
    maxCoinPerOrder: number;
    maxPunchPerOrder: number;
    dailyCoinRemaining: number;
    weeklyCoinGainRemaining: number;
    weeklyPunchGainRemaining: number;
    weeklyPunchLossRemaining: number;
    activeOrdersCount: number;
    maxActiveOrders: number;
  };
}

export interface OrderParticipantDTO {
  userId: string;
  role: string;
  stakeAmount: number;
  outcome: string;
  payoutDelta: number;
  acceptedAt?: string;
}

export interface EconomyOrderDTO {
  orderId: string;
  appId: string;
  orderType: string;
  matchId: string;
  title: string;
  asset: EconomyAsset;
  amount: number;
  weekKey: string;
  status: string;
  creatorUserId: string;
  opponentUserId?: string;
  winnerUserId?: string;
  loserUserId?: string;
  summary?: string;
  acceptExpiresAt: number;
  settleExpiresAt?: number;
  settledAt?: number;
  createdAt: number;
  participants: OrderParticipantDTO[];
}

export interface ZeroSumTransferLeg {
  userId: string;
  delta: number;
}

/**
 * 计算燃烧税后的胜者实得净额与销毁额：
 * 仅对 coin 资产生效；punch_minutes 永远严格 1:1 零和（不销毁时长）。
 */
export function computeBurnAndNetPayout(
  asset: EconomyAsset,
  grossStake: number,
  burnRateBps: number,
): { netWin: number; burnAmount: number } {
  if (grossStake <= 0) {
    throw new Error('筹码数额必须大于 0');
  }
  if (asset !== 'coin' || burnRateBps <= 0) {
    return { netWin: grossStake, burnAmount: 0 };
  }
  const burnAmount = Math.floor((grossStake * burnRateBps) / 10_000);
  const netWin = grossStake - burnAmount;
  if (netWin <= 0) {
    throw new Error('燃烧税配置过高导致实得额非正');
  }
  return { netWin, burnAmount };
}

/**
 * 强校验 P2P 交易流水的数学守恒等式：
 * sum(delta) === -expectedBurnAmount（绝不允许工坊应用凭空增发任何币或时长）。
 */
export function assertZeroSumInvariant(
  legs: ZeroSumTransferLeg[],
  expectedBurnAmount = 0,
): void {
  if (expectedBurnAmount < 0 || !Number.isSafeInteger(expectedBurnAmount)) {
    throw new Error('非法燃烧税数额');
  }
  const sum = legs.reduce((acc, item) => acc + item.delta, 0);
  if (sum !== -expectedBurnAmount) {
    throw new Error(`零和守恒校验失败：流水净和 ${sum} !== 预期 -${expectedBurnAmount}`);
  }
}

/** 校验双人结算风控额度（纯函数，便于单元测试覆盖全部边界）。 */
export interface RiskCheckSnapshot {
  asset: EconomyAsset;
  amount: number;
  maxPerOrder: number;
  activeOrdersCount: number;
  maxActiveOrders: number;
  // coin 维度
  dailyCoinAbsVolume?: number;
  dailyCoinNetLimit?: number;
  weeklyCoinGain?: number;
  weeklyCoinGainLimit?: number;
  // punch_minutes 维度
  weeklyRecordedMinutes?: number;
  minRecordedMinutes?: number;
  weeklyPunchNetMinutes?: number;
  weeklyPunchGainLimit?: number;
  weeklyPunchLossLimit?: number;
  // 同对手频次
  sameOpponentCount?: number;
  sameOpponentLimit?: number;
}

export function evaluateParticipantRisk(snap: RiskCheckSnapshot): {
  ok: true;
} | {
  ok: false;
  reason: string;
} {
  if (snap.amount < 1 || snap.amount > snap.maxPerOrder) {
    return {
      ok: false,
      reason: `单笔数额超出上限（允许 1 ~ ${snap.maxPerOrder}）`,
    };
  }
  if (snap.activeOrdersCount >= snap.maxActiveOrders) {
    return {
      ok: false,
      reason: `同时进行中的托管单已达上限（最多 ${snap.maxActiveOrders} 笔）`,
    };
  }
  if (
    snap.sameOpponentCount !== undefined &&
    snap.sameOpponentLimit !== undefined &&
    snap.sameOpponentCount >= snap.sameOpponentLimit
  ) {
    return {
      ok: false,
      reason: `与同一对手的计分对局已达频次上限（最多 ${snap.sameOpponentLimit} 次）`,
    };
  }

  if (snap.asset === 'coin') {
    const usedDaily = snap.dailyCoinAbsVolume ?? 0;
    const dailyLim = snap.dailyCoinNetLimit ?? 200;
    if (usedDaily + snap.amount > dailyLim) {
      return {
        ok: false,
        reason: `超出今日乐币交易风控上限（每日限额 ${dailyLim}，已用 ${usedDaily}）`,
      };
    }
    const weeklyGain = snap.weeklyCoinGain ?? 0;
    const weeklyLim = snap.weeklyCoinGainLimit ?? 500;
    if (weeklyGain >= weeklyLim) {
      return {
        ok: false,
        reason: `本周通过工坊对局净赢乐币已达上限（${weeklyLim}）`,
      };
    }
  } else {
    const recorded = snap.weeklyRecordedMinutes ?? 0;
    const minReq = snap.minRecordedMinutes ?? 60;
    if (recorded < minReq) {
      return {
        ok: false,
        reason: `本周真实打卡需满 ${minReq} 分钟才可参与打卡时长约战（当前 ${recorded} 分钟）`,
      };
    }
    const net = snap.weeklyPunchNetMinutes ?? 0;
    const gainLim = snap.weeklyPunchGainLimit ?? 60;
    const lossLim = snap.weeklyPunchLossLimit ?? 60;
    // 若本局获胜将超净赢上限，或若本局落败将超净输上限，均提前拦下
    if (net + snap.amount > gainLim) {
      return {
        ok: false,
        reason: `若本局获胜将超出本周净赢打卡时长上限（上限 +${gainLim} 分钟，当前净变动 ${net} 分钟）`,
      };
    }
    if (net - snap.amount < -lossLim) {
      return {
        ok: false,
        reason: `若本局落败将超出本周净输打卡时长上限（上限 -${lossLim} 分钟，当前净变动 ${net} 分钟）`,
      };
    }
  }

  return { ok: true };
}
