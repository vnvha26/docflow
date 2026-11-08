const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ESCAPES[character]);

const INNER_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const INNER_STYLE = `
  body {
    box-sizing: border-box;
    max-width: 64rem;
    margin: 0 auto;
    padding: 1.5rem clamp(1rem, 4vw, 3rem) 4rem;
    font: 1rem/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1f2a1c;
    background: #fff;
    overflow-wrap: anywhere;
  }
  h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 .5em; line-height: 1.3; }
  body > :first-child { margin-top: 0; }
  p, ul, ol { max-width: 76ch; margin: 0 0 .9em; }
  ul, ol { padding-inline-start: 1.5em; }
  li + li { margin-top: .25em; }
  table {
    display: block;
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    margin: 1rem 0 1.5rem;
    font-size: .9375rem;
  }
  th, td {
    min-width: 8ch;
    max-width: 30ch;
    padding: .5rem .75rem;
    border: 1px solid #cfd6c4;
    vertical-align: top;
  }
  th { background: #edf3e7; text-align: start; }
  td > :last-child, th > :last-child { margin-bottom: 0; }
  img { max-width: 100%; height: auto; }
  a { color: #2f6b3a; }
`;
const OUTER_STYLE = `
  html, body { margin: 0; height: 100%; }
  body {
    display: flex;
    flex-direction: column;
    background: #f3f5ee;
    font: .875rem/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #4a5544;
  }
  header { padding: .625rem 1rem; border-bottom: 1px solid #dfe5d4; background: #fff; }
  header strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #1f2a1c; }
  iframe { flex: 1; min-height: 0; border: 0; width: 100%; background: #fff; }
`;

export function previewPage(title: string, html: string): string {
  const label = escapeHtml(title);
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const inner = `<!doctype html><html lang="vi"><head><meta charset="utf-8">${viewport}<meta http-equiv="Content-Security-Policy" content="${INNER_POLICY}"><style>${INNER_STYLE}</style></head><body>${html}</body></html>`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">${viewport}<title>${label}</title><style>${OUTER_STYLE}</style></head>`
    + `<body><header><strong>${label}</strong><span>Cuộn ngang trong bảng rộng. Tải bản gốc để xem đúng bố cục Word.</span></header>`
    + `<iframe sandbox="" referrerpolicy="no-referrer" title="${label}" srcdoc="${escapeHtml(inner)}"></iframe></body></html>`;
}

export const DOCX_FAILED = 'docflow:docx-failed';

export interface DocxScripts { jszip: string; docxPreview: string }

const inlineScript = (source: string) => source.replace(/<\/(script)/gi, String.raw`<\/$1`).replace(/<!--/g, String.raw`<\!--`);

const LAYOUT_STYLE = `
  html, body { margin: 0; background: #e7eae2; }
  #status { padding: 2rem 1rem; text-align: center; font: .9375rem/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #4a5544; }
  #pages .docx-wrapper { background: #e7eae2; padding: 1.5rem 0; }
  #pages .docx-wrapper > section.docx { box-shadow: 0 1px 6px rgba(31, 42, 28, .18); margin-bottom: 1.5rem; }
  @media print { html, body, #pages .docx-wrapper { background: #fff; padding: 0; } #pages .docx-wrapper > section.docx { box-shadow: none; margin: 0; } }
`;

const LAYOUT_SCRIPT = `
(async () => {
  const status = document.getElementById('status');
  const pages = document.getElementById('pages');
  const fit = () => {
    pages.style.zoom = '';
    const widest = Math.max(0, ...Array.from(pages.querySelectorAll('section.docx'), (page) => page.offsetWidth));
    if (widest > 0) pages.style.zoom = String(Math.min(1, (document.documentElement.clientWidth - 16) / widest));
  };
  try {
    const raw = atob(document.getElementById('source').textContent.trim());
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    await docx.renderAsync(bytes, pages, undefined, {
      inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true, useBase64URL: true,
      renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderComments: false,
      ignoreFonts: false, experimental: false,
    });
    if (!pages.querySelector('section.docx')) throw new Error('EMPTY');
    status.remove();
    fit();
    addEventListener('resize', fit);
  } catch {
    status.textContent = 'Không dựng được bố cục của tệp này.';
    parent.postMessage({ type: '${DOCX_FAILED}' }, '*');
  }
})();
`;

export function layoutPolicy(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:`;
}

export function layoutPage(title: string, docxBase64: string, scripts: DocxScripts, nonce: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(docxBase64)) throw new Error('INVALID_BASE64');
  if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) throw new Error('INVALID_NONCE');
  const label = escapeHtml(title);
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const script = (source: string) => `<script nonce="${nonce}">${inlineScript(source)}</script>`;
  const inner = `<!doctype html><html lang="vi"><head><meta charset="utf-8">${viewport}`
    + `<meta http-equiv="Content-Security-Policy" content="${layoutPolicy(nonce)}"><style>${LAYOUT_STYLE}</style></head>`
    + `<body><p id="status">Đang dựng bố cục…</p><div id="pages"></div>`
    + `<script type="application/x-docflow-docx" id="source">${docxBase64}</script>`
    + script(scripts.jszip) + script(scripts.docxPreview) + script(LAYOUT_SCRIPT) + '</body></html>';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">${viewport}<title>${label}</title><style>${OUTER_STYLE}</style></head>`
    + `<body><header><strong>${label}</strong><span>Bố cục được dựng lại trên trình duyệt, có thể lệch nhẹ so với Word. Tải bản gốc nếu cần bản chính xác.</span></header>`
    + `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="${label}" srcdoc="${escapeHtml(inner)}"></iframe></body></html>`;
}
