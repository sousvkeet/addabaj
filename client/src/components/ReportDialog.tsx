import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useChat } from '../store/chat';
import { toast } from '../store/ui';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

/** What's being reported: a person (from their chat), or a message of theirs in a chat or room. */
export type ReportTarget = { scope: 'user' | 'dm' | 'room'; userId: string; name: string; messageId?: number };

const REASONS = [
  { value: 'spam', label: 'Spam', hint: 'Unwanted ads, scams or the same thing over and over' },
  { value: 'harassment', label: 'Harassment or bullying', hint: 'Threats, insults, or not leaving someone alone' },
  { value: 'inappropriate', label: 'Inappropriate content', hint: 'Sexual, violent or hateful messages or pictures' },
  { value: 'impersonation', label: 'Pretending to be someone', hint: 'Using another person’s name or photo' },
  { value: 'other', label: 'Something else', hint: 'Tell the host below' },
] as const;

/** Sends a report to the site's host admin, who can see the messages and act on it. Optionally blocks them too. */
export function ReportDialog({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState<(typeof REASONS)[number]['value'] | ''>('');
  const [details, setDetails] = useState('');
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const blockedAlready = useChat((s) => !!target && !!(s.users[target.userId] ?? s.conversations[target.userId]?.partner)?.blocked);

  useEffect(() => {
    setReason('');
    setDetails('');
    // In a chat, blocking them goes with reporting (unless unticked); in a room, it's up to you.
    setBlock(target?.scope !== 'room');
  }, [target]);

  async function send() {
    if (!target || !reason) return;
    setBusy(true);
    try {
      const alsoBlock = block && !blockedAlready;
      await api('/reports', {
        method: 'POST',
        body: { scope: target.scope, targetId: target.userId, messageId: target.messageId, reason, details: details.trim() || undefined, block: alsoBlock },
      });
      if (alsoBlock) useChat.getState().noteBlocked(target.userId, true);
      toast(alsoBlock ? `Reported and blocked ${target.name}. Thanks for telling the host.` : 'Report sent. Thanks for telling the host.');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const what = target?.scope === 'user' ? target.name : 'this message';
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={`Report ${what}?`}
      description={
        target?.scope === 'user'
          ? `The site's host sees your report and your last messages with ${target.name}, and decides what to do.`
          : `The site's host sees your report with this message and the ones before it, and decides what to do. ${target?.name ?? 'They'} isn't told who reported it.`
      }
      width={460}
    >
      <fieldset>
        <legend className="mb-2 text-[13.5px] font-semibold text-ink-soft">What's wrong?</legend>
        <div className="space-y-1.5">
          {REASONS.map((r) => (
            <label
              key={r.value}
              className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-3.5 py-2.5 transition-colors ${
                reason === r.value ? 'border-brand/60 bg-brand/8' : 'border-line/70 hover:bg-subtle'
              }`}
            >
              <input type="radio" name="report-reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} className="mt-1 accent-[var(--brand)]" />
              <span className="min-w-0">
                <span className="block font-semibold">{r.label}</span>
                <span className="block text-[13px] text-ink-soft">{r.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-[13.5px] font-semibold text-ink-soft">Anything else the host should know? (optional)</span>
        <textarea
          value={details}
          onChange={(e) => setDetails(e.target.value.slice(0, 500))}
          rows={3}
          className="w-full resize-none rounded-2xl border border-line/70 bg-subtle px-3.5 py-2.5 text-[14.5px] text-ink outline-none focus:border-brand"
        />
      </label>
      {!blockedAlready && (
        <label className="mt-3 flex cursor-pointer items-start gap-3 text-[14px]">
          <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} className="mt-1 size-4 accent-[var(--brand)]" />
          <span>
            <span className="block font-semibold">Also block {target?.name}</span>
            <span className="block text-[13px] text-ink-soft">They won't be able to message or call you.</span>
          </span>
        </label>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" busy={busy} disabled={!reason} onClick={() => void send()}>
          Send report
        </Button>
      </div>
    </Dialog>
  );
}
