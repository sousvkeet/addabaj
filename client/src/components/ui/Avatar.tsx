import { MicOff } from 'lucide-react';
import { initials } from '../../lib/format';

type Props = {
  name: string;
  hue: number;
  size?: number;
  online?: boolean;
  speaking?: boolean;
  muted?: boolean;
  square?: boolean;
  className?: string;
};

export function Avatar({ name, hue, size = 40, online, speaking, muted, square, className = '' }: Props) {
  const dot = Math.max(10, Math.round(size * 0.26));
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
      <span
        aria-hidden
        className={`flex size-full select-none items-center justify-center font-semibold text-white ${
          square ? 'rounded-[30%] font-display font-normal' : 'rounded-full'
        } ${speaking ? 'speaking-ring' : ''}`}
        style={{
          background: `hsl(${hue} 32% 38%)`,
          fontSize: square ? size * 0.5 : size * 0.38,
          lineHeight: 1,
        }}
      >
        {square ? [...name.trim()][0]?.toUpperCase() ?? '#' : initials(name)}
      </span>
      {online && !muted && (
        <span
          className="absolute rounded-full border-2 border-paper bg-taxi"
          style={{ width: dot, height: dot, right: -1, bottom: -1 }}
          aria-label="Online"
        />
      )}
      {muted && (
        <span
          className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full border-2 border-paper bg-oxide text-white"
          style={{ width: dot + 6, height: dot + 6 }}
          aria-label="Muted"
        >
          <MicOff size={dot - 2} strokeWidth={2.5} />
        </span>
      )}
    </span>
  );
}

export function hueFromId(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
