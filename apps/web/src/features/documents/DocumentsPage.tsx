import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Icon } from '../../components/Brand';
import { ApiError, StaleSessionError } from '../../lib/api';
import type { User } from '../../lib/api';
import {
  canViewOriginal, documentsApi, fileTypeLabel, formatBytes, infoLine, isChanging, isProcessing, matchesFilters, MAX_UPLOAD_MB, precheck, problemMessage,
  statusFilterLabels, typeFilterLabels,
} from '../../lib/documents';
import type { DocumentFilters, DocumentStatusFilter, DocumentTypeFilter } from '../../lib/documents';
import type { DocumentSummary, StorageUsage } from '../../lib/documents';
import { DocumentOptions } from './DocumentOptions';
import { openOriginal } from './original-file';
import { SummaryDialog } from './SummaryDialog';
import { summarizeUploads } from '../../lib/upload-summary';
import type { UploadItem } from '../../lib/upload-summary';
import './documents.css';


const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'full', timeStyle: 'short' });
const timeOnly = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });
const pad = (value: number) => String(value).padStart(2, '0');

function shortDate(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `Hôm nay ${timeOnly.format(date)}`;
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  if (date.getFullYear() === now.getFullYear()) return `${day} ${timeOnly.format(date)}`;
  return `${day}/${date.getFullYear()}`;
}

function statusTone(item: DocumentSummary): 'done' | 'waiting' | 'problem' | 'muted' {
  if (item.detailsDeleted) return 'muted';
  if (isProcessing(item)) return 'waiting';
  return item.status === 'SUCCEEDED' ? 'done' : 'problem';
}

const POLL_FIRST_MS = 2_000;
const POLL_MAX_MS = 10_000;
const POLL_BATCH = 20;
const POLL_PARALLEL = 4;
const POLL_STOP_MS = 15 * 60_000;
const failureMessage = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

async function inGroups<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) results.push(...await Promise.all(items.slice(start, start + size).map(run)));
  return results;
}

export function DocumentsPage({ user }: { user: User }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [summaryOf, setSummaryOf] = useState<DocumentSummary | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [filters, setFilters] = useState<DocumentFilters>({});
  const currentFilters = useRef(filters);
  currentFilters.current = filters;
  const listRun = useRef(0);
  const filtered = Boolean(filters.type || filters.status);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef(Promise.resolve());
  const currentUser = useRef(user.id);
  const name = user.displayName || user.email.split('@')[0];

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
      setFilters({});
    }
    refreshUsage();
  }, [user.id, refreshUsage]);

  useEffect(() => {
    let active = true;
    listRun.current++;
    setLoading(true);
    setError('');
    documentsApi.list(undefined, { type: filters.type, status: filters.status }).then((page) => {
      if (!active) return;
      setDocuments(page.items);
      setCursor(page.nextCursor);
    }).catch((failure: unknown) => {
      if (!active) return;
      setDocuments([]);
      setCursor(null);
      if (!(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể tải danh sách tài liệu.'));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user.id, filters.type, filters.status]);

  const changingIds = documents.filter(isChanging).slice(0, POLL_BATCH).map((item) => item.id).join(',');

  useEffect(() => {
    if (!changingIds) return;
    const ids = changingIds.split(',');
    let active = true;
    let wait = POLL_FIRST_MS;
    const stopAt = Date.now() + POLL_STOP_MS;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const fresh = await inGroups(ids, POLL_PARALLEL, (id) => documentsApi.get(id).catch((failure: unknown) =>
        failure instanceof ApiError && failure.status === 404 ? 'gone' as const : null));
      if (!active) return;
      setDocuments((previous) => previous.flatMap((known) => {
        const next = fresh[ids.indexOf(known.id)];
        if (next === 'gone') return [];
        return [next ?? known];
      }));
      wait = Math.min(Math.round(wait * 1.5), POLL_MAX_MS);
      if (Date.now() < stopAt) timer = setTimeout(poll, wait);
    };
    timer = setTimeout(poll, wait);
    return () => { active = false; clearTimeout(timer); };
  }, [changingIds]);

  async function loadMore() {
    if (!cursor) return;
    const run = listRun.current;
    setLoading(true);
    try {
      const page = await documentsApi.list(cursor, currentFilters.current);
      if (run !== listRun.current) return;
      setDocuments((previous) => [...previous, ...page.items.filter((item) => !previous.some((known) => known.id === item.id))]);
      setCursor(page.nextCursor);
    } catch (failure) {
      if (run === listRun.current && !(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể tải thêm tài liệu.'));
    } finally { if (run === listRun.current) setLoading(false); }
  }

  function update(key: string, patch: Partial<UploadItem>) {
    setUploads((previous) => previous.map((item) => item.key === key ? { ...item, ...patch } : item));
  }

  function enqueue(files: File[]) {
    const owner = user.id;
    const items = files.map((file) => ({ file, item: { key: crypto.randomUUID(), name: file.name, state: 'waiting' as const } }));
    setUploads((previous) => {
      const running = previous.some((known) => known.state === 'waiting' || known.state === 'uploading');
      return [...(running ? previous : []), ...items.map(({ item }) => item)];
    });
    for (const { file, item } of items) {
      queue.current = queue.current.then(async () => {
        if (currentUser.current !== owner) return update(item.key, { state: 'error', message: 'Đã đổi tài khoản; tệp này không được tải lên.' });
        const problem = precheck(file);
        if (problem) return update(item.key, { state: 'error', message: problem });
        update(item.key, { state: 'uploading' });
        try {
          const result = await documentsApi.upload(file, owner);
          if (currentUser.current !== owner) return;
          if (matchesFilters(result.document, currentFilters.current)) {
            setDocuments((previous) => [result.document, ...previous.filter((known) => known.id !== result.document.id)]);
          }
          update(item.key, { state: result.duplicate ? 'duplicate' : 'done' });
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

  async function view(item: DocumentSummary) {
    setError(''); setViewing(item.id);
    try { await openOriginal(item, 'view'); }
    catch (failure) { if (!(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể mở tài liệu.')); }
    finally { setViewing(null); }
  }

  const uploadSummary = summarizeUploads(uploads);
  const usagePercent = usage ? Math.min(100, (usage.encryptedBytes / usage.quotaBytes) * 100) : 0;

  return <>
    <section className="documents-hero">
      <div className="hero-copy">
        <span className="eyebrow"><span /> KHÔNG GIAN TÀI LIỆU</span>
        <h1>Chào {name}<span>.</span></h1>
        <p>Tải lên hợp đồng, hóa đơn và giấy tờ quan trọng. DocFlow sẽ giúp bạn nhớ những ngày cần nhớ.</p>
      </div>
      {usage && <div className="hero-storage">
        <span className="hero-storage-icon"><Icon name="lock" size={18} /></span>
        <div>
          <span className="hero-storage-label">Bản gốc đã mã hóa</span>
          <strong>{formatBytes(usage.encryptedBytes)} <small>/ {formatBytes(usage.quotaBytes)}</small></strong>
          <div className="usage-bar" role="meter" aria-label="Dung lượng bản gốc" aria-valuemin={0} aria-valuemax={usage.quotaBytes} aria-valuenow={usage.encryptedBytes}>
            <span style={{ width: `${Math.max(usagePercent, usage.encryptedBytes > 0 ? 2 : 0)}%` }} />
          </div>
        </div>
      </div>}
    </section>

    <section className="profile-card upload-card" aria-labelledby="upload-title">
      <div className="profile-heading"><div><span className="auth-kicker">TẢI LÊN</span><h2 id="upload-title">Thêm tài liệu</h2></div><span className="profile-icon"><Icon name="upload" size={24} /></span></div>
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onClick={(event) => { if (event.target === event.currentTarget || !(event.target as HTMLElement).closest('button')) input.current?.click(); }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <span className="dropzone-icon"><Icon name="upload" size={22} /></span>
        <p><strong>Kéo thả tệp vào đây</strong> hoặc <button type="button" className="text-button" onClick={() => input.current?.click()}>chọn từ máy</button></p>
        <span className="dropzone-hint">PDF có lớp chữ, DOCX hoặc TXT (UTF-8) · tối đa {MAX_UPLOAD_MB} MB mỗi tệp</span>
        <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={choose} />
      </div>
      <p className="upload-note"><Icon name="shield" size={14} />Tệp được mã hóa trước khi lưu; chỉ bạn mở được.</p>
      {uploadSummary && <div className={`upload-summary tone-${uploadSummary.tone}`} role="status" aria-live="polite">
        {uploadSummary.tone === 'busy' ? <span className="spinner spinner-small" /> : <span className="upload-summary-icon" aria-hidden="true">{uploadSummary.tone === 'done' ? '✓' : '!'}</span>}
        <div>
          <p>{uploadSummary.text}</p>
          {uploadSummary.details.length > 0 && <ul>{uploadSummary.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
        </div>
      </div>}
    </section>

    <section className="profile-card documents-card" aria-labelledby="documents-title">
      <div className="profile-heading"><div><span className="auth-kicker">THƯ VIỆN</span><h2 id="documents-title">Tài liệu của bạn</h2></div><span className="profile-icon"><Icon name="folder" size={24} /></span></div>
      {error && <div className="form-alert documents-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      {(documents.length > 0 || filtered) && <div className="document-filters" role="group" aria-label="Lọc tài liệu">
        <div className="filter-chips">
          {([undefined, 'pdf', 'docx', 'txt'] as (DocumentTypeFilter | undefined)[]).map((type) =>
            <button key={type ?? 'all'} type="button" className="filter-chip" aria-pressed={filters.type === type}
              onClick={() => setFilters((current) => ({ ...current, type }))}>{type ? typeFilterLabels[type] : 'Tất cả'}</button>)}
        </div>
        <select className="filter-select" aria-label="Lọc theo trạng thái" value={filters.status ?? ''}
          onChange={(event) => setFilters((current) => ({ ...current, status: (event.target.value || undefined) as DocumentStatusFilter | undefined }))}>
          <option value="">Mọi trạng thái</option>
          {(Object.keys(statusFilterLabels) as DocumentStatusFilter[]).map((status) => <option key={status} value={status}>{statusFilterLabels[status]}</option>)}
        </select>
      </div>}
      {!loading && !documents.length && !error && (filtered
        ? <div className="documents-empty">
          <span><Icon name="folder" size={26} /></span>
          <strong>Không có tài liệu khớp bộ lọc</strong>
          <p>Thử chọn loại tệp hoặc trạng thái khác.</p>
          <button type="button" className="button-secondary" onClick={() => setFilters({})}>Bỏ lọc</button>
        </div>
        : <div className="documents-empty">
          <span><Icon name="folder" size={26} /></span>
          <strong>Chưa có tài liệu nào</strong>
          <p>Kéo thả hợp đồng, hóa đơn hay giấy bảo hành vào ô phía trên để bắt đầu.</p>
        </div>)}
      <ul className="document-list" aria-busy={loading}>
        {documents.length > 0 && <li className="document-columns" aria-hidden="true"><span /><span>Tài liệu</span><span>Cập nhật</span><span /></li>}
        {documents.map((item) => <li key={item.id} className="document-row">
          <span className={`document-type type-${fileTypeLabel(item).toLowerCase()}`}>{fileTypeLabel(item)}</span>
          <div className="document-info">
            <strong className="document-title">{item.title}</strong>
            <p className={`document-line tone-${statusTone(item)}`}>
              {isProcessing(item) ? <span className="spinner spinner-tiny" /> : <span className="status-dot" aria-hidden="true" />}
              {infoLine(item)}{item.originalDeleting && ' · Đang xóa bản gốc…'}
            </p>
            {problemMessage(item) && <p className="document-problem">{problemMessage(item)}</p>}
          </div>
          <p className="document-updated">
            <span>Cập nhật </span><time dateTime={item.updatedAt} title={dateFormat.format(new Date(item.updatedAt))}>{shortDate(item.updatedAt)}</time>
          </p>
          <div className="document-actions">
            <button type="button" className="action-button" onClick={() => setSummaryOf(item)}>
              <Icon name="summary" size={15} />Xem tóm tắt
            </button>
            <button type="button" className="action-button action-primary" onClick={() => view(item)} disabled={!canViewOriginal(item) || viewing !== null}
              title={canViewOriginal(item) ? undefined : 'Bản gốc không còn lưu nên không xem được.'}>
              <Icon name="eye" size={15} />{viewing === item.id ? 'Đang mở…' : 'Xem chi tiết'}
            </button>
            <DocumentOptions document={item}
              onChange={(next) => { setDocuments((previous) => previous.map((known) => known.id === next.id ? next : known)); refreshUsage(); }}
              onRemove={() => { setDocuments((previous) => previous.filter((known) => known.id !== item.id)); refreshUsage(); }} />
          </div>
        </li>)}
      </ul>
      {summaryOf && <SummaryDialog document={summaryOf} onClose={() => setSummaryOf(null)} />}
      {(loading || documents.length > 0 || cursor) && <div className="profile-bottom">
        <p role="status">{loading ? 'Đang tải danh sách…' : `${documents.length}${cursor ? '+' : ''} tài liệu${filtered ? ' khớp bộ lọc' : ''}`}</p>
        {cursor && <button type="button" className="button-secondary" onClick={loadMore} disabled={loading}>Tải thêm</button>}
      </div>}
    </section>
  </>;
}
