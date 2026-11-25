import { scryptSync, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { PunchUserEntity } from './entities/punch-core.entities.js';
import {
  isValidEnrollmentYear,
  signMemberKey,
  verifyMemberKey,
} from './punch-shared.util.js';

export function toPunchUserResponse(
  user: PunchUserEntity,
  effectiveRole?: 'member' | 'admin',
  includeTimestamps = true,
) {
  return {
    id: user.id,
    lecUserId: user.logtoUserId ?? undefined,
    username: user.username,
    displayName: user.displayName,
    teamId: user.teamId,
    role: effectiveRole ?? user.role,
    status: user.status,
    enrollYear: user.enrollYear,
    studentId: user.studentId ?? undefined,
    realName: user.realName ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    adminMessageBadgeEnabled: user.adminMessageBadgeEnabled,
    avatarBase64: user.avatarBase64 ?? undefined,
    avatarColor: user.avatarColor ?? undefined,
    avatarEmoji: user.avatarEmoji ?? undefined,
    equippedTitleId: user.equippedTitleId ?? undefined,
    ...(includeTimestamps
      ? {
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        }
      : {}),
  };
}

@Injectable()
export class PunchUsersService {
  constructor(
    @InjectRepository(PunchUserEntity)
    private readonly userRepo: Repository<PunchUserEntity>,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  findById(userId: string) {
    return this.userRepo.findOne({ where: { id: userId } });
  }

  listTeamMembers(teamId: string) {
    return this.userRepo.find({
      where: { teamId },
      order: { enrollYear: 'DESC', displayName: 'ASC' },
    });
  }

  getMemberKey(userId: string): string {
    return signMemberKey(userId, this.cfg.internalServiceToken);
  }

  resolveMemberKey(memberKey: string): string | null {
    return verifyMemberKey(memberKey, this.cfg.internalServiceToken);
  }

  async updateSelfProfile(
    userId: string,
    input: {
      displayName?: string;
      enrollYear?: number;
      avatarBase64?: string | null;
      avatarColor?: string | null;
      avatarEmoji?: string | null;
      adminMessageBadgeEnabled?: boolean;
    },
  ) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    if (input.displayName !== undefined) {
      const trimmed = input.displayName.trim();
      if (!trimmed || trimmed.length > 32) {
        throw new BadRequestException('昵称长度需在 1~32 字符之间');
      }
      user.displayName = trimmed;
    }
    if (input.enrollYear !== undefined) {
      if (!isValidEnrollmentYear(input.enrollYear)) {
        throw new BadRequestException('入学年级无效');
      }
      user.enrollYear = input.enrollYear;
    }
    if (input.avatarBase64 !== undefined) user.avatarBase64 = input.avatarBase64;
    if (input.avatarColor !== undefined) user.avatarColor = input.avatarColor;
    if (input.avatarEmoji !== undefined) user.avatarEmoji = input.avatarEmoji;
    if (input.adminMessageBadgeEnabled !== undefined) {
      user.adminMessageBadgeEnabled = input.adminMessageBadgeEnabled;
    }

    user.updatedAt = new Date();
    await this.userRepo.save(user);
    return toPunchUserResponse(user);
  }

  /** 使用 Node 原生 scrypt 哈希更新本地兼容密码（零 C++ native addon 依赖）。 */
  async updatePassword(userId: string, newPassword: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    if (newPassword.length < 6 || newPassword.length > 128) {
      throw new BadRequestException('密码长度需在 6~128 字符之间');
    }
    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(newPassword, salt, 64).toString('hex');
    user.passwordHash = `scrypt:${salt}:${derived}`;
    user.updatedAt = new Date();
    await this.userRepo.save(user);
    return { ok: true };
  }

  async adminUpdateMember(
    teamId: string,
    targetUserId: string,
    input: {
      displayName?: string;
      realName?: string | null;
      studentId?: string | null;
      enrollYear?: number;
      role?: 'member' | 'admin';
      status?: 'active' | 'disabled';
    },
  ) {
    const user = await this.userRepo.findOne({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('成员不存在');
    if (user.teamId !== teamId) throw new ForbiddenException('禁止跨团队操作成员');

    if (input.displayName !== undefined) user.displayName = input.displayName.trim();
    if (input.realName !== undefined) user.realName = input.realName;
    if (input.studentId !== undefined) user.studentId = input.studentId;
    if (input.enrollYear !== undefined) {
      if (!isValidEnrollmentYear(input.enrollYear)) throw new BadRequestException('入学年级无效');
      user.enrollYear = input.enrollYear;
    }
    if (input.role !== undefined) user.role = input.role;
    if (input.status !== undefined) user.status = input.status;

    user.updatedAt = new Date();
    await this.userRepo.save(user);
    return toPunchUserResponse(user);
  }

  async adminDeleteMember(teamId: string, actorUserId: string, targetUserId: string) {
    if (actorUserId === targetUserId) {
      throw new BadRequestException('不能删除自己的账号');
    }
    const user = await this.userRepo.findOne({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('成员不存在');
    if (user.teamId !== teamId) throw new ForbiddenException('禁止跨团队删除成员');
    await this.userRepo.delete({ id: targetUserId });
    return { ok: true, id: targetUserId };
  }
}
