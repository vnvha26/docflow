import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../../components/Brand';
import { ApiError, StaleSessionError } from '../../lib/api';
import type { User } from '../../lib/api';
import {
  canViewOriginal, documentsApi, fileTypeLabel, formatBytes, infoLine, isChanging, isProcessing, matchesFilters, MAX_UPLOAD_MB, precheck, problemMessage,
  sortLabels, typeFilterLabels,
} from '../../lib/documents';
import type { DocumentFilters, DocumentSort, DocumentSummary, DocumentTypeFilter, StorageUsage, UploadDecision, UploadResult } from '../../lib/documents';
import { sha256Hex } from '../../lib/duplicates';
import type { DuplicateCheck, DuplicateChoice } from '../../lib/duplicates';
import { canCreateIn, childrenOf, foldersApi, MAX_FOLDER_DEPTH, moveProblem, pathLabel, pathOf, UNFILED } from '../../lib/folders';
import type { Folder, FolderTree } from '../../lib/folders';
import { folderContents, trashApi, undoTargets } from '../../lib/trash';
import type { Undo } from '../../lib/trash';
import { isRunning, summarizeUploads } from '../../lib/upload-summary';
import type { UploadItem } from '../../lib/upload-summary';
import { DocumentOptions } from './DocumentOptions';
import { DuplicateDialog } from './DuplicateDialog';
import type { DuplicateQuestion } from './DuplicateDialog';
import { FolderFormDialog, MoveDialog, RenameDialog } from './FolderDialogs';
import { ActionMenu } from './ActionMenu';
import { ALL, DOCUMENT_DRAG, FolderPane, hasFiles } from './FolderPane';
import type { FolderAction } from './FolderPane';
import { openOriginal } from './original-file';
import { SummaryDialog } from './SummaryDialog';
import { useMarquee } from './useMarquee';
import './documents.css';

const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'full', timeStyle: 'short' });
const timeOnly = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });
const pad = (value: number) => String(value).padStart(2, '0');
const FOLDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNFILED_LABEL = 'Chưa phân loại';

function shortDate(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `Hôm nay ${timeOnly.format(date)}`;
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  if (date.getFullYear() === now.getFullYear()) return `${day} ${timeOnly.format(date)}`;
  return `${day}/${date.getFullYear()}`;
}

function statusTone(item: DocumentSummary): 'done' | 'waiting' | 'problem' {
  if (isProcessing(item)) return 'waiting';
  return item.status === 'SUCCEEDED' ? 'done' : 'problem';
}

type Dialog =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'edit'; folder: Folder }
  | { kind: 'move-folder'; folder: Folder }
  | { kind: 'rename'; document: DocumentSummary }
  | { kind: 'move-document'; document: DocumentSummary }
  | { kind: 'move-many'; ids: string[] };

interface Pending { key: string; fileName: string; file: File; folderId: string | null }
type Question = Pending & DuplicateQuestion;

const NOTICE_MS = 7_000;
const NOTICE_UNDO_MS = 12_000;
const POLL_FIRST_MS = 2_000;
const POLL_MAX_MS = 10_000;
const POLL_BATCH = 20;
const POLL_PARALLEL = 4;
const POLL_STOP_MS = 15 * 60_000;
const failureMessage = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
const quoted = (name: string) => `“${name}”`;

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
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<Undo | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [reload, setReload] = useState(0);
  const [over, setOver] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [dragging, setDragging] = useState(false);
  const [summaryOf, setSummaryOf] = useState<DocumentSummary | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [drag, setDrag] = useState<{ kind: 'document' | 'folder'; ids: string[] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [sort, setSort] = useState<DocumentSort>('created');
  const [tree, setTree] = useState<FolderTree | null>(null);
  const [fileType, setFileType] = useState<DocumentTypeFilter | undefined>(undefined);
  const [params, setParams] = useSearchParams();
  const requested = params.get('folder');
  const view = requested === UNFILED || (requested && FOLDER_ID.test(requested)) ? requested.toLowerCase() : ALL;
  const folders = tree?.folders ?? [];
  const openFolder = view === ALL || view === UNFILED ? null : folders.find((folder) => folder.id === view) ?? null;
  const uploadFolderId = openFolder?.id ?? null;
  const filters: DocumentFilters = { type: fileType, folder: view === ALL ? undefined : view, sort };
  const currentFilters = useRef(filters);
  currentFilters.current = filters;
  const listRun = useRef(0);
  const filtered = Boolean(fileType);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef(Promise.resolve());
  const currentUser = useRef(user.id);
  const name = user.displayName || user.email.split('@')[0];

  const select = useCallback((next: string) => {
    setNotice('');
    setUndo(null);
    setParams(next === ALL ? {} : { folder: next });
  }, [setParams]);

  const refreshUsage = useCallback(() => {
    documentsApi.usage().then(setUsage).catch(() => undefined);
  }, []);

  const refreshTree = useCallback(() => {
    const owner = user.id;
    foldersApi.tree().then((next) => { if (currentUser.current === owner) setTree(next); }).catch(() => undefined);
  }, [user.id]);

  useEffect(() => {
    document.title = 'Tài liệu | DocFlow';
    if (currentUser.current !== user.id) {
      currentUser.current = user.id;
      setUploads([]);
      setQuestions([]);
      setDocuments([]);
      setCursor(null);
      setUsage(null);
      setTree(null);
      setFileType(undefined);
      setSort('created');
      setDialog(null);
      setNotice('');
    }
    refreshUsage();
    refreshTree();
  }, [user.id, refreshUsage, refreshTree]);

  useEffect(() => {
    if (tree && view !== ALL && view !== UNFILED && !tree.folders.some((folder) => folder.id === view)) setParams({}, { replace: true });
  }, [tree, view, setParams]);

  useEffect(() => {
    let active = true;
    listRun.current++;
    setLoading(true);
    setError('');
    setSelected([]);
    documentsApi.list(undefined, { type: fileType, folder: view === ALL ? undefined : view, sort }).then((page) => {
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
  }, [user.id, fileType, view, sort, reload]);

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

  function settle(key: string, result: UploadResult) {
    if (matchesFilters(result.document, currentFilters.current)) {
      setDocuments((previous) => result.supplemented && previous.some((known) => known.id === result.document.id)
        ? previous.map((known) => known.id === result.document.id ? result.document : known)
        : [result.document, ...previous.filter((known) => known.id !== result.document.id)]);
    }
    update(key, result.supplemented
      ? { state: 'supplemented', target: result.document.title }
      : { state: 'done', savedAs: result.renamed ? result.document.title : undefined });
    refreshTree();
    if (result.document.originalAvailable) refreshUsage();
  }

  function fail(key: string, failure: unknown) {
    if (failure instanceof StaleSessionError) return update(key, { state: 'error', message: 'Phiên đã thay đổi; tệp này không được tải lên.' });
    const fields = failure instanceof ApiError ? failure.fieldErrors : {};
    update(key, { state: 'error', message: failure instanceof ApiError ? (fields.file || fields.folderId || fields.targetId || failure.message) : 'Chưa thể tải lên. Vui lòng thử lại.' });
    if (fields.folderId) refreshTree();
  }

  function ask(pending: Pending, check: DuplicateCheck) {
    update(pending.key, { state: 'asking' });
    setQuestions((previous) => [...previous.filter((known) => known.key !== pending.key), { ...pending, check }]);
  }

  function send(pending: Pending, decision?: UploadDecision) {
    const owner = user.id;
    queue.current = queue.current.then(async () => {
      if (currentUser.current !== owner) return update(pending.key, { state: 'error', message: 'Đã đổi tài khoản; tệp này không được tải lên.' });
      const problem = precheck(pending.file);
      if (problem) return update(pending.key, { state: 'error', message: problem });
      update(pending.key, { state: 'uploading' });
      try {
        if (!decision) {
          const check = await sha256Hex(pending.file)
            .then((hash) => documentsApi.check(hash, pending.file.size, pending.folderId, owner))
            .catch((failure: unknown) => { if (failure instanceof StaleSessionError) throw failure; return null; });
          if (currentUser.current !== owner) return;
          if (check?.situation === 'ask') return ask(pending, check);
        }
        const result = await documentsApi.upload(pending.file, owner, pending.folderId, decision);
        if (currentUser.current !== owner) return;
        if (result.duplicate && result.conflict?.situation === 'ask') return ask(pending, result.conflict);
        if (result.duplicate) return update(pending.key, { state: 'duplicate' });
        settle(pending.key, result);
      } catch (failure) {
        fail(pending.key, failure);
      }
    });
  }

  function enqueue(files: File[], folderId: string | null = uploadFolderId) {
    if (!files.length) return;
    setNotice('');
    setUndo(null);
    const items = files.map((file) => ({ key: crypto.randomUUID(), fileName: file.name, file, folderId }));
    setUploads((previous) => [...(previous.some((known) => isRunning(known) || known.state === 'asking') ? previous : []),
      ...items.map((item) => ({ key: item.key, name: item.fileName, state: 'waiting' as const }))]);
    for (const item of items) send(item);
  }

  function answer(choices: Record<string, DuplicateChoice>) {
    const owner = user.id;
    const answered = questions;
    setQuestions([]);
    for (const question of answered) {
      const choice = choices[question.key] ?? 'skip';
      const primary = question.check.primary;
      if (choice === 'new') { update(question.key, { state: 'waiting' }); send(question, { mode: 'new' }); continue; }
      if (choice === 'supplement' && primary) { update(question.key, { state: 'waiting' }); send(question, { mode: 'supplement', targetId: primary.documentId }); continue; }
      if (choice === 'restore' && primary?.trashId) {
        const trashId = primary.trashId;
        update(question.key, { state: 'uploading' });
        queue.current = queue.current.then(async () => {
          try {
            const restored = await trashApi.restore(trashId, owner);
            if (currentUser.current !== owner) return;
            update(question.key, { state: 'restored', target: primary.state === 'original-trashed' ? `bản gốc của ${primary.title}` : restored.name });
            setReload((value) => value + 1);
            refreshTree();
            refreshUsage();
          } catch (failure) {
            if (failure instanceof ApiError && failure.status === 404) return send(question);
            fail(question.key, failure);
          }
        });
        continue;
      }
      update(question.key, { state: 'duplicate' });
    }
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    enqueue(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    enqueue(Array.from(event.dataTransfer.files));
  }

  function accepts(target: string, files: boolean): boolean {
    if (files) return true;
    if (!drag) return false;
    if (drag.kind === 'document') {
      const folderId = target === UNFILED ? null : target;
      return target !== ALL && documents.some((known) => drag.ids.includes(known.id) && known.folderId !== folderId);
    }
    const folder = folders.find((known) => known.id === drag.ids[0]);
    const parentId = target === ALL ? null : target;
    return Boolean(folder) && target !== UNFILED && folder!.parentId !== parentId && !moveProblem(folders, folder!.id, parentId);
  }

  function dropOn(target: string, files: File[]) {
    const folderId = target === ALL || target === UNFILED ? null : target;
    if (files.length) { enqueue(files, folderId); return; }
    const dragged = drag;
    setDrag(null);
    if (!dragged) return;
    setError('');
    const folder = folders.find((known) => known.id === dragged.ids[0]);
    const move = dragged.kind === 'document' ? moveDocuments(dragged.ids, folderId) : folder && moveFolder(folder, folderId);
    move?.catch((failure: unknown) => {
      if (failure instanceof StaleSessionError) return;
      const fields = failure instanceof ApiError ? failure.fieldErrors : {};
      setError(fields.folderId || fields.parentId || failureMessage(failure, 'Chưa thể chuyển. Vui lòng thử lại.'));
      refreshTree();
    });
  }

  async function viewOriginal(item: DocumentSummary) {
    setError(''); setViewing(item.id);
    try { await openOriginal(item, 'view'); }
    catch (failure) { if (!(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể mở tài liệu.')); }
    finally { setViewing(null); }
  }

  function place(next: DocumentSummary) {
    setDocuments((previous) => matchesFilters(next, currentFilters.current)
      ? previous.map((known) => known.id === next.id ? next : known)
      : previous.filter((known) => known.id !== next.id));
  }

  function keep(folder: Folder) {
    setTree((current) => current && { ...current, folders: [...current.folders.filter((known) => known.id !== folder.id), folder] });
    refreshTree();
  }

  async function createFolder(parentId: string | null, folderName: string, purpose: string | null) {
    setUndo(null);
    const result = await foldersApi.create({ name: folderName, purpose, parentId }, user.id);
    keep(result.folder);
    setNotice(result.renamed
      ? `Đã có thư mục cùng tên ở đây nên thư mục mới được đặt là ${quoted(result.folder.name)}.`
      : `Đã tạo thư mục ${quoted(result.folder.name)}.`);
    setParams({ folder: result.folder.id });
  }

  async function editFolder(folder: Folder, folderName: string, purpose: string | null) {
    setUndo(null);
    const result = await foldersApi.update(folder.id, { ...(folderName !== folder.name ? { name: folderName } : {}), purpose }, user.id);
    keep(result.folder);
    setNotice(result.renamed ? `Đã có thư mục cùng tên ở đây nên tên được lưu là ${quoted(result.folder.name)}.` : 'Đã lưu thư mục.');
  }

  async function moveFolder(folder: Folder, parentId: string | null) {
    setUndo(null);
    const result = await foldersApi.update(folder.id, { parentId }, user.id);
    keep(result.folder);
    const place = parentId ? quoted(pathLabel(folders, parentId)) : 'cấp ngoài cùng';
    setNotice(`Đã chuyển thư mục tới ${place}${result.renamed ? `, lưu với tên ${quoted(result.folder.name)} vì ở đó đã có thư mục cùng tên` : ''}.`);
  }

  async function renameDocument(item: DocumentSummary, title: string) {
    setUndo(null);
    const result = await documentsApi.update(item.id, { title }, user.id);
    place(result.document);
    setNotice(result.renamed ? `Tên này đã có trong thư mục nên tài liệu được lưu là ${quoted(result.document.title)}.` : '');
  }

  async function moveDocument(item: DocumentSummary, folderId: string | null) {
    setUndo(null);
    const result = await documentsApi.update(item.id, { folderId }, user.id);
    place(result.document);
    refreshTree();
    const target = folderId ? quoted(pathLabel(folders, folderId)) : quoted(UNFILED_LABEL);
    setNotice(`Đã chuyển ${quoted(item.title)} tới ${target}${result.renamed ? `, lưu với tên ${quoted(result.document.title)} vì ở đó đã có tài liệu cùng tên` : ''}.`);
  }

  async function moveDocuments(ids: string[], folderId: string | null) {
    setUndo(null);
    const items = documents.filter((known) => ids.includes(known.id) && known.folderId !== folderId);
    if (items.length === 1) { await moveDocument(items[0], folderId); setSelected([]); return; }
    let moved = 0;
    let renamed = 0;
    for (const item of items) {
      try {
        const result = await documentsApi.update(item.id, { folderId }, user.id);
        place(result.document);
        moved++;
        if (result.renamed) renamed++;
      } catch (failure) {
        if (failure instanceof StaleSessionError) throw failure;
        if (failure instanceof ApiError && failure.fieldErrors.folderId) { refreshTree(); throw failure; }
      }
    }
    refreshTree();
    setSelected([]);
    const target = folderId ? quoted(pathLabel(folders, folderId)) : quoted(UNFILED_LABEL);
    setNotice(moved ? `Đã chuyển ${moved} tài liệu tới ${target}${renamed ? `; ${renamed} tài liệu được thêm hậu tố vì ở đó đã có tên trùng` : ''}.` : '');
    if (moved < items.length) setError(`Chưa chuyển được ${items.length - moved} tài liệu. Vui lòng thử lại.`);
  }

  async function removeDocuments(ids: string[]) {
    const gone: string[] = [];
    for (const id of ids) {
      try {
        await documentsApi.remove(id);
        gone.push(id);
      } catch (failure) {
        if (failure instanceof StaleSessionError) throw failure;
        if (failure instanceof ApiError && failure.status === 404) gone.push(id);
      }
    }
    setDocuments((previous) => previous.filter((known) => !gone.includes(known.id)));
    setSelected((previous) => previous.filter((id) => !gone.includes(id)));
    refreshUsage();
    refreshTree();
    setNotice(gone.length ? `Đã chuyển ${gone.length} tài liệu vào thùng rác.` : '');
    setUndo(gone.length ? { kind: 'DOCUMENT', ids: gone } : null);
    if (gone.length < ids.length) setError(`Chưa xóa được ${ids.length - gone.length} tài liệu. Vui lòng thử lại.`);
  }

  async function removeFolder(folder: Folder) {
    const inside = pathOf(folders, view).some((known) => known.id === folder.id);
    await foldersApi.remove(folder.id, user.id);
    if (inside) setParams(folder.parentId ? { folder: folder.parentId } : {});
    else setDocuments((previous) => previous.filter((known) => !pathOf(folders, known.folderId).some((ancestor) => ancestor.id === folder.id)));
    refreshTree();
    refreshUsage();
    setNotice(`Đã chuyển thư mục ${quoted(folder.name)} vào thùng rác.`);
    setUndo({ kind: 'FOLDER', ids: [folder.id] });
  }

  function deleteNow(work: Promise<void>) {
    setError('');
    work.catch((failure: unknown) => {
      if (failure instanceof StaleSessionError) return;
      setError(failure instanceof ApiError ? failure.message : 'Chưa thể xóa. Vui lòng thử lại.');
      refreshTree();
    });
  }

  function folderAction(folderId: string, action: FolderAction) {
    const folder = folders.find((known) => known.id === folderId);
    if (!folder) return;
    if (action === 'delete') deleteNow(removeFolder(folder));
    else if (action === 'create') setDialog({ kind: 'create', parentId: folder.id });
    else setDialog({ kind: action === 'edit' ? 'edit' : 'move-folder', folder });
  }

  function toggleSelected(id: string) {
    setSelected((previous) => previous.includes(id) ? previous.filter((known) => known !== id) : [...previous, id]);
  }

  const chosen = selected.filter((id) => documents.some((known) => known.id === id));
  const allChosen = documents.length > 0 && chosen.length === documents.length;
  const marquee = useMarquee(documents.length > 0 && !dialog && !summaryOf && !questions.length, chosen, setSelected);
  const barBefore = useRef(false);
  if (!marquee.box) barBefore.current = chosen.length > 0;
  const showBar = marquee.box ? barBefore.current : chosen.length > 0;
  async function undoDelete() {
    const target = undo;
    if (!target) return;
    setUndoing(true); setError('');
    try {
      let restored = 0;
      for (const entry of undoTargets(await trashApi.list(), target)) {
        try {
          await trashApi.restore(entry.id, user.id);
          restored++;
        } catch (failure) {
          if (failure instanceof StaleSessionError) throw failure;
        }
      }
      setUndo(null);
      setNotice(restored >= target.ids.length ? 'Đã hoàn tác: mục vừa xóa đã trở lại chỗ cũ.' : 'Chưa hoàn tác được hết; hãy xem các mục còn lại trong thùng rác.');
      setReload((value) => value + 1);
      refreshTree();
      refreshUsage();
    } catch (failure) {
      if (!(failure instanceof StaleSessionError)) setError(failureMessage(failure, 'Chưa thể hoàn tác. Vui lòng thử lại.'));
    } finally { setUndoing(false); }
  }

  const uploadSummary = summarizeUploads(uploads);
  const uploadTone = uploadSummary?.tone;
  const subfolders = openFolder ? childrenOf(folders, openFolder.id) : [];

  useEffect(() => {
    if (!notice) return;
    setUploads((previous) => previous.some((item) => isRunning(item) || item.state === 'asking') ? previous : []);
    if (undoing) return;
    const timer = setTimeout(() => { setNotice(''); setUndo(null); }, undo ? NOTICE_UNDO_MS : NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, undo, undoing]);

  useEffect(() => {
    if (uploadTone !== 'done') return;
    const timer = setTimeout(() => setUploads((previous) => previous.some((item) => isRunning(item) || item.state === 'asking') ? previous : []), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [uploadTone, uploads.length]);
  const usagePercent = usage ? Math.min(100, (usage.encryptedBytes / usage.quotaBytes) * 100) : 0;
  const path = pathOf(folders, openFolder?.id ?? null);
  const viewLabel = openFolder ? pathLabel(folders, openFolder.id) : view === UNFILED ? UNFILED_LABEL : 'Tất cả tài liệu';
  const mayNest = canCreateIn(folders, openFolder?.id ?? null);
  const emptyText = filtered
    ? { title: 'Không có tài liệu khớp bộ lọc', hint: 'Thử chọn loại tệp khác.' }
    : openFolder
      ? { title: 'Thư mục này chưa có tài liệu', hint: 'Bấm “Tải tài liệu” hoặc kéo thả tệp vào đây. Tài liệu đã có thì kéo vào thư mục ở cây bên trái.' }
      : view === UNFILED
        ? { title: 'Không có tài liệu nào chưa phân loại', hint: 'Mọi tài liệu của bạn đều đã nằm trong thư mục.' }
        : { title: 'Chưa có tài liệu nào', hint: 'Bấm “Tải tài liệu” hoặc kéo thả hợp đồng, hóa đơn, giấy bảo hành vào đây để bắt đầu.' };

  return <>
    <section className="documents-hero">
      <div className="hero-copy">
        <h1>Chào {name}<span>.</span></h1>
        <p>Tải lên hợp đồng, hóa đơn và giấy tờ quan trọng; DocFlow giúp bạn nhớ những ngày cần nhớ.</p>
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

    <section className="profile-card documents-card" aria-labelledby="documents-title">
      <div className="profile-heading"><div><span className="auth-kicker">THƯ VIỆN</span><h2 id="documents-title">Tài liệu của bạn</h2></div><span className="profile-icon"><Icon name="folder" size={24} /></span></div>
      <div className="library">
        <FolderPane tree={tree} view={view} onSelect={select} onCreate={() => setDialog({ kind: 'create', parentId: mayNest ? openFolder?.id ?? null : null })}
          accepts={accepts} onDrop={dropOn} onDragFolder={(id) => setDrag(id ? { kind: 'folder', ids: [id] } : null)}
          onAction={folderAction} mayNest={(id) => canCreateIn(folders, id)} />
        <div className={`library-main${dragging ? ' dragging' : ''}`}
          onDragOver={(event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={drop}>
          <div className="library-bar">
          <nav className="folder-crumbs" aria-label="Vị trí">
            {openFolder
              ? <>
                <button type="button" className="text-button" onClick={() => select(ALL)}>Tất cả tài liệu</button>
                {path.map((folder, index) => <span key={folder.id}><i aria-hidden="true">›</i>
                  {index === path.length - 1 ? <strong aria-current="page">{folder.name}</strong> : <button type="button" className="text-button" onClick={() => select(folder.id)}>{folder.name}</button>}
                </span>)}
              </>
              : <strong aria-current="page">{viewLabel}</strong>}
          </nav>
            {openFolder && <ActionMenu label={`Tùy chọn cho thư mục ${openFolder.name}`} actions={[
              { label: 'Thư mục con mới…', onSelect: () => setDialog({ kind: 'create', parentId: openFolder.id }), disabled: !mayNest, hint: mayNest ? undefined : `Thư mục chỉ được lồng tối đa ${MAX_FOLDER_DEPTH} cấp.` },
              { label: 'Sửa tên và mục đích…', onSelect: () => setDialog({ kind: 'edit', folder: openFolder }) },
              { label: 'Chuyển tới…', onSelect: () => setDialog({ kind: 'move-folder', folder: openFolder }) },
              { label: 'Xóa thư mục', onSelect: () => deleteNow(removeFolder(openFolder)), danger: true, hint: 'Thư mục và mọi thứ bên trong vào thùng rác; khôi phục được trong 30 ngày.' },
            ]} />}
            <button type="button" className="button-primary upload-button" onClick={() => input.current?.click()}><Icon name="upload" size={16} />Tải tài liệu</button>
            <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={choose} />
          </div>
          {openFolder?.purpose && <p className="folder-purpose">{openFolder.purpose}</p>}
          <p className="upload-note"><Icon name="shield" size={14} />PDF có lớp chữ, DOCX hoặc TXT · tối đa {MAX_UPLOAD_MB} MB mỗi tệp · mã hóa trước khi lưu</p>
          {uploadSummary && <div className={`upload-summary tone-${uploadSummary.tone}`} role="status" aria-live="polite">
            {uploadSummary.tone === 'busy' ? <span className="spinner spinner-small" /> : <span className="upload-summary-icon" aria-hidden="true">{uploadSummary.tone === 'done' ? '✓' : '!'}</span>}
            <div>
              <p>{uploadSummary.text}</p>
              {uploadSummary.details.length > 0 && <ul>{uploadSummary.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
            </div>
          </div>}
          {notice && <div className="upload-summary tone-done library-notice" role="status"><span className="upload-summary-icon" aria-hidden="true">✓</span><div><p>{notice}{undo && <> <button type="button" className="text-button" onClick={undoDelete} disabled={undoing}>{undoing ? 'Đang hoàn tác…' : 'Hoàn tác'}</button><i aria-hidden="true"> · </i><Link className="text-button" to="/trash">Mở thùng rác</Link></>}</p></div></div>}
          {error && <div className="form-alert documents-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
          {(documents.length > 0 || filtered) && <div className="document-filters" role="group" aria-label="Lọc tài liệu">
            <div className="filter-chips">
              {([undefined, 'pdf', 'docx', 'txt'] as (DocumentTypeFilter | undefined)[]).map((type) =>
                <button key={type ?? 'all'} type="button" className="filter-chip" aria-pressed={fileType === type}
                  onClick={() => setFileType(type)}>{type ? typeFilterLabels[type] : 'Tất cả'}</button>)}
            </div>
            <select className="filter-select sort-select" aria-label="Sắp xếp" value={sort} onChange={(event) => setSort(event.target.value as DocumentSort)}>
              {(Object.keys(sortLabels) as DocumentSort[]).map((key) => <option key={key} value={key}>{sortLabels[key]}</option>)}
            </select>
          </div>}
          {showBar && <div className="bulk-bar" role="group" aria-label="Thao tác với tài liệu đã chọn">
            <strong>Đã chọn {chosen.length} tài liệu</strong>
            <button type="button" className="action-button" onClick={() => setDialog({ kind: 'move-many', ids: chosen })}><Icon name="folder" size={15} />Chuyển tới…</button>
            <button type="button" className="action-button bulk-danger" title="Vào thùng rác; khôi phục được trong 30 ngày." onClick={() => deleteNow(removeDocuments(chosen))}>Xóa</button>
            <button type="button" className="text-button" onClick={() => setSelected([])}>Bỏ chọn</button>
          </div>}
          {!loading && !documents.length && !subfolders.length && !error && <div className="documents-empty">
            <span><Icon name="folder" size={26} /></span>
            <strong>{emptyText.title}</strong>
            <p>{emptyText.hint}</p>
            {filtered && <button type="button" className="button-secondary" onClick={() => setFileType(undefined)}>Bỏ lọc</button>}
          </div>}
          <ul className="document-list" aria-busy={loading}>
            {(documents.length > 0 || subfolders.length > 0) && <li className="document-columns">
              <label className="document-check" title={allChosen ? 'Bỏ chọn tất cả' : 'Chọn tất cả tài liệu đang hiện'}>
                <input type="checkbox" checked={allChosen} disabled={!documents.length} aria-label="Chọn tất cả tài liệu đang hiện" onChange={() => setSelected(allChosen ? [] : documents.map((item) => item.id))} />
              </label>
              <span aria-hidden="true" /><span aria-hidden="true">Tài liệu</span><span aria-hidden="true">Cập nhật</span><span aria-hidden="true" /></li>}
            {subfolders.map((folder) => <li key={folder.id} className={`document-row folder-entry${over === folder.id ? ' drop-target' : ''}`}
              onDragOver={(event) => {
                if (!accepts(folder.id, hasFiles(event))) return;
                event.preventDefault(); event.stopPropagation();
                event.dataTransfer.dropEffect = hasFiles(event) ? 'copy' : 'move';
                setOver(folder.id);
              }}
              onDragLeave={() => setOver((current) => current === folder.id ? null : current)}
              onDrop={(event) => {
                setOver(null); setDragging(false);
                if (!accepts(folder.id, hasFiles(event))) return;
                event.preventDefault(); event.stopPropagation();
                dropOn(folder.id, Array.from(event.dataTransfer.files));
              }}>
              <span aria-hidden="true" />
              <button type="button" className="document-type type-folder" onClick={() => select(folder.id)} aria-label={`Mở thư mục ${folder.name}`} tabIndex={-1}><Icon name="folder" size={19} /></button>
              <div className="document-info">
                <button type="button" className="document-title folder-open" onClick={() => select(folder.id)} title={folder.purpose ?? 'Mở thư mục'}>{folder.name}</button>
                <p className="document-line">Thư mục · {folderContents(folders, folder.id).documents} tài liệu{folderContents(folders, folder.id).folders > 0 && ` · ${folderContents(folders, folder.id).folders} thư mục con`}</p>
              </div>
              <p className="document-updated"><span>Cập nhật </span><time dateTime={folder.updatedAt}>{shortDate(folder.updatedAt)}</time></p>
              <div className="document-actions">
                <ActionMenu label={`Tùy chọn cho thư mục ${folder.name}`} actions={[
                  { label: 'Thư mục con mới…', onSelect: () => folderAction(folder.id, 'create'), disabled: !canCreateIn(folders, folder.id) },
                  { label: 'Sửa tên và mục đích…', onSelect: () => folderAction(folder.id, 'edit') },
                  { label: 'Chuyển tới…', onSelect: () => folderAction(folder.id, 'move') },
                  { label: 'Xóa thư mục', onSelect: () => folderAction(folder.id, 'delete'), danger: true },
                ]} />
              </div>
            </li>)}
            {documents.map((item) => <li key={item.id} draggable data-document-id={item.id}
              className={`document-row${drag?.kind === 'document' && drag.ids.includes(item.id) ? ' is-dragged' : ''}${chosen.includes(item.id) ? ' is-selected' : ''}`}
              onDragStart={(event) => {
                if (marquee.armed.current) { event.preventDefault(); return; }
                const ids = chosen.includes(item.id) ? chosen : [item.id];
                event.dataTransfer.setData(DOCUMENT_DRAG, ids.join(','));
                event.dataTransfer.effectAllowed = 'move';
                setDrag({ kind: 'document', ids });
              }}
              onDragEnd={() => setDrag(null)}>
              <label className="document-check">
                <input type="checkbox" checked={chosen.includes(item.id)} aria-label={`Chọn ${item.title}`} onChange={() => toggleSelected(item.id)} />
              </label>
              <button type="button" className={`document-type type-${fileTypeLabel(item).toLowerCase()}`} onClick={() => viewOriginal(item)} tabIndex={-1}
                disabled={!canViewOriginal(item) || viewing !== null} aria-label={`Xem ${item.title}`}>{fileTypeLabel(item)}</button>
              <div className="document-info">
                {canViewOriginal(item)
                  ? <button type="button" className="document-title file-open" onClick={() => viewOriginal(item)} disabled={viewing !== null}
                    title={`Bấm để xem · Tên tệp gốc: ${item.file.name}`}>{item.title}{viewing === item.id && <em> · đang mở…</em>}</button>
                  : <strong className="document-title" title={`Bản gốc không còn lưu nên không xem được · Tên tệp gốc: ${item.file.name}`}>{item.title}</strong>}
                <p className={`document-line tone-${statusTone(item)}`}>
                  {isProcessing(item) ? <span className="spinner spinner-tiny" /> : <span className="status-dot" aria-hidden="true" />}
                  {infoLine(item)}{item.originalDeleting && ' · Đang xóa bản gốc…'}
                </p>
                {view === ALL && item.folderId && pathLabel(folders, item.folderId) && <button type="button" className="document-folder" onClick={() => select(item.folderId!)}
                  title="Mở thư mục này"><Icon name="folder" size={13} />{pathLabel(folders, item.folderId)}</button>}
                {problemMessage(item) && <p className="document-problem">{problemMessage(item)}</p>}
              </div>
              <p className="document-updated">
                <span>Cập nhật </span><time dateTime={item.updatedAt} title={dateFormat.format(new Date(item.updatedAt))}>{shortDate(item.updatedAt)}</time>
              </p>
              <div className="document-actions">
                <button type="button" className="action-button" onClick={() => setSummaryOf(item)}>
                  <Icon name="summary" size={15} />Xem tóm tắt
                </button>
                <DocumentOptions document={item}
                  onRename={() => setDialog({ kind: 'rename', document: item })}
                  onMove={() => setDialog({ kind: 'move-document', document: item })}
                  onChange={(next) => {
                    place(next); refreshUsage();
                    if (next.originalInTrash) { setNotice(`Đã chuyển bản gốc của ${quoted(next.title)} vào thùng rác.`); setUndo({ kind: 'ORIGINAL', ids: [next.id] }); }
                  }}
                  onRemove={() => {
                    setDocuments((previous) => previous.filter((known) => known.id !== item.id));
                    refreshUsage(); refreshTree();
                    setNotice(`Đã chuyển ${quoted(item.title)} vào thùng rác.`); setUndo({ kind: 'DOCUMENT', ids: [item.id] });
                  }} />
              </div>
            </li>)}
          </ul>
          {marquee.box && <div className="marquee-box" aria-hidden="true" style={marquee.box} />}
          {dragging && <div className="drop-overlay" aria-hidden="true"><Icon name="upload" size={22} />Thả tệp để tải vào {openFolder ? quoted(viewLabel) : quoted(UNFILED_LABEL)}</div>}
          {(loading || documents.length > 0 || cursor) && <div className="profile-bottom">
            <p role="status">{loading ? 'Đang tải danh sách…' : `${documents.length}${cursor ? '+' : ''} tài liệu${filtered ? ' khớp bộ lọc' : ''}`}</p>
            {cursor && <button type="button" className="button-secondary" onClick={loadMore} disabled={loading}>Tải thêm</button>}
          </div>}
        </div>
      </div>
      {questions.length > 0 && !uploads.some(isRunning) && <DuplicateDialog key={questions.map((question) => question.key).join(',')} questions={questions} onSubmit={answer} />}
      {summaryOf && <SummaryDialog document={summaryOf} onClose={() => setSummaryOf(null)} />}
      {dialog?.kind === 'create' && <FolderFormDialog path={pathOf(folders, dialog.parentId)}
        onSubmit={(folderName, purpose, parentId) => createFolder(parentId, folderName, purpose)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <FolderFormDialog folder={dialog.folder}
        onSubmit={(folderName, purpose) => editFolder(dialog.folder, folderName, purpose)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'move-folder' && <MoveDialog kicker="CHUYỂN THƯ MỤC" title={dialog.folder.name} folders={folders} currentId={dialog.folder.parentId}
        rootLabel="Cấp ngoài cùng" problemFor={(target) => moveProblem(folders, dialog.folder.id, target)}
        note={<p className="dialog-note">Mọi thư mục con và tài liệu bên trong đi theo. Cây thư mục sâu tối đa {MAX_FOLDER_DEPTH} cấp.</p>}
        onSubmit={(target) => moveFolder(dialog.folder, target)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rename' && <RenameDialog title={dialog.document.title} fileName={dialog.document.file.name}
        onSubmit={(title) => renameDocument(dialog.document, title)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'move-document' && <MoveDialog kicker="CHUYỂN TÀI LIỆU" title={dialog.document.title} folders={folders} currentId={dialog.document.folderId}
        rootLabel={UNFILED_LABEL} onSubmit={(target) => moveDocument(dialog.document, target)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'move-many' && <MoveDialog kicker="CHUYỂN TÀI LIỆU" title={`${dialog.ids.length} tài liệu đã chọn`} folders={folders} currentId={undefined}
        rootLabel={UNFILED_LABEL} onSubmit={(target) => moveDocuments(dialog.ids, target)} onClose={() => setDialog(null)} />}
    </section>
  </>;
}
