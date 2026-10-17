import { useState } from 'react';
import { Button } from '../components/ui/Button';
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

export function EmptyPane({ section }: { section: keyof typeof copy }) {
  const c = copy[section];
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-[420px]">
        <p lang="bn" aria-hidden className="font-display text-[64px] leading-none text-line">
          আড্ডা
        </p>
        <h1 className="mt-4 font-display text-[26px] leading-tight">{c.title}</h1>
        <p className="mt-2 text-[15px] text-ink-soft">{c.body}</p>
        {c.action && (
          <Button className="mt-5" onClick={() => setOpen(true)}>
            {c.action}
          </Button>
        )}
      </div>
      {section === 'chats' && <UserPicker open={open} onClose={() => setOpen(false)} mode="chat" />}
      {section === 'rooms' && <CreateRoomDialog open={open} onClose={() => setOpen(false)} />}
    </div>
  );
}
