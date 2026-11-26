import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { PunchMemberEligibilityEntity } from './entities/punch-core.entities.js';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import { newObjectIdHex } from './punch-shared.util.js';

const CreateEligSchema = z.object({
  studentId: z.string().trim().min(1).max(32),
  realName: z.string().trim().min(1).max(48),
  status: z.enum(['allowed', 'blocked']).default('allowed'),
  note: z.string().max(200).optional(),
});

const UpdateEligSchema = z.object({
  realName: z.string().trim().min(1).max(48).optional(),
  status: z.enum(['allowed', 'blocked']).optional(),
  note: z.string().max(200).nullable().optional(),
});

@Controller('member-eligibility')
@UseGuards(PunchAuthGuard)
@PunchAdminOnly()
export class PunchEligibilityController {
  constructor(
    @InjectRepository(PunchMemberEligibilityEntity)
    private readonly repo: Repository<PunchMemberEligibilityEntity>,
  ) {}

  @Get('admin/entries')
  async list(@PunchCurrentUser() user: PunchAuthUser) {
    const items = await this.repo.find({
      where: { teamId: user.teamId },
      order: { updatedAt: 'DESC' },
    });
    return { items };
  }

  @Post('admin/entries')
  async create(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const input = CreateEligSchema.parse(rawBody);
    const dup = await this.repo.findOne({
      where: { teamId: user.teamId, studentId: input.studentId },
    });
    if (dup) throw new ConflictException('该学号已在成员准入名单中');
    const now = new Date();
    const rec = this.repo.create({
      id: newObjectIdHex(),
      teamId: user.teamId,
      studentId: input.studentId,
      realName: input.realName,
      status: input.status,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return this.repo.save(rec);
  }

  @Patch('admin/entries/:entryId')
  async update(
    @PunchCurrentUser() user: PunchAuthUser,
    @Param('entryId') entryId: string,
    @Body() rawBody: unknown,
  ) {
    const input = UpdateEligSchema.parse(rawBody);
    const rec = await this.repo.findOne({ where: { id: entryId.trim(), teamId: user.teamId } });
    if (!rec) throw new NotFoundException('名单记录不存在');
    if (input.realName !== undefined) rec.realName = input.realName;
    if (input.status !== undefined) rec.status = input.status;
    if (input.note !== undefined) rec.note = input.note;
    rec.updatedAt = new Date();
    return this.repo.save(rec);
  }

  @Delete('admin/entries/:entryId')
  async remove(@PunchCurrentUser() user: PunchAuthUser, @Param('entryId') entryId: string) {
    const res = await this.repo.delete({ id: entryId.trim(), teamId: user.teamId });
    if (!res.affected) throw new NotFoundException('名单记录不存在');
    return { ok: true, id: entryId.trim() };
  }
}
