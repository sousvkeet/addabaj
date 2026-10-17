import type { ReactNode } from 'react';
import { Search } from 'lucide-react';

export function ListHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-5 pt-[env(safe-area-inset-top)]">
      <h1 className="font-display text-[26px] leading-none">{title}</h1>
      {action}
    </div>
  );
}

export function ListSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="px-4 pb-2">
      <label className="flex h-10 items-center gap-2 rounded-xl bg-paper/70 px-3 text-ink-soft focus-within:bg-paper focus-within:ring-1 focus-within:ring-line">
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

export function ListEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-6 py-10">
      <p className="font-display text-[19px]">{title}</p>
      <div className="mt-1.5 space-y-4 text-[14px] text-ink-soft">{children}</div>
    </div>
  );
}
