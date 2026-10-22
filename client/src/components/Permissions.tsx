import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, BatteryCharging, Bell, Check, Mic, MoonStar, PhoneCall, Video } from 'lucide-react';
import { useBackClose } from '../lib/back';
import type { AppPermissions, PermissionName } from '../lib/native';
import { LATER, ORDER, missing, usePermissions } from '../store/permissions';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Logo } from './ui/Logo';

const ABOUT: Record<PermissionName, { title: string; hint: string; icon: ReactNode }> = {
  notifications: { title: 'Notifications', hint: 'Messages and calls, even when the app is closed.', icon: <Bell size={20} /> },
  microphone: { title: 'Microphone', hint: 'Calls, room voice and voice messages.', icon: <Mic size={20} /> },
  camera: { title: 'Camera', hint: 'Video calls and room video.', icon: <Video size={20} /> },
  fullScreen: { title: 'Calls on the lock screen', hint: 'Calls ring full screen, like a phone call.', icon: <PhoneCall size={20} /> },
  battery: { title: 'Run in the background', hint: 'Calls still ring when the phone saves battery.', icon: <BatteryCharging size={20} /> },
  background: {
    title: 'Background activity',
    hint: 'Not restricted, so messages, calls and room voice go on when you leave the app.',
    icon: <Activity size={20} />,
  },
  samsung: {
    title: 'Never sleeping (Samsung)',
    hint: 'In Battery › Background usage limits, add Adda Khana to Never sleeping apps.',
    icon: <MoonStar size={20} />,
  },
};

/** "All allowed", or what's still off. */
export function permissionsSummary(state: AppPermissions | null) {
  const off = missing(state);
  if (!off.length) return 'All allowed';
  const names = off.map((p) => ABOUT[p].title.toLowerCase());
  return `${names[0][0].toUpperCase()}${names[0].slice(1)}${off.length > 1 ? ` and ${off.length - 1} more` : ''} not allowed`;
}

/** Each permission this phone has: allowed, or a button for Android's prompt (or the phone's settings). */
function PermissionRows({ state }: { state: AppPermissions }) {
  const asking = usePermissions((s) => s.asking);
  const ask = usePermissions((s) => s.ask);
  return (
    <ul className="space-y-2.5">
      {ORDER.filter((p) => state[p]).map((p) => {
        const status = state[p];
        // Refused for good: only the phone's settings can allow it now. (Calls on the lock
        // screen are always allowed from there, so that's just "Allow"; Samsung's page is opened.)
        const settings = status === 'settings' && p !== 'fullScreen';
        const verb = p === 'samsung' ? 'Open' : settings ? 'Settings' : 'Allow';
        return (
          <li key={p} className="flex items-center gap-3 rounded-2xl border border-line/70 bg-surface/70 px-3 py-2.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/12 text-brand dark:bg-live/15 dark:text-live">{ABOUT[p].icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{ABOUT[p].title}</span>
              <span className="block text-[13px] leading-snug text-ink-soft">{ABOUT[p].hint}</span>
            </span>
            {status === 'granted' || status === 'opened' ? (
              <span
                role="img"
                aria-label={status === 'opened' ? 'Done' : 'Allowed'}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-live/15 text-live-ink"
              >
                <Check size={17} strokeWidth={3} />
              </span>
            ) : (
              <Button
                size="sm"
                variant="soft"
                busy={asking === p}
                disabled={!!asking}
                aria-label={`${p === 'samsung' ? 'Open battery settings for' : settings ? 'Open settings for' : 'Allow'} ${ABOUT[p].title.toLowerCase()}`}
                onClick={() => ask(p)}
              >
                {verb}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The app's first start (and once after updating to 1.10.0, if anything's
 * off): what Adda Khana needs from the phone, and why. The main button takes
 * one step at a time: Android's prompts for notifications, the microphone and
 * the camera; then ringing over the lock screen; then running in the
 * background. Not now (or Back) leaves the rest for Settings › App permissions.
 */
export function FirstRunPermissions() {
  const state = usePermissions((s) => s.state);
  const asking = usePermissions((s) => s.asking);
  const ask = usePermissions((s) => s.ask);
  const markSeen = usePermissions((s) => s.markSeen);
  // Steps tried on this screen: refused ones aren't offered again by the main button (their rows still are).
  const [tried, setTried] = useState<string[]>([]);
  // The first start; or, once, after 1.11.0 brought background activity and Samsung's sleeping apps, if one's off.
  const [open, setOpen] = useState(
    () => !!state && missing(state).length > 0 && (!state.seen || (state.seenExtra === false && missing(state).some((p) => LATER.includes(p)))),
  );
  const main = useRef<HTMLButtonElement>(null);
  useBackClose(open, () => finish());

  // Ready for the keyboard and screen readers, without scrolling away from the top.
  useEffect(() => {
    if (open) main.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open || !state) return null;

  function finish() {
    markSeen();
    setOpen(false);
  }

  const off = missing(state);
  const prompts = (['notifications', 'microphone', 'camera'] as const).filter((p) => state[p] === 'ask');
  const steps: { id: string; label: string; run: () => void }[] = [
    ...(prompts.length ? [{ id: 'prompts', label: 'Allow', run: () => ask('all') }] : []),
    ...(state.fullScreen && state.fullScreen !== 'granted' ? [{ id: 'fullScreen', label: 'Next: calls on the lock screen', run: () => ask('fullScreen') }] : []),
    ...(state.battery && state.battery !== 'granted' ? [{ id: 'battery', label: 'Next: run in the background', run: () => ask('battery') }] : []),
    ...(state.background === 'settings' ? [{ id: 'background', label: 'Next: background activity', run: () => ask('background') }] : []),
    ...(state.samsung === 'ask' ? [{ id: 'samsung', label: 'Next: never sleeping on Samsung', run: () => ask('samsung') }] : []),
  ];
  const next = steps.find((s) => !tried.includes(s.id));

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="permissions-title" className="fixed inset-0 z-[58] overflow-y-auto bg-canvas">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_50%_0%,color-mix(in_srgb,var(--brand)_22%,transparent),transparent)]" />
      <div className="relative mx-auto flex min-h-full w-full max-w-[460px] flex-col px-5 pt-[max(32px,calc(var(--safe-top)+20px))] pb-[max(20px,var(--safe-bottom))]">
        <Logo size={60} className="drop-shadow-[0_12px_30px_var(--logo-glow)]" />
        <h1 id="permissions-title" className="mt-5 font-display text-[26px] leading-tight font-bold tracking-[-0.02em]">
          Before you start
        </h1>
        <p className="mt-1.5 text-[15px] text-ink-soft">
          Adda Khana needs a few things from your phone, so calls ring and messages arrive even when the app is closed.
        </p>
        <div className="mt-6">
          <PermissionRows state={state} />
        </div>
        <div className="mt-auto space-y-2 pt-7">
          {next ? (
            <Button
              ref={main}
              size="lg"
              className="w-full"
              busy={!!asking}
              onClick={() => {
                setTried((t) => [...t, next.id]);
                next.run();
              }}
            >
              {next.label}
            </Button>
          ) : (
            <Button ref={main} size="lg" className="w-full" disabled={!!asking} onClick={finish}>
              Continue
            </Button>
          )}
          {next && off.length > 0 && (
            <Button variant="ghost" className="w-full" disabled={!!asking} onClick={finish}>
              Not now
            </Button>
          )}
          <p className="pt-1 text-center text-[12.5px] text-ink-soft">You can change these any time in Settings › App permissions.</p>
        </div>
      </div>
    </div>
  );
}

/** Settings › App permissions: where each stands, and allowing what's off. */
export function PermissionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = usePermissions((s) => s.state);
  if (!state) return null;
  return (
    <Dialog open={open} onClose={onClose} title="App permissions" description="What Adda Khana can use on this phone, and why." width={460}>
      <PermissionRows state={state} />
      <p className="mt-4 text-[13px] text-ink-soft">
        Turned something off in the phone’s settings? It shows here when you come back. Anything refused twice can only be allowed from the phone’s
        settings.
      </p>
    </Dialog>
  );
}
