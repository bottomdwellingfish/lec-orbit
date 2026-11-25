/**
 * 工坊第三方小游戏权威后端 S2S 结算回调入口（一应用一密钥 HMAC-SHA256 + Nonce 防重放）。
 */
import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { EconomyGatewayService } from './economy-gateway.service.js';
import { SettleWagerS2SSchema } from './economy.types.js';

const UuidSchema = z.string().uuid('无效的订单 ID');

@Controller('api/miniapps/economy/orders')
export class EconomyS2SController {
  constructor(private readonly gateway: EconomyGatewayService) {}

  @Post(':orderId/settle')
  @HttpCode(HttpStatus.OK)
  async settleOrder(
    @Param('orderId') rawOrderId: string,
    @Headers('x-orbit-app-id') appIdHeader: string | undefined,
    @Headers('x-orbit-timestamp') timestampHeader: string | undefined,
    @Headers('x-orbit-nonce') nonceHeader: string | undefined,
    @Headers('x-orbit-signature') signatureHeader: string | undefined,
    @Req() req: { rawBody?: Buffer; url?: string },
    @Body() rawJsonBody: unknown,
  ) {
    const orderId = UuidSchema.parse(rawOrderId.trim());
    const parsedBody = SettleWagerS2SSchema.parse(rawJsonBody);
    const rawBody = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : Buffer.from(JSON.stringify(rawJsonBody ?? {}), 'utf8');
    const requestPath = (req.url ?? `/api/miniapps/economy/orders/${orderId}/settle`).split('?')[0];

    return this.gateway.settleWagerS2S({
      orderId,
      requestPath,
      appIdHeader: appIdHeader ?? '',
      timestampHeader: timestampHeader ?? '',
      nonceHeader: nonceHeader ?? '',
      signatureHeader: signatureHeader ?? '',
      rawBody,
      body: parsedBody,
    });
  }
}
