/**
 * Keep only harmless subtitle formatting tags before ArtPlayer renders the
 * track with HTML parsing enabled. Subtitle files come from third-party
 * providers, so never pass arbitrary markup through to the player.
 */
const ALLOWED_FORMAT_TAGS = new Set(['b', 'i', 'u', 'ruby', 'rt']);

/**
 * Some subtitle providers HTML-encode formatting tags inside VTT/SRT cue text.
 * Decode only the supported formatting tags; leave all other entities as text.
 */
function decodeEscapedFormattingTags(content: string): string {
  return content.replace(
    /(?:&(?:amp;)?lt;|&#0*60;|&#x0*3c;)(\/?)(b|i|u|ruby|rt)\b[^\r\n]*?(?:&(?:amp;)?gt;|&#0*62;|&#x0*3e;)/gi,
    (_tag, closing: string, rawName: string) =>
      `<${closing}${rawName.toLowerCase()}>`,
  );
}

export function sanitizeSubtitleMarkup(content: string): string {
  const decoded = decodeEscapedFormattingTags(content);
  return decoded.replace(/<\/?([a-z][a-z\d:-]*)\b[^<>]*>/gi, (tag, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_FORMAT_TAGS.has(name)) {
      return '';
    }

    // Drop provider-supplied attributes, but retain the allowed formatting tag.
    return tag.startsWith('</') ? `</${name}>` : `<${name}>`;
  });
}
