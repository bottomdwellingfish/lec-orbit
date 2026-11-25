import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 跨项目更新、云文档权限申请/审批与交易通知。 */
@Entity({ name: 'notifications' })
@Index('idx_notifications_target_created', ['targetUserId', 'createdAt'])
@Index('idx_notifications_created', ['createdAt'])
export class NotificationEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id: string;

  @Index()
  @Column({ name: 'source_app', type: 'text' })
  sourceApp: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType: string;

  @Column({ name: 'title', type: 'text' })
  title: string;

  @Column({ name: 'body', type: 'text', default: '' })
  body: string;

  @Column({ name: 'payload', type: 'jsonb', default: () => "'{}'::jsonb" })
  payload: Record<string, unknown>;

  @Column({ name: 'target_user_id', type: 'text', nullable: true })
  targetUserId: string | null;

  @Column({ name: 'action_status', type: 'text', nullable: true })
  actionStatus: string | null;

  @Column({ name: 'action_note', type: 'text', nullable: true })
  actionNote: string | null;

  @Column({ name: 'action_by', type: 'text', nullable: true })
  actionBy: string | null;

  @Column({ name: 'action_at', type: 'timestamptz', nullable: true })
  actionAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
