import { create } from 'zustand';

export type Toast = { id: number; text: string; tone: 'info' | 'error' | 'live' };
type Theme = 'light' | 'dark';

type UiState = {
  toasts: Toast[];
  /** The browser refused to play call audio until the user taps something. */
  soundBlocked: boolean;
  setSoundBlocked: (blocked: boolean) => void;
  /** The audio and video settings dialog. */
  devicesOpen: boolean;
  setDevicesOpen: (open: boolean) => void;
  theme: Theme;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
  toggleTheme: () => void;
};

let nextId = 1;

export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  soundBlocked: false,
  setSoundBlocked: (soundBlocked) => set({ soundBlocked }),
  devicesOpen: false,
  setDevicesOpen: (devicesOpen) => set({ devicesOpen }),
  theme: (document.documentElement.dataset.theme as Theme) ?? 'dark',
  toast: (text, tone = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, text, tone }].slice(-4) }));
    window.setTimeout(() => get().dismiss(id), tone === 'error' ? 6000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  toggleTheme: () => {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#090C1A' : '#F3F4FB');
    try {
      localStorage.setItem('adda-theme', theme);
    } catch {
      /* storage unavailable */
    }
    set({ theme });
  },
}));

export const toast = (text: string, tone?: Toast['tone']) => useUi.getState().toast(text, tone);
