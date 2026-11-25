import { describe, expect, it } from 'bun:test';
import {
  buildReleaseMeta,
  extractShaFromVersion,
} from '../src/modules/notifications/devtron-release.util.js';

describe('Devtron 发版元信息解析', () => {
  it('能够从镜像 tag 中提取短 SHA', () => {
    expect(extractShaFromVersion('192.168.57.10:30500/lec/lec-doc:89a4662f-1-56')).toBe('89a4662f');
    expect(extractShaFromVersion('v1.2.3')).toBe('');
  });

  it('能够聚合主作者与 Co-authored-by 协作者', async () => {
    const { meta, summary } = await buildReleaseMeta({
      appName: 'lecpunch-api',
      version: 'abc12345-1-2',
      commits: [
        {
          sha: 'abc1234567890',
          message:
            'feat: 接入乐币统一账本\n\nCo-authored-by: Alice <12345+alice-dev@users.noreply.github.com>',
          author: 'Bob',
          authorLogin: 'bob-dev',
        },
      ],
    });
    expect(meta.repo).toBe('lec-org/LecPunch');
    expect(meta.shortSha).toBe('abc12345');
    expect(summary).toContain('接入乐币统一账本');
    expect(meta.contributors?.map((c) => c.githubLogin)).toEqual(['bob-dev', 'alice-dev']);
  });
});
