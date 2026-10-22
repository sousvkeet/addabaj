import { useRef, type ReactNode } from 'react';
import { useBackClose } from '../../lib/back';
import type { MenuItem } from './Menu';

/**
 * Phones: a list of actions that slides up from the bottom (press and hold
 * something). Only taps that start once it's open count: lifting the finger
 * that held (it opens under that finger) presses nothing and doesn't close it.
 */
export function Sheet({ label, title, items, onClose }: { label: string; title?: ReactNode; items: MenuItem[]; onClose: () => void }) {
  const pressed = useRef<EventTarget | null>(null);
  useBackClose(true, onClose);
  return (
    <div
      className="fixed inset-0 z-[65] flex items-end bg-[rgb(6_8_22/0.55)] backdrop-blur-[3px]"
      onPointerDown={(e) => (pressed.current = e.target)}
      onClickCapture={(e) => {
        if (e.detail > 0 && !pressed.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={(e) => e.target === e.currentTarget && pressed.current === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={label}
        className="pop-in w-full rounded-t-[28px] border-t border-line bg-surface p-4 pb-[max(16px,var(--safe-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="mb-2 px-3">{title}</div>}
        <div className="space-y-1">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={`ripple flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] font-medium ${item.danger ? 'text-danger hover:bg-danger/10' : 'hover:bg-subtle'}`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
