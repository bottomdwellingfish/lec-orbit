import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import { PunchUsersService, toPunchUserResponse } from './punch-users.service.js';

const UpdateMeSchema = z.object({
  displayName: z.string().optional(),
  enrollYear: z.number().int().optional(),
  avatarBase64: z.string().nullable().optional(),
  avatarColor: z.string().nullable().optional(),
  avatarEmoji: z.string().nullable().optional(),
  adminMessageBadgeEnabled: z.boolean().optional(),
});

const AdminUpdateMemberSchema = z.object({
  displayName: z.string().optional(),
  realName: z.string().nullable().optional(),
  studentId: z.string().nullable().optional(),
  enrollYear: z.number().int().optional(),
  role: z.enum(['member', 'admin']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const UpdatePasswordSchema = z.object({
  newPassword: z.string().min(6).max(128),
});

@Controller()
@UseGuards(PunchAuthGuard)
export class PunchUsersController {
  constructor(private readonly usersService: PunchUsersService) {}

  @Get('auth/me')
  async authMe(@PunchCurrentUser() authUser: PunchAuthUser) {
    const user = await this.usersService.findById(authUser.userId);
    if (!user) return null;
    return toPunchUserResponse(user, authUser.role, false);
  }

  @Get('users/admin/members')
  @PunchAdminOnly()
  async listMembers(@PunchCurrentUser() authUser: PunchAuthUser) {
    const members = await this.usersService.listTeamMembers(authUser.teamId);
    return {
      items: members.map((m) => ({
        ...toPunchUserResponse(m, m.id === authUser.userId ? authUser.role : m.role),
        roleVerified: m.id === authUser.userId,
      })),
    };
  }

  @Patch('users/admin/members/:userId')
  @PunchAdminOnly()
  updateMember(
    @PunchCurrentUser() authUser: PunchAuthUser,
    @Param('userId') userId: string,
    @Body() rawBody: unknown,
  ) {
    const body = AdminUpdateMemberSchema.parse(rawBody);
    return this.usersService.adminUpdateMember(authUser.teamId, userId.trim(), body);
  }

  @Delete('users/admin/members/:userId')
  @PunchAdminOnly()
  deleteMember(@PunchCurrentUser() authUser: PunchAuthUser, @Param('userId') userId: string) {
    return this.usersService.adminDeleteMember(authUser.teamId, authUser.userId, userId.trim());
  }

  @Patch('users/me')
  updateMe(@PunchCurrentUser() authUser: PunchAuthUser, @Body() rawBody: unknown) {
    const body = UpdateMeSchema.parse(rawBody);
    return this.usersService.updateSelfProfile(authUser.userId, body);
  }

  @Patch('users/me/password')
  updatePassword(@PunchCurrentUser() authUser: PunchAuthUser, @Body() rawBody: unknown) {
    const body = UpdatePasswordSchema.parse(rawBody);
    return this.usersService.updatePassword(authUser.userId, body.newPassword);
  }
}
