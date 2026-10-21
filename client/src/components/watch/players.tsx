import { useEffect, useRef } from 'react';
import type { WatchSource } from '../../lib/types';

/** What the sync logic needs from any player (YouTube, file, live stream). */
export type PlayerAdapter = {
  /** Resolves false when the browser blocked playback until the user taps. */
  play: () => Promise<boolean>;
  pause: () => void;
  seek: (seconds: number) => void;
  time: () => number;
  playing: () => boolean;
  /** Live streams have no shared timeline; everyone just plays the live edge. */
  live: () => boolean;
  muted: () => boolean;
  setMuted: (muted: boolean) => void;
  volume: () => number;
  setVolume: (volume: number) => void;
  /** Fine speed control for gentle catch-up (not available for YouTube). */
  setRate?: (rate: number) => void;
};

/** A play/pause/seek made by the person at this player (admins only). */
export type UserAction = { playing: boolean; position: number };

type ViewProps = {
  source: WatchSource;
  /** Admins get the player's own controls; members only follow. */
  controls: boolean;
  startAt: number;
  onReady: (adapter: PlayerAdapter) => void;
  onUserAction: (action: UserAction) => void;
  onError: (message: string) => void;
};

// ── YouTube ──────────────────────────────────────────────────────────

type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(v: number): void;
  getVolume(): number;
  getVideoData?: () => { isLive?: boolean };
  destroy(): void;
};
type YTNamespace = { Player: new (el: HTMLElement, options: object) => YTPlayer };
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytLoading: Promise<YTNamespace> | null = null;

function loadYouTube() {
  return (ytLoading ??= new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      ytLoading = null;
      reject(new Error("Couldn't load the YouTube player. Check your connection."));
    };
    document.head.appendChild(script);
  }));
}

const YT_ERRORS: Record<number, string> = {
  2: 'YouTube rejected this video link.',
  5: "This video can't be played in the browser.",
  100: 'This YouTube video was removed or is private.',
  101: "This video's owner doesn't allow it to be played on other sites.",
  150: "This video's owner doesn't allow it to be played on other sites.",
};

/** Waits briefly to see whether playback really started (autoplay may be blocked). */
function startedWithin(check: () => boolean, ms: number) {
  return new Promise<boolean>((resolve) => {
    const until = Date.now() + ms;
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() > until) return resolve(false);
      window.setTimeout(tick, 150);
    };
    tick();
  });
}

export function YouTubeView({ source, controls, startAt, onReady, onUserAction, onError }: ViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onUserAction, onError });
  callbacks.current = { onReady, onUserAction, onError };

  useEffect(() => {
    let disposed = false;
    let player: YTPlayer | null = null;
    // YouTube replaces its element with an iframe, so give it one React doesn't own.
    const mount = document.createElement('div');
    mount.className = 'size-full';
    host.current?.appendChild(mount);

    loadYouTube()
      .then((YT) => {
        if (disposed) return;
        player = new YT.Player(mount, {
          videoId: source.videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: controls ? 1 : 0,
            disablekb: controls ? 0 : 1,
            fs: controls ? 1 : 0,
            rel: 0,
            playsinline: 1,
            modestbranding: 1,
            start: Math.floor(startAt),
          },
          events: {
            onReady: () => {
              const p = player!;
              const isPlaying = () => [1, 3].includes(p.getPlayerState());
              callbacks.current.onReady({
                play: async () => {
                  p.playVideo();
                  return startedWithin(isPlaying, 2500);
                },
                pause: () => p.pauseVideo(),
                seek: (s) => p.seekTo(s, true),
                time: () => p.getCurrentTime() ?? 0,
                playing: isPlaying,
                live: () => !!p.getVideoData?.().isLive,
                muted: () => p.isMuted(),
                setMuted: (m) => (m ? p.mute() : p.unMute()),
                volume: () => p.getVolume() / 100,
                setVolume: (v) => p.setVolume(Math.round(v * 100)),
              });
            },
            onStateChange: (e: { data: number }) => {
              const p = player!;
              if (e.data === 1) callbacks.current.onUserAction({ playing: true, position: p.getCurrentTime() });
              else if (e.data === 2) callbacks.current.onUserAction({ playing: false, position: p.getCurrentTime() });
              else if (e.data === 0) callbacks.current.onUserAction({ playing: false, position: p.getDuration() });
            },
            onError: (e: { data: number }) => callbacks.current.onError(YT_ERRORS[e.data] ?? "YouTube couldn't play this video."),
          },
        });
      })
      .catch((err: Error) => callbacks.current.onError(err.message));

    return () => {
      disposed = true;
      // YouTube's destroy() throws when its iframe hasn't loaded yet (the video changed quickly).
      try {
        player?.destroy();
      } catch {
        /* nothing left to tear down */
      }
      mount.remove();
    };
    // A new video or role means a fresh player; position changes are handled by sync.
  }, [source.videoId, controls]);

  return <div ref={host} className="size-full [&_iframe]:size-full" />;
}

// ── Direct files and HLS streams ─────────────────────────────────────

type HlsLike = { destroy(): void };

export function FileView({ source, controls, startAt, onReady, onUserAction, onError }: ViewProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onReady, onUserAction, onError });
  callbacks.current = { onReady, onUserAction, onError };

  useEffect(() => {
    const video = ref.current!;
    let hls: HlsLike | null = null;
    let disposed = false;
    let liveStream = false;
    let ready = false;
    let onRelay = false;
    let retries = 0;
    let current = source.url;
    let retryTimer = 0;
    let watchdog = 0;

    const report = () => {
      const insecure = location.protocol === 'https:' && source.url.startsWith('http:');
      callbacks.current.onError(
        insecure
          ? 'This page is secure (https) but the video link is not (http), so the browser blocked it.'
          : source.kind === 'hls'
            ? "The stream couldn't be loaded. It may be offline, or its server doesn't allow playback on other sites."
            : "This link couldn't be played. Use a YouTube link, or a direct link to a video file (.mp4, .webm) or stream (.m3u8).",
      );
    };

    // Recovery, in order: a direct link the browser can't play (blocked across
    // sites, http on an https page, hotlink checks) moves to the server relay;
    // a link that errors or stalls is retried twice with a pause; only then
    // is an error shown.
    const failed = () => {
      if (disposed) return;
      window.clearTimeout(watchdog);
      if (!onRelay && source.fallbackUrl) {
        onRelay = true;
        retries = 0;
        load(source.fallbackUrl);
        return;
      }
      if (retries < 2) {
        retries++;
        retryTimer = window.setTimeout(() => !disposed && load(current), retries * 2000);
        return;
      }
      report();
    };

    const announce = () => {
      if (ready || disposed) return;
      ready = true;
      if (startAt > 0 && Number.isFinite(video.duration)) video.currentTime = startAt;
      callbacks.current.onReady({
        // Only a blocked autoplay counts as "needs a tap"; an interrupted play()
        // (a load or seek got in the way) is retried by the next sync tick, and
        // real failures arrive as the element's error event.
        play: () =>
          video.play().then(
            () => true,
            (err: DOMException) => err.name !== 'NotAllowedError',
          ),
        pause: () => video.pause(),
        seek: (s) => {
          video.currentTime = s;
        },
        time: () => video.currentTime,
        playing: () => !video.paused && !video.ended,
        live: () => liveStream || video.duration === Infinity,
        muted: () => video.muted,
        setMuted: (m) => {
          video.muted = m;
        },
        volume: () => video.volume,
        setVolume: (v) => {
          video.volume = v;
        },
        setRate: (r) => {
          if (Math.abs(video.playbackRate - r) > 0.001) video.playbackRate = r;
        },
      });
    };

    const action = () => callbacks.current.onUserAction({ playing: !video.paused && !video.ended, position: video.currentTime });
    video.addEventListener('loadedmetadata', announce);
    video.addEventListener('error', failed);
    video.addEventListener('play', action);
    video.addEventListener('pause', action);
    video.addEventListener('seeked', action);

    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';
    function load(url: string) {
      current = url;
      hls?.destroy();
      hls = null;
      // Nothing at all after 15 s counts as a stall (some sites just hang).
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        if (video.readyState < 1) failed();
      }, 15_000);
      if (source.kind === 'hls' && !nativeHls) {
        void import('hls.js').then(({ default: Hls }) => {
          if (disposed) return;
          if (!Hls.isSupported()) return report();
          const instance = new Hls();
          hls = instance;
          instance.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
            liveStream = data.details.live;
          });
          instance.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal && hls === instance) failed();
          });
          instance.loadSource(url);
          instance.attachMedia(video);
        });
      } else {
        video.src = url;
      }
    }
    load(source.url);

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(watchdog);
      video.removeEventListener('loadedmetadata', announce);
      video.removeEventListener('error', failed);
      video.removeEventListener('play', action);
      video.removeEventListener('pause', action);
      video.removeEventListener('seeked', action);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [source.url, source.kind]);

  return <video ref={ref} controls={controls} playsInline preload="auto" data-watch-video className="size-full bg-black object-contain" />;
}
