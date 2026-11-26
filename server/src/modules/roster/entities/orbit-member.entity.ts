import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export interface OrbitMemberSocialSnapshot {
  github?: {
    username: string | null;
    name: string | null;
    avatar: string | null;
    profileUrl: string | null;
  } | null;
  feishu?: {
    name: string | null;
    enName: string | null;
    avatar: string | null;
    linked: boolean;
  } | null;
}

/** 工作室成员花名册缓存（同步自 LecSSO lec-studio 组织）。 */
@Entity({ name: 'orbit_members' })
export class OrbitMemberEntity {
  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'username', type: 'text', default: '' })
  username: string;

  @Column({ name: 'display_name', type: 'text', default: '' })
  displayName: string;

  @Column({ name: 'avatar', type: 'text', default: '' })
  avatar: string;

  @Column({ name: 'is_captain', type: 'boolean', default: false })
  isCaptain: boolean;

  @Column({ name: 'enroll_year', type: 'int', nullable: true })
  enrollYear: number | null;

  @Column({ name: 'roles_json', type: 'jsonb', default: () => "'[]'::jsonb" })
  rolesJson: string[];

  @Column({ name: 'social_json', type: 'jsonb', default: () => "'{}'::jsonb" })
  socialJson: OrbitMemberSocialSnapshot;

  @Index()
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
