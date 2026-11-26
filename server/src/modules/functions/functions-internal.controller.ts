/**
 * Orbit FaaS 内网通信与上下文能力桥接控制器：
 * - /internal/v1/functions/bundle/:appId/:versionId（InternalTokenGuard）：供 edge-runtime 主路由按需拉取函数包；
 * - /internal/v1/fn-bridge/*（15s 单次上下文 JWT 鉴权）：供隔离 User Worker 回连使用 5 大平台能力。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { InternalTokenGuard } from '../../common/guards/internal-token.guard.js';
import { InternalSettleWagerSchema } from '../economy/economy.types.js';
import { FunctionsService } from './functions.service.js';

const UuidSchema = z.string().uuid('无效的 UUID');

const RoomStateSetSchema = z.object({
  value: z.unknown(),
  ttlSeconds: z.number().int().min(10).max(86_400).optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

const RealtimeUserSchema = z.object({
  targetUserId: z.string().trim().min(1).max(64),
  event: z.string().trim().min(1).max(64),
  payload: z.unknown().optional(),
});

const RealtimeRoomSchema = z.object({
  roomId: z.string().trim().min(1).max(64),
  event: z.string().trim().min(1).max(64),
  payload: z.unknown().optional(),
});

@Controller('internal/v1/functions')
@UseGuards(InternalTokenGuard)
export class FunctionsInternalBundleController {
  constructor(private readonly service: FunctionsService) {}

  @Get('bundle/:appId/:versionId')
  getBundle(@Param('appId') appId: string, @Param('versionId') versionId: string) {
    return this.service.getInternalBundle(appId.trim(), UuidSchema.parse(versionId.trim()));
  }
}

@Controller('internal/v1/fn-bridge')
export class FunctionsBridgeController {
  constructor(private readonly service: FunctionsService) {}

  private auth(tokenHeader: string | undefined) {
    return this.service.verifyBridgeToken(tokenHeader ?? '');
  }

  @Get('room-state/:roomId')
  getRoomState(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('roomId') roomId: string,
  ) {
    return this.service.bridgeRoomStateGet(this.auth(token), roomId.trim());
  }

  @Put('room-state/:roomId')
  @HttpCode(HttpStatus.OK)
  setRoomState(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('roomId') roomId: string,
    @Body() rawBody: unknown,
  ) {
    const body = RoomStateSetSchema.parse(rawBody ?? {});
    return this.service.bridgeRoomStateSet(this.auth(token), roomId.trim(), body);
  }

  @Delete('room-state/:roomId')
  @HttpCode(HttpStatus.OK)
  delRoomState(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('roomId') roomId: string,
  ) {
    return this.service.bridgeRoomStateDel(this.auth(token), roomId.trim());
  }

  @Post('realtime/user')
  @HttpCode(HttpStatus.OK)
  sendToUser(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const body = RealtimeUserSchema.parse(rawBody ?? {});
    return this.service.bridgeRealtimeSendToUser(this.auth(token), body);
  }

  @Post('realtime/room')
  @HttpCode(HttpStatus.OK)
  broadcastRoom(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Body() rawBody: unknown,
  ) {
    const body = RealtimeRoomSchema.parse(rawBody ?? {});
    return this.service.bridgeRealtimeBroadcastRoom(this.auth(token), body);
  }

  @Get('kv')
  listKvKeys(@Headers('x-orbit-fn-context-token') token: string | undefined) {
    return this.service.bridgeKvListKeys(this.auth(token));
  }

  @Get('kv/:key')
  getKv(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('key') key: string,
  ) {
    return this.service.bridgeKvGet(this.auth(token), key.trim());
  }

  @Put('kv/:key')
  @HttpCode(HttpStatus.OK)
  setKv(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('key') key: string,
    @Body() rawBody: { value?: unknown },
  ) {
    return this.service.bridgeKvSet(this.auth(token), key.trim(), rawBody?.value ?? null);
  }

  @Delete('kv/:key')
  @HttpCode(HttpStatus.OK)
  delKv(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('key') key: string,
  ) {
    return this.service.bridgeKvDel(this.auth(token), key.trim());
  }

  @Get('economy/wagers/:orderId')
  getWager(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('orderId') orderId: string,
  ) {
    return this.service.bridgeEconomyGetWager(this.auth(token), UuidSchema.parse(orderId.trim()));
  }

  @Post('economy/wagers/:orderId/settle')
  @HttpCode(HttpStatus.OK)
  settleWager(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('orderId') orderId: string,
    @Body() rawBody: unknown,
  ) {
    const body = InternalSettleWagerSchema.parse(rawBody ?? {});
    return this.service.bridgeEconomySettleWager(
      this.auth(token),
      UuidSchema.parse(orderId.trim()),
      body,
    );
  }

  @Get('secrets/:name')
  getSecret(
    @Headers('x-orbit-fn-context-token') token: string | undefined,
    @Param('name') name: string,
  ) {
    return this.service.bridgeSecretGet(this.auth(token), name.trim());
  }
}
