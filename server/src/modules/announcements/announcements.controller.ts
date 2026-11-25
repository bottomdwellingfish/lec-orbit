import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
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
import { AnnouncementsService } from './announcements.service.js';

const UuidSchema = z.string().uuid('无效的公告 ID');

const CreateAnnouncementSchema = z.object({
  title: z.string().trim().min(1, '请填写公告标题和正文内容'),
  contentHtml: z.string().min(1, '请填写公告标题和正文内容'),
  pinned: z.boolean().optional(),
});

const UpdateAnnouncementSchema = z.object({
  title: z.string().optional(),
  contentHtml: z.string().optional(),
  pinned: z.boolean().optional(),
});

interface UploadedBinaryFile {
  buffer?: Buffer;
  size?: number;
}

@Controller('api/v1')
@UseGuards(SsoAuthGuard, CaptainGuard)
export class AnnouncementsController {
  constructor(private readonly service: AnnouncementsService) {}

  @Get('announcements')
  async list(@CurrentUser() user: AuthUser) {
    const items = await this.service.list(user.userId);
    return { items };
  }

  @Post('announcements')
  @RequireCaptain()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthUser, @Body() rawBody: unknown) {
    const input = CreateAnnouncementSchema.parse(rawBody);
    return this.service.create(user, input);
  }

  @Patch('announcements/:id')
  @RequireCaptain()
  update(@Param('id') id: string, @Body() rawBody: unknown) {
    const input = UpdateAnnouncementSchema.parse(rawBody);
    return this.service.update(UuidSchema.parse(id), input);
  }

  @Delete('announcements/:id')
  @RequireCaptain()
  remove(@Param('id') id: string) {
    return this.service.softDelete(UuidSchema.parse(id));
  }

  @Post('announcements/:id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.markRead(user, UuidSchema.parse(id));
  }

  @Get('announcements/:id/receipts')
  getReceipts(@Param('id') id: string) {
    return this.service.getReceipts(UuidSchema.parse(id));
  }

  @Post('announcements/:id/remind-unread')
  @RequireCaptain()
  @HttpCode(HttpStatus.OK)
  remindUnread(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remindUnread(user, UuidSchema.parse(id));
  }

  @Post('uploads/image')
  @RequireCaptain()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadImage(@UploadedFile() file: UploadedBinaryFile | undefined) {
    if (!file?.buffer) {
      throw new BadRequestException('请上传图片文件（字段名 file）');
    }
    return this.service.uploadImage(file.buffer);
  }
}
