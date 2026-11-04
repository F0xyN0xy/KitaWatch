import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getForwardPlaybackDelta } from '../src/services/watchTime.ts';

test('counts a normal forward playback interval', () => {
  assert.equal(getForwardPlaybackDelta(10, 18, false, false), 8);
});

test('does not count playback while paused or seeking', () => {
  assert.equal(getForwardPlaybackDelta(10, 18, true, false), 0);
  assert.equal(getForwardPlaybackDelta(10, 18, false, true), 0);
});

test('does not count seeks, backwards movement, or invalid timestamps', () => {
  assert.equal(getForwardPlaybackDelta(10, 50, false, false), 0);
  assert.equal(getForwardPlaybackDelta(50, 10, false, false), 0);
  assert.equal(getForwardPlaybackDelta(Number.NaN, 12, false, false), 0);
});

test('supports a configurable maximum interval', () => {
  assert.equal(getForwardPlaybackDelta(10, 35, false, false, 20), 0);
  assert.equal(getForwardPlaybackDelta(10, 25, false, false, 20), 15);
});
