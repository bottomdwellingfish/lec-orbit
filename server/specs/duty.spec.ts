import { expect, mock, test } from 'bun:test';
import type { DataSource } from 'typeorm';
import { DutyController } from '../src/modules/roster/duty.controller.js';
import type { AuthUser } from '../src/modules/auth/auth.types.js';
import type { AppConfig } from '../src/config/env.config.js';

test('管理员、往届队长、其他组织队长均不能写入排班，只有本组织队长可以', async () => {
  const query = mock(async () => []);
  const api = new DutyController({ query } as unknown as DataSource, { ssoOrgId: 'studio' } as AppConfig);
  const save = (role: string) => api.save({ roles: [role], isStudio: true } as AuthUser, { groups: [['甲']] });
  for (const role of ['member', 'studio:admin', 'studio:senior-captain', 'other:captain']) {
    await expect(save(role)).rejects.toThrow('仅工作室队长');
  }
  expect(query).not.toHaveBeenCalled();
  await save('studio:captain');
  expect(query).toHaveBeenCalledTimes(1);
});
