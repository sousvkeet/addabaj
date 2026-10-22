import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EllipsisVertical } from 'lucide-react';
import { IconButton } from './Button';
import { useBackClose } from '../../lib/back';

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean };

const menuBox = 'pop-in z-[60] min-w-[200px] rounded-2xl border border-line bg-surface p-1.5 shadow-float';

/**
 * A button that opens a list of actions. `floating`: the list floats over the
 * page next to the button (above it when there's no room below), for buttons
 * inside a scrolling list such as a chat's messages.
 */
export function Menu({ label, items, icon, size = 32, floating }: { label: string; items: MenuItem[]; icon?: ReactNode; size?: number; floating?: boolean }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useBackClose(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // A floating list would be left behind by scrolling.
    const onScroll = (e: Event) => !list.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    if (floating) document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, floating]);

  function toggle() {
    if (!open && floating && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const tall = items.length * 44 + 16;
      const up = window.innerHeight - r.bottom < tall + 8 && r.top > window.innerHeight - r.bottom;
      const right = Math.max(8, window.innerWidth - r.right);
      setPlace(up ? { position: 'fixed', right, bottom: window.innerHeight - r.top + 4 } : { position: 'fixed', right, top: r.bottom + 4 });
    }
    setOpen((o) => !o);
  }

  if (!items.length) return null;
  const menu = open && (
    <div ref={list} role="menu" aria-label={label} style={floating ? place : undefined} className={`${menuBox} ${floating ? '' : 'absolute top-9 right-0'}`}>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          type="button"
          onClick={() => {
            setOpen(false);
            item.onSelect();
          }}
          className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium hover:bg-subtle ${item.danger ? 'text-danger' : ''}`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
  return (
    <div ref={ref} className="relative">
      <IconButton label={label} size={size} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {icon ?? <EllipsisVertical size={16} />}
      </IconButton>
      {floating ? menu && createPortal(menu, document.body) : menu}
    </div>
  );
}
