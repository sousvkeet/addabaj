import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Phone, PhoneOff } from 'lucide-react';
import { lastSeen } from '../lib/format';
import { socket } from '../lib/socket';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { Avatar } from '../components/ui/Avatar';
import { Button, IconButton } from '../components/ui/Button';
import { Composer } from '../components/Composer';
import { MessageList, type ThreadItem } from '../components/MessageList';

export function ChatView() {
  const { userId = '' } = useParams();
  const me = useAuth((s) => s.user);
  const partner = useChat((s) => s.users[userId] ?? s.conversations[userId]?.partner);
  const page = useChat((s) => s.dms[userId]);
  const online = useChat((s) => !!s.online[userId]);
  const seen = useChat((s) => s.lastSeen[userId]);
  const typing = useChat((s) => !!s.dmTyping[userId]);
  const openDm = useChat((s) => s.openDm);
  const loadDm = useChat((s) => s.loadDm);
  const sendDm = useChat((s) => s.sendDm);
  const callPhase = useCall((s) => s.phase);
  const callPeer = useCall((s) => s.peer?.id);
  const startCall = useCall((s) => s.startCall);
  const endCall = useCall((s) => s.endCall);
  const navigate = useNavigate();

  useEffect(() => {
    openDm(userId);
    return () => openDm(null);
  }, [userId, openDm]);

  const items = useMemo<ThreadItem[]>(
    () =>
      (page?.items ?? []).map((m) => ({
        key: m.tempId ?? String(m.id),
        mine: m.senderId === me?.id,
        kind: m.kind,
        body: m.body,
        createdAt: m.createdAt,
        readAt: m.readAt,
        pending: m.pending,
        callOutcome: m.meta?.outcome,
        callDuration: m.meta?.duration,
      })),
    [page?.items, me?.id],
  );

  if (userId === me?.id) return <Navigate to="/chats" replace />;

  const name = partner?.name ?? '…';
  const onCallWithThem = callPhase !== 'idle' && callPeer === userId;
  const call = () => partner && void startCall({ id: partner.id, name: partner.name, hue: partner.hue });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-paper px-2 md:px-5">
        <IconButton label="Back to chats" className="md:hidden" onClick={() => navigate('/chats')}>
          <ArrowLeft size={20} />
        </IconButton>
        {partner && <Avatar name={partner.name} hue={partner.hue} size={40} online={online} />}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[20px] leading-tight">{name}</h1>
          <p className="truncate text-[13px] text-ink-soft">
            {typing ? (
              <span className="text-shutter dark:text-taxi">typing…</span>
            ) : online ? (
              'Online'
            ) : (
              lastSeen(seen ?? partner?.lastSeenAt ?? null)
            )}
          </p>
        </div>
        {onCallWithThem ? (
          <Button variant="danger" size="sm" onClick={endCall} aria-label="End call">
            <PhoneOff size={16} />
            <span className="hidden sm:inline">End call</span>
          </Button>
        ) : (
          <Button variant="live" size="sm" onClick={call} disabled={!partner || callPhase !== 'idle'} aria-label={`Call ${name}`}>
            <Phone size={16} />
            <span className="hidden sm:inline">Call</span>
          </Button>
        )}
      </header>

      <MessageList
        key={`thread-${userId}`}
        items={items}
        loaded={!!page?.loaded}
        hasMore={!!page?.hasMore}
        loadingMore={page?.loadingMore}
        onLoadOlder={() => void loadDm(userId, true)}
        receipts
        onRetry={(item) => void sendDm(userId, item.body, item.key)}
        onCallBack={callPhase === 'idle' ? call : undefined}
        empty={
          <div className="mx-auto max-w-sm py-16 text-center">
            {partner && <Avatar name={partner.name} hue={partner.hue} size={72} className="mx-auto" />}
            <p className="mt-4 font-display text-[22px]">Say hello to {name}</p>
            <p className="mt-1 text-[14px] text-ink-soft">Messages arrive instantly. Use the call button above to talk by voice.</p>
          </div>
        }
      />
      <Composer
        key={`composer-${userId}`}
        placeholder={`Message ${name.split(' ')[0]}`}
        onSend={(body) => void sendDm(userId, body)}
        onTyping={(t) => socket.emit('dm:typing', { to: userId, typing: t })}
      />
    </div>
  );
}
