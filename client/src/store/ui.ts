import { create } from 'zustand';

export type Toast = { id: number; text: string; tone: 'info' | 'error' | 'live' };
type Theme = 'light' | 'dark';

type UiState = {
  toasts: Toast[];
  theme: Theme;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
  toggleTheme: () => void;
};

let nextId = 1;

export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  theme: (document.documentElement.dataset.theme as Theme) ?? 'light',
  toast: (text, tone = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, text, tone }].slice(-4) }));
    window.setTimeout(() => get().dismiss(id), tone === 'error' ? 6000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  toggleTheme: () => {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#09130f' : '#15362f');
    try {
      localStorage.setItem('adda-theme', theme);
    } catch {
      /* storage unavailable */
    }
    set({ theme });
  },
}));

export const toast = (text: string, tone?: Toast['tone']) => useUi.getState().toast(text, tone);
