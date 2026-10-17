import { X } from 'lucide-react';
import { useUi } from '../store/ui';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[max(12px,env(safe-area-inset-top))] z-[60] flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={`pop-in pointer-events-auto flex max-w-md items-start gap-3 rounded-2xl py-2.5 pr-2 pl-4 text-[14px] shadow-[0_12px_30px_-12px_rgb(10_30_25/0.5)] ${
            t.tone === 'error'
              ? 'bg-oxide text-white'
              : t.tone === 'live'
                ? 'bg-taxi text-on-taxi'
                : 'bg-shutter-deep text-on-shutter'
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
