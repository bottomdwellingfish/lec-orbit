import { expect, test } from 'bun:test';
import { dutyWeek } from '../src/shared/duty';

test('跨年后仍在同一班次，直到北京时间周一零点换组，末组后回到首组', () => {
  const schedule = { anchor: '2026-12-28', groups: [['甲'], ['乙']] };
  expect(dutyWeek(Date.parse('2027-01-03T15:59:59Z'), schedule)).toEqual({ index: 0, dates: '12.28 – 01.03' });
  expect(dutyWeek(Date.parse('2027-01-03T16:00:00Z'), schedule).index).toBe(1);
  expect(dutyWeek(Date.parse('2027-01-10T16:00:00Z'), schedule).index).toBe(0);
});
