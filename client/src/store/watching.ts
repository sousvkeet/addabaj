// The room whose video plays for me. Its player is made once and then moved,
// never rebuilt, between the room's page (the stage at the top) and a small
// player shown elsewhere in the app, so the video keeps going while I look
// at other chats (and, in the Android app, after I leave the app).
import { create } from 'zustand';
import { onLogout } from './auth';

type Watching = {
  roomId: string | null;
  /** On the room's page: where its stage goes. Null: the small player. */
  slot: HTMLElement | null;
  /** The room page's "Change video". */
  onChange: (() => void) | null;
  /** Bumped when a move reloaded the player's frame (see place): the stage is rebuilt there. */
  moves: number;
  /** The room's page is showing its video at `slot`: it plays for me (from now on). */
  attach: (roomId: string, slot: HTMLElement, onChange: () => void) => void;
  /** The room's page closed: its video carries on in the small player. */
  detach: (slot: HTMLElement) => void;
  /** Stops it for me (not for the room). */
  stop: () => void;
};

/** The player's own element: React renders into it, and it's moved around whole. */
export const playerHolder = document.createElement('div');
playerHolder.className = 'size-full';

let dockArea: HTMLElement | null = null;

/** The small player's video area (see WatchDock). */
export function setDockArea(el: HTMLElement | null) {
  dockArea = el;
  if (el && !useWatching.getState().slot) moved(place(el));
}

/**
 * Moves the player. moveBefore keeps everything running, a YouTube frame
 * too. Browsers without it (Firefox and Safari, for now) keep a <video>
 * playing through a plain move but reload a frame, which leaves YouTube's
 * player behind: false then, and the stage is rebuilt where it now is.
 */
function place(target: HTMLElement): boolean {
  if (playerHolder.parentElement === target) return true;
  const to = target as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
  if (to.moveBefore && playerHolder.isConnected) {
    try {
      to.moveBefore(playerHolder, null);
      return true;
    } catch {
      // Not movable that way here: a plain move.
    }
  }
  const reloads = playerHolder.isConnected && !!playerHolder.querySelector('iframe');
  to.appendChild(playerHolder);
  return !reloads;
}

function moved(intact: boolean) {
  if (!intact) useWatching.setState((s) => ({ moves: s.moves + 1 }));
}

export const useWatching = create<Watching>()((set, get) => ({
  roomId: null,
  slot: null,
  onChange: null,
  moves: 0,

  attach: (roomId, slot, onChange) => {
    moved(place(slot));
    set({ roomId, slot, onChange });
  },

  detach: (slot) => {
    if (get().slot !== slot) return;
    // Right away, before the page takes the slot (and the player in it) away.
    if (dockArea) moved(place(dockArea));
    set({ slot: null, onChange: null });
  },

  stop: () => set({ roomId: null }),
}));

onLogout(() => useWatching.getState().stop());
