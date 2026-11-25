import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EconomyGatewayService } from './economy-gateway.service.js';

/** 定时调度器：每分钟自动扫描并解冻退还超时未应战 / 超时未结算 / 跨周未结的托管单。 */
@Injectable()
export class EconomyReaperService {
  private readonly logger = new Logger(EconomyReaperService.name);
  private running = false;

  constructor(private readonly gateway: EconomyGatewayService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleReap(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const count = await this.gateway.reapExpiredOrders();
      if (count > 0) {
        this.logger.log(`自动解冻退还 ${count} 笔超时托管单`);
      }
    } catch (err) {
      this.logger.warn(
        `定时回收超时托管单异常: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
