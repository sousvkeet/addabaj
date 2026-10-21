import { useState } from 'react';
import { AudioLines, MessageCircle, MonitorPlay, Plus, SquarePen, Video } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';
import { UserPicker } from '../components/UserPicker';
import { CreateRoomDialog } from '../components/CreateRoomDialog';

const copy = {
  chats: {
    title: 'Pick someone to talk to',
    body: 'Choose a chat on the left, or start a new one with anyone on Adda Khana. You can call them from inside the chat.',
    action: 'Start a chat',
  },
  rooms: {
    title: 'Pick a room, or start your own',
    body: 'Rooms are group chats with a voice table. You decide how many people can join, then add or invite them.',
    action: 'Start a room',
  },
  invites: {
    title: 'Room invites',
    body: 'Invites from room admins appear on the left. Join the ones you like; the admin sees when you decline.',
    action: null,
  },
} as const;

const TILES = [
  { Icon: MessageCircle, title: 'Chat', text: 'Photos, files, voice notes, replies and reactions.' },
  { Icon: Video, title: 'Call', text: 'Voice and video calls in HD, one tap away.' },
  { Icon: AudioLines, title: 'Hang out', text: 'Rooms with a live voice table for everyone.' },
  { Icon: MonitorPlay, title: 'Watch', text: 'Videos in sync, or stream live from your device.' },
];

export function EmptyPane({ section }: { section: keyof typeof copy }) {
  const c = copy[section];
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-[560px] text-center">
        <div className="relative mx-auto size-28">
          <span aria-hidden className="absolute inset-0 rounded-full bg-aurora opacity-40 blur-2xl" />
          <Logo size={112} className="relative" />
        </div>
        <h1 className="mt-7 font-display text-[28px] leading-tight font-bold tracking-[-0.02em]">{c.title}</h1>
        <p className="mx-auto mt-2 max-w-[44ch] text-[15px] text-ink-soft">{c.body}</p>
        {c.action && (
          <Button className="mt-6" size="lg" onClick={() => setOpen(true)}>
            {section === 'chats' ? <SquarePen size={18} /> : <Plus size={19} />}
            {c.action}
          </Button>
        )}
        <ul className="mt-10 grid grid-cols-2 gap-3 text-left">
          {TILES.map(({ Icon, title, text }) => (
            <li key={title} className="rounded-2xl border border-line/70 bg-subtle/40 p-4">
              <span className="flex size-9 items-center justify-center rounded-xl bg-brand/12 text-brand dark:text-live">
                <Icon size={18} />
              </span>
              <p className="mt-3 font-display text-[15px] font-semibold">{title}</p>
              <p className="mt-0.5 text-[13px] text-ink-soft">{text}</p>
            </li>
          ))}
        </ul>
      </div>
      {section === 'chats' && <UserPicker open={open} onClose={() => setOpen(false)} mode="chat" />}
      {section === 'rooms' && <CreateRoomDialog open={open} onClose={() => setOpen(false)} />}
    </div>
  );
}
