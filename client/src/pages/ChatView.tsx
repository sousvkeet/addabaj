import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Phone, PhoneOff, Settings2, Video } from 'lucide-react';
import { lastSeen } from '../lib/format';
import type { ReplyRef } from '../lib/types';
import { socket } from '../lib/socket';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { useUi } from '../store/ui';
import { Avatar } from '../components/ui/Avatar';
import { Button, IconButton } from '../components/ui/Button';
import { Composer, type ComposerHandle } from '../components/Composer';
import { FileDrop } from '../components/FileDrop';
import { MessageList, replyRefFor, type ThreadItem } from '../components/MessageList';

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
  const react = useChat((s) => s.react);
  const callPhase = useCall((s) => s.phase);
  const callPeer = useCall((s) => s.peer?.id);
  const startCall = useCall((s) => s.startCall);
  const endCall = useCall((s) => s.endCall);
  const openDevices = useUi((s) => s.setDevicesOpen);
  const navigate = useNavigate();
  const composer = useRef<ComposerHandle>(null);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);

  useEffect(() => {
    openDm(userId);
    setReplyTo(null);
    return () => openDm(null);
  }, [userId, openDm]);

  const items = useMemo<ThreadItem[]>(
    () =>
      (page?.items ?? []).map((m) => {
        const mine = m.senderId === me?.id;
        const who = mine ? me : partner;
        return {
          key: m.tempId ?? String(m.id),
          id: m.id,
          mine,
          kind: m.kind,
          body: m.body,
          createdAt: m.createdAt,
          sender: who ? { id: who.id, name: who.name, hue: who.hue } : null,
          readAt: m.readAt,
          pending: m.pending,
          callOutcome: m.meta?.outcome,
          callDuration: m.meta?.duration,
          callVideo: !!m.meta?.video,
          attachment: m.attachment,
          replyTo: m.replyTo,
          reactions: m.reactions,
          upload: m.upload,
          draft: m.draft,
        };
      }),
    [page?.items, me, partner],
  );

  if (userId === me?.id) return <Navigate to="/chats" replace />;

  const name = partner?.name ?? '…';
  const onCallWithThem = callPhase !== 'idle' && callPeer === userId;
  const call = (video = false) => partner && void startCall({ id: partner.id, name: partner.name, hue: partner.hue }, { video });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="glass relative z-10 flex h-[72px] shrink-0 items-center gap-3 border-b border-line/70 px-2 pt-[env(safe-area-inset-top)] md:px-5">
        <IconButton label="Back to chats" className="md:hidden" onClick={() => navigate('/chats')}>
          <ArrowLeft size={20} />
        </IconButton>
        {partner && <Avatar name={partner.name} hue={partner.hue} size={44} online={online} />}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[18px] leading-tight font-semibold tracking-[-0.01em]">{name}</h1>
          <p className="truncate text-[13px] text-ink-soft">
            {typing ? (
              <span className="font-medium text-brand dark:text-live">typing…</span>
            ) : online ? (
              <span className="font-medium text-cyan-600 dark:text-live">Online</span>
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
            <Button variant="soft" size="sm" onClick={() => call(false)} disabled={!partner || callPhase !== 'idle'} aria-label={`Voice call ${name}`}>
              <Phone size={16} className="text-brand dark:text-live" />
              <span className="hidden sm:inline">Voice</span>
            </Button>
            <Button variant="primary" size="sm" onClick={() => call(true)} disabled={!partner || callPhase !== 'idle'} aria-label={`Video call ${name}`}>
              <Video size={17} />
              <span className="hidden sm:inline">Video</span>
            </Button>
          </div>
        )}
      </header>

      <FileDrop className="flex min-h-0 flex-1 flex-col" onFiles={(files) => composer.current?.addFiles(files)}>
        <MessageList
          key={`thread-${userId}`}
          items={items}
          loaded={!!page?.loaded}
          hasMore={!!page?.hasMore}
          loadingMore={page?.loadingMore}
          onLoadOlder={() => void loadDm(userId, true)}
          receipts
          meId={me?.id ?? ''}
          onRetry={(item) => void sendDm(userId, item.draft ?? { body: item.body }, item.key)}
          onReply={(item) => setReplyTo(replyRefFor(item))}
          onReact={(item, emoji) => void react('dm', item.id, emoji)}
          onCallBack={callPhase === 'idle' ? (video) => call(video) : undefined}
          empty={
            <div className="mx-auto max-w-sm py-16 text-center">
              {partner && (
                <span className="relative mx-auto block w-fit">
                  <span aria-hidden className="absolute inset-0 rounded-full bg-aurora opacity-50 blur-xl" />
                  <Avatar name={partner.name} hue={partner.hue} size={84} className="relative" />
                </span>
              )}
              <p className="mt-5 font-display text-[22px] font-semibold">Say hello to {name}</p>
              <p className="mt-1 text-[14px] text-ink-soft">Messages arrive instantly. Use the buttons above for a voice or video call.</p>
            </div>
          }
        />
        <Composer
          ref={composer}
          key={`composer-${userId}`}
          placeholder={`Message ${name.split(' ')[0]}`}
          onSend={(draft) => void sendDm(userId, draft)}
          onTyping={(t) => socket.emit('dm:typing', { to: userId, typing: t })}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
        />
      </FileDrop>
    </div>
  );
}
