import { documentsApi, DOCX_MIME, MARKDOWN_MIME } from '../../lib/documents';
import type { DocumentSummary } from '../../lib/documents';
import { showDocx } from './docx-viewer';

async function forViewing(blob: Blob, mimeType: string): Promise<Blob> {
  if (mimeType !== 'text/plain' && mimeType !== MARKDOWN_MIME) return blob;
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  const hasBom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  return new Blob(hasBom ? [blob] : [new Uint8Array([0xef, 0xbb, 0xbf]), blob], { type: 'text/plain;charset=utf-8' });
}

export async function openOriginal(item: DocumentSummary, mode: 'view' | 'download'): Promise<void> {
  const viewer = mode === 'view' ? window.open('', '_blank') : null;
  if (viewer) viewer.opener = null;
  try {
    if (viewer && item.file.mimeType === DOCX_MIME) {
      await showDocx(viewer, item);
      return;
    }
    const { blob, fileName } = await documentsApi.original(item.id);
    const url = URL.createObjectURL(viewer ? await forViewing(blob, item.file.mimeType) : blob);
    if (viewer) {
      viewer.location.href = url;
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName ?? item.file.name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (failure) {
    viewer?.close();
    throw failure;
  }
}
