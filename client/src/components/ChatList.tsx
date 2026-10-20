import { useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { PhoneMissed, Phone, SquarePen, Video } from 'lucide-react';
import { listStamp } from '../lib/format';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { Avatar } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import { ListEmpty, ListHeader, ListSearch } from './ListHeader';
import { UserPicker } from './UserPicker';

export function ChatList() {
  const conversations = useChat((s) => s.conversations);
  const online = useChat((s) => s.online);
  const typing = useChat((s) => s.dmTyping);
  const bootstrapped = useChat((s) => s.bootstrapped);
  const me = useAuth((s) => s.user);
  const [filter, setFilter] = useState('');
  const [picking, setPicking] = useState(false);

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return Object.values(conversations)
      .filter((c) => c.lastMessage && (!f || c.partner.name.toLowerCase().includes(f)))
      .sort((a, b) => (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0));
  }, [conversations, filter]);

  return (
    <>
      <ListHeader
        title="Chats"
        action={
          <IconButton label="Start a new chat" variant="primary" size={38} onClick={() => setPicking(true)}>
            <SquarePen size={18} />
          </IconButton>
        }
      />
      {Object.keys(conversations).length > 0 && <ListSearch value={filter} onChange={setFilter} placeholder="Search chats" />}
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {list.map(({ partner, lastMessage, unread }) => {
          const m = lastMessage!;
          const mine = m.senderId === me?.id;
          const isTyping = typing[partner.id];
          return (
            <li key={partner.id}>
              <NavLink
                to={`/chats/${partner.id}`}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors ${isActive ? 'bg-paper' : 'hover:bg-paper/50'}`
                }
              >
                <Avatar name={partner.name} hue={partner.hue} size={46} online={online[partner.id]} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">{partner.name}</span>
                    <span className="ml-auto shrink-0 text-[12px] text-ink-soft">{listStamp(m.createdAt)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`flex min-w-0 flex-1 items-center gap-1 truncate text-[14px] ${unread ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                      {isTyping ? (
                        <span className="text-shutter dark:text-taxi">typing…</span>
                      ) : m.kind === 'call' ? (
                        <>
                          {m.meta?.outcome !== 'completed' ? (
                            <PhoneMissed size={14} className="text-oxide" />
                          ) : m.meta?.video ? (
                            <Video size={14} />
                          ) : (
                            <Phone size={14} />
                          )}
                          <span className="truncate">{m.body}</span>
                        </>
                      ) : (
                        <span className="truncate">
                          {mine && 'You: '}
                          {m.body}
                        </span>
                      )}
                    </span>
                    {unread > 0 && (
                      <span className="min-w-[20px] rounded-full bg-taxi px-1.5 text-center text-[12px] leading-5 font-bold text-on-taxi">
                        {unread}
                      </span>
                    )}
                  </span>
                </span>
              </NavLink>
            </li>
          );
        })}
        {bootstrapped && list.length === 0 && (
          <ListEmpty title={filter ? 'No chats match that name' : 'No chats yet'}>
            {!filter && (
              <>
                <p>Find someone on Adda Khana and say hello. Your conversations will show up here.</p>
                <Button size="sm" onClick={() => setPicking(true)}>
                  Find people
                </Button>
              </>
            )}
          </ListEmpty>
        )}
      </ul>
      <UserPicker open={picking} onClose={() => setPicking(false)} mode="chat" />
    </>
  );
}
