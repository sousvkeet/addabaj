import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Minus, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import type { RoomDetail, RoomSummary, User } from '../lib/types';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Avatar, hueFromId } from './ui/Avatar';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

/** The saved photo: a square this many pixels across (shown in circles everywhere). */
const OUT = 512;
const MAX_ZOOM = 4;

type View = { zoom: number; x: number; y: number };

/** Loads a picked file as an image (turned upright, as the phone took it). */
function load(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That picture can't be opened here. Try another one (JPEG, PNG or WebP)."));
    };
    img.src = url;
  });
}

/**
 * Your profile photo, or a room's (`room`, for its admins): choose a picture,
 * fit it in the frame (drag, pinch, scroll or the zoom buttons), and save; or
 * remove it to go back to initials. The app sends a 512-pixel square JPEG,
 * which also drops the original's camera details and location.
 */
export function PhotoEditor({ open, onClose, room }: { open: boolean; onClose: () => void; room?: RoomSummary | RoomDetail }) {
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const upsertRoom = useChat((s) => s.upsertRoom);
  const picker = useRef<HTMLInputElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stage = Math.min(320, typeof window === 'undefined' ? 320 : window.innerWidth - 64);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; mid: { x: number; y: number }; dist: number } | null>(null);

  useEffect(() => {
    if (open) return;
    setImg((old) => {
      if (old) URL.revokeObjectURL(old.src);
      return null;
    });
    setError('');
  }, [open]);

  if (!user) return null;
  // Whose photo: mine, or the room's.
  const who = room ? { name: room.name, hue: hueFromId(room.id), photo: room.photo ?? null } : { name: user.name, hue: user.hue, photo: user.photo ?? null };
  const endpoint = room ? `/rooms/${room.id}/photo` : '/auth/photo';
  const frame = room ? 'rounded-[32%]' : 'rounded-full';

  // How big the picture is drawn: it always covers the circle.
  const base = img ? stage / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const fit = (v: View): View => {
    if (!img) return v;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom));
    const scale = base * zoom;
    const maxX = (img.naturalWidth * scale - stage) / 2;
    const maxY = (img.naturalHeight * scale - stage) / 2;
    return { zoom, x: Math.max(-maxX, Math.min(maxX, v.x)), y: Math.max(-maxY, Math.min(maxY, v.y)) };
  };
  const scale = base * view.zoom;
  const drawn = img ? { w: img.naturalWidth * scale, h: img.naturalHeight * scale } : { w: 0, h: 0 };
  const left = stage / 2 - drawn.w / 2 + view.x;
  const top = stage / 2 - drawn.h / 2 + view.y;

  async function pick(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      const next = await load(file);
      setImg((old) => {
        if (old) URL.revokeObjectURL(old.src);
        return next;
      });
      setView({ zoom: 1, x: 0, y: 0 });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function save() {
    if (!img) return;
    setBusy(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      // The part of the picture inside the circle's square.
      const side = stage / scale;
      ctx.drawImage(img, -left / scale, -top / scale, side, side, 0, 0, OUT, OUT);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      if (!blob) throw new Error("Couldn't prepare the photo. Try another one.");
      const saved = await api<{ user?: User; room?: RoomDetail }>(endpoint, { method: 'PUT', body: blob });
      if (saved.room) upsertRoom(saved.room);
      if (saved.user) setUser(saved.user);
      toast(room ? 'Room photo updated.' : 'Profile photo updated.');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError('');
    try {
      const saved = await api<{ user?: User; room?: RoomDetail }>(endpoint, { method: 'DELETE' });
      if (saved.room) upsertRoom(saved.room);
      if (saved.user) setUser(saved.user);
      toast(room ? 'Room photo removed.' : 'Profile photo removed.');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ── Fitting the picture: drag, pinch, scroll ──
  const span = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const startGesture = () => {
    const pts = [...pointers.current.values()];
    const mid = pts.length === 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    gesture.current = mid ? { view, mid, dist: pts.length === 2 ? span(pts[0], pts[1]) : 0 } : null;
  };
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      startGesture();
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!pointers.current.has(e.pointerId) || !gesture.current) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      const pts = [...pointers.current.values()];
      if (pts.length === 2 && g.dist) {
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const zoom = (g.view.zoom * span(pts[0], pts[1])) / g.dist;
        setView(fit({ zoom, x: g.view.x * (zoom / g.view.zoom) + (mid.x - g.mid.x), y: g.view.y * (zoom / g.view.zoom) + (mid.y - g.mid.y) }));
      } else if (pts.length === 1) {
        setView(fit({ ...g.view, x: g.view.x + (pts[0].x - g.mid.x), y: g.view.y + (pts[0].y - g.mid.y) }));
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      pointers.current.delete(e.pointerId);
      startGesture();
    },
    onPointerCancel: (e: React.PointerEvent) => {
      pointers.current.delete(e.pointerId);
      startGesture();
    },
    onWheel: (e: React.WheelEvent) => {
      const zoom = view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      setView(fit({ zoom, x: view.x * (zoom / view.zoom), y: view.y * (zoom / view.zoom) }));
    },
  };
  const zoomBy = (factor: number) => {
    const zoom = view.zoom * factor;
    setView(fit({ zoom, x: view.x * (zoom / view.zoom), y: view.y * (zoom / view.zoom) }));
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={img ? (room ? 'Fit the room photo' : 'Fit your photo') : room ? 'Room photo' : 'Profile photo'}
      description={
        img
          ? 'Drag to move it, pinch or scroll to zoom.'
          : room
            ? 'Everyone in the room sees it: in their room list, in the room and in notifications.'
            : 'People see it next to your name, in chats, rooms, calls and notifications.'
      }
      width={420}
    >
      <input ref={picker} type="file" accept="image/*" hidden aria-label="Choose a photo" onChange={(e) => void pick(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
      {img ? (
        <div className="space-y-4">
          <div
            {...handlers}
            role="img"
            aria-label={room ? 'The room photo, to fit in the frame' : 'Your photo, to fit in the circle'}
            className="relative mx-auto touch-none overflow-hidden rounded-3xl bg-black select-none"
            style={{ width: stage, height: stage, cursor: 'grab' }}
          >
            <img
              src={img.src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute top-0 left-0 max-w-none"
              style={{ width: drawn.w, height: drawn.h, transform: `translate(${left}px, ${top}px)` }}
            />
            {/* Everything outside the circle is dimmed: that's what people will see. */}
            <span aria-hidden className={`pointer-events-none absolute inset-0 ${frame} shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] ring-2 ring-white/70`} />
          </div>
          <div className="flex items-center justify-center gap-3">
            <Button variant="ghost" size="sm" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)} disabled={view.zoom <= 1}>
              <Minus size={16} />
            </Button>
            <input
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={view.zoom}
              aria-label="Zoom"
              onChange={(e) => {
                const zoom = Number(e.target.value);
                setView(fit({ zoom, x: view.x * (zoom / view.zoom), y: view.y * (zoom / view.zoom) }));
              }}
              className="w-40 accent-[var(--brand)]"
            />
            <Button variant="ghost" size="sm" aria-label="Zoom in" onClick={() => zoomBy(1.2)} disabled={view.zoom >= MAX_ZOOM}>
              <Plus size={16} />
            </Button>
          </div>
          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => picker.current?.click()} disabled={busy}>
              Choose another
            </Button>
            <Button onClick={() => void save()} busy={busy}>
              Use photo
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex justify-center pt-1">
            <Avatar name={who.name} hue={who.hue} photo={who.photo} size={148} square={!!room} />
          </div>
          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Button onClick={() => picker.current?.click()} disabled={busy}>
              {who.photo ? <ImagePlus size={17} /> : <Camera size={17} />}
              {who.photo ? 'Choose a new photo' : 'Choose a photo'}
            </Button>
            {who.photo && (
              <Button variant="danger-ghost" onClick={() => void remove()} busy={busy}>
                <Trash2 size={17} />
                Remove photo
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
