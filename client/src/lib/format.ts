const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (d: Date) => Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);

export const clock = (iso: string) => time.format(new Date(iso));

/** Compact stamp for list rows: 4:05 PM, Yesterday, Tue, 12 Oct. */
export function listStamp(iso: string) {
  const d = new Date(iso);
  const ago = daysAgo(d);
  if (ago === 0) return time.format(d);
  if (ago === 1) return 'Yesterday';
  if (ago < 7) return weekday.format(d);
  return dayMonth.format(d);
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const ago = daysAgo(d);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return full.format(d);
}

export const sameDay = (a: string, b: string) => startOfDay(new Date(a)) === startOfDay(new Date(b));

export function lastSeen(iso: string | null) {
  if (!iso) return 'Offline';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'Last seen just now';
  if (mins < 60) return `Last seen ${mins} min ago`;
  const d = new Date(iso);
  const ago = daysAgo(d);
  if (ago === 0) return `Last seen today at ${time.format(d)}`;
  if (ago === 1) return `Last seen yesterday at ${time.format(d)}`;
  return `Last seen ${dayMonth.format(d)}`;
}

export function duration(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => [...p][0]?.toUpperCase() ?? '')
    .join('') || '?';
