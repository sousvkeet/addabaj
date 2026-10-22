import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AudioLines, ChevronRight, DoorOpen, FileImage, Flag, KeyRound, LoaderCircle, MessageCircle, Phone, Radio, RefreshCw, Users, Wifi } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { useReports } from '../../store/reports';
import { Button, IconButton } from '../../components/ui/Button';
import { ChangePasswordDialog } from '../../components/ChangePasswordDialog';
import { AdminPage, Chip, Panel, uptime, type Overview as Base } from './shared';

type Data = Base & { reports?: { open: number } };

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export function Overview() {
  const user = useAuth((s) => s.user);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const [tick, setTick] = useState(0);
  const waiting = useReports((s) => s.open) ?? data?.reports?.open ?? 0;

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<Data>('/admin/overview')
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError('');
          if (d.reports) useReports.getState().setOpen(d.reports.open);
        })
        .catch((err) => !cancelled && setError(errorMessage(err)));
    void load();
    // Keep the "right now" numbers fresh.
    const id = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [tick]);

  return (
    <AdminPage
      title="Overview"
      subtitle="What's happening on Adda Khana"
      actions={
        <IconButton label="Refresh" variant="soft" onClick={() => setTick((n) => n + 1)}>
          <RefreshCw size={18} />
        </IconButton>
      }
    >
      {user?.mustChangePassword && (
        <div className="flex flex-wrap items-center gap-4 rounded-[26px] border border-amber-400/40 bg-amber-400/10 p-5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-amber-400/20 text-amber-600 dark:text-amber-300">
            <KeyRound size={21} />
          </span>
          <div className="min-w-[220px] flex-1">
            <p className="font-semibold">You're using the default admin password</p>
            <p className="text-[13.5px] text-ink-soft">Anyone who knows "admin" can run your site. Choose your own password now.</p>
          </div>
          <Button onClick={() => setChanging(true)}>Change password</Button>
        </div>
      )}

      {waiting > 0 && (
        <Link
          to="/admin/reports"
          className="flex items-center gap-4 rounded-[26px] border border-brand/30 bg-brand/10 p-5 transition-colors hover:border-brand/50 hover:bg-brand/15"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-aurora text-white shadow-glow">
            <Flag size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{waiting === 1 ? '1 report waiting' : `${waiting.toLocaleString()} reports waiting`}</span>
            <span className="block text-[13.5px] text-ink-soft">Messages and people reported to you. Have a look and decide what to do.</span>
          </span>
          <ChevronRight size={20} className="shrink-0 text-ink-soft" />
        </Link>
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
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat Icon={Users} label="People" value={data.users.total} sub={`+${data.users.newThisWeek} this week`} to="/admin/people" />
            <Stat Icon={Wifi} label="Online now" value={data.users.online} sub={`of ${data.users.total} people`} tone="live" />
            <Stat Icon={DoorOpen} label="Rooms" value={data.rooms.total} sub={`${data.rooms.activeToday} active today`} to="/admin/rooms" />
            <Stat Icon={MessageCircle} label="Messages today" value={data.messages.today} sub={`${data.messages.total.toLocaleString()} in all`} />
            <Stat Icon={AudioLines} label="In room voice" value={data.now.inVoice} sub="talking right now" tone="live" />
            <Stat Icon={Phone} label="Calls" value={data.now.calls} sub="one-to-one, right now" tone="live" />
            <Stat Icon={Radio} label="Videos playing" value={data.rooms.watching} sub={`${data.now.liveStreams} live from a device`} tone="live" />
            <Stat Icon={FileImage} label="Files shared" value={data.files.count} sub={formatBytes(data.files.bytes)} />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Bars title="New people" hint="Sign-ups, last 14 days" values={data.days.map((d) => ({ day: d.day, value: d.signups }))} />
            <Bars title="Messages" hint="Chats and rooms, last 14 days" values={data.days.map((d) => ({ day: d.day, value: d.messages }))} />
          </div>

          {data.videoTools && <VideoTools tools={data.videoTools} />}

          <Panel title="Server">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Fact label="Up for">{uptime(data.server.uptime)}</Fact>
              <Fact label="Memory">{formatBytes(data.server.memory)}</Fact>
              <Fact label="Node.js">{data.server.node}</Fact>
              <Fact label="Sign-ups">
                <Link to="/admin/settings">{data.signupsOpen ? <Chip tone="live">Open</Chip> : <Chip tone="danger">Closed</Chip>}</Link>
              </Fact>
            </dl>
          </Panel>
        </>
      )}
      <ChangePasswordDialog open={changing} onClose={() => setChanging(false)} />
    </AdminPage>
  );
}

/** One tool "Find videos" relies on: what it is, whether it works, and the command that fixes it. */
function Tool({ name, what, ok, off, status, fix }: { name: string; what: string; ok: boolean | null; off?: boolean; status: ReactNode; fix?: string }) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
      <span className="min-w-[180px] flex-1">
        <span className="block font-semibold">{name}</span>
        <span className="block text-[13px] text-ink-soft">{what}</span>
      </span>
      <span className="flex max-w-full flex-col items-end gap-1 text-right">
        {off ? (
          <Chip tone="muted">Off</Chip>
        ) : ok === null ? (
          <Chip tone="muted">Checking…</Chip>
        ) : ok ? (
          <Chip tone="live">Working</Chip>
        ) : (
          <Chip tone="danger">Not working</Chip>
        )}
        <span className="text-[13px] text-ink-soft">{status}</span>
        {!off && !ok && ok !== null && fix && (
          <code className="rounded-lg bg-subtle px-2 py-0.5 text-[12.5px] break-all">{fix}</code>
        )}
      </span>
    </li>
  );
}

function VideoTools({ tools }: { tools: NonNullable<Data['videoTools']> }) {
  const { ytdlp, ffmpeg, browser, adBlock } = tools;
  const broken = !ytdlp.version || !ffmpeg.installed || (browser.enabled && browser.checked && !browser.ok);
  return (
    <Panel
      title="Finding videos"
      hint={
        broken
          ? 'Something "Find videos" needs is missing, so links from some sites won’t work. Run the command shown on the server, in the project folder, then restart it.'
          : 'What the server uses to find the video on a pasted link, like a download manager.'
      }
    >
      <ul className="divide-y divide-line/70">
        <Tool name="yt-dlp" what="Understands about 1,800 sites" ok={!!ytdlp.version} status={ytdlp.version ? `Version ${ytdlp.version}` : 'Not installed'} fix={ytdlp.fix} />
        <Tool name="FFmpeg" what="Joins sites’ separate picture and sound" ok={ffmpeg.installed} status={ffmpeg.installed ? 'Installed' : 'Not installed'} fix={ffmpeg.fix} />
        <Tool
          name="Background browser"
          what="Opens pages and catches the stream when nothing else finds it"
          ok={browser.checked ? browser.ok : null}
          off={!browser.enabled}
          status={!browser.enabled ? 'Turned off (DEEP_SCAN=false)' : browser.ok ? 'Ready' : browser.problem ?? ''}
          fix={browser.enabled ? browser.fix : undefined}
        />
        <Tool
          name="Ad blocking"
          what="Blocks ads and trackers while searching, with the filter lists Brave uses"
          ok={adBlock.ready ? true : adBlock.error ? false : null}
          off={!adBlock.enabled}
          status={
            !adBlock.enabled
              ? 'Turned off (AD_BLOCK=false)'
              : adBlock.ready
                ? `${adBlock.rules.toLocaleString()} rules${adBlock.updatedAt ? `, updated ${dayName.format(new Date(adBlock.updatedAt))}` : ''}`
                : adBlock.error
                  ? `Couldn’t download the filter lists: ${adBlock.error}`
                  : 'Downloading the filter lists…'
          }
        />
      </ul>
    </Panel>
  );
}

function Stat({
  Icon,
  label,
  value,
  sub,
  to,
  tone = 'brand',
}: {
  Icon: typeof Users;
  label: string;
  value: number;
  sub: string;
  to?: string;
  tone?: 'brand' | 'live';
}) {
  const body = (
    <>
      <span
        className={`flex size-10 items-center justify-center rounded-2xl ${
          tone === 'live' ? 'bg-live/15 text-live-ink' : 'bg-aurora text-white shadow-glow'
        }`}
      >
        <Icon size={19} />
      </span>
      <p className="mt-4 text-[13px] font-semibold text-ink-soft">{label}</p>
      <p className="font-display text-[30px] leading-tight font-bold tracking-[-0.02em] tabular-nums">{value.toLocaleString()}</p>
      <p className="truncate text-[12.5px] text-ink-soft">{sub}</p>
    </>
  );
  const box = 'block rounded-[24px] border border-line/70 bg-surface/60 p-4 transition-colors';
  return to ? (
    <Link to={to} className={`${box} hover:border-brand/50 hover:bg-subtle/50`}>
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}

function Bars({ title, hint, values }: { title: string; hint: string; values: { day: string; value: number }[] }) {
  const max = Math.max(1, ...values.map((v) => v.value));
  const total = values.reduce((n, v) => n + v.value, 0);
  return (
    <Panel title={title} hint={hint} action={<span className="font-display text-[22px] font-bold tabular-nums">{total.toLocaleString()}</span>}>
      <div className="flex h-36 items-end gap-1.5" role="img" aria-label={`${title}: ${values.map((v) => v.value).join(', ')}`}>
        {values.map((v) => (
          <div key={v.day} className="group relative flex h-full flex-1 flex-col justify-end">
            <span className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 rounded-lg bg-ink px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap text-surface group-hover:block">
              {dayName.format(new Date(`${v.day}T12:00:00`))}: {v.value}
            </span>
            <span
              className={`w-full rounded-t-lg rounded-b-sm transition-[height] duration-500 ${v.value ? 'bg-aurora' : 'bg-line/60'}`}
              style={{ height: `${Math.max(v.value ? 6 : 3, (v.value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5 text-center text-[11px] font-semibold text-ink-soft">
        {values.map((v) => (
          <span key={v.day} className="flex-1">
            {weekday.format(new Date(`${v.day}T12:00:00`))}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12.5px] font-semibold text-ink-soft">{label}</dt>
      <dd className="mt-0.5 font-display text-[17px] font-semibold">{children}</dd>
    </div>
  );
}
