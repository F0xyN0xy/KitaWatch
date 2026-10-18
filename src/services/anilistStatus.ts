/**
 * Choose the AniList status to send when an episode finishes.
 *
 * AniList has one status per media-list entry. Starting to watch something
 * that is still Planned should transition that existing entry to Watching;
 * other existing statuses are preserved by omitting the status mutation.
 */
export function statusForProgressUpdate(
  existingStatus: string | null | undefined,
): 'CURRENT' | undefined {
  if (!existingStatus || existingStatus === 'PLANNING') return 'CURRENT';
  return undefined;
}
