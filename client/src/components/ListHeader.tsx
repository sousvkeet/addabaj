import type { ReactNode } from 'react';
import { Search } from 'lucide-react';

export function ListHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 px-5 pt-[max(18px,env(safe-area-inset-top))] pb-3">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-ink-soft">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function ListSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="px-4 pb-3">
      <label className="flex h-11 items-center gap-2.5 rounded-2xl border border-line/70 bg-subtle/60 px-3.5 text-ink-soft transition-[border-color,background-color,box-shadow] focus-within:border-brand focus-within:bg-surface focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_16%,transparent)]">
        <Search size={16} />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-soft/80"
        />
      </label>
    </div>
  );
}

export function ListEmpty({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="mx-2 mt-2 rounded-3xl border border-dashed border-line px-5 py-8 text-center">
      {icon && <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">{icon}</div>}
      <p className="font-display text-[17px] font-semibold">{title}</p>
      <div className="mt-1.5 flex flex-col items-center gap-4 text-[14px] text-ink-soft">{children}</div>
    </div>
  );
}

/** One row in a chat or room list. */
export const listRowClass = (active: boolean) =>
  `relative flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors ${
    active
      ? 'bg-brand/12 ring-1 ring-brand/30 before:absolute before:top-1/2 before:left-0 before:h-7 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-aurora'
      : 'hover:bg-subtle/70'
  }`;

/** Unread count on a list row. */
export function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="min-w-[22px] rounded-full bg-aurora px-1.5 text-center text-[12px] leading-[22px] font-bold text-white shadow-glow">
      {count > 99 ? '99+' : count}
    </span>
  );
}
