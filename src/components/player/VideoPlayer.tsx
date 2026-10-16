import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import type { StreamSource, SubtitleTrack } from '@/types';
import { proxy } from '@/services/api';
import { useIntroSkip } from '@/hooks/useIntroSkip';
import { useSettingsStore } from '@/stores/settingsStore';
import { useHistoryStore } from '@/stores/historyStore';
import { pushProgress } from '@/services/progressSync';
import { peekAnimeInfo } from '@/services/info';
import { classifySourceKind, isDirectMedia, subtitleFormat } from '@/services/sourceType';

/* ASS subtitles via JASSub (libass WASM), loaded from CDN only when needed. */
const JASSUB_BASE = 'https://cdn.jsdelivr.net/npm/jassub@1/dist/';
let jassubLoader: Promise<void> | null = null;

function loadJassub(): Promise<void> {
  if (!jassubLoader) {
    // jassub is not an npm dependency (it was never installed) — load the
    // UMD build from the CDN at runtime instead of importing it, so the
    // bundler never has to resolve it. Failure rejects and the caller
    // falls back to "no subtitles".
    jassubLoader = new Promise<void>((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${JASSUB_BASE}jassub.css`;
      document.head.appendChild(link);
      const script = document.createElement('script');
      script.src = `${JASSUB_BASE}jassub.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('jassub CDN load failed'));
      document.head.appendChild(script);
    }).then(() => {
      const w = window as unknown as { JASSub?: unknown };
      if (w.JASSub) {
        (Artplayer as unknown as { JASSub: unknown }).JASSub = w.JASSub;
      }
    });
  }
  return jassubLoader;
}

function jassubPlugin(subUrl: string) {
  return function (this: Artplayer) {
    const { JASSub } = Artplayer as unknown as {
      JASSub?: new (...args: unknown[]) => { destroy(): void };
    };
    if (!JASSub) return;
    const option = this.option as unknown as { video: HTMLVideoElement };
    const renderer = new JASSub({
      video: option.video,
      subUrl,
      workerUrl: `${JASSUB_BASE}jassub-worker.js`,
      wasmUrl: `${JASSUB_BASE}jassub-worker.wasm`,
      legacyWasmUrl: `${JASSUB_BASE}jassub-worker-legacy.js`,
      offscreenRender: false,
      onError: () => {},
    });
    Object.defineProperty(this, 'destroy', {
      value: () => renderer.destroy(),
    });
  };
}

interface Props {
  source: StreamSource;
  animeId: string;
  episodeNumber: number;
  subtitles?: SubtitleTrack[];
  poster?: string;
  autoplayNext: boolean;
  hasNextEpisode: boolean;
  onEnded: () => void;
  onFatal: () => void;
}

/**
 * Dispatches on the *established* source kind. Each kind has its own
 * component so hooks, effects and cleanup never mix: switching between
 * iframe / HLS / MP4 unmounts the previous player completely.
 *
 *  embed       -> <EmbedPlayer>   (iframe, provider-approved embed only)
 *  hls | mp4   -> <MediaPlayer>   (ArtPlayer + HLS.js)
 *  unknown     -> <UnsupportedSource> (never handed to ArtPlayer)
 */
export default function VideoPlayer(props: Props) {
  const kind = classifySourceKind(props.source.type, props.source.url);
  if (kind === 'embed') {
    return <EmbedPlayer source={props.source} onFatal={props.onFatal} />;
  }
  if (isDirectMedia(kind)) {
    return <MediaPlayer {...props} kind={kind} />;
  }
  return <UnsupportedSource source={props.source} onFatal={props.onFatal} />;
}

const FRAME_CLASS = 'relative w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10';

async function openExternal(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/* ---------------------------------------------------------------------- */
/* Iframe embeds                                                           */
/* ---------------------------------------------------------------------- */

function EmbedPlayer({ source, onFatal }: Pick<Props, 'source' | 'onFatal'>) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  // New source -> reset state. On unmount, blank the frame so the embedded
  // page stops playing audio immediately instead of waiting for GC.
  useEffect(() => {
    setLoaded(false);
    const frame = frameRef.current;
    return () => {
      if (frame) frame.src = 'about:blank';
    };
  }, [source.url]);

  let host = source.url;
  try {
    host = new URL(source.url).host;
  } catch {
    /* keep raw url */
  }

  return (
    <div className={FRAME_CLASS}>
      <div className="aspect-video w-full">
        <iframe
          ref={frameRef}
          key={source.url}
          src={source.url}
          title={`Video player (${host})`}
          className="h-full w-full border-0 bg-black"
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-forms allow-presentation allow-popups allow-popups-to-escape-sandbox"
          onLoad={() => setLoaded(true)}
          onError={onFatal}
        />
      </div>
      {/* The browser fires `load` even when it replaced the page with a
          "refused to connect" error (X-Frame-Options / CSP frame-ancestors),
          so a load event can't prove the embed works. Keep an escape hatch
          visible instead of guessing. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 bg-ink-900 px-3 py-2 text-xs text-zinc-500">
        <span>
          {loaded ? 'Embedded player' : 'Loading embedded player'} · {host}. Blank? The provider may
          block embedding.
        </span>
        <span className="flex gap-3">
          <button
            type="button"
            className="text-zinc-300 hover:text-white"
            onClick={() => void openExternal(source.url)}
          >
            Open in browser
          </button>
          <button type="button" className="text-zinc-300 hover:text-white" onClick={onFatal}>
            Try another source
          </button>
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Unsupported (media type not established)                                */
/* ---------------------------------------------------------------------- */

function UnsupportedSource({ source, onFatal }: Pick<Props, 'source' | 'onFatal'>) {
  // Such a source is never playable: mark it failed so Watch moves on.
  const fatalRef = useRef(onFatal);
  fatalRef.current = onFatal;
  useEffect(() => {
    fatalRef.current();
  }, [source.url]);

  return (
    <div className={FRAME_CLASS}>
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-zinc-200">This source can&apos;t be played here</p>
        <p className="max-w-md text-xs text-zinc-500">
          {source.unsupportedReason ??
            'The provider returned a web page, not a video stream or an embeddable player.'}
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Direct media (HLS / MP4) via ArtPlayer                                  */
/* ---------------------------------------------------------------------- */

function MediaPlayer({
  source,
  kind,
  animeId,
  episodeNumber,
  subtitles,
  poster,
  autoplayNext,
  hasNextEpisode,
  onEnded,
  onFatal,
}: Props & { kind: 'hls' | 'mp4' }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [art, setArt] = useState<Artplayer | null>(null);
  // Latest callbacks without re-creating the player instance
  const callbacks = useRef({ onEnded, onFatal });
  callbacks.current = { onEnded, onFatal };
  // Subtitles/poster are read when the player is created; a background
  // provider merge replacing the array must not rebuild a playing player.
  const latest = useRef({ subtitles, poster });
  latest.current = { subtitles, poster };
  const skips = useIntroSkip(animeId, episodeNumber);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // `cancelled` guards every await below: if the source changed or the
    // component unmounted while subtitles were downloading, the stale init
    // must not create a player (it would leak, and could overwrite the new one).
    let cancelled = false;
    let hls: Hls | null = null;
    let instance: Artplayer | null = null;
    let subBlobUrl: string | null = null;
    let failed = false;
    // Listeners wired after art creation; cleaned up by the effect return.
    const disposers: (() => void)[] = [];

    const fail = () => {
      if (failed || cancelled) return;
      failed = true;
      callbacks.current.onFatal();
    };

    const sub = latest.current.subtitles?.[0];
    const subType = sub ? subtitleFormat(sub.url) : null;

    const init = async () => {
      // Subtitles: remote subtitle hosts are usually CORS-locked, and a failed
      // subtitle fetch used to crash the entire player. Pull the first track
      // into a blob URL (direct first, local proxy as fallback) so a failure
      // just means "no subtitles" — the video still plays.
      if (sub && subType && subType !== 'ass') {
        // Second candidate goes through the playback proxy (no host
        // allowlist), not /cors — subtitle CDNs like dragonatepizza.online
        // rotate hosts exactly like segment CDNs do and would 403 on the
        // /cors allowlist.
        for (const candidate of [sub.url, proxy.segment(sub.url)]) {
          try {
            const res = await fetch(candidate);
            if (res.ok) {
              const blob = await res.blob();
              if (cancelled) return;
              subBlobUrl = URL.createObjectURL(blob);
              break;
            }
          } catch {
            /* try the next candidate */
          }
          if (cancelled) return;
        }
      }

      if (cancelled || !containerRef.current) return;

      const created = new Artplayer({
        container: containerRef.current,
        url: source.url,
        poster: latest.current.poster,
        type: kind === 'hls' ? 'm3u8' : 'mp4',
        autoplay: true,
        volume: 0.8,
        theme: '#9333ea',
        screenshot: true,
        setting: true,
        subtitleOffset: true,
        pip: true,
        fullscreen: true,
        playbackRate: true,
        aspectRatio: true,
        hotkey: true,
        ...(subBlobUrl
          ? {
              subtitle: {
                url: subBlobUrl,
                type: (subType === 'srt' ? 'srt' : 'vtt') as 'srt' | 'vtt',
                encoding: 'utf-8' as const,
                style: {
                  color: '#fff',
                  fontSize: '24px',
                  textShadow: '0 0 5px #000',
                },
              },
            }
          : {}),
        customType: {
          m3u8: (video, url) => {
            // Route every HLS stream through the local proxy: provider CDNs
            // are referer-locked AND CORS-locked, so direct playback dies
            // either way. The proxy rewrites segment URLs to /proxy_segment.
            const finalUrl = proxy.m3u8(url, source.referer ?? '');
            if (Hls.isSupported()) {
              hls = new Hls({ maxBufferLength: 30, enableWorker: true });
              hls.loadSource(finalUrl);
              hls.attachMedia(video);
              hls.on(Hls.Events.ERROR, (_e, data) => {
                if (data?.fatal) fail();
              });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
              video.src = finalUrl;
            } else {
              fail();
            }
          },
        },
      });
      instance = created;
      setArt(created);
      const player = created;

      // ASS subtitles: render via JASSub (native tracks only do VTT/SRT)
      if (sub && subType === 'ass') {
        loadJassub()
          .then(() => {
            if (!cancelled) player.plugins.add(jassubPlugin(proxy.cors(sub.url)));
          })
          .catch(() => {
            /* fall back to no subtitles */
          });
      }

      // Fatal error on direct mp4 files too
      player.video.addEventListener('error', fail);
      disposers.push(() => player.video.removeEventListener('error', fail));

      const onVideoEnded = () => {
        // Episode finished: make sure the final position is on AniList even
        // when autoplay is off (the next episode's onMeta would cover it
        // otherwise, but only if the user clicks through).
        pushProgress(Number(animeId), episodeNumber, peekAnimeInfo(animeId)?.isAdult);
        if (autoplayNext && hasNextEpisode) callbacks.current.onEnded();
      };
      player.on('video:ended', onVideoEnded);
      disposers.push(() => player.off('video:ended', onVideoEnded));

      // remember fullscreen across sessions. Webviews reject programmatic
      // fullscreen without a user gesture, so restore on the first
      // interaction instead of at mount.
      const onFullscreenChange = (state: boolean) => {
        useSettingsStore.getState().setLastFullscreen(state);
      };
      player.on('fullscreen', onFullscreenChange);
      disposers.push(() => player.off('fullscreen', onFullscreenChange));

      const tryRestoreFullscreen = () => {
        const s = useSettingsStore.getState();
        if (s.rememberFullscreen && s.lastFullscreen) {
          try {
            player.fullscreen = true;
          } catch {
            /* rejected without a gesture — stay windowed */
          }
        }
        player.off('video:play', tryRestoreFullscreen);
        player.off('click', tryRestoreFullscreen);
      };
      player.on('video:play', tryRestoreFullscreen);
      player.on('click', tryRestoreFullscreen);
      disposers.push(() => {
        player.off('video:play', tryRestoreFullscreen);
        player.off('click', tryRestoreFullscreen);
      });

      // resume where the user left off (same anime + episode only;
      // near-start and near-end positions start fresh by design).
      const resumeEntry = useHistoryStore
        .getState()
        .entries.find((e) => e.animeId === Number(animeId) && e.episode === episodeNumber);
      const resumeAt =
        resumeEntry?.position != null &&
        resumeEntry?.duration != null &&
        resumeEntry.position > 15 &&
        resumeEntry.position < resumeEntry.duration - 30
          ? resumeEntry.position
          : null;
      const onMeta = () => {
        // Restore the resume point once the media metadata is available.
        // AniList progress is updated only by the video:ended handler above;
        // starting an episode must not mark it as watched.
        if (resumeAt != null) player.currentTime = resumeAt;
      };
      player.video.addEventListener('loadedmetadata', onMeta, { once: true });
      disposers.push(() => player.video.removeEventListener('loadedmetadata', onMeta));

      // save position — throttled to ~every 10s, plus a final save on
      // pause/ended so the resume point is fresh.
      let lastPosSave = 0;
      const savePosition = (force = false) => {
        const now = Date.now();
        if (!force && now - lastPosSave < 10_000) return;
        lastPosSave = now;
        const d = player.duration;
        if (!d || Number.isNaN(d)) return;
        useHistoryStore
          .getState()
          .updatePosition(Number(animeId), episodeNumber, player.currentTime, d);
      };
      const onTime = () => savePosition();
      const onStop = () => savePosition(true);
      player.video.addEventListener('timeupdate', onTime);
      player.video.addEventListener('pause', onStop);
      player.video.addEventListener('ended', onStop);
      disposers.push(() => {
        player.video.removeEventListener('timeupdate', onTime);
        player.video.removeEventListener('pause', onStop);
        player.video.removeEventListener('ended', onStop);
      });
    };

    void init();

    // Cleanup is registered synchronously here — never from inside the async
    // init (React ignores a function returned from a promise).
    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose();
      hls?.destroy();
      hls = null;
      // destroy(true) empties the container. destroy(false) only tagged the
      // old DOM with a CSS class and left it behind, so every source switch
      // stacked another dead player in the container.
      instance?.destroy(true);
      instance = null;
      setArt(null);
      if (subBlobUrl) URL.revokeObjectURL(subBlobUrl);
      subBlobUrl = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.url, source.referer, kind, animeId, episodeNumber]);

  // intro/outro skip buttons (AniSkip data). Only visible while the
  // playhead is inside the skip window — no permanent button clutter.
  // Keyed on the player *instance* (state), because the instance is created
  // asynchronously and a ref read here would usually still be null.
  // No data (AniSkip 404) simply means no buttons.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !art || !skips) return;
    const specs = [
      { interval: skips.op, label: 'Skip intro →' },
      { interval: skips.ed, label: 'Skip outro →' },
    ];
    const btns: { interval: { start: number; end: number }; el: HTMLButtonElement }[] = [];
    for (const spec of specs) {
      const interval = spec.interval;
      if (!interval) continue;
      const btn = document.createElement('button');
      btn.textContent = spec.label;
      btn.className =
        'absolute bottom-24 right-4 z-40 rounded-lg bg-black/70 px-3 py-1.5 text-sm text-white hover:bg-black/90';
      btn.style.display = 'none';
      btn.onclick = () => {
        art.currentTime = interval.end;
        btn.style.display = 'none';
      };
      container.appendChild(btn);
      btns.push({ interval, el: btn });
    }
    const update = () => {
      const t = art.currentTime;
      for (const b of btns) {
        b.el.style.display = t >= b.interval.start && t < b.interval.end ? '' : 'none';
      }
    };
    update();
    art.video.addEventListener('timeupdate', update);
    return () => {
      art.video.removeEventListener('timeupdate', update);
      for (const b of btns) b.el.remove();
    };
  }, [skips, art]);

  return (
    <div className={FRAME_CLASS}>
      <div ref={containerRef} className="aspect-video w-full" />
    </div>
  );
}
