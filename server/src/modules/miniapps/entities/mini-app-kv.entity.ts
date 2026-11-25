import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 工坊应用用户云存档（按 app_id + user_id 隔离，免自建后端）。 */
@Entity({ name: 'mini_app_kv' })
export class MiniAppKvEntity {
  @PrimaryColumn({ name: 'app_id', type: 'text' })
  appId: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @PrimaryColumn({ name: 'key', type: 'text' })
  key: string;

  @Column({ name: 'value_json', type: 'jsonb', default: () => "'null'::jsonb" })
  valueJson: unknown;

  @Column({ name: 'size_bytes', type: 'int', default: 0 })
  sizeBytes: number;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
