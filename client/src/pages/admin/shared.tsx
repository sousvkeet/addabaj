import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import type { Announcement, User } from '../../lib/types';
import { IconButton } from '../../components/ui/Button';
import { goBack } from '../../lib/screens';
import { StatusLine } from '../../components/ConnectionNotice';

export type Overview = {
  users: { total: number; newThisWeek: number; disabled: number; admins: number; online: number };
  rooms: { total: number; activeToday: number; watching: number };
  messages: { total: number; today: number };
  files: { count: number; bytes: number };
  now: { calls: number; inVoice: number; liveStreams: number };
  days: { day: string; signups: number; messages: number }[];
  server: { uptime: number; memory: number; node: string };
  signupsOpen: boolean;
  /** What "Find videos" can use on this server. */
  videoTools?: {
    ytdlp: { version: string | null; fix: string };
    ffmpeg: { installed: boolean; fix: string };
    browser: { enabled: boolean; checked: boolean; ok: boolean; problem: string | null; fix: string };
    adBlock: { enabled: boolean; ready: boolean; rules: number; updatedAt: string | null; error: string | null };
  };
};

export type AdminUser = User & {
  email: string;
  createdAt: string;
  siteAdmin: boolean;
  disabled: boolean;
  defaultPassword: boolean;
  rooms: number;
  messages: number;
};

export type AdminRoom = {
  id: string;
  name: string;
  photo?: string | null;
  description: string;
  maxMembers: number;
  memberCount: number;
  messages: number;
  createdAt: string;
  lastActivityAt: string | null;
  owner: { id: string; name: string; hue: number; photo?: string | null };
  watching: string | null;
  live: boolean;
  inVoice: number;
};

export type SiteSettings = { allowSignups: boolean; announcement: Announcement | null };

export type Page<T> = { items: T[]; total: number };

const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const shortDate = (iso: string) => date.format(new Date(iso));

export function uptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** A page of the admin area: header (with a back button on phones) and a scrolling body. */
export function AdminPage({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="glass relative z-10 flex h-[72px] shrink-0 items-center gap-3 border-b border-line/70 px-2 pt-[var(--safe-top)] md:px-6">
        <IconButton label="Back to admin" className="md:hidden" onClick={() => goBack(navigate, '/admin')}>
          <ArrowLeft size={20} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[19px] leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
          <p className="truncate text-[13px] text-ink-soft empty:hidden">
            <StatusLine>{subtitle}</StatusLine>
          </p>
        </div>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 pb-[calc(24px+var(--safe-bottom))] md:px-7">
        <div className="mx-auto max-w-[1080px] space-y-5">{children}</div>
      </div>
    </div>
  );
}

/** A rounded panel on an admin page. */
export function Panel({ title, hint, action, children, className = '' }: { title?: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[26px] border border-line/70 bg-surface/60 p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="font-display text-[16px] font-semibold">{title}</h2>}
            {hint && <p className="mt-0.5 text-[13.5px] text-ink-soft">{hint}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A small label on a person or room ("Host admin", "Switched off", "Live"). */
export function Chip({ tone, children }: { tone: 'brand' | 'danger' | 'live' | 'muted' | 'warn'; children: ReactNode }) {
  const tones = {
    brand: 'bg-aurora text-white',
    danger: 'bg-danger/15 text-danger',
    live: 'bg-live/15 text-live-ink',
    muted: 'bg-subtle text-ink-soft',
    warn: 'bg-amber-400/15 text-amber-700 dark:text-amber-300',
  };
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-bold ${tones[tone]}`}>{children}</span>;
}
