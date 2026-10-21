import { useEffect, useId, useRef, type ReactNode } from 'react';
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
};

export function Dialog({ open, onClose, title, description, children, width = 440, dismissible = true }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

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
      className="pop-in m-auto max-h-[min(740px,calc(100dvh-32px))] w-[calc(100%-32px)] overflow-hidden rounded-[28px] border border-line bg-surface p-0 text-ink shadow-[0_40px_90px_-30px_rgb(10_8_40/0.6)] backdrop:bg-[rgb(6_8_22/0.62)] backdrop:backdrop-blur-[6px]"
      style={{ maxWidth: width }}
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col">
          <span aria-hidden className="h-1 shrink-0 bg-aurora" />
          <header className="flex items-start gap-3 px-6 pt-5 pb-3">
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
            {dismissible && (
              <IconButton label="Close" size={36} onClick={onClose} className="-mt-1 -mr-2">
                <X size={18} />
              </IconButton>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
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
    <Dialog open={open} onClose={onClose} title={title} width={420}>
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
