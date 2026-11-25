import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import {
  PunchAttendanceSessionEntity,
  PunchPointLedgerEntity,
} from './entities/punch-attendance.entities.js';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import { PunchUsersService } from './punch-users.service.js';

const MarkRecordSchema = z.object({
  isMarked: z.boolean(),
});

@Controller('records')
@UseGuards(PunchAuthGuard)
export class PunchRecordsController {
  constructor(
    @InjectRepository(PunchAttendanceSessionEntity)
    private readonly sessionRepo: Repository<PunchAttendanceSessionEntity>,
    @InjectRepository(PunchPointLedgerEntity)
    private readonly pointRepo: Repository<PunchPointLedgerEntity>,
    private readonly usersService: PunchUsersService,
  ) {}

  @Get('me')
  async myRecords(
    @PunchCurrentUser() user: PunchAuthUser,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawSize?: string,
  ) {
    const page = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(rawSize ?? '20', 10) || 20));
    const [items, total] = await this.sessionRepo.findAndCount({
      where: { teamId: user.teamId, userId: user.userId },
      order: { checkInAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  @Get('member/:memberKey')
  async memberRecords(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('memberKey') memberKey: string,
    @Query('page') rawPage?: string,
    @Query('pageSize') rawSize?: string,
  ) {
    const targetUserId = this.usersService.resolveMemberKey(memberKey);
    if (!targetUserId) throw new BadRequestException('无效的 memberKey');
    const target = await this.usersService.findById(targetUserId);
    if (!target || target.teamId !== user.teamId) {
      throw new ForbiddenException('无权查看其他团队成员记录');
    }
    const page = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(rawSize ?? '20', 10) || 20));
    const [items, total] = await this.sessionRepo.findAndCount({
      where: { teamId: user.teamId, userId: target.id },
      order: { checkInAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  @Patch('admin/:recordId/mark')
  @PunchAdminOnly()
  async markRecord(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('recordId') recordId: string,
    @Body() rawBody: unknown,
  ) {
    const { isMarked } = MarkRecordSchema.parse(rawBody);
    const rec = await this.sessionRepo.findOne({
      where: { id: recordId.trim(), teamId: user.teamId },
    });
    if (!rec) throw new NotFoundException('打卡记录不存在');
    rec.isMarked = isMarked;
    rec.updatedAt = new Date();
    await this.sessionRepo.save(rec);
    return rec;
  }

  @Delete('admin/:recordId')
  @PunchAdminOnly()
  async deleteRecord(@PunchCurrentUser() user: PunchAuthUser, @Param('recordId') recordId: string) {
    const rec = await this.sessionRepo.findOne({
      where: { id: recordId.trim(), teamId: user.teamId },
    });
    if (!rec) throw new NotFoundException('打卡记录不存在');
    await this.sessionRepo.delete({ id: rec.id });
    await this.pointRepo.delete({ sourceAttendanceSessionId: rec.id });
    return { ok: true, id: rec.id };
  }

  @Get('admin/export')
  @PunchAdminOnly()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(@PunchCurrentUser() user: PunchAuthUser, @Query('week') week?: string) {
    const qb = this.sessionRepo
      .createQueryBuilder('s')
      .where('s.team_id = :teamId', { teamId: user.teamId })
      .orderBy('s.check_in_at', 'DESC')
      .take(2000);
    if (week?.trim()) {
      qb.andWhere('s.week_key = :week', { week: week.trim() });
    }
    const rows = await qb.getMany();
    const lines = ['id,userId,weekKey,status,durationSeconds,checkInAt,checkOutAt,isMarked'];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.userId,
          r.weekKey,
          r.status,
          r.durationSeconds ?? 0,
          r.checkInAt.toISOString(),
          r.checkOutAt?.toISOString() ?? '',
          r.isMarked,
        ].join(','),
      );
    }
    return lines.join('\n');
  }
}
