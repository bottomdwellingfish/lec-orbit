export interface DutySchedule { anchor: string | null; groups: string[][] }

const day = 86_400_000;
export function dutyWeek(now: number, schedule?: DutySchedule | null) {
  const date = new Date(now + 8 * 3_600_000);
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const elapsed = schedule?.anchor ? Math.floor((monday - Date.parse(schedule.anchor)) / (7 * day)) : -1;
  const index = elapsed >= 0 && schedule?.groups.length ? elapsed % schedule.groups.length : -1;
  const label = (ms: number) => new Date(ms).toISOString().slice(5, 10).replace('-', '.');
  return { index, dates: `${label(monday)} – ${label(monday + 6 * day)}` };
}
