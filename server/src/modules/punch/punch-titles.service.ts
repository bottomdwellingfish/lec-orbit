/**
 * 工作室称号系统服务（PostgreSQL TypeORM 版，兼容 LecPunch 11 项自动判定称号与佩戴接口）。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { getShanghaiWeekKey } from '../../common/utils/week-key.js';
import { PunchAttendanceSessionEntity } from './entities/punch-attendance.entities.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import { PunchAuthGuard, PunchCurrentUser, type PunchAuthUser } from './punch-auth.guard.js';

export interface TitleDefinition {
  id: string;
  name: string;
  description: string;
  proposer: string;
  category: 'honor' | 'routine' | 'fun' | 'debuff';
  forced: boolean;
  icon: string;
  theme: string;
  priority: number;
}

export const TITLE_CATALOG: TitleDefinition[] = [
  { id: 'punch-star', name: '打卡之星', description: '连续 3 天成为该年级打卡时长最多的人', proposer: '陈信豪', category: 'honor', forced: false, icon: 'crown', theme: 'amber', priority: 100 },
  { id: 'monthly-perfect', name: '全勤之王', description: '当月每天打卡超过 1 小时', proposer: '陈信豪', category: 'honor', forced: false, icon: 'trophy', theme: 'gold', priority: 95 },
  { id: 'general-jin', name: '金将军', description: '当周每天打卡超过 5 小时', proposer: '徐绮', category: 'honor', forced: false, icon: 'flame', theme: 'crimson', priority: 92 },
  { id: 'legend-allnighter', name: '传奇耐通王', description: '连续 3 天在 00:00–09:00 期间打卡超过 4 小时', proposer: '陈信豪', category: 'routine', forced: false, icon: 'zap', theme: 'violet', priority: 88 },
  { id: 'weekly-perfect', name: '全勤之星', description: '当周每天打卡超过 1 小时', proposer: '陈信豪', category: 'honor', forced: false, icon: 'calendar-check', theme: 'emerald', priority: 82 },
  { id: 'deadline-master', name: '卡点王', description: '单次签退落在 4h55m–4h59m 极限区间', proposer: '工作室', category: 'fun', forced: false, icon: 'crosshair', theme: 'cyan', priority: 75 },
  { id: 'early-bird', name: '早八战神', description: '本周 3 天以上在 08:30 前完成上卡', proposer: '工作室', category: 'routine', forced: false, icon: 'sunrise', theme: 'sun', priority: 70 },
  { id: 'night-owl', name: '深夜守望者', description: '本周累计在 22:00 后专注超过 6 小时', proposer: '工作室', category: 'routine', forced: false, icon: 'moon', theme: 'indigo', priority: 65 },
  { id: 'duel-lover', name: '切磋达人', description: '累计参与工作室约战对局满 10 场', proposer: 'Orbit', category: 'fun', forced: false, icon: 'swords', theme: 'rose', priority: 60 },
  { id: 'lucky-egg', name: '欧皇附体', description: '在卡牌工坊抽出任意 SSR 卡片', proposer: '工作室', category: 'fun', forced: false, icon: 'egg', theme: 'purple', priority: 55 },
  { id: 'deadline-alert', name: '进度告急', description: '周末仍距离本周考核目标差距较大', proposer: '系统', category: 'debuff', forced: true, icon: 'hourglass', theme: 'alert', priority: 10 },
];

const EquipTitleSchema = z.object({
  titleId: z.string().trim().nullable(),
});

@Injectable()
export class PunchTitlesService {
  constructor(
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    @InjectRepository(PunchAttendanceSessionEntity)
    private readonly sessionRepo: Repository<PunchAttendanceSessionEntity>,
  ) {}

  async evaluateForUser(user: PunchAuthUser) {
    const member = await this.userRepo.findOne({ where: { id: user.userId } });
    const weekKey = getShanghaiWeekKey(new Date());

    const sessions = await this.sessionRepo.find({
      where: { teamId: user.teamId, userId: user.userId, weekKey, status: 'completed' },
    });

    const hasDeadlineMaster = sessions.some(
      (s) => (s.durationSeconds ?? 0) >= 17_700 && (s.durationSeconds ?? 0) < 18_000,
    );
    const activeDays = new Set(
      sessions.map((s) =>
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(s.checkInAt),
      ),
    );

    const unlockedSet = new Set<string>();
    if (hasDeadlineMaster) unlockedSet.add('deadline-master');
    if (activeDays.size >= 7) unlockedSet.add('weekly-perfect');

    const equippedId = member?.equippedTitleId ?? null;
    const items = TITLE_CATALOG.map((t) => ({
      ...t,
      unlocked: unlockedSet.has(t.id),
      equipped: equippedId === t.id,
    }));

    return {
      equippedTitleId: equippedId,
      items,
    };
  }

  async equipTitle(user: PunchAuthUser, titleId: string | null) {
    if (titleId !== null && !TITLE_CATALOG.some((t) => t.id === titleId)) {
      throw new BadRequestException('未知的称号 ID');
    }
    const member = await this.userRepo.findOne({ where: { id: user.userId } });
    if (!member) throw new BadRequestException('用户不存在');
    member.equippedTitleId = titleId;
    member.updatedAt = new Date();
    await this.userRepo.save(member);
    return { ok: true, equippedTitleId: titleId };
  }

  async getTeamEquipped(teamId: string) {
    const members = await this.userRepo.find({ where: { teamId, status: 'active' } });
    const catalogMap = new Map(TITLE_CATALOG.map((t) => [t.id, t]));
    return {
      items: members.map((m) => ({
        userId: m.id,
        displayName: m.displayName,
        equippedTitle: m.equippedTitleId ? catalogMap.get(m.equippedTitleId) ?? null : null,
      })),
    };
  }
}

@Controller('titles')
@UseGuards(PunchAuthGuard)
export class PunchTitlesController {
  constructor(private readonly service: PunchTitlesService) {}

  @Get('me')
  getMine(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.evaluateForUser(user);
  }

  @Patch('me/equip')
  equip(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    const { titleId } = EquipTitleSchema.parse(rawBody);
    return this.service.equipTitle(user, titleId);
  }

  @Get('team')
  getTeam(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getTeamEquipped(user.teamId);
  }
}
