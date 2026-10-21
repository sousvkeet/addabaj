import { useEffect, useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useOffline } from '../lib/liveness';

/**
 * "Connecting…" (or "Waiting for network…" with no connection at all) while
 * the line to the server is down; null otherwise. After a moment, so blips
 * don't flash.
 */
export function useConnectionLabel() {
  const offline = useOffline();
  const [show, setShow] = useState(false);
  const [network, setNetwork] = useState(navigator.onLine);

  useEffect(() => {
    const update = () => setNetwork(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const down = offline || !network;
  useEffect(() => {
    if (!down) return setShow(false);
    const id = window.setTimeout(() => setShow(true), 1500);
    return () => window.clearTimeout(id);
  }, [down]);

  return show ? (network ? 'Connecting…' : 'Waiting for network…') : null;
}

/** Wider screens: a notice floating at the top. (Phones show it in the header instead; see StatusLine.) */
export function ConnectionNotice() {
  const label = useConnectionLabel();
  if (!label) return null;
  return (
    <div
      role="status"
      className="pop-in fixed top-[max(8px,env(safe-area-inset-top))] left-1/2 z-[55] hidden -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full glass-deep border border-white/10 px-4 py-2 text-[13.5px] font-medium text-on-brand shadow-float md:flex"
    >
      <LoaderCircle size={15} className="animate-spin" />
      {label}
    </div>
  );
}

/**
 * A header's second line on phones, as in other messengers: the connection
 * state while the line is down, otherwise `children` (last seen, members…).
 */
export function StatusLine({ children }: { children?: ReactNode }) {
  const label = useConnectionLabel();
  if (!label) return <>{children}</>;
  return (
    <>
      <span role="status" className="inline-flex items-center gap-1.5 md:hidden">
        <LoaderCircle size={12} className="animate-spin" />
        {label}
      </span>
      <span className="hidden md:contents">{children}</span>
    </>
  );
}
