// AniList mutations + list import extensions (added for auto-sync + notifications feature)
// Mutation: save/update media list entry (watching, completed, progress, dates)
const SAVE_LIST_ENTRY = `
mutation ($mediaId: Int!, $status: MediaListStatus, $episodes: Int, $score: Float) {
  SaveMediaListEntry (mediaId: $mediaId, status: $status, progress: $episodes, score: $score) {
    id status progress score updatedAt
  }
}`;

// Query: import full user media lists (watching, completed, planning, etc.)
const USER_LISTS_QUERY = `
query ($userName: String!, $type: MediaType) {
  MediaListCollection(userName: $userName, type: $type, status_in: [CURRENT, PLANNING, COMPLETED, DROPPED, PAUSED, REPEATING]) {
    lists { name entries { mediaId status progress score updatedAt } }
  }
}`;

export async function saveListEntry(
  token: string,
  mediaId: number,
  status?: string,
  episodes?: number,
  score?: number,
) {
  const query = SAVE_LIST_ENTRY;
  const variables = { mediaId, status: status || undefined, episodes: episodes ?? undefined, score: score ?? undefined };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token.trim()}` };
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST', headers, body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`AniList save failed: ${res.status}`);
  const json = (await res.json()) as { errors?: { message: string }[]; data?: { SaveMediaListEntry?: { id: number } } };
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data?.SaveMediaListEntry ?? null;
}

export async function importUserLists(token: string, userName: string) {
  const query = USER_LISTS_QUERY;
  const variables = { userName, type: 'ANIME' };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token.trim()}` };
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST', headers, body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`AniList import failed: ${res.status}`);
  const json = (await res.json()) as { errors?: { message: string }[]; data?: { MediaListCollection?: { lists: Array<{ name: string; entries: Array<{ mediaId: number; status: string; progress: number; score: number; updatedAt: number }> }> } } };
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data?.MediaListCollection?.lists ?? [];
}
