import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../nakama-modules/orbit_wager_bridge.js') as {
  InitModule: (...args: unknown[]) => void;
  rpcCreateWagerMatch: (...args: unknown[]) => string;
  matchInit: (...args: unknown[]) => { state: Record<string, unknown>; tickRate: number; label: string };
  matchJoinAttempt: (...args: unknown[]) => { state: Record<string, unknown>; accept: boolean; rejectMessage?: string };
  matchJoin: (...args: unknown[]) => { state: Record<string, unknown> };
  matchLeave: (...args: unknown[]) => { state: Record<string, unknown> };
  matchLoop: (...args: unknown[]) => { state: Record<string, unknown> } | null;
  OP_REPORT_RESULT: number;
  OP_SURRENDER: number;
  OP_WAGER_EVENT: number;
  TICK_RATE: number;
};

interface MockHttpCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

function createHarness(orderOverrides: Record<string, unknown> = {}) {
  const httpCalls: MockHttpCall[] = [];
  const broadcasts: Array<{ opCode: number; data: unknown; recipients: unknown; sender: unknown }> = [];
  const createdMatches: Array<{ name: string; params: Record<string, unknown>; matchId: string }> = [];
  const activeMatches: Array<{ matchId: string; label: string }> = [];

  const order = {
    orderId: '11111111-1111-4111-8111-111111111111',
    appId: 'lec-xiangqi',
    orderType: 'escrow_wager',
    status: 'locked',
    creatorUserId: 'orbit-red',
    opponentUserId: 'orbit-black',
    asset: 'coin',
    amount: 20,
    ...orderOverrides,
  };

  const accounts: Record<string, { customId: string }> = {
    'nk-red': { customId: 'lec:orbit-red' },
    'nk-black': { customId: 'lec:orbit-black' },
    'nk-outsider': { customId: 'lec:orbit-outsider' },
  };

  const ctx = {
    userId: 'nk-red',
    env: {
      ORBIT_INTERNAL_URL: 'http://lec-orbit-server:8080',
      ORBIT_INTERNAL_TOKEN: 'test-internal-token',
    },
  };

  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const nk = {
    accountGetId: (uid: string) => accounts[uid] ?? null,
    binaryToString: (data: unknown) => (typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8')),
    matchList: (_limit: number, _auth: boolean, label: string) =>
      activeMatches.filter((m) => m.label === label),
    matchCreate: (name: string, params: Record<string, unknown>) => {
      const matchId = `match-${createdMatches.length + 1}.orbit`;
      createdMatches.push({ name, params, matchId });
      activeMatches.push({
        matchId,
        label: JSON.stringify({ type: 'orbit_wager', appId: params.appId, orderId: params.orderId }),
      });
      return matchId;
    },
    httpRequest: (url: string, method: string, _headers: Record<string, string>, bodyStr: string) => {
      const body = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : null;
      httpCalls.push({ method, url, body });
      if (method === 'get' && url.includes('/wagers/')) {
        return { code: 200, body: JSON.stringify(order) };
      }
      if (method === 'post' && url.endsWith('/settle')) {
        return { code: 200, body: JSON.stringify({ ...order, status: 'settled', summary: body?.summary }) };
      }
      if (method === 'post' && url.endsWith('/dispute')) {
        return { code: 200, body: JSON.stringify({ ...order, status: 'disputed', summary: body?.reason }) };
      }
      return { code: 404, body: JSON.stringify({ error: 'Not Found' }) };
    },
  };

  const dispatcher = {
    broadcastMessage: (opCode: number, data: unknown, recipients: unknown, sender: unknown) => {
      broadcasts.push({ opCode, data, recipients, sender });
    },
  };

  const redPresence = { userId: 'nk-red', sessionId: 'sess-red', username: 'red' };
  const blackPresence = { userId: 'nk-black', sessionId: 'sess-black', username: 'black' };
  const outsiderPresence = { userId: 'nk-outsider', sessionId: 'sess-out', username: 'out' };

  return { ctx, logger, nk, dispatcher, httpCalls, broadcasts, createdMatches, order, redPresence, blackPresence, outsiderPresence };
}

describe('Nakama 通用联机赌约房插件 (orbit_wager_bridge.js)', () => {
  test('RPC 建房强校验 locked 与参与方身份，并实现一单一房幂等复用', () => {
    const h = createHarness();
    const res1 = JSON.parse(
      bridge.rpcCreateWagerMatch(h.ctx, h.logger, h.nk, JSON.stringify({ orderId: h.order.orderId, disconnectGraceSeconds: 25 })),
    );
    expect(res1.created).toBe(true);
    expect(res1.matchId).toBe('match-1.orbit');
    expect(res1.disconnectGraceSeconds).toBe(25);

    // 对手再调同一 RPC，必须直接复用同一房间
    const res2 = JSON.parse(
      bridge.rpcCreateWagerMatch({ ...h.ctx, userId: 'nk-black' }, h.logger, h.nk, JSON.stringify({ orderId: h.order.orderId })),
    );
    expect(res2.created).toBe(false);
    expect(res2.matchId).toBe('match-1.orbit');
    expect(h.createdMatches).toHaveLength(1);

    // 非参与方禁止建房
    expect(() =>
      bridge.rpcCreateWagerMatch({ ...h.ctx, userId: 'nk-outsider' }, h.logger, h.nk, JSON.stringify({ orderId: h.order.orderId })),
    ).toThrow('无权创建或加入对赌房');

    // 未锁仓订单禁止建房
    const pendingHarness = createHarness({ status: 'pending_accept' });
    expect(() =>
      bridge.rpcCreateWagerMatch(
        pendingHarness.ctx,
        pendingHarness.logger,
        pendingHarness.nk,
        JSON.stringify({ orderId: pendingHarness.order.orderId }),
      ),
    ).toThrow('不可开启对赌房');
  });

  test('双端共识上报胜负触发内网原子结算，并透传业务 OpCode 1~8999', () => {
    const h = createHarness();
    let { state } = bridge.matchInit(h.ctx, h.logger, h.nk, {
      orderId: h.order.orderId,
      appId: h.order.appId,
      creatorOrbitId: 'orbit-red',
      opponentOrbitId: 'orbit-black',
      disconnectGraceSeconds: 15,
    });

    // 非参与方进房被拒
    const rejectRes = bridge.matchJoinAttempt(h.ctx, h.logger, h.nk, h.dispatcher, 1, state, h.outsiderPresence, {});
    expect(rejectRes.accept).toBe(false);

    // 双方进房
    state = bridge.matchJoin(h.ctx, h.logger, h.nk, h.dispatcher, 1, state, [h.redPresence, h.blackPresence]).state;
    expect(state.bothJoined).toBe(true);

    // 业务帧透传（OpCode 10）仅发给对手
    bridge.matchLoop(h.ctx, h.logger, h.nk, h.dispatcher, 2, state, [
      { opCode: 10, data: '{"move":"e2e4"}', sender: h.redPresence },
    ]);
    const gameRelay = h.broadcasts.find((b) => b.opCode === 10);
    expect(gameRelay).toBeDefined();
    expect(gameRelay?.recipients).toEqual([h.blackPresence]);

    // 双方均上报红方胜 -> 自动结算
    bridge.matchLoop(h.ctx, h.logger, h.nk, h.dispatcher, 3, state, [
      { opCode: bridge.OP_REPORT_RESULT, data: JSON.stringify({ result: 'win', winnerOrbitUserId: 'orbit-red' }), sender: h.redPresence },
      { opCode: bridge.OP_REPORT_RESULT, data: JSON.stringify({ result: 'win', winnerOrbitUserId: 'orbit-red' }), sender: h.blackPresence },
    ]);

    const settleCall = h.httpCalls.find((c) => c.url.endsWith('/settle'));
    expect(settleCall).toBeDefined();
    expect(settleCall?.body?.result).toBe('win');
    expect(settleCall?.body?.winnerUserId).toBe('orbit-red');
    expect(state.finalized).toBe(true);
  });

  test('双方上报结果冲突时自动调用 /dispute 挂起待队长仲裁', () => {
    const h = createHarness();
    let { state } = bridge.matchInit(h.ctx, h.logger, h.nk, {
      orderId: h.order.orderId,
      appId: h.order.appId,
      creatorOrbitId: 'orbit-red',
      opponentOrbitId: 'orbit-black',
    });
    state = bridge.matchJoin(h.ctx, h.logger, h.nk, h.dispatcher, 1, state, [h.redPresence, h.blackPresence]).state;

    bridge.matchLoop(h.ctx, h.logger, h.nk, h.dispatcher, 2, state, [
      { opCode: bridge.OP_REPORT_RESULT, data: JSON.stringify({ result: 'win', winnerOrbitUserId: 'orbit-red' }), sender: h.redPresence },
      { opCode: bridge.OP_REPORT_RESULT, data: JSON.stringify({ result: 'win', winnerOrbitUserId: 'orbit-black' }), sender: h.blackPresence },
    ]);

    const disputeCall = h.httpCalls.find((c) => c.url.endsWith('/dispute'));
    expect(disputeCall).toBeDefined();
    expect(String(disputeCall?.body?.reason)).toContain('冲突');
    expect(state.finalStatus).toBe('disputed');
  });

  test('主动认输 (9002) 与中途掉线超时 (graceSeconds) 均自动判在场方胜，重连则取消计时', () => {
    // 1. 主动认输
    const h1 = createHarness();
    let { state: s1 } = bridge.matchInit(h1.ctx, h1.logger, h1.nk, {
      orderId: h1.order.orderId,
      appId: h1.order.appId,
      creatorOrbitId: 'orbit-red',
      opponentOrbitId: 'orbit-black',
    });
    s1 = bridge.matchJoin(h1.ctx, h1.logger, h1.nk, h1.dispatcher, 1, s1, [h1.redPresence, h1.blackPresence]).state;
    bridge.matchLoop(h1.ctx, h1.logger, h1.nk, h1.dispatcher, 2, s1, [
      { opCode: bridge.OP_SURRENDER, data: '', sender: h1.redPresence },
    ]);
    expect(h1.httpCalls.find((c) => c.url.endsWith('/settle'))?.body?.winnerUserId).toBe('orbit-black');

    // 2. 掉线重连取消 + 再次掉线满宽限期自动判负
    const h2 = createHarness();
    let { state: s2 } = bridge.matchInit(h2.ctx, h2.logger, h2.nk, {
      orderId: h2.order.orderId,
      appId: h2.order.appId,
      creatorOrbitId: 'orbit-red',
      opponentOrbitId: 'orbit-black',
      disconnectGraceSeconds: 10,
    });
    s2 = bridge.matchJoin(h2.ctx, h2.logger, h2.nk, h2.dispatcher, 1, s2, [h2.redPresence, h2.blackPresence]).state;
    s2 = bridge.matchLeave(h2.ctx, h2.logger, h2.nk, h2.dispatcher, 10, s2, [h2.blackPresence]).state;

    // 宽限期内（5 秒）不判负
    bridge.matchLoop(h2.ctx, h2.logger, h2.nk, h2.dispatcher, 10 + 5 * bridge.TICK_RATE, s2, []);
    expect(h2.httpCalls).toHaveLength(0);

    // 8 秒时重连，清除掉线倒计时
    s2 = bridge.matchJoin(h2.ctx, h2.logger, h2.nk, h2.dispatcher, 10 + 8 * bridge.TICK_RATE, s2, [
      { userId: 'nk-black', sessionId: 'sess-black-2', username: 'black' },
    ]).state;
    bridge.matchLoop(h2.ctx, h2.logger, h2.nk, h2.dispatcher, 10 + 15 * bridge.TICK_RATE, s2, []);
    expect(h2.httpCalls).toHaveLength(0);

    // 再次掉线并超过 10 秒宽限期 -> 自动判红方胜
    const leaveTick = 500;
    s2 = bridge.matchLeave(h2.ctx, h2.logger, h2.nk, h2.dispatcher, leaveTick, s2, [
      { userId: 'nk-black', sessionId: 'sess-black-2', username: 'black' },
    ]).state;
    bridge.matchLoop(h2.ctx, h2.logger, h2.nk, h2.dispatcher, leaveTick + 10 * bridge.TICK_RATE, s2, []);
    const forfeitCall = h2.httpCalls.find((c) => c.url.endsWith('/settle'));
    expect(forfeitCall?.body?.winnerUserId).toBe('orbit-red');
    expect(String(forfeitCall?.body?.summary)).toContain('掉线');
  });
});
