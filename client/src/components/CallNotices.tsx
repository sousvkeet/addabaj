import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { X } from 'lucide-react';
import { useCall } from '../store/call';
import { useCallNotices, type CallNotice } from '../store/callNotices';
import { useVoice } from '../store/voice';
import { useCallStageOpen } from './CallUi';
import { useRoomStageOpen } from './RoomCall';
import { Avatar } from './ui/Avatar';

/**
 * Messages that arrive while a call's video window covers the app (a room's
 * call with cameras on, or a one-to-one video call), as banners over it, like
 * a phone's notifications. Tapping one shrinks the call to its bar and opens
 * the chat; each goes by itself after a few seconds.
 */
export function CallNotices() {
  const roomOpen = useRoomStageOpen();
  const callOpen = useCallStageOpen();
  const open = roomOpen || callOpen;
  const notices = useCallNotices((s) => s.notices);
  const dismiss = useCallNotices((s) => s.dismiss);
  const navigate = useNavigate();

  // Shrunk or over: the chats are in view again, so the banners go.
  useEffect(() => {
    useCallNotices.setState({ windowOpen: open });
    if (!open) useCallNotices.getState().clear();
  }, [open]);

  if (!open || !notices.length) return null;

  function show(n: CallNotice) {
    dismiss(n.key);
    if (roomOpen) useVoice.getState().setMinimized(true);
    if (callOpen) useCall.getState().setMinimized(true);
    navigate(n.scope === 'dm' ? `/chats/${n.chatId}` : `/rooms/${n.chatId}`);
  }

  return (
    <div
      aria-live="polite"
      aria-label="New messages"
      className="pointer-events-none fixed inset-x-0 top-[max(10px,var(--safe-top))] z-[55] flex flex-col items-center gap-2 px-3"
    >
      {notices.map((n) => (
        <div
          key={n.key}
          className="pop-in glass-deep pointer-events-auto flex w-full max-w-md items-center gap-1 rounded-[20px] border border-white/10 py-2 pr-1.5 pl-2.5 text-on-brand shadow-[0_18px_44px_-14px_rgb(4_6_18/0.75)]"
        >
          <button
            type="button"
            onClick={() => show(n)}
            aria-label={`${n.sender.name}${n.room ? ` in ${n.room}` : ''}: ${n.text}. Open the chat`}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <Avatar name={n.sender.name} hue={n.sender.hue} photo={n.sender.photo} size={38} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5 text-[13.5px]">
                <span className="truncate font-semibold">{n.sender.name}</span>
                {n.room && <span className="min-w-0 truncate opacity-70">· {n.room}</span>}
                {n.count > 1 && (
                  <span className="ml-auto shrink-0 rounded-full bg-white/15 px-1.5 text-[11.5px] leading-[18px] font-bold tabular-nums" aria-hidden>
                    {n.count}
                  </span>
                )}
              </span>
              <span className="line-clamp-2 block text-[14px] leading-snug break-words opacity-90">{n.text}</span>
            </span>
          </button>
          <button type="button" aria-label={`Dismiss ${n.sender.name}${n.room ? ` in ${n.room}` : ''}`} onClick={() => dismiss(n.key)} className="shrink-0 rounded-full p-1.5 opacity-70 hover:bg-white/10 hover:opacity-100">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
