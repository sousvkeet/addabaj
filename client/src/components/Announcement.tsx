import { Megaphone, X } from 'lucide-react';
import { useSite } from '../lib/site';

/** The host's announcement, at the top of the conversation panel until dismissed. */
export function Announcement() {
  const announcement = useSite((s) => s.announcement);
  const dismissed = useSite((s) => s.dismissed);
  const dismiss = useSite((s) => s.dismiss);
  if (!announcement || dismissed === announcement.id) return null;
  return (
    <div role="status" className="pop-in relative z-20 flex shrink-0 items-start gap-3 bg-aurora px-4 py-2.5 text-white md:px-6">
      <Megaphone size={18} className="mt-0.5 shrink-0" />
      <p className="min-w-0 flex-1 text-[14px]">
        <span className="mr-1.5 font-bold">From the host:</span>
        {announcement.text}
      </p>
      <button type="button" onClick={dismiss} aria-label="Dismiss announcement" className="-my-1 rounded-full p-1.5 hover:bg-white/15">
        <X size={16} />
      </button>
    </div>
  );
}
