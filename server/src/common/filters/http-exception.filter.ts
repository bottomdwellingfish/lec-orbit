/**
 * 全局异常过滤器：将 NestJS HttpException 与 Zod 校验错误统一输出为 { error: string }，
 * 与原 Orbit Go 服务端及桌面端解析协议保持 100% 兼容。
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ZodError } from 'zod';

@Catch()
export class OrbitHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(OrbitHttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<{
      status?: (code: number) => { json: (body: unknown) => void };
      statusCode?: number;
      setHeader?: (name: string, value: string) => void;
      end?: (body?: string) => void;
    }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = '服务端内部错误';

    if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      message = exception.issues[0]?.message || '请求参数格式无效';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string' && body.trim()) {
        message = body.trim();
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        // NestJS 默认把精准业务文案放在 message，而把通用英文状态名（如 "Bad Request"）放在 error，必须优先取 message
        if (typeof record.message === 'string' && record.message.trim()) {
          message = record.message.trim();
        } else if (Array.isArray(record.message)) {
          const joined = record.message
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .join('；');
          if (joined) message = joined;
        } else if (typeof record.error === 'string' && record.error.trim()) {
          message = record.error.trim();
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    } else {
      this.logger.error(`未知异常: ${String(exception)}`);
    }

    const payload = { error: message, message, statusCode: status };
    if (typeof res.status === 'function') {
      res.status(status).json(payload);
      return;
    }

    res.statusCode = status;
    res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
    res.end?.(JSON.stringify(payload));
  }
}
