import { describe, expect, it } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import {
  isAllowedGitHubReleaseUrl,
  normalizeAndValidateManifest,
  validateZipBundle,
} from '../src/modules/miniapps/miniapp-validator.util.js';

describe('工坊 Manifest 与 ZIP 构建包安全校验', () => {
  it('允许声明新的 economy.* 权限作用域并拒绝未知作用域', () => {
    const valid = normalizeAndValidateManifest({
      id: 'lec-xiangqi',
      name: '乐程象棋',
      version: '1.1.0',
      type: 'minigame',
      engine: 'web',
      permissions: {
        scopes: [
          'user.profile',
          'storage.cloud',
          'clipboard',
          'economy.read',
          'economy.wager.coin',
          'economy.wager.punch',
          'economy.tip',
        ],
        networkDomains: ['chess.lecspace.top'],
      },
    });
    expect(valid.id).toBe('lec-xiangqi');
    expect(valid.permissions.scopes).toContain('economy.wager.coin');

    expect(() =>
      normalizeAndValidateManifest({
        id: 'lec-xiangqi',
        name: '乐程象棋',
        version: '1.1.0',
        permissions: { scopes: ['economy.mint'], networkDomains: [] },
      }),
    ).toThrow('不支持的权限范围');
  });

  it('合法 ZIP 包（含单层外包目录）应当通过校验并提取 SHA256', async () => {
    const manifest = JSON.stringify({
      schemaVersion: 1,
      id: 'lec-xiangqi',
      name: '乐程象棋',
      version: '1.1.0',
      type: 'minigame',
      engine: 'web',
      entry: 'index.html',
      permissions: { scopes: ['user.profile', 'economy.read', 'economy.wager.coin'], networkDomains: [] },
    });
    const zipped = zipSync({
      'xiangqi-dist/orbit.manifest.json': strToU8(manifest),
      'xiangqi-dist/index.html': strToU8('<!doctype html><html><body>OK</body></html>'),
    });
    const res = await validateZipBundle(Buffer.from(zipped));
    expect(res.manifest.id).toBe('lec-xiangqi');
    expect(res.fileCount).toBe(2);
    expect(res.sha256).toHaveLength(64);
  });

  it('ZIP 路径穿越与缺少入口文件必须拒绝', async () => {
    const badZip = zipSync({
      '../src/evil.txt': strToU8('bad'),
    });
    await expect(validateZipBundle(Buffer.from(badZip))).rejects.toThrow('路径穿越');

    const missingEntryZip = zipSync({
      'orbit.manifest.json': strToU8(
        JSON.stringify({ id: 'demo-app', name: 'Demo', version: '1.0.0', entry: 'app.html' }),
      ),
    });
    await expect(validateZipBundle(Buffer.from(missingEntryZip))).rejects.toThrow('入口文件');
  });

  it('GitHub Releases URL 白名单校验', () => {
    expect(
      isAllowedGitHubReleaseUrl('https://github.com/lec-org/demo/releases/download/v1.0.0/app.zip'),
    ).toBe(true);
    expect(isAllowedGitHubReleaseUrl('https://evil.example.com/app.zip')).toBe(false);
    expect(isAllowedGitHubReleaseUrl('http://github.com/lec-org/demo/app.zip')).toBe(false);
  });
});
