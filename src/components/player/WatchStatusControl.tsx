import { useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { saveListEntry } from '@/services/anilistSync';

type AniListStatus = 'CURRENT' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'PLANNING';

const STATUS_OPTIONS: { value: AniListStatus; label: string }[] = [
  { value: 'CURRENT', label: 'Watching' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'DROPPED', label: 'Dropped' },
  { value: 'PLANNING', label: 'Planned' },
];

const ENTRY_STATUS_QUERY = `
query ($mediaId: Int!, $userId: Int!) {
  MediaList(mediaId: $mediaId, userId: $userId) {
    status
  }
}`;

interface Props {
  mediaId: number;
}

export default function WatchStatusControl({ mediaId }: Props) {
  const { accessToken, viewer } = useAuthStore();
  const [status, setStatus] = useState<AniListStatus | ''>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus('');
    setError('');
    setSaved(false);

    if (!accessToken || !viewer?.id) return;

    setLoading(true);
    fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken.trim()}`,
      },
      body: JSON.stringify({
        query: ENTRY_STATUS_QUERY,
        variables: { mediaId, userId: viewer.id },
      }),
      signal: AbortSignal.timeout(15000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`AniList request failed: ${response.status}`);
        const result = (await response.json()) as {
          data?: { MediaList?: { status?: AniListStatus } | null };
          errors?: { message: string }[];
        };
        if (result.errors?.length) {
          throw new Error(result.errors.map((item) => item.message).join('; '));
        }
        if (!result.data) throw new Error('AniList returned no status data');
        if (!cancelled) setStatus(result.data.MediaList?.status ?? '');
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load AniList status');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, viewer?.id, mediaId]);

  if (!accessToken || !viewer?.id) return null;

  const changeStatus = async (nextStatus: string) => {
    if (!STATUS_OPTIONS.some((option) => option.value === nextStatus) || saving) return;
    const previousStatus = status;
    setStatus(nextStatus as AniListStatus);
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await saveListEntry(accessToken, mediaId, nextStatus);
      setSaved(true);
    } catch (cause) {
      setStatus(previousStatus);
      setError(cause instanceof Error ? cause.message : 'Could not update AniList status');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl bg-ink-900 px-4 py-3 ring-1 ring-white/5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">AniList status</p>
        <p className="text-xs text-zinc-500">Changes sync to your AniList account.</p>
      </div>
      <select
        aria-label="AniList watch status"
        value={status}
        disabled={loading || saving}
        onChange={(event) => void changeStatus(event.target.value)}
        className="ml-auto min-w-36 rounded-lg border-0 bg-ink-800 px-3 py-2 text-sm text-zinc-100 ring-1 ring-white/10 outline-none focus:ring-accent-500 disabled:opacity-60"
      >
        <option value="" disabled>{loading ? 'Loading status…' : 'Choose status'}</option>
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {saving && <LoaderCircle aria-label="Saving status" className="h-4 w-4 animate-spin text-accent-300" />}
      {!saving && saved && <Check aria-label="Status saved" className="h-4 w-4 text-emerald-400" />}
      {error && <p role="alert" className="w-full text-xs text-red-300">{error}</p>}
    </section>
  );
}
