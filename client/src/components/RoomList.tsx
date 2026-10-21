import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { AudioLines, KeyRound, MonitorPlay, Plus, Users } from 'lucide-react';
import { listStamp, messagePreview } from '../lib/format';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { Avatar, hueFromId } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import { ListEmpty, ListHeader, ListSearch, UnreadBadge, listRowClass } from './ListHeader';
import { CreateRoomDialog } from './CreateRoomDialog';
import { JoinRoomDialog } from './JoinRoomDialog';

export function RoomList() {
  const rooms = useChat((s) => s.rooms);
  const voice = useChat((s) => s.voice);
  const bootstrapped = useChat((s) => s.bootstrapped);
  const me = useAuth((s) => s.user);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  // A /join link (see JoinLink in App.tsx) opens the join dialog with its code.
  const location = useLocation();
  const navigate = useNavigate();
  const linkCode = (location.state as { joinCode?: string } | null)?.joinCode ?? '';
  useEffect(() => {
    if (linkCode) setJoining(true);
  }, [linkCode]);
  const closeJoin = () => {
    setJoining(false);
    if (linkCode) navigate(location.pathname, { replace: true, state: null });
  };

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return Object.values(rooms)
      .filter((r) => !f || r.name.toLowerCase().includes(f))
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt).localeCompare(a.lastMessage?.createdAt ?? a.createdAt));
  }, [rooms, filter]);

  return (
    <>
      <ListHeader
        title="Rooms"
        subtitle={list.length ? `${list.length} ${list.length === 1 ? 'room' : 'rooms'}` : 'Hang out together'}
        action={
          <span className="flex gap-2">
            <IconButton label="Join a room with a code" variant="soft" size={42} onClick={() => setJoining(true)}>
              <KeyRound size={19} />
            </IconButton>
            <IconButton label="Start a room" variant="primary" size={42} onClick={() => setCreating(true)}>
              <Plus size={20} />
            </IconButton>
          </span>
        }
      />
      {Object.keys(rooms).length > 0 && <ListSearch value={filter} onChange={setFilter} placeholder="Search rooms" />}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
        {list.map((room) => {
          const m = room.lastMessage;
          const talking = voice[room.id]?.length ?? 0;
          const sender = m?.kind === 'text' ? (m.sender?.id === me?.id ? 'You' : m.sender?.name.split(' ')[0]) : null;
          return (
            <li key={room.id}>
              <NavLink
                to={`/rooms/${room.id}`}
                className={({ isActive }) => listRowClass(isActive)}
              >
                <Avatar name={room.name} hue={hueFromId(room.id)} size={48} square />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">{room.name}</span>
                    {m && (
                      <span className={`ml-auto shrink-0 text-[12px] ${room.unread ? 'font-semibold text-brand dark:text-live' : 'text-ink-soft'}`}>
                        {listStamp(m.createdAt)}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[14px] ${room.unread ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                      {m ? (sender ? `${sender}: ${messagePreview(m)}` : m.body) : room.description || 'No messages yet'}
                    </span>
                    {room.watching && (
                      <span className="inline-flex items-center rounded-full bg-brand-2/15 px-1.5 leading-5 text-brand-2" title={`Watching ${room.watching}`}>
                        <MonitorPlay size={12} />
                        <span className="sr-only">Watching {room.watching}</span>
                      </span>
                    )}
                    {talking > 0 && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-live/15 px-1.5 text-[12px] leading-5 font-semibold text-live-ink"
                        title={`${talking} in voice`}
                      >
                        <AudioLines size={12} />
                        {talking}
                      </span>
                    )}
                    <UnreadBadge count={room.unread} />
                  </span>
                </span>
              </NavLink>
            </li>
          );
        })}
        {bootstrapped && list.length === 0 && (
          <ListEmpty icon={<Users size={22} />} title={filter ? 'No rooms match that name' : 'No rooms yet'}>
            {!filter && (
              <>
                <p>Start a room for your friends, or join one with the invite code someone shared with you.</p>
                <span className="flex flex-wrap justify-center gap-2">
                  <Button size="sm" onClick={() => setCreating(true)}>
                    Start a room
                  </Button>
                  <Button size="sm" variant="soft" onClick={() => setJoining(true)}>
                    Join with a code
                  </Button>
                </span>
              </>
            )}
          </ListEmpty>
        )}
      </ul>
      <CreateRoomDialog open={creating} onClose={() => setCreating(false)} />
      <JoinRoomDialog open={joining} onClose={closeJoin} code={linkCode} />
    </>
  );
}
