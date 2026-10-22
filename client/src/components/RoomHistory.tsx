import { useEffect, useState } from 'react';
import { History, Trash2 } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { clearAfterLabel, MOST } from '../lib/history';
import type { ClearAfter, ClearAfterUnit, RoomDetail } from '../lib/types';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Button } from './ui/Button';
import { inputClass } from './ui/Dialog';

const PRESETS: { label: string; value: ClearAfter | null }[] = [
  { label: 'Off', value: null },
  { label: '1 hour', value: { amount: 1, unit: 'hour' } },
  { label: '24 hours', value: { amount: 24, unit: 'hour' } },
  { label: '7 days', value: { amount: 7, unit: 'day' } },
  { label: '30 days', value: { amount: 30, unit: 'day' } },
  { label: '3 months', value: { amount: 3, unit: 'month' } },
];
const UNITS: { unit: ClearAfterUnit; label: string }[] = [
  { unit: 'minute', label: 'minutes' },
  { unit: 'hour', label: 'hours' },
  { unit: 'day', label: 'days' },
  { unit: 'month', label: 'months' },
];

const same = (a: ClearAfter | null | undefined, b: ClearAfter | null | undefined) =>
  (a ?? null) === (b ?? null) || (!!a && !!b && a.amount === b.amount && a.unit === b.unit);

/**
 * Room settings › Chat history (its admins): messages older than a chosen
 * time clear by themselves, for everyone; or the whole history, now.
 */
export function RoomHistorySettings({ room }: { room: RoomDetail }) {
  const setRoomHistory = useChat((s) => s.setRoomHistory);
  const clearRoomHistory = useChat((s) => s.clearRoomHistory);
  const current = room.clearAfter ?? null;
  const [choice, setChoice] = useState<ClearAfter | null>(current);
  const [custom, setCustom] = useState(() => !!current && !PRESETS.some((p) => same(p.value, current)));
  const [amount, setAmount] = useState(String(current?.amount ?? 15));
  const [unit, setUnit] = useState<ClearAfterUnit>(current?.unit ?? 'minute');
  const [busy, setBusy] = useState<'apply' | 'clear' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');

  // Changed meanwhile (another admin, or here): start from what's set.
  useEffect(() => {
    setChoice(current);
    setCustom(!!current && !PRESETS.some((p) => same(p.value, current)));
  }, [current?.amount, current?.unit]);

  const customValue = (): ClearAfter | null => {
    const n = Number(amount);
    return Number.isInteger(n) && n >= 1 && n <= MOST[unit] ? { amount: n, unit } : null;
  };
  const wanted = custom ? customValue() : choice;
  const changed = custom ? !!wanted && !same(wanted, current) : !same(choice, current);

  async function apply() {
    if (custom && !wanted) return setError(`Choose 1 to ${MOST[unit]} ${unit}s.`);
    setBusy('apply');
    setError('');
    try {
      await setRoomHistory(room.id, wanted);
      toast(wanted ? `Messages now clear after ${clearAfterLabel(wanted)}.` : 'Messages are kept now.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearNow() {
    setBusy('clear');
    setError('');
    try {
      await clearRoomHistory(room.id);
      setConfirm(false);
      toast('The chat history is cleared for everyone.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="room-history" className="mt-6 border-t border-line pt-5">
      <h3 id="room-history" className="flex items-center gap-2 font-semibold">
        <History size={17} className="text-ink-soft" />
        Chat history
      </h3>
      <p className="mt-0.5 text-[14px] text-ink-soft">Clear messages by themselves after a while, for everyone in the room.</p>

      <div role="radiogroup" aria-label="Clear messages after" className="mt-3 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const on = !custom && same(choice, p.value);
          return (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                setCustom(false);
                setChoice(p.value);
                setError('');
              }}
              className={`rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors ${on ? 'bg-aurora text-white shadow-glow' : 'bg-subtle text-ink-soft hover:text-ink'}`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          onClick={() => {
            setCustom(true);
            setError('');
          }}
          className={`rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors ${custom ? 'bg-aurora text-white shadow-glow' : 'bg-subtle text-ink-soft hover:text-ink'}`}
        >
          Custom
        </button>
      </div>

      {custom && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[14px] text-ink-soft">After</span>
          <span className="w-24 shrink-0">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MOST[unit]}
              aria-label="How many"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError('');
              }}
              className={`${inputClass} h-10 text-center`}
            />
          </span>
          <span className="w-36 shrink-0">
            <select
              aria-label="Minutes, hours, days or months"
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value as ClearAfterUnit);
                setError('');
              }}
              className={`${inputClass} h-10 cursor-pointer appearance-auto pr-2`}
            >
              {UNITS.map((u) => (
                <option key={u.unit} value={u.unit}>
                  {u.label}
                </option>
              ))}
            </select>
          </span>
        </div>
      )}

      <p className="mt-2.5 text-[13px] text-ink-soft">
        {current ? `Now: messages older than ${clearAfterLabel(current)} clear by themselves.` : 'Now: messages are kept.'}
        {changed && wanted && ` After you apply this, messages older than ${clearAfterLabel(wanted)} go, starting now.`}
      </p>
      {changed && (
        <Button size="sm" className="mt-3" busy={busy === 'apply'} disabled={!!busy} onClick={() => void apply()}>
          Apply
        </Button>
      )}

      <div className="mt-5">
        <p className="font-medium">Clear the chat history now</p>
        <p className="mt-0.5 text-[13.5px] text-ink-soft">Every message, photo and file in the room goes, for everyone. This can’t be undone.</p>
        {confirm ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-danger/10 p-3">
            <span className="flex-1 text-[14px] text-danger">Clear all of {room.name}’s messages for everyone?</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep them
            </Button>
            <Button size="sm" variant="danger" busy={busy === 'clear'} disabled={!!busy} onClick={() => void clearNow()}>
              Clear history
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="danger-soft" className="mt-3" onClick={() => setConfirm(true)}>
            <Trash2 size={15} />
            Clear chat history
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
