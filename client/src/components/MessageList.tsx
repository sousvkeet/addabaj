import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowDown, Ban, Check, CheckCheck, Clock, Copy, Download, FileText, Info, LoaderCircle, Phone, PhoneMissed, Reply, SmilePlus, Trash2, Video, X,
} from 'lucide-react';
import { attachmentLabel, clock, dayLabel, deletedText, duration, formatBytes, sameDay } from '../lib/format';
import { haptic, inApp } from '../lib/native';
import { toast } from '../store/ui';
import type { Attachment, Draft, Reaction, Receipt, ReplyRef } from '../lib/types';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
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
  /** For my messages: sent, delivered or read. */
  receipt?: Receipt;
  /** Under my latest room message: "Seen by Rahul and Mitali". */
  seenBy?: string;
  pending?: 'sending' | 'failed';
  callOutcome?: 'completed' | 'missed' | 'declined';
  callDuration?: number;
  callVideo?: boolean;
  attachment?: Attachment | null;
  replyTo?: ReplyRef | null;
  reactions?: Reaction[];
  upload?: number;
  draft?: Draft;
  /** Deleted for everyone: shown as "This message was deleted". */
  deleted?: boolean;
  deletedByAdmin?: boolean;
  /** I may delete it for everyone (my own, recent; or anyone's, as a room admin). */
  canDeleteForEveryone?: boolean;
};

type Props = {
  items: ThreadItem[];
  loaded: boolean;
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadOlder: () => void;
  showSenders?: boolean;
  meId: string;
  onRetry: (item: ThreadItem) => void;
  onReply: (item: ThreadItem) => void;
  onReact: (item: ThreadItem, emoji: string) => void;
  /** "Message info" for my messages: when it was delivered and read, and by whom. */
  onInfo?: (item: ThreadItem) => void;
  onCallBack?: (video: boolean) => void;
  /** Delete for me, or for everyone; resolves true once done. */
  onDelete?: (item: ThreadItem, forEveryone: boolean) => Promise<boolean>;
  empty?: ReactNode;
};

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
/** Your own messages can be deleted for everyone this long after sending (the server checks too). */
export const DELETE_FOR_EVERYONE_MS = 48 * 60 * 60 * 1000;
export const recentEnoughToDelete = (createdAt: string) => Date.now() - new Date(createdAt).getTime() < DELETE_FOR_EVERYONE_MS;
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
  items, loaded, hasMore, loadingMore, onLoadOlder, showSenders, meId, onRetry, onReply, onReact, onInfo, onCallBack, onDelete, empty,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prev = useRef<{ first?: string; last?: string; height: number }>({ height: 0 });
  const [unseen, setUnseen] = useState(0);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [sheetFor, setSheetFor] = useState<ThreadItem | null>(null);
  const [deleting, setDeleting] = useState<ThreadItem | null>(null);

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
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-x-hidden overflow-y-auto px-3 pt-5 pb-3 md:px-7" role="log" aria-live="polite">
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
                  meId={meId}
                  onRetry={onRetry}
                  onReply={onReply}
                  onInfo={onInfo}
                  onReact={onReact}
                  onOpenSheet={setSheetFor}
                  onView={setViewing}
                  onJump={jumpTo}
                  onCallBack={onCallBack}
                  onDelete={onDelete ? setDeleting : undefined}
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
          onInfo={
            onInfo && sheetFor.mine
              ? () => {
                  onInfo(sheetFor);
                  setSheetFor(null);
                }
              : undefined
          }
          onReact={(emoji) => {
            onReact(sheetFor, emoji);
            setSheetFor(null);
          }}
          onDelete={
            onDelete
              ? () => {
                  setDeleting(sheetFor);
                  setSheetFor(null);
                }
              : undefined
          }
        />
      )}
      {onDelete && <DeleteDialog item={deleting} onClose={() => setDeleting(null)} onDelete={onDelete} />}
    </div>
  );
}

// ── Touch: press and hold, swipe to reply ───────────────────────────

/** How far a message is swiped (px) before letting go replies to it. */
const SWIPE_TO_REPLY = 64;

/**
 * Touch screens, as in other messengers: press and hold a message for its menu
 * (with a little buzz), or swipe it to the right to reply. A finger that
 * wobbles a little still counts as holding; moving up or down scrolls.
 */
function useTouchGestures(onHold: (() => void) | null, onSwipe: (() => void) | null) {
  const moving = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLSpanElement>(null);
  const g = useRef<{ x: number; y: number; dx: number; swiping: boolean; armed: boolean; timer: number } | null>(null);

  const paint = (dx: number, animate: boolean) => {
    const el = moving.current;
    const h = hint.current;
    const pull = dx <= SWIPE_TO_REPLY ? dx : SWIPE_TO_REPLY + (dx - SWIPE_TO_REPLY) * 0.25;
    const t = animate ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 220ms' : 'none';
    if (el) {
      el.style.transition = t;
      el.style.transform = pull ? `translateX(${pull}px)` : '';
    }
    if (h) {
      const p = Math.min(1, dx / SWIPE_TO_REPLY);
      h.style.transition = t;
      h.style.opacity = String(p);
      h.style.transform = `translateY(-50%) scale(${0.5 + p * 0.5})`;
    }
  };
  const stop = () => {
    const s = g.current;
    g.current = null;
    if (s) window.clearTimeout(s.timer);
    return s;
  };

  if (!onHold && !onSwipe) return { moving, hint, handlers: {} };
  return {
    moving,
    hint,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        stop();
        g.current = {
          x: e.clientX,
          y: e.clientY,
          dx: 0,
          swiping: false,
          armed: false,
          timer: onHold
            ? window.setTimeout(() => {
                if (g.current?.swiping) return;
                g.current = null;
                haptic('press');
                onHold();
              }, 420)
            : 0,
        };
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = g.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (!s.swiping) {
          if (Math.hypot(dx, dy) > 10) window.clearTimeout(s.timer);
          if (onSwipe && dx > 12 && dx > Math.abs(dy) * 1.5) s.swiping = true;
          else if (Math.abs(dy) > 12 || dx < -12) return void stop();
          else return;
        }
        s.dx = Math.max(0, dx);
        paint(s.dx, false);
        if (!s.armed && s.dx >= SWIPE_TO_REPLY) {
          s.armed = true;
          haptic('tick');
        } else if (s.armed && s.dx < SWIPE_TO_REPLY) {
          s.armed = false;
        }
      },
      onPointerUp: () => {
        const s = stop();
        if (!s?.swiping) return;
        paint(0, true);
        if (s.armed) onSwipe?.();
      },
      onPointerCancel: () => {
        if (stop()?.swiping) paint(0, true);
      },
      onContextMenu: (e: React.MouseEvent) => {
        if ((e.nativeEvent as PointerEvent).pointerType === 'touch') e.preventDefault();
      },
    },
  };
}

/** The reply arrow that fades in beside a message as it's swiped. */
function SwipeHint({ hint }: { hint: React.RefObject<HTMLSpanElement | null> }) {
  return (
    <span
      ref={hint}
      aria-hidden
      className="pointer-events-none absolute top-1/2 left-1 flex size-8 items-center justify-center rounded-full bg-subtle text-ink-soft opacity-0"
      style={{ transform: 'translateY(-50%) scale(0.5)' }}
    >
      <Reply size={16} />
    </span>
  );
}

// ── One message ──────────────────────────────────────────────────────

type MessageProps = {
  item: ThreadItem;
  groupStart: boolean;
  showSender: boolean;
  meId: string;
  onRetry: (item: ThreadItem) => void;
  onReply: (item: ThreadItem) => void;
  onInfo?: (item: ThreadItem) => void;
  onReact: (item: ThreadItem, emoji: string) => void;
  onOpenSheet: (item: ThreadItem) => void;
  onView: (a: Attachment) => void;
  onJump: (id: number) => void;
  onCallBack?: (video: boolean) => void;
  onDelete?: (item: ThreadItem) => void;
};

function Message(props: MessageProps) {
  const { item, groupStart, showSender, meId, onRetry, onReply, onInfo, onReact, onOpenSheet, onView, onJump, onCallBack, onDelete } = props;
  const [picking, setPicking] = useState(false);
  const canAct = item.id > 0 && !item.pending && !item.deleted && item.kind === 'text';
  const touch = useTouchGestures(canAct ? () => onOpenSheet(item) : null, canAct ? () => onReply(item) : null);

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

  if (item.deleted) return <DeletedMessage {...props} />;

  const sender = item.sender;
  const showName = showSender && !item.mine && groupStart && sender;
  const nameStyle = sender ? ({ '--h': sender.hue } as CSSProperties) : undefined;
  const a = item.attachment;
  const media = a && (a.kind === 'image' || a.kind === 'video');

  return (
    <div id={item.id ? `msg-${item.id}` : undefined} className={`group relative flex items-end gap-2 rounded-xl ${item.mine ? 'justify-end' : ''} ${groupStart ? 'mt-3' : 'mt-[3px]'}`}>
      {canAct && <SwipeHint hint={touch.hint} />}
      {showSender && !item.mine && (
        <span className="w-8 shrink-0 self-start">{groupStart && sender && <Avatar name={sender.name} hue={sender.hue} size={32} />}</span>
      )}
      {item.mine && canAct && (
        <Actions
          picking={picking}
          setPicking={setPicking}
          onReply={() => onReply(item)}
          onReact={(e) => onReact(item, e)}
          onInfo={onInfo ? () => onInfo(item) : undefined}
          onDelete={onDelete ? () => onDelete(item) : undefined}
        />
      )}
      <div ref={touch.moving} {...touch.handlers} className={`flex max-w-[min(78%,560px)] touch-pan-y flex-col ${item.mine ? 'items-end' : 'items-start'}`}>
        {showName && (
          <span style={nameStyle} className="mb-1 ml-1 text-[12.5px] font-bold text-[hsl(var(--h)_75%_32%)] dark:text-[hsl(var(--h)_90%_74%)]">
            {sender.name}
          </span>
        )}
        <div
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
                {item.replyTo.deleted ? 'This message was deleted' : item.replyTo.body || (item.replyTo.attachment ? attachmentLabel(item.replyTo.attachment) : '')}
              </span>
            </button>
          )}
          {a && (
            <div className="relative">
              <AttachmentView attachment={a} mine={item.mine} upload={item.pending === 'sending' ? item.upload : undefined} onView={onView} />
              {/* A photo without a caption carries its time on the picture. */}
              {a.kind === 'image' && !item.body && <Meta item={item} overlay />}
            </div>
          )}
          {(item.body || !a) && (
            <div className={media ? 'px-2.5 pt-1.5 pb-1' : a ? 'pt-1.5' : ''}>
              <span className="break-words whitespace-pre-wrap">{item.body}</span>
              <Meta item={item} />
            </div>
          )}
          {a && a.kind !== 'image' && !item.body && (
            <div className={`flex justify-end ${media ? 'px-2 pb-0.5' : ''}`}>
              <Meta item={item} />
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
        {item.seenBy && (
          <button
            type="button"
            onClick={() => onInfo?.(item)}
            className="mt-1 flex items-center gap-1 text-[12px] font-medium text-ink-soft hover:text-ink hover:underline"
          >
            <CheckCheck size={13} className="text-live-ink" />
            {item.seenBy}
          </button>
        )}
      </div>
      {!item.mine && canAct && (
        <Actions
          picking={picking}
          setPicking={setPicking}
          onReply={() => onReply(item)}
          onReact={(e) => onReact(item, e)}
          onDelete={onDelete ? () => onDelete(item) : undefined}
        />
      )}
    </div>
  );
}

function Meta({ item, overlay }: { item: ThreadItem; overlay?: boolean }) {
  const place = overlay
    ? 'pointer-events-none absolute right-2 bottom-2 rounded-full bg-black/50 px-2 py-[3px] text-white'
    : `float-right mt-[7px] ml-3 ${item.mine ? 'text-white/75' : 'text-ink-soft'}`;
  return (
    <span className={`inline-flex items-center gap-1 text-[11.5px] leading-none ${place}`}>
      {clock(item.createdAt)}
      {item.mine &&
        (item.pending === 'sending' ? (
          <Clock size={13} aria-label="Sending" />
        ) : item.pending === 'failed' ? null : (
          <Ticks receipt={item.receipt ?? 'sent'} />
        ))}
    </span>
  );
}

/** One tick: sent. Two: delivered to their device. Two in colour: read. */
function Ticks({ receipt }: { receipt: Receipt }) {
  if (receipt === 'read') return <CheckCheck size={15} strokeWidth={2.6} className="text-tick-read" aria-label="Read" />;
  if (receipt === 'delivered') return <CheckCheck size={15} aria-label="Delivered" />;
  return <Check size={14} aria-label="Sent" />;
}

/** Reply and react buttons beside a message (shown on hover or keyboard focus). */
function Actions({
  picking,
  setPicking,
  onReply,
  onReact,
  onInfo,
  onDelete,
}: {
  picking: boolean;
  setPicking: (v: boolean) => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onInfo?: () => void;
  onDelete?: () => void;
}) {
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
      {onInfo && (
        <button type="button" aria-label="Message info" onClick={onInfo} className="rounded-full p-1.5 text-ink-soft hover:bg-subtle hover:text-ink">
          <Info size={16} />
        </button>
      )}
      {onDelete && (
        <button type="button" aria-label="Delete message" onClick={onDelete} className="rounded-full p-1.5 text-ink-soft hover:bg-danger/10 hover:text-danger">
          <Trash2 size={16} />
        </button>
      )}
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

/**
 * Touch, as in phone photo viewers: pinch to zoom, drag to look around a
 * zoomed photo, double-tap to zoom in or out, and swipe down to close.
 */
function usePhotoGestures(onClose: () => void) {
  const img = useRef<HTMLImageElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; mid: { x: number; y: number }; x: number; y: number } | null>(null);
  const lastTap = useRef(0);

  const apply = (animate = false, dismissY = 0) => {
    const el = img.current;
    if (!el) return;
    const { scale, x, y } = view.current;
    el.style.transition = animate ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
    el.style.transform = `translate(${x}px, ${y + dismissY}px) scale(${scale})`;
    if (backdrop.current) backdrop.current.style.opacity = String(1 - Math.min(0.7, Math.abs(dismissY) / 400));
  };
  const zoomTo = (scale: number, at?: { x: number; y: number }) => {
    const v = view.current;
    if (scale <= 1) Object.assign(v, { scale: 1, x: 0, y: 0 });
    else if (at) {
      // Keep the tapped point under the finger.
      const cx = at.x - window.innerWidth / 2;
      const cy = at.y - window.innerHeight / 2;
      Object.assign(v, { x: cx - ((cx - v.x) * scale) / v.scale, y: cy - ((cy - v.y) * scale) / v.scale, scale });
    }
    apply(true);
  };
  const two = () => [...pointers.current.values()];
  const span = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  return {
    img,
    backdrop,
    zoomed: () => view.current.scale > 1,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        // Touch pointers stay with what they first touched, so a tap on the photo is still its own click.
        if (e.pointerType === 'mouse') return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const v = view.current;
        const pts = two();
        if (pts.length === 2) {
          gesture.current = { dist: span(pts[0], pts[1]), scale: v.scale, mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, x: v.x, y: v.y };
        } else {
          gesture.current = { dist: 0, scale: v.scale, mid: { x: e.clientX, y: e.clientY }, x: v.x, y: v.y };
        }
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!pointers.current.has(e.pointerId) || !gesture.current) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current;
        const v = view.current;
        const pts = two();
        if (pts.length === 2 && g.dist) {
          const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
          v.scale = Math.min(5, Math.max(0.8, (g.scale * span(pts[0], pts[1])) / g.dist));
          v.x = g.x + (mid.x - g.mid.x);
          v.y = g.y + (mid.y - g.mid.y);
          apply();
        } else if (pts.length === 1) {
          const dx = e.clientX - g.mid.x;
          const dy = e.clientY - g.mid.y;
          if (v.scale > 1) {
            v.x = g.x + dx;
            v.y = g.y + dy;
            apply();
          } else {
            apply(false, dy);
          }
        }
      },
      onPointerUp: (e: React.PointerEvent) => {
        const g = gesture.current;
        const start = g?.mid;
        pointers.current.delete(e.pointerId);
        if (pointers.current.size) {
          // One finger left after a pinch: carry on panning from here.
          const [p] = two();
          const v = view.current;
          gesture.current = { dist: 0, scale: v.scale, mid: p, x: v.x, y: v.y };
          return;
        }
        gesture.current = null;
        const v = view.current;
        const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : 0;
        if (v.scale === 1 && start && e.clientY - start.y > 110) return onClose();
        if (v.scale < 1) zoomTo(1);
        else apply(true);
        // Double tap: zoom in where tapped, or back out.
        if (moved < 10 && g?.dist === 0) {
          const now = Date.now();
          if (now - lastTap.current < 300) {
            lastTap.current = 0;
            zoomTo(v.scale > 1 ? 1 : 2.5, { x: e.clientX, y: e.clientY });
          } else {
            lastTap.current = now;
          }
        }
      },
      onPointerCancel: (e: React.PointerEvent) => {
        pointers.current.delete(e.pointerId);
        gesture.current = null;
        apply(true);
      },
    },
  };
}

/** A photo shown full screen, with a download button. */
function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const photo = usePhotoGestures(onClose);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={attachment.name} className="fixed inset-0 z-[70] flex flex-col" onClick={onClose}>
      <div ref={photo.backdrop} aria-hidden className="absolute inset-0 bg-[rgb(4_6_18/0.94)] backdrop-blur-md" />
      <div className="relative flex shrink-0 items-center justify-end gap-2 p-3 pt-[max(12px,env(safe-area-inset-top))]" onClick={(e) => e.stopPropagation()}>
        <a href={`${attachment.url}?download=1`} download={attachment.name} className="flex items-center gap-2 rounded-full bg-white/15 px-3.5 py-2 text-[14px] font-semibold text-white hover:bg-white/25">
          <Download size={16} />
          Download
        </a>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-full bg-white/15 p-2 text-white hover:bg-white/25">
          <X size={20} />
        </button>
      </div>
      {/* Tapping beside the photo closes it (unless zoomed in). */}
      <div
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center p-4"
        {...photo.handlers}
        onClick={(e) => {
          e.stopPropagation();
          if (e.target === e.currentTarget && !photo.zoomed()) onClose();
        }}
      >
        <img ref={photo.img} src={attachment.url} alt={attachment.name} draggable={false} className="max-h-full max-w-full object-contain will-change-transform" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>
  );
}

/** Copies text, with the old way for WebViews without the clipboard API. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  }
}

/** Press-and-hold menu on phones: react, reply, copy, download. */
function ActionSheet({
  item,
  onClose,
  onReply,
  onReact,
  onInfo,
  onDelete,
}: {
  item: ThreadItem;
  onClose: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onInfo?: () => void;
  onDelete?: () => void;
}) {
  // Only a tap that starts on the backdrop closes it: lifting the finger that just opened it doesn't.
  const fromBackdrop = useRef(false);
  return (
    <div
      className="fixed inset-0 z-[65] flex items-end bg-[rgb(6_8_22/0.55)] backdrop-blur-[3px]"
      onPointerDown={(e) => (fromBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => e.target === e.currentTarget && fromBackdrop.current && onClose()}
    >
      <div
        role="dialog"
        aria-label="Message actions"
        className="pop-in w-full rounded-t-[28px] border-t border-line bg-surface p-4 pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        {!item.deleted && (
        <div className="flex justify-between gap-1">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} type="button" aria-label={`React ${e}`} onClick={() => onReact(e)} className="flex size-12 items-center justify-center rounded-full bg-subtle text-[24px]">
              {e}
            </button>
          ))}
        </div>
        )}
        <div className={`space-y-1 ${item.deleted ? '' : 'mt-3'}`}>
          {!item.deleted && (
            <button type="button" onClick={onReply} className="ripple flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] font-medium hover:bg-subtle">
              <Reply size={19} />
              Reply
            </button>
          )}
          {!item.deleted && item.body && (
            <button
              type="button"
              onClick={() => {
                onClose();
                void copyText(item.body).then((ok) => {
                  // Android 13 and newer confirm copying themselves.
                  if (!ok) toast("Couldn't copy that message.", 'error');
                  else if (!(inApp && Number(/Android (\d+)/.exec(navigator.userAgent)?.[1]) >= 13)) toast('Message copied');
                });
              }}
              className="ripple flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] font-medium hover:bg-subtle"
            >
              <Copy size={19} />
              Copy
            </button>
          )}
          {onInfo && (
            <button type="button" onClick={onInfo} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] font-medium hover:bg-subtle">
              <Info size={19} />
              Message info
            </button>
          )}
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
          {onDelete && (
            <button type="button" onClick={onDelete} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] font-medium text-danger hover:bg-danger/10">
              <Trash2 size={19} />
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where a message was deleted for everyone: a quiet marker that keeps its place. */
function DeletedMessage({ item, groupStart, showSender, onOpenSheet, onDelete }: MessageProps) {
  const sender = item.sender;
  const canAct = item.id > 0 && !!onDelete;
  const touch = useTouchGestures(canAct ? () => onOpenSheet(item) : null, null);
  const remove = canAct ? (
    <button
      type="button"
      aria-label="Delete message"
      onClick={() => onDelete!(item)}
      className="mb-1 hidden shrink-0 self-center rounded-full p-1.5 text-ink-soft opacity-0 group-hover:opacity-100 hover:bg-danger/10 hover:text-danger focus:opacity-100 [@media(hover:hover)]:block"
    >
      <Trash2 size={16} />
    </button>
  ) : null;
  return (
    <div id={item.id ? `msg-${item.id}` : undefined} className={`group flex items-end gap-2 ${item.mine ? 'justify-end' : ''} ${groupStart ? 'mt-3' : 'mt-[3px]'}`}>
      {showSender && !item.mine && (
        <span className="w-8 shrink-0 self-start">{groupStart && sender && <Avatar name={sender.name} hue={sender.hue} size={32} />}</span>
      )}
      {item.mine && remove}
      <div className={`flex max-w-[min(78%,560px)] flex-col ${item.mine ? 'items-end' : 'items-start'}`}>
        {showSender && !item.mine && groupStart && sender && (
          <span className="mb-1 ml-1 text-[12.5px] font-bold text-ink-soft">{sender.name}</span>
        )}
        <div
          {...touch.handlers}
          role="note"
          className="flex items-center gap-2 rounded-[22px] border border-dashed border-line bg-subtle/40 px-4 py-2 text-[14px] text-ink-soft italic"
        >
          <Ban size={14} className="shrink-0" aria-hidden />
          <span>{deletedText(item.mine, item.deletedByAdmin)}</span>
          <span className="ml-1 text-[11.5px] not-italic opacity-80">{clock(item.createdAt)}</span>
        </div>
      </div>
      {!item.mine && remove}
    </div>
  );
}

/** "Delete message?": for everyone (when allowed) or just for me. */
function DeleteDialog({
  item,
  onClose,
  onDelete,
}: {
  item: ThreadItem | null;
  onClose: () => void;
  onDelete: (item: ThreadItem, forEveryone: boolean) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<'everyone' | 'me' | null>(null);
  const run = async (forEveryone: boolean) => {
    if (!item) return;
    setBusy(forEveryone ? 'everyone' : 'me');
    const ok = await onDelete(item, forEveryone);
    setBusy(null);
    if (ok) onClose();
  };
  const everyone = !!item && !item.deleted && !!item.canDeleteForEveryone;
  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      width={400}
      title="Delete message?"
      description={
        everyone
          ? 'Delete it for everyone in this chat, or only from your own view.'
          : item?.deleted
            ? 'This removes the marker from your view.'
            : 'This removes it from your view. Others in the chat still see it.'
      }
    >
      <div className="flex flex-col gap-2">
        {everyone && (
          <Button variant="danger" busy={busy === 'everyone'} disabled={!!busy} onClick={() => void run(true)}>
            Delete for everyone
          </Button>
        )}
        <Button variant={everyone ? 'soft' : 'danger'} busy={busy === 'me'} disabled={!!busy} onClick={() => void run(false)}>
          Delete for me
        </Button>
        <Button variant="ghost" disabled={!!busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Dialog>
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
