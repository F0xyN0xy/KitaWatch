import { useEffect, useRef } from 'react';
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import type { StreamSource, SubtitleTrack } from '@/types';
import { proxy } from '@/services/api';
import { useIntroSkip } from '@/hooks/useIntroSkip';
import { useSettingsStore } from '@/stores/settingsStore';
import { useHistoryStore } from '@/stores/historyStore';

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

export default function VideoPlayer({
  source,
  animeId,
  episodeNumber,
  subtitles,
  poster,
  autoplayNext,
  hasNextEpisode,
  onEnded,
  onFatal,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<Artplayer | null>(null);
  // Latest callbacks without re-creating the player instance
  const callbacks = useRef({ onEnded, onFatal });
  callbacks.current = { onEnded, onFatal };
  const skips = useIntroSkip(animeId, episodeNumber);

  useEffect(() => {
    if (!containerRef.current) return;
    let hls: Hls | null = null;
    let art: Artplayer | null = null;
    let subBlobUrl: string | null = null;
    let failed = false;
    // Listeners wired after art creation; cleaned up by the effect return.
    const disposers: (() => void)[] = [];

    const fail = () => {
      if (failed) return;
      failed = true;
      callbacks.current.onFatal();
    };

    const isHls = source.type === 'hls' || source.url.includes('.m3u8');
    const sub = subtitles?.[0];
    const subType = sub
      ? sub.url.includes('.ass')
        ? 'ass'
        : sub.url.includes('.srt')
          ? 'srt'
          : 'vtt'
      : null;

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
              subBlobUrl = URL.createObjectURL(await res.blob());
              break;
            }
          } catch {
            /* try the next candidate */
          }
        }
      }

      if (!containerRef.current) return;

      art = new Artplayer({
        container: containerRef.current,
        url: source.url,
        poster,
        type: isHls ? 'm3u8' : 'mp4',
        autoplay: true,
        volume: 0.8,
        theme: '#9333ea',
        screenshot: true,
        setting: true,
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
          m3u8: (video, url, art) => {
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
              art.on('destroy', () => hls?.destroy());
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
              video.src = url;
            } else {
              fail();
            }
          },
        },
      });
      artRef.current = art;
      const instance = art;

      // ASS subtitles: render via JASSub (native tracks only do VTT/SRT)
      if (sub && subType === 'ass') {
        loadJassub()
          .then(() => instance.plugins.add(jassubPlugin(proxy.cors(sub.url))))
          .catch(() => {
            /* fall back to no subtitles */
          });
      }

      // Fatal error on direct mp4 files too
      instance.video.addEventListener('error', fail);

      instance.on('video:ended', () => {
        if (autoplayNext && hasNextEpisode) callbacks.current.onEnded();
      });

      // remember fullscreen across sessions. Webviews reject programmatic
      // fullscreen without a user gesture, so restore on the first
      // interaction instead of at mount.
      const onFullscreenChange = (state: boolean) => {
        useSettingsStore.getState().setLastFullscreen(state);
      };
      instance.on('fullscreen', onFullscreenChange);
      disposers.push(() => instance.off('fullscreen', onFullscreenChange));

      const tryRestoreFullscreen = () => {
        const s = useSettingsStore.getState();
        if (s.rememberFullscreen && s.lastFullscreen) {
          try {
            instance.fullscreen = true;
          } catch {
            /* rejected without a gesture — stay windowed */
          }
        }
        instance.off('video:play', tryRestoreFullscreen);
        instance.off('click', tryRestoreFullscreen);
      };
      instance.on('video:play', tryRestoreFullscreen);
      instance.on('click', tryRestoreFullscreen);
      disposers.push(() => {
        instance.off('video:play', tryRestoreFullscreen);
        instance.off('click', tryRestoreFullscreen);
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
        if (resumeAt != null) instance.currentTime = resumeAt;
      };
      instance.video.addEventListener('loadedmetadata', onMeta, { once: true });
      disposers.push(() => instance.video.removeEventListener('loadedmetadata', onMeta));

      // save position — throttled to ~every 10s, plus a final save on
      // pause/ended so the resume point is fresh.
      let lastPosSave = 0;
      const savePosition = (force = false) => {
        const now = Date.now();
        if (!force && now - lastPosSave < 10_000) return;
        lastPosSave = now;
        const d = instance.duration;
        if (!d || Number.isNaN(d)) return;
        useHistoryStore
          .getState()
          .updatePosition(Number(animeId), episodeNumber, instance.currentTime, d);
      };
      const onTime = () => savePosition();
      const onStop = () => savePosition(true);
      instance.video.addEventListener('timeupdate', onTime);
      instance.video.addEventListener('pause', onStop);
      instance.video.addEventListener('ended', onStop);
      disposers.push(() => {
        instance.video.removeEventListener('timeupdate', onTime);
        instance.video.removeEventListener('pause', onStop);
        instance.video.removeEventListener('ended', onStop);
      });
    };

    void init();

    return () => {
      for (const dispose of disposers) dispose();
      art?.destroy(false);
      artRef.current = null;
      if (subBlobUrl) URL.revokeObjectURL(subBlobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.url, source.type, animeId, episodeNumber]);

  // intro/outro skip buttons (AniSkip data). Only visible while the
  // playhead is inside the skip window — no permanent button clutter.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !artRef.current) return;
    const art = artRef.current;
    const specs = [
      { interval: skips?.op ?? null, label: 'Skip intro →' },
      { interval: skips?.ed ?? null, label: 'Skip outro →' },
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
  }, [skips, source.url]);

  return (
    <div className="relative w-full overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
      <div ref={containerRef} className="aspect-video w-full" />
    </div>
  );
}