import { useEffect, useRef } from 'react';
import type { DocumentSummary } from '../../lib/documents';

interface Props {
  document: DocumentSummary;
  onClose: () => void;
}

export function SummaryDialog({ document, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return <dialog ref={dialog} className="summary-dialog" aria-labelledby="summary-dialog-title" onClose={onClose}
    onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
    <div className="summary-dialog-body">
      <header>
        <span className="auth-kicker">TÓM TẮT</span>
        <h2 id="summary-dialog-title">{document.title}</h2>
      </header>
      {document.summary
        ? <p className="summary-text">{document.summary}</p>
        : <p className="summary-empty">Tính năng tóm tắt đang được phát triển. Khi hoàn thiện, tóm tắt và các điều khoản đáng chú ý của tài liệu sẽ hiện ở đây.</p>}
      <div className="summary-dialog-actions">
        <button type="button" className="button-secondary" onClick={() => dialog.current?.close()} autoFocus>Đóng</button>
      </div>
    </div>
  </dialog>;
}
