import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Phone, PhoneOff, Settings2, Video } from 'lucide-react';
import { lastSeen } from '../lib/format';
import { socket } from '../lib/socket';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { useUi } from '../store/ui';
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
  const openDevices = useUi((s) => s.setDevicesOpen);
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
        callVideo: !!m.meta?.video,
      })),
    [page?.items, me?.id],
  );

  if (userId === me?.id) return <Navigate to="/chats" replace />;

  const name = partner?.name ?? '…';
  const onCallWithThem = callPhase !== 'idle' && callPeer === userId;
  const call = (video = false) => partner && void startCall({ id: partner.id, name: partner.name, hue: partner.hue }, { video });

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
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openDevices(true)} aria-label="Microphone, speaker and camera">
              <Settings2 size={16} />
              <span className="hidden sm:inline">Devices</span>
            </Button>
            <Button variant="danger" size="sm" onClick={endCall} aria-label="End call">
              <PhoneOff size={16} />
              <span className="hidden sm:inline">End call</span>
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="live" size="sm" onClick={() => call(false)} disabled={!partner || callPhase !== 'idle'} aria-label={`Voice call ${name}`}>
              <Phone size={16} />
              <span className="hidden sm:inline">Voice</span>
            </Button>
            <Button variant="live" size="sm" onClick={() => call(true)} disabled={!partner || callPhase !== 'idle'} aria-label={`Video call ${name}`}>
              <Video size={17} />
              <span className="hidden sm:inline">Video</span>
            </Button>
          </div>
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
        onCallBack={callPhase === 'idle' ? (video) => call(video) : undefined}
        empty={
          <div className="mx-auto max-w-sm py-16 text-center">
            {partner && <Avatar name={partner.name} hue={partner.hue} size={72} className="mx-auto" />}
            <p className="mt-4 font-display text-[22px]">Say hello to {name}</p>
            <p className="mt-1 text-[14px] text-ink-soft">Messages arrive instantly. Use the buttons above for a voice or video call.</p>
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
