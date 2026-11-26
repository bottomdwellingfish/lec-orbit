/**
 * Orbit FaaS（方案 E）外部用户与开发者接口：
 * - POST /api/v1/apps/:id/fn/:fnName：调用工坊托管云函数（支持普通 JSON 与 SSE 流式透传）；
 * - POST /api/v1/apps/:id/realtime/rooms/:roomId/(join|leave)：订阅或退出房间实时推送；
 * - GET /api/v1/apps/:id/versions/:versionId/functions：作者/队长审核查看云函数源码；
 * - GET /api/v1/apps/:id/functions/logs：作者/队长查看最近 200 条云函数运行日志；
 * - GET/PUT/DELETE /api/v1/apps/:id/secrets：作者/队长自助配置 AES-256-GCM 加密环境变量。
 */
import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { FunctionsService } from './functions.service.js';

const UuidSchema = z.string().uuid('无效的版本 ID');
const UpsertSecretSchema = z.object({
  value: z.string().min(1, '环境变量值不能为空').max(4096),
});

@Controller('api/v1/apps/:id')
@UseGuards(SsoAuthGuard)
export class FunctionsController {
  constructor(private readonly service: FunctionsService) {}

  @Post('fn/:fnName')
  async invokeFunction(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('fnName') fnName: string,
    @Query('versionId') previewVersionId: string | undefined,
    @Body() rawBody: unknown,
    @Res() res: ServerResponse,
  ) {
    const result = await this.service.invokeFunction(
      user,
      appId.trim(),
      fnName.trim(),
      rawBody,
      previewVersionId?.trim() ? { previewVersionId: UuidSchema.parse(previewVersionId.trim()) } : undefined,
    );

    res.statusCode = result.status;
    res.setHeader('Content-Type', result.contentType);

    if (result.isStream && result.bodyStream) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      const reader = result.bodyStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
        res.end();
      }
      return;
    }

    res.end(result.bodyText ?? '{}');
  }

  @Post('realtime/rooms/:roomId/join')
  @HttpCode(HttpStatus.OK)
  joinRoom(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('roomId') roomId: string,
  ) {
    return this.service.joinRealtimeRoom(user, appId.trim(), roomId.trim());
  }

  @Post('realtime/rooms/:roomId/leave')
  @HttpCode(HttpStatus.OK)
  leaveRoom(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('roomId') roomId: string,
  ) {
    return this.service.leaveRealtimeRoom(user, appId.trim(), roomId.trim());
  }

  @Get('versions/:versionId/functions')
  getVersionFunctions(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.service.getVersionFunctionsSource(
      user,
      appId.trim(),
      UuidSchema.parse(versionId.trim()),
    );
  }

  @Get('functions/logs')
  getLogs(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) || 50 : 50;
    return this.service.getInvocationLogs(user, appId.trim(), limit);
  }

  @Get('secrets')
  listSecrets(@CurrentUser() user: AuthUser, @Param('id') appId: string) {
    return this.service.listSecrets(user, appId.trim());
  }

  @Put('secrets/:name')
  @HttpCode(HttpStatus.OK)
  upsertSecret(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('name') name: string,
    @Body() rawBody: unknown,
  ) {
    const body = UpsertSecretSchema.parse(rawBody ?? {});
    return this.service.upsertSecret(user, appId.trim(), name.trim(), body.value);
  }

  @Delete('secrets/:name')
  @HttpCode(HttpStatus.OK)
  deleteSecret(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('name') name: string,
  ) {
    return this.service.deleteSecret(user, appId.trim(), name.trim());
  }
}
