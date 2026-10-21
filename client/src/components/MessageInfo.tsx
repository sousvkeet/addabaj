import { useEffect, useState, type ReactNode } from 'react';
import { Check, CheckCheck, Clock, LoaderCircle } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { clock, dayLabel } from '../lib/format';
import type { User } from '../lib/types';
import { useAuth } from '../store/auth';
import { Avatar } from './ui/Avatar';
import { Dialog } from './ui/Dialog';

/** "Today, 9:41 PM" */
const when = (iso: string) => `${dayLabel(iso)}, ${clock(iso)}`;

export type InfoTarget =
  | { scope: 'dm'; sentAt: string; deliveredAt: string | null; readAt: string | null; partnerName: string }
  | { scope: 'room'; roomId: string; messageId: number; sentAt: string };

/** When one of my messages was delivered and read (in a chat), or who has it and who saw it (in a room). */
export function MessageInfo({ target, onClose }: { target: InfoTarget | null; onClose: () => void }) {
  return (
    <Dialog open={!!target} onClose={onClose} title="Message info" width={420}>
      {target?.scope === 'dm' && <DmInfo target={target} />}
      {target?.scope === 'room' && <RoomInfo target={target} />}
    </Dialog>
  );
}

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-subtle text-ink-soft">{icon}</span>
      <div>
        <p className="text-[13px] font-semibold text-ink-soft">{label}</p>
        <p className="text-[15px]">{value}</p>
      </div>
    </div>
  );
}

function DmInfo({ target }: { target: Extract<InfoTarget, { scope: 'dm' }> }) {
  const receiptsOn = useAuth((s) => s.user?.privacy?.readReceipts ?? true);
  return (
    <div className="divide-y divide-line/70">
      <Row
        icon={<CheckCheck size={16} className={target.readAt ? 'text-live-ink' : ''} />}
        label="Read"
        value={target.readAt ? when(target.readAt) : <span className="text-ink-soft">Not yet</span>}
      />
      <Row
        icon={<CheckCheck size={16} />}
        label={`Delivered to ${target.partnerName}`}
        value={target.deliveredAt ? when(target.deliveredAt) : <span className="text-ink-soft">Not yet: their app hasn't been online since</span>}
      />
      <Row icon={<Check size={16} />} label="Sent" value={when(target.sentAt)} />
      {!receiptsOn && (
        <p className="pt-3 text-[13px] text-ink-soft">You've turned off read receipts, so you don't see when people read your messages.</p>
      )}
    </div>
  );
}

type Member = { user: User; read: boolean; delivered: boolean };

function RoomInfo({ target }: { target: Extract<InfoTarget, { scope: 'room' }> }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ members: Member[] }>(`/rooms/${target.roomId}/messages/${target.messageId}/info`)
        .then((r) => live && setMembers(r.members))
        .catch((err) => live && setError(errorMessage(err)));
    void load();
    // Keep it current while open.
    const id = window.setInterval(load, 4000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [target.roomId, target.messageId]);

  if (error) return <p className="rounded-2xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>;
  if (!members) {
    return (
      <p className="flex justify-center py-8 text-ink-soft">
        <LoaderCircle className="animate-spin" />
      </p>
    );
  }
  const groups: [string, ReactNode, Member[]][] = [
    ['Read by', <CheckCheck key="r" size={15} className="text-live-ink" />, members.filter((m) => m.read)],
    ['Delivered to', <CheckCheck key="d" size={15} />, members.filter((m) => m.delivered && !m.read)],
    ['Not delivered yet', <Clock key="w" size={15} />, members.filter((m) => !m.delivered)],
  ];
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-soft">Sent {when(target.sentAt)}</p>
      {members.length === 0 && <p className="text-[14px] text-ink-soft">No one else is in this room yet.</p>}
      {groups.map(([label, icon, list]) =>
        list.length ? (
          <section key={label}>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-ink-soft">
              {icon}
              {label} <span className="tabular-nums">· {list.length}</span>
            </h3>
            <ul className="space-y-1">
              {list.map(({ user }) => (
                <li key={user.id} className="flex items-center gap-3 rounded-2xl px-1 py-1">
                  <Avatar name={user.name} hue={user.hue} size={34} online={user.online} />
                  <span className="truncate font-medium">{user.name}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}
