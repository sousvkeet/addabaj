import { Minus, Plus } from 'lucide-react';
import { IconButton } from './ui/Button';
import { inputClass } from './ui/Dialog';

export const ROOM_MIN = 2;
export const ROOM_MAX = 50;

export function MemberLimit({ value, onChange, min = ROOM_MIN }: { value: number; onChange: (n: number) => void; min?: number }) {
  const lo = Math.max(ROOM_MIN, min);
  const clamp = (n: number) => Math.min(ROOM_MAX, Math.max(lo, Math.round(n) || lo));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <IconButton label="Fewer people" variant="outline" size={40} disabled={value <= lo} onClick={() => onChange(clamp(value - 1))}>
        <Minus size={16} />
      </IconButton>
      <input
        type="number"
        inputMode="numeric"
        aria-label="Maximum members"
        className={`${inputClass} w-[72px] text-center text-[17px] font-semibold tabular-nums`}
        min={lo}
        max={ROOM_MAX}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onBlur={() => onChange(clamp(value))}
      />
      <IconButton label="More people" variant="outline" size={40} disabled={value >= ROOM_MAX} onClick={() => onChange(clamp(value + 1))}>
        <Plus size={16} />
      </IconButton>
      <input
        type="range"
        aria-label="Maximum members slider"
        min={lo}
        max={ROOM_MAX}
        value={Math.min(ROOM_MAX, Math.max(lo, value || lo))}
        onChange={(e) => onChange(Number(e.target.value))}
        className="ml-1 min-w-[120px] flex-1 accent-[var(--brand)]"
      />
    </div>
  );
}
