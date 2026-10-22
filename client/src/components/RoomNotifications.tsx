import { useState } from 'react';
import { Archive, ArchiveRestore, Bell, BellOff, Pin, PinOff } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { isMuted, mutedForGood, useChat } from '../store/chat';
import { toast } from '../store/ui';
import type { RoomSummary } from '../lib/types';
import { Button } from './ui/Button';

const CHOICES = [
  { span: '8h', label: '8 hours' },
  { span: '1w', label: '1 week' },
  { span: 'always', label: 'Always' },
] as const;

const at = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const today = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** "until 6:30 PM", "until Fri 9:15 AM". */
function until(iso: string) {
  const d = new Date(iso);
  return `until ${d.toDateString() === new Date().toDateString() ? today.format(d) : at.format(d)}`;
}

/**
 * Room info: my notifications for the room, and muting them (mentions and
 * replies to me still come through); and pinning or archiving it in my list.
 */
export function RoomNotifications({ room }: { room: RoomSummary }) {
  const muteRoom = useChat((s) => s.muteRoom);
  const setChatSettings = useChat((s) => s.setChatSettings);
  const [busy, setBusy] = useState('');
  const muted = isMuted(room);

  async function set(span: '8h' | '1w' | 'always' | 'off') {
    setBusy(span);
    try {
      await muteRoom(room.id, span);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  async function keep(change: { pinned?: boolean; archived?: boolean }, what: string) {
    setBusy(what);
    try {
      await setChatSettings('room', room.id, change);
      if (change.archived) toast('Room archived. It stays under Archived when new messages come in.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <section aria-labelledby="notifications-heading" className="border-t border-line/70 px-4 pt-4 pb-4">
      <div className="flex items-start gap-3">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-2xl ${muted ? 'bg-subtle text-ink-soft' : 'bg-brand/12 text-brand dark:bg-live/15 dark:text-live'}`}>
          {muted ? <BellOff size={19} /> : <Bell size={19} />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="notifications-heading" className="font-semibold">
            Notifications
          </h2>
          <p className="text-[13.5px] text-ink-soft">
            {muted
              ? `Muted ${mutedForGood(room) ? 'until you turn them back on' : until(room.mutedUntil!)}. You still hear when someone mentions you or replies to you.`
              : 'On for every message.'}
          </p>
        </div>
      </div>
      {muted ? (
        <Button variant="soft" size="sm" className="mt-3 w-full" busy={busy === 'off'} onClick={() => void set('off')}>
          <Bell size={15} />
          Unmute
        </Button>
      ) : (
        <div className="mt-3" role="group" aria-label="Mute notifications for">
          <p className="mb-1.5 text-[12.5px] font-semibold text-ink-soft">Mute for</p>
          <div className="flex gap-2">
            {CHOICES.map((c) => (
              <Button key={c.span} variant="outline" size="sm" className="flex-1" busy={busy === c.span} disabled={!!busy} onClick={() => void set(c.span)}>
                {c.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <Button variant="ghost" size="sm" className="flex-1" busy={busy === 'pin'} disabled={!!busy} onClick={() => void keep({ pinned: !room.pinnedAt }, 'pin')}>
          {room.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}
          {room.pinnedAt ? 'Unpin room' : 'Pin room'}
        </Button>
        <Button variant="ghost" size="sm" className="flex-1" busy={busy === 'archive'} disabled={!!busy} onClick={() => void keep({ archived: !room.archivedAt }, 'archive')}>
          {room.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          {room.archivedAt ? 'Unarchive room' : 'Archive room'}
        </Button>
      </div>
    </section>
  );
}
