import { create } from 'zustand';
import { api } from './api';
import type { Announcement } from './types';
import { onLogout } from '../store/auth';

const DISMISSED_KEY = 'adda-dismissed-announcement';

type SiteState = {
  announcement: Announcement | null;
  dismissed: string | null;
  /** The page the server hosts now (its main script), when it hosts the built app. */
  build: string | null;
  load: () => Promise<void>;
  set: (site: { announcement: Announcement | null }) => void;
  dismiss: () => void;
};

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
};

/** Site-wide things from the host: the announcement banner. */
export const useSite = create<SiteState>()((set, get) => ({
  announcement: null,
  dismissed: readDismissed(),
  build: null,
  load: async () => {
    try {
      const site = await api<{ announcement: Announcement | null; build?: string | null }>('/site');
      get().set(site);
      set({ build: site.build ?? null });
    } catch {
      /* not important enough to complain about */
    }
  },
  set: ({ announcement }) => set({ announcement }),
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

onLogout(() => useSite.setState({ announcement: null }));
