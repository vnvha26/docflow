import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Brand';
import { ApiError, StaleSessionError } from '../../lib/api';
import type { User } from '../../lib/api';
import { documentsApi, formatBytes, MAX_UPLOAD_MB, precheck, privacyLabels } from '../../lib/documents';
import type { DocumentSummary, StorageUsage } from '../../lib/documents';
import { DocumentOptions } from './DocumentOptions';
import './documents.css';

interface UploadItem { key: string; name: string; state: 'waiting' | 'uploading' | 'done' | 'duplicate' | 'error'; message?: string }

const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });
const statusLabels: Record<DocumentSummary['status'], string> = {
  PENDING: 'Chờ xử lý', PROCESSING: 'Đang xử lý', SUCCEEDED: 'Đã xử lý', FAILED: 'Xử lý lỗi', UNSUPPORTED: 'Không đọc được',
};
const typeLabels: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'text/plain': 'TXT',
};
const viewable = (document: DocumentSummary) => document.file.mimeType === 'application/pdf' || document.file.mimeType === 'text/plain';
const failureMessage = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

async function forViewing(blob: Blob, mimeType: string): Promise<Blob> {
  if (mimeType !== 'text/plain') return blob;
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  const hasBom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  return new Blob(hasBom ? [blob] : [new Uint8Array([0xef, 0xbb, 0xbf]), blob], { type: 'text/plain;charset=utf-8' });
}

export function DocumentsPage({ user }: { user: User }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef(Promise.resolve());
  const currentUser = useRef(user.id);
  const name = user.displayName || user.email.split('@')[0];
  const level3 = user.privacyLevel === 'ENCRYPTED_COPY';

  const refreshUsage = useCallback(() => {
    documentsApi.usage().then(setUsage).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.title = 'Tài liệu | DocFlow';
    if (currentUser.current !== user.id) {
      currentUser.current = user.id;
      setUploads([]);
      setDocuments([]);
      setCursor(null);
      setUsage(null);
      setLoading(true);
    }
    let active = true;
    documentsApi.list().then((page) => {
      if (!active) return;
      setDocuments(page.items);
      setCursor(page.nextCursor);
    }).catch((failure: unknown) => {
      if (active && !(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể tải danh sách tài liệu.'));
    }).finally(() => { if (active) setLoading(false); });
    refreshUsage();
    return () => { active = false; };
  }, [user.id, refreshUsage]);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await documentsApi.list(cursor);
      setDocuments((previous) => [...previous, ...page.items.filter((item) => !previous.some((known) => known.id === item.id))]);
      setCursor(page.nextCursor);
    } catch (failure) {
      if (!(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể tải thêm tài liệu.'));
    } finally { setLoading(false); }
  }

  function update(key: string, patch: Partial<UploadItem>) {
    setUploads((previous) => previous.map((item) => item.key === key ? { ...item, ...patch } : item));
  }

  function enqueue(files: File[]) {
    const owner = user.id;
    const items = files.map((file) => ({ file, item: { key: crypto.randomUUID(), name: file.name, state: 'waiting' as const } }));
    setUploads((previous) => [...items.map(({ item }) => item), ...previous].slice(0, 20));
    for (const { file, item } of items) {
      queue.current = queue.current.then(async () => {
        if (currentUser.current !== owner) return update(item.key, { state: 'error', message: 'Đã đổi tài khoản; tệp này không được tải lên.' });
        const problem = precheck(file);
        if (problem) return update(item.key, { state: 'error', message: problem });
        update(item.key, { state: 'uploading' });
        try {
          const result = await documentsApi.upload(file, owner);
          if (currentUser.current !== owner) return;
          setDocuments((previous) => [result.document, ...previous.filter((known) => known.id !== result.document.id)]);
          update(item.key, result.duplicate
            ? { state: 'duplicate', message: `Đã có sẵn: “${result.document.title}”. Không lưu thêm bản mới.` }
            : { state: 'done', message: result.document.originalAvailable ? 'Đã lưu, kèm bản gốc mã hóa.' : 'Đã lưu.' });
          if (!result.duplicate && result.document.originalAvailable) refreshUsage();
        } catch (failure) {
          if (failure instanceof StaleSessionError) return update(item.key, { state: 'error', message: 'Phiên đã thay đổi; tệp này không được tải lên.' });
          const message = failure instanceof ApiError ? (failure.fieldErrors.file || failure.message) : 'Chưa thể tải lên. Vui lòng thử lại.';
          update(item.key, { state: 'error', message });
        }
      });
    }
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    enqueue(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    enqueue(Array.from(event.dataTransfer.files));
  }

  async function open(item: DocumentSummary, mode: 'view' | 'download') {
    setError(''); setBusyId(item.id);
    const viewer = mode === 'view' ? window.open('', '_blank') : null;
    try {
      const { blob, fileName } = await documentsApi.original(item.id);
      const url = URL.createObjectURL(viewer ? await forViewing(blob, item.file.mimeType) : blob);
      if (viewer) {
        viewer.opener = null;
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
      if (!(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể tải bản gốc.'));
    } finally { setBusyId(null); }
  }

  return <>
    <section className="documents-hero">
      <div>
        <span className="eyebrow"><span /> KHÔNG GIAN TÀI LIỆU</span>
        <h1>Chào {name}<span>.</span></h1>
        <p>Tải lên hợp đồng, hóa đơn và giấy tờ quan trọng. DocFlow sẽ giúp bạn nhớ những ngày cần nhớ.</p>
      </div>
      <div className="privacy-chip">
        <Icon name="shield" size={18} />
        <div><span>Mức lưu trữ</span><strong>{privacyLabels[user.privacyLevel]}</strong><Link to="/account#privacy">Thay đổi</Link></div>
      </div>
    </section>

    <section className="profile-card upload-card" aria-labelledby="upload-title">
      <div className="profile-heading"><div><span className="auth-kicker">TẢI LÊN</span><h2 id="upload-title">Thêm tài liệu</h2></div><span className="profile-icon"><Icon name="upload" size={24} /></span></div>
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <Icon name="file" size={30} />
        <p><strong>Kéo thả tệp vào đây</strong> hoặc <button type="button" className="text-button" onClick={() => input.current?.click()}>chọn từ máy</button></p>
        <span>PDF có lớp chữ, DOCX hoặc TXT (UTF-8) · tối đa {MAX_UPLOAD_MB} MB mỗi tệp</span>
        <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={choose} />
      </div>
      <p className="upload-note">
        {level3
          ? <>Bản gốc được <strong>mã hóa</strong> và giữ lại để bạn tải về từ máy khác.{usage && <> Đã dùng {formatBytes(usage.encryptedBytes)} / {formatBytes(usage.quotaBytes)}.</>}</>
          : <>Ở mức này, bản gốc chỉ được giữ tạm (đã mã hóa) để xử lý rồi xóa. Muốn tải lại bản gốc từ máy khác, chọn mức “Bản gốc được mã hóa”.</>}
      </p>
      {level3 && usage && <div className="usage-bar" role="meter" aria-label="Dung lượng bản gốc" aria-valuemin={0} aria-valuemax={usage.quotaBytes} aria-valuenow={usage.encryptedBytes}><span style={{ width: `${Math.min(100, (usage.encryptedBytes / usage.quotaBytes) * 100)}%` }} /></div>}
      {uploads.length > 0 && <ul className="upload-list" aria-live="polite">
        {uploads.map((item) => <li key={item.key} className={`upload-${item.state}`}>
          <span className="upload-name">{item.name}</span>
          <span className="upload-state">{item.state === 'waiting' ? 'Đang chờ…' : item.state === 'uploading' ? <><span className="spinner spinner-small" />Đang tải lên…</> : item.message}</span>
        </li>)}
      </ul>}
    </section>

    <section className="profile-card documents-card" aria-labelledby="documents-title">
      <div className="profile-heading"><div><span className="auth-kicker">THƯ VIỆN</span><h2 id="documents-title">Tài liệu của bạn</h2></div><span className="profile-icon"><Icon name="folder" size={24} /></span></div>
      {error && <div className="form-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      {!loading && !documents.length && !error && <p className="session-note">Chưa có tài liệu nào. Hãy tải lên tài liệu đầu tiên ở trên.</p>}
      <ul className="document-list" aria-busy={loading}>
        {documents.map((item) => <li key={item.id}>
          <span className="document-type">{typeLabels[item.file.mimeType] ?? 'TỆP'}</span>
          <div className="document-info">
            <strong>{item.title}</strong>
            <p>{item.file.name} · {formatBytes(item.file.byteSize)} · <time dateTime={item.createdAt}>{dateFormat.format(new Date(item.createdAt))}</time></p>
            <div className="document-tags">
              <span className="tag">{statusLabels[item.status]}</span>
              {item.originalAvailable && <span className="tag tag-secure"><Icon name="lock" size={12} />Bản gốc mã hóa</span>}
              {item.originalDeleting && <span className="tag">Đang xóa bản gốc…</span>}
              {item.privacyOverride && <span className="tag">Mức riêng: {privacyLabels[item.privacyLevel]}</span>}
            </div>
          </div>
          <div className="document-actions">
            {item.originalAvailable && viewable(item) && <button type="button" className="button-secondary" onClick={() => open(item, 'view')} disabled={busyId !== null}><Icon name="eye" size={15} />Xem</button>}
            {item.originalAvailable && <button type="button" className="button-secondary" onClick={() => open(item, 'download')} disabled={busyId !== null}>{busyId === item.id ? 'Đang tải…' : <><Icon name="download" size={15} />Tải bản gốc</>}</button>}
            <DocumentOptions document={item} accountLevel={user.privacyLevel}
              onChange={(next) => { setDocuments((previous) => previous.map((known) => known.id === next.id ? next : known)); refreshUsage(); }} />
          </div>
        </li>)}
      </ul>
      <div className="profile-bottom">
        <p role="status">{loading ? 'Đang tải danh sách…' : `${documents.length} tài liệu`}</p>
        {cursor && <button type="button" className="button-secondary" onClick={loadMore} disabled={loading}>Tải thêm</button>}
      </div>
    </section>
  </>;
}
