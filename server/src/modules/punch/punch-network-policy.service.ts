/**
 * 考勤网络策略与工作室 Wi-Fi 指纹服务（PostgreSQL TypeORM 版，完全等价迁移自 LecPunch）：
 * - IPv4 / IPv6 公网 IP 与 CIDR 白名单匹配；
 * - 可信代理跳数（X-Forwarded-For）提取客户端真实 IP；
 * - 工作室周边固定 Wi-Fi BSSID + RSSI 指纹防远程代打校验。
 */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ipaddr from 'ipaddr.js';
import { Repository } from 'typeorm';
import {
  PunchNetworkPolicyEntity,
  type WifiAnchorEntry,
} from './entities/punch-core.entities.js';
import { newObjectIdHex, PUNCH_ERROR_CODES } from './punch-shared.util.js';

export interface WifiScanSample {
  bssid: string;
  ssid?: string;
  rssi?: number;
}

export interface AttendanceAccessEvaluation {
  clientIp: string;
  isAllowed: boolean;
  ipAllowed: boolean;
  wifiFingerprintEnabled: boolean;
  wifiAllowed: boolean;
  matchedCount: number;
  requiredMatchCount: number;
  configuredAnchorCount: number;
  reason?: string;
}

const BSSID_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

function normalizeBssid(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/-/g, ':');
  return BSSID_RE.test(cleaned) ? cleaned : '';
}

function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = ipaddr.parse(trimmed);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address().toString();
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function ipMatchesCidr(clientIp: string, cidr: string): boolean {
  try {
    const addr = ipaddr.parse(clientIp);
    const [range, bits] = ipaddr.parseCIDR(cidr);
    if (addr.kind() !== range.kind()) return false;
    return addr.match([range, bits]);
  } catch {
    return false;
  }
}

@Injectable()
export class PunchNetworkPolicyService {
  constructor(
    @InjectRepository(PunchNetworkPolicyEntity)
    private readonly policyRepo: Repository<PunchNetworkPolicyEntity>,
  ) {}

  async resolvePolicy(teamId: string) {
    const stored = await this.policyRepo.findOne({ where: { teamId } });
    if (stored) {
      return {
        teamId,
        allowAnyNetwork: stored.allowAnyNetwork,
        allowedPublicIps: stored.allowedPublicIps ?? [],
        allowedCidrs: stored.allowedCidrs ?? [],
        trustProxy: stored.trustProxy,
        trustedProxyHops: Math.max(1, stored.trustedProxyHops || 1),
        wifiFingerprintEnabled: stored.wifiFingerprintEnabled,
        wifiAnchors: stored.wifiAnchors ?? [],
        wifiMinMatchCount: Math.max(1, stored.wifiMinMatchCount || 2),
        wifiMinRssi: stored.wifiMinRssi ?? -82,
        source: 'database' as const,
        updatedAt: stored.updatedAt,
      };
    }

    return {
      teamId,
      allowAnyNetwork: true,
      allowedPublicIps: [] as string[],
      allowedCidrs: [] as string[],
      trustProxy: false,
      trustedProxyHops: 1,
      wifiFingerprintEnabled: false,
      wifiAnchors: [] as WifiAnchorEntry[],
      wifiMinMatchCount: 2,
      wifiMinRssi: -82,
      source: 'environment' as const,
      updatedAt: undefined,
    };
  }

  async extractClientIp(
    teamId: string,
    req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
  ): Promise<string> {
    const policy = await this.resolvePolicy(teamId);
    if (policy.trustProxy) {
      const rawXff = req.headers?.['x-forwarded-for'];
      const xff = Array.isArray(rawXff) ? rawXff.join(',') : rawXff;
      if (xff) {
        const parts = xff
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length > 0) {
          const idx = Math.max(0, parts.length - policy.trustedProxyHops);
          return normalizeIp(parts[idx]);
        }
      }
    }
    return normalizeIp(req.socket?.remoteAddress ?? '');
  }

  async evaluateAccess(
    teamId: string,
    clientIp: string,
    wifiScan?: WifiScanSample[],
  ): Promise<AttendanceAccessEvaluation> {
    const policy = await this.resolvePolicy(teamId);
    const normIp = normalizeIp(clientIp);

    let ipAllowed = policy.allowAnyNetwork;
    if (!ipAllowed && normIp) {
      if (policy.allowedPublicIps.some((ip) => normalizeIp(ip) === normIp)) {
        ipAllowed = true;
      } else if (policy.allowedCidrs.some((cidr) => ipMatchesCidr(normIp, cidr))) {
        ipAllowed = true;
      }
    }

    const anchors = policy.wifiAnchors ?? [];
    const anchorSet = new Set(anchors.map((a) => normalizeBssid(a.bssid)).filter(Boolean));
    const requiredMatchCount = Math.min(policy.wifiMinMatchCount, Math.max(1, anchorSet.size));

    let matchedCount = 0;
    if (Array.isArray(wifiScan) && anchorSet.size > 0) {
      const seen = new Set<string>();
      for (const sample of wifiScan) {
        const bssid = normalizeBssid(sample.bssid ?? '');
        if (!bssid || seen.has(bssid) || !anchorSet.has(bssid)) continue;
        if (sample.rssi !== undefined && sample.rssi < policy.wifiMinRssi) continue;
        seen.add(bssid);
        matchedCount += 1;
      }
    }

    const wifiAllowed = !policy.wifiFingerprintEnabled || matchedCount >= requiredMatchCount;
    const isAllowed = ipAllowed && wifiAllowed;

    let reason: string | undefined;
    if (!ipAllowed) {
      reason = `当前网络 IP (${normIp || '未知'}) 不在工作室考勤白名单内`;
    } else if (!wifiAllowed) {
      reason = `未检测到足够的工作室周边 Wi-Fi 信号（匹配 ${matchedCount}/${requiredMatchCount}）`;
    }

    return {
      clientIp: normIp,
      isAllowed,
      ipAllowed,
      wifiFingerprintEnabled: policy.wifiFingerprintEnabled,
      wifiAllowed,
      matchedCount,
      requiredMatchCount,
      configuredAnchorCount: anchorSet.size,
      reason,
    };
  }

  async assertAllowed(teamId: string, clientIp: string, wifiScan?: WifiScanSample[]) {
    const evalRes = await this.evaluateAccess(teamId, clientIp, wifiScan);
    if (!evalRes.isAllowed) {
      throw new ForbiddenException({
        code: PUNCH_ERROR_CODES.ATTENDANCE_NETWORK_NOT_ALLOWED,
        message: evalRes.reason || '当前网络不允许打卡',
      });
    }
    return evalRes;
  }

  async updateAdminPolicy(
    teamId: string,
    input: {
      allowAnyNetwork: boolean;
      allowedPublicIps?: string[];
      allowedCidrs?: string[];
      trustProxy?: boolean;
      trustedProxyHops?: number;
    },
  ) {
    const ips = (input.allowedPublicIps ?? []).map((s) => normalizeIp(s)).filter(Boolean);
    const cidrs = (input.allowedCidrs ?? []).map((s) => s.trim()).filter(Boolean);
    if (!input.allowAnyNetwork && ips.length === 0 && cidrs.length === 0) {
      throw new BadRequestException('关闭“允许任意网络”时必须至少配置一个 IP 或 CIDR 白名单');
    }

    const now = new Date();
    let entity = await this.policyRepo.findOne({ where: { teamId } });
    if (!entity) {
      entity = this.policyRepo.create({
        id: newObjectIdHex(),
        teamId,
        createdAt: now,
      });
    }
    entity.allowAnyNetwork = input.allowAnyNetwork;
    entity.allowedPublicIps = ips;
    entity.allowedCidrs = cidrs;
    entity.trustProxy = Boolean(input.trustProxy);
    entity.trustedProxyHops = Math.max(1, input.trustedProxyHops ?? 1);
    entity.updatedAt = now;
    await this.policyRepo.save(entity);
    return this.resolvePolicy(teamId);
  }

  async getWifiFingerprintConfig(teamId: string) {
    const p = await this.resolvePolicy(teamId);
    return {
      teamId,
      enabled: p.wifiFingerprintEnabled,
      anchors: p.wifiAnchors,
      minMatchCount: p.wifiMinMatchCount,
      minRssi: p.wifiMinRssi,
      updatedAt: p.updatedAt,
    };
  }

  async updateWifiFingerprintConfig(
    teamId: string,
    input: {
      enabled: boolean;
      anchors?: WifiAnchorEntry[];
      minMatchCount?: number;
      minRssi?: number;
      merge?: boolean;
    },
  ) {
    const existing = await this.policyRepo.findOne({ where: { teamId } });
    const normalizeAnchors = (list: WifiAnchorEntry[]) => {
      const map = new Map<string, WifiAnchorEntry>();
      for (const a of list) {
        const bssid = normalizeBssid(a.bssid ?? '');
        if (!bssid) continue;
        map.set(bssid, { bssid, ssid: a.ssid?.trim(), sampleRssi: a.sampleRssi });
      }
      return [...map.values()];
    };

    const incoming = normalizeAnchors(input.anchors ?? []);
    const merged = input.merge
      ? normalizeAnchors([...(existing?.wifiAnchors ?? []), ...incoming])
      : incoming;

    if (input.enabled && merged.length === 0) {
      throw new BadRequestException(
        '启用工作室环境指纹校验前，请至少采集并保存 1 个固定 Wi-Fi 信号点。',
      );
    }

    const now = new Date();
    const entity =
      existing ??
      this.policyRepo.create({
        id: newObjectIdHex(),
        teamId,
        allowAnyNetwork: true,
        allowedPublicIps: [],
        allowedCidrs: [],
        trustProxy: false,
        trustedProxyHops: 1,
        createdAt: now,
      });

    entity.wifiFingerprintEnabled = Boolean(input.enabled);
    entity.wifiAnchors = merged;
    entity.wifiMinMatchCount = Math.min(20, Math.max(1, input.minMatchCount ?? 2));
    entity.wifiMinRssi = Math.min(-30, Math.max(-100, input.minRssi ?? -82));
    entity.updatedAt = now;
    await this.policyRepo.save(entity);
    return this.getWifiFingerprintConfig(teamId);
  }
}
