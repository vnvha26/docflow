import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Brand';
import { ApiError, StaleSessionError } from '../../lib/api';
import { documentsApi, isProcessing } from '../../lib/documents';
import type { DocumentSummary } from '../../lib/documents';
import { openOriginal } from './original-file';

type Layer = 'original' | 'all';

interface Props {
  document: DocumentSummary;
  onChange: (next: DocumentSummary) => void;
  onRemove: () => void;
  onRename: () => void;
  onMove: () => void;
}

const LABELS: Record<Layer, { label: string; hint: string }> = {
  original: { label: 'Xóa bản gốc', hint: 'Bản gốc vào thùng rác; tên, thông tin và tóm tắt của tài liệu vẫn giữ.' },
  all: { label: 'Xóa', hint: 'Tài liệu vào thùng rác; khôi phục được trong 30 ngày.' },
};

export function DocumentOptions({ document, onChange, onRemove, onRename, onMove }: Props) {
  const [removing, setRemoving] = useState<Layer | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const available: Layer[] = [
    ...(document.originalAvailable && !isProcessing(document) ? ['original' as const] : []),
    'all',
  ];

  useEffect(() => {
    function close(event: Event) {
      const details = menu.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !details.contains(event.target as Node)) details.open = false;
    }
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, []);

  function toggled() {
    if (!menu.current?.open) { setError(''); return; }
    for (const other of window.document.querySelectorAll<HTMLDetailsElement>('details.document-menu[open]')) {
      if (other !== menu.current) other.open = false;
    }
  }

  function leave(action: () => void) {
    if (menu.current) menu.current.open = false;
    action();
  }

  async function download() {
    setDownloading(true); setError('');
    try {
      await openOriginal(document, 'download');
      if (menu.current) menu.current.open = false;
    } catch (failure) {
      if (!(failure instanceof StaleSessionError)) setError(failure instanceof Error ? failure.message : 'Chưa thể tải bản gốc.');
    } finally { setDownloading(false); }
  }

  async function remove(layer: Layer) {
    setRemoving(layer); setError('');
    try {
      if (layer === 'all') {
        await documentsApi.remove(document.id);
        onRemove();
        return;
      }
      const next = await documentsApi.deleteOriginal(document.id);
      if (menu.current) menu.current.open = false;
      onChange(next);
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      if (failure instanceof ApiError && failure.status === 404 && layer === 'all') { onRemove(); return; }
      setError(failure instanceof ApiError ? failure.message : 'Chưa thể xóa. Vui lòng thử lại.');
    } finally { setRemoving(null); }
  }

  return <details ref={menu} className="document-menu" onToggle={toggled}>
    <summary aria-label={`Tùy chọn cho ${document.title}`} title="Tùy chọn"><Icon name="more" size={18} /></summary>
    <div className="document-menu-body">
      <button type="button" className="text-button menu-item" onClick={() => leave(onRename)}>Đổi tên…</button>
      <button type="button" className="text-button menu-item" onClick={() => leave(onMove)}>Chuyển tới…</button>
      {document.originalAvailable && <button type="button" className="text-button menu-item" onClick={download} disabled={downloading}>
        {downloading ? 'Đang tải…' : 'Tải bản gốc'}
      </button>}
      {available.map((layer) => <button key={layer} type="button" className="text-button danger menu-item" title={LABELS[layer].hint}
        disabled={removing !== null} onClick={() => remove(layer)}>{removing === layer ? 'Đang xóa…' : LABELS[layer].label}</button>)}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  </details>;
}
