// Timezone-aware helpers. Always uses the IANA name, never a fixed UTC offset,
// so the 25 October 2026 clock change moves the windows correctly.
const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmts.get(tz);
}

function parts(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = Number(p.value);
  if (o.hour === 24) o.hour = 0;
  return o;
}

export function tzOffsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMs(guess, tz);
  let res = guess - off;
  const off2 = tzOffsetMs(res, tz);
  if (off2 !== off) res = guess - off2;
  return res;
}

export function dateKey(ms, tz) {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function monthKey(ms, tz) {
  return dateKey(ms, tz).slice(0, 7);
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function windowsOn(key, cfg) {
  const [y, m, d] = key.split('-').map(Number);
  return cfg.windows.map((hhmm, index) => {
    const [h, mi] = hhmm.split(':').map(Number);
    const startMs = zonedToUtc(y, m, d, h, mi, cfg.timezone);
    return { index, startMs, endMs: startMs + cfg.windowMinutes * 60000, day: key };
  });
}

/** The window that contains `ms`, or null outside the windows. */
export function windowAt(ms, cfg) {
  const key = dateKey(ms, cfg.timezone);
  return windowsOn(key, cfg).find((w) => ms >= w.startMs && ms < w.endMs) || null;
}

/** First window with this index that starts at or after `ms`. */
export function nextWindow(ms, index, cfg) {
  let key = dateKey(ms, cfg.timezone);
  for (let i = 0; i < 400; i++, key = addDays(key, 1)) {
    const w = windowsOn(key, cfg)[index];
    if (w.startMs >= ms) return w;
  }
  throw new Error('no window found');
}

export const discordTs = (ms, style = 'F') => `<t:${Math.floor(ms / 1000)}:${style}>`;
export const DAY = 86400000;
export const HOUR = 3600000;
