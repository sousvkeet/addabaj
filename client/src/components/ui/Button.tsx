import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { LoaderCircle } from 'lucide-react';

type Variant = 'primary' | 'live' | 'danger' | 'ghost' | 'outline' | 'soft' | 'on-dark';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-aurora text-on-brand shadow-glow hover:brightness-110 active:brightness-95',
  live: 'bg-live text-on-live shadow-[0_8px_24px_-10px_var(--live)] hover:brightness-105 active:brightness-95',
  danger: 'bg-danger text-white shadow-[0_8px_24px_-12px_var(--danger)] hover:brightness-110',
  ghost: 'text-ink hover:bg-subtle',
  outline: 'border border-line bg-surface/40 text-ink hover:border-brand/50 hover:bg-subtle',
  soft: 'bg-subtle text-ink hover:bg-brand/15',
  'on-dark': 'bg-white/10 text-on-brand hover:bg-white/20',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13.5px] gap-1.5 rounded-xl',
  md: 'h-11 px-4.5 text-[15px] gap-2 rounded-2xl',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-2xl',
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean };

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'primary', size = 'md', busy, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      className={`inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-[filter,background-color,border-color,transform] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {busy && <LoaderCircle size={16} className="animate-spin" />}
      {children}
    </button>
  );
});

type IconProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: Variant; size?: number };

export function IconButton({ label, variant = 'ghost', size = 40, className = '', children, ...rest }: IconProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-[filter,background-color,transform] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${variants[variant]} ${className}`}
      style={{ width: size, height: size }}
      {...rest}
    >
      {children}
    </button>
  );
}
