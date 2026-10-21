import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowDown, Check, CheckCheck, Clock, Download, FileText, LoaderCircle, Phone, PhoneMissed, Reply, SmilePlus, Video, X,
} from 'lucide-react';
import { attachmentLabel, clock, dayLabel, duration, formatBytes, sameDay } from '../lib/format';
import type { Attachment, Draft, Reaction, ReplyRef } from '../lib/types';
import { Avatar } from './ui/Avatar';
import { VoicePlayer } from './VoicePlayer';

export type ThreadItem = {
  key: string;
  /** Server id (0 while sending). */
  id: number;
  mine: boolean;
  kind: 'text' | 'call' | 'system';
  body: string;
  createdAt: string;
  sender?: { id: string; name: string; hue: number } | null;
  readAt?: string | null;
  pending?: 'sending' | 'failed';
  callOutcome?: 'completed' | 'missed' | 'declined';
  callDuration?: number;
  callVideo?: boolean;
  attachment?: Attachment | null;
  replyTo?: ReplyRef | null;
  reactions?: Reaction[];
  upload?: number;
  draft?: Draft;
};

type Props = {
  items: ThreadItem[];
  loaded: boolean;
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadOlder: () => void;
  showSenders?: boolean;
  receipts?: boolean;
  meId: string;
  onRetry: (item: ThreadItem) => void;
  onReply: (item: ThreadItem) => void;
  onReact: (item: ThreadItem, emoji: string) => void;
  onCallBack?: (video: boolean) => void;
  empty?: ReactNode;
};

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const GROUP_GAP_MS = 5 * 60 * 1000;

/** The quote a reply carries, from the message being replied to. */
export function replyRefFor(item: ThreadItem): ReplyRef {
  const a = item.attachment;
  return {
    id: item.id,
    senderId: item.sender?.id,
    senderName: item.mine ? 'You' : (item.sender?.name ?? ''),
    body: item.body.slice(0, 200),
    attachment: a ? { kind: a.kind, name: a.name, duration: a.duration } : null,
  };
}

export function MessageList({
  items, loaded, hasMore, loadingMore, onLoadOlder, showSenders, receipts, meId, onRetry, onReply, onReact, onCallBack, empty,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prev = useRef<{ first?: string; last?: string; height: number }>({ height: 0 });
  const [unseen, setUnseen] = useState(0);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [sheetFor, setSheetFor] = useState<ThreadItem | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = items[0]?.key;
    const last = items.at(-1)?.key;
    const p = prev.current;
    if (p.first && first !== p.first && last === p.last) {
      // Older messages were prepended: keep the view anchored.
      el.scrollTop += el.scrollHeight - p.height;
    } else if (last !== p.last) {
      if (atBottom.current || items.at(-1)?.mine || !p.last) el.scrollTop = el.scrollHeight;
      else setUnseen((n) => n + 1);
    }
    prev.current = { first, last, height: el.scrollHeight };
  }, [items]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current && unseen) setUnseen(0);
    if (el.scrollTop < 150 && hasMore && !loadingMore) {
      prev.current.height = el.scrollHeight;
      onLoadOlder();
    }
  }

  function jumpToLatest() {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setUnseen(0);
  }

  /** Scrolls to a replied-to message (if it's loaded) and flashes it. */
  function jumpTo(id: number) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-3 pt-5 pb-3 md:px-7" role="log" aria-live="polite">
        <div className="mx-auto flex min-h-full max-w-[860px] flex-col justify-end">
          {loadingMore && (
            <p className="flex justify-center py-2 text-ink-soft">
              <LoaderCircle size={18} className="animate-spin" />
            </p>
          )}
          {!loaded && (
            <p className="flex justify-center py-10 text-ink-soft">
              <LoaderCircle size={22} className="animate-spin" />
            </p>
          )}
          {loaded && items.length === 0 && empty}
          {items.map((item, i) => {
            const before = items[i - 1];
            const newDay = !before || !sameDay(before.createdAt, item.createdAt);
            const groupStart =
              newDay ||
              before.kind !== 'text' ||
              item.kind !== 'text' ||
              before.mine !== item.mine ||
              before.sender?.id !== item.sender?.id ||
              new Date(item.createdAt).getTime() - new Date(before.createdAt).getTime() > GROUP_GAP_MS;
            return (
              <div key={item.key}>
                {newDay && (
                  <p className="my-4 flex justify-center">
                    <span className="glass rounded-full border border-line/70 px-3.5 py-1 text-[12px] font-semibold tracking-wide text-ink-soft uppercase">{dayLabel(item.createdAt)}</span>
                  </p>
                )}
                <Message
                  item={item}
                  groupStart={groupStart}
                  showSender={!!showSenders}
                  receipts={!!receipts}
                  meId={meId}
                  onRetry={onRetry}
                  onReply={onReply}
                  onReact={onReact}
                  onOpenSheet={setSheetFor}
                  onView={setViewing}
                  onJump={jumpTo}
                  onCallBack={onCallBack}
                />
              </div>
            );
          })}
        </div>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="pop-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-aurora px-4 py-2 text-[13.5px] font-semibold text-white shadow-glow"
        >
          <ArrowDown size={15} />
          {unseen === 1 ? 'New message' : `${unseen} new messages`}
        </button>
      )}
      {viewing && <Lightbox attachment={viewing} onClose={() => setViewing(null)} />}
      {sheetFor && (
        <ActionSheet
          item={sheetFor}
          onClose={() => setSheetFor(null)}
          onReply={() => {
            onReply(sheetFor);
            setSheetFor(null);
          }}
          onReact={(emoji) => {
            onReact(sheetFor, emoji);
            setSheetFor(null);
          }}
        />
      )}
    </div>
  );
}

// ── One message ──────────────────────────────────────────────────────

type MessageProps = {
  item: ThreadItem;
  groupStart: boolean;
  showSender: boolean;
  receipts: boolean;
  meId: string;
  onRetry: (item: ThreadItem) => void;
  onReply: (item: ThreadItem) => void;
  onReact: (item: ThreadItem, emoji: string) => void;
  onOpenSheet: (item: ThreadItem) => void;
  onView: (a: Attachment) => void;
  onJump: (id: number) => void;
  onCallBack?: (video: boolean) => void;
};

function Message(props: MessageProps) {
  const { item, groupStart, showSender, receipts, meId, onRetry, onReply, onReact, onOpenSheet, onView, onJump, onCallBack } = props;
  const [picking, setPicking] = useState(false);
  const pressTimer = useRef(0);

  if (item.kind === 'system') {
    return (
      <p className="mx-auto my-2.5 w-fit max-w-[85%] rounded-full bg-subtle/60 px-3.5 py-1 text-center text-[12.5px] text-ink-soft">
        {item.body}
        <span className="ml-1.5 opacity-70">{clock(item.createdAt)}</span>
      </p>
    );
  }

  if (item.kind === 'call') {
    const missed = item.callOutcome !== 'completed';
    return (
      <div className={`mt-3 flex ${item.mine ? 'justify-end' : ''}`}>
        <div className="flex items-center gap-3 rounded-2xl border border-line/70 bg-surface/80 py-2.5 pr-4 pl-3 shadow-float">
          <span className={`flex size-10 items-center justify-center rounded-full ${missed ? 'bg-danger/15 text-danger' : 'bg-aurora text-white shadow-glow'}`}>
            {missed ? <PhoneMissed size={17} /> : item.callVideo ? <Video size={17} /> : <Phone size={17} />}
          </span>
          <span>
            <span className="block text-[14.5px] font-semibold">
              {item.callOutcome === 'completed' ? `${item.mine ? 'Outgoing' : 'Incoming'} ${item.callVideo ? 'video call' : 'call'}` : item.body}
            </span>
            <span className="block text-[12.5px] text-ink-soft">
              {item.callOutcome === 'completed' ? `${duration(item.callDuration ?? 0)} long, ` : ''}
              {clock(item.createdAt)}
            </span>
          </span>
          {onCallBack && !item.mine && missed && (
            <button type="button" onClick={() => onCallBack(!!item.callVideo)} className="ml-2 text-[13.5px] font-semibold text-brand hover:underline dark:text-live">
              Call back
            </button>
          )}
        </div>
      </div>
    );
  }

  const sender = item.sender;
  const showName = showSender && !item.mine && groupStart && sender;
  const nameStyle = sender ? ({ '--h': sender.hue } as CSSProperties) : undefined;
  const a = item.attachment;
  const media = a && (a.kind === 'image' || a.kind === 'video');
  const canAct = item.id > 0 && !item.pending;

  // Press and hold on a touch screen opens the action sheet.
  const touchHandlers = canAct
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.pointerType !== 'touch') return;
          pressTimer.current = window.setTimeout(() => onOpenSheet(item), 450);
        },
        onPointerUp: () => window.clearTimeout(pressTimer.current),
        onPointerMove: () => window.clearTimeout(pressTimer.current),
        onPointerCancel: () => window.clearTimeout(pressTimer.current),
        onContextMenu: (e: React.MouseEvent) => {
          if ((e.nativeEvent as PointerEvent).pointerType === 'touch') e.preventDefault();
        },
      }
    : {};

  return (
    <div id={item.id ? `msg-${item.id}` : undefined} className={`group flex items-end gap-2 rounded-xl ${item.mine ? 'justify-end' : ''} ${groupStart ? 'mt-3' : 'mt-[3px]'}`}>
      {showSender && !item.mine && (
        <span className="w-8 shrink-0 self-start">{groupStart && sender && <Avatar name={sender.name} hue={sender.hue} size={32} />}</span>
      )}
      {item.mine && canAct && <Actions picking={picking} setPicking={setPicking} onReply={() => onReply(item)} onReact={(e) => onReact(item, e)} />}
      <div className={`flex max-w-[min(78%,560px)] flex-col ${item.mine ? 'items-end' : 'items-start'}`}>
        {showName && (
          <span style={nameStyle} className="mb-1 ml-1 text-[12.5px] font-bold text-[hsl(var(--h)_70%_44%)] dark:text-[hsl(var(--h)_90%_74%)]">
            {sender.name}
          </span>
        )}
        <div
          {...touchHandlers}
          className={`text-[15px] leading-[1.5] select-text ${media ? 'p-1' : 'px-4 py-2.5'} ${
            item.mine
              ? `rounded-[22px] bg-aurora text-white shadow-[0_8px_24px_-14px_var(--brand)] ${groupStart ? 'rounded-tr-[8px]' : ''}`
              : `rounded-[22px] border border-line/70 bg-surface text-ink shadow-[0_6px_18px_-14px_rgb(0_0_0/0.5)] ${groupStart ? 'rounded-tl-[8px]' : ''}`
          } ${item.pending === 'failed' ? 'opacity-60' : ''} ${groupStart ? 'rise-in' : ''}`}
        >
          {item.replyTo && (
            <button
              type="button"
              onClick={() => onJump(item.replyTo!.id)}
              className={`mb-1.5 block w-full min-w-[160px] rounded-xl border-l-[3px] px-3 py-1.5 text-left ${media ? 'mx-0' : ''} ${
                item.mine ? 'border-white/85 bg-black/15' : 'border-brand bg-subtle dark:border-live'
              }`}
            >
              <span className="block text-[12.5px] font-semibold">{item.replyTo.senderId === meId ? 'You' : item.replyTo.senderName}</span>
              <span className="block truncate text-[13px] opacity-80">
                {item.replyTo.deleted ? 'Message unavailable' : item.replyTo.body || (item.replyTo.attachment ? attachmentLabel(item.replyTo.attachment) : '')}
              </span>
            </button>
          )}
          {a && (
            <div className="relative">
              <AttachmentView attachment={a} mine={item.mine} upload={item.pending === 'sending' ? item.upload : undefined} onView={onView} />
              {/* A photo without a caption carries its time on the picture. */}
              {a.kind === 'image' && !item.body && <Meta item={item} receipts={receipts} overlay />}
            </div>
          )}
          {(item.body || !a) && (
            <div className={media ? 'px-2.5 pt-1.5 pb-1' : a ? 'pt-1.5' : ''}>
              <span className="break-words whitespace-pre-wrap">{item.body}</span>
              <Meta item={item} receipts={receipts} />
            </div>
          )}
          {a && a.kind !== 'image' && !item.body && (
            <div className={`flex justify-end ${media ? 'px-2 pb-0.5' : ''}`}>
              <Meta item={item} receipts={receipts} />
            </div>
          )}
        </div>
        {!!item.reactions?.length && (
          <div className={`mt-1 flex flex-wrap gap-1 ${item.mine ? 'justify-end' : ''}`}>
            {item.reactions.map((r) => {
              const mineToo = r.users.includes(meId);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => onReact(item, r.emoji)}
                  aria-pressed={mineToo}
                  aria-label={`${r.emoji} ${r.users.length}${mineToo ? ', including you' : ''}`}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[13px] ${
                    mineToo ? 'border-brand/60 bg-brand/15 shadow-[0_0_12px_-4px_var(--brand)]' : 'border-line bg-surface'
                  }`}
                >
                  <span>{r.emoji}</span>
                  <span className="font-semibold tabular-nums">{r.users.length}</span>
                </button>
              );
            })}
          </div>
        )}
        {item.pending === 'failed' && (
          <button type="button" onClick={() => onRetry(item)} className="mt-1 text-[13px] font-semibold text-danger hover:underline">
            Not sent. Tap to retry
          </button>
        )}
      </div>
      {!item.mine && canAct && <Actions picking={picking} setPicking={setPicking} onReply={() => onReply(item)} onReact={(e) => onReact(item, e)} />}
    </div>
  );
}

function Meta({ item, receipts, overlay }: { item: ThreadItem; receipts: boolean; overlay?: boolean }) {
  const place = overlay
    ? 'pointer-events-none absolute right-2 bottom-2 rounded-full bg-black/50 px-2 py-[3px] text-white'
    : `float-right mt-[7px] ml-3 ${item.mine ? 'text-white/75' : 'text-ink-soft'}`;
  return (
    <span className={`inline-flex items-center gap-1 text-[11.5px] leading-none ${place}`}>
      {clock(item.createdAt)}
      {item.mine &&
        (item.pending === 'sending' ? (
          <Clock size={13} aria-label="Sending" />
        ) : item.pending === 'failed' ? null : receipts && item.readAt ? (
          <CheckCheck size={15} className="text-white drop-shadow-[0_0_4px_var(--live)]" aria-label="Read" />
        ) : (
          <Check size={14} aria-label="Sent" />
        ))}
    </span>
  );
}

/** Reply and react buttons beside a message (shown on hover or keyboard focus). */
function Actions({ picking, setPicking, onReply, onReact }: { picking: boolean; setPicking: (v: boolean) => void; onReply: () => void; onReact: (emoji: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picking) return;
    const close = (e: Event) => !box.current?.contains(e.target as Node) && setPicking(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPicking(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [picking, setPicking]);

  return (
    <div
      ref={box}
      className={`relative mb-1 hidden shrink-0 items-center gap-0.5 self-center transition-opacity [@media(hover:hover)]:flex ${
        picking ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
      }`}
    >
      <button type="button" aria-label="React" onClick={() => setPicking(!picking)} className="rounded-full p-1.5 text-ink-soft hover:bg-subtle hover:text-ink">
        <SmilePlus size={16} />
      </button>
      <button type="button" aria-label="Reply" onClick={onReply} className="rounded-full p-1.5 text-ink-soft hover:bg-subtle hover:text-ink">
        <Reply size={16} />
      </button>
      {picking && (
        <div role="menu" className="pop-in absolute bottom-9 left-1/2 z-20 flex -translate-x-1/2 gap-0.5 rounded-full border border-line bg-surface p-1 shadow-float">
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitem"
              aria-label={`React ${e}`}
              onClick={() => {
                onReact(e);
                setPicking(false);
              }}
              className="flex size-9 items-center justify-center rounded-full text-[20px] transition-transform hover:scale-125 hover:bg-subtle"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Attachments ──────────────────────────────────────────────────────

/** Fits a picture of width×height into the bubble without the layout jumping while it loads. */
function boxFor(a: Attachment) {
  const maxW = Math.min(300, typeof window !== 'undefined' ? window.innerWidth * 0.68 : 300);
  const maxH = 340;
  const w0 = a.width || 300;
  const h0 = a.height || 200;
  let w = Math.min(maxW, w0);
  let h = (w * h0) / w0;
  if (h > maxH) {
    h = maxH;
    w = (h * w0) / h0;
  }
  return { width: Math.round(w), height: Math.round(h) };
}

function AttachmentView({ attachment: a, mine, upload, onView }: { attachment: Attachment; mine: boolean; upload?: number; onView: (a: Attachment) => void }) {
  const uploading = upload !== undefined && (
    <div className="absolute inset-0 flex items-center justify-center rounded-[14px] bg-black/45 text-[14px] font-semibold text-white">
      <span className="flex items-center gap-2">
        <LoaderCircle size={18} className="animate-spin" />
        {upload}%
      </span>
    </div>
  );

  if (a.kind === 'image') {
    return (
      <div className="relative">
        <button type="button" onClick={() => onView(a)} aria-label={`Open photo ${a.name}`} className="block">
          <img src={a.url} alt={a.name} loading="lazy" style={boxFor(a)} className="rounded-[14px] bg-black/10 object-cover" />
        </button>
        {uploading}
      </div>
    );
  }
  if (a.kind === 'video') {
    return (
      <div className="relative">
        <video src={a.url} controls preload="metadata" playsInline style={boxFor(a)} className="rounded-[14px] bg-black" />
        {uploading}
      </div>
    );
  }
  if (a.kind === 'voice') {
    return (
      <div className="relative">
        <VoicePlayer attachment={a} mine={mine} />
        {upload !== undefined && <p className="text-[12px] opacity-70">Sending, {upload}%</p>}
      </div>
    );
  }
  const downloadable = a.id !== 'local';
  return (
    <div className={`flex min-w-[220px] items-center gap-3 rounded-2xl p-2 ${mine ? 'bg-black/15' : 'bg-subtle'}`}>
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${mine ? 'bg-white/20' : 'bg-aurora text-white'}`}>
        <FileText size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold">{a.name}</span>
        <span className="block text-[12.5px] opacity-75">{upload !== undefined ? `Sending, ${upload}%` : formatBytes(a.size)}</span>
      </span>
      {downloadable && (
        <a href={`${a.url}?download=1`} download={a.name} aria-label={`Download ${a.name}`} className="rounded-full p-2 hover:bg-black/10">
          <Download size={18} />
        </a>
      )}
    </div>
  );
}

/** A photo shown full screen, with a download button. */
function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={attachment.name} className="fixed inset-0 z-[70] flex flex-col bg-[rgb(4_6_18/0.94)] backdrop-blur-md" onClick={onClose}>
      <div className="flex shrink-0 items-center justify-end gap-2 p-3 pt-[max(12px,env(safe-area-inset-top))]" onClick={(e) => e.stopPropagation()}>
        <a href={`${attachment.url}?download=1`} download={attachment.name} className="flex items-center gap-2 rounded-full bg-white/15 px-3.5 py-2 text-[14px] font-semibold text-white hover:bg-white/25">
          <Download size={16} />
          Download
        </a>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-full bg-white/15 p-2 text-white hover:bg-white/25">
          <X size={20} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <img src={attachment.url} alt={attachment.name} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>
  );
}

/** Press-and-hold menu on phones: react, reply, download. */
function ActionSheet({ item, onClose, onReply, onReact }: { item: ThreadItem; onClose: () => void; onReply: () => void; onReact: (emoji: string) => void }) {
  return (
    <div className="fixed inset-0 z-[65] flex items-end bg-[rgb(6_8_22/0.55)] backdrop-blur-[3px]" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Message actions"
        className="pop-in w-full rounded-t-[28px] border-t border-line bg-surface p-4 pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between gap-1">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} type="button" aria-label={`React ${e}`} onClick={() => onReact(e)} className="flex size-12 items-center justify-center rounded-full bg-subtle text-[24px]">
              {e}
            </button>
          ))}
        </div>
        <div className="mt-3 space-y-1">
          <button type="button" onClick={onReply} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] font-medium hover:bg-subtle">
            <Reply size={19} />
            Reply
          </button>
          {item.attachment && item.attachment.kind !== 'voice' && (
            <a
              href={`${item.attachment.url}?download=1`}
              download={item.attachment.name}
              onClick={onClose}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[15px] font-medium hover:bg-subtle"
            >
              <Download size={19} />
              Download
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function TypingLine({ text }: { text: string | null }) {
  return (
    <div className="h-6 shrink-0 px-4 md:px-6">
      {text && (
        <p className="mx-auto flex max-w-[860px] items-center gap-2 text-[13px] text-ink-soft">
          <span className="typing-dots text-brand dark:text-live" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          {text}
        </p>
      )}
    </div>
  );
}
