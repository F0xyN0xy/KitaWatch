/**
 * Keep only harmless subtitle formatting tags before ArtPlayer renders the
 * track with HTML parsing enabled. Subtitle files come from third-party
 * providers, so never pass arbitrary markup through to the player.
 */
const ALLOWED_FORMAT_TAGS = new Set(['b', 'i', 'u', 'ruby', 'rt']);

export function sanitizeSubtitleMarkup(content: string): string {
  return content.replace(/<\/?[a-z][^<>]*>/gi, (tag) => {
    const match = /^<(\/)?(b|i|u|ruby|rt)>$/i.exec(tag);
    if (!match || !ALLOWED_FORMAT_TAGS.has(match[2].toLowerCase())) {
      return '';
    }

    return match[1]
      ? `</${match[2].toLowerCase()}>`
      : `<${match[2].toLowerCase()}>`;
  });
}
