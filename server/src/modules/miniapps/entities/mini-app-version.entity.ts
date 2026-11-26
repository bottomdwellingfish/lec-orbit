import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 工坊应用构建版本（支持 RustFS 直传 <=100MB 与 GitHub Releases 导入双源）。 */
@Entity({ name: 'mini_app_versions' })
@Index('idx_mini_app_versions_app_created', ['appId', 'createdAt'])
export class MiniAppVersionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id: string;

  @Column({ name: 'app_id', type: 'text' })
  appId: string;

  @Column({ name: 'version', type: 'text' })
  version: string;

  @Column({ name: 'channel', type: 'text', default: 'preview' })
  channel: string;

  @Index()
  @Column({ name: 'status', type: 'text', default: 'pending' })
  status: string;

  @Column({ name: 'source_type', type: 'text', default: 'rustfs' })
  sourceType: string;

  @Column({ name: 'bundle_url', type: 'text' })
  bundleUrl: string;

  @Column({ name: 'bundle_key', type: 'text', default: '' })
  bundleKey: string;

  @Column({ name: 'bundle_sha256', type: 'text' })
  bundleSha256: string;

  @Column({ name: 'bundle_size', type: 'bigint', default: 0 })
  bundleSize: string;

  @Column({ name: 'icon_url', type: 'text', nullable: true })
  iconUrl: string | null;

  @Column({ name: 'manifest_json', type: 'jsonb', default: () => "'{}'::jsonb" })
  manifestJson: Record<string, unknown>;

  @Column({ name: 'changelog', type: 'text', default: '' })
  changelog: string;

  @Column({ name: 'uploader_id', type: 'text' })
  uploaderId: string;

  @Column({ name: 'reviewer_id', type: 'text', nullable: true })
  reviewerId: string | null;

  @Column({ name: 'review_note', type: 'text', nullable: true })
  reviewNote: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;
}
