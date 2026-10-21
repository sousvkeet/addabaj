import { X } from 'lucide-react';
import { useUi } from '../store/ui';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div
      aria-live="polite"
      // In the app on a phone they rise from the bottom, like Android's own.
      className="pointer-events-none fixed inset-x-0 top-[max(12px,var(--safe-top))] z-[60] flex flex-col items-center gap-2 px-4 app:max-md:top-auto app:max-md:bottom-[calc(84px+var(--safe-bottom))]"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={`pop-in pointer-events-auto flex max-w-md items-start gap-3 rounded-2xl border py-2.5 pr-2 pl-4 text-[14px] font-medium shadow-[0_16px_40px_-14px_rgb(10_8_40/0.6)] ${
            t.tone === 'error'
              ? 'border-white/15 bg-danger text-white'
              : t.tone === 'live'
                ? 'border-white/30 bg-live text-on-live'
                : 'glass-deep border-white/10 text-on-brand'
          }`}
        >
          <span className="py-0.5">{t.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="rounded-full p-1 opacity-70 hover:opacity-100"
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
