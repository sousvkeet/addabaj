import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { LoaderCircle } from 'lucide-react';

type Variant = 'primary' | 'live' | 'danger' | 'ghost' | 'outline' | 'on-dark';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-shutter text-on-shutter hover:brightness-110',
  live: 'bg-taxi text-on-taxi hover:brightness-105',
  danger: 'bg-oxide text-white hover:brightness-110',
  ghost: 'text-ink hover:bg-limewash',
  outline: 'border border-line text-ink hover:bg-limewash',
  'on-dark': 'bg-white/10 text-on-shutter hover:bg-white/18',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13.5px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-[15px] gap-2 rounded-xl',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-xl',
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
      className={`inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-[filter,background-color] disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
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
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-[filter,background-color] disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
      style={{ width: size, height: size }}
      {...rest}
    >
      {children}
    </button>
  );
}
