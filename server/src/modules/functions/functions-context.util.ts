/**
 * Orbit FaaS（方案 E）核心安全与基础设施纯函数工具：
 * - 云函数静态源码安全扫描（上传 ZIP 时拦截文件系统、子进程、环境变量、动态 eval 与 Runtime 逃逸）；
 * - 15 秒单次调用 HS256 上下文令牌签发与验签（防跨应用越权）；
 * - 应用级环形调用日志（保留最近 200 条）与窗口限流器。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface FnContextClaims {
  appId: string;
  versionId: string;
  fnName: string;
  requestId: string;
  userId: string;
  username?: string;
  displayName: string;
  isCaptain: boolean;
  scopes: string[];
  allowedDomains: string[];
  exp: number;
}

export interface FnInvocationLogEntry {
  requestId: string;
  fnName: string;
  userId: string;
  status: number;
  durationMs: number;
  logs: Array<{ level: string; text: string }>;
  error?: string;
  createdAt: string;
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bDeno\s*\.\s*Command\b/, reason: '禁止调用 Deno.Command 启动子进程' },
  { pattern: /\bDeno\s*\.\s*run\b/, reason: '禁止调用 Deno.run 启动子进程' },
  { pattern: /\bDeno\s*\.\s*(?:readFile|readTextFile|writeFile|writeTextFile|open|remove|mkdir|readDir|stat|lstat)\b/, reason: '禁止云函数直接读写宿主机文件系统' },
  { pattern: /\bDeno\s*\.\s*env\b/, reason: '禁止读取运行时环境变量（请改用 ctx.secrets.get）' },
  { pattern: /\bDeno\s*\.\s*(?:connect|listen|serve|serveHttp)\b/, reason: '禁止云函数私自监听端口或建立底层 Socket' },
  { pattern: /\bEdgeRuntime\s*\./, reason: '禁止访问底层 EdgeRuntime 宿主对象' },
  { pattern: /['"`](?:node:)?(?:child_process|fs|fs\/promises|os|net|tls|dgram|cluster|worker_threads|vm)['"`]/, reason: '禁止导入危险 Node 原生系统模块' },
  { pattern: /\bprocess\s*\.\s*env\b/, reason: '禁止读取 process.env（请改用 ctx.secrets.get）' },
  { pattern: /\beval\s*\(/, reason: '禁止使用动态 eval()' },
  { pattern: /\bnew\s+Function\s*\(/, reason: '禁止使用 new Function() 动态执行代码' },
];

/** 对上传的 .ts / .js / .mjs 云函数源码执行静态安全扫描，发现危险调用直接抛出中文错误。 */
export function scanFunctionSourceSafety(source: string, filePath: string): void {
  // 简单去除行注释与块注释以降低误报（不改变安全边界）
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(stripped)) {
      throw new Error(`云函数安全扫描拦截（${filePath}）：${rule.reason}`);
    }
  }
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** 签发短期 HS256 云函数桥接上下文令牌（默认有效期 15 秒，流式最高 70 秒）。 */
export function signFnContextToken(
  secret: string,
  claims: Omit<FnContextClaims, 'exp'>,
  ttlSeconds = 15,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + Math.min(Math.max(ttlSeconds, 5), 75);
  const payload = base64UrlEncode(JSON.stringify({ ...claims, exp }));
  const signingInput = `${header}.${payload}`;
  const sig = base64UrlEncode(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

/** 验签并解析短期 HS256 云函数桥接令牌。 */
export function verifyFnContextToken(secret: string, token: string): FnContextClaims | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  const [header, payload, gotSig] = parts;
  const expectedSig = base64UrlEncode(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );
  const a = Buffer.from(gotSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(base64UrlDecode(payload).toString('utf8')) as FnContextClaims;
    if (!claims.appId || !claims.userId || !claims.exp) return null;
    if (Math.floor(Date.now() / 1000) > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

/** 每应用保留最近 N 条调用记录的轻量环形日志缓冲。 */
export class FnRingLogger {
  private readonly store = new Map<string, FnInvocationLogEntry[]>();

  constructor(private readonly maxPerApp = 200) {}

  push(appId: string, entry: FnInvocationLogEntry): void {
    const list = this.store.get(appId) ?? [];
    list.unshift(entry);
    if (list.length > this.maxPerApp) {
      list.length = this.maxPerApp;
    }
    this.store.set(appId, list);
  }

  list(appId: string, limit = 50): FnInvocationLogEntry[] {
    const safeLimit = Math.min(Math.max(limit, 1), this.maxPerApp);
    return (this.store.get(appId) ?? []).slice(0, safeLimit);
  }
}

/** 内存滑动计数限流器（按分钟窗口限制单应用与单人调用频次）。 */
export class FnRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  consume(key: string, limit: number, windowMs = 60_000): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const cur = this.buckets.get(key);
    if (!cur || now >= cur.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (this.buckets.size > 5000) {
        for (const [k, v] of this.buckets.entries()) {
          if (now >= v.resetAt) this.buckets.delete(k);
        }
      }
      return { allowed: true, retryAfterSec: 0 };
    }
    if (cur.count >= limit) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
    }
    cur.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }
}
