import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySourceKind,
  frameEmbedPolicy,
  isDirectMedia,
  kindFromUrl,
  mediaResponseVerdict,
  subtitleFormat,
} from '../src/services/sourceType.ts';

const h = (o: Record<string, string>) => ({
  get: (k: string) => o[k.toLowerCase()] ?? null,
});

test('1. provider-declared embed is an embed; never inferred from the URL', () => {
  assert.equal(classifySourceKind('embed', 'https://hentaiocean.com/embed/overflow-1'), 'embed');
  // same URL with no declaration is NOT an embed
  assert.equal(classifySourceKind(undefined, 'https://hentaiocean.com/embed/overflow-1'), 'unknown');
  // an "embed" that is really a media file is reported as the media it is
  assert.equal(classifySourceKind('embed', 'https://cdn.example/v/a.m3u8'), 'hls');
  assert.equal(classifySourceKind('embed', 'not a url'), 'unknown');
});

test('2. direct HLS', () => {
  assert.equal(classifySourceKind('hls', 'https://cdn.example/v/index.m3u8'), 'hls');
  assert.equal(classifySourceKind(undefined, 'https://cdn.example/v/index.M3U8'), 'hls');
});

test('3. direct MP4', () => {
  assert.equal(classifySourceKind('mp4', 'https://cdn.example/v/ep1.mp4'), 'mp4');
  assert.equal(classifySourceKind(undefined, 'https://cdn.example/v/ep1.m4v'), 'mp4');
});

test('4. webpage supplied as mp4 is not trusted as a file', () => {
  assert.equal(classifySourceKind('mp4', 'https://hstream.moe/watch/overflow-1.html'), 'unknown');
  assert.equal(classifySourceKind(undefined, 'https://hstream.moe/hentai/overflow-1'), 'unknown');
  // declared type contradicted by the path wins
  assert.equal(classifySourceKind('mp4', 'https://cdn.example/v/index.m3u8'), 'hls');
});

test('4b. extensionless declared mp4 (token / loopback torrent URLs) stays playable, but probing decides', () => {
  assert.equal(classifySourceKind('mp4', 'http://127.0.0.1:8080/stream/0'), 'mp4');
  // an HTML 200 is NOT proof of video
  assert.equal(mediaResponseVerdict('mp4', 200, 'text/html; charset=utf-8'), false);
  assert.equal(mediaResponseVerdict('mp4', 200, 'video/mp4'), true);
  assert.equal(mediaResponseVerdict('mp4', 200, 'application/octet-stream'), true);
});

test('5. query strings and fragments do not hide or fake extensions', () => {
  assert.equal(kindFromUrl('https://cdn.example/v/index.m3u8?token=abc&x=1'), 'hls');
  assert.equal(kindFromUrl('https://cdn.example/v/ep1.mp4?sig=a#t=10'), 'mp4');
  // extension only in the query is not a media path
  assert.equal(kindFromUrl('https://cdn.example/watch?file=ep1.mp4'), 'unknown');
  assert.equal(kindFromUrl('https://cdn.example/watch#ep1.m3u8'), 'unknown');
  assert.equal(kindFromUrl('/relative/ep1.mp4'), 'unknown');
  assert.equal(kindFromUrl('javascript:alert(1)'), 'unknown');
  assert.equal(subtitleFormat('https://s.example/sub.srt?v=2'), 'srt');
  assert.equal(subtitleFormat('https://s.example/sub.ass?v=2'), 'ass');
});

test('6/7. switching kinds dispatches to the right player component', () => {
  // VideoPlayer renders EmbedPlayer / MediaPlayer / UnsupportedSource purely
  // from this decision, and Watch keys the player on the source identity, so
  // iframe -> hls -> mp4 each unmounts the previous player.
  const seq = [
    classifySourceKind('embed', 'https://hentaiocean.com/embed/x'),
    classifySourceKind('hls', 'https://cdn.example/a.m3u8'),
    classifySourceKind('mp4', 'https://cdn.example/a.mp4'),
  ];
  assert.deepEqual(seq, ['embed', 'hls', 'mp4']);
  assert.deepEqual(seq.map(isDirectMedia), [false, true, true]);
});

test('9. a 404 page is not media; an embed status proves nothing', () => {
  assert.equal(mediaResponseVerdict('hls', 404, null, ''), false);
  assert.equal(mediaResponseVerdict('mp4', 404, 'text/html'), false);
  assert.equal(mediaResponseVerdict('hls', 200, 'text/html', '<html>player</html>'), false);
  assert.equal(mediaResponseVerdict('hls', 200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-VERSION:3'), true);
  assert.equal(mediaResponseVerdict('embed', 200, 'text/html'), undefined);
  assert.equal(mediaResponseVerdict('unknown', 200, 'text/html'), false);
  assert.equal(mediaResponseVerdict('mp4', 405, null), undefined);
});

test('11. frame policy: X-Frame-Options / CSP frame-ancestors are detected, not bypassed', () => {
  assert.equal(frameEmbedPolicy(h({ 'x-frame-options': 'sameorigin' })).embeddable, false);
  assert.equal(frameEmbedPolicy(h({ 'x-frame-options': 'DENY' })).embeddable, false);
  assert.equal(
    frameEmbedPolicy(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" })).embeddable,
    false,
  );
  assert.equal(
    frameEmbedPolicy(h({ 'content-security-policy': 'frame-ancestors https://other.example' })).embeddable,
    false,
  );
  assert.equal(frameEmbedPolicy(h({ 'content-security-policy': 'frame-ancestors *' })).embeddable, true);
  assert.equal(frameEmbedPolicy(h({})).embeddable, true);
  assert.match(frameEmbedPolicy(h({ 'x-frame-options': 'sameorigin' })).reason ?? '', /sameorigin/);
});
