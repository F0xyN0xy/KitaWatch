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
    sanitizeSubtitleMarkup('<b onclick="alert(1)">Bold</b><script>alert(1)</script><img src=x><svg/onload=alert(1)>ignored</svg>'),
    '<b>Bold</b>alert(1)ignored',
  );
});

test('keeps ruby subtitle formatting and leaves ordinary angle-bracket text alone', () => {
  assert.equal(
    sanitizeSubtitleMarkup('<ruby>漢<rt>かん</rt></ruby> < 3'),
    '<ruby>漢<rt>かん</rt></ruby> < 3',
  );
});

test('decodes HTML-escaped supported formatting tags in subtitle cues', () => {
  assert.equal(
    sanitizeSubtitleMarkup('&lt;i&gt;Italic&lt;/i&gt; and &amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt;'),
    '<i>Italic</i> and <b>bold</b>',
  );
});

test('decodes numeric formatting-tag entities but leaves unrelated entities alone', () => {
  assert.equal(
    sanitizeSubtitleMarkup('&#60;u&#62;underlined&#60;/u&#62; &lt;3'),
    '<u>underlined</u> &lt;3',
  );
});
