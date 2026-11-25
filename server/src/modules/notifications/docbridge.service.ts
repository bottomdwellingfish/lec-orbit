/**
 * LecDoc 内部桥接服务（等价迁移原 Go internal/docbridge/client.go）。
 */
import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';

export interface DocPageMeta {
  pageId: string;
  slugId: string;
  title: string;
  classification: string;
  creatorSsoSub: string;
  creatorName: string;
  requesterCanEdit: boolean;
  pageUrl: string;
}

@Injectable()
export class DocBridgeService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.lecDocInternalUrl && this.cfg.lecDocInternalToken);
  }

  async resolvePageMeta(slugOrId: string, requesterSsoSub: string): Promise<DocPageMeta> {
    if (!this.isConfigured()) {
      throw new BadGatewayException('LecDoc 内部桥接未配置');
    }
    const resp = await fetch(`${this.cfg.lecDocInternalUrl}/api/lec/pages/internal/orbit-page-meta`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orbit-Internal-Token': this.cfg.lecDocInternalToken,
      },
      body: JSON.stringify({
        pageKey: slugOrId.trim(),
        requesterSsoSub,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      throw new BadGatewayException(
        `查询云文档信息失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    const text = (await resp.text().catch(() => '')).slice(0, 4096);
    if (!resp.ok) {
      throw new BadGatewayException(`查询云文档信息失败（HTTP ${resp.status}）: ${text.trim()}`);
    }

    const parsed = JSON.parse(text) as { data?: DocPageMeta } & Partial<DocPageMeta>;
    const meta = parsed.data?.pageId ? parsed.data : (parsed as DocPageMeta);
    return meta;
  }

  async grantEditorAccess(
    pageId: string,
    requesterSsoSub: string,
    authorSsoSub: string,
  ): Promise<void> {
    if (!this.isConfigured()) {
      throw new BadGatewayException('LecDoc 内部桥接未配置');
    }
    const resp = await fetch(
      `${this.cfg.lecDocInternalUrl}/api/lec/pages/internal/orbit-grant-editor`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orbit-Internal-Token': this.cfg.lecDocInternalToken,
        },
        body: JSON.stringify({ pageId, requesterSsoSub, authorSsoSub }),
        signal: AbortSignal.timeout(10_000),
      },
    ).catch((err: unknown) => {
      throw new BadGatewayException(
        `云文档授予编辑权失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 1024).trim();
      throw new BadGatewayException(`云文档授予编辑权失败（HTTP ${resp.status}）: ${text}`);
    }
  }
}
