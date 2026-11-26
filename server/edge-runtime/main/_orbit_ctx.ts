/**
 * Orbit FaaS 用户函数上下文注入 SDK（运行在隔离的 User Worker V8 Isolate 内）：
 * - 构造强类型 ctx（user / roomState / realtime / kv / economy / secrets / fetch）；
 * - 自动采集本次调用的 console.log / warn / error 随响应头回传环形日志；
 * - 原生兼容 3 种返回值：普通 JSON 对象、Web Response（含 SSE）、AsyncGenerator 流式输出。
 */

interface InjectedMeta {
  appId: string;
  versionId: string;
  fnName: string;
  requestId: string;
  allowedDomains: string[];
  user: {
    userId: string;
    username?: string;
    displayName: string;
    isCaptain: boolean;
  };
}

export interface OrbitFnContext {
  appId: string;
  versionId: string;
  fnName: string;
  requestId: string;
  user: InjectedMeta['user'];
  roomState: {
    get: <T = unknown>(roomId: string) => Promise<T | null>;
    set: (roomId: string, value: unknown, ttlSeconds?: number) => Promise<void>;
    update: <T = unknown>(
      roomId: string,
      mutator: (prev: T | null) => T,
      ttlSeconds?: number,
    ) => Promise<T>;
    del: (roomId: string) => Promise<void>;
  };
  realtime: {
    sendToUser: (targetUserId: string, event: string, payload?: unknown) => Promise<void>;
    broadcastRoom: (roomId: string, event: string, payload?: unknown) => Promise<void>;
  };
  kv: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<void>;
    del: (key: string) => Promise<void>;
    keys: () => Promise<string[]>;
  };
  economy: {
    getWager: (orderId: string) => Promise<Record<string, unknown>>;
    settleWager: (
      orderId: string,
      input: { result: 'win' | 'draw' | 'refund'; winnerUserId?: string; summary?: string },
    ) => Promise<Record<string, unknown>>;
  };
  secrets: {
    get: (name: string) => Promise<string | null>;
  };
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

type UserHandler = (ctx: OrbitFnContext, body: unknown, req: Request) => unknown | Promise<unknown>;

function isBlockedPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.svc') ||
    h.endsWith('.cluster.local') ||
    h === '::1' ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    h.startsWith('fe80:')
  ) {
    return true;
  }
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
  }
  return false;
}

function isDomainAllowed(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const raw of allowedDomains) {
    const d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    if (!d) continue;
    if (d.startsWith('*.')) {
      const suffix = d.slice(1); // '.example.com'
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === d) {
      return true;
    }
  }
  return false;
}

function encodeLogsHeader(logs: Array<{ level: string; text: string }>): string {
  if (logs.length === 0) return '';
  const trimmed = logs.slice(0, 30);
  const raw = JSON.stringify(trimmed).slice(0, 4096);
  const bytes = new TextEncoder().encode(raw);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function decodeBase64Json<T>(b64: string): T {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function serveOrbitFunction(handler: UserHandler): void {
  const bridgeBase = (Deno.env.get('ORBIT_BRIDGE_URL') ?? '').replace(/\/+$/, '');

  Deno.serve(async (req: Request): Promise<Response> => {
    if (typeof handler !== 'function') {
      return new Response(
        JSON.stringify({ error: '云函数必须默认导出 async function (ctx, body)' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const ctxToken = req.headers.get('x-orbit-fn-context-token') ?? '';
    const metaB64 = req.headers.get('x-orbit-fn-meta') ?? '';
    if (!ctxToken || !metaB64 || !bridgeBase) {
      return new Response(JSON.stringify({ error: '缺少云函数执行上下文' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let meta: InjectedMeta;
    try {
      meta = decodeBase64Json<InjectedMeta>(metaB64);
    } catch {
      return new Response(JSON.stringify({ error: '无效的云函数上下文元数据' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let body: unknown = {};
    const ct = (req.headers.get('content-type') ?? '').toLowerCase();
    const rawText = await req.text();
    if (rawText) {
      if (ct.includes('application/json') || rawText.trim().startsWith('{') || rawText.trim().startsWith('[')) {
        try {
          body = JSON.parse(rawText);
        } catch {
          body = rawText;
        }
      } else {
        body = rawText;
      }
    }

    const bridgeCall = async <T = unknown>(
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      payload?: unknown,
    ): Promise<T> => {
      const resp = await fetch(`${bridgeBase}/internal/v1/fn-bridge${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Orbit-Fn-Context-Token': ctxToken,
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      });
      const text = await resp.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { message: text };
        }
      }
      if (!resp.ok) {
        const errMsg =
          parsed && typeof parsed === 'object'
            ? String(
                (parsed as Record<string, unknown>).message ??
                  (parsed as Record<string, unknown>).error ??
                  `HTTP ${resp.status}`,
              )
            : `HTTP ${resp.status}`;
        throw new Error(errMsg);
      }
      return parsed as T;
    };

    const ctx: OrbitFnContext = {
      appId: meta.appId,
      versionId: meta.versionId,
      fnName: meta.fnName,
      requestId: meta.requestId,
      user: meta.user,

      roomState: {
        get: async <T = unknown>(roomId: string) => {
          const res = await bridgeCall<{ value: T | null }>(
            'GET',
            `/room-state/${encodeURIComponent(roomId)}`,
          );
          return res.value ?? null;
        },
        set: async (roomId: string, value: unknown, ttlSeconds = 3600) => {
          await bridgeCall('PUT', `/room-state/${encodeURIComponent(roomId)}`, {
            value,
            ttlSeconds,
          });
        },
        update: async <T = unknown>(
          roomId: string,
          mutator: (prev: T | null) => T,
          ttlSeconds = 3600,
        ) => {
          const cur = await bridgeCall<{ value: T | null; version: number }>(
            'GET',
            `/room-state/${encodeURIComponent(roomId)}`,
          );
          const next = mutator(cur.value ?? null);
          await bridgeCall('PUT', `/room-state/${encodeURIComponent(roomId)}`, {
            value: next,
            ttlSeconds,
            expectedVersion: cur.version,
          });
          return next;
        },
        del: async (roomId: string) => {
          await bridgeCall('DELETE', `/room-state/${encodeURIComponent(roomId)}`);
        },
      },

      realtime: {
        sendToUser: async (targetUserId: string, event: string, payload?: unknown) => {
          await bridgeCall('POST', '/realtime/user', { targetUserId, event, payload });
        },
        broadcastRoom: async (roomId: string, event: string, payload?: unknown) => {
          await bridgeCall('POST', '/realtime/room', { roomId, event, payload });
        },
      },

      kv: {
        get: async <T = unknown>(key: string) => {
          const res = await bridgeCall<{ value: T | null }>('GET', `/kv/${encodeURIComponent(key)}`);
          return res.value ?? null;
        },
        set: async (key: string, value: unknown) => {
          await bridgeCall('PUT', `/kv/${encodeURIComponent(key)}`, { value });
        },
        del: async (key: string) => {
          await bridgeCall('DELETE', `/kv/${encodeURIComponent(key)}`);
        },
        keys: async () => {
          const res = await bridgeCall<{ keys: string[] }>('GET', '/kv');
          return res.keys ?? [];
        },
      },

      economy: {
        getWager: (orderId: string) =>
          bridgeCall<Record<string, unknown>>('GET', `/economy/wagers/${encodeURIComponent(orderId)}`),
        settleWager: (orderId, input) =>
          bridgeCall<Record<string, unknown>>(
            'POST',
            `/economy/wagers/${encodeURIComponent(orderId)}/settle`,
            input,
          ),
      },

      secrets: {
        get: async (name: string) => {
          const res = await bridgeCall<{ value: string | null }>(
            'GET',
            `/secrets/${encodeURIComponent(name)}`,
          );
          return res.value ?? null;
        },
      },

      fetch: async (rawUrl: string, init?: RequestInit) => {
        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          throw new Error(`无效的外网请求地址：${rawUrl}`);
        }
        if (parsed.protocol !== 'https:') {
          throw new Error('云函数 ctx.fetch 仅允许发起 HTTPS 外网请求');
        }
        if (isBlockedPrivateHost(parsed.hostname)) {
          throw new Error(`安全拦截：禁止云函数访问内网或本机地址 (${parsed.hostname})`);
        }
        if (!isDomainAllowed(parsed.hostname, meta.allowedDomains ?? [])) {
          throw new Error(
            `安全拦截：域名 ${parsed.hostname} 未在 orbit.manifest.json 的 permissions.networkDomains 中声明`,
          );
        }
        return fetch(parsed.href, init);
      },
    };

    // 截获本次调用的 console 日志
    const logs: Array<{ level: string; text: string }> = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    const capture = (level: string) => (...args: unknown[]) => {
      if (logs.length < 30) {
        const text = args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, 300);
        logs.push({ level, text });
      }
    };
    console.log = capture('log');
    console.warn = capture('warn');
    console.error = capture('error');

    // 构造剔除内网与桥接令牌的脱敏 Request 供用户 handler 可选读取（杜绝触碰任何内部密钥）
    const safeHeaders = new Headers();
    const ctHeader = req.headers.get('content-type');
    const acceptHeader = req.headers.get('accept');
    if (ctHeader) safeHeaders.set('content-type', ctHeader);
    if (acceptHeader) safeHeaders.set('accept', acceptHeader);
    const sanitizedReq = new Request(req.url, { method: req.method, headers: safeHeaders });

    try {
      const result = await handler(ctx, body, sanitizedReq);
      const logsHeader = encodeLogsHeader(logs);

      if (result instanceof Response) {
        const headers = new Headers(result.headers);
        if (logsHeader) headers.set('X-Orbit-Fn-Logs', logsHeader);
        return new Response(result.body, { status: result.status, headers });
      }

      // 若返回 AsyncIterable（async function*），自动转 SSE 流式输出
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
              controller.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`));
              controller.close();
            }
          },
        });
        const headers: Record<string, string> = {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        };
        if (logsHeader) headers['X-Orbit-Fn-Logs'] = logsHeader;
        return new Response(stream, { status: 200, headers });
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
      if (logsHeader) headers['X-Orbit-Fn-Logs'] = logsHeader;
      return new Response(JSON.stringify({ ok: true, data: result ?? null }), {
        status: 200,
        headers,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push({ level: 'error', text: msg.slice(0, 300) });
      const logsHeader = encodeLogsHeader(logs);
      const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
      if (logsHeader) headers['X-Orbit-Fn-Logs'] = logsHeader;
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 400,
        headers,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }
  });
}
