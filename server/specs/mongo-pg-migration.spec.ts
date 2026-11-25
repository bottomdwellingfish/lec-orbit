import { describe, expect, it } from 'bun:test';
import {
  computeIdSetSha256,
  computeInitialCoinGrants,
  normalizeMongoId,
  PUNCH_TABLE_SPECS,
} from '../src/database/migration-tool/mongo-pg-mappers.js';

describe('MongoDB -> PostgreSQL 21 表映射、校验指纹与期初乐币结转', () => {
  it('完整覆盖全部 21 张 LecPunch 集合且无重复表名', () => {
    expect(PUNCH_TABLE_SPECS).toHaveLength(21);
    expect(new Set(PUNCH_TABLE_SPECS.map((s) => s.mongoCollection)).size).toBe(21);
    expect(new Set(PUNCH_TABLE_SPECS.map((s) => s.pgTable)).size).toBe(21);
  });

  it('ObjectId 与文档字段可无损转换为 PG 行，确定性 ID 指纹与顺序无关', () => {
    const fakeObjectId = { toHexString: () => '6a0000000000000000000011' };
    expect(normalizeMongoId(fakeObjectId)).toBe('6a0000000000000000000011');

    const userSpec = PUNCH_TABLE_SPECS.find((s) => s.mongoCollection === 'users')!;
    const mapped = userSpec.mapDoc({
      _id: fakeObjectId,
      logtoUserId: 'sso-sub-1',
      username: 'alice',
      displayName: '爱丽丝',
      teamId: { toHexString: () => '6a0000000000000000000001' },
      role: 'admin',
      status: 'active',
      enrollYear: 2024,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });

    expect(mapped.id).toBe('6a0000000000000000000011');
    expect(mapped.logto_user_id).toBe('sso-sub-1');
    expect(mapped.team_id).toBe('6a0000000000000000000001');
    expect(mapped.enroll_year).toBe(2024);

    // 指纹对顺序不敏感，任意缺少一条即立刻变化
    const sha1 = computeIdSetSha256(['b', 'a', 'c']);
    const sha2 = computeIdSetSha256(['c', 'a', 'b']);
    const sha3 = computeIdSetSha256(['a', 'b']);
    expect(sha1).toBe(sha2);
    expect(sha1).not.toBe(sha3);
  });

  it('期初乐币结转精确汇总打卡分、狂热小数分、手动调时并钳零，优先使用 logtoUserId', () => {
    const { weekKey, grants } = computeInitialCoinGrants({
      users: [
        { id: 'u1', logtoUserId: 'sso-u1', username: 'alice' },
        { id: 'u2', logtoUserId: null, username: 'bob' },
        { id: 'u3', logtoUserId: 'sso-u3', username: 'charlie' },
      ],
      pointRows: [
        { userId: 'u1', points: 100 },
        { userId: 'u1', points: 12.1 }, // 狂热 +10% 浮点分
        { userId: 'u2', points: 20 },
        { userId: 'u3', points: 10 },
      ],
      adjustmentRows: [
        { userId: 'u1', signedDurationSeconds: 1800 }, // +30 min
        { userId: 'u3', signedDurationSeconds: -3600 }, // -60 min -> 钳零为 0
      ],
      currentWeekSessions: [
        { userId: 'u1', status: 'completed', durationSeconds: 5400 }, // 90 min
        { userId: 'u1', status: 'invalidated', durationSeconds: 18000 }, // 无效不计入
      ],
      now: new Date('2026-11-25T12:00:00Z'),
    });

    expect(weekKey).toBe('2026-11-23');
    const byId = new Map(grants.map((g) => [g.punchUserId, g]));

    expect(byId.get('u1')).toMatchObject({
      economyUserId: 'sso-u1',
      initialCoins: 142, // round(112.1 + 30) = 142
      currentWeekRecordedMinutes: 90,
      idempotencyKey: 'migration:init-coin:u1',
    });
    expect(byId.get('u2')).toMatchObject({
      economyUserId: 'u2', // 未绑定 logtoUserId 时兜底回退 punchUserId
      initialCoins: 20,
      currentWeekRecordedMinutes: 0,
    });
    expect(byId.get('u3')).toMatchObject({
      economyUserId: 'sso-u3',
      initialCoins: 0, // 负调时后安全钳零
    });
  });
});
