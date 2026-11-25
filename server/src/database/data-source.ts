import { DataSource, type DataSourceOptions } from 'typeorm';
import type { AppConfig } from '../config/env.config.js';
import { OrbitMemberEntity } from '../modules/roster/entities/orbit-member.entity.js';
import { AnnouncementEntity } from '../modules/announcements/entities/announcement.entity.js';
import { AnnouncementReceiptEntity } from '../modules/announcements/entities/announcement-receipt.entity.js';
import { NotificationEntity } from '../modules/notifications/entities/notification.entity.js';
import { NotificationReadEntity } from '../modules/notifications/entities/notification-read.entity.js';
import { MiniAppEntity } from '../modules/miniapps/entities/mini-app.entity.js';
import { MiniAppVersionEntity } from '../modules/miniapps/entities/mini-app-version.entity.js';
import { MiniAppKvEntity } from '../modules/miniapps/entities/mini-app-kv.entity.js';
import { EconomyAccountEntity } from '../modules/economy/entities/economy-account.entity.js';
import { EconomyHoldEntity } from '../modules/economy/entities/economy-hold.entity.js';
import { EconomyLedgerEntryEntity } from '../modules/economy/entities/economy-ledger-entry.entity.js';
import { MiniAppCredentialEntity } from '../modules/economy/entities/mini-app-credential.entity.js';
import { EconomyOrderEntity } from '../modules/economy/entities/economy-order.entity.js';
import { EconomyOrderParticipantEntity } from '../modules/economy/entities/economy-order-participant.entity.js';
import {
  PunchMemberEligibilityEntity,
  PunchNetworkPolicyEntity,
  PunchTeamEntity,
  PunchUserEntity,
} from '../modules/punch/entities/punch-core.entities.js';
import {
  PunchAdjustmentBucketEntity,
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
  PunchPointLedgerEntity,
} from '../modules/punch/entities/punch-attendance.entities.js';
import {
  PunchCardActionArchiveEntity,
  PunchCardGameEntity,
  PunchCardWeekArchiveEntity,
} from '../modules/punch/entities/punch-cards.entities.js';
import {
  PunchAssessmentMembershipEntity,
  PunchAssessmentWeekEntity,
} from '../modules/punch/entities/punch-assessment.entities.js';
import {
  PunchGitHubSourceEntity,
  PunchNotificationEntity,
  PunchNotificationReceiptEntity,
  PunchReportEntity,
  PunchSkinUnlockEntity,
  PunchTeamEventEntity,
  PunchTeamLedgerEntryEntity,
  PunchWeeklyReportRefEntity,
} from '../modules/punch/entities/punch-collab.entities.js';
import { InitialSchema1764000000000 } from './migrations/1764000000000-InitialSchema.js';
import { AddPunchTables1764100000000 } from './migrations/1764100000000-AddPunchTables.js';

export const ALL_ENTITIES = [
  OrbitMemberEntity,
  AnnouncementEntity,
  AnnouncementReceiptEntity,
  NotificationEntity,
  NotificationReadEntity,
  MiniAppEntity,
  MiniAppVersionEntity,
  MiniAppKvEntity,
  EconomyAccountEntity,
  EconomyHoldEntity,
  EconomyLedgerEntryEntity,
  MiniAppCredentialEntity,
  EconomyOrderEntity,
  EconomyOrderParticipantEntity,
  // LecPunch 21 张融合业务表
  PunchTeamEntity,
  PunchUserEntity,
  PunchNetworkPolicyEntity,
  PunchMemberEligibilityEntity,
  PunchAttendanceSessionEntity,
  PunchDurationAdjustmentEntity,
  PunchAdjustmentBucketEntity,
  PunchPointLedgerEntity,
  PunchCardGameEntity,
  PunchCardActionArchiveEntity,
  PunchCardWeekArchiveEntity,
  PunchAssessmentWeekEntity,
  PunchAssessmentMembershipEntity,
  PunchNotificationEntity,
  PunchNotificationReceiptEntity,
  PunchReportEntity,
  PunchGitHubSourceEntity,
  PunchWeeklyReportRefEntity,
  PunchTeamEventEntity,
  PunchTeamLedgerEntryEntity,
  PunchSkinUnlockEntity,
];

export const ALL_MIGRATIONS = [InitialSchema1764000000000, AddPunchTables1764100000000];

export function buildTypeOrmOptions(cfg: AppConfig): DataSourceOptions {
  if (!cfg.databaseUrl) {
    throw new Error('必须配置 DATABASE_URL（PostgreSQL 连接串）');
  }
  return {
    type: 'postgres',
    url: cfg.databaseUrl,
    entities: ALL_ENTITIES,
    migrations: ALL_MIGRATIONS,
    migrationsRun: cfg.dbRunMigrations,
    synchronize: cfg.dbSynchronize,
    logging: cfg.nodeEnv === 'development' ? ['error', 'warn'] : ['error'],
    extra: {
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    },
  };
}

/** 供 TypeORM CLI 与独立迁移脚本使用的 DataSource 实例。 */
export function createStandaloneDataSource(cfg: AppConfig): DataSource {
  return new DataSource(buildTypeOrmOptions(cfg));
}
