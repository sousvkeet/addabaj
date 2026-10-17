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
};

const resetHandlers: (() => void)[] = [];
/** Stores register a reset so logging out leaves nothing behind. */
export const onLogout = (fn: () => void) => resetHandlers.push(fn);

export const useAuth = create<AuthState>()((set) => {
  const signedIn = (user: User) => {
    set({ user, status: 'authed' });
    socket.connect();
  };
  const signedOut = () => {
    socket.disconnect();
    resetHandlers.forEach((fn) => fn());
    set({ user: null, status: 'guest' });
  };

  return {
    user: null,
    status: 'loading',
    init: async () => {
      try {
        const { user } = await api<{ user: User | null }>('/auth/me');
        if (user) signedIn(user);
        else set({ status: 'guest' });
      } catch {
        set({ status: 'guest' });
      }
    },
    login: async (email, password) => {
      const { user } = await api<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } });
      signedIn(user);
    },
    register: async (name, email, password) => {
      const { user } = await api<{ user: User }>('/auth/register', { method: 'POST', body: { name, email, password } });
      signedIn(user);
    },
    logout: async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      signedOut();
    },
    expire: signedOut,
  };
});

export const myId = () => useAuth.getState().user?.id ?? '';
