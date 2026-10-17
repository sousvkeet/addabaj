import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
};

export function Dialog({ open, onClose, title, description, children, width = 440 }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="pop-in m-auto max-h-[min(720px,calc(100dvh-32px))] w-[calc(100%-32px)] overflow-hidden rounded-[22px] bg-paper p-0 text-ink shadow-[0_24px_60px_-20px_rgb(10_30_25/0.45)] backdrop:bg-[rgb(10_25_21/0.55)] backdrop:backdrop-blur-[2px]"
      style={{ maxWidth: width }}
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col">
          <header className="flex items-start gap-3 px-6 pt-5 pb-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-[22px] leading-tight">{title}</h2>
              {description && <p className="mt-1 text-[13.5px] text-ink-soft">{description}</p>}
            </div>
            <IconButton label="Close" size={36} onClick={onClose} className="-mt-1 -mr-2">
              <X size={18} />
            </IconButton>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13.5px] font-semibold">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-[13px] text-oxide">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[13px] text-ink-soft">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  'h-11 w-full rounded-xl border border-line bg-wall px-3.5 text-[15px] text-ink placeholder:text-ink-soft/70 outline-none transition-colors focus:border-shutter focus:bg-paper';
