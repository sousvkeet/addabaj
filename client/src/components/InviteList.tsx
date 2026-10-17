import { useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../lib/api';
import { listStamp } from '../lib/format';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Avatar, hueFromId } from './ui/Avatar';
import { Button } from './ui/Button';
import { ListEmpty, ListHeader } from './ListHeader';

export function InviteList() {
  const invites = useChat((s) => s.invites);
  const accept = useChat((s) => s.acceptInvite);
  const decline = useChat((s) => s.declineInvite);
  const bootstrapped = useChat((s) => s.bootstrapped);
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(id: string, action: 'accept' | 'decline') {
    setBusy(`${id}:${action}`);
    try {
      if (action === 'accept') {
        const room = await accept(id);
        navigate(`/rooms/${room.id}`);
      } else {
        await decline(id);
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <ListHeader title="Invites" />
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {invites.map((inv) => {
          const full = inv.room.memberCount >= inv.room.maxMembers;
          return (
            <li key={inv.id} className="rounded-2xl bg-paper p-4">
              <div className="flex items-start gap-3">
                <Avatar name={inv.room.name} hue={hueFromId(inv.room.id)} size={44} square />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">{inv.room.name}</span>
                    <span className="ml-auto shrink-0 text-[12px] text-ink-soft">{listStamp(inv.createdAt)}</span>
                  </p>
                  <p className="text-[13.5px] text-ink-soft">{inv.inviter.name} invited you</p>
                  <p className={`mt-0.5 text-[13px] ${full ? 'text-oxide' : 'text-ink-soft'}`}>
                    {full ? 'This room is full right now' : `${inv.room.memberCount} of ${inv.room.maxMembers} members`}
                  </p>
                </div>
              </div>
              {inv.room.description && <p className="mt-2 text-[14px]">{inv.room.description}</p>}
              <div className="mt-3 flex gap-2">
                <Button size="sm" busy={busy === `${inv.id}:accept`} disabled={!!busy || full} onClick={() => run(inv.id, 'accept')}>
                  Join room
                </Button>
                <Button size="sm" variant="ghost" busy={busy === `${inv.id}:decline`} disabled={!!busy} onClick={() => run(inv.id, 'decline')}>
                  Decline
                </Button>
              </div>
            </li>
          );
        })}
        {bootstrapped && invites.length === 0 && (
          <ListEmpty title="No invites right now">
            <p>When a room admin invites you, it shows up here so you can join or decline.</p>
          </ListEmpty>
        )}
      </ul>
    </>
  );
}
