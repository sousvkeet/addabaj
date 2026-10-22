import { useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { emitAck } from '../../lib/socket';
import type { WatchState } from '../../lib/types';
import { toast } from '../../store/ui';
import { Button } from '../ui/Button';

// An admin can turn the room's video sound off for everyone (and back on).
// Everyone's player is then muted, whatever their own mute and volume say;
// those come back when the sound is turned on again.

/** The admins' button, under the video. */
export function MuteForEveryone({ roomId, watch }: { roomId: string; watch: WatchState }) {
  const [busy, setBusy] = useState(false);
  const muted = !!watch.muted;

  async function toggle() {
    setBusy(true);
    try {
      await emitAck('watch:mute', { roomId, muted: !muted });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const label = muted ? 'Unmute for everyone' : 'Mute for everyone';
  // The icon shows the sound as it is (lit while it's off); the label, what a
  // tap does. Just the icon where the bar under the video is narrow (a phone,
  // or beside the room's details), so its buttons stay on one line.
  return (
    <Button size="sm" variant={muted ? 'live' : 'on-dark'} title={label} disabled={busy} onClick={() => void toggle()} className="@max-lg:px-2.5">
      {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
      <span className="@max-lg:sr-only">{label}</span>
    </Button>
  );
}

/** On the video while its sound is off for everyone; just the icon in the small player. */
export function MutedForEveryone({ watch, small = false, className = 'top-2 left-2' }: { watch: WatchState; small?: boolean; className?: string }) {
  if (!watch.muted) return null;
  return (
    <span
      role="status"
      className={`pointer-events-none absolute flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-black/60 text-[12px] font-semibold text-white ${
        small ? 'p-1.5' : 'px-2.5 py-1'
      } ${className}`}
    >
      <VolumeX size={13} className="shrink-0" aria-hidden />
      <span className={small ? 'sr-only' : 'truncate'}>Muted for everyone by {watch.muted.byName}</span>
    </span>
  );
}

/** Someone's own sound button while the sound is off for everyone. */
export const mutedForEveryone = (watch: WatchState, isAdmin = false) =>
  toast(
    `${watch.muted?.byName ?? 'An admin'} muted the video for everyone. ${
      isAdmin ? 'Turn its sound back on with “Unmute for everyone”.' : 'Only an admin can turn its sound back on.'
    }`,
  );
