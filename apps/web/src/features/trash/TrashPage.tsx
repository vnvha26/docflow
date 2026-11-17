import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Brand';
import { ApiError, StaleSessionError } from '../../lib/api';
import type { User } from '../../lib/api';
import { contentsLabel, entryTitle, kindLabels, locationLabel, remainingLabel, restoreMessage, TRASH_DAYS, trashApi } from '../../lib/trash';
import type { TrashEntry } from '../../lib/trash';
import { ConfirmDialog } from '../documents/FolderDialogs';
import '../documents/documents.css';
import './trash.css';

const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });
const failureMessage = (failure: unknown, fallback: string) => failure instanceof ApiError ? failure.message : fallback;
const icons = { DOCUMENT: 'file', FOLDER: 'folder', ORIGINAL: 'lock' } as const;

type Confirm = { kind: 'purge'; entry: TrashEntry } | { kind: 'empty' };

export function TrashPage({ user }: { user: User }) {
  const [items, setItems] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const run = useRef(0);

  const load = useCallback(() => {
    const current = ++run.current;
    setLoading(true);
    trashApi.list().then((next) => {
      if (current === run.current) setItems(next);
    }).catch((failure: unknown) => {
      if (current === run.current && !(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể tải thùng rác.'));
    }).finally(() => { if (current === run.current) setLoading(false); });
  }, []);

  useEffect(() => {
    document.title = 'Thùng rác | DocFlow';
    setItems([]);
    setNotice('');
    setError('');
    load();
  }, [user.id, load]);

  async function restore(entry: TrashEntry) {
    setBusy(entry.id); setError(''); setNotice('');
    try {
      const result = await trashApi.restore(entry.id, user.id);
      setNotice(restoreMessage(result));
      load();
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      setError(failureMessage(failure, 'Chưa thể khôi phục. Vui lòng thử lại.'));
      if (failure instanceof ApiError && failure.status === 404) load();
    } finally { setBusy(null); }
  }

  async function purge(entry: TrashEntry) {
    setError(''); setNotice('');
    try {
      await trashApi.purge(entry.id, user.id);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
    }
    setNotice(`Đã xóa vĩnh viễn ${entry.kind === 'ORIGINAL' ? 'bản gốc của ' : ''}“${entry.name}”.`);
    load();
  }

  async function empty() {
    setError(''); setNotice('');
    await trashApi.empty(user.id);
    setNotice('Đã dọn sạch thùng rác.');
    load();
  }

  return <section className="profile-card documents-card trash-card" aria-labelledby="trash-title">
    <div className="profile-heading">
      <div><span className="auth-kicker">THÙNG RÁC</span><h2 id="trash-title">Mục đã xóa</h2></div>
      <span className="profile-icon"><Icon name="trash" size={24} /></span>
    </div>
    <div className="trash-bar">
      <p>Mục đã xóa được giữ {TRASH_DAYS} ngày rồi tự xóa vĩnh viễn.</p>
      <button type="button" className="action-button bulk-danger" disabled={!items.length} onClick={() => setConfirm({ kind: 'empty' })}>Dọn sạch thùng rác…</button>
    </div>
    {notice && <div className="upload-summary tone-done library-notice" role="status"><span className="upload-summary-icon" aria-hidden="true">✓</span><div><p>{notice}</p></div></div>}
    {error && <div className="form-alert documents-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
    {!loading && !items.length && !error && <div className="documents-empty">
      <span><Icon name="trash" size={26} /></span>
      <strong>Thùng rác trống</strong>
      <p>Tài liệu, thư mục và bản gốc bạn xóa sẽ nằm ở đây {TRASH_DAYS} ngày.</p>
      <Link className="button-secondary" to="/">Về thư viện</Link>
    </div>}
    <ul className="trash-list" aria-busy={loading}>
      {items.map((entry) => <li key={entry.id} className="trash-row">
        <span className={`trash-kind kind-${entry.kind.toLowerCase()}`}><Icon name={icons[entry.kind]} size={18} /></span>
        <div className="trash-info">
          <strong>{entryTitle(entry)}</strong>
          <p>{kindLabels[entry.kind]}{contentsLabel(entry) ? ` · ${contentsLabel(entry)}` : ''} · Vị trí cũ: {locationLabel(entry)}</p>
          <p>Xóa lúc <time dateTime={entry.deletedAt}>{dateFormat.format(new Date(entry.deletedAt))}</time> · <span className="trash-left">{remainingLabel(entry)}</span></p>
        </div>
        <div className="document-actions">
          <button type="button" className="action-button action-primary" disabled={busy !== null} onClick={() => restore(entry)}>{busy === entry.id ? 'Đang khôi phục…' : 'Khôi phục'}</button>
          <button type="button" className="action-button bulk-danger" disabled={busy !== null} onClick={() => setConfirm({ kind: 'purge', entry })}>Xóa vĩnh viễn…</button>
        </div>
      </li>)}
    </ul>
    {(loading || items.length > 0) && <div className="profile-bottom"><p role="status">{loading ? 'Đang tải thùng rác…' : `${items.length} mục`}</p></div>}
    {confirm?.kind === 'purge' && <ConfirmDialog kicker="XÓA VĨNH VIỄN" title={`Xóa vĩnh viễn ${entryTitle(confirm.entry)}?`} label="Xóa vĩnh viễn"
      onSubmit={() => purge(confirm.entry)} onClose={() => setConfirm(null)}>
      <p className="dialog-note danger"><strong>Không khôi phục được.</strong> {confirm.entry.kind === 'ORIGINAL'
        ? 'Tệp gốc và nội dung chữ đầy đủ sẽ mất; tên, thông tin trích xuất và tóm tắt của tài liệu vẫn còn.'
        : confirm.entry.kind === 'FOLDER'
          ? 'Thư mục cùng mọi thư mục con và tài liệu bên trong sẽ bị xóa hẳn: tệp gốc, nội dung, tóm tắt, thông tin, việc cần làm và nhắc hạn.'
          : 'Tệp gốc, nội dung, tóm tắt, thông tin, việc cần làm và nhắc hạn của tài liệu này sẽ bị xóa hẳn.'}</p>
    </ConfirmDialog>}
    {confirm?.kind === 'empty' && <ConfirmDialog kicker="DỌN SẠCH" title={`Xóa vĩnh viễn ${items.length} mục trong thùng rác?`} label="Dọn sạch thùng rác"
      onSubmit={empty} onClose={() => setConfirm(null)}>
      <p className="dialog-note danger"><strong>Không khôi phục được.</strong> Mọi tài liệu, thư mục và bản gốc trong thùng rác sẽ bị xóa hẳn.</p>
    </ConfirmDialog>}
  </section>;
}
