import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { Ban, BellOff, Check, CheckCheck, Clock, MessageCircle, Phone, PhoneMissed, Pin, SquarePen, Video } from 'lucide-react';
import { listStamp, messagePreview } from '../lib/format';
import type { Conversation } from '../lib/types';
import { useAuth } from '../store/auth';
import { isMuted, ordered, useChat } from '../store/chat';
import { Avatar } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import { ROW_TIME_HIDES, useRowMenu } from './ChatActions';
import { ArchivedBack, ArchivedRow, Fab, ListEmpty, ListHeader, ListSearch, UnreadBadge, listClass, listRowClass } from './ListHeader';
import { UserPicker } from './UserPicker';

export function ChatList() {
  const conversations = useChat((s) => s.conversations);
  const bootstrapped = useChat((s) => s.bootstrapped);
  const [filter, setFilter] = useState('');
  const [picking, setPicking] = useState(false);
  const [archive, setArchive] = useState(false);

  const all = useMemo(() => Object.values(conversations).filter((c) => c.lastMessage || c.clearedAt), [conversations]);
  const archived = all.filter((c) => c.archivedAt);
  // The last one brought back: back to the list.
  useEffect(() => {
    if (archive && !archived.length) setArchive(false);
  }, [archive, archived.length]);
  // Searching looks through archived chats too.
  const f = filter.trim().toLowerCase();
  const showing = f ? 'search' : archive && archived.length ? 'archive' : 'list';
  const list = useMemo(
    () =>
      ordered(
        all.filter((c) => (showing === 'search' ? c.partner.name.toLowerCase().includes(f) : showing === 'archive' ? c.archivedAt : !c.archivedAt)),
        (c) => c.lastMessage?.createdAt ?? c.clearedAt ?? '',
      ),
    [all, f, showing],
  );

  return (
    <>
      <ListHeader
        title="Chats"
        subtitle={all.length ? `${all.length} ${all.length === 1 ? 'conversation' : 'conversations'}` : 'Talk one to one'}
        action={
          <span className="hidden md:flex">
            <IconButton label="Start a new chat" variant="primary" size={42} onClick={() => setPicking(true)}>
              <SquarePen size={18} />
            </IconButton>
          </span>
        }
      />
      {Object.keys(conversations).length > 0 && <ListSearch value={filter} onChange={setFilter} placeholder="Search chats" />}
      <ul className={listClass}>
        {showing === 'list' && archived.length > 0 && (
          <ArchivedRow count={archived.length} unread={archived.filter((c) => c.unread > 0).length} onOpen={() => setArchive(true)} />
        )}
        {showing === 'archive' && <ArchivedBack what="chats" onBack={() => setArchive(false)} />}
        {list.map((c) => (
          <ChatRow key={c.partner.id} conversation={c} />
        ))}
        {bootstrapped && list.length === 0 && showing !== 'archive' && (archived.length === 0 || f) && (
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
      <Fab label="Start a new chat" onClick={() => setPicking(true)}>
        <SquarePen size={22} />
      </Fab>
      <UserPicker open={picking} onClose={() => setPicking(false)} mode="chat" />
    </>
  );
}

function ChatRow({ conversation: c }: { conversation: Conversation }) {
  const { partner, unread } = c;
  const online = useChat((s) => !!s.online[partner.id]);
  const isTyping = useChat((s) => !!s.dmTyping[partner.id]);
  const me = useAuth((s) => s.user);
  const menu = useRowMenu('dm', partner.id, partner.name, c);
  const m = c.lastMessage;
  const mine = m?.senderId === me?.id;
  const muted = isMuted(c);
  return (
    <li className="group relative">
      <NavLink
        to={`/chats/${partner.id}`}
        viewTransition
        {...menu.hold}
        className={({ isActive }) => `${listRowClass(isActive)} select-none [-webkit-touch-callout:none]`}
      >
        <Avatar name={partner.name} hue={partner.hue} photo={partner.photo} size={48} online={online} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate font-semibold">{partner.name}</span>
            {muted && <BellOff size={14} className="shrink-0 self-center text-ink-soft" role="img" aria-label="Muted" />}
            <span className={`ml-auto shrink-0 text-[12px] ${ROW_TIME_HIDES} ${unread && !muted ? 'font-semibold text-brand dark:text-live' : 'text-ink-soft'}`}>{listStamp(m?.createdAt ?? c.clearedAt ?? '')}</span>
          </span>
          <span className="flex items-center gap-2">
            <span className={`flex min-w-0 flex-1 items-center gap-1 truncate text-[14px] ${unread && !muted ? 'font-medium text-ink' : 'text-ink-soft'}`}>
              {isTyping ? (
                <span className="text-brand dark:text-live">typing…</span>
              ) : !m ? (
                <span className="truncate italic">History cleared</span>
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
            {c.pinnedAt && <Pin size={14} className="shrink-0 rotate-45 text-ink-soft" role="img" aria-label="Pinned" />}
            <UnreadBadge count={unread} muted={muted} />
          </span>
        </span>
      </NavLink>
      {menu.extras}
    </li>
  );
}
