import { test } from 'node:test';
import assert from 'node:assert/strict';
import hanime, { extractMediaStreams, extractEmbedCandidates } from '../api/anivexa/providers/hanime.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body, headers = {}, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

/** Route table -> fetch mock. Unlisted URLs 404. Records every URL. */
function mockWeb(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === 'graphql.anilist.co' && parsedUrl.pathname === '/') {
      return json({ data: { Media: { id: 113417, title: { english: 'Overflow', romaji: 'Overflow' }, episodes: 8 } } });
    }
    for (const [prefix, make] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return make(url);
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const watch = () =>
  hanime.fetch(new Request('http://localhost/watch/hanime/113417/sub/hanime-1'));

const OCEAN_API = 'https://hentaiocean.com/api?action=hentai&slug=overflow-1';
const OCEAN_EMBED = 'https://hentaiocean.com/embed/overflow-1';

test('1. provider embed endpoint that allows framing -> one embed source', async () => {
  const web = mockWeb({
    [OCEAN_API]: () => json({ info: [{ urlname: 'overflow-1' }] }),
    [OCEAN_EMBED]: () => html('<html><body>player shell</body></html>'),
  });
  try {
    const res = await watch();
    assert.equal(res.status, 200);
    const { streams } = await res.json();
    assert.equal(streams.length, 1);
    assert.equal(streams[0].type, 'embed');
    assert.equal(streams[0].url, OCEAN_EMBED);
  } finally {
    web.restore();
  }
});

test('11. page returns 200 but forbids framing -> clear unsupported result, NOT an embed', async () => {
  // exactly the reported log: hanime.tv 404, hstream.moe 200 + X-Frame-Options
  const web = mockWeb({
    'https://hstream.moe/hentai/overflow-1': () =>
      html('<html><div class="player">watch</div></html>', { 'x-frame-options': 'sameorigin' }),
  });
  try {
    const res = await watch();
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error, /hstream\.moe/);
    assert.match(body.error, /sameorigin/i);
    assert.equal(body.streams, undefined);
  } finally {
    web.restore();
  }
});

test('11b. embed endpoint that forbids framing is rejected too', async () => {
  const web = mockWeb({
    [OCEAN_API]: () => json({ info: [{ urlname: 'overflow-1' }] }),
    [OCEAN_EMBED]: () => html('<html></html>', { 'content-security-policy': "frame-ancestors 'self'" }),
  });
  try {
    const res = await watch();
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /frame-ancestors/);
  } finally {
    web.restore();
  }
});

test('9. every candidate 404 -> "no page found" miss, no streams', async () => {
  const web = mockWeb({});
  try {
    const res = await watch();
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /no page found/i);
  } finally {
    web.restore();
  }
});

test('direct media found on a watch page is returned typed from the URL path', async () => {
  const web = mockWeb({
    'https://hstream.moe/hentai/overflow-1': () =>
      html('<video><source src="https://cdn.example/v/ep1.m3u8?token=a"></video>', { 'x-frame-options': 'sameorigin' }),
  });
  try {
    const res = await watch();
    assert.equal(res.status, 200);
    const { streams } = await res.json();
    assert.deepEqual(streams.map((s) => s.type), ['hls']);
  } finally {
    web.restore();
  }
});

test('extractors: no mislabeling, no duplicates, no relative/garbage URLs', () => {
  const page = `
    <video src="/media/a.mp4"></video><video src="/media/a.mp4"></video>
    <script type="application/ld+json">{"contentUrl":"https://cdn.example/b.mp4?x=1","embedUrl":"https://p.example/embed/9"}</script>
    <script>var u = "https://cdn.example/c.m3u8"; var w = "https://cdn.example/watch?file=d.mp4";</script>
    <iframe src="//p.example/player/1"></iframe><iframe src="javascript:alert(1)"></iframe>`;
  const media = extractMediaStreams(page, 'https://site.example');
  assert.deepEqual(
    media.map((s) => [s.type, s.url]).sort(),
    [
      ['hls', 'https://cdn.example/c.m3u8'],
      ['mp4', 'https://cdn.example/b.mp4?x=1'],
      ['mp4', 'https://site.example/media/a.mp4'],
    ].sort(),
  );
  // JSON-LD embedUrl is a frame candidate, not an "mp4"
  assert.ok(extractEmbedCandidates(page, 'https://site.example').includes('https://p.example/embed/9'));
  assert.ok(!extractEmbedCandidates(page, 'https://site.example').some((u) => u.startsWith('javascript')));
});
