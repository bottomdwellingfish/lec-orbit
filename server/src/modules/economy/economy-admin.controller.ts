/**
 * 队长管理端 Economy 控制接口（需同时通过 LecSSO 鉴权 + 队长权限守卫）：
 * - 一应用一密钥签发、轮换、列表、一键吊销；
 * - 异常托管订单强制仲裁退款；
 * - 工作室活动手动发奖（带审计理由）。
 */
import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireCaptain } from '../../common/decorators/require-captain.decorator.js';
import { CaptainGuard } from '../../common/guards/captain.guard.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { EconomyGatewayService } from './economy-gateway.service.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import { IssueCredentialSchema } from './economy.types.js';

const UuidSchema = z.string().uuid('无效的订单 ID');

const AdminGrantSchema = z.object({
  userId: z.string().trim().min(1, '缺少目标成员 userId').max(64),
  amount: z.number().int().min(1).max(10_000),
  title: z.string().trim().min(1, '请填写发奖理由（将记入公开审计账单）').max(120),
});

const AdminRefundSchema = z.object({
  note: z.string().trim().max(200).optional(),
});

@Controller('api/v1/admin/economy')
@UseGuards(SsoAuthGuard, CaptainGuard)
@RequireCaptain()
export class EconomyAdminController {
  constructor(
    private readonly gateway: EconomyGatewayService,
    private readonly ledger: EconomyLedgerService,
  ) {}

  @Get('credentials')
  async listCredentials() {
    const items = await this.gateway.listCredentials();
    return { items };
  }

  @Post('apps/:appId/credential')
  @HttpCode(HttpStatus.OK)
  issueOrRotateCredential(
    @CurrentUser() captain: AuthUser,
    @Param('appId') appId: string,
    @Body() rawBody: unknown,
  ) {
    const input = IssueCredentialSchema.parse(rawBody);
    return this.gateway.issueOrRotateCredential(captain, appId.trim(), input);
  }

  @Delete('apps/:appId/credential')
  @HttpCode(HttpStatus.OK)
  revokeCredential(@Param('appId') appId: string) {
    return this.gateway.revokeCredential(appId.trim());
  }

  @Post('orders/:orderId/refund')
  @HttpCode(HttpStatus.OK)
  forceRefundOrder(@Param('orderId') orderId: string, @Body() rawBody: unknown) {
    const body = AdminRefundSchema.parse(rawBody ?? {});
    return this.gateway.adminForceRefund(UuidSchema.parse(orderId.trim()), body.note ?? '');
  }

  @Post('grant')
  @HttpCode(HttpStatus.CREATED)
  grantActivityCoins(@CurrentUser() captain: AuthUser, @Body() rawBody: unknown) {
    const input = AdminGrantSchema.parse(rawBody);
    return this.ledger.mintCoins({
      userId: input.userId,
      amount: input.amount,
      reason: 'admin_grant',
      title: `${input.title}（发奖人：${captain.displayName || captain.username}）`,
      idempotencyKey: `admin-grant:${randomUUID()}`,
      appId: 'orbit-admin',
    });
  }
}
