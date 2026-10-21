import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileUp, LoaderCircle, Smartphone, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { toast } from '../../store/ui';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog, inputClass } from '../../components/ui/Dialog';
import { Toggle } from '../../components/ui/Toggle';
import { AdminPage, Chip, Panel, shortDate } from './shared';

type Release = {
  versionCode: number;
  versionName: string;
  notes: string;
  mandatory: boolean;
  size: number;
  sha256: string;
  minSdk: number | null;
  publishedAt: string;
  url: string;
  certSha256: string | null;
  uploadedBy: string | null;
};

/** Sends the APK as the request body (it can be large), with progress. */
function uploadApk(file: File, meta: { notes: string; mandatory: boolean }, onProgress: (percent: number) => void) {
  return new Promise<Release>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/app/releases');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Release-Meta', encodeURIComponent(JSON.stringify(meta)));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded * 100) / e.total));
    xhr.onload = () => {
      let data: { release?: Release; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 201 && data.release) resolve(data.release);
      else reject(new Error(data.error ?? `The upload failed (${xhr.status}). Try again.`));
    };
    xhr.onerror = () => reject(new Error("Can't reach the server. Check your connection and try again."));
    xhr.send(file);
  });
}

/** Host admin: new versions of the Android app. Phones offer the newest when they open; mandatory ones must be installed. */
export function AppReleases() {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [mandatory, setMandatory] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [removing, setRemoving] = useState<Release | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ releases: Release[] }>('/admin/app/releases')
      .then((r) => setReleases(r.releases))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setUploadError('Choose the app file (.apk) first.');
    setUploadError('');
    setUploading(0);
    try {
      const release = await uploadApk(file, { notes: notes.trim(), mandatory }, setUploading);
      setReleases((list) => [release, ...(list ?? [])]);
      setFile(null);
      setNotes('');
      setMandatory(false);
      if (picker.current) picker.current.value = '';
      toast(`Version ${release.versionName} is out. Phones offer it the next time the app opens.`);
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(null);
    }
  }

  async function change(r: Release, input: { mandatory?: boolean }) {
    try {
      const res = await api<{ releases: Release[] }>(`/admin/app/releases/${r.versionCode}`, { method: 'PATCH', body: input });
      setReleases(res.releases);
      toast(input.mandatory ? `Version ${r.versionName} is now required: older apps must update.` : `Version ${r.versionName} is optional now.`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      const res = await api<{ releases: Release[] }>(`/admin/app/releases/${removing.versionCode}`, { method: 'DELETE' });
      setReleases(res.releases);
      toast(`Version ${removing.versionName} was removed.`);
      setRemoving(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const latest = releases?.[0];

  return (
    <AdminPage title="App updates" subtitle={latest ? `Latest: ${latest.versionName}` : 'New versions of the Android app'}>
      <Panel
        title="Upload a new version"
        hint="Build it with ./gradlew assembleRelease after raising versionCode. Every copy of the app offers it the next time it opens, then downloads and installs it."
      >
        <form onSubmit={submit} className="space-y-4" noValidate>
          <input
            ref={picker}
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            aria-label="App file (.apk)"
            className="block w-full text-[14px] file:mr-3 file:rounded-xl file:border-0 file:bg-subtle file:px-3.5 file:py-2 file:font-semibold file:text-ink"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setUploadError('');
            }}
          />
          <label className="block">
            <span className="mb-1.5 block text-[13.5px] font-semibold">What's new</span>
            <textarea
              className={`${inputClass} h-auto min-h-[84px] resize-y py-2.5`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Optional. Shown on the update screen."
            />
          </label>
          <Toggle
            checked={mandatory}
            onChange={setMandatory}
            label="Make it mandatory"
            hint="Older apps can't be used until they update. They see the update screen, with no way to put it off, every time they open."
          />
          {uploadError && (
            <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
              {uploadError}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" busy={uploading !== null} disabled={uploading !== null}>
              <FileUp size={17} />
              {uploading !== null ? `Uploading ${uploading}%` : 'Upload and publish'}
            </Button>
            {file && uploading === null && (
              <span className="truncate text-[13px] text-ink-soft">
                {file.name}, {formatBytes(file.size)}
              </span>
            )}
          </div>
        </form>
      </Panel>

      {error && (
        <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-[14px] text-danger">
          {error}
        </p>
      )}

      <Panel title="Versions" hint="Phones are offered the newest. Any version made mandatory has to be installed before the app can be used.">
        {!releases ? (
          !error && (
            <p className="flex justify-center py-8 text-ink-soft">
              <LoaderCircle className="animate-spin" />
            </p>
          )
        ) : releases.length === 0 ? (
          <p className="py-6 text-center text-[14px] text-ink-soft">No versions uploaded yet. Phones won't be offered updates until you upload one.</p>
        ) : (
          <ul aria-label="App versions" className="divide-y divide-line/70">
            {releases.map((r, i) => (
              <li key={r.versionCode} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-subtle text-brand dark:text-live">
                  <Smartphone size={19} />
                </span>
                <div className="min-w-[200px] flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Version {r.versionName}</span>
                    <span className="text-[12.5px] text-ink-soft">code {r.versionCode}</span>
                    {i === 0 && <Chip tone="live">Latest</Chip>}
                    {r.mandatory && <Chip tone="danger">Mandatory</Chip>}
                  </p>
                  <p className="text-[13px] text-ink-soft">
                    {formatBytes(r.size)} · {shortDate(r.publishedAt)}
                    {r.uploadedBy ? ` · by ${r.uploadedBy}` : ''}
                  </p>
                  {r.notes && <p className="mt-1 text-[13.5px] whitespace-pre-wrap">{r.notes}</p>}
                  {r.certSha256 && (
                    <p className="mt-1 truncate font-mono text-[11px] text-ink-soft" title={r.certSha256}>
                      Signed by {r.certSha256}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <label className="flex items-center gap-2 text-[13px] font-medium">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={r.mandatory}
                      onChange={(e) => void change(r, { mandatory: e.target.checked })}
                      aria-label={`Version ${r.versionName} is mandatory`}
                      className="size-4 accent-[var(--brand)]"
                    />
                    Mandatory
                  </label>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(r)} aria-label={`Remove version ${r.versionName}`}>
                    <Trash2 size={15} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <ConfirmDialog
        open={!!removing}
        title={`Remove version ${removing?.versionName ?? ''}?`}
        body="Phones stop being offered it. Phones that already installed it keep it; if it's the newest, they're offered the one before it."
        confirm="Remove"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </AdminPage>
  );
}
