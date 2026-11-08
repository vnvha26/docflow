import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCX_FAILED, escapeHtml, layoutPage, layoutPolicy, previewPage } from './preview.ts';

test('the DOCX preview sits in a sandboxed frame without scripts, and the title cannot break out', () => {
  const hostile = '<p>Hợp đồng</p><script>alert(1)</script><a href="javascript:alert(2)">x</a>" onload="alert(3)';
  const page = previewPage('Hợp đồng "<b>thuê</b>"', hostile);
  const frames = page.match(/<iframe[^>]*>/g) ?? [];
  assert.equal(frames.length, 1);
  assert.match(frames[0], /\ssandbox=""\s/);
  assert.doesNotMatch(frames[0], /allow-scripts|allow-same-origin/);
  assert.equal(page.match(/<script/g), null, 'untrusted markup only appears escaped inside srcdoc');
  assert.ok(page.includes('<title>Hợp đồng &quot;&lt;b&gt;thuê&lt;/b&gt;&quot;</title>'));
  const srcdoc = /srcdoc="([^"]*)"/.exec(page)?.[1] ?? '';
  const inner = srcdoc.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.ok(inner.includes(`Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`));
  assert.ok(inner.endsWith(`<body>${hostile}</body></html>`), 'the frame receives the HTML unchanged');
});

test('escapeHtml covers every character that can end an attribute or start a tag', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const nonce = 'Abc_def-0123456789xyz';

test('the layout viewer runs only our nonce scripts inside an opaque-origin frame with no network', () => {
  const page = layoutPage('Hợp đồng "<b>"', 'UEsDBA==', { jszip: 'var JSZip = "</script><b>x</b><!-- y";', docxPreview: 'var docx = {};' }, nonce);
  const frames = page.match(/<iframe[^>]*>/g) ?? [];
  assert.equal(frames.length, 1);
  assert.match(frames[0], /\ssandbox="allow-scripts"\s/, 'scripts run, but never with the app origin');
  assert.doesNotMatch(frames[0], /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/);
  assert.equal(page.match(/<script/g), null, 'the outer page has no script at all');
  assert.ok(page.includes('<title>Hợp đồng &quot;&lt;b&gt;&quot;</title>'));
  const inner = decode(/srcdoc="([^"]*)"/.exec(page)?.[1] ?? '');
  assert.ok(inner.includes(`content="${layoutPolicy(nonce)}"`));
  assert.equal(layoutPolicy(nonce), `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:`);
  const scripts = inner.match(/<script[^>]*>/g) ?? [];
  assert.deepEqual(scripts, ['<script type="application/x-docflow-docx" id="source">', ...Array(3).fill(`<script nonce="${nonce}">`)]);
  assert.ok(inner.includes(String.raw`var JSZip = "<\/script><b>x</b><\!-- y";`),'a closing tag inside vendor code cannot end the script early');
  assert.ok(inner.includes('<script type="application/x-docflow-docx" id="source">UEsDBA==</script>'));
  assert.ok(inner.includes(DOCX_FAILED));
});

test('the layout viewer refuses data or a nonce that could break out of the page', () => {
  const scripts = { jszip: '', docxPreview: '' };
  assert.throws(() => layoutPage('x', 'AAAA</script>', scripts, nonce), /INVALID_BASE64/);
  assert.throws(() => layoutPage('x', 'AAAA', scripts, 'short'), /INVALID_NONCE/);
  assert.throws(() => layoutPage('x', 'AAAA', scripts, `${nonce}" onload="x`), /INVALID_NONCE/);
});
