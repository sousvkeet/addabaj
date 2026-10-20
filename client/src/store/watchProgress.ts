import { create } from 'zustand';

/** How far along the server is with joining picture and sound, per room. */
export type Preparing = { phase: 'download' | 'join'; percent: number };

export const useWatchProgress = create<{ rooms: Record<string, Preparing> }>()(() => ({ rooms: {} }));

export const setPreparing = (roomId: string, p: Preparing) =>
  useWatchProgress.setState((s) => ({ rooms: { ...s.rooms, [roomId]: p } }));
