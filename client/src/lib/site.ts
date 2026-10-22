import { create } from 'zustand';
import { api } from './api';
import type { Announcement, Messaging } from './types';
import { onLogout } from '../store/auth';

const DISMISSED_KEY = 'adda-dismissed-announcement';

/** Until the server says otherwise (the host admin's choices: Admin › Site settings › Messages). */
export const MESSAGING_DEFAULTS: Messaging = { linkPreviews: true, editing: true, editMinutes: 15, forwarding: true, forwardTo: 5 };

type Site = { announcement: Announcement | null; messaging?: Messaging };

type SiteState = {
  announcement: Announcement | null;
  /** How messages work here: editing and forwarding, and for how long and how many. */
  messaging: Messaging;
  dismissed: string | null;
  /** The page the server hosts now (its main script), when it hosts the built app. */
  build: string | null;
  load: () => Promise<void>;
  set: (site: Site) => void;
  dismiss: () => void;
};

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
};

/** Site-wide things from the host: the announcement banner, and how messages work. */
export const useSite = create<SiteState>()((set, get) => ({
  announcement: null,
  messaging: MESSAGING_DEFAULTS,
  dismissed: readDismissed(),
  build: null,
  load: async () => {
    try {
      const site = await api<Site & { build?: string | null }>('/site');
      get().set(site);
      set({ build: site.build ?? null });
    } catch {
      /* not important enough to complain about */
    }
  },
  set: ({ announcement, messaging }) => set({ announcement, ...(messaging ? { messaging: { ...MESSAGING_DEFAULTS, ...messaging } } : {}) }),
  dismiss: () => {
    const id = get().announcement?.id ?? null;
    try {
      if (id) localStorage.setItem(DISMISSED_KEY, id);
    } catch {
      /* storage unavailable */
    }
    set({ dismissed: id });
  },
}));

onLogout(() => useSite.setState({ announcement: null, messaging: MESSAGING_DEFAULTS }));
