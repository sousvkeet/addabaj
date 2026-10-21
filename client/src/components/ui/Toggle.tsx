/** An on/off switch with its label and an explanation. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-4 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        {hint && <span className="mt-0.5 block text-[13.5px] text-ink-soft">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand ${
          checked ? 'bg-aurora shadow-glow' : 'bg-line'
        }`}
      >
        <span className={`absolute top-1 size-5 rounded-full bg-white shadow transition-[left] ${checked ? 'left-6' : 'left-1'}`} />
      </span>
    </label>
  );
}
