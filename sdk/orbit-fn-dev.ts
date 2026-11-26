#!/usr/bin/env bun
/**
 * Orbit 托管云函数本地热调试工具（orbit-fn-dev）：
 * - 零外部依赖，直接 `bun run fn:dev -- <你的作品目录>` 启动本地模拟网关（默认端口 8787）；
 * - 自动读取目录根的 orbit.manifest.json 与 .env.local（供 ctx.secrets.get 读取）；
 * - 每次请求热重载对应 functions/<route>.ts（修改源码保存即生效，无需重启或打包上传）；
 * - 完整模拟 5 大平台底座（ctx.user / roomState CAS / kv / realtime / economy / secrets / fetch）
 *   与 SSE 流式（async function*），并在调用前同步执行与线上一致的静态安全检查提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface DevManifest {
  id: string;
  name?: string;
  version?: string;
  permissions?: {
    scopes?: string[];
    networkDomains?: string[];
  };
  functions?: {
    dir?: string;
    timeoutMs?: number;
    allowStreaming?: boolean;
    routes?: string[];
  };
}

const DANGEROUS_CHECKS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bDeno\s*\.\s*Command\b/, reason: '禁止调用 Deno.Command 启动子进程' },
  { pattern: /\bDeno\s*\.\s*run\b/, reason: '禁止调用 Deno.run 启动子进程' },
  { pattern: /\bDeno\s*\.\s*(?:readFile|readTextFile|writeFile|writeTextFile|open|remove|mkdir)\b/, reason: '禁止直接读写宿主机文件系统' },
  { pattern: /\bDeno\s*\.\s*env\b/, reason: '禁止读取运行时环境变量（请改用 ctx.secrets.get）' },
  { pattern: /\bprocess\s*\.\s*env\b/, reason: '禁止读取 process.env（请改用 ctx.secrets.get）' },
  { pattern: /['"`](?:node:)?(?:child_process|fs|fs\/promises|os|net|tls|vm)['"`]/, reason: '禁止导入危险 Node 原生模块' },
  { pattern: /\beval\s*\(/, reason: '禁止使用 eval()' },
  { pattern: /\bnew\s+Function\s*\(/, reason: '禁止使用 new Function()' },
];

function parseArgs(argv: string[]) {
  let appDir = process.cwd();
  let port = 8787;
  let envFile = '.env.local';
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--port' || arg === '-p') {
      const next = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(next) && next > 0 && next < 65535) port = next;
      i += 1;
    } else if (arg === '--env') {
      if (argv[i + 1]) envFile = argv[i + 1]!;
      i += 1;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  if (positional[0]) {
    appDir = path.resolve(process.cwd(), positional[0]);
  }
  return { appDir, port, envFile };
}

function loadEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function resolveRouteFile(fnDir: string, route: string): string | null {
  for (const ext of ['.ts', '.js', '.mjs']) {
    const full = path.join(fnDir, `${route}${ext}`);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

function warnIfDangerous(filePath: string): void {
  const src = fs.readFileSync(filePath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  for (const rule of DANGEROUS_CHECKS) {
    if (rule.pattern.test(src)) {
      console.warn(
        `\x1b[33m[orbit-fn-dev 安全预检警告]\x1b[0m ${path.basename(filePath)}: ${rule.reason}（上传审核时将被服务端拦截）`,
      );
    }
  }
}

function isDomainAllowed(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const raw of allowedDomains) {
    const d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]!.split(':')[0]!;
    if (!d) continue;
    if (d.startsWith('*.')) {
      const suffix = d.slice(1);
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === d) {
      return true;
    }
  }
  return false;
}

const { appDir, port, envFile } = parseArgs(process.argv.slice(2));
const manifestPath = path.join(appDir, 'orbit.manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`\x1b[31m[orbit-fn-dev] 未找到 ${manifestPath}\x1b[0m`);
  console.error('用法：bun run fn:dev -- <包含 orbit.manifest.json 的作品目录> [--port 8787]');
  process.exit(1);
}

const roomStore = new Map<string, { value: unknown; version: number; expiresAt: number }>();
const kvStore = new Map<string, unknown>();

function readManifest(): DevManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DevManifest;
}

const initialManifest = readManifest();
const initialRoutes = initialManifest.functions?.routes ?? [];
const initialFnDir = path.join(appDir, initialManifest.functions?.dir || 'functions');

console.log(`\x1b[36m[orbit-fn-dev]\x1b[0m 已启动本地云函数热调试服务：http://127.0.0.1:${port}`);
console.log(`  应用目录：${appDir}`);
console.log(`  应用 ID ：${initialManifest.id} (${initialManifest.name ?? '未命名'})`);
console.log(`  函数目录：${initialFnDir}`);
console.log(`  声明路由：${initialRoutes.length > 0 ? initialRoutes.join(', ') : '（尚未在 manifest.functions.routes 中声明）'}`);
console.log(`  本地密钥：${path.join(appDir, envFile)}（如存在将注入 ctx.secrets.get）`);
console.log('  提示：在 Orbit 客户端使用「本地目录 / Localhost 热重载」运行作品时，orbitSDK.cloud.call / stream 会自动直连本服务。\n');

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/_orbit_fn_dev/health' && req.method === 'GET') {
      const m = readManifest();
      return Response.json({
        ok: true,
        mode: 'orbit-fn-dev',
        appId: m.id,
        routes: m.functions?.routes ?? [],
      });
    }

    const match = url.pathname.match(/^\/invoke\/([^/]+)$/);
    if (!match || req.method !== 'POST') {
      return Response.json({ ok: false, error: 'Not Found' }, { status: 404 });
    }

    const fnName = decodeURIComponent(match[1]!);
    const manifest = readManifest();
    const fnDir = path.join(appDir, manifest.functions?.dir || 'functions');
    const declaredRoutes = manifest.functions?.routes ?? [];
    if (declaredRoutes.length > 0 && !declaredRoutes.includes(fnName)) {
      return Response.json(
        { ok: false, error: `路由 "${fnName}" 未在 orbit.manifest.json 的 functions.routes 中声明` },
        { status: 404 },
      );
    }

    const entryPath = resolveRouteFile(fnDir, fnName);
    if (!entryPath) {
      return Response.json(
        { ok: false, error: `缺少路由入口文件：${path.join(fnDir, `${fnName}.ts`)}` },
        { status: 404 },
      );
    }

    warnIfDangerous(entryPath);

    let body: unknown = {};
    try {
      const rawText = await req.text();
      body = rawText.trim() ? JSON.parse(rawText) : {};
    } catch {
      body = {};
    }

    // 解析 Orbit 桌面端传入的真实当前用户头（无头时降级为本地调试用户）
    let user = {
      userId: 'dev-local-user',
      username: 'dev',
      displayName: '本地调试开发者',
      isCaptain: true,
    };
    const rawUserB64 = req.headers.get('x-orbit-dev-user');
    if (rawUserB64) {
      try {
        user = { ...user, ...JSON.parse(Buffer.from(rawUserB64, 'base64').toString('utf8')) };
      } catch {
        // 忽略非法头
      }
    }

    const localSecrets = loadEnvFile(path.join(appDir, envFile));
    const allowedDomains = manifest.permissions?.networkDomains ?? [];
    const realtimeEvents: Array<{ targetUserId?: string; roomId?: string; event: string; payload: unknown }> = [];

    const ctx = {
      appId: manifest.id,
      versionId: 'local-dev',
      fnName,
      requestId: crypto.randomUUID(),
      user,
      roomState: {
        get: async <T = unknown>(roomId: string): Promise<T | null> => {
          const item = roomStore.get(roomId);
          if (!item || Date.now() >= item.expiresAt) {
            roomStore.delete(roomId);
            return null;
          }
          return item.value as T;
        },
        set: async (roomId: string, value: unknown, ttlSeconds = 3600): Promise<void> => {
          const cur = roomStore.get(roomId);
          roomStore.set(roomId, {
            value: value ?? null,
            version: (cur?.version ?? 0) + 1,
            expiresAt: Date.now() + ttlSeconds * 1000,
          });
        },
        update: async <T = unknown>(
          roomId: string,
          mutator: (prev: T | null) => T,
          ttlSeconds = 3600,
        ): Promise<T> => {
          const cur = roomStore.get(roomId);
          const prev = cur && Date.now() < cur.expiresAt ? (cur.value as T) : null;
          const next = mutator(prev);
          roomStore.set(roomId, {
            value: next,
            version: (cur?.version ?? 0) + 1,
            expiresAt: Date.now() + ttlSeconds * 1000,
          });
          return next;
        },
        del: async (roomId: string): Promise<void> => {
          roomStore.delete(roomId);
        },
      },
      realtime: {
        sendToUser: async (targetUserId: string, event: string, payload?: unknown) => {
          console.log(`\x1b[35m[realtime.sendToUser]\x1b[0m -> ${targetUserId} | ${event}`, payload ?? null);
          realtimeEvents.push({ targetUserId, event, payload: payload ?? null });
        },
        broadcastRoom: async (roomId: string, event: string, payload?: unknown) => {
          console.log(`\x1b[35m[realtime.broadcastRoom]\x1b[0m -> #${roomId} | ${event}`, payload ?? null);
          realtimeEvents.push({ roomId, event, payload: payload ?? null });
        },
      },
      kv: {
        get: async <T = unknown>(key: string): Promise<T | null> =>
          (kvStore.has(key) ? (kvStore.get(key) as T) : null),
        set: async (key: string, value: unknown) => {
          kvStore.set(key, value ?? null);
        },
        del: async (key: string) => {
          kvStore.delete(key);
        },
        keys: async () => [...kvStore.keys()].sort(),
      },
      economy: {
        getWager: async (orderId: string) => ({
          orderId,
          appId: manifest.id,
          status: 'locked',
          asset: 'coin',
          amount: 10,
          creatorUserId: user.userId,
          opponentUserId: 'dev-opponent',
          mock: true,
        }),
        settleWager: async (
          orderId: string,
          input: { result: 'win' | 'draw' | 'refund'; winnerUserId?: string; summary?: string },
        ) => {
          console.log(`\x1b[32m[economy.settleWager MOCK]\x1b[0m ${orderId}`, input);
          return { ok: true, orderId, ...input, mock: true };
        },
      },
      secrets: {
        get: async (name: string): Promise<string | null> =>
          localSecrets[name] ?? process.env[name] ?? null,
      },
      fetch: async (rawUrl: string, init?: RequestInit) => {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:') {
          throw new Error('云函数 ctx.fetch 仅允许发起 HTTPS 外网请求');
        }
        if (!isDomainAllowed(parsed.hostname, allowedDomains)) {
          throw new Error(
            `安全拦截：域名 ${parsed.hostname} 未在 orbit.manifest.json 的 permissions.networkDomains 中声明`,
          );
        }
        return fetch(parsed.href, init);
      },
    };

    const startedAt = Date.now();
    try {
      const modUrl = `${pathToFileURL(entryPath).href}?t=${Date.now()}`;
      const mod = (await import(modUrl)) as { default?: unknown; handler?: unknown };
      const handler = (mod.default ?? mod.handler) as
        | ((c: typeof ctx, b: unknown, r: Request) => unknown | Promise<unknown>)
        | undefined;
      if (typeof handler !== 'function') {
        throw new Error(`云函数 ${fnName} 必须使用 export default 导出处理函数`);
      }

      const result = await handler(ctx, body, req);
      const elapsed = Date.now() - startedAt;
      console.log(`\x1b[32m[POST /invoke/${fnName}]\x1b[0m 200 (${elapsed}ms)`);

      const extraHeaders: Record<string, string> = {};
      if (realtimeEvents.length > 0) {
        extraHeaders['X-Orbit-Dev-Realtime'] = Buffer.from(
          JSON.stringify(realtimeEvents),
          'utf8',
        ).toString('base64');
      }

      if (result instanceof Response) {
        const h = new Headers(result.headers);
        for (const [k, v] of Object.entries(extraHeaders)) h.set(k, v);
        return new Response(result.body, { status: result.status, headers: h });
      }

      if (
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in (result as Record<symbol, unknown>)
      ) {
        const iter = result as AsyncIterable<unknown>;
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of iter) {
                const line = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
                controller.enqueue(enc.encode(`data: ${line}\n\n`));
              }
              controller.enqueue(enc.encode('event: done\ndata: {}\n\n'));
              controller.close();
            } catch (streamErr) {
              const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
              controller.enqueue(
                enc.encode(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`),
              );
              controller.close();
            }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...extraHeaders,
          },
        });
      }

      return Response.json(
        { ok: true, data: result ?? null },
        { status: 200, headers: extraHeaders },
      );
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\x1b[31m[POST /invoke/${fnName}]\x1b[0m 400 (${elapsed}ms): ${msg}`);
      return Response.json({ ok: false, error: msg }, { status: 400 });
    }
  },
});

process.on('SIGINT', () => {
  server.stop();
  process.exit(0);
});
