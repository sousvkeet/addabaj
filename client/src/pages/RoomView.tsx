import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ArrowLeft, AudioLines, Headphones, LoaderCircle, MonitorPlay, Users } from 'lucide-react';
import { socket } from '../lib/socket';
import { useMedia } from '../lib/useMedia';
import type { Receipt, ReplyRef, RoomMember, VoiceParticipant } from '../lib/types';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { useVoice } from '../store/voice';
import { Avatar, hueFromId } from '../components/ui/Avatar';
import { Button, IconButton } from '../components/ui/Button';
import { Composer, type ComposerHandle } from '../components/Composer';
import { FileDrop } from '../components/FileDrop';
import { MessageList, TypingLine, recentEnoughToDelete, replyRefFor, type ThreadItem } from '../components/MessageList';
import { MessageInfo, type InfoTarget } from '../components/MessageInfo';
import { RoomPanel } from '../components/RoomPanel';
import { WatchDialog } from '../components/watch/WatchStage';
import { WatchSlot } from '../components/watch/WatchDock';
import { goBack } from '../lib/screens';
import { StatusLine } from '../components/ConnectionNotice';

const EMPTY: VoiceParticipant[] = [];

/** "Seen by Rahul and Mitali", "Seen by Rahul, Mitali and 3 others", "Seen by everyone". */
function seenText(readers: RoomMember[], audience: number) {
  if (!readers.length) return undefined;
  if (readers.length === audience && audience > 2) return 'Seen by everyone';
  const names = readers.map((r) => r.name.split(' ')[0]);
  if (names.length <= 2) return `Seen by ${names.join(' and ')}`;
  return `Seen by ${names.slice(0, 2).join(', ')} and ${names.length - 2} ${names.length - 2 === 1 ? 'other' : 'others'}`;
}

function typingText(names: string[]) {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names.length} people are typing`;
}

/** Phones: header buttons as plain icons, as in other messengers (wider screens keep the labelled buttons). */
const phoneIcon = 'ripple max-md:size-11 max-md:rounded-full max-md:bg-transparent max-md:px-0 max-md:shadow-none';

export function RoomView() {
  const { roomId = '' } = useParams();
  const me = useAuth((s) => s.user);
  const room = useChat((s) => s.rooms[roomId]);
  const detail = useChat((s) => s.roomDetails[roomId]);
  const page = useChat((s) => s.roomMessages[roomId]);
  const typing = useChat((s) => s.roomTyping[roomId]);
  const voiceList = useChat((s) => s.voice[roomId] ?? EMPTY);
  const bootstrapped = useChat((s) => s.bootstrapped);
  const openRoom = useChat((s) => s.openRoom);
  const loadRoomMessages = useChat((s) => s.loadRoomMessages);
  const sendRoomMessage = useChat((s) => s.sendRoomMessage);
  const react = useChat((s) => s.react);
  const deleteMessage = useChat((s) => s.deleteMessage);
  const voiceRoom = useVoice((s) => s.roomId);
  const voiceStatus = useVoice((s) => s.status);
  const joinVoice = useVoice((s) => s.join);
  const inCall = useCall((s) => s.phase !== 'idle');
  const wide = useMedia('(min-width: 1280px)');
  const navigate = useNavigate();
  const location = useLocation();
  // Room info is a page of its own on phones (#info), so Android's back closes it rather than the room.
  const panelOpen = !wide && location.hash === '#info';
  const setPanelOpen = (open: boolean) => {
    if (open && !panelOpen) void navigate({ hash: 'info' });
    else if (!open && panelOpen) {
      if (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0) void navigate(-1);
      else void navigate({ hash: '' }, { replace: true });
    }
  };
  const [addOpen, setAddOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const composer = useRef<ComposerHandle>(null);

  useEffect(() => {
    openRoom(roomId);
    setReplyTo(null);
    return () => openRoom(null);
  }, [roomId, openRoom]);

  // Right after creating a room, jump straight into adding people.
  useEffect(() => {
    if ((location.state as { addPeople?: boolean } | null)?.addPeople && detail) {
      setAddOpen(true);
      navigate({ pathname: location.pathname, hash: wide ? '' : 'info' }, { replace: true, state: null });
    }
  }, [location.state, location.pathname, detail, wide, navigate]);

  const members = detail?.members;
  const isRoomAdmin = (detail ?? room)?.myRole === 'admin';
  const items = useMemo<ThreadItem[]>(() => {
    const list = page?.items ?? [];
    const others = (members ?? []).filter((x) => x.id !== me?.id);
    const isMine = (m: (typeof list)[number]) => m.sender?.id === me?.id && m.kind === 'text';
    const latestMine = list.reduce((id, m) => (isMine(m) && !m.pending && m.id > id ? m.id : id), 0);
    return list.map((m) => {
      const mine = isMine(m);
      let receipt: Receipt | undefined;
      let seenBy: string | undefined;
      if (mine && m.id > 0) {
        // Who was in the room when it was sent: delivered / read once all of them have it / saw it.
        const audience = others.filter((o) => new Date(o.joinedAt).getTime() <= new Date(m.createdAt).getTime());
        const readers = audience.filter((o) => o.lastReadId >= m.id);
        receipt = !audience.length ? 'sent' : readers.length === audience.length ? 'read' : audience.every((o) => o.lastDeliveredId >= m.id) ? 'delivered' : 'sent';
        if (m.id === latestMine) seenBy = seenText(readers, audience.length);
      }
      return {
        key: m.tempId ?? String(m.id),
        id: m.id,
        mine,
        kind: m.kind,
        body: m.body,
        createdAt: m.createdAt,
        sender: m.sender,
        pending: m.pending,
        receipt,
        seenBy,
        attachment: m.attachment,
        replyTo: m.replyTo,
        reactions: m.reactions,
        upload: m.upload,
        draft: m.draft,
        deleted: !!m.deletedAt,
        deletedByAdmin: !!m.deletedByAdmin,
        // My own recent messages; room admins can delete anyone's.
        canDeleteForEveryone: m.kind === 'text' && m.id > 0 && !m.deletedAt && (isRoomAdmin || (mine && recentEnoughToDelete(m.createdAt))),
      };
    });
  }, [page?.items, me?.id, members, isRoomAdmin]);

  // A message taken back while it's being replied to: the reply goes too.
  useEffect(() => {
    if (replyTo && items.some((m) => m.id === replyTo.id && m.deleted)) setReplyTo(null);
  }, [items, replyTo]);

  if (!room) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        {bootstrapped ? (
          <>
            <p className="font-display text-[22px]">This room isn't available</p>
            <p className="max-w-sm text-[14px] text-ink-soft">It may have been deleted, or you're no longer a member.</p>
            <Link to="/rooms" className="font-semibold text-brand hover:underline dark:text-live">
              Back to your rooms
            </Link>
          </>
        ) : (
          <LoaderCircle className="animate-spin text-ink-soft" />
        )}
      </div>
    );
  }

  const liveHere = voiceRoom === roomId && voiceStatus !== 'idle';
  const typingNames = Object.values(typing ?? {}).map((n) => n.split(' ')[0]);
  const panel = detail && (
    <RoomPanel room={detail} addOpen={addOpen} setAddOpen={setAddOpen} onClose={wide ? undefined : () => setPanelOpen(false)} />
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass relative z-10 flex h-[64px] shrink-0 items-center gap-2.5 border-b border-line/70 px-1.5 pt-[var(--safe-top)] md:h-[72px] md:gap-3 md:px-5">
          <IconButton label="Back to rooms" className="ripple md:hidden" onClick={() => goBack(navigate, '/rooms')}>
            <ArrowLeft size={20} />
          </IconButton>
          <span className="md:hidden">
            <Avatar name={room.name} hue={hueFromId(room.id)} photo={room.photo} size={40} square />
          </span>
          <span className="hidden md:block">
            <Avatar name={room.name} hue={hueFromId(room.id)} photo={room.photo} size={44} square />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-[18px] leading-tight font-semibold tracking-[-0.01em]">{room.name}</h1>
            <p className="flex items-center gap-2 truncate text-[13px] text-ink-soft">
              <StatusLine>
                <span className="truncate">
                  {room.memberCount}
                  <span className="hidden sm:inline"> of {room.maxMembers}</span> members
                </span>
                {voiceList.length > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-live/15 px-2 leading-5 font-semibold text-live-ink">
                    <AudioLines size={12} />
                    {voiceList.length} in voice
                  </span>
                )}
              </StatusLine>
            </p>
          </div>
          {!liveHere && (
            <Button
              variant="live"
              size="sm"
              onClick={() => void joinVoice(roomId)}
              disabled={inCall}
              aria-label="Join voice"
              title={inCall ? 'End your call to join voice' : 'Join the room’s voice chat'}
              className="ripple max-md:h-8 max-md:rounded-full max-md:px-3.5"
            >
              <Headphones size={16} />
              {/* A word, not just an icon: what it does is clear at a glance. */}
              <span className="sm:hidden">Join</span>
              <span className="hidden sm:inline">Join voice</span>
            </Button>
          )}
          {room.myRole === 'admin' && (
            <Button variant="soft" size="sm" onClick={() => setWatchOpen(true)} aria-label="Watch together" className={`${phoneIcon} max-md:text-ink`}>
              <MonitorPlay size={16} className="max-md:size-[21px]" />
              <span className="hidden lg:inline">Watch</span>
            </Button>
          )}
          {!wide && (
            <IconButton label="Members and voice" variant="soft" size={44} className="ripple max-md:bg-transparent" onClick={() => setPanelOpen(true)}>
              <Users size={20} />
            </IconButton>
          )}
        </header>

        {detail?.watch && <WatchSlot roomId={detail.id} onChange={() => setWatchOpen(true)} />}

        <FileDrop className="flex min-h-0 flex-1 flex-col" onFiles={(files) => composer.current?.addFiles(files)}>
          <MessageList
            key={`thread-${roomId}`}
            items={items}
            loaded={!!page?.loaded}
            hasMore={!!page?.hasMore}
            loadingMore={page?.loadingMore}
            onLoadOlder={() => void loadRoomMessages(roomId, true)}
            showSenders
            meId={me?.id ?? ''}
            onRetry={(item) => void sendRoomMessage(roomId, item.draft ?? { body: item.body }, item.key)}
            onReply={(item) => setReplyTo(replyRefFor(item))}
            onInfo={(item) => setInfo({ scope: 'room', roomId, messageId: item.id, sentAt: item.createdAt })}
            onReact={(item, emoji) => void react('room', item.id, emoji)}
            onDelete={(item, forEveryone) => deleteMessage('room', roomId, item.id, forEveryone)}
          />
          <TypingLine text={typingText(typingNames)} />
          <Composer
            ref={composer}
            key={`composer-${roomId}`}
            placeholder={`Message ${room.name}`}
            onSend={(draft) => void sendRoomMessage(roomId, draft)}
            onTyping={(t) => socket.emit('room:typing', { roomId, typing: t })}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
          />
        </FileDrop>
        <MessageInfo target={info} onClose={() => setInfo(null)} />
      </div>

      {room.myRole === 'admin' && (
        <WatchDialog roomId={roomId} open={watchOpen} onClose={() => setWatchOpen(false)} replacing={!!detail?.watch} />
      )}

      {wide ? (
        <aside className="flex w-[340px] shrink-0 flex-col border-l border-line/70 bg-subtle/30">{panel}</aside>
      ) : (
        panelOpen && (
          // Phones: a full page (like a group's info); between phone and wide: a side panel.
          <div className="fixed inset-0 z-[45] flex justify-end bg-[rgb(6_8_22/0.5)]" onMouseDown={(e) => e.target === e.currentTarget && setPanelOpen(false)}>
            <aside className="panel-in flex h-full w-full flex-col bg-surface pt-[var(--safe-top)] shadow-2xl md:w-[min(370px,100%)] md:border-l md:border-line">{panel}</aside>
          </div>
        )
      )}
    </div>
  );
}
