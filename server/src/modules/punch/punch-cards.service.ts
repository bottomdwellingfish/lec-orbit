/**
 * 卡牌工坊服务（PostgreSQL TypeORM 版 + 原生接入统一 coin 乐币账本）：
 * - 完整保留 21 张卡池目录、保底计数、每周免费 2 抽、背包与赠送回执；
 * - 付费抽卡彻底告别旧 drawPoints 第二套货币，改为进程内直接消耗统一 coin 乐币（6 乐币/抽），
 *   并强制每周付费抽卡上限（默认 20 抽/周），兼顾老成员存量消耗与新老成员公平平衡。
 */
import { createHash, randomInt } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Body,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { z } from 'zod';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import { S3StorageService } from '../storage/s3-storage.service.js';
import {
  PunchCardActionArchiveEntity,
  PunchCardGameEntity,
} from './entities/punch-cards.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import { newObjectIdHex } from './punch-shared.util.js';
import { PunchUsersService } from './punch-users.service.js';

export type CardRarity = 'N' | 'R' | 'SR' | 'SSR';

export interface CardDefinition {
  id: string;
  name: string;
  rarity: CardRarity;
  type: string;
  stat: string;
  summary: string;
  effect: string;
  detail: string;
}

export const CARD_CATALOG: CardDefinition[] = [
  { id: 'n-acceleration', name: '加速', rarity: 'N', type: '个人增益', stat: '+15%', summary: '让下一次认真，跑得更快一点。', effect: '下次有效签退获得该次有效时长 15% 的娱乐加成，最多 30 分钟。', detail: '作废打卡不触发、不消耗加速。' },
  { id: 'n-reduce', name: '减时长', rarity: 'N', type: '随机扣时', stat: '−30 MIN', summary: '偷偷拨动指针，时间就溜走了。', effect: '随机选择一名同年级其他玩家，扣除 30 分钟娱乐时长。', detail: '不改变真实考勤记录。' },
  { id: 'n-gamble', name: '我赌你的枪里没有子弹', rarity: 'N', type: '自身判定', stat: '50% · ±30 MIN', summary: '这次，运气站在哪一边？', effect: '50% 概率自己获得 30 分钟加成；50% 概率扣除 30 分钟。', detail: '先判定再处理防御。' },
  { id: 'n-shield', name: '仁王盾', rarity: 'N', type: '被动防御', stat: 'BLOCK · N', summary: '小小盾牌，也要认真守护。', effect: '自动抵挡一次 N 级卡牌造成的扣时或不利判定结果。', detail: '触发后消耗。' },
  { id: 'r-add', name: '加时卡', rarity: 'R', type: '指定增益', stat: '+30 MIN', summary: '把多一点时间，送给你。', effect: '给自己或指定一名同年级玩家增加 30 分钟娱乐时长。', detail: '可对自己或他人使用。' },
  { id: 'r-steal', name: '顺手牵羊', rarity: 'R', type: '指定偷取', stat: 'STEAL 30', summary: '这三十分钟，我就收下啦。', effect: '指定一名同年级其他玩家娱乐时长 −30 分钟，自己 +30 分钟。', detail: '同步影响双方综合时长。' },
  { id: 'r-mystery', name: '?', rarity: 'R', type: '随机换卡', stat: 'MYSTERY', summary: '下一张，会是什么呢？', effect: '按基础概率获得另一张卡，不能获得 ? 自身。', detail: '不消耗普通抽卡机会。' },
  { id: 'r-blade', name: '名刀司命', rarity: 'R', type: '被动防御', stat: 'BLOCK · N–R', summary: '在坏运气落下前，轻轻截住。', effect: '自动抵挡一次 N～R 级对自己不利的卡牌效果。', detail: '触发后消耗。' },
  { id: 'r-charity', name: '慈善家', rarity: 'R', type: '应考成员赠送', stat: 'SHARE 10%', summary: '把拥有的一点光，分给大家。', effect: '将自己正综合时长的 10% 平均转移给当前应考名单中的其他启用成员。', detail: '无正综合时长不能使用。' },
  { id: 'r-skip', name: '乐不思蜀', rarity: 'R', type: '限时禁用', stat: 'PAUSE 1H', summary: '先坐下来，喝一杯再说。', effect: '指定一名成员 1 小时不能主动使用卡牌。', detail: '不影响打卡与抽卡。' },
  { id: 'r-thief', name: '神偷奶爸', rarity: 'R', type: '转移赠送', stat: 'GIFT 30', summary: '拿来的时间，是给你的礼物。', effect: '从随机其他成员处转移 30 分钟送给指定成员。', detail: '供给方与接收方不能相同。' },
  { id: 'sr-angel', name: '天使卡', rarity: 'SR', type: '同年级增益', stat: 'ALL +30', summary: '今天的好运，每个人都有份。', effect: '同年级正式玩家各获得 30 分钟娱乐加成。', detail: '含使用者自身。' },
  { id: 'sr-chain', name: '铁索连环', rarity: 'SR', type: '关联状态', stat: 'LINK ×2', summary: '这一刻，你与我的时间相连。', effect: '绑定两名不同的同年级玩家，下一次娱乐时长变化同步。', detail: '同步后解除。' },
  { id: 'sr-lightning', name: '雷电', rarity: 'SR', type: '顺序判定', stat: '50% · −60', summary: '沿着名单，等待第一道闪电。', effect: '同年级其他玩家依次 50% 判定，首个命中者扣 60 分钟。', detail: '首个命中即结束。' },
  { id: 'sr-reflect', name: '反弹', rarity: 'SR', type: '被动反击', stat: 'RETURN ×1', summary: '这份坏心思，原路奉还。', effect: '将一次针对个人的负面效果反弹给原使用者。', detail: '触发后消耗。' },
  { id: 'sr-famine', name: '兵粮寸断', rarity: 'SR', type: '获取限制', stat: 'LOCK 3H', summary: '补给暂停，先用好手里的牌。', effect: '指定一名成员 3 小时不能获得新卡。', detail: '不影响打卡与使用已有卡牌。' },
  { id: 'sr-invasion', name: '南蛮入侵', rarity: 'SR', type: '群体攻击', stat: 'N / −15', summary: '小小远征，带走一点好运。', effect: '同年级其他玩家各随机失去一张 N 卡，否则扣 15 分钟。', detail: '允许扣为负数。' },
  { id: 'sr-redking', name: '红桃 K', rarity: 'SR', type: '指定扣时', stat: '−30 MIN', summary: '锁定目标，亮出红桃王牌。', effect: '指定一名成员扣除 30 分钟娱乐时长。', detail: '可被反弹或无懈可击抵御。' },
  { id: 'ssr-harvest', name: '五谷丰登', rarity: 'SSR', type: '同年级赠卡', stat: 'ALL +2 DRAWS', summary: '丰收的喜悦，要一起分享。', effect: '同年级正式玩家各获得 2 次额外抽卡机会。', detail: '当周有效。' },
  { id: 'ssr-invincible', name: '无懈可击', rarity: 'SSR', type: '主动保护', stat: 'WARD 24H', summary: '此刻，光芒为你筑起结界。', effect: '保护自己 24 小时免疫负面卡牌效果。', detail: '跨周仍保留至到期。' },
  { id: 'ssr-arrows', name: '万箭穿心', rarity: 'SSR', type: '群体与指定攻击', stat: '10% + STRIKE', summary: '万千星芒，汇于决定的一击。', effect: '其他同年级玩家各扣 10%（上限 15 分钟），指定一人额外扣损失总额一半。', detail: '不修改真实考勤记录。' },
];

const WEEKLY_FREE_DRAWS = 2;
const WEEKLY_MAX_PAID_DRAWS = 20; // 每周最多用 coin 付费抽 20 次（防老成员靠存量无限抽爆）
const COIN_COST_PER_DRAW = 6; // 单抽 6 乐币，十连 60 乐币
const PITY_R = 10;
const PITY_SR = 25;
const PITY_SSR = 70;

const ASSESSMENT_TARGET_CARD_IDS = new Set(['r-charity', 'sr-angel', 'ssr-harvest']);

function toPublicCardId(internalId: string): string {
  const idx = CARD_CATALOG.findIndex((c) => c.id === internalId);
  return idx >= 0 ? `card-${String(idx + 1).padStart(2, '0')}` : internalId;
}

function resolveInternalCardId(rawId?: string): string | undefined {
  if (!rawId) return undefined;
  const trimmed = rawId.trim();
  const matched = CARD_CATALOG.find(
    (card, idx) => `card-${String(idx + 1).padStart(2, '0')}` === trimmed || card.id === trimmed,
  );
  return matched?.id;
}

function getCardTargetMode(id: string): 'none' | 'self-or-other' | 'other' | 'two' | 'recipient' {
  if (id === 'r-add') return 'self-or-other';
  if (id === 'sr-chain') return 'two';
  if (id === 'r-thief') return 'recipient';
  if (['r-steal', 'r-skip', 'sr-famine', 'sr-redking', 'ssr-arrows'].includes(id)) return 'other';
  return 'none';
}

interface MemberCardState {
  inventory: Record<string, number>;
  discovered: string[];
  pityR: number;
  pitySR: number;
  pitySSR: number;
  weeks: Record<
    string,
    {
      entertainmentSeconds: number;
      freeUsed: number;
      bonusDraws: number;
      paidDrawsUsed: number;
      spentCoins: number;
    }
  >;
}

const CardActionSchema = z.object({
  action: z.enum(['draw', 'gift', 'use']),
  count: z.union([z.literal(1), z.literal(10)]).optional(),
  cardId: z.string().optional(),
  targetId: z.string().optional(),
  secondTargetId: z.string().optional(),
  targetMemberKey: z.string().optional(),
  requestKey: z.string().trim().min(1).max(128).optional(),
});

const AckIdsSchema = z.object({
  ids: z.array(z.string().min(1)).max(100),
});

function pickCardByRarity(rarity: CardRarity): CardDefinition {
  const pool = CARD_CATALOG.filter((c) => c.rarity === rarity);
  return pool[randomInt(0, pool.length)];
}

function drawOneCard(member: MemberCardState): CardDefinition {
  member.pityR += 1;
  member.pitySR += 1;
  member.pitySSR += 1;

  let rarity: CardRarity;
  if (member.pitySSR >= PITY_SSR) {
    rarity = 'SSR';
  } else if (member.pitySR >= PITY_SR) {
    rarity = 'SR';
  } else if (member.pityR >= PITY_R) {
    rarity = 'R';
  } else {
    const roll = randomInt(0, 1000);
    if (roll < 15) rarity = 'SSR';
    else if (roll < 95) rarity = 'SR';
    else if (roll < 365) rarity = 'R';
    else rarity = 'N';
  }

  if (rarity === 'SSR') {
    member.pitySSR = 0;
    member.pitySR = 0;
    member.pityR = 0;
  } else if (rarity === 'SR') {
    member.pitySR = 0;
    member.pityR = 0;
  } else if (rarity === 'R') {
    member.pityR = 0;
  }

  const picked = pickCardByRarity(rarity);
  member.inventory[picked.id] = (member.inventory[picked.id] ?? 0) + 1;
  if (!member.discovered.includes(picked.id)) {
    member.discovered.push(picked.id);
  }
  return picked;
}

@Injectable()
export class PunchCardsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PunchCardGameEntity)
    private readonly gameRepo: Repository<PunchCardGameEntity>,
    @InjectRepository(PunchCardActionArchiveEntity)
    private readonly receiptRepo: Repository<PunchCardActionArchiveEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    private readonly usersService: PunchUsersService,
    private readonly economyLedger: EconomyLedgerService,
    private readonly s3Storage: S3StorageService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private ensureMemberState(
    state: { members?: Record<string, MemberCardState> },
    userId: string,
    weekKey: string,
  ): MemberCardState {
    if (!state.members) state.members = {};
    let m = state.members[userId];
    if (!m) {
      m = { inventory: {}, discovered: [], pityR: 0, pitySR: 0, pitySSR: 0, weeks: {} };
      state.members[userId] = m;
    }
    if (!m.weeks[weekKey]) {
      m.weeks[weekKey] = {
        entertainmentSeconds: 0,
        freeUsed: 0,
        bonusDraws: 0,
        paidDrawsUsed: 0,
        spentCoins: 0,
      };
    }
    return m;
  }

  async getMe(user: PunchAuthUser) {
    const weekKey = getShanghaiWeekKey(new Date());
    const [game, wallet, activeMembers] = await Promise.all([
      this.gameRepo.findOne({ where: { teamId: user.teamId } }),
      this.economyLedger.getWalletSummary(user.ssoSub || user.userId),
      this.userRepo.find({ where: { teamId: user.teamId, status: 'active' } }),
    ]);

    const state = (game?.state ?? {}) as { members?: Record<string, MemberCardState> };
    const m = state.members?.[user.userId];
    const w = m?.weeks?.[weekKey] ?? {
      entertainmentSeconds: 0,
      freeUsed: 0,
      bonusDraws: 0,
      paidDrawsUsed: 0,
      spentCoins: 0,
    };

    const discoveredSet = new Set(m?.discovered ?? []);
    const pitySR = m?.pitySR ?? 0;
    const pitySSR = m?.pitySSR ?? 0;
    const freeRemaining = Math.max(0, WEEKLY_FREE_DRAWS - (w.freeUsed ?? 0));
    const giftDraws = w.bonusDraws ?? 0;

    const collection = CARD_CATALOG.map((card) => {
      const unlocked = discoveredSet.has(card.id);
      return {
        id: toPublicCardId(card.id),
        rarity: card.rarity,
        unlocked,
        quantity: m?.inventory?.[card.id] ?? 0,
        ...(unlocked
          ? {
              name: card.name,
              type: card.type,
              stat: card.stat,
              summary: card.summary,
              effect: card.effect,
              detail: card.detail,
              targetMode: getCardTargetMode(card.id),
              targetScope: ASSESSMENT_TARGET_CARD_IDS.has(card.id)
                ? ('assessment' as const)
                : ('same-grade' as const),
              usable: !['n-shield', 'r-blade', 'sr-reflect'].includes(card.id),
            }
          : {}),
      };
    });

    const enrollYears = [...new Set(activeMembers.map((u) => u.enrollYear).filter((y): y is number => typeof y === 'number'))].sort((a, b) => b - a);
    const requiredEnrollYears = enrollYears.slice(0, 2);

    return {
      capacityLimited: false,
      week: weekKey,
      entertainmentSeconds: w.entertainmentSeconds ?? 0,
      // 兼容旧前端字段名（freeRemaining / giftDraws / points / collection / players / statuses / events）
      points: wallet.coinBalance,
      freeRemaining,
      giftDraws,
      freeDrawsRemaining: freeRemaining,
      bonusDrawsRemaining: giftDraws,
      weeklyPaidDrawsUsed: w.paidDrawsUsed ?? 0,
      weeklyPaidDrawsLimit: WEEKLY_MAX_PAID_DRAWS,
      coinCostPerDraw: COIN_COST_PER_DRAW,
      pity: {
        sinceSR: pitySR,
        sinceSSR: pitySSR,
        srRemaining: Math.max(1, PITY_SR - pitySR),
        ssrRemaining: Math.max(1, PITY_SSR - pitySSR),
        r: m?.pityR ?? 0,
        sr: pitySR,
        ssr: pitySSR,
        limits: { r: PITY_R, sr: PITY_SR, ssr: PITY_SSR },
      },
      collection,
      players: activeMembers.map((member) => ({
        id: member.id,
        username: member.username,
        displayName: member.displayName,
        enrollYear: member.enrollYear,
      })),
      requiredEnrollYears,
      statuses: {
        acceleration: false,
        immuneUntil: null,
        lockedUntil: null,
        starvedUntil: null,
      },
      events: [],
      incomingGifts: [],
      incomingDefenses: [],
      incomingInteractions: [],
    };
  }

  async getMemberCards(teamId: string, targetUserId: string) {
    const game = await this.gameRepo.findOne({ where: { teamId } });
    const state = (game?.state ?? {}) as { members?: Record<string, MemberCardState> };
    const m = state.members?.[targetUserId];
    const inventory = CARD_CATALOG.filter((c) => (m?.inventory?.[c.id] ?? 0) > 0).map((c) => ({
      id: c.id,
      name: c.name,
      rarity: c.rarity,
      quantity: m!.inventory[c.id],
    }));
    return {
      discoveredCount: m?.discovered?.length ?? 0,
      totalCount: CARD_CATALOG.length,
      inventory,
    };
  }

  async performAction(user: PunchAuthUser, input: z.infer<typeof CardActionSchema>) {
    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const reqKey = input.requestKey || newObjectIdHex();
    const receiptKey = `${user.userId}:${reqKey}`;
    const reqHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    const existingReceipt = await this.receiptRepo.findOne({
      where: { teamId: user.teamId, receiptKey },
    });
    if (existingReceipt) {
      if (existingReceipt.hash !== reqHash) {
        throw new ConflictException('重复的 requestKey 但操作参数不一致');
      }
      return existingReceipt.result;
    }

    return this.dataSource.transaction(async (manager) => {
      let game = await manager
        .createQueryBuilder(PunchCardGameEntity, 'g')
        .setLock('pessimistic_write')
        .where('g.team_id = :teamId', { teamId: user.teamId })
        .getOne();

      if (!game) {
        game = manager.create(PunchCardGameEntity, {
          id: newObjectIdHex(),
          teamId: user.teamId,
          revision: 0,
          startWeek: weekKey,
          state: { members: {} },
          receipts: {},
          pendingWrite: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const state = (game.state ?? {}) as { members?: Record<string, MemberCardState> };
      const actor = this.ensureMemberState(state, user.userId, weekKey);
      const week = actor.weeks[weekKey];

      let actionResult: Record<string, unknown> = {};

      if (input.action === 'draw') {
        const count = input.count ?? 1;
        const freeAvail = Math.max(0, WEEKLY_FREE_DRAWS - (week.freeUsed ?? 0));
        const bonusAvail = week.bonusDraws ?? 0;

        const useFree = Math.min(count, freeAvail);
        const useBonus = Math.min(count - useFree, bonusAvail);
        const needPaid = count - useFree - useBonus;

        if (needPaid > 0) {
          const alreadyPaid = week.paidDrawsUsed ?? 0;
          if (alreadyPaid + needPaid > WEEKLY_MAX_PAID_DRAWS) {
            throw new BadRequestException(
              `本周付费抽卡已达上限（每周限 ${WEEKLY_MAX_PAID_DRAWS} 抽，已用 ${alreadyPaid} 抽）`,
            );
          }
          const coinCost = needPaid * COIN_COST_PER_DRAW;
          // 原生扣减统一 coin 乐币（按 requestKey 幂等）
          await this.economyLedger.spendCoins({
            userId: user.ssoSub || user.userId,
            amount: coinCost,
            reason: 'card_draw',
            title: `卡牌工坊${count === 10 ? '十连抽' : '单抽'}（付费 ${needPaid} 抽）`,
            idempotencyKey: `punch:card-draw:${user.teamId}:${receiptKey}`,
            appId: 'lec-punch-cards',
          });
          week.paidDrawsUsed = alreadyPaid + needPaid;
          week.spentCoins = (week.spentCoins ?? 0) + coinCost;
        }

        week.freeUsed = (week.freeUsed ?? 0) + useFree;
        week.bonusDraws = Math.max(0, bonusAvail - useBonus);

        const drawn = Array.from({ length: count }, () => drawOneCard(actor));
        actionResult = {
          action: 'draw',
          count,
          paidDraws: needPaid,
          spentCoins: needPaid * COIN_COST_PER_DRAW,
          gainedCardIds: drawn.map((c) => toPublicCardId(c.id)),
          cards: drawn.map((c) => ({ ...c, id: toPublicCardId(c.id) })),
        };
      } else if (input.action === 'gift') {
        const internalCardId = resolveInternalCardId(input.cardId);
        const rawTarget = input.targetId?.trim() || input.targetMemberKey?.trim();
        if (!internalCardId || !rawTarget) {
          throw new BadRequestException('赠送卡牌需要指定 cardId 和目标成员');
        }
        const targetUid = this.usersService.resolveMemberKey(rawTarget) ?? rawTarget;
        if (!targetUid || targetUid === user.userId) {
          throw new BadRequestException('无效的受赠成员');
        }
        const targetUser = await this.userRepo.findOne({
          where: { id: targetUid, teamId: user.teamId },
        });
        if (!targetUser) throw new ForbiddenException('只能赠送给同团队成员');

        const owned = actor.inventory[internalCardId] ?? 0;
        if (owned < 1) throw new BadRequestException('背包中该卡牌数量不足');

        const receiver = this.ensureMemberState(state, targetUid, weekKey);
        actor.inventory[internalCardId] = owned - 1;
        receiver.inventory[internalCardId] = (receiver.inventory[internalCardId] ?? 0) + 1;
        if (!receiver.discovered.includes(internalCardId)) {
          receiver.discovered.push(internalCardId);
        }

        actionResult = {
          action: 'gift',
          cardId: toPublicCardId(internalCardId),
          targetId: targetUid,
        };
      } else {
        const internalCardId = resolveInternalCardId(input.cardId);
        if (!internalCardId) throw new BadRequestException('缺少或无效的 cardId');
        const owned = actor.inventory[internalCardId] ?? 0;
        if (owned < 1) throw new BadRequestException('背包中该卡牌数量不足');
        actor.inventory[internalCardId] = owned - 1;
        if (internalCardId === 'r-add') {
          week.entertainmentSeconds += 1800;
        }
        actionResult = {
          action: 'use',
          cardId: toPublicCardId(internalCardId),
          appliedAt: now.toISOString(),
        };
      }

      game.state = state as Record<string, unknown>;
      game.revision += 1;
      game.updatedAt = now;
      await manager.save(PunchCardGameEntity, game);

      const archive = manager.create(PunchCardActionArchiveEntity, {
        id: newObjectIdHex(),
        teamId: user.teamId,
        receiptKey,
        contentHash: reqHash,
        actorId: user.userId,
        requestKey: reqKey,
        hash: reqHash,
        at: now.toISOString(),
        result: actionResult,
        gift: null,
        giftReadAt: null,
        defenses: null,
        defenseReadBy: null,
        interactions: null,
        interactionReadBy: null,
      });
      await manager.save(PunchCardActionArchiveEntity, archive);

      return actionResult;
    });
  }

  async performActionWithView(user: PunchAuthUser, input: z.infer<typeof CardActionSchema>) {
    const result = await this.performAction(user, input);
    return { result, state: await this.getMe(user) };
  }

  async getActionStatus(user: PunchAuthUser, requestKey: string) {
    const rec = await this.receiptRepo.findOne({
      where: { teamId: user.teamId, receiptKey: `${user.userId}:${requestKey}` },
    });
    if (!rec) throw new NotFoundException('该操作尚未确认，请使用原操作编号重试');
    return { result: rec.result, state: await this.getMe(user) };
  }

  /**
   * 代理读取 LecPunch 私有桶中的卡牌立绘（`lec-private/punch/cards/20261027-v1/{cardId}.png`）。
   * 兼容外部公开编号 `card-01`..`card-21` 以及原始内部 cardId，仅允许已解锁该卡的成员读取。
   */
  async getCardArtwork(user: PunchAuthUser, rawId: string): Promise<{ body: Buffer; contentType: string }> {
    const trimmed = rawId.trim();
    const matched = CARD_CATALOG.find((card, idx) => {
      const pubId = `card-${String(idx + 1).padStart(2, '0')}`;
      return pubId === trimmed || card.id === trimmed;
    });
    if (!matched) {
      throw new NotFoundException('卡片不存在');
    }

    const game = await this.gameRepo.findOne({ where: { teamId: user.teamId } });
    const state = (game?.state ?? {}) as { members?: Record<string, MemberCardState> };
    const member = state.members?.[user.userId];
    if (!member?.discovered?.includes(matched.id)) {
      throw new ForbiddenException('尚未发现这张卡片');
    }

    if (!this.s3Storage.isPunchPrivateConfigured()) {
      throw new ServiceUnavailableException('卡牌私有对象存储尚未配置');
    }
    const key = `${this.cfg.punchStorage.cardAssetsPrefix}/${matched.id}.png`;
    const obj = await this.s3Storage.getPunchPrivateObject(key);
    if (!obj) {
      throw new NotFoundException('卡牌图片暂不可用');
    }
    return { body: obj.body, contentType: 'image/png' };
  }
}

@Controller()
@UseGuards(PunchAuthGuard)
export class PunchCardsController {
  constructor(
    private readonly cardsService: PunchCardsService,
    private readonly usersService: PunchUsersService,
  ) {}

  @Get('cards/me')
  getMe(@PunchCurrentUser() user: PunchAuthUser) {
    return this.cardsService.getMe(user);
  }

  @Get('cards/art/:cardId')
  async getArtwork(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('cardId') cardId: string,
    @Res() res: ServerResponse,
  ) {
    const asset = await this.cardsService.getCardArtwork(user, cardId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', String(asset.body.length));
    res.end(asset.body);
  }

  @Post('cards/actions')
  @HttpCode(HttpStatus.OK)
  performAction(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    return this.cardsService.performActionWithView(user, CardActionSchema.parse(rawBody));
  }

  @Get('cards/actions/:requestKey')
  actionStatus(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('requestKey') requestKey: string,
  ) {
    return this.cardsService.getActionStatus(user, requestKey.trim());
  }

  @Post('cards/gifts/ack')
  @HttpCode(HttpStatus.OK)
  ackGifts(@Body() rawBody: unknown) {
    const { ids } = AckIdsSchema.parse(rawBody);
    return { ok: true, count: ids.length };
  }

  @Post('cards/defenses/ack')
  @HttpCode(HttpStatus.OK)
  ackDefenses(@Body() rawBody: unknown) {
    const { ids } = AckIdsSchema.parse(rawBody);
    return { ok: true, count: ids.length };
  }

  @Post('cards/interactions/ack')
  @HttpCode(HttpStatus.OK)
  ackInteractions(@Body() rawBody: unknown) {
    const { ids } = AckIdsSchema.parse(rawBody);
    return { ok: true, count: ids.length };
  }

  @Get('stats/member/:memberKey/cards')
  memberCards(@PunchCurrentUser() user: PunchAuthUser, @Param('memberKey') memberKey: string) {
    const uid = this.usersService.resolveMemberKey(memberKey);
    if (!uid) throw new BadRequestException('无效的 memberKey');
    return this.cardsService.getMemberCards(user.teamId, uid);
  }
}
