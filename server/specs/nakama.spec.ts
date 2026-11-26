import { describe, expect, it } from 'bun:test';
import { loadAppConfig } from '../src/config/env.config.js';
import {
  decodeNakamaJwtClaims,
  NakamaService,
  sanitizeNakamaUsername,
} from '../src/modules/nakama/nakama.service.js';

describe('Nakama 游戏联机 BaaS 单点换票服务', () => {
  it('能正确规范化用户名并解析 Nakama JWT 元信息', () => {
    expect(sanitizeNakamaUsername('zengquanjun.namlss', 'user123')).toBe('zengquanjun.namlss');
    expect(sanitizeNakamaUsername('张 三!', 'u_abcdef123456')).toBe('lec_uabcdef123456');

    const payload = Buffer.from(
      JSON.stringify({ uid: 'nk-uuid-1', usn: 'alice', exp: 1_900_000_000 }),
      'utf8',
    ).toString('base64url');
    expect(decodeNakamaJwtClaims(`hdr.${payload}.sig`)).toEqual({
      uid: 'nk-uuid-1',
      usn: 'alice',
      exp: 1_900_000_000,
    });
  });

  it('未配置 NAKAMA_SERVER_KEY 时 getPublicConfig 返回 enabled=false 且换票报 503', async () => {
    const svc = new NakamaService(loadAppConfig({}));
    expect(svc.getPublicConfig().enabled).toBe(false);
    await expect(
      svc.exchangeSession({
        userId: 'sso-1',
        username: 'alice',
        displayName: 'Alice',
        avatar: '',
        organizations: ['lec-studio'],
        roles: [],
        isStudio: true,
        isCaptain: false,
      }),
    ).rejects.toThrow('尚未配置');
  });

  it('已配置时调用内网 Nakama custom auth 换票并同步资料', async () => {
    const cfg = loadAppConfig({
      NAKAMA_INTERNAL_URL: 'http://nakama.local:7350',
      NAKAMA_PUBLIC_HOST: 'orbit.lecspace.top',
      NAKAMA_PUBLIC_PORT: '443',
      NAKAMA_PUBLIC_USE_SSL: 'true',
      NAKAMA_SERVER_KEY: 'super-secret-key',
    });
    const svc = new NakamaService(cfg);
    expect(svc.getPublicConfig()).toEqual({
      enabled: true,
      host: 'orbit.lecspace.top',
      port: '443',
      useSSL: true,
    });

    const payload = Buffer.from(
      JSON.stringify({ uid: 'nk-user-001', usn: 'alice', exp: 2_000_000_000 }),
      'utf8',
    ).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const calls: Array<{ url: string; method?: string; auth?: string }> = [];

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method, auth: headers.Authorization });
      if (url.includes('/v2/account/authenticate/custom')) {
        return new Response(
          JSON.stringify({ token: fakeToken, refresh_token: 'refresh-1', created: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const session = await svc.exchangeSession(
      {
        userId: 'sso-alice',
        username: 'alice',
        displayName: '爱丽丝',
        avatar: 'https://drive.lecspace.top/a.png',
        organizations: ['lec-studio'],
        roles: [],
        isStudio: true,
        isCaptain: false,
      },
      'gobang-game',
      mockFetch,
    );

    expect(session.host).toBe('orbit.lecspace.top');
    expect(session.port).toBe('443');
    expect(session.useSSL).toBe(true);
    expect(session.token).toBe(fakeToken);
    expect(session.userId).toBe('nk-user-001');
    expect(session.orbitUserId).toBe('sso-alice');
    expect(session.created).toBe(true);
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('super-secret-key:').toString('base64')}`);
  });
});
