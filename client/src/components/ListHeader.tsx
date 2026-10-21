import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { StatusLine } from './ConnectionNotice';

export function ListHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-[64px] shrink-0 items-center justify-between gap-2 px-5 pt-[max(12px,var(--safe-top))] pb-2 md:pt-[max(18px,var(--safe-top))] md:pb-3">
      <div className="min-w-0">
        <h1 className="font-display text-[24px] leading-tight font-bold tracking-[-0.02em] md:text-[26px]">{title}</h1>
        {subtitle && <p className="hidden truncate text-[13px] text-ink-soft md:block">{subtitle}</p>}
        <p className="truncate text-[13px] text-ink-soft empty:hidden md:hidden">
          <StatusLine />
        </p>
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
    <div className="mx-4 mt-2 rounded-3xl border border-dashed md:mx-2 border-line px-5 py-8 text-center">
      {icon && <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">{icon}</div>}
      <p className="font-display text-[17px] font-semibold">{title}</p>
      <div className="mt-1.5 flex flex-col items-center gap-4 text-[14px] text-ink-soft">{children}</div>
    </div>
  );
}

/** One row in a chat or room list: edge to edge on phones, a card on wider screens. */
export const listRowClass = (active: boolean) =>
  `ripple relative flex items-center gap-3 px-4 py-2.5 transition-colors md:rounded-2xl md:px-3 ${
    active
      ? 'md:bg-brand/12 md:ring-1 md:ring-brand/30 md:before:absolute md:before:top-1/2 md:before:left-0 md:before:h-7 md:before:w-[3px] md:before:-translate-y-1/2 md:before:rounded-full md:before:bg-aurora'
      : 'active:bg-subtle/60 md:hover:bg-subtle/70'
  }`;

/** The list itself: room at the bottom on phones for the floating button. */
export const listClass = 'min-h-0 flex-1 overflow-y-auto pb-24 md:space-y-0.5 md:px-2.5 md:pb-3';

/** Phones: a list's main action floats in its bottom corner, as in other messengers (the header has it on wider screens). */
export function Fab({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="ripple absolute right-4 bottom-4 z-10 flex size-14 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow transition-transform active:scale-95 md:hidden"
    >
      {children}
    </button>
  );
}

/** Unread count on a list row. */
export function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="min-w-[22px] rounded-full bg-aurora px-1.5 text-center text-[12px] leading-[22px] font-bold text-white shadow-glow">
      {count > 99 ? '99+' : count}
    </span>
  );
}
