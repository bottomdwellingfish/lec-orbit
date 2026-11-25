import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  PunchAdminOnly,
  PunchAuthGuard,
  PunchCurrentUser,
  type PunchAuthUser,
} from './punch-auth.guard.js';
import {
  PunchNetworkPolicyService,
  type WifiScanSample,
} from './punch-network-policy.service.js';

const WifiScanSchema = z.object({
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

const UpdatePolicySchema = z.object({
  allowAnyNetwork: z.boolean(),
  allowedPublicIps: z.array(z.string()).optional(),
  allowedCidrs: z.array(z.string()).optional(),
  trustProxy: z.boolean().optional(),
  trustedProxyHops: z.number().int().min(1).max(10).optional(),
});

const UpdateWifiSchema = z.object({
  enabled: z.boolean(),
  anchors: z
    .array(
      z.object({
        bssid: z.string(),
        ssid: z.string().optional(),
        sampleRssi: z.number().optional(),
      }),
    )
    .optional(),
  minMatchCount: z.number().int().min(1).max(20).optional(),
  minRssi: z.number().int().min(-100).max(-30).optional(),
  merge: z.boolean().optional(),
});

@Controller('network-policy')
@UseGuards(PunchAuthGuard)
export class PunchNetworkPolicyController {
  constructor(private readonly service: PunchNetworkPolicyService) {}

  @Get('current-status')
  async currentStatusGet(
    @PunchCurrentUser() user: PunchAuthUser,
    @Req() req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
  ) {
    const ip = await this.service.extractClientIp(user.teamId, req);
    return this.service.evaluateAccess(user.teamId, ip);
  }

  @Post('current-status')
  async currentStatusPost(
    @PunchCurrentUser() user: PunchAuthUser,
    @Req() req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
    @Body() rawBody: unknown,
  ) {
    const parsed = WifiScanSchema.parse(rawBody ?? {});
    const ip = await this.service.extractClientIp(user.teamId, req);
    return this.service.evaluateAccess(user.teamId, ip, parsed.wifiScan as WifiScanSample[]);
  }

  @Get('admin/current')
  @PunchAdminOnly()
  getAdminPolicy(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.resolvePolicy(user.teamId);
  }

  @Patch('admin/current')
  @PunchAdminOnly()
  updateAdminPolicy(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    return this.service.updateAdminPolicy(user.teamId, UpdatePolicySchema.parse(rawBody));
  }

  @Get('admin/wifi-fingerprint')
  @PunchAdminOnly()
  getWifiConfig(@PunchCurrentUser() user: PunchAuthUser) {
    return this.service.getWifiFingerprintConfig(user.teamId);
  }

  @Patch('admin/wifi-fingerprint')
  @PunchAdminOnly()
  updateWifiConfig(@PunchCurrentUser() user: PunchAuthUser, @Body() rawBody: unknown) {
    return this.service.updateWifiFingerprintConfig(user.teamId, UpdateWifiSchema.parse(rawBody));
  }

  @Get('admin/debug')
  @PunchAdminOnly()
  async debug(
    @PunchCurrentUser() user: PunchAuthUser,
    @Req() req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
  ) {
    const ip = await this.service.extractClientIp(user.teamId, req);
    const policy = await this.service.resolvePolicy(user.teamId);
    return {
      clientIp: ip,
      xForwardedFor: req.headers?.['x-forwarded-for'] ?? null,
      remoteAddress: req.socket?.remoteAddress ?? null,
      policy,
    };
  }
}
