import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useOffline } from '../lib/liveness';

/** Shows "Reconnecting…" while the line is down (after a moment, so blips don't flash). */
export function ConnectionNotice() {
  const offline = useOffline();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!offline) return setShow(false);
    const id = window.setTimeout(() => setShow(true), 1500);
    return () => window.clearTimeout(id);
  }, [offline]);

  if (!show) return null;
  return (
    <div
      role="status"
      className="pop-in fixed top-[max(8px,env(safe-area-inset-top))] left-1/2 z-[55] flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-shutter-deep px-4 py-2 text-[13.5px] font-medium text-on-shutter shadow-lg"
    >
      <LoaderCircle size={15} className="animate-spin" />
      Reconnecting…
    </div>
  );
}
