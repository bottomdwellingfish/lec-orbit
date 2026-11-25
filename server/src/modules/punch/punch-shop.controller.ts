/**
 * 皮肤商城模块（PostgreSQL TypeORM 版 + 统一 coin 乐币扣减）：
 * 承接原 LecPunch `/shop/unlocks` 与 `/shop/unlock`，保持 100% 路由与响应字段兼容。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import { PunchSkinUnlockEntity } from './entities/punch-collab.entities.js';
import { PunchPointLedgerEntity } from './entities/punch-attendance.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';
import { newObjectIdHex } from './punch-shared.util.js';

const SKIN_PRICE_COINS = 600;
const SKIN_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const UnlockSkinSchema = z.object({
  skinId: z.string().trim().regex(SKIN_ID_REGEX, 'skinId 格式非法'),
});

@Controller('shop')
@UseGuards(PunchAuthGuard)
export class PunchShopController {
  constructor(
    @InjectRepository(PunchSkinUnlockEntity)
    private readonly skinRepo: Repository<PunchSkinUnlockEntity>,
    @InjectRepository(PunchPointLedgerEntity)
    private readonly pointRepo: Repository<PunchPointLedgerEntity>,
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    private readonly economyLedger: EconomyLedgerService,
  ) {}

  @Get('unlocks')
  async getUnlocks(@PunchCurrentUser() user: PunchAuthUser) {
    const unlocks = await this.skinRepo.find({
      where: { userId: user.userId },
      order: { skinId: 'ASC' },
    });
    return { skinIds: unlocks.map((u) => u.skinId) };
  }

  @Post('unlock')
  async unlock(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const { skinId } = UnlockSkinSchema.parse(rawBody);
    const dbUser = await this.userRepo.findOne({ where: { id: user.userId } });
    const economyUserId = dbUser?.logtoUserId?.trim() || user.ssoSub || user.userId;

    const existing = await this.skinRepo.findOne({
      where: { userId: user.userId, skinId },
    });
    if (existing) {
      const wallet = await this.economyLedger.getWalletSummary(economyUserId);
      return {
        skinId: existing.skinId,
        unlockedAt: existing.unlockedAt.toISOString(),
        alreadyUnlocked: true,
        pricePoints: SKIN_PRICE_COINS,
        totalPoints: wallet.coinBalance,
      };
    }

    const walletBefore = await this.economyLedger.getWalletSummary(economyUserId);
    if (walletBefore.coinBalance < SKIN_PRICE_COINS) {
      throw new BadRequestException({
        code: 'SHOP_INSUFFICIENT_POINTS',
        message: `解锁皮肤需要至少 ${SKIN_PRICE_COINS} 乐币`,
        requiredPoints: SKIN_PRICE_COINS,
        totalPoints: walletBefore.coinBalance,
      });
    }

    const now = new Date();
    const weekKey = getShanghaiWeekKey(now);
    const idempotencyKey = `punch:skin-unlock:${user.userId}:${skinId}`;

    await this.economyLedger.spendCoins({
      userId: economyUserId,
      amount: SKIN_PRICE_COINS,
      appId: 'lec-punch-shop',
      reason: 'shop_spend',
      title: `解锁皮肤 ${skinId}`,
      idempotencyKey,
    });

    // 同步记入历史积分明细表，保持旧面板流水口径一致
    await this.pointRepo
      .createQueryBuilder()
      .insert()
      .into(PunchPointLedgerEntity)
      .values({
        id: newObjectIdHex(),
        teamId: user.teamId,
        userId: user.userId,
        sourceType: 'skin_unlock',
        sourceAttendanceSessionId: `skin:${user.userId}:${skinId}`,
        weekKey,
        points: -SKIN_PRICE_COINS,
        createdAt: now,
        updatedAt: now,
      })
      .orIgnore()
      .execute();

    await this.skinRepo
      .createQueryBuilder()
      .insert()
      .into(PunchSkinUnlockEntity)
      .values({
        id: newObjectIdHex(),
        userId: user.userId,
        skinId,
        unlockedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .orIgnore()
      .execute();

    const saved = await this.skinRepo.findOneOrFail({
      where: { userId: user.userId, skinId },
    });
    const walletAfter = await this.economyLedger.getWalletSummary(economyUserId);

    return {
      skinId: saved.skinId,
      unlockedAt: saved.unlockedAt.toISOString(),
      alreadyUnlocked: false,
      pricePoints: SKIN_PRICE_COINS,
      totalPoints: walletAfter.coinBalance,
    };
  }
}
