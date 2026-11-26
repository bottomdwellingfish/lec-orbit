/**
 * 考勤记录查询、标记通知、删除冲正与 CSV 导出控制器：
 * - PATCH /records/admin/:recordId/mark：从 false→true 时同步给成员发送 attendance.record_marked 站内通知；
 * - DELETE /records/admin/:recordId：禁止删除进行中会话，并同步冲正 punch_point_ledger_entries 与统一 coin 乐币，同时失效称号缓存。
 */
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
import { EconomyLedgerService } from '../economy/economy-ledger.service.js';
import {
  PunchAttendanceSessionEntity,
  PunchPointLedgerEntity,
} from './entities/punch-attendance.entities.js';
import { PunchNotificationEntity } from './entities/punch-collab.entities.js';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import { newObjectIdHex } from './punch-shared.util.js';
import { PunchTitlesService } from './punch-titles.service.js';
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
    @InjectRepository(PunchNotificationEntity)
    private readonly notifRepo: Repository<PunchNotificationEntity>,
    private readonly usersService: PunchUsersService,
    private readonly economyLedger: EconomyLedgerService,
    private readonly titlesService: PunchTitlesService,
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
    const wasMarked = rec.isMarked;
    const now = new Date();
    rec.isMarked = isMarked;
    rec.updatedAt = now;
    await this.sessionRepo.save(rec);

    // 首次标记异常打卡记录时，向该成员写入一条 attendance.record_marked 站内通知
    if (isMarked && !wasMarked) {
      await this.notifRepo
        .createQueryBuilder()
        .insert()
        .into(PunchNotificationEntity)
        .values({
          id: newObjectIdHex(),
          teamId: rec.teamId,
          userId: rec.userId,
          audience: 'user',
          recipientUserIds: null,
          deliveryKey: `attendance_mark:${rec.id}`,
          requestHash: null,
          type: 'attendance.record_marked',
          title: '打卡记录已被管理员标记',
          message: `你在 ${rec.weekKey} 所在周的一条打卡记录已被管理员标记为需关注，请核对考勤详情。`,
          payload: {
            recordId: rec.id,
            memberKey: this.usersService.getMemberKey(rec.userId),
            weekKey: rec.weekKey,
          },
          sourceType: 'attendance_record',
          sourceId: rec.id,
          createdBy: user.userId,
          acknowledgedAt: null,
          createdAt: now,
        })
        .orIgnore()
        .execute();
    }

    return rec;
  }

  @Delete('admin/:recordId')
  @PunchAdminOnly()
  async deleteRecord(@PunchCurrentUser() user: PunchAuthUser, @Param('recordId') recordId: string) {
    const rec = await this.sessionRepo.findOne({
      where: { id: recordId.trim(), teamId: user.teamId },
    });
    if (!rec) throw new NotFoundException('打卡记录不存在');
    if (rec.status === 'active') {
      throw new BadRequestException({
        code: 'ADMIN_ACTIVE_RECORD_DELETE_FORBIDDEN',
        message: '进行中的打卡记录不可直接删除',
      });
    }

    const [pointEntry, targetMember] = await Promise.all([
      this.pointRepo.findOne({ where: { sourceAttendanceSessionId: rec.id } }),
      this.usersService.findById(rec.userId),
    ]);

    await this.sessionRepo.delete({ id: rec.id });
    await this.pointRepo.delete({ sourceAttendanceSessionId: rec.id });

    // 联动冲正统一 coin 乐币账本（按原铸币记录或积分表记录幂等冲正）
    const fallbackCoins = pointEntry ? Math.round(Math.max(0, Number(pointEntry.points))) : 0;
    const economyUserId = targetMember?.logtoUserId || rec.userId;
    await this.economyLedger.reverseAttendanceCoins({
      userId: economyUserId,
      attendanceSessionId: rec.id,
      weekKey: rec.weekKey,
      fallbackCoins,
    });

    this.titlesService.invalidateTeamCache(user.teamId);
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
