/**
 * Orbit 实时推送 WebSocket Hub：
 * - 挂载在 HTTP Server 的 /api/v1/ws 升级路径上，100% 兼容原有桌面端原始 JSON 协议 { type, payload }；
 * - 复用 AuthService 校验 Bearer / query.token 身份；
 * - 30 秒心跳保活；
 * - 若配置了 REDIS_URL，自动启用 Redis Pub/Sub 跨副本同步（未配置则纯本机分发）。
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import { AuthService } from '../auth/auth.service.js';

const REDIS_CHANNEL = 'lec:orbit:ws:events';

export interface RealtimeEvent {
  type: string;
  payload: unknown;
}

interface RealtimeEnvelope {
  targetUserId?: string;
  event: RealtimeEvent;
}

@Injectable()
export class RealtimeHub implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeHub.name);
  private readonly clients = new Map<string, Set<WebSocket>>();
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private redisPub: Redis | null = null;
  private redisSub: Redis | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.cfg.redisUrl) return;
    try {
      this.redisPub = new Redis(this.cfg.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      });
      this.redisSub = new Redis(this.cfg.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      });
      await this.redisPub.connect();
      await this.redisSub.connect();
      await this.redisSub.subscribe(REDIS_CHANNEL);
      this.redisSub.on('message', (_channel, raw) => {
        try {
          const env = JSON.parse(raw) as RealtimeEnvelope;
          this.deliverLocal(env);
        } catch {
          // 忽略格式异常消息
        }
      });
      this.logger.log('Redis Pub/Sub 实时推送总线已连接');
    } catch (err) {
      this.logger.warn(
        `Redis 不可用，自动降级为单机 WebSocket 推送: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.redisPub?.disconnect();
      this.redisSub?.disconnect();
      this.redisPub = null;
      this.redisSub = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close();
      this.wss = null;
    }
    this.redisPub?.disconnect();
    this.redisSub?.disconnect();
  }

  /** 将 WebSocket 升级监听挂载到 NestJS NodeAdapter 底层 http.Server。 */
  attachToHttpServer(httpServer: HttpServer): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/api/v1/ws') {
        socket.destroy();
        return;
      }
      void this.handleUpgrade(req, socket, head, url);
    });

    // 30 秒心跳保活
    this.heartbeatTimer = setInterval(() => {
      if (!this.wss) return;
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.ping();
        }
      }
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
  ): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      const token =
        authHeader && authHeader.toLowerCase().startsWith('bearer ')
          ? authHeader.slice(7).trim()
          : (url.searchParams.get('token') ?? '').trim();

      const user = await this.authService.verifyToken(token);
      if (!user.isStudio && !user.isCaptain) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.registerClient(user.userId, ws);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  }

  private registerClient(userId: string, ws: WebSocket): void {
    let set = this.clients.get(userId);
    if (!set) {
      set = new Set<WebSocket>();
      this.clients.set(userId, set);
    }
    set.add(ws);

    const cleanup = () => {
      const group = this.clients.get(userId);
      if (!group) return;
      group.delete(ws);
      if (group.size === 0) {
        this.clients.delete(userId);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  /** 向全员广播实时事件。 */
  async broadcast(event: RealtimeEvent): Promise<void> {
    await this.publish({ event });
  }

  /** 定向推送实时事件给指定成员。 */
  async pushToUser(userId: string, event: RealtimeEvent): Promise<void> {
    if (!userId) return;
    await this.publish({ targetUserId: userId, event });
  }

  private async publish(env: RealtimeEnvelope): Promise<void> {
    if (this.redisPub) {
      try {
        await this.redisPub.publish(REDIS_CHANNEL, JSON.stringify(env));
        return;
      } catch {
        // Redis 异常时回退本机投递
      }
    }
    this.deliverLocal(env);
  }

  private deliverLocal(env: RealtimeEnvelope): void {
    const raw = JSON.stringify(env.event);
    if (env.targetUserId) {
      const set = this.clients.get(env.targetUserId);
      if (!set) return;
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(raw);
        }
      }
      return;
    }

    for (const set of this.clients.values()) {
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(raw);
        }
      }
    }
  }
}
