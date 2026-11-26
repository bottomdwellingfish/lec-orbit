/**
 * 内部服务总线 Economy 接口（/internal/v1/economy/*，仅限受内网 Token 保护的 LecPunch/平台内部服务调用）：
 * - mint：打卡签退产出 coin、狂热 +10% 加成、存量 totalPoints 1:1 迁移初始化；
 * - spend：卡牌工坊付费抽卡、兑换站消费 coin；
 * - weekly-trade-minutes：供 LecPunch 周统计与周考核聚合工坊交易增减时长。
 */
import {
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
import { InternalTokenGuard } from '../../common/guards/internal-token.guard.js';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { EconomyGatewayService } from './economy-gateway.service.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import {
  InternalDisputeWagerSchema,
  InternalMintSchema,
  InternalSettleWagerSchema,
  InternalSpendSchema,
} from './economy.types.js';

const UuidSchema = z.string().uuid('无效的订单 ID');

@Controller('internal/v1/economy')
@UseGuards(InternalTokenGuard)
export class EconomyInternalController {
  constructor(
    private readonly ledger: EconomyLedgerService,
    private readonly gateway: EconomyGatewayService,
  ) {}

  @Post('mint')
  @HttpCode(HttpStatus.OK)
  mint(@Body() rawBody: unknown) {
    const input = InternalMintSchema.parse(rawBody);
    return this.ledger.mintCoins(input);
  }

  @Post('spend')
  @HttpCode(HttpStatus.OK)
  spend(@Body() rawBody: unknown) {
    const input = InternalSpendSchema.parse(rawBody);
    return this.ledger.spendCoins(input);
  }

  @Get('wallet')
  getWallet(@Query('userId') userId: string) {
    return this.ledger.getWalletSummary((userId ?? '').trim());
  }

  @Get('weekly-trade-minutes')
  getWeeklyTradeMinutes(@Query('weekKey') weekKey?: string) {
    const key = weekKey?.trim() || getShanghaiWeekKey(new Date());
    return this.ledger.getWeeklyTradeMinutesSummary(key);
  }

  /** 供 Nakama 通用赌约房插件在建房前核验订单状态与参与双方身份。 */
  @Get('wagers/:orderId')
  getWager(@Param('orderId') orderId: string) {
    return this.gateway.getWagerInternal(UuidSchema.parse(orderId.trim()));
  }

  /** 供 Nakama 通用赌约房插件在双端共识、认输或掉线超时后触发原子结算。 */
  @Post('wagers/:orderId/settle')
  @HttpCode(HttpStatus.OK)
  settleWager(@Param('orderId') orderId: string, @Body() rawBody: unknown) {
    const input = InternalSettleWagerSchema.parse(rawBody ?? {});
    return this.gateway.settleWagerInternal(UuidSchema.parse(orderId.trim()), input);
  }

  /** 供 Nakama 通用赌约房插件在双方上报结果冲突时挂起订单进入队长仲裁队列。 */
  @Post('wagers/:orderId/dispute')
  @HttpCode(HttpStatus.OK)
  disputeWager(@Param('orderId') orderId: string, @Body() rawBody: unknown) {
    const input = InternalDisputeWagerSchema.parse(rawBody ?? {});
    return this.gateway.disputeWagerInternal(UuidSchema.parse(orderId.trim()), input);
  }
}
