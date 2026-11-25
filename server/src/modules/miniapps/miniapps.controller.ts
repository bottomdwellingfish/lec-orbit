import {
  BadRequestException,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-node';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireCaptain } from '../../common/decorators/require-captain.decorator.js';
import { CaptainGuard } from '../../common/guards/captain.guard.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { MINIAPP_MAX_BUNDLE_BYTES, type MiniAppManifest } from './miniapp-validator.util.js';
import { MiniAppsService } from './miniapps.service.js';

const UuidSchema = z.string().uuid('无效的版本 ID');

const ReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().optional(),
});

const StatusUpdateSchema = z.object({
  status: z.string().optional(),
  activeVersionId: z.string().uuid('无效的版本 ID').optional(),
});

const ImportGitHubSchema = z.object({
  bundleUrl: z.string().trim().min(1, '导入参数不完整'),
  bundleSha256: z.string().trim().min(1, '导入参数不完整'),
  bundleSize: z.number().int().min(0).optional(),
  iconUrl: z.string().optional(),
  channel: z.string().optional(),
  changelog: z.string().optional(),
  directPublish: z.boolean().optional(),
  manifest: z.record(z.string(), z.unknown()),
});

interface UploadedBinaryFile {
  buffer?: Buffer;
}

@Controller('api/v1/apps')
@UseGuards(SsoAuthGuard, CaptainGuard)
export class MiniAppsController {
  constructor(private readonly service: MiniAppsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('type') type?: string,
    @Query('engine') engine?: string,
    @Query('q') q?: string,
    @Query('mine') mine?: string,
    @Query('pending') pending?: string,
  ) {
    const items = await this.service.list(user, {
      type: type?.trim(),
      engine: engine?.trim(),
      q,
      mine: mine === '1' || mine === 'true',
      pending: pending === '1' || pending === 'true',
    });
    return { items };
  }

  @Get(':id')
  getDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getDetail(user, id.trim());
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MINIAPP_MAX_BUNDLE_BYTES } }),
  )
  uploadBundle(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedBinaryFile | undefined,
    @Body() formBody: { channel?: string; changelog?: string; directPublish?: string },
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('请上传构建包文件（字段名 file，格式 .zip/.lecapp）');
    }
    return this.service.uploadBundle(user, file.buffer, formBody ?? {});
  }

  @Post('import-github')
  @HttpCode(HttpStatus.CREATED)
  importGitHub(@CurrentUser() user: AuthUser, @Body() rawBody: unknown) {
    const req = ImportGitHubSchema.parse(rawBody);
    return this.service.importFromGitHub(user, {
      ...req,
      manifest: req.manifest as unknown as Partial<MiniAppManifest>,
    });
  }

  @Post(':id/versions/:versionId/review')
  @RequireCaptain()
  @HttpCode(HttpStatus.OK)
  reviewVersion(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('versionId') versionId: string,
    @Body() rawBody: unknown,
  ) {
    const body = ReviewSchema.parse(rawBody);
    return this.service.reviewVersion(
      user,
      appId.trim(),
      UuidSchema.parse(versionId.trim()),
      body.decision,
      body.note,
    );
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Body() rawBody: unknown,
  ) {
    const body = StatusUpdateSchema.parse(rawBody);
    return this.service.updateStatus(user, appId.trim(), body);
  }

  @Post(':id/play')
  @HttpCode(HttpStatus.OK)
  recordPlay(@Param('id') appId: string) {
    return this.service.recordPlay(appId.trim());
  }

  // ── 云存档 KV ──

  @Get(':id/kv')
  listKvKeys(@CurrentUser() user: AuthUser, @Param('id') appId: string) {
    return this.service.listKvKeys(user.userId, appId.trim());
  }

  @Get(':id/kv/:key')
  getKv(@CurrentUser() user: AuthUser, @Param('id') appId: string, @Param('key') key: string) {
    return this.service.getKv(user.userId, appId.trim(), key.trim());
  }

  @Put(':id/kv/:key')
  setKv(
    @CurrentUser() user: AuthUser,
    @Param('id') appId: string,
    @Param('key') key: string,
    @Body() rawBody: { value?: unknown },
  ) {
    if (!rawBody || typeof rawBody !== 'object' || !('value' in rawBody)) {
      throw new BadRequestException('请提供合法的 JSON value');
    }
    return this.service.setKv(user.userId, appId.trim(), key.trim(), rawBody.value);
  }

  @Delete(':id/kv/:key')
  deleteKv(@CurrentUser() user: AuthUser, @Param('id') appId: string, @Param('key') key: string) {
    return this.service.deleteKv(user.userId, appId.trim(), key.trim());
  }
}
