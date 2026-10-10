import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSkipTimes } from '../src/hooks/useIntroSkip.ts';

type Call = string;

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('10. missing AniSkip data (404) resolves to null, never throws, and stays quiet', async () => {
  const m = mockFetch((url) =>
    url.includes('graphql.anilist.co') ? json({ data: { Media: { idMal: 40746 } } }) : json({ found: false }, 404),
  );
  try {
    const res = await fetchSkipTimes(113417, 1);
    assert.equal(res, null);
    const skipCalls = m.calls.filter((u) => u.includes('skip-times'));
    // 3 mirrors for the exact episode + 1 mirror x (ep 2 only: -1 and -2 are < 1)
    assert.ok(skipCalls.length <= 5, `too many AniSkip requests: ${skipCalls.length}`);
    // second lookup is served from the negative cache: no new AniSkip requests
    const before = m.calls.filter((u) => u.includes('skip-times')).length;
    assert.equal(await fetchSkipTimes(113417, 1), null);
    assert.equal(m.calls.filter((u) => u.includes('skip-times')).length, before);
  } finally {
    m.restore();
  }
});

test('timestamps still work when AniSkip has data', async () => {
  const m = mockFetch((url) =>
    url.includes('graphql.anilist.co')
      ? json({ data: { Media: { idMal: 777 } } })
      : json({ found: true, results: [{ skipType: 'op', interval: { startTime: 10, endTime: 95 } }] }),
  );
  try {
    const res = await fetchSkipTimes(5001, 3);
    assert.deepEqual(res, { op: { start: 10, end: 95 }, ed: null });
  } finally {
    m.restore();
  }
});

test('network failure of every mirror resolves to null (no unhandled rejection)', async () => {
  const m = mockFetch((url) => {
    if (url.includes('graphql.anilist.co')) return json({ data: { Media: { idMal: 888 } } });
    throw new TypeError('network down');
  });
  try {
    assert.equal(await fetchSkipTimes(6001, 2), null);
  } finally {
    m.restore();
  }
});
