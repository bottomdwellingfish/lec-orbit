import { describe, expect, it } from 'bun:test';
import {
  computeBayesianScore,
  DAILY_MAX_RATINGS_GLOBAL,
  DAILY_MAX_RATINGS_PER_APP,
  MiniAppsEngagementService,
  shanghaiDateKey,
} from '../src/modules/miniapps/miniapps-engagement.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import type { AuthUser } from '../src/modules/auth/auth.types.js';

const mockInviter: AuthUser = {
  userId: 'u-host',
  username: 'host',
  displayName: '房主同学',
  avatar: 'https://example.com/host.png',
  organizations: ['lec-studio'],
  roles: ['member'],
  isStudio: true,
  isCaptain: false,
};

const mockGuest: AuthUser = {
  userId: 'u-guest',
  username: 'guest',
  displayName: '受邀队友',
  avatar: 'https://example.com/guest.png',
  organizations: ['lec-studio'],
  roles: ['member'],
  isStudio: true,
  isCaptain: false,
};

describe('工坊互动统计、贝叶斯加权评分与防刷工具函数', () => {
  it('贝叶斯加权分能防止仅 1 人打 5 星超过多人高分作品', () => {
    const oneFiveStar = computeBayesianScore(5.0, 1);
    const tenHighStars = computeBayesianScore(4.7, 10);
    expect(oneFiveStar).toBeGreaterThan(3.8);
    expect(tenHighStars).toBeGreaterThan(oneFiveStar);
    expect(computeBayesianScore(null, 0)).toBe(0);
  });

  it('东八区自然日 key 正确按 UTC+8 切日并配置合理防刷上限', () => {
    // 2026-11-26 16:30 UTC = 2026-11-27 00:30 Asia/Shanghai
    expect(shanghaiDateKey(new Date('2026-11-26T16:30:00Z'))).toBe('2026-11-27');
    expect(shanghaiDateKey(new Date('2026-11-26T15:30:00Z'))).toBe('2026-11-26');
    expect(DAILY_MAX_RATINGS_GLOBAL).toBe(5);
    expect(DAILY_MAX_RATINGS_PER_APP).toBe(2);
  });
});

describe('工坊组队邀请与一键进房后端闭环', () => {
  it('sendRoomInvites 拒绝邀请自己、超过 8 人，并正确推送 hub.room_invite 通知', async () => {
    const pushed: Array<Record<string, unknown>> = [];
    const service = new MiniAppsEngagementService(
      { redisUrl: '' } as never,
      {} as never,
      { findOne: async () => ({ id: 'lec-chess', name: '乐程象棋', iconUrl: 'https://cdn/chess.png' }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        find: async () => [
          { userId: 'u-guest', username: 'guest', displayName: '受邀队友', avatar: '' },
        ],
      } as never,
      { pushToUser: async () => undefined, broadcast: async () => undefined } as never,
      {
        createAndPush: async (input: Record<string, unknown>) => {
          pushed.push(input);
          return { id: 'invite-001', ...input };
        },
      } as never,
    );

    await expect(
      service.sendRoomInvites(mockInviter, 'lec-chess', {
        toUserIds: ['u-host'],
        roomId: 'room-888',
      }),
    ).rejects.toThrow('请至少选择一位其他工作室成员发起邀请');

    await expect(
      service.sendRoomInvites(mockInviter, 'lec-chess', {
        toUserIds: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'],
        roomId: 'room-888',
      }),
    ).rejects.toThrow('单次最多同时邀请 8 位队友');

    const res = await service.sendRoomInvites(mockInviter, 'lec-chess', {
      toUserIds: ['u-guest', 'u-host'],
      roomId: 'room-888',
      roomName: '快棋 1 号桌',
      mode: 'standalone',
      meta: { round: 1 },
    });

    expect(res.ok).toBe(true);
    expect(res.sent).toHaveLength(1);
    expect(res.sent[0]?.inviteId).toBe('invite-001');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.eventType).toBe('hub.room_invite');
    expect(pushed[0]?.actionStatus).toBe('pending');
    expect((pushed[0]?.payload as Record<string, unknown>)?.roomId).toBe('room-888');
  });

  it('handleNotificationAction 接受组队邀请后向房主回推实时进房事件，且拦截已过期邀请', async () => {
    const wsPushes: Array<{ userId: string; event: Record<string, unknown> }> = [];
    const savedNotifs: Array<Record<string, unknown>> = [];

    const makeService = (record: Record<string, unknown>) =>
      new NotificationsService(
        {
          findOne: async () => record,
          create: (v: Record<string, unknown>) => v,
          save: async (v: Record<string, unknown>) => {
            savedNotifs.push({ ...v });
            return v;
          },
        } as never,
        { query: async () => [] } as never,
        {} as never,
        {
          pushToUser: async (userId: string, event: Record<string, unknown>) => {
            wsPushes.push({ userId, event });
          },
          broadcast: async () => undefined,
        } as never,
        { githubToken: '' } as never,
      );

    // 1. 有效邀请：接受后应推 notification.updated、hub.room_invite_result 及 miniapp.realtime
    const activeRecord: Record<string, unknown> = {
      id: 'invite-ok',
      sourceApp: 'orbit',
      eventType: 'hub.room_invite',
      targetUserId: 'u-guest',
      actionStatus: 'pending',
      payload: {
        appId: 'lec-chess',
        appName: '乐程象棋',
        roomId: 'room-888',
        roomName: '快棋 1 号桌',
        inviterId: 'u-host',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    };
    const svc1 = makeService(activeRecord);
    const okRes = await svc1.handleNotificationAction(mockGuest, 'invite-ok', 'approve');
    expect(okRes.actionStatus).toBe('approved');
    const realtimeEvent = wsPushes.find(
      (p) => p.userId === 'u-host' && p.event.type === 'miniapp.realtime',
    );
    expect(realtimeEvent).toBeDefined();
    expect((realtimeEvent?.event.payload as Record<string, unknown>)?.event).toBe(
      'orbit.invite.responded',
    );

    // 2. 过期邀请：应标记 expired 并抛出明确中文错误
    const expiredRecord: Record<string, unknown> = {
      id: 'invite-exp',
      sourceApp: 'orbit',
      eventType: 'hub.room_invite',
      targetUserId: 'u-guest',
      actionStatus: 'pending',
      payload: {
        appId: 'lec-chess',
        appName: '乐程象棋',
        roomId: 'room-888',
        inviterId: 'u-host',
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      },
    };
    const svc2 = makeService(expiredRecord);
    await expect(
      svc2.handleNotificationAction(mockGuest, 'invite-exp', 'approve'),
    ).rejects.toThrow('该组队邀请已过期');
    expect(expiredRecord.actionStatus).toBe('expired');
  });
});
