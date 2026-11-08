import { documentsApi } from '../../lib/documents';
import type { DocumentSummary } from '../../lib/documents';
import { DOCX_FAILED, layoutPage, previewPage } from '../../lib/preview';

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function write(viewer: Window, html: string) {
  viewer.document.open();
  viewer.document.write(html);
  viewer.document.close();
}

async function showText(viewer: Window, item: DocumentSummary) {
  try {
    const html = await (await documentsApi.preview(item.id)).blob.text();
    if (viewer.closed) return;
    const url = URL.createObjectURL(new Blob([previewPage(item.title, html)], { type: 'text/html;charset=utf-8' }));
    viewer.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    return;
  }
}

export async function showDocx(viewer: Window, item: DocumentSummary): Promise<void> {
  const [{ blob }, { docxScripts }] = await Promise.all([documentsApi.original(item.id), import('../../lib/docx-scripts')]);
  const page = layoutPage(item.title, await toBase64(blob), docxScripts, newNonce());
  if (viewer.closed) return;
  write(viewer, page);
  const frame = viewer.document.querySelector('iframe');
  const onMessage = (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow || (event.data as { type?: unknown } | null)?.type !== DOCX_FAILED) return;
    viewer.removeEventListener('message', onMessage);
    void showText(viewer, item);
  };
  viewer.addEventListener('message', onMessage);
}
