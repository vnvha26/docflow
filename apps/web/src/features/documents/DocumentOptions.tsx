import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Brand';
import { ApiError, StaleSessionError } from '../../lib/api';
import { documentsApi, isProcessing } from '../../lib/documents';
import type { DocumentSummary } from '../../lib/documents';
import { openOriginal } from './original-file';

type Layer = 'original' | 'details' | 'all';

interface Props {
  document: DocumentSummary;
  onChange: (next: DocumentSummary) => void;
  onRemove: () => void;
}

const LAYERS: Record<Layer, { label: string; action: string; lost: string; kept: string }> = {
  original: {
    label: 'Xóa bản gốc…', action: 'Xóa bản gốc',
    lost: 'Tệp gốc đã mã hóa. Sau này không xem hay tải lại được tệp này nữa.',
    kept: 'Dòng thông tin, tóm tắt, nội dung đã đọc, việc cần làm và nhắc hạn.',
  },
  details: {
    label: 'Xóa bản chi tiết…', action: 'Xóa bản chi tiết',
    lost: 'Tệp gốc, nội dung đã đọc và tóm tắt.',
    kept: 'Dòng thông tin (loại, ngày hết hạn, số tiền…), việc cần làm và nhắc hạn.',
  },
  all: {
    label: 'Xóa toàn bộ…', action: 'Xóa toàn bộ',
    lost: 'Cả tài liệu: tệp gốc, nội dung, tóm tắt, thông tin, việc cần làm và nhắc hạn của tài liệu này.',
    kept: 'Không còn gì. Tài liệu biến mất khỏi danh sách.',
  },
};

export function DocumentOptions({ document, onChange, onRemove }: Props) {
  const [pending, setPending] = useState<Layer | null>(null);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const available: Layer[] = [
    ...(document.originalAvailable && !isProcessing(document) ? ['original' as const] : []),
    ...(!document.detailsDeleted ? ['details' as const] : []),
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
    if (!menu.current?.open) { setPending(null); setError(''); return; }
    for (const other of window.document.querySelectorAll<HTMLDetailsElement>('details.document-menu[open]')) {
      if (other !== menu.current) other.open = false;
    }
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

  async function confirm(layer: Layer) {
    setSaving(true); setError('');
    try {
      if (layer === 'all') {
        await documentsApi.remove(document.id);
        onRemove();
        return;
      }
      const next = await (layer === 'original' ? documentsApi.deleteOriginal(document.id) : documentsApi.deleteDetails(document.id));
      onChange(next);
      setPending(null);
      if (menu.current) menu.current.open = false;
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      if (failure instanceof ApiError && failure.status === 404 && layer === 'all') { onRemove(); return; }
      setError(failure instanceof ApiError ? failure.message : 'Chưa thể xóa. Vui lòng thử lại.');
    } finally { setSaving(false); }
  }

  return <details ref={menu} className="document-menu" onToggle={toggled}>
    <summary aria-label={`Tùy chọn cho ${document.title}`} title="Tùy chọn"><Icon name="more" size={18} /></summary>
    <div className="document-menu-body">
      {pending
        ? <div className="menu-confirm">
          <strong>{LAYERS[pending].action}?</strong>
          <p><span>Mất vĩnh viễn:</span> {LAYERS[pending].lost}</p>
          <p><span>Còn lại:</span> {LAYERS[pending].kept}</p>
          <div className="menu-row">
            <button type="button" className="button-danger" disabled={saving} onClick={() => confirm(pending)}>{saving ? 'Đang xóa…' : LAYERS[pending].action}</button>
            <button type="button" className="text-button" disabled={saving} onClick={() => { setPending(null); setError(''); }}>Giữ lại</button>
          </div>
        </div>
        : <>
          {document.originalAvailable && <button type="button" className="text-button menu-item" onClick={download} disabled={downloading}>
            {downloading ? 'Đang tải…' : 'Tải bản gốc'}
          </button>}
          {available.map((layer) => <button key={layer} type="button" className="text-button danger menu-item"
          onClick={() => { setPending(layer); setError(''); }}>{LAYERS[layer].label}</button>)}
        </>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  </details>;
}
