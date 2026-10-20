import { useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { AudioLines, MonitorPlay, Plus } from 'lucide-react';
import { listStamp } from '../lib/format';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { Avatar, hueFromId } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import { ListEmpty, ListHeader, ListSearch } from './ListHeader';
import { CreateRoomDialog } from './CreateRoomDialog';

export function RoomList() {
  const rooms = useChat((s) => s.rooms);
  const voice = useChat((s) => s.voice);
  const bootstrapped = useChat((s) => s.bootstrapped);
  const me = useAuth((s) => s.user);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

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
        action={
          <IconButton label="Start a room" variant="primary" size={38} onClick={() => setCreating(true)}>
            <Plus size={20} />
          </IconButton>
        }
      />
      {Object.keys(rooms).length > 0 && <ListSearch value={filter} onChange={setFilter} placeholder="Search rooms" />}
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {list.map((room) => {
          const m = room.lastMessage;
          const talking = voice[room.id]?.length ?? 0;
          const sender = m?.kind === 'text' ? (m.sender?.id === me?.id ? 'You' : m.sender?.name.split(' ')[0]) : null;
          return (
            <li key={room.id}>
              <NavLink
                to={`/rooms/${room.id}`}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors ${isActive ? 'bg-paper' : 'hover:bg-paper/50'}`
                }
              >
                <Avatar name={room.name} hue={hueFromId(room.id)} size={46} square />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">{room.name}</span>
                    {m && <span className="ml-auto shrink-0 text-[12px] text-ink-soft">{listStamp(m.createdAt)}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[14px] ${room.unread ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                      {m ? (sender ? `${sender}: ${m.body}` : m.body) : room.description || 'No messages yet'}
                    </span>
                    {room.watching && (
                      <span className="inline-flex items-center rounded-full bg-shutter px-1.5 leading-5 text-taxi" title={`Watching ${room.watching}`}>
                        <MonitorPlay size={12} />
                        <span className="sr-only">Watching {room.watching}</span>
                      </span>
                    )}
                    {talking > 0 && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-shutter px-1.5 text-[12px] leading-5 font-semibold text-taxi"
                        title={`${talking} in voice`}
                      >
                        <AudioLines size={12} />
                        {talking}
                      </span>
                    )}
                    {room.unread > 0 && (
                      <span className="min-w-[20px] rounded-full bg-taxi px-1.5 text-center text-[12px] leading-5 font-bold text-on-taxi">
                        {room.unread}
                      </span>
                    )}
                  </span>
                </span>
              </NavLink>
            </li>
          );
        })}
        {bootstrapped && list.length === 0 && (
          <ListEmpty title={filter ? 'No rooms match that name' : 'No rooms yet'}>
            {!filter && (
              <>
                <p>Start a room for your friends, choose how many people it holds, then add or invite them.</p>
                <Button size="sm" onClick={() => setCreating(true)}>
                  Start a room
                </Button>
              </>
            )}
          </ListEmpty>
        )}
      </ul>
      <CreateRoomDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
