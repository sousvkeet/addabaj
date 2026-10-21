import { useId } from 'react';

/** The app mark: an "A" on the theme's gradient, with a "live" dot. Colours come from the theme. */
export function Logo({ size = 40, className = '' }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={`shrink-0 ${className}`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--logo-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-b)' }} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${id})`} />
      <path d="M20 46 32 16l12 30M24.5 36h15" fill="none" stroke="white" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="49" cy="15" r="6" style={{ fill: 'var(--logo-dot)' }} stroke="white" strokeWidth="2.5" />
    </svg>
  );
}

/** "Adda Khana", with the second word in the aurora gradient. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-bold tracking-[-0.02em] ${className}`}>
      Adda <span className="text-aurora">Khana</span>
    </span>
  );
}
