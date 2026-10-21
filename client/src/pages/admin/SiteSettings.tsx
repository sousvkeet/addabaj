import { useEffect, useState } from 'react';
import { KeyRound, LoaderCircle, Megaphone } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { toast } from '../../store/ui';
import { Button } from '../../components/ui/Button';
import { inputClass } from '../../components/ui/Dialog';
import { Toggle } from '../../components/ui/Toggle';
import { ChangePasswordDialog } from '../../components/ChangePasswordDialog';
import { AdminPage, Panel, type SiteSettings as Settings } from './shared';

const MAX = 280;

export function SiteSettings() {
  const user = useAuth((s) => s.user);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'signups' | 'publish' | 'clear'>('');
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    api<{ settings: Settings }>('/admin/settings')
      .then(({ settings }) => {
        setSettings(settings);
        setDraft(settings.announcement?.text ?? '');
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  async function save(patch: Partial<{ allowSignups: boolean; announcement: string | null }>, what: typeof busy, done: string) {
    setBusy(what);
    try {
      const res = await api<{ settings: Settings }>('/admin/settings', { method: 'PATCH', body: patch });
      setSettings(res.settings);
      setDraft(res.settings.announcement?.text ?? '');
      toast(done, 'live');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <AdminPage title="Site settings" subtitle="How Adda Khana works for everyone">
      {error && (
        <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
          {error}
        </p>
      )}
      {!settings ? (
        !error && (
          <p className="flex justify-center py-16 text-ink-soft">
            <LoaderCircle className="animate-spin" />
          </p>
        )
      ) : (
        <>
          <Panel title="Sign-ups">
            <Toggle
              checked={settings.allowSignups}
              disabled={busy === 'signups'}
              onChange={(on) => void save({ allowSignups: on }, 'signups', on ? 'Anyone can create an account now.' : 'Sign-ups are closed. Add people from the People page.')}
              label="Let new people create accounts"
              hint="When this is off, the sign-up page says sign-ups are closed, and only a host admin can add people."
            />
          </Panel>

          <Panel title="Announcement" hint="A banner at the top of the app for everyone who's signed in, for example about maintenance.">
            {settings.announcement && (
              <div className="mb-4 flex items-start gap-3 rounded-2xl border border-brand/30 bg-brand/10 p-3.5">
                <Megaphone size={18} className="mt-0.5 shrink-0 text-brand dark:text-live" />
                <p className="min-w-0 flex-1 text-[14px]">
                  <span className="mr-1.5 font-semibold">Showing now:</span>
                  {settings.announcement.text}
                </p>
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, MAX))}
              placeholder="Video calls will be down for 10 minutes at 11 pm for an update."
              aria-label="Announcement"
              className={`${inputClass} h-auto min-h-[92px] resize-none py-3`}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="mr-auto text-[12.5px] text-ink-soft tabular-nums">
                {draft.length}/{MAX}
              </span>
              {settings.announcement && (
                <Button variant="ghost" size="sm" busy={busy === 'clear'} onClick={() => void save({ announcement: null }, 'clear', 'The announcement was taken down.')}>
                  Take down
                </Button>
              )}
              <Button
                size="sm"
                busy={busy === 'publish'}
                disabled={!draft.trim() || draft.trim() === settings.announcement?.text}
                onClick={() => void save({ announcement: draft }, 'publish', 'Everyone sees your announcement now.')}
              >
                <Megaphone size={15} />
                {settings.announcement ? 'Update' : 'Publish'}
              </Button>
            </div>
          </Panel>

          <Panel title="Your admin login">
            <div className="flex flex-wrap items-center gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">
                <KeyRound size={20} />
              </span>
              <p className="min-w-[220px] flex-1 text-[14px] text-ink-soft">
                You log in as <span className="font-semibold text-ink">{user?.email}</span>.
                {user?.mustChangePassword ? ' You still have the default password.' : ''} Locked out? On the server, run{' '}
                <code className="rounded bg-subtle px-1.5 py-0.5 text-[13px] text-ink">npm run admin:reset</code>.
              </p>
              <Button variant={user?.mustChangePassword ? 'primary' : 'soft'} onClick={() => setChanging(true)}>
                Change password
              </Button>
            </div>
          </Panel>
        </>
      )}
      <ChangePasswordDialog open={changing} onClose={() => setChanging(false)} />
    </AdminPage>
  );
}
