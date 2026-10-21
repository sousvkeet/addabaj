import { useCallback, useEffect, useState } from 'react';
import { Download, LoaderCircle, ShieldAlert, Smartphone } from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import { canSelfUpdate, inApp, nativeAppVersion, nativeInstallUpdate, onNative } from '../lib/native';
import { socket } from '../lib/socket';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

type Release = { versionCode: number; versionName: string; notes: string; size: number; sha256: string; url: string };
type Versions = { latest: Release | null; required: { versionCode: number; versionName: string } | null };

// The last answer from the server, so a required update shows the moment the
// app opens (and offline), not only once the check comes back.
const KEY = 'adda-app-versions';
function remembered(): Versions | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}
function remember(v: Versions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

/** "1.10.0" > "1.9.2": compares dotted version names number by number. */
function newerName(a: string, b: string) {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Is `release` newer than what's installed? By version code when the app says it, else by name. */
function isNewer(release: { versionCode: number; versionName: string }, installed: ReturnType<typeof nativeAppVersion>) {
  if (installed.code !== null) return release.versionCode > installed.code;
  return installed.name ? newerName(release.versionName, installed.name) : false;
}

type Progress =
  | { state: 'idle' }
  | { state: 'downloading'; percent: number }
  | { state: 'browser' }
  | { state: 'permission' }
  | { state: 'installing' }
  | { state: 'cancelled' }
  | { state: 'failed'; message: string };

/**
 * In the Android app: offers a newer version whenever the app opens. A
 * mandatory one can't be put off. "Update app" downloads it inside the app and
 * opens Android's installer (older apps download it with the browser instead).
 */
export function AppUpdate() {
  const [versions, setVersions] = useState<Versions | null>(() => (inApp ? remembered() : null));
  const [later, setLater] = useState(false);
  const [progress, setProgress] = useState<Progress>({ state: 'idle' });

  const check = useCallback(() => {
    api<Versions>('/app/version')
      .then((v) => {
        setVersions(v);
        remember(v);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!inApp) return;
    check();
    // A release uploaded (or made mandatory) while the app is open.
    const onVersions = (v: Versions) => {
      setVersions(v);
      remember(v);
      setLater(false);
    };
    socket.on('app:versions', onVersions);
    return () => {
      socket.off('app:versions', onVersions);
    };
  }, [check]);

  useEffect(
    () =>
      onNative((e) => {
        if (e.type !== 'update') return;
        if (e.state === 'downloading') setProgress({ state: 'downloading', percent: Math.max(0, e.percent ?? 0) });
        else if (e.state === 'downloaded') setProgress({ state: 'downloading', percent: 100 });
        else if (e.state === 'permission' || e.state === 'permission-needed') setProgress({ state: 'permission' });
        else if (e.state === 'installing') setProgress({ state: 'installing' });
        else if (e.state === 'cancelled') setProgress({ state: 'cancelled' });
        else if (e.state === 'failed') setProgress({ state: 'failed', message: e.message ?? 'The update didn’t download. Try again.' });
      }),
    [],
  );

  if (!inApp || !versions?.latest) return null;
  const installed = nativeAppVersion();
  const latest = versions.latest;
  if (!isNewer(latest, installed)) return null;
  const mandatory = !!versions.required && isNewer(versions.required, installed);
  if (later && !mandatory) return null;

  const update = () => {
    if (canSelfUpdate()) {
      setProgress({ state: 'downloading', percent: 0 });
      nativeInstallUpdate(latest.url, latest.sha256);
    } else {
      // An app from before in-app updates: Android's downloader saves it, and its notification installs it.
      setProgress({ state: 'browser' });
      window.location.href = latest.url;
    }
  };
  const working = progress.state === 'downloading' || progress.state === 'installing';

  return (
    <Dialog
      open
      onClose={() => setLater(true)}
      dismissible={!mandatory}
      width={420}
      title={mandatory ? 'Update required' : 'Update Adda Khana'}
      description={
        mandatory
          ? `Version ${latest.versionName} is needed to keep using Adda Khana${installed.name ? ` (you have ${installed.name})` : ''}.`
          : `Version ${latest.versionName} is ready${installed.name ? ` (you have ${installed.name})` : ''}.`
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-2xl bg-subtle/60 p-3">
          <span className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${mandatory ? 'bg-danger/15 text-danger' : 'bg-aurora text-white shadow-glow'}`}>
            {mandatory ? <ShieldAlert size={21} /> : <Smartphone size={21} />}
          </span>
          <span className="min-w-0">
            <span className="block font-semibold">Adda Khana {latest.versionName}</span>
            <span className="block text-[13px] text-ink-soft">{formatBytes(latest.size)} download</span>
          </span>
        </div>
        {latest.notes && <p className="max-h-40 overflow-y-auto text-[14px] whitespace-pre-wrap text-ink-soft">{latest.notes}</p>}

        {progress.state === 'downloading' && (
          <div role="status" aria-label="Download progress">
            <div className="mb-1.5 flex justify-between text-[13px] font-medium">
              <span>{progress.percent >= 100 ? 'Checking the download…' : 'Downloading…'}</span>
              <span className="tabular-nums">{progress.percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-subtle">
              <div className="h-full rounded-full bg-aurora transition-[width] duration-300" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}
        {progress.state === 'installing' && (
          <p role="status" className="flex items-center gap-2 text-[14px]">
            <LoaderCircle size={16} className="animate-spin" />
            Opening the installer: tap <b>Update</b> (or <b>Install</b>) there.
          </p>
        )}
        {progress.state === 'permission' && (
          <p role="status" className="rounded-xl bg-amber-400/10 px-3.5 py-2.5 text-[14px] text-amber-700 dark:text-amber-300">
            Allow <b>Install unknown apps</b> for Adda Khana in the settings that opened, then come back: the update carries on.
          </p>
        )}
        {progress.state === 'browser' && (
          <p role="status" className="rounded-xl bg-subtle px-3.5 py-2.5 text-[14px]">
            Downloading. When it finishes, tap the download notification and choose <b>Install</b>.
          </p>
        )}
        {progress.state === 'cancelled' && (
          <p role="status" className="rounded-xl bg-subtle px-3.5 py-2.5 text-[14px]">
            The update wasn’t installed. Tap <b>Install update</b> to open the installer again (it’s already downloaded).
          </p>
        )}
        {progress.state === 'failed' && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-2.5 text-[14px] text-danger">
            {progress.message}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Button onClick={update} busy={working} disabled={working}>
            <Download size={17} />
            {progress.state === 'failed'
              ? 'Try again'
              : progress.state === 'cancelled'
                ? 'Install update'
                : progress.state === 'permission' || progress.state === 'browser'
                  ? 'Update app again'
                  : 'Update app'}
          </Button>
          {!mandatory && (
            <Button variant="ghost" onClick={() => setLater(true)} disabled={working}>
              Later
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
