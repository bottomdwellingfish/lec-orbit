import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 成员针对每条通知的已读记录。 */
@Entity({ name: 'notification_reads' })
export class NotificationReadEntity {
  @PrimaryColumn({ name: 'notification_id', type: 'uuid' })
  notificationId: string;

  @PrimaryColumn({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ name: 'read_at', type: 'timestamptz' })
  readAt: Date;
}
