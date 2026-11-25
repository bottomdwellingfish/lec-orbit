/**
 * 零外部 SDK 依赖的 AWS SigV4 上传器，直连校园统一 RustFS 对象存储。
 * 逻辑与原 Go 版 internal/storage/s3.go 完全一致。
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

@Injectable()
export class S3StorageService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.s3Endpoint && this.cfg.s3AccessKey && this.cfg.s3SecretKey);
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

    const parsed = new URL(this.cfg.s3Endpoint);
    const canonicalUri = `/${encodeS3Path(`${this.cfg.s3Bucket}/${fullKey}`)}`;
    const targetUrl = `${parsed.protocol}//${parsed.host}${canonicalUri}`;

    const now = new Date();
    const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const amzDate = iso; // YYYYMMDDTHHMMSSZ
    const dateStamp = iso.slice(0, 8);
    const payloadHash = sha256Hex(data);

    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${parsed.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'PUT',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.cfg.s3Region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = deriveSigningKey(this.cfg.s3SecretKey, dateStamp, this.cfg.s3Region, 's3');
    const signature = hmacSha256(signingKey, stringToSign).toString('hex');
    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.s3AccessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const resp = await fetch(targetUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: authHeader,
      },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 512).trim();
      throw new Error(`上传 RustFS 失败（HTTP ${resp.status}）: ${body}`);
    }

    return `${this.cfg.s3PublicBaseUrl}/${cleanRel}`;
  }
}
