/**
 * 成员端 & 工坊应用端 Economy 接口（需通过 LecSSO SsoAuthGuard 鉴权）。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { EconomyGatewayService } from './economy-gateway.service.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import { CreateWagerSchema, EconomyAssetSchema, TipCoinSchema } from './economy.types.js';

const UuidSchema = z.string().uuid('无效的订单 ID');

@Controller('api/v1')
@UseGuards(SsoAuthGuard)
export class EconomyController {
  constructor(
    private readonly ledger: EconomyLedgerService,
    private readonly gateway: EconomyGatewayService,
  ) {}

  // ── 成员原生钱包与公开透明账单 ──

  @Get('economy/wallet')
  getMyWallet(@CurrentUser() user: AuthUser) {
    return this.ledger.getWalletSummary(user.userId);
  }

  @Get('economy/ledger')
  async getMyLedger(
    @CurrentUser() user: AuthUser,
    @Query('asset') rawAsset?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const asset = rawAsset?.trim() ? EconomyAssetSchema.parse(rawAsset.trim()) : undefined;
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
    const items = await this.ledger.listLedger(user.userId, {
      asset,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return { items };
  }

  @Get('economy/orders')
  async getMyOrders(@CurrentUser() user: AuthUser, @Query('limit') rawLimit?: string) {
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
    const items = await this.gateway.listUserOrders(
      user.userId,
      Number.isFinite(limit) ? limit : 50,
    );
    return { items };
  }

  @Post('economy/tip')
  @HttpCode(HttpStatus.CREATED)
  tipDirect(@CurrentUser() user: AuthUser, @Body() rawBody: unknown) {
    const input = TipCoinSchema.parse(rawBody);
    return this.gateway.tipCoin(user, 'orbit-native', input, false);
  }

  // ── 工坊应用沙箱经 Electron 主进程代理调用的受控接口 ──

  @Get('apps/:id/economy/wallet')
  getAppWallet(@CurrentUser() user: AuthUser) {
    return this.ledger.getWalletSummary(user.userId);
  }

  @Post('apps/:id/economy/wagers')
  @HttpCode(HttpStatus.CREATED)
  createAppWager(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Body() rawBody: unknown,
  ) {
    const cleanAppId = appId.trim();
    if (!cleanAppId) throw new BadRequestException('缺少应用 ID');
    const input = CreateWagerSchema.parse(rawBody);
    return this.gateway.createWager(user, cleanAppId, input);
  }

  @Get('apps/:id/economy/wagers/:orderId')
  getAppWager(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.gateway.getWager(user, appId.trim(), UuidSchema.parse(orderId.trim()));
  }

  @Post('apps/:id/economy/wagers/:orderId/accept')
  @HttpCode(HttpStatus.OK)
  acceptAppWager(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.gateway.acceptWager(user, appId.trim(), UuidSchema.parse(orderId.trim()));
  }

  @Post('apps/:id/economy/wagers/:orderId/cancel')
  @HttpCode(HttpStatus.OK)
  cancelAppWager(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.gateway.cancelWager(user, appId.trim(), UuidSchema.parse(orderId.trim()));
  }

  @Post('apps/:id/economy/tip')
  @HttpCode(HttpStatus.CREATED)
  tipFromMiniApp(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Body() rawBody: unknown,
  ) {
    const cleanAppId = appId.trim();
    if (!cleanAppId) throw new BadRequestException('缺少应用 ID');
    const input = TipCoinSchema.parse(rawBody);
    return this.gateway.tipCoin(user, cleanAppId, input, true);
  }
}
