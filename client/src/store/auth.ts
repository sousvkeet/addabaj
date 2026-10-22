import { create } from 'zustand';
import { api } from '../lib/api';
import { cachedUser, forgetCache, saveUser } from '../lib/localCache';
import { socket } from '../lib/socket';
import type { User } from '../lib/types';

/** A sign-up waiting for the code emailed to it (the token proves it's this browser's). */
export type PendingSignup = { token: string; email: string; resendIn: number };

type AuthState = {
  user: User | null;
  status: 'loading' | 'authed' | 'guest';
  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  /** Signs up: in at once, or (when the site confirms emails) a sign-up waiting for its code. */
  register: (name: string, email: string, password: string) => Promise<PendingSignup | null>;
  /** The emailed code finishes the sign-up and logs in. */
  confirmSignup: (token: string, code: string) => Promise<void>;
  /** Another code; seconds until the next one can be sent. */
  resendSignup: (token: string) => Promise<number>;
  /** Emails a code to reset a forgotten password (if there's an account); seconds until another can be sent. */
  forgotPassword: (email: string) => Promise<number>;
  /** The emailed code sets a new password and logs in (everywhere else is logged out). */
  resetPassword: (email: string, code: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  expire: () => void;
  /** Reloads my account (after a password change, or when the host changes my role). */
  refresh: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** A new user ID (what people type to find you). */
  changeHandle: (handle: string) => Promise<void>;
  /** My name, as everyone sees it (they see the new one at once). */
  changeName: (name: string) => Promise<void>;
  /** My account as the server now has it (a new photo, say). */
  setUser: (user: User) => void;
};

const resetHandlers: (() => void)[] = [];
/** Stores register a reset so logging out leaves nothing behind. */
export const onLogout = (fn: () => void) => resetHandlers.push(fn);
const goodbyes: (() => Promise<unknown>)[] = [];
/** Runs while still signed in, just before logging out (e.g. stop this phone's notifications). */
export const beforeLogout = (fn: () => Promise<unknown>) => goodbyes.push(fn);

let initOnce: Promise<void> | null = null;

export const useAuth = create<AuthState>()((set) => {
  const signedIn = (user: User) => {
    set({ user, status: 'authed' });
    saveUser(user);
    // Calling connect() again while a connection is opening makes Socket.IO
    // join twice over one WebSocket, so the server sees two sockets for one tab.
    if (!socket.active) socket.connect();
  };
  const signedOut = () => {
    socket.disconnect();
    forgetCache();
    resetHandlers.forEach((fn) => fn());
    set({ user: null, status: 'guest' });
  };

  const kept = cachedUser();
  return {
    user: kept,
    status: kept ? 'authed' : 'loading',
    // Runs once per page load, even when React calls the effect twice in development.
    // In the app, the account kept on the phone opens the chats at once (even
    // offline); the server then confirms it, or sends them to the login page.
    init: () =>
      (initOnce ??= (async () => {
        const kept = cachedUser();
        if (kept) signedIn(kept);
        try {
          const { user } = await api<{ user: User | null }>('/auth/me');
          if (user) signedIn(user);
          else if (kept) signedOut();
          else set({ status: 'guest' });
        } catch {
          if (!kept) set({ status: 'guest' });
        }
      })()),
    login: async (email, password) => {
      const { user } = await api<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } });
      signedIn(user);
    },
    register: async (name, email, password) => {
      const res = await api<{ user?: User; confirm?: PendingSignup }>('/auth/register', { method: 'POST', body: { name, email, password } });
      if (res.user) signedIn(res.user);
      return res.confirm ?? null;
    },
    confirmSignup: async (token, code) => {
      const { user } = await api<{ user: User }>('/auth/register/confirm', { method: 'POST', body: { token, code } });
      signedIn(user);
    },
    resendSignup: async (token) => (await api<{ resendIn: number }>('/auth/register/resend', { method: 'POST', body: { token } })).resendIn,
    forgotPassword: async (email) => (await api<{ resendIn: number }>('/auth/forgot', { method: 'POST', body: { email } })).resendIn,
    resetPassword: async (email, code, password) => {
      const { user } = await api<{ user: User }>('/auth/reset', { method: 'POST', body: { email, code, password } });
      signedIn(user);
    },
    logout: async () => {
      await Promise.all(goodbyes.map((fn) => fn().catch(() => {})));
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      signedOut();
    },
    expire: signedOut,
    refresh: async () => {
      const { user } = await api<{ user: User | null }>('/auth/me');
      if (user) {
        set({ user });
        saveUser(user);
      } else signedOut();
    },
    setUser: (user) => {
      set({ user });
      saveUser(user);
    },
    changeHandle: async (handle) => {
      const { user } = await api<{ user: User }>('/auth/handle', { method: 'PATCH', body: { handle } });
      set({ user });
      saveUser(user);
    },
    changeName: async (name) => {
      const { user } = await api<{ user: User }>('/auth/name', { method: 'PATCH', body: { name } });
      set({ user });
      saveUser(user);
    },
    changePassword: async (currentPassword, newPassword) => {
      const { user } = await api<{ user: User }>('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      set({ user });
      saveUser(user);
    },
  };
});

export const myId = () => useAuth.getState().user?.id ?? '';
