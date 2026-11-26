/**
 * 零外部 SDK 依赖的 AWS SigV4 对象存储客户端，直连校园统一 RustFS：
 * - Orbit 公开静态资产（lec-public/orbit/...）：公告插图、工坊 ZIP 构建包与图标；
 * - LecPunch 私有资产（lec-private/punch/...）：卡牌立绘与举报附件图鉴权读写。
 */
import { createHash, createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function encodeS3Path(rawPath: string): string {
  return rawPath
    .replace(/^\/+/, '')
    .split('/')
    .filter((s) => s.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

interface S3TargetConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

@Injectable()
export class S3StorageService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.s3Endpoint && this.cfg.s3AccessKey && this.cfg.s3SecretKey);
  }

  isPunchPrivateConfigured(): boolean {
    const p = this.cfg.punchStorage;
    return Boolean(p.endpoint && p.bucket && p.accessKey && p.secretKey);
  }

  /** 对任意 RustFS 桶执行 AWS SigV4 签名请求（支持 GET / PUT / DELETE）。 */
  private async signedRequest(
    target: S3TargetConfig,
    method: 'GET' | 'PUT' | 'DELETE',
    fullKey: string,
    opts?: { body?: Buffer; contentType?: string },
  ): Promise<Response> {
    const parsed = new URL(target.endpoint);
    const canonicalUri = `/${encodeS3Path(`${target.bucket}/${fullKey}`)}`;
    const targetUrl = `${parsed.protocol}//${parsed.host}${canonicalUri}`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(opts?.body ?? '');

    const headerPairs: Array<[string, string]> = [];
    if (opts?.contentType) {
      headerPairs.push(['content-type', opts.contentType]);
    }
    headerPairs.push(
      ['host', parsed.host],
      ['x-amz-content-sha256', payloadHash],
      ['x-amz-date', amzDate],
    );
    headerPairs.sort((a, b) => a[0].localeCompare(b[0]));

    const canonicalHeaders = headerPairs.map(([k, v]) => `${k}:${v}\n`).join('');
    const signedHeaders = headerPairs.map(([k]) => k).join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${target.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = deriveSigningKey(target.secretKey, dateStamp, target.region, 's3');
    const signature = hmacSha256(signingKey, stringToSign).toString('hex');
    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${target.accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const reqHeaders: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: authHeader,
    };
    if (opts?.contentType) {
      reqHeaders['Content-Type'] = opts.contentType;
    }

    return fetch(targetUrl, {
      method,
      headers: reqHeaders,
      body: opts?.body ? new Uint8Array(opts.body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
  }

  /** 上传公开静态对象（公告插图 / 工坊 ZIP 包 / 图标）并返回公开直链 URL。 */
  async putPublicObject(relKey: string, data: Buffer, contentType: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('RustFS 对象存储尚未配置');
    }
    const cleanRel = relKey.replace(/^\/+/, '');
    const fullKey =
      this.cfg.s3KeyPrefix && !cleanRel.startsWith(`${this.cfg.s3KeyPrefix}/`)
        ? `${this.cfg.s3KeyPrefix}/${cleanRel}`
        : cleanRel;

    const resp = await this.signedRequest(
      {
        endpoint: this.cfg.s3Endpoint,
        bucket: this.cfg.s3Bucket,
        region: this.cfg.s3Region,
        accessKey: this.cfg.s3AccessKey,
        secretKey: this.cfg.s3SecretKey,
      },
      'PUT',
      fullKey,
      { body: data, contentType },
    );

    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 512).trim();
      throw new Error(`上传 RustFS 失败（HTTP ${resp.status}）: ${body}`);
    }

    return `${this.cfg.s3PublicBaseUrl}/${cleanRel}`;
  }

  /** 从 LecPunch 私有桶读取对象（卡牌立绘 / 举报图片），不存在时返回 null。 */
  async getPunchPrivateObject(
    fullKey: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    if (!this.isPunchPrivateConfigured()) {
      return null;
    }
    const resp = await this.signedRequest(this.cfg.punchStorage, 'GET', fullKey);
    if (resp.status === 404) {
      return null;
    }
    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 256).trim();
      throw new Error(`读取私有 RustFS 对象失败（HTTP ${resp.status}）: ${text}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return {
      body: buf,
      contentType: resp.headers.get('content-type') || 'application/octet-stream',
    };
  }

  /** 写入 LecPunch 私有桶对象（举报图片等）。 */
  async putPunchPrivateObject(
    fullKey: string,
    data: Buffer,
    contentType: string,
  ): Promise<void> {
    if (!this.isPunchPrivateConfigured()) {
      throw new Error('LecPunch 私有 RustFS 尚未配置');
    }
    const resp = await this.signedRequest(this.cfg.punchStorage, 'PUT', fullKey, {
      body: data,
      contentType,
    });
    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 256).trim();
      throw new Error(`上传私有 RustFS 对象失败（HTTP ${resp.status}）: ${text}`);
    }
  }

  /** 删除 LecPunch 私有桶对象（举报图过期清理 / 回滚）。 */
  async deletePunchPrivateObject(fullKey: string): Promise<void> {
    if (!this.isPunchPrivateConfigured()) return;
    await this.signedRequest(this.cfg.punchStorage, 'DELETE', fullKey).catch(() => undefined);
  }
}
