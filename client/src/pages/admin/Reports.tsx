import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  ChevronUp,
  CircleCheck,
  CircleMinus,
  ExternalLink,
  FileText,
  Film,
  Flag,
  Forward,
  ImageOff,
  LoaderCircle,
  Mic,
  Phone,
  Power,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { clock, dayLabel, lastSeen, sameDay } from '../../lib/format';
import { useReports } from '../../store/reports';
import { toast } from '../../store/ui';
import { Button, IconButton } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { AdminPage, Chip } from './shared';

type Reason = 'spam' | 'harassment' | 'inappropriate' | 'impersonation' | 'other';
type Action = 'resolve' | 'dismiss' | 'reopen' | 'delete-message' | 'switch-off';
type Tab = 'open' | 'closed';
type Person = { id: string; name: string; handle: string | null };

/** A message as it was when the report was made. */
type Kept = {
  id: number;
  senderId: string | null;
  senderName: string | null;
  kind: 'text' | 'call' | 'system';
  body: string;
  file: { id: string; kind: 'image' | 'video' | 'voice' | 'file'; name: string } | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  forwarded: boolean;
};

type Report = {
  id: string;
  /** A person; a message in a one-to-one chat; a message in a room. */
  scope: 'user' | 'dm' | 'room';
  reason: Reason;
  details: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  /** What the host did about it. */
  actions: ('deleted-message' | 'switched-off')[];
  createdAt: string;
  handledAt: string | null;
  handledBy: string | null;
  messageId: number | null;
  room: { id: string; name: string | null } | null;
  reporter: Person | null;
  target: (Person & { email: string; disabled: boolean; reports: number }) | (Person & { email: string; gone: true }) | null;
  /** The reported message and up to 10 before it; for a person, the end of the reporter's chat with them. */
  messages: Kept[];
  /** What the reported message said before each edit, oldest first. */
  edits: { body: string; editedAt: string }[];
  /** Whether the reported message is deleted now (null: not about a message). */
  messageDeleted: boolean | null;
};

type List = { reports: Report[]; hasMore: boolean; open: number };

const REASONS: Record<Reason, string> = {
  spam: 'Spam',
  harassment: 'Harassment or bullying',
  inappropriate: 'Inappropriate content',
  impersonation: 'Pretending to be someone',
  other: 'Something else',
};

const DID: Record<string, string> = { 'deleted-message': 'message deleted', 'switched-off': 'account switched off' };

const DONE: Record<Action, (r: Report) => string> = {
  resolve: () => 'Marked as resolved.',
  dismiss: () => 'Dismissed.',
  reopen: () => "Reopened. It's waiting again.",
  'delete-message': () => 'The message was deleted for everyone.',
  'switch-off': (r) => `${r.target?.name ?? 'They'} was logged out and can't log in.`,
};

const PAGE = 20;
/** Messages a report shows before "Show earlier". */
const SHOWN = 4;

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "just now", "5 min ago", "today at 4:05 PM", "12 Oct". */
function Stamp({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={full.format(new Date(iso))}>
      {lastSeen(iso).replace('Last seen ', '')}
    </time>
  );
}

const about = (r: Report) => (r.scope === 'user' ? 'A person' : r.scope === 'room' ? `A message in ${r.room?.name ?? 'a room'}` : 'A message in a chat');

async function fetchReports(status: Tab, offset: number) {
  const params = new URLSearchParams({ status, limit: String(PAGE), offset: String(offset) });
  const list = await api<List>(`/admin/reports?${params}`);
  useReports.getState().setOpen(list.open);
  return list;
}

/** Another report about the same person or message, brought up to date after acting on `done`. */
function sync(r: Report, done: Report): Report {
  let next = r;
  if (done.target && r.target?.id === done.target.id) next = { ...next, target: done.target };
  if (done.messageId != null && r.scope === done.scope && r.messageId === done.messageId) next = { ...next, messageDeleted: done.messageDeleted };
  return next;
}

/** Host admin: what people reported, and what was done about it. */
export function Reports() {
  const open = useReports((s) => s.open);
  const [tab, setTab] = useState<Tab>('open');
  const [data, setData] = useState<{ reports: Report[]; hasMore: boolean } | null>(null);
  const [error, setError] = useState('');
  const [reloads, setReloads] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // What's being done to each report right now (by its id).
  const [busy, setBusy] = useState<Record<string, Action>>({});
  const [confirming, setConfirming] = useState<{ report: Report; action: 'delete-message' | 'switch-off' } | null>(null);
  // New reports since the list loaded: offered with a button, so the list doesn't move under the host's finger.
  const [fresh, setFresh] = useState(false);
  const baseline = useRef<number | null>(null);
  const shownTab = useRef<Tab | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (shownTab.current !== tab) setData(null);
    setError('');
    baseline.current = null;
    fetchReports(tab, 0).then(
      (list) => {
        if (cancelled) return;
        shownTab.current = tab;
        setData(list);
        setFresh(false);
        if (tab === 'open') baseline.current = list.open;
      },
      (err) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [tab, reloads]);

  useEffect(() => {
    if (tab !== 'open' || open === null || baseline.current === null) return;
    if (open > baseline.current) setFresh(true);
    else baseline.current = open;
  }, [open, tab]);

  // Everything shown was handled but there are more: fetch them.
  useEffect(() => {
    if (data && !data.reports.length && data.hasMore) setReloads((n) => n + 1);
  }, [data]);

  async function more() {
    if (!data) return;
    const asked = tab;
    setLoadingMore(true);
    try {
      const list = await fetchReports(asked, data.reports.length);
      if (shownTab.current !== asked) return;
      setData((d) => d && { reports: [...d.reports, ...list.reports.filter((r) => !d.reports.some((x) => x.id === r.id))], hasMore: list.hasMore });
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoadingMore(false);
    }
  }

  async function act(report: Report, action: Action) {
    setBusy((b) => ({ ...b, [report.id]: action }));
    try {
      const res = await api<{ report: Report }>(`/admin/reports/${report.id}`, { method: 'POST', body: { action } });
      const done = res.report;
      // Out of this tab if it's moved to the other one.
      const stays = (done.status === 'open') === (shownTab.current === 'open');
      setData((d) => d && { ...d, reports: d.reports.flatMap((r) => (r.id === done.id ? (stays ? [done] : []) : [sync(r, done)])) });
      setConfirming(null);
      toast(DONE[action](done), 'live');
      void useReports.getState().load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[report.id];
        return next;
      });
    }
  }

  const c = confirming;
  const tabs: { id: Tab; label: string; count?: number | null }[] = [
    { id: 'open', label: 'Waiting', count: open },
    { id: 'closed', label: 'Handled' },
  ];

  return (
    <AdminPage
      title="Reports"
      subtitle="Messages and people reported to you"
      actions={
        <IconButton label="Refresh" variant="soft" onClick={() => setReloads((n) => n + 1)}>
          <RefreshCw size={18} />
        </IconButton>
      }
    >
      <div role="tablist" aria-label="Reports" className="grid grid-cols-2 gap-1 rounded-xl bg-subtle p-1 sm:w-[340px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[14px] font-semibold transition-colors ${
              tab === t.id ? 'bg-aurora text-white shadow-glow' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {t.label}
            {!!t.count && (
              <span
                className={`min-w-[20px] rounded-full px-1.5 text-center text-[12px] leading-[20px] tabular-nums ${
                  tab === t.id ? 'bg-white/25 text-white' : 'bg-ink-soft/15 text-ink'
                }`}
              >
                {t.count > 99 ? '99+' : t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {fresh && tab === 'open' && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => setReloads((n) => n + 1)}>
            <RefreshCw size={15} />
            New reports came in. Show them
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
          {error}
        </p>
      )}

      {!data ? (
        !error && (
          <p className="flex justify-center py-16 text-ink-soft">
            <LoaderCircle className="animate-spin" />
          </p>
        )
      ) : data.reports.length === 0 ? (
        !data.hasMore && (
          <div className="rounded-[26px] border border-dashed border-line px-6 py-12 text-center text-ink-soft">
            <Flag size={22} className="mx-auto mb-2 opacity-60" />
            {tab === 'open' ? 'Nothing waiting. Reports people send come here.' : 'No handled reports yet.'}
          </div>
        )
      ) : (
        <ul aria-label={tab === 'open' ? 'Waiting reports' : 'Handled reports'} className="space-y-3">
          {data.reports.map((r) => (
            <li key={r.id}>
              <ReportCard
                report={r}
                busy={busy[r.id] ?? null}
                onAction={(action) => (action === 'delete-message' || action === 'switch-off' ? setConfirming({ report: r, action }) : void act(r, action))}
              />
            </li>
          ))}
        </ul>
      )}

      {data?.hasMore && !!data.reports.length && (
        <div className="flex justify-center">
          <Button variant="soft" busy={loadingMore} onClick={() => void more()}>
            Show more
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!c}
        title={c?.action === 'switch-off' ? `Switch off ${c.report.target?.name ?? ''}?` : 'Delete this message?'}
        body={
          c?.action === 'switch-off' ? (
            <>
              They're logged out everywhere and can't log in until you switch their account back on in People. Their messages stay. The report is
              marked resolved.
            </>
          ) : (
            <>
              It's deleted for everyone in the {c?.report.scope === 'room' ? 'room' : 'chat'}, with any photo or file in it. The report keeps its
              copy and is marked resolved.
            </>
          )
        }
        confirm={c?.action === 'switch-off' ? 'Switch off' : 'Delete message'}
        danger
        busy={!!c && !!busy[c.report.id]}
        onConfirm={() => c && void act(c.report, c.action)}
        onClose={() => setConfirming(null)}
      />
    </AdminPage>
  );
}

function ReportCard({ report: r, busy, onAction }: { report: Report; busy: Action | null; onAction: (action: Action) => void }) {
  const t = r.target;
  const target = t && !('gone' in t) ? t : null;
  const waiting = r.status === 'open';
  const canDelete = waiting && r.scope !== 'user' && r.messageId != null && !r.messageDeleted;
  const canSwitchOff = waiting && !!target && !target.disabled;
  const did = r.actions.map((a) => DID[a] ?? a).join(', ');
  // A spinner instead of its icon while a button's request runs.
  const icon = (action: Action, node: ReactNode) => (busy === action ? null : node);

  return (
    <article aria-label={`${REASONS[r.reason] ?? 'Report'}: ${about(r)}`} className="rounded-[26px] border border-line/70 bg-surface/60 p-4 sm:p-5">
      <header className="flex items-start gap-3">
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-2xl ${waiting ? 'bg-danger/12 text-danger' : 'bg-subtle text-ink-soft'}`}
        >
          <Flag size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[16px] leading-snug font-semibold">{REASONS[r.reason] ?? 'Something else'}</h2>
          <p className="text-[13px] break-words text-ink-soft">
            {about(r)} · <Stamp iso={r.createdAt} />
          </p>
        </div>
      </header>

      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Who label="Reported by" person={r.reporter} />
        <ArrowRight size={18} aria-hidden className="hidden self-center text-ink-soft sm:block" />
        <Who label="Person reported" person={t} email={t?.email}>
          {t && 'gone' in t && <Chip tone="muted">Account removed</Chip>}
          {target?.disabled && <Chip tone="danger">Switched off</Chip>}
          {target && target.reports > 1 && <Chip tone="warn">{target.reports} reports in all</Chip>}
        </Who>
      </div>

      {r.details && (
        <blockquote className="mt-3 rounded-2xl border-l-[3px] border-brand bg-subtle/60 px-4 py-2.5 dark:border-live">
          <p className="text-[12px] font-semibold text-ink-soft">{r.reporter?.name ?? 'The reporter'} wrote</p>
          <p className="text-[14px] break-words whitespace-pre-wrap">“{r.details}”</p>
        </blockquote>
      )}

      <Transcript report={r} />

      {waiting ? (
        // Phones: two buttons a row; wider screens: one row, closing it on the right.
        <footer className="mt-4 grid grid-cols-2 gap-2 border-t border-line/70 pt-4 sm:flex sm:flex-wrap sm:items-center">
          {canDelete && (
            <Button size="sm" variant="danger-soft" className={canSwitchOff ? '' : 'col-span-2'} disabled={!!busy} onClick={() => onAction('delete-message')}>
              <Trash2 size={15} />
              Delete message
            </Button>
          )}
          {canSwitchOff && (
            <Button
              size="sm"
              variant="danger-soft"
              aria-label={`Switch off ${target.name}`}
              className={`min-w-0 sm:max-w-full ${canDelete ? '' : 'col-span-2'}`}
              disabled={!!busy}
              onClick={() => onAction('switch-off')}
            >
              <Power size={15} className="shrink-0" />
              <span className="min-w-0 truncate">
                Switch off<span className="hidden sm:inline"> {target.name}</span>
              </span>
            </Button>
          )}
          <Button size="sm" variant="soft" className="sm:ml-auto" busy={busy === 'dismiss'} disabled={!!busy} onClick={() => onAction('dismiss')}>
            {icon('dismiss', <X size={15} />)}
            Dismiss
          </Button>
          <Button size="sm" busy={busy === 'resolve'} disabled={!!busy} onClick={() => onAction('resolve')}>
            {icon('resolve', <Check size={15} />)}
            Resolve
          </Button>
        </footer>
      ) : (
        <footer className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line/70 pt-4">
          <p className="mr-auto flex min-w-0 items-start gap-2 text-[13.5px] text-ink-soft">
            {r.status === 'dismissed' ? (
              <CircleMinus size={17} className="mt-px shrink-0" />
            ) : (
              <CircleCheck size={17} className="mt-px shrink-0 text-live-ink" />
            )}
            <span className="min-w-0">
              <span className="font-semibold text-ink">{r.status === 'dismissed' ? 'Dismissed' : 'Resolved'}</span>
              {r.handledBy && ` by ${r.handledBy}`}
              {r.handledAt && (
                <>
                  , <Stamp iso={r.handledAt} />
                </>
              )}
              {did && `: ${did}`}
            </span>
          </p>
          <Button size="sm" variant="soft" className="ml-auto" busy={busy === 'reopen'} onClick={() => onAction('reopen')}>
            {icon('reopen', <RotateCcw size={15} />)}
            Reopen
          </Button>
        </footer>
      )}
    </article>
  );
}

/** Who reported, or who was reported: name, @handle, email and how they stand. */
function Who({ label, person, email, children }: { label: string; person: { name: string; handle: string | null } | null; email?: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl bg-subtle/60 px-3.5 py-2.5">
      <p className="text-[12px] font-semibold text-ink-soft">{label}</p>
      {person ? (
        <>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="min-w-0 font-semibold break-words">{person.name}</span>
            {person.handle && <span className="min-w-0 text-[13px] break-words text-ink-soft">@{person.handle}</span>}
            {children}
          </p>
          {email && <p className="text-[13px] break-words text-ink-soft">{email}</p>}
        </>
      ) : (
        <p className="text-[14px] text-ink-soft italic">Account removed</p>
      )}
    </div>
  );
}

/** The messages kept with the report, as a short chat; the reported one stands out. */
function Transcript({ report: r }: { report: Report }) {
  const [all, setAll] = useState(false);
  const { messages } = r;
  if (!messages.length) {
    return r.scope === 'user' ? <p className="mt-3 text-[13.5px] text-ink-soft">They had no messages with each other.</p> : null;
  }
  const at = messages.findIndex((m) => m.id === r.messageId);
  // The last few, always including the reported one.
  const from = all ? 0 : Math.max(0, Math.min(messages.length - SHOWN, at < 0 ? messages.length : at));
  const shown = messages.slice(from);

  return (
    <section aria-label="Messages" className="mt-3 rounded-2xl border border-line/70 bg-canvas/50 p-1.5 sm:p-2">
      <p className="px-2 pt-1 pb-1 text-[12.5px] font-semibold text-ink-soft">
        {r.scope === 'user' ? 'Their chat when it was reported' : 'The conversation when it was reported'}
      </p>
      {(all || from > 0) && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          aria-expanded={all}
          className="mx-auto flex items-center gap-1 rounded-full px-3 py-1 text-[12.5px] font-semibold text-brand hover:bg-subtle dark:text-live"
        >
          <ChevronUp size={14} className={all ? 'rotate-180' : ''} />
          {all ? 'Show fewer' : `Show ${from} earlier ${from === 1 ? 'message' : 'messages'}`}
        </button>
      )}
      <ol>
        {shown.map((m, i) => (
          <Fragment key={m.id}>
            {(i === 0 || !sameDay(shown[i - 1].createdAt, m.createdAt)) && (
              <li className="py-1 text-center text-[11.5px] font-semibold text-ink-soft">{dayLabel(m.createdAt)}</li>
            )}
            <Line m={m} report={r} reported={m.id === r.messageId} />
          </Fragment>
        ))}
      </ol>
    </section>
  );
}

function Line({ m, report, reported }: { m: Kept; report: Report; reported: boolean }) {
  if (m.kind === 'system') return <li className="px-3 py-1 text-center text-[12.5px] break-words text-ink-soft">{m.body}</li>;
  return (
    <li className={`rounded-xl px-2.5 sm:px-3 ${reported ? 'my-1 bg-danger/8 py-2 ring-1 ring-danger/40 ring-inset' : 'py-1.5'}`}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-ink-soft">
        <span className="min-w-0 font-semibold break-words text-ink">{m.senderName ?? 'Removed account'}</span>
        <time dateTime={m.createdAt} title={full.format(new Date(m.createdAt))}>
          {clock(m.createdAt)}
        </time>
        {m.forwarded && (
          <span className="inline-flex items-center gap-1">
            <Forward size={12} />
            Forwarded
          </span>
        )}
        {m.editedAt && !m.deletedAt && <span>edited</span>}
        {reported && (
          <span className="ml-auto flex gap-1">
            <Chip tone="danger">Reported</Chip>
            {report.messageDeleted && <Chip tone="muted">Deleted</Chip>}
          </span>
        )}
      </p>
      {m.deletedAt ? (
        <p className="text-[14px] text-ink-soft italic">This message was deleted</p>
      ) : m.kind === 'call' ? (
        <p className="flex items-center gap-1.5 text-[14px] text-ink-soft">
          <Phone size={14} />
          {m.body}
        </p>
      ) : (
        <>
          {m.file && <KeptFile reportId={report.id} file={m.file} gone={reported && !!report.messageDeleted} />}
          {m.body && <p className="text-[14.5px] break-words whitespace-pre-wrap">{m.body}</p>}
        </>
      )}
      {reported && report.edits.length > 0 && (
        <div className="mt-2 border-t border-danger/20 pt-2">
          <p className="text-[12px] font-semibold text-ink-soft">Before it was edited:</p>
          <ol className="mt-1 space-y-1">
            {report.edits.map((e, i) => (
              <li key={i} className="border-l-2 border-line pl-2.5 text-[14px]">
                <span className="break-words whitespace-pre-wrap">{e.body}</span>
                <span className="ml-2 text-[12px] whitespace-nowrap text-ink-soft">
                  changed at{' '}
                  <time dateTime={e.editedAt} title={full.format(new Date(e.editedAt))}>
                    {clock(e.editedAt)}
                  </time>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

/** A photo (as a thumbnail) or a file (as a link) from a kept message; opens in a new tab. */
function KeptFile({ reportId, file, gone }: { reportId: string; file: NonNullable<Kept['file']>; gone: boolean }) {
  const [broken, setBroken] = useState(false);
  const url = `/api/admin/reports/${reportId}/files/${file.id}`;
  if (gone || broken) {
    return (
      <p className="my-1 inline-flex items-center gap-1.5 rounded-xl bg-subtle px-2.5 py-1.5 text-[12.5px] text-ink-soft">
        <ImageOff size={14} />
        File deleted
      </p>
    );
  }
  if (file.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open photo ${file.name}`} className="my-1 block w-fit max-w-full">
        <img
          src={url}
          alt={file.name}
          loading="lazy"
          onError={() => setBroken(true)}
          className="max-h-40 max-w-full rounded-xl border border-line/70 bg-subtle object-contain"
        />
      </a>
    );
  }
  const Icon = file.kind === 'video' ? Film : file.kind === 'voice' ? Mic : FileText;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="my-1 flex w-fit max-w-full items-center gap-2 rounded-xl bg-subtle px-3 py-2 text-[13.5px] font-semibold transition-colors hover:bg-brand/15"
    >
      <Icon size={16} className="shrink-0 text-brand dark:text-live" />
      <span className="min-w-0 truncate">{file.kind === 'voice' ? 'Voice message' : file.name}</span>
      <ExternalLink size={13} className="shrink-0 text-ink-soft" />
    </a>
  );
}
