import { useState } from 'react';
import { useNavigate } from 'react-router';
import { leaveGone } from '../lib/back';
import { ArrowLeft, Camera, Crown, LogOut, MessageCircle, Settings, ShieldCheck, UserMinus, UserPlus, X } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { lastSeen } from '../lib/format';
import { useNow } from '../lib/useMedia';
import type { RoomDetail, RoomMember } from '../lib/types';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Avatar, hueFromId } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import { Menu, type MenuItem } from './ui/Menu';
import { RoomSettingsDialog } from './RoomSettingsDialog';
import { PhotoEditor } from './PhotoEditor';
import { RoomInviteCard } from './RoomInvite';
import { UserPicker } from './UserPicker';
import { VoiceTable } from './VoiceTable';

type Props = {
  room: RoomDetail;
  onClose?: () => void;
  addOpen: boolean;
  setAddOpen: (open: boolean) => void;
};

export function RoomPanel({ room, onClose, addOpen, setAddOpen }: Props) {
  const me = useAuth((s) => s.user);
  const online = useChat((s) => s.online);
  const seen = useChat((s) => s.lastSeen);
  const hidden = useChat((s) => s.hiddenPresence);
  // "Last seen 5 min ago" keeps counting.
  useNow(60_000);
  /** "Online", "Last seen 5 min ago", or nothing when they (or I) don't share it. */
  const status = (m: RoomMember) => {
    if (m.id === me?.id || (hidden[m.id] ?? m.presenceHidden)) return null;
    return online[m.id] ? 'Online' : lastSeen(seen[m.id] ?? m.lastSeenAt);
  };
  const removeMember = useChat((s) => s.removeMember);
  const setRole = useChat((s) => s.setRole);
  const cancelInvite = useChat((s) => s.cancelInvite);
  const leaveRoom = useChat((s) => s.leaveRoom);
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'remove'; member: RoomMember } | { kind: 'leave' } | null>(null);
  const [busy, setBusy] = useState(false);

  const isAdmin = room.myRole === 'admin';
  const isOwner = room.ownerId === me?.id;
  const full = room.memberCount >= room.maxMembers;

  async function run(fn: () => Promise<void>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      setConfirm(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  function memberMenu(m: RoomMember): MenuItem[] {
    if (m.id === me?.id) return [];
    const items: MenuItem[] = [
      { label: `Message ${m.name.split(' ')[0]}`, icon: <MessageCircle size={16} />, onSelect: () => navigate(`/chats/${m.id}`) },
    ];
    if (isOwner && m.id !== room.ownerId) {
      items.push(
        m.role === 'admin'
          ? { label: 'Remove as admin', icon: <ShieldCheck size={16} />, onSelect: () => void run(() => setRole(room.id, m.id, 'member')) }
          : { label: 'Make admin', icon: <ShieldCheck size={16} />, onSelect: () => void run(() => setRole(room.id, m.id, 'admin')) },
      );
    }
    const canRemove = isAdmin && m.id !== room.ownerId && (m.role !== 'admin' || isOwner);
    if (canRemove) {
      items.push({ label: 'Remove from room', icon: <UserMinus size={16} />, danger: true, onSelect: () => setConfirm({ kind: 'remove', member: m }) });
    }
    return items;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {onClose && (
        <div className="flex h-14 shrink-0 items-center gap-2 px-2 md:justify-between md:px-4">
          {/* Phones: a page of its own, so back. Wider screens: a side panel, so close. */}
          <IconButton label="Close" onClick={onClose} className="ripple md:hidden">
            <ArrowLeft size={20} />
          </IconButton>
          <h2 className="font-display text-[18px] font-semibold">Room info</h2>
          <span className="ml-auto hidden md:flex">
            <IconButton label="Close" onClick={onClose}>
              <X size={19} />
            </IconButton>
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The room: its photo (admins can change it), name and what it's for. */}
        <div className="flex flex-col items-center px-5 pt-3 pb-5 text-center">
          {isAdmin ? (
            <button
              type="button"
              onClick={() => setPhotoOpen(true)}
              aria-label={room.photo ? 'Change the room photo' : 'Add a room photo'}
              className="relative rounded-[32%] transition-transform active:scale-95"
            >
              <Avatar name={room.name} hue={hueFromId(room.id)} photo={room.photo} size={96} square />
              <span aria-hidden className="absolute -right-1 -bottom-1 flex size-8 items-center justify-center rounded-full border-2 border-surface bg-aurora text-white">
                <Camera size={15} />
              </span>
            </button>
          ) : (
            <Avatar name={room.name} hue={hueFromId(room.id)} photo={room.photo} size={96} square />
          )}
          <p className="mt-3 max-w-full truncate font-display text-[20px] font-semibold">{room.name}</p>
          <p className="text-[13.5px] text-ink-soft">
            Room · {room.memberCount} {room.memberCount === 1 ? 'member' : 'members'}
          </p>
          {room.description && <p className="mt-1.5 text-[14px] break-words text-ink-soft">{room.description}</p>}
        </div>
        <VoiceTable roomId={room.id} members={room.members} />

        <section aria-labelledby="members-heading" className="border-t border-line/70 px-2 pt-4 pb-3">
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <h2 id="members-heading" className="font-semibold">
              Members{' '}
              <span className={`font-normal tabular-nums ${full ? 'text-danger' : 'text-ink-soft'}`}>
                {room.memberCount} of {room.maxMembers}
              </span>
            </h2>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                <UserPlus size={15} />
                Add people
              </Button>
            )}
          </div>
          {isAdmin && <RoomInviteCard room={room} />}
          {isAdmin && full && (
            <p className="mx-2 mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">
              The room is full. Raise the limit in settings to add more people.
            </p>
          )}
          <ul>
            {room.members.map((m) => (
              <li key={m.id}>
                <div className="flex items-center gap-3 rounded-2xl px-2 py-1.5 transition-colors hover:bg-subtle/70">
                  <Avatar name={m.name} hue={m.hue} photo={m.photo} size={36} online={online[m.id]} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium">
                      {m.name}
                      {m.id === me?.id && <span className="font-normal text-ink-soft"> (you)</span>}
                    </span>
                    {(m.id === room.ownerId || m.role === 'admin' || status(m)) && (
                      <span className="flex min-w-0 items-center gap-1 text-[12.5px] text-ink-soft">
                        {(m.id === room.ownerId || m.role === 'admin') && (
                          <>
                            {m.id === room.ownerId ? <Crown size={12} className="shrink-0" /> : <ShieldCheck size={12} className="shrink-0" />}
                            <span className="shrink-0">{m.id === room.ownerId ? 'Admin, started the room' : 'Admin'}</span>
                            {status(m) && <span aria-hidden>·</span>}
                          </>
                        )}
                        {status(m) && <span className={`truncate ${online[m.id] ? 'font-medium text-live-ink' : ''}`}>{status(m)}</span>}
                      </span>
                    )}
                  </span>
                  <Menu label={`Options for ${m.name}`} items={memberMenu(m)} />
                </div>
                {confirm?.kind === 'remove' && confirm.member.id === m.id && (
                  <div className="mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-danger/10 p-2.5">
                    <span className="flex-1 text-[13.5px] text-danger">Remove {m.name} from the room?</span>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" busy={busy} onClick={() => void run(() => removeMember(room.id, m.id), `${m.name} was removed.`)}>
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        {isAdmin && room.invites.length > 0 && (
          <section aria-labelledby="invites-heading" className="border-t border-line/70 px-2 pt-4 pb-3">
            <h2 id="invites-heading" className="px-2 pb-2 font-semibold">
              Waiting to join <span className="font-normal text-ink-soft">{room.invites.length}</span>
            </h2>
            <ul>
              {room.invites.map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
                  <Avatar name={inv.invitee.name} hue={inv.invitee.hue} photo={inv.invitee.photo} size={36} className="opacity-70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium">{inv.invitee.name}</span>
                    <span className="block truncate text-[12.5px] text-ink-soft">Invited by {inv.invitedBy}</span>
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => cancelInvite(room.id, inv.id), 'Invite cancelled.')}>
                    Cancel
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="shrink-0 border-t border-line/70 p-3 pb-[max(12px,var(--safe-bottom))]">
        {confirm?.kind === 'leave' ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 text-[14px]">Leave {room.name}?</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Stay
            </Button>
            <Button
              size="sm"
              variant="danger"
              busy={busy}
              onClick={() =>
                void run(async () => {
                  await leaveRoom(room.id);
                  leaveGone(navigate, '/rooms');
                }, `You left ${room.name}.`)
              }
            >
              Leave room
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            {isAdmin && (
              <Button variant="soft" className="flex-1" onClick={() => setSettingsOpen(true)}>
                <Settings size={17} />
                Room settings
              </Button>
            )}
            {!isOwner && (
              <Button variant="danger-ghost" className="flex-1" onClick={() => setConfirm({ kind: 'leave' })}>
                <LogOut size={17} />
                Leave room
              </Button>
            )}
          </div>
        )}
      </div>

      {isAdmin && <RoomSettingsDialog room={room} open={settingsOpen} onClose={() => setSettingsOpen(false)} isOwner={isOwner} />}
      {isAdmin && <PhotoEditor room={room} open={photoOpen} onClose={() => setPhotoOpen(false)} />}
      {isAdmin && <UserPicker open={addOpen} onClose={() => setAddOpen(false)} mode="room" roomId={room.id} />}
    </div>
  );
}
