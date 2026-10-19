import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiscordAuthCallback } from '../src/services/discordAuthUrl.ts';

test('accepts a Discord callback with an authorization code', () => {
  assert.deepEqual(
    parseDiscordAuthCallback('kitawatch://auth?provider=discord&code=abc123'),
    { code: 'abc123' },
  );
});

test('rejects an AniList callback so Discord cannot consume its code', () => {
  assert.equal(parseDiscordAuthCallback('kitawatch://auth?code=anilist-code'), null);
});

test('rejects callbacks from other protocols or hosts', () => {
  assert.equal(parseDiscordAuthCallback('https://example.com/auth?provider=discord&code=x'), null);
  assert.equal(parseDiscordAuthCallback('kitawatch://other?provider=discord&code=x'), null);
});

test('rejects implicit-flow token fragments instead of treating them as a code', () => {
  assert.equal(
    parseDiscordAuthCallback('kitawatch://auth?provider=discord#access_token=redacted&refresh_token=redacted'),
    null,
  );
});

test('rejects missing or empty authorization codes', () => {
  assert.equal(parseDiscordAuthCallback('kitawatch://auth?provider=discord'), null);
  assert.equal(parseDiscordAuthCallback('kitawatch://auth?provider=discord&code='), null);
  assert.equal(parseDiscordAuthCallback('not a URL'), null);
});
