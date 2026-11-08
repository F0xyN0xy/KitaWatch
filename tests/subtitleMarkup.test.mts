import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSubtitleMarkup } from '../src/services/subtitleMarkup.ts';

test('preserves supported subtitle formatting tags', () => {
  assert.equal(
    sanitizeSubtitleMarkup('<b>Bold</b> and <i>italic</i> with <u>underline</u>'),
    '<b>Bold</b> and <i>italic</i> with <u>underline</u>',
  );
});

test('removes attributes and unsupported HTML while preserving subtitle text', () => {
  assert.equal(
    sanitizeSubtitleMarkup('<b onclick="alert(1)">Bold</b><script>alert(1)</script><img src=x>'),
    '<b>Bold</b>alert(1)',
  );
});

test('keeps ruby subtitle formatting and leaves ordinary angle-bracket text alone', () => {
  assert.equal(
    sanitizeSubtitleMarkup('<ruby>漢<rt>かん</rt></ruby> < 3'),
    '<ruby>漢<rt>かん</rt></ruby> < 3',
  );
});
