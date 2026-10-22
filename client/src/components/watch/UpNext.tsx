import { useState } from 'react';
import { ArrowUpToLine, ChevronDown, ListVideo, Play, SkipForward, Trash2, X } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { duration } from '../../lib/format';
import { emitAck } from '../../lib/socket';
import type { QueueItem, RoomDetail } from '../../lib/types';
import { toast } from '../../store/ui';
import { Button } from '../ui/Button';
import { Menu } from '../ui/Menu';

/**
 * Up next: the videos queued to play after the current one, in order. The
 * room moves on to the next by itself when a video ends. Everyone sees the
 * list; admins play, reorder, remove and skip.
 */
export function UpNext({ room }: { room: RoomDetail }) {
  const queue = room.queue ?? [];
  const isAdmin = room.myRole === 'admin';
  const [open, setOpen] = useState(false);
  if (!queue.length) return null;

  const act = (event: string, payload: object = {}) =>
    emitAck(event, { roomId: room.id, ...payload }, 60_000).catch((err) => toast(errorMessage(err), 'error'));
  const rest = queue.length - 1;

  return (
    <section aria-label="Up next" className="shrink-0 border-b border-line bg-surface/70">
      <div className="flex items-center gap-2 py-1.5 pr-3 pl-4">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left">
          <ListVideo size={17} className="shrink-0 text-brand dark:text-live" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[14px]">
            <span className="font-semibold">Up next</span>
            <span className="text-ink-soft">
              {' · '}
              {open ? `${queue.length} ${queue.length === 1 ? 'video' : 'videos'}` : `${queue[0].title}${rest ? ` and ${rest} more` : ''}`}
            </span>
          </span>
          <ChevronDown size={16} className={`shrink-0 text-ink-soft transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        {isAdmin && (
          <Button size="sm" variant="soft" onClick={() => void act('watch:next')} title="Play the next video now">
            <SkipForward size={15} />
            Next
          </Button>
        )}
      </div>
      {open && (
        <ol className="max-h-[38dvh] overflow-y-auto px-2 pb-2">
          {queue.map((item, i) => (
            <li key={item.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
              <span className="w-5 shrink-0 text-center text-[12.5px] text-ink-soft tabular-nums">{i + 1}</span>
              <Thumbnail item={item} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{item.title}</p>
                <p className="truncate text-[12.5px] text-ink-soft">
                  {[item.duration ? duration(item.duration) : null, item.site, `added by ${item.addedBy.name}`].filter(Boolean).join(' · ')}
                </p>
              </div>
              {isAdmin && (
                <Menu
                  label={`Actions for ${item.title}`}
                  items={[
                    { label: 'Play now', icon: <Play size={16} />, onSelect: () => void act('watch:queue-play', { itemId: item.id }) },
                    ...(i > 0
                      ? [{ label: 'Play next', icon: <ArrowUpToLine size={16} />, onSelect: () => void act('watch:queue-move', { itemId: item.id, to: 0 }) }]
                      : []),
                    { label: 'Remove', icon: <X size={16} />, danger: true, onSelect: () => void act('watch:queue-remove', { itemId: item.id }) },
                  ]}
                />
              )}
            </li>
          ))}
          {isAdmin && queue.length > 1 && (
            <li className="flex justify-end px-2 pt-1">
              <Button size="sm" variant="danger-ghost" onClick={() => void act('watch:queue-clear')}>
                <Trash2 size={15} />
                Clear Up next
              </Button>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

function Thumbnail({ item }: { item: QueueItem }) {
  const [broken, setBroken] = useState(false);
  if (!item.thumbnail || broken) {
    return (
      <span className="flex aspect-video w-16 shrink-0 items-center justify-center rounded-md bg-subtle text-ink-soft" aria-hidden>
        <Play size={15} />
      </span>
    );
  }
  return (
    <img
      src={item.thumbnail}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setBroken(true)}
      className="aspect-video w-16 shrink-0 rounded-md bg-subtle object-cover"
    />
  );
}
