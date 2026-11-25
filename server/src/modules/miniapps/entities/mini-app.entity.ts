import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 工坊小程序与小游戏元数据主表（仅限 lec-studio 内部成员可见与发布）。 */
@Entity({ name: 'mini_apps' })
export class MiniAppEntity {
  @PrimaryColumn({ name: 'id', type: 'text' })
  id: string;

  @Column({ name: 'name', type: 'text' })
  name: string;

  @Index()
  @Column({ name: 'type', type: 'text' })
  type: string;

  @Index()
  @Column({ name: 'engine', type: 'text' })
  engine: string;

  @Column({ name: 'description', type: 'text', default: '' })
  description: string;

  @Column({ name: 'icon_url', type: 'text', default: '' })
  iconUrl: string;

  @Column({ name: 'tags_json', type: 'jsonb', default: () => "'[]'::jsonb" })
  tagsJson: string[];

  @Index()
  @Column({ name: 'owner_id', type: 'text' })
  ownerId: string;

  @Column({ name: 'owner_name', type: 'text', default: '' })
  ownerName: string;

  @Column({ name: 'owner_avatar', type: 'text', default: '' })
  ownerAvatar: string;

  @Index()
  @Column({ name: 'status', type: 'text', default: 'draft' })
  status: string;

  @Column({ name: 'active_version_id', type: 'uuid', nullable: true })
  activeVersionId: string | null;

  @Column({ name: 'featured_rank', type: 'int', default: 0 })
  featuredRank: number;

  @Column({ name: 'play_count', type: 'bigint', default: 0 })
  playCount: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
