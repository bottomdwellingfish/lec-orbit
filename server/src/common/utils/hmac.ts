/**
 * 工坊应用权威后端 S2S 全要素 HMAC-SHA256 签名与防重放校验工具。
 * 签名原文覆盖：METHOD + PATH + APP_ID + TIMESTAMP + NONCE + SHA256(RAW_BODY)，
 * 杜绝跨应用、跨订单与重放攻击。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const S2S_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000; // ±5 分钟时间窗
export const S2S_NONCE_TTL_MS = 10 * 60 * 1000; // Nonce 去重窗口 10 分钟

export interface S2SSignInput {
  method: string;
  path: string;
  appId: string;
  timestampMs: string;
  nonce: string;
  rawBody: Buffer | string;
}

/** 计算 S2S 规范签名串。 */
export function buildS2SCanonicalString(input: S2SSignInput): string {
  const bodyBuf = Buffer.isBuffer(input.rawBody)
    ? input.rawBody
    : Buffer.from(input.rawBody, 'utf8');
  const bodyHash = createHash('sha256').update(bodyBuf).digest('hex');
  return [
    input.method.trim().toUpperCase(),
    input.path.trim(),
    input.appId.trim(),
    input.timestampMs.trim(),
    input.nonce.trim(),
    bodyHash,
  ].join('\n');
}

/** 使用应用专属密钥生成 sha256=<hex> 格式签名。 */
export function signS2SRequest(secret: string, input: S2SSignInput): string {
  const canonical = buildS2SCanonicalString(input);
  const hex = createHmac('sha256', secret).update(canonical).digest('hex');
  return `sha256=${hex}`;
}

/** 校验 S2S 签名与时间窗口（常量时间比对）。 */
export function verifyS2SSignature(
  secret: string,
  input: S2SSignInput,
  signatureHeader: string,
  nowMs: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!secret || !input.appId.trim() || !input.timestampMs.trim() || !signatureHeader.trim()) {
    return { ok: false, reason: '缺少必要的 S2S 签名请求头' };
  }
  const nonce = input.nonce.trim();
  if (nonce.length < 8 || nonce.length > 128) {
    return { ok: false, reason: 'X-Orbit-Nonce 长度需在 8~128 字符之间' };
  }
  const ts = Number.parseInt(input.timestampMs.trim(), 10);
  if (!Number.isSafeInteger(ts)) {
    return { ok: false, reason: 'X-Orbit-Timestamp 格式无效' };
  }
  if (Math.abs(nowMs - ts) > S2S_SIGNATURE_MAX_SKEW_MS) {
    return { ok: false, reason: 'S2S 请求时间戳超出 ±5 分钟安全窗口' };
  }

  const providedHex = signatureHeader.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) {
    return { ok: false, reason: 'X-Orbit-Signature 格式无效' };
  }

  const expectedHex = signS2SRequest(secret, input).slice('sha256='.length);
  const a = Buffer.from(providedHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'S2S HMAC 签名校验失败' };
  }
  return { ok: true };
}

/** 内存级 Nonce 防重放窗口缓存（支持自动过期清理，防止高并发内存增长）。 */
export class InMemoryNonceStore {
  private readonly entries = new Map<string, number>();

  /** 原子检查并记录 Nonce；若在有效窗口内已出现过则返回 false。 */
  consume(scopeKey: string, nonce: string, nowMs: number = Date.now()): boolean {
    if (this.entries.size > 5000) {
      this.prune(nowMs);
    }
    const key = `${scopeKey}:${nonce}`;
    const existingExp = this.entries.get(key);
    if (existingExp && existingExp > nowMs) {
      return false;
    }
    this.entries.set(key, nowMs + S2S_NONCE_TTL_MS);
    return true;
  }

  private prune(nowMs: number): void {
    for (const [k, exp] of this.entries.entries()) {
      if (exp <= nowMs) {
        this.entries.delete(k);
      }
    }
  }
}

/** 常量时间比对字符串令牌。 */
export function constantTimeEqualString(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
