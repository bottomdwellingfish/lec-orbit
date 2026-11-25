import { describe, expect, it } from 'bun:test';
import {
  InMemoryNonceStore,
  signS2SRequest,
  verifyS2SSignature,
} from '../src/common/utils/hmac.js';

describe('S2S 全要素 HMAC-SHA256 签名与 Nonce 防重放', () => {
  const secret = 'lec_app_test_secret_0123456789abcdef';
  const nowMs = 1795584000000;
  const baseInput = {
    method: 'POST',
    path: '/api/miniapps/economy/orders/11111111-1111-1111-1111-111111111111/settle',
    appId: 'lec-xiangqi',
    timestampMs: String(nowMs),
    nonce: 'nonce-1234567890',
    rawBody: Buffer.from(
      JSON.stringify({ matchId: 'room-8429', result: 'win', winnerUserId: 'u1' }),
      'utf8',
    ),
  };

  it('合法全要素签名应当通过校验', () => {
    const sig = signS2SRequest(secret, baseInput);
    expect(verifyS2SSignature(secret, baseInput, sig, nowMs)).toEqual({ ok: true });
  });

  it('篡改请求体、路径或 appId 均必须拒绝', () => {
    const sig = signS2SRequest(secret, baseInput);

    expect(
      verifyS2SSignature(
        secret,
        { ...baseInput, rawBody: Buffer.from('{"tampered":true}') },
        sig,
        nowMs,
      ).ok,
    ).toBe(false);

    expect(
      verifyS2SSignature(
        secret,
        {
          ...baseInput,
          path: '/api/miniapps/economy/orders/22222222-2222-2222-2222-222222222222/settle',
        },
        sig,
        nowMs,
      ).ok,
    ).toBe(false);

    expect(
      verifyS2SSignature(secret, { ...baseInput, appId: 'evil-game' }, sig, nowMs).ok,
    ).toBe(false);
  });

  it('超出 ±5 分钟时间窗或错误密钥必须拒绝', () => {
    const sig = signS2SRequest(secret, baseInput);
    expect(verifyS2SSignature('wrong-secret', baseInput, sig, nowMs).ok).toBe(false);
    expect(verifyS2SSignature(secret, baseInput, sig, nowMs + 6 * 60 * 1000).ok).toBe(false);
    expect(verifyS2SSignature(secret, baseInput, sig, nowMs - 6 * 60 * 1000).ok).toBe(false);
  });

  it('同一应用内重复 Nonce 必须拦截重放，过期后允许复用', () => {
    const store = new InMemoryNonceStore();
    expect(store.consume('lec-xiangqi', 'nonce-aaa111', nowMs)).toBe(true);
    expect(store.consume('lec-xiangqi', 'nonce-aaa111', nowMs + 1000)).toBe(false);
    expect(store.consume('other-app', 'nonce-aaa111', nowMs + 1000)).toBe(true);
    expect(store.consume('lec-xiangqi', 'nonce-aaa111', nowMs + 11 * 60 * 1000)).toBe(true);
  });
});
