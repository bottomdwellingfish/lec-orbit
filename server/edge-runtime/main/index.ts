/**
 * Orbit FaaS 运行时主路由入口（运行于 supabase/edge-runtime:v1.67.4 Main Worker）：
 * - 监听内网端口 9000，仅接受携带有效 X-Orbit-Internal-Token 的 lec-orbit-server 转发请求；
 * - 按 appId / versionId 从 lec-orbit-server 内网按需拉取已过审函数包并物化到 /tmp/orbit-fn/；
 * - 通过 EdgeRuntime.userWorkers.create() 为每个函数创建独立 V8 Isolate，强控 64MB 内存与超时熔断；
 * - 零敏感密钥注入 User Worker，所有平台能力均通过 15 秒单次上下文 JWT 回连 Orbit 内网桥接。
 */
declare const EdgeRuntime: {
  userWorkers: {
    create: (opts: {
      servicePath: string;
      memoryLimitMb?: number;
      workerTimeoutMs?: number;
      cpuTimeSoftLimitMs?: number;
      cpuTimeHardLimitMs?: number;
      noModuleCache?: boolean;
      envVars?: Array<[string, string]>;
      forceCreate?: boolean;
    }) => Promise<{ fetch: (req: Request) => Promise<Response> }>;
  };
};

interface BundleFileEntry {
  path: string;
  contentBase64: string;
  isBinary: boolean;
}

interface RemoteBundlePayload {
  appId: string;
  versionId: string;
  version: string;
  routes: string[];
  timeoutMs: number;
  allowStreaming: boolean;
  sha256: string;
  files: BundleFileEntry[];
}

const CACHE_ROOT = '/var/lib/orbit-fn';
const ORBIT_INTERNAL_URL = (Deno.env.get('ORBIT_INTERNAL_URL') ?? '').replace(/\/+$/, '');
const ORBIT_INTERNAL_TOKEN = Deno.env.get('ORBIT_INTERNAL_TOKEN') ?? '';
const CTX_SDK_PATH = '/home/deno/main/_orbit_ctx.ts';

const materializeInFlight = new Map<string, Promise<RemoteBundlePayload>>();
const bundleMetaCache = new Map<string, RemoteBundlePayload>();
let cachedCtxSdkSource: string | null = null;

function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function isSafeSegment(seg: string): boolean {
  return /^[a-zA-Z0-9._-]{1,80}$/.test(seg) && !seg.includes('..');
}

function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) {
    return false;
  }
  return rel.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');
}

function resolveRouteEntryFile(files: BundleFileEntry[], route: string): string | null {
  const candidates = [
    `${route}.ts`,
    `${route}.js`,
    `${route}.mjs`,
    `${route}/index.ts`,
    `${route}/index.js`,
    `${route}/index.mjs`,
  ];
  const set = new Set(files.map((f) => f.path));
  for (const c of candidates) {
    if (set.has(c)) return c;
  }
  return null;
}

async function loadCtxSdkSource(): Promise<string> {
  if (cachedCtxSdkSource !== null) return cachedCtxSdkSource;
  cachedCtxSdkSource = await Deno.readTextFile(CTX_SDK_PATH);
  return cachedCtxSdkSource;
}

/** 从 lec-orbit-server 拉取并物化指定版本的全部函数文件与按路由封装的入口。 */
async function ensureBundleMaterialized(
  appId: string,
  versionId: string,
): Promise<RemoteBundlePayload> {
  const cacheKey = `${appId}:${versionId}`;
  const cached = bundleMetaCache.get(cacheKey);
  if (cached) return cached;

  const existing = materializeInFlight.get(cacheKey);
  if (existing) return existing;

  const task = (async () => {
    const resp = await fetch(
      `${ORBIT_INTERNAL_URL}/internal/v1/functions/bundle/${encodeURIComponent(appId)}/${encodeURIComponent(versionId)}`,
      {
        headers: { 'X-Orbit-Internal-Token': ORBIT_INTERNAL_TOKEN },
      },
    );
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`拉取云函数包失败（HTTP ${resp.status}）：${txt.slice(0, 200)}`);
    }
    const bundle = (await resp.json()) as RemoteBundlePayload;
    const baseDir = `${CACHE_ROOT}/${appId}/${versionId}`;
    const ctxSource = await loadCtxSdkSource();

    // 预解码用户函数源码与 .wasm 资产，写入每个路由独立的自包含目录（杜绝 ../ 跨 servicePath 导入报错）
    const decodedFiles = bundle.files
      .filter((f) => isSafeRelPath(f.path))
      .map((f) => ({ path: f.path, bytes: decodeBase64ToBytes(f.contentBase64) }));

    for (const route of bundle.routes) {
      if (!isSafeSegment(route)) continue;
      const entryFile = resolveRouteEntryFile(bundle.files, route);
      if (!entryFile) continue;
      const fnDir = `${baseDir}/fn_${route}`;
      const srcDir = `${fnDir}/src`;
      await Deno.mkdir(srcDir, { recursive: true });
      await Deno.writeTextFile(`${fnDir}/_orbit_ctx.ts`, ctxSource);

      for (const file of decodedFiles) {
        const targetPath = `${srcDir}/${file.path}`;
        const lastSlash = targetPath.lastIndexOf('/');
        if (lastSlash > 0) {
          await Deno.mkdir(targetPath.slice(0, lastSlash), { recursive: true });
        }
        await Deno.writeFile(targetPath, file.bytes);
      }

      const wrapper = [
        `import * as userMod from './src/${entryFile}';`,
        `import { serveOrbitFunction } from './_orbit_ctx.ts';`,
        `const handler = (userMod as Record<string, unknown>).default ?? (userMod as Record<string, unknown>).handler;`,
        `serveOrbitFunction(handler as never);`,
        '',
      ].join('\n');
      await Deno.writeTextFile(`${fnDir}/index.ts`, wrapper);
    }

    bundleMetaCache.set(cacheKey, bundle);
    return bundle;
  })().finally(() => {
    materializeInFlight.delete(cacheKey);
  });

  materializeInFlight.set(cacheKey, task);
  return task;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // K8s 探针健康检查
  if (url.pathname === '/_internal/health' && req.method === 'GET') {
    return new Response(
      JSON.stringify({ ok: true, runtime: 'supabase-edge-runtime', version: '1.67.4' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 强校验内网服务令牌，阻断任何非 lec-orbit-server 直接调用
  const gotToken = req.headers.get('x-orbit-internal-token') ?? '';
  if (!ORBIT_INTERNAL_TOKEN || gotToken !== ORBIT_INTERNAL_TOKEN) {
    return new Response(JSON.stringify({ error: 'Forbidden: invalid internal token' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 匹配 POST /invoke/:appId/:versionId/:fnName
  const match = url.pathname.match(/^\/invoke\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match || req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const appId = decodeURIComponent(match[1]);
  const versionId = decodeURIComponent(match[2]);
  const fnName = decodeURIComponent(match[3]);
  if (!isSafeSegment(appId) || !isSafeSegment(versionId) || !isSafeSegment(fnName)) {
    return new Response(JSON.stringify({ error: 'Invalid invocation path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const bundle = await ensureBundleMaterialized(appId, versionId);
    if (!bundle.routes.includes(fnName)) {
      return new Response(JSON.stringify({ error: `未声明的云函数路由：${fnName}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const servicePath = `${CACHE_ROOT}/${appId}/${versionId}/fn_${fnName}`;
    const timeoutMs = bundle.allowStreaming
      ? Math.min(Math.max(bundle.timeoutMs || 5000, 1000), 60_000)
      : Math.min(Math.max(bundle.timeoutMs || 5000, 500), 15_000);

    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 64,
      workerTimeoutMs: timeoutMs,
      cpuTimeSoftLimitMs: 1500,
      cpuTimeHardLimitMs: Math.min(timeoutMs, 4000),
      noModuleCache: false,
      envVars: [['ORBIT_BRIDGE_URL', ORBIT_INTERNAL_URL]],
    });

    // 直接透传原生 Request 给 User Worker（supabase/edge-runtime 要求保留 streamRid）；
    // 敏感请求头由 _orbit_ctx.ts 包装层在进入用户 handler 前统一脱敏剥离。
    return await worker.fetch(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `云函数执行异常：${message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
