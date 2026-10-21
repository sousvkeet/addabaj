import { useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { Ban, Check, CheckCheck, Clock, MessageCircle, Phone, PhoneMissed, SquarePen, Video } from 'lucide-react';
import { listStamp, messagePreview } from '../lib/format';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { Avatar } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import { ListEmpty, ListHeader, ListSearch, UnreadBadge, listRowClass } from './ListHeader';
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
        subtitle={list.length ? `${list.length} ${list.length === 1 ? 'conversation' : 'conversations'}` : 'Talk one to one'}
        action={
          <IconButton label="Start a new chat" variant="primary" size={42} onClick={() => setPicking(true)}>
            <SquarePen size={18} />
          </IconButton>
        }
      />
      {Object.keys(conversations).length > 0 && <ListSearch value={filter} onChange={setFilter} placeholder="Search chats" />}
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
        {list.map(({ partner, lastMessage, unread }) => {
          const m = lastMessage!;
          const mine = m.senderId === me?.id;
          const isTyping = typing[partner.id];
          return (
            <li key={partner.id}>
              <NavLink
                to={`/chats/${partner.id}`}
                className={({ isActive }) => listRowClass(isActive)}
              >
                <Avatar name={partner.name} hue={partner.hue} size={48} online={online[partner.id]} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">{partner.name}</span>
                    <span className={`ml-auto shrink-0 text-[12px] ${unread ? 'font-semibold text-brand dark:text-live' : 'text-ink-soft'}`}>{listStamp(m.createdAt)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`flex min-w-0 flex-1 items-center gap-1 truncate text-[14px] ${unread ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                      {isTyping ? (
                        <span className="text-brand dark:text-live">typing…</span>
                      ) : m.kind === 'call' ? (
                        <>
                          {m.meta?.outcome !== 'completed' ? (
                            <PhoneMissed size={14} className="text-danger" />
                          ) : m.meta?.video ? (
                            <Video size={14} />
                          ) : (
                            <Phone size={14} />
                          )}
                          <span className="truncate">{m.body}</span>
                        </>
                      ) : (
                        <>
                          {/* Where my last message has got to: sending, sent, delivered, read. */}
                          {m.deletedAt ? (
                            <Ban size={14} className="shrink-0" aria-hidden />
                          ) : mine &&
                            (m.pending === 'sending' ? (
                              <Clock size={14} className="shrink-0" aria-label="Sending" />
                            ) : m.readAt ? (
                              <CheckCheck size={15} className="shrink-0 text-live-ink" aria-label="Read" />
                            ) : m.deliveredAt ? (
                              <CheckCheck size={15} className="shrink-0" aria-label="Delivered" />
                            ) : m.pending !== 'failed' ? (
                              <Check size={14} className="shrink-0" aria-label="Sent" />
                            ) : null)}
                          <span className={`truncate ${m.deletedAt ? 'italic' : ''}`}>{messagePreview(m, mine)}</span>
                        </>
                      )}
                    </span>
                    <UnreadBadge count={unread} />
                  </span>
                </span>
              </NavLink>
            </li>
          );
        })}
        {bootstrapped && list.length === 0 && (
          <ListEmpty icon={<MessageCircle size={22} />} title={filter ? 'No chats match that name' : 'No chats yet'}>
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
