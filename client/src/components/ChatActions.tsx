import { useRef, useState } from 'react';
import { Archive, ArchiveRestore, Bell, BellOff, Pin, PinOff } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { haptic } from '../lib/native';
import type { ChatSettings } from '../lib/types';
import { isMuted, useChat, type MuteSpan, type Scope } from '../store/chat';
import { toast } from '../store/ui';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Menu, type MenuItem } from './ui/Menu';
import { Sheet } from './ui/Sheet';

const MUTE_CHOICES = [
  { span: '8h', label: '8 hours' },
  { span: '1w', label: '1 week' },
  { span: 'always', label: 'Always' },
] as const;

/** "Mute notifications for…": a while, or until I turn them back on. */
export function MuteDialog({ open, scope, id, name, onClose }: { open: boolean; scope: Scope; id: string; name: string; onClose: () => void }) {
  const [busy, setBusy] = useState('');
  async function mute(span: MuteSpan) {
    setBusy(span);
    try {
      await useChat.getState().setChatSettings(scope, id, { mute: span });
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy('');
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      alert
      width={380}
      title={`Mute ${name}?`}
      description={
        scope === 'room'
          ? "You won't be notified of its messages, except ones that mention you or reply to you."
          : "You won't be notified of their messages. Calls still ring."
      }
    >
      <div className="flex flex-col gap-2" role="group" aria-label="Mute for">
        {MUTE_CHOICES.map((c) => (
          <Button key={c.span} variant="soft" busy={busy === c.span} disabled={!!busy} onClick={() => void mute(c.span)}>
            {c.label}
          </Button>
        ))}
        <Button variant="ghost" disabled={!!busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}

/** A row's time, which makes way for its ⋮ while the pointer is over the row. */
export const ROW_TIME_HIDES = '[@media(hover:hover)]:group-hover:invisible';

/** Mute or unmute, pin or unpin, archive or bring back a chat or room. `askMute`: opens the MuteDialog. */
export function settingsItems(scope: Scope, id: string, settings: ChatSettings, askMute: () => void): MenuItem[] {
  const change = (c: { mute?: MuteSpan; pinned?: boolean; archived?: boolean }, done?: string) =>
    void useChat
      .getState()
      .setChatSettings(scope, id, c)
      .then(() => done && toast(done))
      .catch((err) => toast(errorMessage(err), 'error'));
  const what = scope === 'room' ? 'room' : 'chat';
  return [
    isMuted(settings)
      ? { label: 'Unmute notifications', icon: <Bell size={18} />, onSelect: () => change({ mute: 'off' }) }
      : { label: 'Mute notifications', icon: <BellOff size={18} />, onSelect: askMute },
    settings.pinnedAt
      ? { label: `Unpin ${what}`, icon: <PinOff size={18} />, onSelect: () => change({ pinned: false }) }
      : { label: `Pin ${what}`, icon: <Pin size={18} />, onSelect: () => change({ pinned: true }) },
    settings.archivedAt
      ? { label: `Unarchive ${what}`, icon: <ArchiveRestore size={18} />, onSelect: () => change({ archived: false }, `${scope === 'room' ? 'Room' : 'Chat'} is back in your list`) }
      : { label: `Archive ${what}`, icon: <Archive size={18} />, onSelect: () => change({ archived: true }, `${scope === 'room' ? 'Room' : 'Chat'} archived`) },
  ];
}

/**
 * Press and hold (touch only), as in other messengers: a little buzz, then
 * `onHold`. The tap that ends the hold doesn't open the row, and the
 * browser's own long-press menu for links stays away.
 */
export function useHold(onHold: () => void) {
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const held = useRef(false);
  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      cancel();
      held.current = false;
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          press.current = null;
          held.current = true;
          haptic('press');
          onHold();
        }, 450),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      if ((e.nativeEvent as PointerEvent).pointerType === 'touch' || held.current) e.preventDefault();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!held.current) return;
      held.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/**
 * A chat or room row's own menu: ⋮ in place of its time when the pointer is
 * over it (wider screens; the row's time hides with ROW_TIME_HIDES), or press
 * and hold the row (phones). Returns the row's hold handlers, and what to put
 * beside the row.
 */
export function useRowMenu(scope: Scope, id: string, name: string, settings: ChatSettings) {
  const [sheet, setSheet] = useState(false);
  const [muting, setMuting] = useState(false);
  const items = settingsItems(scope, id, settings, () => setMuting(true));
  const hold = useHold(() => setSheet(true));
  const label = `Options for ${name}`;
  const extras = (
    <>
      <span className="absolute top-2 right-2 z-[1] hidden rounded-full bg-surface opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 md:right-2.5 [@media(hover:hover)]:block">
        <Menu floating label={label} items={items} size={28} />
      </span>
      {sheet && <Sheet label={label} title={<p className="truncate text-[13.5px] font-semibold text-ink-soft">{name}</p>} items={items} onClose={() => setSheet(false)} />}
      <MuteDialog open={muting} scope={scope} id={id} name={name} onClose={() => setMuting(false)} />
    </>
  );
  return { hold, extras };
}
