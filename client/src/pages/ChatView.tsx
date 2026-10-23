import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Ban, BellOff, Eraser, Flag, Phone, PhoneOff, Settings2, ShieldCheck, Video } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { lastSeen } from '../lib/format';
import { useSite } from '../lib/site';
import { useNow } from '../lib/useMedia';
import type { ReplyRef } from '../lib/types';
import { socket } from '../lib/socket';
import { useAuth } from '../store/auth';
import { useCall } from '../store/call';
import { isMuted, useChat } from '../store/chat';
import { toast, useUi } from '../store/ui';
import { Avatar } from '../components/ui/Avatar';
import { Button, IconButton } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { MuteDialog, settingsItems } from '../components/ChatActions';
import { Composer, type ComposerHandle, type EditTarget } from '../components/Composer';
import { ReportDialog, type ReportTarget } from '../components/ReportDialog';
import { FileDrop } from '../components/FileDrop';
import { MessageList, recentEnoughToDelete, replyRefFor, type ThreadItem } from '../components/MessageList';
import { MessageInfo, type InfoTarget } from '../components/MessageInfo';
import { StatusLine } from '../components/ConnectionNotice';
import { goBack } from '../lib/screens';

export function ChatView() {
  const { userId = '' } = useParams();
  const me = useAuth((s) => s.user);
  const partner = useChat((s) => s.users[userId] ?? s.conversations[userId]?.partner);
  const page = useChat((s) => s.dms[userId]);
  const online = useChat((s) => !!s.online[userId]);
  const seen = useChat((s) => s.lastSeen[userId]);
  // Not shared by them, or by me (it works both ways): show no status at all.
  const presenceHidden = useChat((s) => s.hiddenPresence[userId] ?? s.users[userId]?.presenceHidden ?? s.conversations[userId]?.partner.presenceHidden ?? false);
  const typing = useChat((s) => !!s.dmTyping[userId]);
  const openDm = useChat((s) => s.openDm);
  const loadDm = useChat((s) => s.loadDm);
  const sendDm = useChat((s) => s.sendDm);
  const react = useChat((s) => s.react);
  const deleteMessage = useChat((s) => s.deleteMessage);
  const editMessage = useChat((s) => s.editMessage);
  const conversation = useChat((s) => s.conversations[userId]);
  const messaging = useSite((s) => s.messaging);
  const callPhase = useCall((s) => s.phase);
  const callPeer = useCall((s) => s.peer?.id);
  const startCall = useCall((s) => s.startCall);
  const endCall = useCall((s) => s.endCall);
  const openDevices = useUi((s) => s.setDevicesOpen);
  const navigate = useNavigate();
  const composer = useRef<ComposerHandle>(null);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const [muting, setMuting] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  // "Last seen 5 min ago" keeps counting.
  useNow(30_000, !online);

  useEffect(() => {
    openDm(userId);
    setReplyTo(null);
    setEditing(null);
    return () => openDm(null);
  }, [userId, openDm]);

  // How long my messages can be edited (the host's choice; host admins, any time).
  const editFor = me?.siteAdmin ? Infinity : messaging.editing ? messaging.editMinutes * 60_000 : 0;
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
          sender: who ? { id: who.id, name: who.name, hue: who.hue, photo: who.photo } : null,
          receipt: m.readAt ? 'read' : m.deliveredAt ? 'delivered' : 'sent',
          pending: m.pending,
          callOutcome: m.meta?.outcome,
          callDuration: m.meta?.duration,
          callVideo: !!m.meta?.video,
          attachment: m.attachment,
          replyTo: m.replyTo,
          reactions: m.reactions,
          upload: m.upload,
          draft: m.draft,
          deleted: !!m.deletedAt,
          canDeleteForEveryone: mine && m.kind === 'text' && m.id > 0 && !m.deletedAt && recentEnoughToDelete(m.createdAt),
          editedAt: m.editedAt,
          forwarded: m.forwarded,
          preview: m.preview,
          editableUntil: mine && m.kind === 'text' ? new Date(m.createdAt).getTime() + editFor : 0,
        };
      }),
    [page?.items, me, partner, editFor],
  );

  // A message taken back while it's being replied to (or edited): the reply (or edit) goes too.
  useEffect(() => {
    if (replyTo && items.some((m) => m.id === replyTo.id && m.deleted)) setReplyTo(null);
    if (editing && items.some((m) => m.id === editing.id && m.deleted)) setEditing(null);
  }, [items, replyTo, editing]);

  if (userId === me?.id) return <Navigate to="/chats" replace />;

  const name = partner?.name ?? '…';
  const blocked = !!partner?.blocked;
  const onCallWithThem = callPhase !== 'idle' && callPeer === userId;
  const call = (video = false) => partner && void startCall({ id: partner.id, name: partner.name, hue: partner.hue, photo: partner.photo }, { video });
  const unblock = () =>
    void useChat
      .getState()
      .unblock(userId)
      .then(() => toast(`${name} is unblocked`))
      .catch((err) => toast(errorMessage(err), 'error'));
  // ⋮ in the header: my settings for the chat, and blocking or reporting them.
  const menu: MenuItem[] = [
    ...(conversation ? settingsItems('dm', userId, conversation, () => setMuting(true)) : []),
    // Something to clear.
    ...(conversation?.lastMessage ? [{ label: 'Clear chat history', icon: <Eraser size={18} />, onSelect: () => setClearing(true) }] : []),
    blocked
      ? { label: `Unblock ${name}`, icon: <ShieldCheck size={18} />, onSelect: unblock }
      : { label: `Block ${name}`, icon: <Ban size={18} />, onSelect: () => setBlocking(true), danger: true },
    { label: `Report ${name}`, icon: <Flag size={18} />, onSelect: () => setReporting({ scope: 'user', userId, name }), danger: true },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="glass relative z-10 flex h-[64px] shrink-0 items-center gap-2.5 border-b border-line/70 px-1.5 pt-[var(--safe-top)] md:h-[72px] md:gap-3 md:px-5">
        <IconButton label="Back to chats" className="ripple md:hidden" onClick={() => goBack(navigate, '/chats')}>
          <ArrowLeft size={20} />
        </IconButton>
        {partner && (
          <>
            <span className="md:hidden">
              <Avatar name={partner.name} hue={partner.hue} photo={partner.photo} size={40} online={online} />
            </span>
            <span className="hidden md:block">
              <Avatar name={partner.name} hue={partner.hue} photo={partner.photo} size={44} online={online} />
            </span>
          </>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h1 className="truncate font-display text-[18px] leading-tight font-semibold tracking-[-0.01em]">{name}</h1>
            {conversation && isMuted(conversation) && <BellOff size={15} className="shrink-0 text-ink-soft" role="img" aria-label="Notifications muted" />}
          </div>
          <p className="truncate text-[13px] text-ink-soft">
            <StatusLine>
              {typing ? (
                <span className="font-medium text-brand dark:text-live">typing…</span>
              ) : presenceHidden ? (
                ''
              ) : online ? (
                <span className="font-medium text-live-ink">Online</span>
              ) : (
                lastSeen(seen ?? partner?.lastSeenAt ?? null)
              )}
            </StatusLine>
          </p>
        </div>
        {onCallWithThem ? (
          // Phones: round icons with room to spare (the call bar above has the rest).
          <div className="flex items-center gap-1.5 pr-1 md:gap-2 md:pr-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDevices(true)}
              aria-label="Microphone, speaker and camera"
              className="ripple max-md:size-10 max-md:rounded-full max-md:border-transparent max-md:bg-transparent max-md:px-0"
            >
              <Settings2 size={18} />
              <span className="hidden md:inline">Devices</span>
            </Button>
            <Button variant="danger" size="sm" onClick={endCall} aria-label="End call" className="ripple max-md:size-10 max-md:rounded-full max-md:px-0">
              <PhoneOff size={18} />
              <span className="hidden md:inline">End call</span>
            </Button>
          </div>
        ) : (
          <>
            {/* Phones: plain icons, as in other messengers. */}
            <div className="flex md:hidden">
              <IconButton label={`Video call ${name}`} size={44} className="ripple" onClick={() => call(true)} disabled={!partner || blocked || callPhase !== 'idle'}>
                <Video size={23} />
              </IconButton>
              <IconButton label={`Voice call ${name}`} size={44} className="ripple" onClick={() => call(false)} disabled={!partner || blocked || callPhase !== 'idle'}>
                <Phone size={20} />
              </IconButton>
            </div>
            <div className="hidden gap-2 md:flex">
            <Button variant="soft" size="sm" onClick={() => call(false)} disabled={!partner || blocked || callPhase !== 'idle'} aria-label={`Voice call ${name}`}>
              <Phone size={16} className="text-brand dark:text-live" />
              <span className="hidden sm:inline">Voice</span>
            </Button>
            <Button variant="primary" size="sm" onClick={() => call(true)} disabled={!partner || blocked || callPhase !== 'idle'} aria-label={`Video call ${name}`}>
              <Video size={17} />
              <span className="hidden sm:inline">Video</span>
            </Button>
            </div>
          </>
        )}
        {partner && (
          <span className="-ml-1 md:ml-0">
            <Menu label="Chat options" items={menu} size={40} />
          </span>
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
          meId={me?.id ?? ''}
          onRetry={(item) => void sendDm(userId, item.draft ?? { body: item.body }, item.key)}
          onReply={(item) => {
            setEditing(null);
            setReplyTo(replyRefFor(item));
          }}
          onEdit={(item) => {
            setReplyTo(null);
            setEditing({ id: item.id, body: item.body, hasFile: !!item.attachment });
          }}
          scope="dm"
          canForward={!!me?.siteAdmin || messaging.forwarding}
          onInfo={(item) => {
            const m = page?.items.find((x) => x.id === item.id);
            if (m) setInfo({ scope: 'dm', sentAt: m.createdAt, deliveredAt: m.deliveredAt, readAt: m.readAt, partnerName: name });
          }}
          onReact={(item, emoji) => void react('dm', item.id, emoji)}
          onDelete={(item, forEveryone) => deleteMessage('dm', userId, item.id, forEveryone)}
          onCallBack={callPhase === 'idle' ? (video) => call(video) : undefined}
          empty={
            <div className="mx-auto max-w-sm py-16 text-center">
              {partner && (
                <span className="relative mx-auto block w-fit">
                  <span aria-hidden className="absolute inset-0 rounded-full bg-aurora opacity-50 blur-xl" />
                  <Avatar name={partner.name} hue={partner.hue} photo={partner.photo} size={84} className="relative" />
                </span>
              )}
              <p className="mt-5 font-display text-[22px] font-semibold">Say hello to {name}</p>
              <p className="mt-1 text-[14px] text-ink-soft">Messages arrive instantly. Use the buttons above for a voice or video call.</p>
            </div>
          }
        />
        {blocked ? (
          <BlockedBar name={name} onUnblock={unblock} />
        ) : (
          <Composer
            ref={composer}
            key={`composer-${userId}`}
            placeholder={`Message ${name.split(' ')[0]}`}
            onSend={(draft) => void sendDm(userId, draft)}
            onTyping={(t) => socket.emit('dm:typing', { to: userId, typing: t })}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            editing={editing}
            onSaveEdit={(target, body) => editMessage('dm', target.id, body)}
            onCancelEdit={() => setEditing(null)}
          />
        )}
      </FileDrop>
      <MessageInfo target={info} onClose={() => setInfo(null)} />
      <MuteDialog open={muting} scope="dm" id={userId} name={name} onClose={() => setMuting(false)} />
      <BlockDialog open={blocking} userId={userId} name={name} onClose={() => setBlocking(false)} />
      <ClearDialog open={clearing} userId={userId} name={name} onClose={() => setClearing(false)} />
      <ReportDialog target={reporting} onClose={() => setReporting(null)} />
    </div>
  );
}

/** In place of the message box once I've blocked them. */
function BlockedBar({ name, onUnblock }: { name: string; onUnblock: () => void }) {
  return (
    <div className="shrink-0 px-3 pt-2 pb-[max(12px,var(--safe-bottom))] md:px-6 md:pb-5">
      <div className="mx-auto flex max-w-[860px] flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-[22px] border border-line/80 bg-subtle/60 px-4 py-3 text-center text-[14px] text-ink-soft">
        <span className="flex items-center gap-2">
          <Ban size={16} className="shrink-0" aria-hidden />
          You blocked {name}. You can't message or call each other.
        </span>
        <Button size="sm" variant="soft" onClick={onUnblock}>
          Unblock
        </Button>
      </div>
    </div>
  );
}

/** "Block them?": what it does, before doing it. */
function BlockDialog({ open, userId, name, onClose }: { open: boolean; userId: string; name: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  async function block() {
    setBusy(true);
    try {
      await useChat.getState().block(userId);
      toast(`You blocked ${name}`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      alert
      width={400}
      title={`Block ${name}?`}
      description="They won't be able to message or call you, or add you to rooms, and neither of you will see when the other is online. They aren't told. Your messages so far stay."
    >
      <div className="flex flex-col gap-2">
        <Button variant="danger" busy={busy} onClick={() => void block()}>
          Block
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}

/** "Clear chat history?" (as Telegram's): for me, or with "Also clear for them", for both of us. */
function ClearDialog({ open, userId, name, onClose }: { open: boolean; userId: string; name: string; onClose: () => void }) {
  const [everyone, setEveryone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setEveryone(false);
  }, [open]);
  async function clear() {
    setBusy(true);
    try {
      await useChat.getState().clearDm(userId, everyone);
      toast(everyone ? `Chat history cleared for you and ${name}` : 'Chat history cleared');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      alert
      width={400}
      title="Clear chat history?"
      description={`Every message, photo and file in your chat with ${name} goes. This can't be undone.`}
    >
      <label className="flex cursor-pointer items-start gap-3 text-[14px]">
        <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} className="mt-1 size-4 accent-[var(--brand)]" />
        <span>
          <span className="block font-semibold">Also clear for {name}</span>
          <span className="block text-[13px] text-ink-soft">The chat empties on both sides, their messages too. Otherwise only you stop seeing it.</span>
        </span>
      </label>
      <div className="mt-5 flex flex-col gap-2">
        <Button variant="danger" busy={busy} onClick={() => void clear()}>
          {everyone ? 'Clear for both of us' : 'Clear for me'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
