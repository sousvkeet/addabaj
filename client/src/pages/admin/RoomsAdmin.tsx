import { useCallback, useEffect, useState } from 'react';
import { AudioLines, LoaderCircle, MonitorPlay, Radio, Search, Square, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { listStamp } from '../../lib/format';
import { toast } from '../../store/ui';
import { Avatar, hueFromId } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { Menu, type MenuItem } from '../../components/ui/Menu';
import { AdminPage, Chip, shortDate, type AdminRoom, type Page } from './shared';

const PAGE = 40;

export function RoomsAdmin() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<Page<AdminRoom> | null>(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleting, setDeleting] = useState<AdminRoom | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (offset = 0) => {
      const params = new URLSearchParams({ q, limit: String(PAGE), offset: String(offset) });
      const page = await api<Page<AdminRoom>>(`/admin/rooms?${params}`);
      setData((prev) => (offset && prev ? { total: page.total, items: [...prev.items, ...page.items] } : page));
    },
    [q],
  );

  useEffect(() => {
    const id = window.setTimeout(() => load().then(() => setError(''), (err) => setError(errorMessage(err))), q ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [load, q]);

  async function stopVideo(room: AdminRoom) {
    try {
      await api(`/admin/rooms/${room.id}/stop-video`, { method: 'POST' });
      setData((d) => d && { ...d, items: d.items.map((r) => (r.id === room.id ? { ...r, watching: null, live: false } : r)) });
      toast(`The video in ${room.name} was stopped.`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/admin/rooms/${deleting.id}`, { method: 'DELETE' });
      setData((d) => d && { total: d.total - 1, items: d.items.filter((r) => r.id !== deleting.id) });
      toast(`${deleting.name} was deleted.`);
      setDeleting(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const actions = (r: AdminRoom): MenuItem[] => [
    ...(r.watching ? [{ label: r.live ? 'Stop the live stream' : 'Stop the video', icon: <Square size={15} />, onSelect: () => void stopVideo(r) }] : []),
    { label: 'Delete room', icon: <Trash2 size={16} />, danger: true, onSelect: () => setDeleting(r) },
  ];

  return (
    <AdminPage title="Rooms" subtitle={data ? `${data.total.toLocaleString()} ${data.total === 1 ? 'room' : 'rooms'}` : 'Every room on the site'}>
      <label className="flex h-11 items-center gap-2.5 rounded-2xl border border-line/70 bg-subtle/60 px-3.5 text-ink-soft transition-[border-color,box-shadow] focus-within:border-brand focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_16%,transparent)]">
        <Search size={16} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by room or owner name"
          aria-label="Search rooms"
          className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-ink outline-none placeholder:text-ink-soft/80"
        />
      </label>

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
      ) : data.items.length === 0 ? (
        <p className="rounded-[26px] border border-dashed border-line py-12 text-center text-ink-soft">{q ? 'No rooms match that.' : 'No rooms yet.'}</p>
      ) : (
        <ul aria-label="Rooms" className="rounded-[26px] border border-line/70 bg-surface/60">
          {data.items.map((r) => (
            <li key={r.id} className="flex items-center gap-3 border-b border-line/60 px-4 py-3 last:border-b-0">
              <Avatar name={r.name} hue={hueFromId(r.id)} size={44} square />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate font-semibold">{r.name}</span>
                  {r.inVoice > 0 && (
                    <Chip tone="live">
                      <AudioLines size={11} />
                      {r.inVoice} in voice
                    </Chip>
                  )}
                  {r.live ? (
                    <Chip tone="danger">
                      <Radio size={11} />
                      Live
                    </Chip>
                  ) : (
                    r.watching && (
                      <Chip tone="muted">
                        <MonitorPlay size={11} />
                        Watching
                      </Chip>
                    )
                  )}
                </p>
                <p className="flex items-center gap-1.5 truncate text-[13px] text-ink-soft">
                  <Avatar name={r.owner.name} hue={r.owner.hue} size={16} />
                  {r.owner.name}
                  {r.watching && <span className="truncate">· “{r.watching}”</span>}
                </p>
              </div>
              <dl className="hidden shrink-0 grid-cols-3 gap-6 text-[12.5px] lg:grid">
                <div>
                  <dt className="text-ink-soft">Members</dt>
                  <dd className="font-semibold tabular-nums">
                    {r.memberCount} of {r.maxMembers}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-soft">Messages</dt>
                  <dd className="font-semibold tabular-nums">{r.messages.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-ink-soft">Started</dt>
                  <dd className="font-semibold">{shortDate(r.createdAt)}</dd>
                </div>
              </dl>
              <span className="hidden w-[90px] shrink-0 text-right text-[12.5px] text-ink-soft sm:block">
                {r.lastActivityAt ? listStamp(r.lastActivityAt) : 'No activity'}
              </span>
              <span className="w-8 shrink-0">
                <Menu label={`Actions for ${r.name}`} items={actions(r)} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {data && data.items.length < data.total && (
        <div className="flex justify-center">
          <Button
            variant="soft"
            busy={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              load(data.items.length)
                .catch((err) => toast(errorMessage(err), 'error'))
                .finally(() => setLoadingMore(false));
            }}
          >
            Show more
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting?.name ?? ''}?`}
        body={<>Everyone in it is removed and its chat history is gone for good. Its {deleting?.memberCount ?? 0} members are told right away.</>}
        confirm="Delete room"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
    </AdminPage>
  );
}
