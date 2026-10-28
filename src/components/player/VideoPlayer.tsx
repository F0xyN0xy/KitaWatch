import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Artplayer from 'artplayer';
import 'artplayer/dist/artplayer.css';
import { invoke } from '@tauri-apps/api/core';
import { Download } from 'lucide-react';
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
          onLoad={(event) => {
            setLoaded(true);
            const frame = event.currentTarget;
            console.info('[KitaWatch iframe debug] load event', {
              src: frame.src,
              host,
              sandbox: frame.getAttribute('sandbox'),
              allow: frame.getAttribute('allow'),
              referrerPolicy: frame.referrerPolicy,
              loadedAt: new Date().toISOString(),
            });
          }}
          onError={(event) => {
            console.error('[KitaWatch iframe debug] iframe error event', {
              src: event.currentTarget.src,
              host,
              sandbox: event.currentTarget.getAttribute('sandbox'),
              allow: event.currentTarget.getAttribute('allow'),
              referrerPolicy: event.currentTarget.referrerPolicy,
              failedAt: new Date().toISOString(),
            });
            onFatal();
          }}
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
      <details className="border-t border-white/5 px-3 py-2 text-xs text-zinc-400">
        <summary className="cursor-pointer select-none">Iframe debug info</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all">
          <dt>Host</dt><dd>{host}</dd>
          <dt>URL</dt><dd>{source.url}</dd>
          <dt>Sandbox</dt><dd>{frameRef.current?.getAttribute('sandbox') ?? '(not set)'}</dd>
          <dt>Allow</dt><dd>{frameRef.current?.getAttribute('allow') ?? '(not set)'}</dd>
          <dt>Referrer policy</dt><dd>{frameRef.current?.referrerPolicy ?? '(not set)'}</dd>
          <dt>Iframe load event</dt><dd>{loaded ? 'Fired (does not guarantee playback)' : 'Not fired yet'}</dd>
        </dl>
        <p className="mt-2 text-zinc-500">
          Details and errors from inside a cross-origin embed are hidden by the browser.
          Check DevTools Console and Network for the provider&apos;s own errors.
        </p>
      </details>
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
  const [subtitleSettingsHost, setSubtitleSettingsHost] = useState<HTMLElement | null>(null);
  const [subtitleSettingsOpen, setSubtitleSettingsOpen] = useState(false);
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState(0);
  const [subtitleNotice, setSubtitleNotice] = useState('');
  const [downloadState, setDownloadState] = useState<{ busy: boolean; message: string }>({ busy: false, message: '' });
  const subtitleEnabled = useSettingsStore((s) => s.subtitleEnabled);
  const subtitleFontSize = useSettingsStore((s) => s.subtitleFontSize);
  const subtitleColor = useSettingsStore((s) => s.subtitleColor);
  const subtitleFontFamily = useSettingsStore((s) => s.subtitleFontFamily);
  const subtitleBold = useSettingsStore((s) => s.subtitleBold);
  const subtitleOutline = useSettingsStore((s) => s.subtitleOutline);
  const setSubtitleEnabled = useSettingsStore((s) => s.setSubtitleEnabled);
  const setSubtitleFontSize = useSettingsStore((s) => s.setSubtitleFontSize);
  const setSubtitleColor = useSettingsStore((s) => s.setSubtitleColor);
  const setSubtitleFontFamily = useSettingsStore((s) => s.setSubtitleFontFamily);
  const setSubtitleBold = useSettingsStore((s) => s.setSubtitleBold);
  const setSubtitleOutline = useSettingsStore((s) => s.setSubtitleOutline);
  // Latest callbacks without re-creating the player instance
  const callbacks = useRef({ onEnded, onFatal });
  callbacks.current = { onEnded, onFatal };
  // Subtitles/poster are read when the player is created; a background
  // provider merge replacing the array must not rebuild a playing player.
  const latest = useRef({ subtitles, poster });
  latest.current = { subtitles, poster };
  const skips = useIntroSkip(animeId, episodeNumber);

  useEffect(() => {
    setSelectedSubtitleIndex(0);
    setSubtitleNotice('');
    setDownloadState({ busy: false, message: '' });
  }, [source.url]);

  const downloadEpisode = async () => {
    if (kind !== 'mp4' || downloadState.busy) return;
    setDownloadState({ busy: true, message: 'Downloading…' });
    try {
      const savedPath = await invoke<string>('download_episode', {
        url: source.url,
        filename: `anime-${animeId}-episode-${episodeNumber}`,
        referer: source.referer ?? null,
      });
      setDownloadState({ busy: false, message: `Saved to ${savedPath}` });
    } catch (error) {
      setDownloadState({ busy: false, message: error instanceof Error ? error.message : String(error) });
    }
  };

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
    // AniList progress should update when a viewer reaches 80% of an episode,
    // not only when the media emits its ended event.
    let progressCommitted = false;
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
        if (!subBlobUrl && sub) setSubtitleNotice(`Could not load subtitles: ${sub.lang || 'default track'}.`);
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
        controls: latest.current.subtitles?.length
          ? [{
              name: 'kitawatch-subtitles',
              index: 10,
              position: 'right',
              html: '<span style="font-size:12px;font-weight:700;letter-spacing:.02em">CC</span>',
              tooltip: 'Subtitle settings',
              click: () => setSubtitleSettingsOpen((open) => !open),
            }]
          : [],
        subtitleOffset: true,
        pip: true,
        fullscreen: true,
        playbackRate: true,
        aspectRatio: true,
        // KitaWatch handles shortcuts below so behavior is consistent across browsers.
        hotkey: false,
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

      // Use one predictable shortcut map instead of ArtPlayer's built-in hotkeys.
      // Only handle keys while the pointer or keyboard focus is inside this player.
      const isEditableTarget = (target: EventTarget | null): boolean => {
        if (!(target instanceof HTMLElement)) return false;
        return target.isContentEditable || Boolean(
          target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
        );
      };
      const onPlayerKeyDown = (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          isEditableTarget(event.target)
        ) return;

        const playerRoot = player.template.$player;
        if (!playerRoot.matches(':hover') && !playerRoot.contains(document.activeElement)) return;

        const key = event.key.toLowerCase();
        // Space should still activate a focused button in the player controls.
        if (
          (key === ' ' || event.code === 'Space') &&
          event.target instanceof HTMLElement &&
          event.target.closest('button, a, [role="button"]')
        ) return;

        let handled = true;
        switch (key) {
          case 'f':
            player.fullscreen = !player.fullscreen;
            break;
          case ' ':
          case 'k':
            if (player.video.paused) {
              void player.video.play().catch(() => {
                /* Playback can be blocked by the webview until user interaction. */
              });
            } else {
              player.video.pause();
            }
            break;
          case 'arrowleft':
            player.currentTime = Math.max(0, player.currentTime - 5);
            break;
          case 'arrowright': {
            const duration = player.duration;
            const next = player.currentTime + 5;
            player.currentTime = Number.isFinite(duration) ? Math.min(duration, next) : next;
            break;
          }
          case 'arrowup':
            player.muted = false;
            player.volume = Math.min(1, player.volume + 0.1);
            break;
          case 'arrowdown':
            player.volume = Math.max(0, player.volume - 0.1);
            break;
          case 'm':
            player.muted = !player.muted;
            break;
          case 'escape':
            if (player.fullscreen) {
              player.fullscreen = false;
            } else {
              handled = false;
            }
            break;
          default:
            handled = false;
        }

        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      document.addEventListener('keydown', onPlayerKeyDown);
      disposers.push(() => document.removeEventListener('keydown', onPlayerKeyDown));

      // ASS subtitles: render via JASSub (native tracks only do VTT/SRT)
      if (sub && subType === 'ass') {
        loadJassub()
          .then(() => {
            if (!cancelled) player.plugins.add(jassubPlugin(proxy.cors(sub.url)));
          })
          .catch(() => {
            setSubtitleNotice('Could not load ASS/SSA subtitles. Try another track or source.');
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
      const onTime = () => {
        savePosition();
        const duration = player.duration;
        if (
          !progressCommitted &&
          !player.video.seeking &&
          Number.isFinite(duration) &&
          duration > 0 &&
          player.currentTime / duration >= 0.8
        ) {
          progressCommitted = true;
          pushProgress(Number(animeId), episodeNumber, peekAnimeInfo(animeId)?.isAdult);
        }
      };
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

  // Apply persisted subtitle visibility and appearance without recreating the player.
  useEffect(() => {
    if (!art) return;
    try {
      art.subtitle.show = subtitleEnabled;
      art.subtitle.style({
        color: subtitleColor,
        fontSize: `${subtitleFontSize}px`,
        fontFamily: subtitleFontFamily,
        fontWeight: subtitleBold ? 'bold' : 'normal',
        textShadow: subtitleOutline
          ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 5px #000'
          : '0 0 5px #000',
      });
    } catch {
      setSubtitleNotice('Subtitle styling is unavailable for this stream.');
    }
  }, [art, subtitleEnabled, subtitleFontSize, subtitleColor, subtitleFontFamily, subtitleBold, subtitleOutline]);

  // Load the selected track through the direct URL first, then the local
  // playback proxy. Blob URLs avoid cross-origin subtitle requests and work
  // with providers whose subtitle host blocks CORS.
  // ArtPlayer's switch API accepts URL + format, not a third language arg.
  useEffect(() => {
    if (!art || !subtitles?.length) return;
    const track = subtitles[selectedSubtitleIndex];
    if (!track) return;
    const type = subtitleFormat(track.url);
    if (type === 'ass') {
      if (selectedSubtitleIndex !== 0) setSubtitleNotice('Switching to another ASS/SSA track is not supported yet.');
      return;
    }
    let cancelled = false;
    let blobUrl: string | null = null;
    const loadTrack = async () => {
      for (const candidate of [track.url, proxy.segment(track.url)]) {
        try {
          const response = await fetch(candidate);
          if (!response.ok) continue;
          const blob = await response.blob();
          if (cancelled) return;
          blobUrl = URL.createObjectURL(blob);
          art.subtitle.switch(blobUrl, {
            type: type === 'srt' ? 'srt' : 'vtt',
            name: track.lang || `Subtitle ${selectedSubtitleIndex + 1}`,
          });
          art.subtitle.show = useSettingsStore.getState().subtitleEnabled;
          setSubtitleNotice('');
          return;
        } catch {
          // Try the proxy fallback after a direct CORS/network failure.
        }
        if (cancelled) return;
      }
      if (!cancelled) setSubtitleNotice(`Could not load ${track.lang || 'the selected subtitle track'} from this provider.`);
    };
    void loadTrack();
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [art, subtitles, selectedSubtitleIndex]);

  // Mount subtitle controls inside ArtPlayer's fullscreen subtree.
  useEffect(() => {
    const playerElement = art?.template.$player;
    if (!playerElement || !subtitles?.length) {
      setSubtitleSettingsHost(null);
      return;
    }
    const host = document.createElement('div');
    host.className = 'pointer-events-none absolute inset-0 z-[90]';
    playerElement.appendChild(host);
    setSubtitleSettingsHost(host);
    return () => {
      setSubtitleSettingsHost(null);
      host.remove();
    };
  }, [art, subtitles?.length]);

  // intro/outro skip buttons (AniSkip data). Only visible while the
  // playhead is inside the skip window — no permanent button clutter.
  // Keyed on the player *instance* (state), because the instance is created
  // asynchronously and a ref read here would usually still be null.
  // No data (AniSkip 404) simply means no buttons.
  useEffect(() => {
    // The player itself is the fullscreen element. Appending overlays to the
    // outer React container leaves them outside the fullscreen subtree, so
    // attach skip buttons to ArtPlayer's own root instead.
    const playerElement = art?.template.$player;
    if (!playerElement || !skips) return;
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
      playerElement.appendChild(btn);
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
      {kind === 'mp4' && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 bg-ink-900 px-3 py-2">
          <button
            type="button"
            onClick={() => void downloadEpisode()}
            disabled={downloadState.busy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-accent-500 disabled:cursor-not-allowed disabled:opacity-60"
            title="Save this direct MP4 file for offline playback"
          >
            <Download className="h-3.5 w-3.5" />
            {downloadState.busy ? 'Downloading…' : 'Download MP4'}
          </button>
          {downloadState.message && (
            <p role="status" aria-live="polite" className="min-w-0 flex-1 break-all text-xs text-zinc-400">
              {downloadState.message}
            </p>
          )}
          {!downloadState.message && (
            <p className="text-xs text-zinc-500">Direct MP4 only · max 2 GiB</p>
          )}
        </div>
      )}
      {subtitleSettingsHost && subtitles && subtitles.length > 0 && subtitleSettingsOpen && createPortal(
        <div className="pointer-events-auto absolute bottom-12 right-3 z-[100]">
            <div className="w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl bg-black/90 p-4 text-sm text-white shadow-2xl ring-1 ring-white/20">
              <label className="flex items-center justify-between gap-3">
                <span>Subtitles</span>
                <input type="checkbox" checked={subtitleEnabled} onChange={(event) => setSubtitleEnabled(event.target.checked)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-300">Subtitle track</span>
                <select
                  value={selectedSubtitleIndex}
                  onChange={(event) => { setSelectedSubtitleIndex(Number(event.target.value)); setSubtitleNotice(''); }}
                  className="w-full rounded-md bg-zinc-800 px-2 py-2 text-white"
                >
                  {subtitles.map((track, index) => (
                    <option key={`${track.url}-${index}`} value={index}>
                      {track.lang || `Subtitle ${index + 1}`}{index === 0 ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="flex justify-between text-xs text-zinc-300"><span>Text size</span><span>{subtitleFontSize}px</span></span>
                <input type="range" min="14" max="40" step="2" value={subtitleFontSize} onChange={(event) => setSubtitleFontSize(Number(event.target.value))} className="w-full accent-purple-500" />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>Text color</span>
                <input aria-label="Subtitle text color" type="color" value={subtitleColor} onChange={(event) => setSubtitleColor(event.target.value)} className="h-8 w-10 cursor-pointer rounded bg-zinc-800 p-0.5" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-300">Font</span>
                <select value={subtitleFontFamily} onChange={(event) => setSubtitleFontFamily(event.target.value)} className="w-full rounded-md bg-zinc-800 px-2 py-2 text-white">
                  <option value="Arial, sans-serif">Arial</option>
                  <option value="Verdana, sans-serif">Verdana</option>
                  <option value="Tahoma, sans-serif">Tahoma</option>
                  <option value="Georgia, serif">Georgia</option>
                  <option value="monospace">Monospace</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>Bold text</span>
                <input type="checkbox" checked={subtitleBold} onChange={(event) => setSubtitleBold(event.target.checked)} />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>Dark text outline</span>
                <input type="checkbox" checked={subtitleOutline} onChange={(event) => setSubtitleOutline(event.target.checked)} />
              </label>
              {subtitleNotice && <p role="status" className="text-xs text-amber-300">{subtitleNotice}</p>}
            </div>
        </div>,
        subtitleSettingsHost
      )}
    </div>
  );
}
