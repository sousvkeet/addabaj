import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EllipsisVertical } from 'lucide-react';
import { IconButton } from './Button';

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean };

export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!items.length) return null;
  return (
    <div ref={ref} className="relative">
      <IconButton label={label} size={32} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <EllipsisVertical size={16} />
      </IconButton>
      {open && (
        <div
          role="menu"
          className="pop-in absolute top-9 right-0 z-20 min-w-[200px] rounded-2xl border border-line bg-surface p-1.5 shadow-float"
        >
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
      )}
    </div>
  );
}
