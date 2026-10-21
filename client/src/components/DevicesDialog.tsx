import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, LogOut, Monitor, Smartphone } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { lastSeen, shortDay } from '../lib/format';
import { toast } from '../store/ui';
import { Button } from './ui/Button';
import { ConfirmDialog, Dialog } from './ui/Dialog';

export type Session = {
  id: string;
  /** The Adda Khana app, or a browser. */
  kind: 'app' | 'web';
  phone: boolean;
  /** "Pixel 8", "Chrome on Windows". */
  name: string;
  /** "Adda Khana 1.6.0 · Android 16", "Browser". */
  detail: string;
  ip: string | null;
  signedInAt: string;
  lastActiveAt: string;
  current: boolean;
  online: boolean;
};

/** "3 devices: 1 app, 2 browsers". */
export function devicesSummary(list: Session[]) {
  const apps = list.filter((s) => s.kind === 'app').length;
  const browsers = list.length - apps;
  const parts = [apps && `${apps} ${apps === 1 ? 'app' : 'apps'}`, browsers && `${browsers} ${browsers === 1 ? 'browser' : 'browsers'}`].filter(Boolean);
  return `${list.length} ${list.length === 1 ? 'device' : 'devices'}: ${parts.join(', ')}`;
}

/** Where I'm logged in; reloads when a device logs in or out elsewhere. */
export function useSessions(enabled = true) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ sessions: Session[] }>('/auth/sessions')
      .then((r) => {
        setSessions(r.sessions);
        setError('');
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    load();
    window.addEventListener('adda:sessions', load);
    return () => window.removeEventListener('adda:sessions', load);
  }, [enabled, load]);
  return { sessions, error, load, setSessions };
}

function DeviceIcon({ s }: { s: Session }) {
  const Icon = s.phone || s.kind === 'app' ? Smartphone : Monitor;
  return (
    <span className={`flex size-11 shrink-0 items-center justify-center rounded-full ${s.kind === 'app' ? 'bg-aurora text-white' : 'bg-subtle text-ink-soft'}`}>
      <Icon size={20} />
    </span>
  );
}

/**
 * Settings › Devices: everywhere this account is logged in (the app on which
 * phones, and which browsers), when each was last used, and logging any of
 * them out (or all the others at once), as in other messengers.
 */
export function DevicesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { sessions, error, setSessions } = useSessions(open);
  const [ending, setEnding] = useState<Session | 'others' | null>(null);
  const [busy, setBusy] = useState(false);
  const others = sessions?.filter((s) => !s.current) ?? [];

  async function confirm() {
    if (!ending) return;
    setBusy(true);
    try {
      if (ending === 'others') {
        const { sessions: left } = await api<{ sessions: Session[] }>('/auth/sessions/others', { method: 'DELETE' });
        setSessions(left);
        toast(others.length === 1 ? 'The other device was logged out.' : `${others.length} other devices were logged out.`);
      } else {
        const { sessions: left } = await api<{ sessions: Session[] }>(`/auth/sessions/${ending.id}`, { method: 'DELETE' });
        setSessions(left);
        toast(`${ending.name} was logged out.`);
      }
      setEnding(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const row = (s: Session) => (
    <li key={s.id} className="flex items-center gap-3 py-3">
      <DeviceIcon s={s} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 font-semibold">
          <span className="truncate">{s.name}</span>
          {s.current && <span className="rounded-full bg-live/15 px-2 text-[11.5px] leading-5 font-bold text-live-ink">This device</span>}
        </p>
        <p className="truncate text-[13px] text-ink-soft">{s.detail}</p>
        <p className="truncate text-[12.5px] text-ink-soft">
          {s.online ? <span className="font-medium text-live-ink">Active now</span> : lastSeen(s.lastActiveAt).replace('Last seen', 'Last active')}
          {` · Logged in ${shortDay(s.signedInAt)}`}
          {s.ip ? ` · ${s.ip}` : ''}
        </p>
      </div>
      {!s.current && (
        <Button size="sm" variant="danger-ghost" onClick={() => setEnding(s)} aria-label={`Log out ${s.name}`}>
          <LogOut size={15} />
          <span className="hidden sm:inline">Log out</span>
        </Button>
      )}
    </li>
  );

  return (
    <>
      <Dialog open={open} onClose={onClose} title="Devices" description={sessions ? `Logged in on ${devicesSummary(sessions)}.` : 'Where you’re logged in.'} width={520}>
        {!sessions ? (
          error ? (
            <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
              {error}
            </p>
          ) : (
            <p className="flex justify-center py-8 text-ink-soft">
              <LoaderCircle className="animate-spin" />
            </p>
          )
        ) : (
          <div className="space-y-4">
            <ul aria-label="Your devices" className="divide-y divide-line/70">
              {sessions.filter((s) => s.current).map(row)}
              {others.map(row)}
            </ul>
            {others.length > 0 ? (
              <Button variant="danger-soft" className="w-full" onClick={() => setEnding('others')}>
                <LogOut size={16} />
                Log out of all other devices
              </Button>
            ) : (
              <p className="rounded-xl bg-subtle/60 px-3.5 py-2.5 text-[13.5px] text-ink-soft">You’re not logged in anywhere else.</p>
            )}
            <p className="text-[12.5px] text-ink-soft">Don’t recognise a device? Log it out, then change your password.</p>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!ending}
        title={ending === 'others' ? 'Log out of all other devices?' : `Log out ${ending?.name ?? ''}?`}
        body={
          ending === 'others'
            ? 'Every other app and browser is logged out at once, and stops getting messages and notifications. This device stays logged in.'
            : 'It’s logged out at once and stops getting messages and notifications until someone logs in there again.'
        }
        confirm="Log out"
        danger
        busy={busy}
        onConfirm={() => void confirm()}
        onClose={() => setEnding(null)}
      />
    </>
  );
}
