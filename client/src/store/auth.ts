import { create } from 'zustand';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import type { User } from '../lib/types';

type AuthState = {
  user: User | null;
  status: 'loading' | 'authed' | 'guest';
  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  expire: () => void;
  /** Reloads my account (after a password change, or when the host changes my role). */
  refresh: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** A new user ID (what people type to find you). */
  changeHandle: (handle: string) => Promise<void>;
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
    // Calling connect() again while a connection is opening makes Socket.IO
    // join twice over one WebSocket, so the server sees two sockets for one tab.
    if (!socket.active) socket.connect();
  };
  const signedOut = () => {
    socket.disconnect();
    resetHandlers.forEach((fn) => fn());
    set({ user: null, status: 'guest' });
  };

  return {
    user: null,
    status: 'loading',
    // Runs once per page load, even when React calls the effect twice in development.
    init: () =>
      (initOnce ??= (async () => {
        try {
          const { user } = await api<{ user: User | null }>('/auth/me');
          if (user) signedIn(user);
          else set({ status: 'guest' });
        } catch {
          set({ status: 'guest' });
        }
      })()),
    login: async (email, password) => {
      const { user } = await api<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } });
      signedIn(user);
    },
    register: async (name, email, password) => {
      const { user } = await api<{ user: User }>('/auth/register', { method: 'POST', body: { name, email, password } });
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
      if (user) set({ user });
      else signedOut();
    },
    changeHandle: async (handle) => {
      const { user } = await api<{ user: User }>('/auth/handle', { method: 'PATCH', body: { handle } });
      set({ user });
    },
    changePassword: async (currentPassword, newPassword) => {
      const { user } = await api<{ user: User }>('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      set({ user });
    },
  };
});

export const myId = () => useAuth.getState().user?.id ?? '';
