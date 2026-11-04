/**
 * Return only a plausible forward-playback delta.
 *
 * Media currentTime advances during normal playback, but also jumps when a
 * viewer seeks. Large gaps are ignored because they cannot be distinguished
 * reliably from background-tab throttling or a seek.
 */
export function getForwardPlaybackDelta(
  previousTime: number,
  currentTime: number,
  paused: boolean,
  seeking: boolean,
  maxDeltaSeconds = 30,
): number {
  if (
    paused ||
    seeking ||
    !Number.isFinite(previousTime) ||
    !Number.isFinite(currentTime) ||
    !Number.isFinite(maxDeltaSeconds) ||
    maxDeltaSeconds <= 0
  ) {
    return 0;
  }

  const delta = currentTime - previousTime;
  return delta > 0 && delta <= maxDeltaSeconds ? delta : 0;
}
