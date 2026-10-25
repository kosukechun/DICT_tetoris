import { timingSafeEqual } from 'node:crypto';

export function passwordMatches(actual, expected) {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PlayAccess {
  constructor(store) {
    this.store = store;
    this.schedule = { enabled: false, start: '22:00', end: '06:00', paused: false };
    this.pending = Promise.resolve();
  }
  async load() {
    const record = await this.store.get('SETTINGS', 'PLAY_SCHEDULE');
    if (record) this.schedule = { ...this.schedule, ...this.validate(record) };
  }
  validate(value) {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (
      typeof value?.enabled !== 'boolean' ||
      !time.test(value.start) ||
      !time.test(value.end) ||
      value.start === value.end ||
      (value.paused !== undefined && typeof value.paused !== 'boolean')
    )
      throw new Error('開始・終了を異なる時刻（00:00〜23:59）で指定してください。');
    return {
      enabled: value.enabled,
      start: value.start,
      end: value.end,
      ...(value.paused === undefined ? {} : { paused: value.paused })
    };
  }
  update(value) {
    return this.write(this.validate(value));
  }
  setPaused(paused) {
    if (typeof paused !== 'boolean') throw new Error('停止・再開を選んでください。');
    return this.write({ paused });
  }
  write(patch) {
    const write = this.pending.then(async () => {
      const schedule = { ...this.schedule, ...patch };
      await this.store.put({ pk: 'SETTINGS', sk: 'PLAY_SCHEDULE', ...schedule });
      this.schedule = schedule;
    });
    this.pending = write.catch(() => {});
    return write;
  }
  status(now = Date.now()) {
    const { enabled, start, end, paused } = this.schedule;
    const date = new Date(now + 9 * 60 * 60 * 1000);
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const from = toMinutes(start),
      to = toMinutes(end);
    const blocked =
      paused ||
      (enabled && (from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to));
    return { ...this.schedule, timezone: 'Asia/Tokyo', blocked };
  }
}
