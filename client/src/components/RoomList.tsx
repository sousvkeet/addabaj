import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { AtSign, AudioLines, BellOff, KeyRound, MonitorPlay, Pin, Plus, Users, Video } from 'lucide-react';
import { deletedText, listStamp, messagePreview } from '../lib/format';
import type { RoomSummary } from '../lib/types';
import { useAuth } from '../store/auth';
import { isMuted, ordered, useChat } from '../store/chat';
import { Avatar, hueFromId } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import { ROW_TIME_HIDES, useRowMenu } from './ChatActions';
import { ArchivedBack, ArchivedRow, Fab, ListEmpty, ListHeader, ListSearch, UnreadBadge, listClass, listRowClass } from './ListHeader';
import { CreateRoomDialog } from './CreateRoomDialog';
import { JoinRoomDialog } from './JoinRoomDialog';

export function RoomList() {
  const rooms = useChat((s) => s.rooms);
  const bootstrapped = useChat((s) => s.bootstrapped);
  const [filter, setFilter] = useState('');
  const [archive, setArchive] = useState(false);
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
    // Forget the link's code (so it doesn't open again), unless joining already went on to the room.
    if (linkCode && window.location.pathname === location.pathname) navigate(location.pathname, { replace: true, state: null });
  };

  const all = useMemo(() => Object.values(rooms), [rooms]);
  const archived = all.filter((r) => r.archivedAt);
  // The last one brought back: back to the list.
  useEffect(() => {
    if (archive && !archived.length) setArchive(false);
  }, [archive, archived.length]);
  // Searching looks through archived rooms too.
  const f = filter.trim().toLowerCase();
  const showing = f ? 'search' : archive && archived.length ? 'archive' : 'list';
  const list = useMemo(
    () =>
      ordered(
        all.filter((r) => (showing === 'search' ? r.name.toLowerCase().includes(f) : showing === 'archive' ? r.archivedAt : !r.archivedAt)),
        (r) => r.lastMessage?.createdAt ?? r.createdAt,
      ),
    [all, f, showing],
  );

  return (
    <>
      <ListHeader
        title="Rooms"
        subtitle={all.length ? `${all.length} ${all.length === 1 ? 'room' : 'rooms'}` : 'Hang out together'}
        action={
          <span className="flex gap-2">
            <IconButton label="Join a room with a code" variant="soft" size={42} onClick={() => setJoining(true)}>
              <KeyRound size={19} />
            </IconButton>
            <span className="hidden md:flex">
              <IconButton label="Start a room" variant="primary" size={42} onClick={() => setCreating(true)}>
                <Plus size={20} />
              </IconButton>
            </span>
          </span>
        }
      />
      {Object.keys(rooms).length > 0 && <ListSearch value={filter} onChange={setFilter} placeholder="Search rooms" />}
      <ul className={listClass}>
        {showing === 'list' && archived.length > 0 && (
          <ArchivedRow count={archived.length} unread={archived.filter((r) => r.unread > 0).length} onOpen={() => setArchive(true)} />
        )}
        {showing === 'archive' && <ArchivedBack what="rooms" onBack={() => setArchive(false)} />}
        {list.map((room) => (
          <RoomRow key={room.id} room={room} />
        ))}
        {bootstrapped && list.length === 0 && showing !== 'archive' && (archived.length === 0 || f) && (
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
      <Fab label="Start a room" onClick={() => setCreating(true)}>
        <Plus size={24} />
      </Fab>
      <CreateRoomDialog open={creating} onClose={() => setCreating(false)} />
      <JoinRoomDialog open={joining} onClose={closeJoin} code={linkCode} />
    </>
  );
}

function RoomRow({ room }: { room: RoomSummary }) {
  const voice = useChat((s) => s.voice[room.id]);
  const me = useAuth((s) => s.user);
  const menu = useRowMenu('room', room.id, room.name, room);
  const m = room.lastMessage;
  const talking = voice?.length ?? 0;
  const onCamera = voice?.some((p) => p.camera) ?? false;
  const muted = isMuted(room);
  const forMe = room.unreadMentions ?? 0;
  // A muted room only stands out for messages that mention me or reply to me.
  const loud = room.unread > 0 && (!muted || forMe > 0);
  const sender = m?.kind === 'text' && !m.deletedAt ? (m.sender?.id === me?.id ? 'You' : m.sender?.name.split(' ')[0]) : null;
  return (
    <li className="group relative">
      <NavLink
        to={`/rooms/${room.id}`}
        viewTransition
        {...menu.hold}
        className={({ isActive }) => `${listRowClass(isActive)} select-none [-webkit-touch-callout:none]`}
      >
        <Avatar name={room.name} hue={hueFromId(room.id)} photo={room.photo} size={48} square />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate font-semibold">{room.name}</span>
            {muted && <BellOff size={14} className="shrink-0 self-center text-ink-soft" role="img" aria-label="Muted" />}
            {m && (
              <span className={`ml-auto shrink-0 text-[12px] ${ROW_TIME_HIDES} ${loud ? 'font-semibold text-brand dark:text-live' : 'text-ink-soft'}`}>
                {listStamp(m.createdAt)}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className={`min-w-0 flex-1 truncate text-[14px] ${loud ? 'font-medium text-ink' : 'text-ink-soft'}`}>
              {m
                ? m.deletedAt
                  ? deletedText(m.sender?.id === me?.id, m.deletedByAdmin)
                  : sender
                    ? `${sender}: ${messagePreview(m)}`
                    : m.body
                : room.description || 'No messages yet'}
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
                title={`${talking} in voice${onCamera ? ', cameras on' : ''}`}
              >
                {onCamera ? <Video size={12} /> : <AudioLines size={12} />}
                {talking}
              </span>
            )}
            {room.pinnedAt && <Pin size={14} className="shrink-0 rotate-45 text-ink-soft" role="img" aria-label="Pinned" />}
            {forMe > 0 && (
              <span
                className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-aurora text-white shadow-glow"
                title={`${forMe} ${forMe === 1 ? 'message mentions' : 'messages mention'} you or ${forMe === 1 ? 'replies' : 'reply'} to you`}
              >
                <AtSign size={13} strokeWidth={2.75} aria-hidden />
                <span className="sr-only">Mentions you</span>
              </span>
            )}
            <UnreadBadge count={room.unread} muted={muted} />
          </span>
        </span>
      </NavLink>
      {menu.extras}
    </li>
  );
}
