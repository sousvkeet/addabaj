import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ArrowLeft, AudioLines, Headphones, LoaderCircle, Users } from 'lucide-react';
import { socket } from '../lib/socket';
import { useMedia } from '../lib/useMedia';
import type { VoiceParticipant } from '../lib/types';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { useChat } from '../store/chat';
import { useVoice } from '../store/voice';
import { Avatar, hueFromId } from '../components/ui/Avatar';
import { Button, IconButton } from '../components/ui/Button';
import { Composer } from '../components/Composer';
import { MessageList, TypingLine, type ThreadItem } from '../components/MessageList';
import { RoomPanel } from '../components/RoomPanel';

const EMPTY: VoiceParticipant[] = [];

function typingText(names: string[]) {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names.length} people are typing`;
}

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
  const voiceRoom = useVoice((s) => s.roomId);
  const voiceStatus = useVoice((s) => s.status);
  const joinVoice = useVoice((s) => s.join);
  const inCall = useCall((s) => s.phase !== 'idle');
  const wide = useMedia('(min-width: 1280px)');
  const navigate = useNavigate();
  const location = useLocation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    openRoom(roomId);
    setPanelOpen(false);
    return () => openRoom(null);
  }, [roomId, openRoom]);

  // Right after creating a room, jump straight into adding people.
  useEffect(() => {
    if ((location.state as { addPeople?: boolean } | null)?.addPeople && detail) {
      setAddOpen(true);
      if (!wide) setPanelOpen(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, detail, wide, navigate]);

  const items = useMemo<ThreadItem[]>(
    () =>
      (page?.items ?? []).map((m) => ({
        key: m.tempId ?? String(m.id),
        mine: m.sender?.id === me?.id && m.kind === 'text',
        kind: m.kind,
        body: m.body,
        createdAt: m.createdAt,
        sender: m.sender,
        pending: m.pending,
      })),
    [page?.items, me?.id],
  );

  if (!room) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        {bootstrapped ? (
          <>
            <p className="font-display text-[22px]">This room isn't available</p>
            <p className="max-w-sm text-[14px] text-ink-soft">It may have been deleted, or you're no longer a member.</p>
            <Link to="/rooms" className="font-semibold text-shutter hover:underline dark:text-taxi">
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
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-paper px-2 md:px-5">
          <IconButton label="Back to rooms" className="md:hidden" onClick={() => navigate('/rooms')}>
            <ArrowLeft size={20} />
          </IconButton>
          <Avatar name={room.name} hue={hueFromId(room.id)} size={40} square />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-[20px] leading-tight">{room.name}</h1>
            <p className="flex items-center gap-2 truncate text-[13px] text-ink-soft">
              <span className="truncate">
                {room.memberCount} of {room.maxMembers} members
              </span>
              {voiceList.length > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-shutter px-2 leading-5 font-semibold text-taxi">
                  <AudioLines size={12} />
                  {voiceList.length} in voice
                </span>
              )}
            </p>
          </div>
          {!liveHere && (
            <Button
              variant="live"
              size="sm"
              onClick={() => void joinVoice(roomId)}
              disabled={inCall}
              aria-label="Join voice"
              title={inCall ? 'End your call to join voice' : undefined}
            >
              <Headphones size={16} />
              <span className="hidden sm:inline">Join voice</span>
            </Button>
          )}
          {!wide && (
            <IconButton label="Members and voice" onClick={() => setPanelOpen(true)}>
              <Users size={20} />
            </IconButton>
          )}
        </header>

        <MessageList
          key={`thread-${roomId}`}
          items={items}
          loaded={!!page?.loaded}
          hasMore={!!page?.hasMore}
          loadingMore={page?.loadingMore}
          onLoadOlder={() => void loadRoomMessages(roomId, true)}
          showSenders
          onRetry={(item) => void sendRoomMessage(roomId, item.body, item.key)}
        />
        <TypingLine text={typingText(typingNames)} />
        <Composer
          key={`composer-${roomId}`}
          placeholder={`Message ${room.name}`}
          onSend={(body) => void sendRoomMessage(roomId, body)}
          onTyping={(t) => socket.emit('room:typing', { roomId, typing: t })}
        />
      </div>

      {wide ? (
        <aside className="flex w-[330px] shrink-0 flex-col border-l border-line bg-limewash">{panel}</aside>
      ) : (
        panelOpen && (
          <div className="fixed inset-0 z-[45] flex justify-end bg-[rgb(10_25_21/0.5)]" onMouseDown={(e) => e.target === e.currentTarget && setPanelOpen(false)}>
            <aside className="pop-in flex h-full w-[min(360px,100%)] flex-col bg-limewash pt-[env(safe-area-inset-top)] shadow-2xl">{panel}</aside>
          </div>
        )
      )}
    </div>
  );
}
