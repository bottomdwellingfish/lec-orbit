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
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InternalTokenGuard } from '../../common/guards/internal-token.guard.js';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import { InternalMintSchema, InternalSpendSchema } from './economy.types.js';

@Controller('internal/v1/economy')
@UseGuards(InternalTokenGuard)
export class EconomyInternalController {
  constructor(private readonly ledger: EconomyLedgerService) {}

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
}
