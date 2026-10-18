import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusForProgressUpdate } from '../src/services/anilistStatus.ts';

test('a missing AniList entry is created as Watching', () => {
  assert.equal(statusForProgressUpdate(null), 'CURRENT');
  assert.equal(statusForProgressUpdate(undefined), 'CURRENT');
});

test('Planned transitions to Watching when an episode ends', () => {
  assert.equal(statusForProgressUpdate('PLANNING'), 'CURRENT');
});

test('existing Watching status is left unchanged', () => {
  assert.equal(statusForProgressUpdate('CURRENT'), undefined);
});

test('Completed, Paused, Dropped, and Repeating statuses are preserved', () => {
  for (const status of ['COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING']) {
    assert.equal(statusForProgressUpdate(status), undefined, status);
  }
});
