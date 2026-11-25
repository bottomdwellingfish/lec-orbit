/**
 * LecPunch MongoDB -> PostgreSQL 生产数据无损迁移与逐表校验命令行工具。
 *
 * 用法：
 *   MONGO_URL=mongodb://... DATABASE_URL=postgres://... bun run migrate:mongo:dry-run
 *   MONGO_URL=mongodb://... DATABASE_URL=postgres://... bun run migrate:mongo
 *   MONGO_URL=mongodb://... DATABASE_URL=postgres://... bun run migrate:mongo:verify
 *
 * 特性：
 * - 100% 幂等（ON CONFLICT (id) DO UPDATE），支持随时断点重跑；
 * - 逐表核对源/目标记录总数与 ID 集合 SHA256 指纹 + 关键业务汇总（总有效打卡秒数、总积分、总财务分值）；
 * - 自动将存量历史 totalPoints 按 1:1 结转为期初 coin 乐币（带唯一幂等键，重复执行绝不双发）。
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import type { DataSource } from 'typeorm';
import { loadAppConfig } from '../../config/env.config.js';
import { createStandaloneDataSource } from '../data-source.js';
import {
  computeIdSetSha256,
  computeInitialCoinGrants,
  normalizeMongoId,
  PUNCH_TABLE_SPECS,
  type MongoDoc,
  type TableMigrationSpec,
} from './mongo-pg-mappers.js';

interface TableVerifyReport {
  mongoCollection: string;
  pgTable: string;
  mongoCount: number;
  pgCount: number;
  mongoIdsSha256: string;
  pgIdsSha256: string;
  matched: boolean;
}

interface BusinessMetricCheck {
  metric: string;
  mongoValue: number;
  pgValue: number;
  matched: boolean;
}

async function upsertBatch(
  ds: DataSource,
  spec: TableMigrationSpec,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const jsonbSet = new Set(spec.jsonbColumns ?? []);
  const cols = spec.columns;
  const updateAssignments = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  await ds.transaction(async (manager) => {
    for (const row of rows) {
      const placeholders: string[] = [];
      const values: unknown[] = [];
      cols.forEach((col, idx) => {
        const val = row[col];
        if (jsonbSet.has(col)) {
          placeholders.push(`$${idx + 1}::jsonb`);
          values.push(val === null || val === undefined ? null : JSON.stringify(val));
        } else {
          placeholders.push(`$${idx + 1}`);
          values.push(val === undefined ? null : val);
        }
      });

      await manager.query(
        `INSERT INTO ${spec.pgTable} (${cols.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT (id) DO UPDATE SET ${updateAssignments}`,
        values,
      );
    }
  });
}

async function migrateAllTables(mongoDb: Db, ds: DataSource, dryRun: boolean): Promise<void> {
  for (const spec of PUNCH_TABLE_SPECS) {
    const docs = (await mongoDb.collection(spec.mongoCollection).find({}).toArray()) as MongoDoc[];
    if (dryRun) {
      console.log(`[dry-run] ${spec.mongoCollection} -> ${spec.pgTable}: ${docs.length} 条待迁移`);
      continue;
    }

    const mapped = docs.map((d) => spec.mapDoc(d));
    const batchSize = 200;
    for (let i = 0; i < mapped.length; i += batchSize) {
      await upsertBatch(ds, spec, mapped.slice(i, i + batchSize));
    }
    console.log(`[migrate] ${spec.mongoCollection} -> ${spec.pgTable}: 已幂等写入 ${mapped.length} 条`);
  }
}

async function initCoinsFromMigratedData(ds: DataSource, dryRun: boolean): Promise<void> {
  const users = (await ds.query(
    `SELECT id, logto_user_id AS "logtoUserId", username FROM punch_users`,
  )) as Array<{ id: string; logtoUserId: string | null; username: string }>;
  const pointRows = (await ds.query(
    `SELECT user_id AS "userId", points FROM punch_point_ledger_entries`,
  )) as Array<{ userId: string; points: number }>;
  const adjustmentRows = (await ds.query(
    `SELECT user_id AS "userId", signed_duration_seconds AS "signedDurationSeconds"
     FROM punch_attendance_duration_adjustments`,
  )) as Array<{ userId: string; signedDurationSeconds: number }>;

  const now = new Date();
  const { weekKey, grants } = computeInitialCoinGrants({
    users,
    pointRows,
    adjustmentRows,
    currentWeekSessions: [],
    now,
  });

  // 补查当前周已完成会话，同步每位成员本周真实打卡分钟数
  const weekSessions = (await ds.query(
    `SELECT user_id AS "userId", status, duration_seconds AS "durationSeconds"
     FROM punch_attendance_sessions WHERE week_key = $1 AND status = 'completed'`,
    [weekKey],
  )) as Array<{ userId: string; status: string; durationSeconds: number | null }>;

  const finalCalc = computeInitialCoinGrants({
    users,
    pointRows,
    adjustmentRows,
    currentWeekSessions: weekSessions,
    now,
  });

  const totalCoins = finalCalc.grants.reduce((s, g) => s + g.initialCoins, 0);
  if (dryRun) {
    console.log(
      `[dry-run] 期初乐币结转预览：${finalCalc.grants.length} 名成员，总计 ${totalCoins} coin`,
    );
    return;
  }

  let mintedUsers = 0;
  let skippedUsers = 0;

  await ds.transaction(async (manager) => {
    for (const g of finalCalc.grants) {
      await manager.query(
        `INSERT INTO economy_accounts (user_id, coin_balance, frozen_coins, lifetime_earned_coins, weekly_recorded_minutes, weekly_recorded_week_key, updated_at)
         VALUES ($1, 0, 0, 0, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           weekly_recorded_minutes = EXCLUDED.weekly_recorded_minutes,
           weekly_recorded_week_key = EXCLUDED.weekly_recorded_week_key,
           updated_at = EXCLUDED.updated_at`,
        [g.economyUserId, g.currentWeekRecordedMinutes, weekKey, now],
      );

      if (g.initialCoins <= 0) {
        skippedUsers += 1;
        continue;
      }

      const [existing] = (await manager.query(
        `SELECT entry_id FROM economy_ledger_entries WHERE idempotency_key = $1`,
        [g.idempotencyKey],
      )) as Array<{ entry_id: string }>;

      if (existing) {
        skippedUsers += 1;
        continue;
      }

      await manager.query(
        `UPDATE economy_accounts
         SET coin_balance = coin_balance + $2,
             lifetime_earned_coins = lifetime_earned_coins + $2,
             updated_at = $3
         WHERE user_id = $1`,
        [g.economyUserId, g.initialCoins, now],
      );

      await manager.query(
        `INSERT INTO economy_ledger_entries
          (entry_id, tx_group_id, order_id, app_id, user_id, counterparty_user_id, asset, delta, counts_toward_lifetime, week_key, reason, title, idempotency_key, created_at)
         VALUES ($1, $2, NULL, 'lec-punch-migration', $3, NULL, 'coin', $4, TRUE, $5, 'migration_init', $6, $7, $8)`,
        [
          randomUUID(),
          randomUUID(),
          g.economyUserId,
          g.initialCoins,
          weekKey,
          `历史考勤积分 1:1 结转期初乐币（${g.username}）`,
          g.idempotencyKey,
          now,
        ],
      );
      mintedUsers += 1;
    }
  });

  console.log(
    `[coin-init] 期初乐币结转完成：新结转 ${mintedUsers} 人，跳过(已结转或 0 分) ${skippedUsers} 人，总计 ${totalCoins} coin`,
  );
}

async function verifyMigration(mongoDb: Db, ds: DataSource): Promise<boolean> {
  const tableReports: TableVerifyReport[] = [];

  for (const spec of PUNCH_TABLE_SPECS) {
    const mongoDocs = await mongoDb
      .collection(spec.mongoCollection)
      .find({}, { projection: { _id: 1 } })
      .toArray();
    const mongoIds = mongoDocs.map((d) => normalizeMongoId(d._id));

    const pgRows = (await ds.query(`SELECT id FROM ${spec.pgTable}`)) as Array<{ id: string }>;
    const pgIds = pgRows.map((r) => r.id);

    const mongoSha = computeIdSetSha256(mongoIds);
    const pgSha = computeIdSetSha256(pgIds);
    tableReports.push({
      mongoCollection: spec.mongoCollection,
      pgTable: spec.pgTable,
      mongoCount: mongoIds.length,
      pgCount: pgIds.length,
      mongoIdsSha256: mongoSha,
      pgIdsSha256: pgSha,
      matched: mongoIds.length === pgIds.length && mongoSha === pgSha,
    });
  }

  // 关键业务总和交叉核对
  const mongoAttAgg = await mongoDb
    .collection('attendance_sessions')
    .aggregate<{ total: number }>([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$durationSeconds', 0] } } } },
    ])
    .toArray();
  const [pgAttRow] = (await ds.query(
    `SELECT COALESCE(SUM(duration_seconds), 0)::bigint AS total
     FROM punch_attendance_sessions WHERE status = 'completed'`,
  )) as [{ total: string }];

  const mongoPtsAgg = await mongoDb
    .collection('point_ledger_entries')
    .aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: '$points' } } }])
    .toArray();
  const [pgPtsRow] = (await ds.query(
    `SELECT COALESCE(SUM(points), 0)::double precision AS total FROM punch_point_ledger_entries`,
  )) as [{ total: number }];

  const mongoLedgerAgg = await mongoDb
    .collection('team_ledger_entries')
    .aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: '$amountCents' } } }])
    .toArray();
  const [pgLedgerRow] = (await ds.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM punch_team_ledger_entries`,
  )) as [{ total: string }];

  const metrics: BusinessMetricCheck[] = [
    {
      metric: 'completed_attendance_duration_seconds',
      mongoValue: Math.trunc(mongoAttAgg[0]?.total ?? 0),
      pgValue: Number(pgAttRow?.total ?? 0),
      matched: Math.trunc(mongoAttAgg[0]?.total ?? 0) === Number(pgAttRow?.total ?? 0),
    },
    {
      metric: 'point_ledger_total_points',
      mongoValue: Math.round((mongoPtsAgg[0]?.total ?? 0) * 100) / 100,
      pgValue: Math.round(Number(pgPtsRow?.total ?? 0) * 100) / 100,
      matched:
        Math.abs((mongoPtsAgg[0]?.total ?? 0) - Number(pgPtsRow?.total ?? 0)) < 0.001,
    },
    {
      metric: 'team_ledger_amount_cents',
      mongoValue: Math.trunc(mongoLedgerAgg[0]?.total ?? 0),
      pgValue: Number(pgLedgerRow?.total ?? 0),
      matched: Math.trunc(mongoLedgerAgg[0]?.total ?? 0) === Number(pgLedgerRow?.total ?? 0),
    },
  ];

  const allTablesOk = tableReports.every((r) => r.matched);
  const allMetricsOk = metrics.every((m) => m.matched);
  const ok = allTablesOk && allMetricsOk;

  console.log(
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        ok,
        tablesChecked: tableReports.length,
        tablesMatched: tableReports.filter((r) => r.matched).length,
        mismatchedTables: tableReports.filter((r) => !r.matched),
        businessMetrics: metrics,
      },
      null,
      2,
    ),
  );
  return ok;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const verifyOnly = args.has('--verify-only');
  const skipCoinInit = args.has('--skip-coin-init');

  const mongoUrl = (process.env.MONGO_URL || process.env.MONGODB_URI || '').trim();
  if (!mongoUrl) {
    throw new Error('缺少源 MongoDB 连接串，请设置 MONGO_URL 或 MONGODB_URI');
  }

  const cfg = loadAppConfig();
  const ds = createStandaloneDataSource(cfg);
  const mongoClient = new MongoClient(mongoUrl);

  await mongoClient.connect();
  await ds.initialize();

  try {
    const mongoDbName = process.env.MONGO_DB?.trim();
    const mongoDb = mongoDbName ? mongoClient.db(mongoDbName) : mongoClient.db();

    if (!dryRun && !verifyOnly) {
      const executed = await ds.runMigrations();
      console.log(`[migration] PostgreSQL Schema 迁移已就绪（本次执行 ${executed.length} 个）`);
    }

    if (!verifyOnly) {
      await migrateAllTables(mongoDb, ds, dryRun);
      if (!skipCoinInit) {
        await initCoinsFromMigratedData(ds, dryRun);
      }
    }

    if (!dryRun) {
      const ok = await verifyMigration(mongoDb, ds);
      if (!ok) {
        console.error('[verify] 存在表指纹或业务指标不一致，请排查！');
        process.exitCode = 1;
      } else {
        console.log('[verify] 全部 20 张表 ID 指纹与核心业务指标 100% 校验一致！');
      }
    }
  } finally {
    await ds.destroy();
    await mongoClient.close();
  }
}

main().catch((err) => {
  console.error('[migrate-mongo-to-pg] 迁移失败:', err);
  process.exit(1);
});
