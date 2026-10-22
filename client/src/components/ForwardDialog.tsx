import { useEffect, useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { useSite } from '../lib/site';
import { useAuth } from '../store/auth';
import { ordered, useChat, type Scope } from '../store/chat';
import { toast } from '../store/ui';
import { Avatar, hueFromId } from './ui/Avatar';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

type Target = { key: string; scope: Scope; id: string; name: string; hue: number; photo?: string | null; at: string; pinnedAt?: string | null };

/** Pick chats and rooms of mine to send a copy of a message to (as many at once as the host allows). */
export function ForwardDialog({ scope, messageId, onClose }: { scope: Scope; messageId: number | null; onClose: () => void }) {
  const conversations = useChat((s) => s.conversations);
  const rooms = useChat((s) => s.rooms);
  const forwardTo = useSite((s) => s.messaging.forwardTo);
  // Host admins aren't limited (the server allows them up to 50).
  const limit = useAuth((s) => (s.user?.siteAdmin ? 50 : forwardTo));
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<Target[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setChosen([]);
    setFilter('');
  }, [messageId]);

  // Chats and rooms together: pinned first, then the latest.
  const targets = useMemo(() => {
    const chats: Target[] = Object.values(conversations)
      .filter((c) => c.lastMessage && !c.partner.blocked)
      .map((c) => ({ key: `dm:${c.partner.id}`, scope: 'dm', id: c.partner.id, name: c.partner.name, hue: c.partner.hue, photo: c.partner.photo, at: c.lastMessage!.createdAt, pinnedAt: c.pinnedAt }));
    const groups: Target[] = Object.values(rooms).map((r) => ({
      key: `room:${r.id}`, scope: 'room', id: r.id, name: r.name, hue: hueFromId(r.id), photo: r.photo, at: r.lastMessage?.createdAt ?? r.createdAt, pinnedAt: r.pinnedAt,
    }));
    const f = filter.trim().toLowerCase();
    return ordered([...chats, ...groups], (t) => t.at).filter((t) => !f || t.name.toLowerCase().includes(f));
  }, [conversations, rooms, filter]);

  function toggle(t: Target) {
    if (chosen.some((c) => c.key === t.key)) return setChosen(chosen.filter((c) => c.key !== t.key));
    if (chosen.length >= limit) return toast(`You can forward a message to up to ${limit} ${limit === 1 ? 'chat' : 'chats'} at a time.`);
    setChosen([...chosen, t]);
  }

  async function send() {
    if (!messageId || !chosen.length) return;
    setBusy(true);
    const results = await useChat.getState().forwardMessage(scope, messageId, chosen.map((t) => ({ scope: t.scope, id: t.id })));
    setBusy(false);
    if (!results) return;
    const nameOf = (r: { scope: Scope; id: string }) => chosen.find((t) => t.scope === r.scope && t.id === r.id)?.name ?? 'a chat';
    const sent = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (sent.length) toast(sent.length === 1 ? `Forwarded to ${nameOf(sent[0])}` : `Forwarded to ${sent.length} chats`);
    for (const r of failed) toast(`Not forwarded to ${nameOf(r)}: ${r.error ?? 'try again.'}`, 'error');
    if (sent.length) onClose();
    else setChosen(chosen.filter((t) => failed.every((r) => r.scope !== t.scope || r.id !== t.id)));
  }

  return (
    <Dialog open={messageId !== null} onClose={onClose} title="Forward message" description={`Choose up to ${limit} ${limit === 1 ? 'chat or room' : 'chats or rooms'}.`} width={440}>
      <label className="mb-3 flex h-11 items-center gap-2.5 rounded-2xl border border-line/70 bg-subtle px-3.5 text-ink-soft focus-within:border-brand">
        <Search size={16} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search chats and rooms"
          aria-label="Search chats and rooms"
          className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-soft/80"
        />
      </label>
      <ul className="-mx-2 max-h-[min(50vh,380px)] overflow-y-auto" aria-label="Chats and rooms">
        {targets.map((t) => {
          const on = chosen.some((c) => c.key === t.key);
          return (
            <li key={t.key}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(t)}
                className={`flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-subtle ${on ? 'bg-brand/8' : ''}`}
              >
                <Avatar name={t.name} hue={t.hue} photo={t.photo} size={40} square={t.scope === 'room'} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{t.name}</span>
                  <span className="block text-[12.5px] text-ink-soft">{t.scope === 'room' ? 'Room' : 'Chat'}</span>
                </span>
                <span
                  aria-hidden
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 ${on ? 'border-transparent bg-aurora text-white shadow-glow' : 'border-line'}`}
                >
                  {on && <Check size={14} strokeWidth={3} />}
                </span>
              </button>
            </li>
          );
        })}
        {!targets.length && <li className="px-2 py-6 text-center text-[14px] text-ink-soft">{filter ? 'Nothing matches that name.' : 'No chats or rooms yet.'}</li>}
      </ul>
      <div className="mt-4 flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-[13.5px] text-ink-soft" aria-live="polite">
          {chosen.length ? chosen.map((t) => t.name).join(', ') : 'Nothing chosen yet'}
        </p>
        <Button busy={busy} disabled={!chosen.length} onClick={() => void send()}>
          Forward
        </Button>
      </div>
    </Dialog>
  );
}
