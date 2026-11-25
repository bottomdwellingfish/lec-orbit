import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import { PunchAttendanceService } from './punch-attendance.service.js';
import {
  PunchNetworkPolicyService,
  type WifiScanSample,
} from './punch-network-policy.service.js';

const CheckBodySchema = z.object({
  wifiScan: z
    .array(
      z.object({
        bssid: z.string(),
        ssid: z.string().optional(),
        rssi: z.number().optional(),
      }),
    )
    .optional(),
});

const AdjustDurationSchema = z.object({
  userId: z.string().trim().min(1),
  operation: z.enum(['add', 'subtract']),
  durationSeconds: z.number().int().min(1).max(36_000),
  reason: z.string().max(200).optional(),
  requestKey: z.string().max(128).optional(),
});

@Controller('attendance')
@UseGuards(PunchAuthGuard)
export class PunchAttendanceController {
  constructor(
    private readonly attendanceService: PunchAttendanceService,
    private readonly networkPolicy: PunchNetworkPolicyService,
  ) {}

  @Get('current')
  getCurrent(@PunchCurrentUser() user: PunchAuthUser) {
    return this.attendanceService.getCurrentSession(user.userId);
  }

  @Get('team-active')
  getTeamActive(@PunchCurrentUser() user: PunchAuthUser) {
    return this.attendanceService.getTeamActive(user.teamId);
  }

  @Get('me/weekly-summary')
  getMyWeeklySummary(@PunchCurrentUser() user: PunchAuthUser, @Query('week') week?: string) {
    return this.attendanceService.getMyWeeklySummary(user, week);
  }

  @Post('check-in')
  async checkIn(
    @PunchCurrentUser() user: PunchAuthUser,
    @Req() req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
    @Body() rawBody: unknown,
  ) {
    const parsed = CheckBodySchema.parse(rawBody ?? {});
    const ip = await this.networkPolicy.extractClientIp(user.teamId, req);
    return this.attendanceService.checkIn(user, ip, parsed.wifiScan as WifiScanSample[]);
  }

  @Post('check-out')
  async checkOut(
    @PunchCurrentUser() user: PunchAuthUser,
    @Req() req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
    @Body() rawBody: unknown,
  ) {
    const parsed = CheckBodySchema.parse(rawBody ?? {});
    const ip = await this.networkPolicy.extractClientIp(user.teamId, req);
    return this.attendanceService.checkOut(user, ip, parsed.wifiScan as WifiScanSample[]);
  }

  @Post('keepalive')
  keepAlive(@PunchCurrentUser() user: PunchAuthUser) {
    return this.attendanceService.keepAlive(user);
  }

  @Get('admin/current-week-adjustment-context')
  @PunchAdminOnly()
  getAdjustmentContext(@PunchCurrentUser() user: PunchAuthUser) {
    return this.attendanceService.listWeeklyAdjustments(user.teamId);
  }

  @Post('admin/current-week-duration-adjustments')
  @PunchAdminOnly()
  adjustDuration(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    return this.attendanceService.adjustCurrentWeekDuration(
      user,
      AdjustDurationSchema.parse(rawBody),
    );
  }

  @Get('admin/weekly-adjustments')
  @PunchAdminOnly()
  listAdjustments(@PunchCurrentUser() user: PunchAuthUser, @Query('week') week?: string) {
    return this.attendanceService.listWeeklyAdjustments(user.teamId, week);
  }
}
