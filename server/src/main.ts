/**
 * 乐程 Orbit 统一核心服务端入口（NestJS 12 + @nestjs/platform-node 官方原生 HTTP 底层 + TypeORM + PostgreSQL）。
 * 同时兼容 Bun 1.3+ 与 Node.js 22+ 运行时。
 */
import 'reflect-metadata';
import type { Server as HttpServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NodeAdapter } from '@nestjs/platform-node';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/env.config.js';
import { OrbitHttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { RealtimeHub } from './modules/realtime/realtime.hub.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, new NodeAdapter(), {
    rawBody: true,
  });

  app.enableCors({
    origin: true,
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Accept',
      'X-Orbit-Service-Token',
      'X-Orbit-Internal-Token',
      'X-Orbit-App-Id',
      'X-Orbit-Timestamp',
      'X-Orbit-Nonce',
      'X-Orbit-Signature',
    ],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalFilters(new OrbitHttpExceptionFilter());
  app.enableShutdownHooks();

  const cfg = app.get<AppConfig>(APP_CONFIG);
  const hub = app.get(RealtimeHub);

  await app.listen(cfg.port, '0.0.0.0');
  const httpServer = app.getHttpServer() as HttpServer;
  hub.attachToHttpServer(httpServer);

  logger.log(
    `lec-orbit-server (NestJS 12 / @nestjs/platform-node) 已监听 :${cfg.port} | runtime=${typeof Bun !== 'undefined' ? `bun-${Bun.version}` : `node-${process.version}`}`,
  );
}

bootstrap().catch((err) => {
  console.error('[bootstrap] 服务启动失败:', err);
  process.exit(1);
});
