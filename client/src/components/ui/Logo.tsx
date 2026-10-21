import { useId } from 'react';

/** The app mark: an "A" on the aurora gradient, with a cyan "live" dot. */
export function Logo({ size = 40, className = '' }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={`shrink-0 ${className}`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7C5CFF" />
          <stop offset="1" stopColor="#FF5CA8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${id})`} />
      <path d="M20 46 32 16l12 30M24.5 36h15" fill="none" stroke="white" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="49" cy="15" r="6" fill="#22D3EE" stroke="white" strokeWidth="2.5" />
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
