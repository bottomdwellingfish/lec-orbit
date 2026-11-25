/**
 * Orbit 通用交易网关服务：
 * - 强制校验工坊应用上架状态、已审核 Manifest scope 与一应用一密钥凭证；
 * - 执行 5 道防刷硬风控（零和守恒、单笔上限、日/周净限额、同对手频次、真实打卡门槛）；
 * - 维护托管单状态机（pending_accept -> locked -> settled / refunded / cancelled / expired）；
 * - 提供 S2S 全要素 HMAC-SHA256 + Nonce 防重放结算、双超时与跨周自动流局回收、队长密钥管理与仲裁退款。
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { generateAppSecret, openAppSecret, sealAppSecret } from '../../common/utils/crypto-secret.js';
import { InMemoryNonceStore, verifyS2SSignature } from '../../common/utils/hmac.js';
import { getShanghaiDayBounds, getShanghaiWeekKey } from '../../common/utils/week-key.js';
import type { AuthUser } from '../auth/auth.types.js';
import { MiniAppEntity } from '../miniapps/entities/mini-app.entity.js';
import { MiniAppVersionEntity } from '../miniapps/entities/mini-app-version.entity.js';
import { RealtimeHub } from '../realtime/realtime.hub.js';
import type { EconomyAsset } from './entities/economy-hold.entity.js';
import { MiniAppCredentialEntity } from './entities/mini-app-credential.entity.js';
import { EconomyOrderEntity } from './entities/economy-order.entity.js';
import { EconomyOrderParticipantEntity } from './entities/economy-order-participant.entity.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import {
  evaluateParticipantRisk,
  type CreateWagerInput,
  type EconomyOrderDTO,
  type IssueCredentialInput,
  type SettleWagerS2SInput,
  type TipCoinInput,
} from './economy.types.js';

@Injectable()
export class EconomyGatewayService {
  private readonly logger = new Logger(EconomyGatewayService.name);
  private readonly nonceStore = new InMemoryNonceStore();

  constructor(
    private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly ledger: EconomyLedgerService,
    private readonly hub: RealtimeHub,
  ) {}

  // ── 应用权限与一应用一密钥校验 ──

  /**
   * 后端强校验：目标工坊应用必须存在、已上架（published）、其生效版本 Manifest 确实声明了对应 scope，
   * 且已由队长在 mini_app_credentials 签发有效密钥并授权该资产类型。
   */
  private async assertAppAuthorizedForEconomy(
    manager: EntityManager,
    appId: string,
    requiredScope: string,
    asset?: EconomyAsset,
    requireActiveCredential = true,
  ): Promise<{ app: MiniAppEntity; credential: MiniAppCredentialEntity | null }> {
    const app = await manager.findOne(MiniAppEntity, { where: { id: appId } });
    if (!app || app.status !== 'published' || !app.activeVersionId) {
      throw new ForbiddenException('该工坊应用未上架或未通过审核，禁止发起交易');
    }

    const activeVersion = await manager.findOne(MiniAppVersionEntity, {
      where: { id: app.activeVersionId, appId: app.id, status: 'approved' },
    });
    if (!activeVersion) {
      throw new ForbiddenException('该工坊应用缺少已审核通过的生效版本');
    }

    const manifestPerms = (activeVersion.manifestJson?.permissions ?? {}) as {
      scopes?: unknown;
    };
    const scopes = Array.isArray(manifestPerms.scopes)
      ? manifestPerms.scopes.filter((s): s is string => typeof s === 'string')
      : [];

    if (!scopes.includes(requiredScope)) {
      throw new ForbiddenException(`应用生效版本未获批 ${requiredScope} 权限`);
    }

    const cred = await manager.findOne(MiniAppCredentialEntity, { where: { appId: app.id } });
    if (requireActiveCredential) {
      if (!cred || cred.status !== 'active') {
        throw new ForbiddenException('队长尚未为该工坊应用签发有效交易凭证或凭证已吊销');
      }
      if (asset && !cred.allowedAssets.includes(asset)) {
        throw new ForbiddenException(`该工坊应用未被授权使用 ${asset} 资产`);
      }
    }

    return { app, credential: cred };
  }

  /** 统计同一对成员在指定时间窗内的同资产托管对局次数（防串通高频互刷）。 */
  private async countSameOpponentMatches(
    manager: EntityManager,
    userA: string,
    userB: string,
    asset: EconomyAsset,
    weekKey: string,
    now: Date,
  ): Promise<number> {
    if (!userA || !userB || userA === userB) return 0;

    if (asset === 'punch_minutes') {
      const [row] = (await manager.query(
        `SELECT COUNT(DISTINCT o.id)::int AS cnt
         FROM economy_orders o
         JOIN economy_order_participants p1 ON p1.order_id = o.id AND p1.user_id = $1
         JOIN economy_order_participants p2 ON p2.order_id = o.id AND p2.user_id = $2
         WHERE o.asset = 'punch_minutes' AND o.week_key = $3
           AND o.status IN ('locked', 'settled')`,
        [userA, userB, weekKey],
      )) as [{ cnt: number }];
      return Number(row?.cnt ?? 0);
    }

    const { startUtc, endUtc } = getShanghaiDayBounds(now);
    const [row] = (await manager.query(
      `SELECT COUNT(DISTINCT o.id)::int AS cnt
       FROM economy_orders o
       JOIN economy_order_participants p1 ON p1.order_id = o.id AND p1.user_id = $1
       JOIN economy_order_participants p2 ON p2.order_id = o.id AND p2.user_id = $2
       WHERE o.asset = 'coin'
         AND o.status IN ('locked', 'settled')
         AND o.created_at >= $3 AND o.created_at < $4`,
      [userA, userB, startUtc, endUtc],
    )) as [{ cnt: number }];
    return Number(row?.cnt ?? 0);
  }

  // ── 托管赌约（escrow_wager）全生命周期 ──

  async createWager(
    user: AuthUser,
    appId: string,
    input: CreateWagerInput,
  ): Promise<EconomyOrderDTO> {
    const requiredScope =
      input.asset === 'coin' ? 'economy.wager.coin' : 'economy.wager.punch';
    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const ec = this.cfg.economy;

    if (input.opponentUserId && input.opponentUserId === user.userId) {
      throw new BadRequestException('不能指定自己作为约战对手');
    }

    const { order, participants } = await this.dataSource.transaction(async (manager) => {
      const { credential } = await this.assertAppAuthorizedForEconomy(
        manager,
        appId,
        requiredScope,
        input.asset,
        true,
      );

      // 校验单笔上限（取平台硬上限与应用专属上限的较小值）
      const maxPerOrder =
        input.asset === 'coin'
          ? Math.min(ec.maxCoinPerOrder, credential!.maxCoinPerOrder)
          : Math.min(ec.maxPunchPerOrder, credential!.maxPunchPerOrder);

      // 校验发起方风控额度
      const metrics = await this.ledger.getUserRiskMetrics(manager, user.userId, weekKey, now);
      const sameOppCount = input.opponentUserId
        ? await this.countSameOpponentMatches(
            manager,
            user.userId,
            input.opponentUserId,
            input.asset,
            weekKey,
            now,
          )
        : 0;

      const risk = evaluateParticipantRisk({
        asset: input.asset,
        amount: input.amount,
        maxPerOrder,
        activeOrdersCount: metrics.activeOrdersCount,
        maxActiveOrders: ec.maxActiveOrdersPerUser,
        dailyCoinAbsVolume: metrics.dailyCoinAbsVolume,
        dailyCoinNetLimit: ec.dailyCoinNetLimit,
        weeklyCoinGain: metrics.weeklyCoinGain,
        weeklyCoinGainLimit: ec.weeklyCoinGainLimit,
        weeklyRecordedMinutes: metrics.weeklyRecordedMinutes,
        minRecordedMinutes: ec.punchMinRecordedMinutes,
        weeklyPunchNetMinutes: metrics.weeklyPunchNetMinutes,
        weeklyPunchGainLimit: ec.weeklyPunchGainLimit,
        weeklyPunchLossLimit: ec.weeklyPunchLossLimit,
        sameOpponentCount: sameOppCount,
        sameOpponentLimit:
          input.asset === 'coin'
            ? ec.dailyCoinSameOpponentLimit
            : ec.weeklyPunchSameOpponentLimit,
      });
      if (!risk.ok) {
        throw new BadRequestException(risk.reason);
      }

      const orderId = randomUUID();
      const acceptTtl = input.acceptTimeoutSeconds ?? ec.defaultAcceptTtlSeconds;
      const acceptExpiresAt = new Date(now.getTime() + acceptTtl * 1000);

      const hold = await this.ledger.createHoldTx(
        manager,
        {
          orderId,
          appId,
          userId: user.userId,
          asset: input.asset,
          amount: input.amount,
          weekKey,
          expiresAt: new Date(now.getTime() + (acceptTtl + ec.defaultSettleTtlSeconds) * 1000),
          idempotencyKey: `wager:create:${orderId}:${user.userId}`,
        },
        now,
      );

      const newOrder = manager.create(EconomyOrderEntity, {
        id: orderId,
        appId,
        orderType: 'escrow_wager',
        externalMatchId: input.matchId,
        title: input.title,
        asset: input.asset,
        amount: input.amount,
        weekKey,
        status: 'pending_accept',
        creatorUserId: user.userId,
        summary: '',
        acceptExpiresAt,
        settleExpiresAt: null,
        settledAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await manager.save(EconomyOrderEntity, newOrder);

      const creatorPart = manager.create(EconomyOrderParticipantEntity, {
        orderId,
        userId: user.userId,
        role: 'creator',
        stakeAmount: input.amount,
        holdId: hold.holdId,
        outcome: '',
        payoutDelta: 0,
        acceptedAt: now,
      });
      const parts: EconomyOrderParticipantEntity[] = [creatorPart];

      if (input.opponentUserId) {
        parts.push(
          manager.create(EconomyOrderParticipantEntity, {
            orderId,
            userId: input.opponentUserId,
            role: 'opponent',
            stakeAmount: input.amount,
            holdId: null,
            outcome: '',
            payoutDelta: 0,
            acceptedAt: null,
          }),
        );
      }
      await manager.save(EconomyOrderParticipantEntity, parts);

      return { order: newOrder, participants: parts };
    });

    return this.toOrderDTO(order, participants);
  }

  async getWager(user: AuthUser, appId: string, orderId: string): Promise<EconomyOrderDTO> {
    const order = await this.dataSource.getRepository(EconomyOrderEntity).findOne({
      where: { id: orderId, appId },
    });
    if (!order) {
      throw new NotFoundException('托管赌约单不存在');
    }
    const participants = await this.dataSource
      .getRepository(EconomyOrderParticipantEntity)
      .find({ where: { orderId: order.id } });

    // 待应战的公开约战允许任意工作室成员查看详情以确认画押；其余状态仅参与方或队长可见
    const isParticipant = participants.some((p) => p.userId === user.userId);
    const hasDesignatedOpponent = participants.some((p) => p.role === 'opponent');
    if (
      !isParticipant &&
      !user.isCaptain &&
      !(order.status === 'pending_accept' && !hasDesignatedOpponent)
    ) {
      throw new ForbiddenException('无权查看该托管单详情');
    }

    return this.toOrderDTO(order, participants);
  }

  async acceptWager(user: AuthUser, appId: string, orderId: string): Promise<EconomyOrderDTO> {
    const now = new Date();
    const currentWeekKey = getShanghaiWeekKey(now);
    const ec = this.cfg.economy;

    const { order, participants } = await this.dataSource.transaction(async (manager) => {
      const target = await manager
        .createQueryBuilder(EconomyOrderEntity, 'o')
        .setLock('pessimistic_write')
        .where('o.id = :id AND o.app_id = :appId', { id: orderId, appId })
        .getOne();

      if (!target) {
        throw new NotFoundException('托管赌约单不存在');
      }
      if (target.status !== 'pending_accept') {
        throw new ConflictException('该托管赌约已锁定或已结束');
      }

      const parts = await manager.find(EconomyOrderParticipantEntity, {
        where: { orderId: target.id },
      });

      // 懒触发过期检查：过期或 punch_minutes 跨周则立即自动解冻退还发起人
      const expired =
        now > target.acceptExpiresAt ||
        (target.asset === 'punch_minutes' && target.weekKey !== currentWeekKey);
      if (expired) {
        await this.refundOrderTx(manager, target, parts, 'expired', '超时未应战自动退还', now);
        throw new GoneException('该托管赌约已过期并自动退还筹码');
      }

      if (target.creatorUserId === user.userId) {
        throw new BadRequestException('不能应战自己发起的赌约');
      }

      const designatedOpponent = parts.find((p) => p.role === 'opponent');
      if (designatedOpponent && designatedOpponent.userId !== user.userId) {
        throw new ForbiddenException('你不是该赌约指定的应战成员');
      }

      const requiredScope =
        target.asset === 'coin' ? 'economy.wager.coin' : 'economy.wager.punch';
      const { credential } = await this.assertAppAuthorizedForEconomy(
        manager,
        appId,
        requiredScope,
        target.asset,
        true,
      );

      const maxPerOrder =
        target.asset === 'coin'
          ? Math.min(ec.maxCoinPerOrder, credential!.maxCoinPerOrder)
          : Math.min(ec.maxPunchPerOrder, credential!.maxPunchPerOrder);

      // 校验应战方风控额度与同对手频次
      const metrics = await this.ledger.getUserRiskMetrics(
        manager,
        user.userId,
        target.weekKey,
        now,
      );
      const sameOppCount = await this.countSameOpponentMatches(
        manager,
        target.creatorUserId,
        user.userId,
        target.asset,
        target.weekKey,
        now,
      );
      const risk = evaluateParticipantRisk({
        asset: target.asset,
        amount: target.amount,
        maxPerOrder,
        activeOrdersCount: metrics.activeOrdersCount,
        maxActiveOrders: ec.maxActiveOrdersPerUser,
        dailyCoinAbsVolume: metrics.dailyCoinAbsVolume,
        dailyCoinNetLimit: ec.dailyCoinNetLimit,
        weeklyCoinGain: metrics.weeklyCoinGain,
        weeklyCoinGainLimit: ec.weeklyCoinGainLimit,
        weeklyRecordedMinutes: metrics.weeklyRecordedMinutes,
        minRecordedMinutes: ec.punchMinRecordedMinutes,
        weeklyPunchNetMinutes: metrics.weeklyPunchNetMinutes,
        weeklyPunchGainLimit: ec.weeklyPunchGainLimit,
        weeklyPunchLossLimit: ec.weeklyPunchLossLimit,
        sameOpponentCount: sameOppCount,
        sameOpponentLimit:
          target.asset === 'coin'
            ? ec.dailyCoinSameOpponentLimit
            : ec.weeklyPunchSameOpponentLimit,
      });
      if (!risk.ok) {
        throw new BadRequestException(risk.reason);
      }

      const settleExpiresAt = new Date(now.getTime() + ec.defaultSettleTtlSeconds * 1000);
      const hold = await this.ledger.createHoldTx(
        manager,
        {
          orderId: target.id,
          appId: target.appId,
          userId: user.userId,
          asset: target.asset,
          amount: target.amount,
          weekKey: target.weekKey,
          expiresAt: settleExpiresAt,
          idempotencyKey: `wager:accept:${target.id}:${user.userId}`,
        },
        now,
      );

      let oppPart: EconomyOrderParticipantEntity;
      if (designatedOpponent) {
        designatedOpponent.holdId = hold.holdId;
        designatedOpponent.acceptedAt = now;
        oppPart = designatedOpponent;
      } else {
        oppPart = manager.create(EconomyOrderParticipantEntity, {
          orderId: target.id,
          userId: user.userId,
          role: 'opponent',
          stakeAmount: target.amount,
          holdId: hold.holdId,
          outcome: '',
          payoutDelta: 0,
          acceptedAt: now,
        });
        parts.push(oppPart);
      }
      await manager.save(EconomyOrderParticipantEntity, oppPart);

      target.status = 'locked';
      target.settleExpiresAt = settleExpiresAt;
      target.updatedAt = now;
      await manager.save(EconomyOrderEntity, target);

      return { order: target, participants: parts };
    });

    return this.toOrderDTO(order, participants);
  }

  async cancelWager(user: AuthUser, appId: string, orderId: string): Promise<{ ok: true }> {
    const now = new Date();
    await this.dataSource.transaction(async (manager) => {
      const target = await manager
        .createQueryBuilder(EconomyOrderEntity, 'o')
        .setLock('pessimistic_write')
        .where('o.id = :id AND o.app_id = :appId', { id: orderId, appId })
        .getOne();

      if (!target) {
        throw new NotFoundException('托管赌约单不存在');
      }
      if (target.status === 'cancelled' || target.status === 'refunded' || target.status === 'expired') {
        return;
      }
      if (target.status !== 'pending_accept') {
        throw new ConflictException('赌约已锁定开局，无法单方面取消');
      }

      const parts = await manager.find(EconomyOrderParticipantEntity, {
        where: { orderId: target.id },
      });
      const canCancel =
        user.isCaptain ||
        target.creatorUserId === user.userId ||
        parts.some((p) => p.userId === user.userId);
      if (!canCancel) {
        throw new ForbiddenException('无权取消该托管赌约');
      }

      await this.refundOrderTx(manager, target, parts, 'cancelled', '成员主动取消并退还筹码', now);
    });

    return { ok: true };
  }

  // ── 成员即时打赏（p2p_tip） ──

  async tipCoin(
    user: AuthUser,
    appId: string,
    input: TipCoinInput,
    viaMiniApp: boolean,
  ): Promise<EconomyOrderDTO> {
    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const ec = this.cfg.economy;

    const { order, participants } = await this.dataSource.transaction(async (manager) => {
      let maxPerOrder = ec.maxCoinPerOrder;
      if (viaMiniApp) {
        const { credential } = await this.assertAppAuthorizedForEconomy(
          manager,
          appId,
          'economy.tip',
          'coin',
          false,
        );
        if (credential && credential.status === 'active') {
          maxPerOrder = Math.min(maxPerOrder, credential.maxCoinPerOrder);
        }
      }

      const metrics = await this.ledger.getUserRiskMetrics(manager, user.userId, weekKey, now);
      const risk = evaluateParticipantRisk({
        asset: 'coin',
        amount: input.amount,
        maxPerOrder,
        activeOrdersCount: 0,
        maxActiveOrders: ec.maxActiveOrdersPerUser,
        dailyCoinAbsVolume: metrics.dailyCoinAbsVolume,
        dailyCoinNetLimit: ec.dailyCoinNetLimit,
        weeklyCoinGain: 0,
        weeklyCoinGainLimit: ec.weeklyCoinGainLimit,
      });
      if (!risk.ok) {
        throw new BadRequestException(risk.reason);
      }

      const orderId = randomUUID();
      const transfer = await this.ledger.transferCoinTx(
        manager,
        {
          orderId,
          appId,
          fromUserId: user.userId,
          toUserId: input.toUserId,
          amount: input.amount,
          title: input.note,
          weekKey,
        },
        now,
      );

      const newOrder = manager.create(EconomyOrderEntity, {
        id: orderId,
        appId,
        orderType: 'p2p_tip',
        externalMatchId: '',
        title: input.note,
        asset: 'coin',
        amount: input.amount,
        weekKey,
        status: 'settled',
        creatorUserId: user.userId,
        summary: input.note,
        acceptExpiresAt: now,
        settleExpiresAt: now,
        settledAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await manager.save(EconomyOrderEntity, newOrder);

      const parts = [
        manager.create(EconomyOrderParticipantEntity, {
          orderId,
          userId: user.userId,
          role: 'creator',
          stakeAmount: input.amount,
          holdId: null,
          outcome: 'loss',
          payoutDelta: -input.amount,
          acceptedAt: now,
        }),
        manager.create(EconomyOrderParticipantEntity, {
          orderId,
          userId: input.toUserId,
          role: 'recipient',
          stakeAmount: 0,
          holdId: null,
          outcome: 'win',
          payoutDelta: transfer.netReceived,
          acceptedAt: now,
        }),
      ];
      await manager.save(EconomyOrderParticipantEntity, parts);

      return { order: newOrder, participants: parts };
    });

    void this.hub.pushToUser(input.toUserId, {
      type: 'economy.order.settled',
      payload: this.toOrderDTO(order, participants),
    });
    return this.toOrderDTO(order, participants);
  }

  // ── 第三方小游戏后端 S2S 全要素验签结算 ──

  async settleWagerS2S(params: {
    orderId: string;
    requestPath: string;
    appIdHeader: string;
    timestampHeader: string;
    nonceHeader: string;
    signatureHeader: string;
    rawBody: Buffer;
    body: SettleWagerS2SInput;
  }): Promise<EconomyOrderDTO> {
    const appId = params.appIdHeader.trim();
    if (!appId) {
      throw new UnauthorizedException('缺少 X-Orbit-App-Id 请求头');
    }

    const cred = await this.dataSource
      .getRepository(MiniAppCredentialEntity)
      .findOne({ where: { appId } });
    if (!cred || cred.status !== 'active') {
      throw new UnauthorizedException('该应用尚未签发有效 S2S 凭证或已被吊销');
    }

    let plainSecret: string;
    try {
      plainSecret = openAppSecret(cred.secretSealed, this.cfg.economy.credentialMasterKey);
    } catch {
      throw new UnauthorizedException('应用凭证解密失败，请检查服务端主密钥配置');
    }

    const sigCheck = verifyS2SSignature(
      plainSecret,
      {
        method: 'POST',
        path: params.requestPath,
        appId,
        timestampMs: params.timestampHeader,
        nonce: params.nonceHeader,
        rawBody: params.rawBody,
      },
      params.signatureHeader,
    );
    if (!sigCheck.ok) {
      throw new UnauthorizedException(sigCheck.reason);
    }

    if (!this.nonceStore.consume(appId, params.nonceHeader.trim())) {
      throw new UnauthorizedException('检测到重复的 X-Orbit-Nonce，已拒绝重放请求');
    }

    const now = new Date();
    const currentWeekKey = getShanghaiWeekKey(now);

    const { order, participants, notifyUsers } = await this.dataSource.transaction(
      async (manager) => {
        const target = await manager
          .createQueryBuilder(EconomyOrderEntity, 'o')
          .setLock('pessimistic_write')
          .where('o.id = :id AND o.app_id = :appId', { id: params.orderId, appId })
          .getOne();

        if (!target) {
          throw new NotFoundException('托管赌约单不存在或不属于当前应用');
        }
        if (target.externalMatchId !== params.body.matchId) {
          throw new BadRequestException('结算请求 matchId 与托管单不匹配');
        }

        const parts = await manager.find(EconomyOrderParticipantEntity, {
          where: { orderId: target.id },
        });

        // 强幂等：已终态直接返回原结果
        if (target.status === 'settled' || target.status === 'refunded') {
          return { order: target, participants: parts, notifyUsers: [] as string[] };
        }
        if (target.status !== 'locked') {
          throw new ConflictException(`托管单当前状态（${target.status}）不可结算`);
        }

        // punch_minutes 若跨周未结，强制流局退还（防跨周套利）
        const crossWeekPunch =
          target.asset === 'punch_minutes' && target.weekKey !== currentWeekKey;
        const isRefund =
          crossWeekPunch ||
          params.body.result === 'draw' ||
          params.body.result === 'refund' ||
          !params.body.winnerUserId;

        if (isRefund) {
          const reasonText = crossWeekPunch
            ? '跨考核周自动流局退还'
            : params.body.summary || '和棋/流局自动退还';
          await this.refundOrderTx(manager, target, parts, 'refunded', reasonText, now);
          return {
            order: target,
            participants: parts,
            notifyUsers: parts.map((p) => p.userId),
          };
        }

        const winnerPart = parts.find((p) => p.userId === params.body.winnerUserId);
        const loserPart = parts.find((p) => p.userId !== params.body.winnerUserId);
        if (!winnerPart || !loserPart) {
          throw new BadRequestException('胜者必须是本局已锁定的参与成员之一');
        }

        const res = await this.ledger.settleEscrowWagerTx(
          manager,
          {
            orderId: target.id,
            appId: target.appId,
            title: target.title,
            asset: target.asset,
            amount: target.amount,
            weekKey: target.weekKey,
            winnerUserId: winnerPart.userId,
            loserUserId: loserPart.userId,
            winnerHoldId: winnerPart.holdId,
            loserHoldId: loserPart.holdId,
          },
          now,
        );

        winnerPart.outcome = 'win';
        winnerPart.payoutDelta = res.winnerNetDelta;
        loserPart.outcome = 'loss';
        loserPart.payoutDelta = res.loserDelta;
        await manager.save(EconomyOrderParticipantEntity, [winnerPart, loserPart]);

        target.status = 'settled';
        target.summary = params.body.summary ?? '';
        target.settledAt = now;
        target.updatedAt = now;
        await manager.save(EconomyOrderEntity, target);

        return {
          order: target,
          participants: parts,
          notifyUsers: [winnerPart.userId, loserPart.userId],
        };
      },
    );

    const dto = this.toOrderDTO(order, participants);
    for (const uid of notifyUsers) {
      void this.hub.pushToUser(uid, { type: 'economy.order.settled', payload: dto });
    }
    return dto;
  }

  // ── 队长管理：密钥签发/轮换/吊销 & 仲裁退款 ──

  async issueOrRotateCredential(
    captain: AuthUser,
    appId: string,
    input: IssueCredentialInput,
  ): Promise<{
    appId: string;
    secret: string;
    secretPrefix: string;
    allowedAssets: EconomyAsset[];
    maxCoinPerOrder: number;
    maxPunchPerOrder: number;
    dailyOrderLimit: number;
    status: string;
    rotatedAt: Date;
  }> {
    const app = await this.dataSource.getRepository(MiniAppEntity).findOne({
      where: { id: appId },
    });
    if (!app) {
      throw new NotFoundException('工坊应用不存在');
    }

    const now = new Date();
    const { plain, prefix } = generateAppSecret();
    const sealed = sealAppSecret(plain, this.cfg.economy.credentialMasterKey);

    const repo = this.dataSource.getRepository(MiniAppCredentialEntity);
    const existing = await repo.findOne({ where: { appId } });

    const record = repo.create({
      appId,
      secretSealed: sealed,
      secretPrefix: prefix,
      allowedAssets: input.allowedAssets,
      maxCoinPerOrder: input.maxCoinPerOrder,
      maxPunchPerOrder: input.maxPunchPerOrder,
      dailyOrderLimit: input.dailyOrderLimit,
      status: 'active',
      rotatedAt: now,
      createdBy: existing?.createdBy ?? captain.userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await repo.save(record);

    return {
      appId,
      secret: plain, // 明文仅在签发/轮换本次响应中返回一次
      secretPrefix: prefix,
      allowedAssets: record.allowedAssets,
      maxCoinPerOrder: record.maxCoinPerOrder,
      maxPunchPerOrder: record.maxPunchPerOrder,
      dailyOrderLimit: record.dailyOrderLimit,
      status: record.status,
      rotatedAt: record.rotatedAt,
    };
  }

  async revokeCredential(appId: string): Promise<{ ok: true; appId: string; status: 'revoked' }> {
    const repo = this.dataSource.getRepository(MiniAppCredentialEntity);
    const cred = await repo.findOne({ where: { appId } });
    if (!cred) {
      throw new NotFoundException('该应用尚未签发交易凭证');
    }
    cred.status = 'revoked';
    cred.updatedAt = new Date();
    await repo.save(cred);
    return { ok: true, appId, status: 'revoked' };
  }

  async listCredentials(): Promise<
    Array<{
      appId: string;
      secretPrefix: string;
      allowedAssets: EconomyAsset[];
      maxCoinPerOrder: number;
      maxPunchPerOrder: number;
      dailyOrderLimit: number;
      status: string;
      rotatedAt: Date;
    }>
  > {
    const rows = await this.dataSource
      .getRepository(MiniAppCredentialEntity)
      .find({ order: { updatedAt: 'DESC' } });
    return rows.map((r) => ({
      appId: r.appId,
      secretPrefix: r.secretPrefix,
      allowedAssets: r.allowedAssets,
      maxCoinPerOrder: r.maxCoinPerOrder,
      maxPunchPerOrder: r.maxPunchPerOrder,
      dailyOrderLimit: r.dailyOrderLimit,
      status: r.status,
      rotatedAt: r.rotatedAt,
    }));
  }

  /** 队长强制仲裁流局退款（处理小游戏服务端宕机或恶意判负等异常订单）。 */
  async adminForceRefund(orderId: string, note: string): Promise<EconomyOrderDTO> {
    const now = new Date();
    const { order, participants } = await this.dataSource.transaction(async (manager) => {
      const target = await manager
        .createQueryBuilder(EconomyOrderEntity, 'o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: orderId })
        .getOne();

      if (!target) {
        throw new NotFoundException('订单不存在');
      }
      if (target.status !== 'pending_accept' && target.status !== 'locked') {
        throw new ConflictException(`订单当前状态为 ${target.status}，无法强制解冻`);
      }

      const parts = await manager.find(EconomyOrderParticipantEntity, {
        where: { orderId: target.id },
      });
      await this.refundOrderTx(
        manager,
        target,
        parts,
        'refunded',
        note.trim() || '队长仲裁流局退款',
        now,
      );
      return { order: target, participants: parts };
    });

    const dto = this.toOrderDTO(order, participants);
    for (const p of participants) {
      void this.hub.pushToUser(p.userId, { type: 'economy.order.settled', payload: dto });
    }
    return dto;
  }

  /** 成员查看自己参与的托管单与交易单列表。 */
  async listUserOrders(userId: string, limit = 50): Promise<EconomyOrderDTO[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const orderRows = await this.dataSource
      .getRepository(EconomyOrderEntity)
      .createQueryBuilder('o')
      .innerJoin(
        EconomyOrderParticipantEntity,
        'p',
        'p.order_id = o.id AND p.user_id = :userId',
        { userId },
      )
      .orderBy('o.created_at', 'DESC')
      .take(safeLimit)
      .getMany();

    if (orderRows.length === 0) return [];

    const orderIds = orderRows.map((o) => o.id);
    const allParts = await this.dataSource
      .getRepository(EconomyOrderParticipantEntity)
      .createQueryBuilder('p')
      .where('p.order_id IN (:...ids)', { ids: orderIds })
      .getMany();

    const byOrder = new Map<string, EconomyOrderParticipantEntity[]>();
    for (const p of allParts) {
      const list = byOrder.get(p.orderId) ?? [];
      list.push(p);
      byOrder.set(p.orderId, list);
    }

    return orderRows.map((o) => this.toOrderDTO(o, byOrder.get(o.id) ?? []));
  }

  /**
   * 定时扫描并回收所有超时未应战（pending_accept）、超时未结算（locked）以及跨周未结的 punch_minutes 订单，
   * 彻底消除冻结资金永久卡死风险。
   */
  async reapExpiredOrders(): Promise<number> {
    const now = new Date();
    const currentWeekKey = getShanghaiWeekKey(now);

    const candidates = await this.dataSource
      .getRepository(EconomyOrderEntity)
      .createQueryBuilder('o')
      .where(
        `(o.status = 'pending_accept' AND o.accept_expires_at <= :now)
         OR (o.status = 'locked' AND o.settle_expires_at IS NOT NULL AND o.settle_expires_at <= :now)
         OR (o.status IN ('pending_accept', 'locked') AND o.asset = 'punch_minutes' AND o.week_key <> :weekKey)`,
        { now, weekKey: currentWeekKey },
      )
      .take(50)
      .getMany();

    let reaped = 0;
    for (const cand of candidates) {
      try {
        await this.dataSource.transaction(async (manager) => {
          const target = await manager
            .createQueryBuilder(EconomyOrderEntity, 'o')
            .setLock('pessimistic_write')
            .where('o.id = :id', { id: cand.id })
            .getOne();

          if (!target || (target.status !== 'pending_accept' && target.status !== 'locked')) {
            return;
          }
          const parts = await manager.find(EconomyOrderParticipantEntity, {
            where: { orderId: target.id },
          });
          const reason =
            target.status === 'pending_accept'
              ? '超时未应战自动解冻退还'
              : '对局超时未收到裁判结算，自动流局退还';
          await this.refundOrderTx(manager, target, parts, 'expired', reason, now);
          reaped += 1;
        });
      } catch (err) {
        this.logger.warn(
          `自动回收超时托管单 ${cand.id} 失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return reaped;
  }

  private async refundOrderTx(
    manager: EntityManager,
    order: EconomyOrderEntity,
    parts: EconomyOrderParticipantEntity[],
    nextStatus: 'cancelled' | 'refunded' | 'expired',
    summary: string,
    now: Date,
  ): Promise<void> {
    const sortedParts = [...parts].sort((a, b) => a.userId.localeCompare(b.userId));
    for (const p of sortedParts) {
      if (p.holdId) {
        await this.ledger.releaseHoldTx(manager, p.holdId, now);
      }
      p.outcome = 'refund';
      p.payoutDelta = 0;
      await manager.save(EconomyOrderParticipantEntity, p);
    }

    order.status = nextStatus;
    order.summary = summary;
    order.settledAt = now;
    order.updatedAt = now;
    await manager.save(EconomyOrderEntity, order);
  }

  private toOrderDTO(
    order: EconomyOrderEntity,
    participants: EconomyOrderParticipantEntity[],
  ): EconomyOrderDTO {
    const opponent = participants.find((p) => p.role === 'opponent' || p.role === 'recipient');
    const winner = participants.find((p) => p.outcome === 'win');
    const loser = participants.find((p) => p.outcome === 'loss');

    return {
      orderId: order.id,
      appId: order.appId,
      orderType: order.orderType,
      matchId: order.externalMatchId,
      title: order.title,
      asset: order.asset,
      amount: order.amount,
      weekKey: order.weekKey,
      status: order.status,
      creatorUserId: order.creatorUserId,
      opponentUserId: opponent?.userId,
      winnerUserId: winner?.userId,
      loserUserId: loser?.userId,
      summary: order.summary || undefined,
      acceptExpiresAt: order.acceptExpiresAt.getTime(),
      settleExpiresAt: order.settleExpiresAt?.getTime(),
      settledAt: order.settledAt?.getTime(),
      createdAt: order.createdAt.getTime(),
      participants: participants.map((p) => ({
        userId: p.userId,
        role: p.role,
        stakeAmount: p.stakeAmount,
        outcome: p.outcome,
        payoutDelta: p.payoutDelta,
        acceptedAt: p.acceptedAt?.toISOString(),
      })),
    };
  }
}
