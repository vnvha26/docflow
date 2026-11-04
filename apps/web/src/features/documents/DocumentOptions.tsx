import { useEffect, useRef, useState } from 'react';
import { ApiError, StaleSessionError } from '../../lib/api';
import { documentsApi, LEVEL_ORDER, lossesOf, privacyLabels } from '../../lib/documents';
import type { DocumentSummary, PrivacyLevel } from '../../lib/documents';

interface Props {
  document: DocumentSummary;
  accountLevel: PrivacyLevel;
  onChange: (next: DocumentSummary) => void;
}

export function DocumentOptions({ document, accountLevel, onChange }: Props) {
  const [choice, setChoice] = useState<PrivacyLevel | 'ACCOUNT'>(document.privacyOverride ?? 'ACCOUNT');
  const [pending, setPending] = useState<'level' | 'delete' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const target: PrivacyLevel = choice === 'ACCOUNT' ? accountLevel : choice;
  const losses = lossesOf(target, document.privacyLevel);
  const levelChanged = (document.privacyOverride ?? 'ACCOUNT') !== choice;
  const menu = useRef<HTMLDetailsElement>(null);

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

  async function run(action: () => Promise<DocumentSummary>) {
    setSaving(true); setError('');
    try {
      const next = await action();
      onChange(next);
      setPending(null);
      setChoice(next.privacyOverride ?? 'ACCOUNT');
      if (menu.current) menu.current.open = false;
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      setError(failure instanceof ApiError ? (failure.fieldErrors.privacyLevel || failure.message) : 'Chưa thể lưu thay đổi.');
    } finally { setSaving(false); }
  }

  return <details ref={menu} className="document-menu" onToggle={toggled}>
    <summary aria-label={`Tùy chọn cho ${document.title}`}>Tùy chọn</summary>
    <div className="document-menu-body">
      <label className="menu-label" htmlFor={`level-${document.id}`}>Mức lưu trữ của tài liệu</label>
      <select id={`level-${document.id}`} value={choice} disabled={saving} onChange={(event) => { setChoice(event.target.value as PrivacyLevel | 'ACCOUNT'); setPending(null); setError(''); }}>
        <option value="ACCOUNT">Theo tài khoản ({privacyLabels[accountLevel]})</option>
        {LEVEL_ORDER.filter((level) => LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(accountLevel)).map((level) =>
          <option key={level} value={level}>Mức {LEVEL_ORDER.indexOf(level) + 1} · {privacyLabels[level]}</option>)}
      </select>
      {pending === 'level' && <ul className="menu-losses">{losses.map((loss) => <li key={loss}>{loss}</li>)}</ul>}
      {levelChanged && (losses.length && pending !== 'level'
        ? <button type="button" className="button-secondary" onClick={() => setPending('level')} disabled={saving}>Áp dụng…</button>
        : <button type="button" className="button-secondary" disabled={saving}
          onClick={() => run(() => documentsApi.setLevel(document.id, choice === 'ACCOUNT' ? null : choice))}>
          {saving ? 'Đang lưu…' : losses.length ? 'Xác nhận và xóa' : 'Áp dụng'}
        </button>)}
      {document.originalAvailable && <div className="menu-danger">
        {pending === 'delete'
          ? <><p>Xóa bản gốc đã mã hóa? Tài liệu và thông tin đã trích xuất vẫn được giữ. Không thể hoàn tác.</p>
            <div className="menu-row">
              <button type="button" className="button-danger" disabled={saving} onClick={() => run(() => documentsApi.deleteOriginal(document.id))}>{saving ? 'Đang xóa…' : 'Xóa bản gốc'}</button>
              <button type="button" className="text-button" disabled={saving} onClick={() => setPending(null)}>Giữ lại</button>
            </div></>
          : <button type="button" className="text-button danger" onClick={() => { setPending('delete'); setError(''); }}>Xóa bản gốc…</button>}
      </div>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  </details>;
}
