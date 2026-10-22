import { create } from 'zustand';
import { api } from '../lib/api';
import { onLogout } from './auth';

// Bumped whenever the count is set, so an older load can't overwrite a newer count.
let version = 0;

/** How many reports are waiting for the host admin (null until it's known). */
export const useReports = create<{ open: number | null; setOpen: (n: number) => void; load: () => Promise<void> }>()((set) => ({
  open: null,
  setOpen: (open) => {
    version++;
    set({ open });
  },
  load: async () => {
    const asked = version;
    try {
      const { open } = await api<{ open: number }>('/admin/reports?status=open&limit=1');
      if (asked === version) set({ open });
    } catch {
      /* the count can wait */
    }
  },
}));

onLogout(() => {
  version++;
  useReports.setState({ open: null });
});
