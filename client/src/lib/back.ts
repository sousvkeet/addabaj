// Android's back button in the app, as in other messengers:
//  1. It closes what's open first (a sheet, a photo, a menu): those register
//     with useBackClose.
//  2. It steps back through the screens, and the history always has the chats
//     (the home screen) at the bottom: tabs replace each other instead of
//     piling up, and a chat opened from a notification gets the chats
//     slipped in underneath.
//  3. From the chats, it leaves the app.
// The page does 1 and 2 itself (window.__addaBack, app 1.6.1 on) and tells the
// app while it has something to do, rather than leaving the steps to the
// WebView's own Back: that skips screens the page added without a tap (the
// chats slipped in underneath), and would leave the app from a notification's
// chat.
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { inApp, nativeBackHandled } from './native';

const HOME = '/chats';
const open: { close: () => void }[] = [];
/** Somewhere other than the chats at the bottom of the history. */
let away = false;
let goHome: (() => void) | null = null;
const tell = () => nativeBackHandled(open.length > 0 || away);
const historyIndex = () => (window.history.state as { idx?: number } | null)?.idx ?? 0;

/** While `active`, Android's back calls `close` (the most recently opened first) instead of leaving the screen. */
export function useBackClose(active: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!active || !inApp) return;
    const entry = { close: () => latest.current() };
    open.push(entry);
    tell();
    return () => {
      const i = open.indexOf(entry);
      if (i >= 0) open.splice(i, 1);
      tell();
    };
  }, [active]);
}

/** Keeps the app told whether Back has a screen to go back to (in the signed-in pages). */
export function useBackSteps() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!inApp) return;
    goHome = () => void navigate(HOME, { replace: true, viewTransition: true });
    away = location.pathname !== HOME || historyIndex() > 0;
    tell();
  }, [location, navigate]);
  useEffect(
    () => () => {
      away = false;
      goHome = null;
      tell();
    },
    [],
  );
}

/** What the app calls on Back: true when the page handled it (closed something, or went back a screen). */
(window as { __addaBack?: () => boolean }).__addaBack = () => {
  const top = open.at(-1);
  if (top) {
    top.close();
    return true;
  }
  if (!away) return false;
  if (historyIndex() > 0) window.history.back();
  else goHome?.();
  return true;
};

const section = (path: string) => path.split('/')[1] ?? '';

/**
 * A tab in the bottom bar. In the app, tabs don't pile up history: going from
 * the chats to another tab can be undone with Back; tab to tab replaces; and
 * the chats tab goes back down to the chats at the bottom.
 */
export function goTab(navigate: NavigateFunction, to: string, from: string) {
  if (section(to) === section(from) && to === from) return;
  if (!inApp) return void navigate(to, { viewTransition: true });
  const idx = historyIndex();
  if (to === HOME) {
    if (idx > 0) void navigate(-idx);
    else void navigate(to, { replace: true, viewTransition: true });
  } else if (from === HOME) {
    void navigate(to, { viewTransition: true });
  } else {
    void navigate(to, { replace: true, viewTransition: true });
  }
}

let shaped = false;

/**
 * The app opened straight onto another screen (a notification's chat, a
 * room): put the chats underneath it, so Back reaches the home screen before
 * leaving the app.
 */
export async function homeUnderneath(navigate: NavigateFunction, path: string, state?: unknown) {
  // Once per page load (React may run the opening effect twice).
  if (shaped) return;
  shaped = true;
  if (!inApp || historyIndex() > 0 || path === HOME || !/^\/(chats|rooms|invites|settings|admin)\b/.test(path)) return;
  await navigate(HOME, { replace: true });
  // With what came with it (a /join link's code).
  await navigate(path, { state });
}

/**
 * Leaves a screen that's gone (a room just left or deleted): back past it,
 * and its info page if open, to where it was opened from, so Back doesn't
 * lead to it again; or on to `fallback` when it was the first screen.
 */
export function leaveGone(navigate: NavigateFunction, fallback: string) {
  const steps = window.location.hash === '#info' ? 2 : 1;
  if (historyIndex() >= steps) void navigate(-steps);
  else void navigate(fallback, { replace: true });
}
