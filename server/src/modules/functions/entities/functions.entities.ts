import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export interface StoredFunctionFile {
  path: string;
  contentBase64: string;
  isBinary: boolean;
  sizeBytes: number;
}

/** 工坊版本关联的托管云函数源码/Wasm 包（随 ZIP 校验提取，过审后由 edge-runtime 按需拉取执行）。 */
@Entity({ name: 'mini_app_function_bundles' })
@Index('idx_mini_app_fn_bundles_app', ['appId', 'createdAt'])
export class MiniAppFunctionBundleEntity {
  @PrimaryColumn({ name: 'version_id', type: 'uuid' })
  versionId: string;

  @Column({ name: 'app_id', type: 'text' })
  appId: string;

  @Column({ name: 'version', type: 'text' })
  version: string;

  @Column({ name: 'routes_json', type: 'jsonb', default: () => "'[]'::jsonb" })
  routesJson: string[];

  @Column({ name: 'files_json', type: 'jsonb', default: () => "'[]'::jsonb" })
  filesJson: StoredFunctionFile[];

  @Column({ name: 'timeout_ms', type: 'int', default: 5000 })
  timeoutMs: number;

  @Column({ name: 'allow_streaming', type: 'boolean', default: false })
  allowStreaming: boolean;

  @Column({ name: 'sha256', type: 'text' })
  sha256: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

/** 应用级全局持久化 KV（供云函数 ctx.kv 读写榜单、全局配置等跨玩家共享数据）。 */
@Entity({ name: 'mini_app_global_kv' })
export class MiniAppGlobalKvEntity {
  @PrimaryColumn({ name: 'app_id', type: 'text' })
  appId: string;

  @PrimaryColumn({ name: 'key', type: 'text' })
  key: string;

  @Column({ name: 'value_json', type: 'jsonb', default: () => "'null'::jsonb" })
  valueJson: unknown;

  @Column({ name: 'size_bytes', type: 'int', default: 0 })
  sizeBytes: number;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** 应用专属加密环境变量（AES-256-GCM 静态加密，仅本应用云函数 ctx.secrets.get 可读）。 */
@Entity({ name: 'mini_app_secrets' })
export class MiniAppSecretEntity {
  @PrimaryColumn({ name: 'app_id', type: 'text' })
  appId: string;

  @PrimaryColumn({ name: 'name', type: 'text' })
  name: string;

  @Column({ name: 'value_sealed', type: 'text' })
  valueSealed: string;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy: string;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
