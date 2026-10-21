import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button, IconButton } from './Button';

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
  /** False for a step that must be finished (no close button, Escape or outside click). */
  dismissible?: boolean;
  /** A short question with buttons: stays a centred box on phones (other dialogs slide up from the bottom). */
  alert?: boolean;
};

/**
 * A dialog: a centred box on wider screens; on phones a sheet that slides up
 * from the bottom and can be swiped down to close, as in phone apps.
 */
export function Dialog({ open, onClose, title, description, children, width = 440, dismissible = true, alert = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const drag = useRef<{ y: number; dy: number } | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.style.transform = '';
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // Swipe the sheet's top down to close it.
  const swipe = dismissible && !alert
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.pointerType === 'mouse' || window.innerWidth >= 768 || (e.target as Element).closest('button')) return;
          drag.current = { y: e.clientY, dy: 0 };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        },
        onPointerMove: (e: React.PointerEvent) => {
          const d = drag.current;
          if (!d || !ref.current) return;
          d.dy = Math.max(0, e.clientY - d.y);
          ref.current.style.transition = 'none';
          ref.current.style.transform = `translateY(${d.dy}px)`;
        },
        onPointerUp: () => {
          const d = drag.current;
          drag.current = null;
          const el = ref.current;
          if (!d || !el) return;
          el.style.transition = 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)';
          if (d.dy > Math.min(140, el.offsetHeight / 3)) {
            el.style.transform = 'translateY(100%)';
            window.setTimeout(onClose, 180);
          } else {
            el.style.transform = '';
          }
        },
        onPointerCancel: () => {
          drag.current = null;
          if (ref.current) ref.current.style.transform = '';
        },
      }
    : {};

  const sheet = alert
    ? 'm-auto w-[calc(100%-48px)] rounded-[28px]'
    : 'max-md:mx-0 max-md:mt-auto max-md:mb-0 max-md:max-h-[92dvh] max-md:w-full max-md:max-w-none max-md:rounded-t-[28px] max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 md:m-auto md:w-[calc(100%-32px)] md:rounded-[28px]';

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault();
      }}
      onMouseDown={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className={`${alert ? 'pop-in' : 'dialog-in'} max-h-[min(740px,calc(100dvh-32px))] overflow-hidden border border-line bg-surface p-0 text-ink shadow-[0_40px_90px_-30px_rgb(10_8_40/0.6)] backdrop:bg-[rgb(6_8_22/0.62)] backdrop:backdrop-blur-[6px] md:max-w-[var(--w)] ${sheet}`}
      style={{ '--w': `${width}px`, ...(alert ? { maxWidth: Math.min(width, 400) } : {}) } as CSSProperties}
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col">
          <div {...swipe} className={alert ? '' : 'max-md:touch-none'}>
            {/* The aurora edge on a box; a grab handle on a phone's sheet. */}
            <span aria-hidden className={`h-1 shrink-0 bg-aurora ${alert ? 'block' : 'hidden md:block'}`} />
            {!alert && <span aria-hidden className="mx-auto mt-2.5 block h-1 w-10 rounded-full bg-ink-soft/35 md:hidden" />}
            <header className={`flex items-start gap-3 px-6 pb-3 ${alert ? 'pt-5' : 'pt-3 md:pt-5'}`}>
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="font-display text-[21px] leading-tight font-semibold tracking-[-0.01em]">
                  {title}
                </h2>
                {description && (
                  <p id={descriptionId} className="mt-1 text-[13.5px] text-ink-soft">
                    {description}
                  </p>
                )}
              </div>
              {dismissible && !alert && (
                <IconButton label="Close" size={36} onClick={onClose} className="-mt-1 -mr-2">
                  <X size={18} />
                </IconButton>
              )}
            </header>
          </div>
          <div className={`min-h-0 flex-1 overflow-y-auto px-6 ${alert ? 'pb-5' : 'pb-[max(24px,env(safe-area-inset-bottom))]'}`}>{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  // The hint sits outside the label so the field's name is just the label.
  return (
    <div>
      <label className="block">
        <span className="mb-1.5 block text-[13.5px] font-semibold">{label}</span>
        {children}
      </label>
      {error ? (
        <span className="mt-1 block text-[13px] text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[13px] text-ink-soft">{hint}</span>
      ) : null}
    </div>
  );
}

export const inputClass =
  'h-12 w-full rounded-2xl border border-line bg-subtle/60 px-4 text-[15px] text-ink placeholder:text-ink-soft/70 outline-none transition-[border-color,background-color,box-shadow] focus:border-brand focus:bg-surface focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_18%,transparent)]';

/** "Are you sure?" with the consequence spelled out. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirm,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={420} alert>
      <div className="text-[14.5px] text-ink-soft">{body}</div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
          {confirm}
        </Button>
      </div>
    </Dialog>
  );
}
