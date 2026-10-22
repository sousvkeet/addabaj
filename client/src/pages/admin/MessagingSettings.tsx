import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { toast } from '../../store/ui';
import { Toggle } from '../../components/ui/Toggle';
import { Panel } from './shared';

type Messaging = { linkPreviews: boolean; editing: boolean; editMinutes: number; forwarding: boolean; forwardTo: number };

const EDIT_MINUTES = [5, 15, 30, 60, 1440];
const FORWARD_TO = [1, 3, 5, 10, 20];

/** "15 minutes", "1 hour", "1 day". */
function minutes(n: number) {
  if (n % 1440 === 0) return n === 1440 ? '1 day' : `${n / 1440} days`;
  if (n % 60 === 0) return n === 60 ? '1 hour' : `${n / 60} hours`;
  return n === 1 ? '1 minute' : `${n} minutes`;
}
const chats = (n: number) => (n === 1 ? '1 chat' : `${n} chats`);

/** The usual choices, plus the saved one if it's something else. */
const choices = (usual: number[], saved: number) => (usual.includes(saved) ? usual : [...usual, saved].sort((a, b) => a - b));

const selectClass =
  'mt-3 h-10 max-w-full rounded-xl border border-line bg-subtle/60 pr-8 pl-3 text-[14px] font-semibold text-ink outline-none transition-[border-color,box-shadow] focus:border-brand focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_18%,transparent)] disabled:cursor-not-allowed disabled:opacity-50';

/** What everyone can do with messages: link previews, editing and forwarding. Each change is saved at once. */
export function MessagingSettingsPanel() {
  const [settings, setSettings] = useState<Messaging | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ messaging: Messaging }>('/admin/messaging')
      .then(({ messaging }) => setSettings(messaging))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  if (!settings) {
    return (
      <Panel title="Messages">
        {error ? <p className="text-[14px] text-danger">{error}</p> : <p className="text-[14px] text-ink-soft">Loading…</p>}
      </Panel>
    );
  }

  async function save<K extends keyof Messaging>(key: K, value: Messaging[K], done: (m: Messaging) => string) {
    const before = settings!;
    // Show the change at once; put it back if it isn't saved.
    setSettings({ ...before, [key]: value });
    setSaving(true);
    try {
      const { messaging } = await api<{ messaging: Messaging }>('/admin/messaging', { method: 'PATCH', body: { [key]: value } });
      setSettings(messaging);
      toast(done(messaging), 'live');
    } catch (err) {
      setSettings(before);
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  const editFor = (m: Messaging) => `People can edit a message for ${minutes(m.editMinutes)} after sending it.`;
  const forwardTo = (m: Messaging) => `People can forward a message to up to ${chats(m.forwardTo)} at a time.`;

  return (
    <Panel title="Messages" hint="What people can do with messages in chats and rooms. Host admins can always edit and forward, with no time or chat limit.">
      <div className="divide-y divide-line/70">
        <div className="pb-4">
          <Toggle
            checked={settings.linkPreviews}
            disabled={saving}
            onChange={(on) => void save('linkPreviews', on, () => (on ? 'Links in messages show a preview card now.' : 'Link previews are off. Links show as plain links.'))}
            label="Link previews"
            hint="Links in messages show a card with the page's title and picture. The server fetches the page itself, and never reaches addresses on your own network."
          />
        </div>
        <div className="py-4">
          <Toggle
            checked={settings.editing}
            disabled={saving}
            onChange={(on) => void save('editing', on, (m) => (on ? editFor(m) : "Editing is off. People can't change messages they've sent."))}
            label="Editing"
            hint="People can change a message after sending it, for a while. It's marked edited, and if it's reported you see what it said before."
          />
          <select
            aria-label="How long people can edit a message"
            className={selectClass}
            value={settings.editMinutes}
            disabled={saving || !settings.editing}
            onChange={(e) => void save('editMinutes', Number(e.target.value), editFor)}
          >
            {choices(EDIT_MINUTES, settings.editMinutes).map((n) => (
              <option key={n} value={n}>
                for {minutes(n)}
              </option>
            ))}
          </select>
        </div>
        <div className="pt-4">
          <Toggle
            checked={settings.forwarding}
            disabled={saving}
            onChange={(on) => void save('forwarding', on, (m) => (on ? forwardTo(m) : 'Forwarding is off.'))}
            label="Forwarding"
            hint="People can send a message on to other chats and rooms. It's marked forwarded."
          />
          <select
            aria-label="How many chats people can forward a message to at once"
            className={selectClass}
            value={settings.forwardTo}
            disabled={saving || !settings.forwarding}
            onChange={(e) => void save('forwardTo', Number(e.target.value), forwardTo)}
          >
            {choices(FORWARD_TO, settings.forwardTo).map((n) => (
              <option key={n} value={n}>
                to up to {chats(n)} at a time
              </option>
            ))}
          </select>
        </div>
      </div>
    </Panel>
  );
}
