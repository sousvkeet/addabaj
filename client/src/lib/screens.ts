// Moving between screens like a phone app: on a phone, opening a chat slides
// it in from the right over the list, and going back (the back arrow or
// Android's back gesture) slides it away again; switching tabs fades through.
// The router animates with the browser's view transitions (index.css has the
// animations); this tells the CSS which way to go.
import type { NavigateFunction } from 'react-router';

type Router = { state: { location: { pathname: string } }; subscribe: (fn: (state: { location: { pathname: string } }) => void) => () => void };

const parts = (path: string) => path.split('/').filter(Boolean);

/** 'forward' into a chat, 'back' out to its list, 'tab' between sections. */
export function direction(from: string, to: string) {
  const a = parts(from);
  const b = parts(to);
  if (a[0] !== b[0]) return 'tab';
  if (b.length > a.length) return 'forward';
  if (b.length < a.length) return 'back';
  return 'tab';
}

/** Keeps <html data-nav> set to the direction of the latest move (before the router starts animating it). */
export function watchScreens(router: Router) {
  let last = router.state.location.pathname;
  router.subscribe((state) => {
    const next = state.location.pathname;
    if (next === last) return;
    document.documentElement.dataset.nav = direction(last, next);
    last = next;
  });
}

/**
 * The back arrow on a chat or room: back through history like Android's back
 * gesture (so the list comes back as it was), or to `list` when the chat was
 * opened directly (from a notification or a link).
 */
export function goBack(navigate: NavigateFunction, list: string) {
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  if (idx > 0) void navigate(-1);
  else void navigate(list, { replace: true, viewTransition: true });
}
