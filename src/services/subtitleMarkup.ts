/**
 * Keep only harmless subtitle formatting tags before ArtPlayer renders the
 * track with HTML parsing enabled. Subtitle files come from third-party
 * providers, so never pass arbitrary markup through to the player.
 */
const ALLOWED_FORMAT_TAGS = new Set(['b', 'i', 'u', 'ruby', 'rt']);

export function sanitizeSubtitleMarkup(content: string): string {
  return content.replace(/<\/?([a-z][a-z\d:-]*)\b[^<>]*>/gi, (tag, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_FORMAT_TAGS.has(name)) {
      return '';
    }

    // Drop provider-supplied attributes, but retain the allowed formatting tag.
    return tag.startsWith('</') ? `</${name}>` : `<${name}>`;
  });
}
