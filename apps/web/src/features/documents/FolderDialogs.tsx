import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Icon } from '../../components/Brand';
import { Modal } from '../../components/Modal';
import { ApiError, StaleSessionError } from '../../lib/api';
import { titleProblem } from '../../lib/documents';
import { flattenTree, folderNameProblem, MAX_FOLDER_NAME, MAX_FOLDER_PURPOSE } from '../../lib/folders';
import type { Folder } from '../../lib/folders';

function useSubmit(onClose: () => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>, fields: string[]) {
    setSaving(true); setError('');
    try {
      await action();
      onClose();
    } catch (failure) {
      if (failure instanceof StaleSessionError) { onClose(); return; }
      const fieldMessage = failure instanceof ApiError ? fields.map((field) => failure.fieldErrors[field]).find(Boolean) : undefined;
      setError(fieldMessage ?? (failure instanceof ApiError ? failure.message : 'Chưa thể lưu. Vui lòng thử lại.'));
    } finally { setSaving(false); }
  }
  return { saving, error, setError, run };
}

function Actions({ saving, label, onClose, disabled = false }: { saving: boolean; label: string; onClose: () => void; disabled?: boolean }) {
  return <div className="summary-dialog-actions dialog-actions">
    <button type="button" className="button-secondary" onClick={onClose} disabled={saving}>Hủy</button>
    <button type="submit" className="button-primary dialog-submit" disabled={saving || disabled}>{saving ? 'Đang lưu…' : label}</button>
  </div>;
}

interface FolderFormProps {
  folder?: Folder;
  path?: readonly Folder[];
  onSubmit: (name: string, purpose: string | null, parentId: string | null) => Promise<void>;
  onClose: () => void;
}

const ROOT_LABEL = 'Cấp ngoài cùng';

export function FolderFormDialog({ folder, path = [], onSubmit, onClose }: FolderFormProps) {
  const [name, setName] = useState(folder?.name ?? '');
  const [purpose, setPurpose] = useState(folder?.purpose ?? '');
  const [parentId, setParentId] = useState<string | null>(path.at(-1)?.id ?? null);
  const { saving, error, setError, run } = useSubmit(onClose);
  const parent = path.find((known) => known.id === parentId);
  const chosen = path.findIndex((known) => known.id === parentId);

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = folderNameProblem(name);
    if (problem) { setError(problem); return; }
    void run(() => onSubmit(name.trim(), purpose.trim() || null, parentId), ['name', 'purpose', 'parentId']);
  }

  const place = (id: string | null, label: string, index: number) => <span key={id ?? 'root'}>
    {index >= 0 && <i aria-hidden="true">›</i>}
    <button type="button" className={`parent-place${id === parentId ? ' selected' : ''}${index > chosen ? ' beyond' : ''}`}
      aria-pressed={id === parentId} disabled={saving} onClick={() => setParentId(id)}>{label}</button>
  </span>;

  return <Modal kicker={folder ? 'SỬA THƯ MỤC' : 'THƯ MỤC MỚI'} title={folder ? folder.name : `Tạo trong ${parent ? `“${parent.name}”` : 'cấp ngoài cùng'}`} onClose={onClose} locked={saving}>
    <form className="dialog-form" onSubmit={submit} noValidate>
      {!folder && path.length > 0 && <div className="dialog-field">
        <span>Tạo trong</span>
        <div className="parent-path" role="group" aria-label="Chọn nơi tạo thư mục">
          {place(null, ROOT_LABEL, -1)}
          {path.map((known, index) => place(known.id, known.name, index))}
        </div>
        <small>Bấm vào một thư mục trong đường dẫn để tạo ở đó.</small>
      </div>}
      <label className="dialog-field">
        <span>Tên thư mục</span>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={MAX_FOLDER_NAME} autoFocus required placeholder="Ví dụ: Giấy tờ xe" />
      </label>
      <label className="dialog-field">
        <span>Mục đích <small>(không bắt buộc)</small></span>
        <textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={MAX_FOLDER_PURPOSE} rows={3}
          placeholder="Ví dụ: Đăng ký xe, đăng kiểm, bảo hiểm xe — các giấy tờ cần gia hạn" />
        <small>Mô tả ngắn giúp DocFlow gợi ý xếp tài liệu vào đúng thư mục sau này.</small>
      </label>
      {error && <p className="field-error" role="alert">{error}</p>}
      <Actions saving={saving} label={folder ? 'Lưu thay đổi' : 'Tạo thư mục'} onClose={onClose} />
    </form>
  </Modal>;
}

interface RenameProps {
  title: string;
  fileName: string;
  onSubmit: (title: string) => Promise<void>;
  onClose: () => void;
}

export function RenameDialog({ title, fileName, onSubmit, onClose }: RenameProps) {
  const [value, setValue] = useState(title);
  const { saving, error, setError, run } = useSubmit(onClose);

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = titleProblem(value);
    if (problem) { setError(problem); return; }
    if (value.trim() === title) { onClose(); return; }
    void run(() => onSubmit(value.trim()), ['title']);
  }

  return <Modal kicker="ĐỔI TÊN" title={title} onClose={onClose} locked={saving}>
    <form className="dialog-form" onSubmit={submit} noValidate>
      <label className="dialog-field">
        <span>Tên hiển thị</span>
        <input value={value} onChange={(event) => setValue(event.target.value)} maxLength={255} autoFocus required onFocus={(event) => event.target.select()} />
        <small>Tên tệp gốc lúc tải lên vẫn được giữ: {fileName}</small>
      </label>
      {error && <p className="field-error" role="alert">{error}</p>}
      <Actions saving={saving} label="Đổi tên" onClose={onClose} />
    </form>
  </Modal>;
}

interface MoveProps {
  kicker: string;
  title: string;
  folders: readonly Folder[];
  currentId: string | null | undefined;
  rootLabel: string;
  problemFor?: (targetId: string | null) => string | null;
  note?: ReactNode;
  onSubmit: (targetId: string | null) => Promise<void>;
  onClose: () => void;
}

export function MoveDialog({ kicker, title, folders, currentId, rootLabel, problemFor, note, onSubmit, onClose }: MoveProps) {
  const [target, setTarget] = useState<string | null | undefined>(currentId);
  const { saving, error, run } = useSubmit(onClose);
  const rows = flattenTree(folders);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (target === undefined) return;
    if (target === currentId) { onClose(); return; }
    void run(() => onSubmit(target), ['folderId', 'parentId']);
  }

  const option = (id: string | null, label: string, depth: number, icon: 'folder' | 'file') => {
    const problem = problemFor?.(id) ?? null;
    return <label key={id ?? 'root'} className={`move-option${target === id ? ' selected' : ''}${problem ? ' blocked' : ''}`}
      style={{ paddingLeft: 12 + (depth - 1) * 18 }} title={problem ?? undefined}>
      <input type="radio" name="move-target" checked={target === id} disabled={Boolean(problem) || saving} onChange={() => setTarget(id)} />
      <Icon name={icon} size={16} /><span>{label}</span>{id === currentId && <em>đang ở đây</em>}
    </label>;
  };

  return <Modal kicker={kicker} title={title} onClose={onClose} locked={saving}>
    <form className="dialog-form" onSubmit={submit}>
      <div className="move-list" role="radiogroup" aria-label="Chọn nơi chuyển tới">
        {option(null, rootLabel, 1, 'file')}
        {rows.map(({ folder, depth }) => option(folder.id, folder.name, depth, 'folder'))}
      </div>
      {note}
      {error && <p className="field-error" role="alert">{error}</p>}
      <Actions saving={saving} label="Chuyển tới đây" onClose={onClose} disabled={target === currentId} />
    </form>
  </Modal>;
}

interface ConfirmProps {
  kicker: string;
  title: string;
  label: string;
  children: ReactNode;
  onSubmit: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ kicker, title, label, children, onSubmit, onClose }: ConfirmProps) {
  const { saving, error, run } = useSubmit(onClose);
  return <Modal kicker={kicker} title={title} onClose={onClose} locked={saving}>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); void run(onSubmit, []); }}>
      {children}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="summary-dialog-actions dialog-actions">
        <button type="button" className="button-secondary" onClick={onClose} disabled={saving} autoFocus>Giữ lại</button>
        <button type="submit" className="button-danger" disabled={saving}>{saving ? 'Đang xóa…' : label}</button>
      </div>
    </form>
  </Modal>;
}
