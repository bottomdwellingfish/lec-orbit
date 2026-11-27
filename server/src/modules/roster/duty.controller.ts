import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SsoAuthGuard } from '../../common/guards/sso-auth.guard.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.config.js';
import type { AuthUser } from '../auth/auth.types.js';

const schedule = z.object({ groups: z.array(z.array(z.string().trim().min(1).max(80)).min(1).max(100)).max(100) });

@Controller('api/v1/duty-schedule')
@UseGuards(SsoAuthGuard)
export class DutyController {
  constructor(@InjectDataSource() private db: DataSource, @Inject(APP_CONFIG) private cfg: AppConfig) {}

  @Get()
  async get(@CurrentUser() user: AuthUser) {
    if (!user.isStudio) throw new ForbiddenException();
    const [row] = await this.db.query('SELECT anchor::text AS anchor, groups_json AS groups FROM orbit_duty_schedule WHERE id = 1');
    return row ?? { anchor: null, groups: [] };
  }

  @Put()
  async save(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const captain = ['captain', 'lec-captain'].some(role => user.roles.includes(role) || user.roles.includes(`${this.cfg.ssoOrgId}:${role}`));
    if (!user.isStudio || !captain) throw new ForbiddenException('仅工作室队长可管理值日生');
    const input = schedule.safeParse(body);
    if (!input.success) throw new BadRequestException('排班格式不正确');
    if (!input.data.groups.length) {
      await this.db.query('DELETE FROM orbit_duty_schedule WHERE id = 1');
    } else {
      await this.db.query(`INSERT INTO orbit_duty_schedule (id, anchor, groups_json)
        VALUES (1, date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai')::date, $1::jsonb)
        ON CONFLICT (id) DO UPDATE SET groups_json = EXCLUDED.groups_json`, [JSON.stringify(input.data.groups)]);
    }
    return { ok: true };
  }
}
