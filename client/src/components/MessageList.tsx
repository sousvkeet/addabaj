import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, Check, CheckCheck, Clock, LoaderCircle, Phone, PhoneMissed, Video } from 'lucide-react';
import { clock, dayLabel, duration, sameDay } from '../lib/format';
import { Avatar } from './ui/Avatar';

export type ThreadItem = {
  key: string;
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
};

type Props = {
  items: ThreadItem[];
  loaded: boolean;
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadOlder: () => void;
  showSenders?: boolean;
  receipts?: boolean;
  onRetry: (item: ThreadItem) => void;
  onCallBack?: (video: boolean) => void;
  empty?: ReactNode;
};

const GROUP_GAP_MS = 5 * 60 * 1000;

export function MessageList({ items, loaded, hasMore, loadingMore, onLoadOlder, showSenders, receipts, onRetry, onCallBack, empty }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prev = useRef<{ first?: string; last?: string; height: number }>({ height: 0 });
  const [unseen, setUnseen] = useState(0);

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

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-3 pt-4 pb-3 md:px-6" role="log" aria-live="polite">
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
                    <span className="rounded-full bg-limewash px-3 py-0.5 text-[12.5px] font-medium text-ink-soft">{dayLabel(item.createdAt)}</span>
                  </p>
                )}
                <Message item={item} groupStart={groupStart} showSender={!!showSenders} receipts={!!receipts} onRetry={onRetry} onCallBack={onCallBack} />
              </div>
            );
          })}
        </div>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="pop-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-shutter px-3.5 py-1.5 text-[13.5px] font-semibold text-on-shutter shadow-lg"
        >
          <ArrowDown size={15} />
          {unseen === 1 ? 'New message' : `${unseen} new messages`}
        </button>
      )}
    </div>
  );
}

function Message({
  item, groupStart, showSender, receipts, onRetry, onCallBack,
}: {
  item: ThreadItem;
  groupStart: boolean;
  showSender: boolean;
  receipts: boolean;
  onRetry: (item: ThreadItem) => void;
  onCallBack?: (video: boolean) => void;
}) {
  if (item.kind === 'system') {
    return (
      <p className="mx-auto my-2.5 max-w-[85%] text-center text-[13px] text-ink-soft">
        {item.body}
        <span className="ml-1.5 opacity-70">{clock(item.createdAt)}</span>
      </p>
    );
  }

  if (item.kind === 'call') {
    const missed = item.callOutcome !== 'completed';
    return (
      <div className={`mt-3 flex ${item.mine ? 'justify-end' : ''}`}>
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-paper py-2.5 pr-4 pl-3">
          <span className={`flex size-9 items-center justify-center rounded-full ${missed ? 'bg-oxide/12 text-oxide' : 'bg-limewash text-shutter dark:text-taxi'}`}>
            {missed ? <PhoneMissed size={17} /> : item.callVideo ? <Video size={17} /> : <Phone size={17} />}
          </span>
          <span>
            <span className="block text-[14.5px] font-semibold">
              {item.callOutcome === 'completed'
                ? `${item.mine ? 'Outgoing' : 'Incoming'} ${item.callVideo ? 'video call' : 'call'}`
                : item.body}
            </span>
            <span className="block text-[12.5px] text-ink-soft">
              {item.callOutcome === 'completed' ? `${duration(item.callDuration ?? 0)} long, ` : ''}
              {clock(item.createdAt)}
            </span>
          </span>
          {onCallBack && !item.mine && missed && (
            <button type="button" onClick={() => onCallBack(!!item.callVideo)} className="ml-2 text-[13.5px] font-semibold text-shutter hover:underline dark:text-taxi">
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

  return (
    <div className={`flex items-end gap-2 ${item.mine ? 'justify-end' : ''} ${groupStart ? 'mt-3' : 'mt-[3px]'}`}>
      {showSender && !item.mine && (
        <span className="w-8 shrink-0 self-start">{groupStart && sender && <Avatar name={sender.name} hue={sender.hue} size={32} />}</span>
      )}
      <div className={`flex max-w-[min(78%,560px)] flex-col ${item.mine ? 'items-end' : 'items-start'}`}>
        {showName && (
          <span style={nameStyle} className="mb-0.5 ml-1 text-[13px] font-semibold text-[hsl(var(--h)_42%_34%)] dark:text-[hsl(var(--h)_50%_72%)]">
            {sender.name}
          </span>
        )}
        <div
          className={`px-3.5 py-2 text-[15px] leading-[1.45] ${
            item.mine
              ? 'rounded-[18px] rounded-br-[6px] bg-shutter text-on-shutter'
              : 'rounded-[18px] rounded-bl-[6px] border border-line bg-paper text-ink'
          } ${item.pending === 'failed' ? 'opacity-60' : ''}`}
        >
          <span className="break-words whitespace-pre-wrap">{item.body}</span>
          <span className={`float-right mt-[7px] ml-3 inline-flex items-center gap-1 text-[11.5px] leading-none ${item.mine ? 'text-on-shutter/70' : 'text-ink-soft'}`}>
            {clock(item.createdAt)}
            {item.mine &&
              (item.pending === 'sending' ? (
                <Clock size={13} aria-label="Sending" />
              ) : item.pending === 'failed' ? null : receipts && item.readAt ? (
                <CheckCheck size={15} className="text-taxi" aria-label="Read" />
              ) : (
                <Check size={14} aria-label="Sent" />
              ))}
          </span>
        </div>
        {item.pending === 'failed' && (
          <button type="button" onClick={() => onRetry(item)} className="mt-1 text-[13px] font-semibold text-oxide hover:underline">
            Not sent. Tap to retry
          </button>
        )}
      </div>
    </div>
  );
}

export function TypingLine({ text }: { text: string | null }) {
  return (
    <div className="h-6 shrink-0 px-4 md:px-6">
      {text && (
        <p className="mx-auto flex max-w-[860px] items-center gap-2 text-[13px] text-ink-soft">
          <span className="typing-dots text-shutter dark:text-taxi" aria-hidden>
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
