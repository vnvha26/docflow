import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import { Icon } from '../../components/Brand';
import { flattenTree, pathOf, UNFILED } from '../../lib/folders';
import type { FolderTree } from '../../lib/folders';
import { folderContents } from '../../lib/trash';

export const ALL = 'all';
export const FOLDER_DRAG = 'application/x-docflow-folder';
export const DOCUMENT_DRAG = 'application/x-docflow-document';
const STORAGE_KEY = 'docflow-folder-tree';

interface Stored { collapsed: string[]; hidden: boolean }

function readStored(): Stored {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Stored>;
    return { collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter((id) => typeof id === 'string') : [], hidden: value.hidden === true };
  } catch { return { collapsed: [], hidden: false }; }
}

export const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

interface Props {
  tree: FolderTree | null;
  view: string;
  onSelect: (view: string) => void;
  onCreate: () => void;
  accepts: (target: string, files: boolean) => boolean;
  onDrop: (target: string, files: File[]) => void;
  onDragFolder: (id: string | null) => void;
  onAction: (folderId: string, action: FolderAction) => void;
  mayNest: (folderId: string) => boolean;
}

export type FolderAction = 'create' | 'edit' | 'move' | 'delete';
const MENU_WIDTH = 230;
const MENU_HEIGHT = 176;

export function FolderPane({ tree, view, onSelect, onCreate, accepts, onDrop, onDragFolder, onAction, mayNest }: Props) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [stored, setStored] = useState(readStored);
  const [over, setOver] = useState<string | null>(null);
  const folders = tree?.folders ?? [];
  const collapsed = new Set(stored.collapsed);
  const parents = new Set(folders.map((folder) => folder.parentId).filter(Boolean));
  const rows = flattenTree(folders).filter(({ folder }) => !pathOf(folders, folder.parentId).some((ancestor) => collapsed.has(ancestor.id)));

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)); } catch { return; }
  }, [stored]);

  useEffect(() => {
    const ancestors = pathOf(folders, view).slice(0, -1).map((folder) => folder.id);
    if (ancestors.some((id) => stored.collapsed.includes(id))) {
      setStored((current) => ({ ...current, collapsed: current.collapsed.filter((id) => !ancestors.includes(id)) }));
    }
  }, [view, tree]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && (event.target as Element | null)?.closest?.('.context-menu')) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const choose = (action: FolderAction) => {
    const id = menu?.id;
    setMenu(null);
    if (id) onAction(id, action);
  };

  const toggle = (id: string) => setStored((current) => ({
    ...current, collapsed: current.collapsed.includes(id) ? current.collapsed.filter((known) => known !== id) : [...current.collapsed, id],
  }));

  const dropProps = (key: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!accepts(key, hasFiles(event))) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = hasFiles(event) ? 'copy' : 'move';
      setOver(key);
    },
    onDragLeave: () => setOver((current) => current === key ? null : current),
    onDrop: (event: DragEvent) => {
      setOver(null);
      if (!accepts(key, hasFiles(event))) return;
      event.preventDefault();
      event.stopPropagation();
      onDrop(key, Array.from(event.dataTransfer.files));
    },
  });

  const item = (key: string, label: string, count: number | undefined, depth: number, icon: 'folder' | 'file', expandable = false) =>
    <li key={key} className={`folder-row${over === key ? ' drop-target' : ''}`} style={{ paddingLeft: (depth - 1) * 14 }} {...dropProps(key)}>
      {icon === 'folder' && (expandable
        ? <button type="button" className={`folder-toggle${collapsed.has(key) ? '' : ' open'}`} onClick={() => toggle(key)}
          aria-label={collapsed.has(key) ? `Mở rộng ${label}` : `Thu gọn ${label}`} aria-expanded={!collapsed.has(key)}><Icon name="chevron" size={14} /></button>
        : <span className="folder-toggle" aria-hidden="true" />)}
      <button type="button" className="folder-item" aria-current={view === key ? 'true' : undefined} onClick={() => onSelect(key)} title={label}
        draggable={icon === 'folder'}
        onContextMenu={icon === 'folder' ? (event) => {
          event.preventDefault();
          setMenu({ id: key, x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8)) });
        } : undefined}
        onDragStart={(event) => { event.dataTransfer.setData(FOLDER_DRAG, key); event.dataTransfer.effectAllowed = 'move'; onDragFolder(key); }}
        onDragEnd={() => { onDragFolder(null); setOver(null); }}>
        <Icon name={icon} size={16} /><span>{label}</span>{count !== undefined && <small>{count}</small>}
      </button>
    </li>;

  return <aside className="folder-pane" aria-label="Thư mục">
    <div className="folder-pane-head">
      <button type="button" className={`folder-toggle pane-toggle${stored.hidden ? '' : ' open'}`} aria-expanded={!stored.hidden}
        onClick={() => setStored((current) => ({ ...current, hidden: !current.hidden }))} aria-label={stored.hidden ? 'Hiện cây thư mục' : 'Ẩn cây thư mục'}>
        <Icon name="chevron" size={14} /><span>Thư mục</span>
      </button>
      <button type="button" className="text-button" onClick={onCreate}>+ Thư mục mới</button>
    </div>
    <ul className="folder-tree">
      {item(ALL, 'Tất cả tài liệu', tree?.totalCount, 1, 'file')}
      {item(UNFILED, 'Chưa phân loại', tree?.unfiledCount, 1, 'file')}
      {!stored.hidden && rows.length > 0 && <li className="folder-divider" aria-hidden="true" />}
      {!stored.hidden && rows.map(({ folder, depth }) => item(folder.id, folder.name, folderContents(folders, folder.id).documents, depth, 'folder', parents.has(folder.id)))}
    </ul>
    {menu && <div className="document-menu-body context-menu" role="menu" style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }}>
      <button type="button" role="menuitem" className="text-button menu-item" disabled={!mayNest(menu.id)} onClick={() => choose('create')}>Thư mục con mới…</button>
      <button type="button" role="menuitem" className="text-button menu-item" onClick={() => choose('edit')}>Sửa tên và mục đích…</button>
      <button type="button" role="menuitem" className="text-button menu-item" onClick={() => choose('move')}>Chuyển tới…</button>
      <button type="button" role="menuitem" className="text-button danger menu-item" onClick={() => choose('delete')}>Xóa thư mục</button>
    </div>}
    <select className="folder-select" aria-label="Chọn thư mục" value={view} onChange={(event) => onSelect(event.target.value)}>
      <option value={ALL}>Tất cả tài liệu{tree ? ` (${tree.totalCount})` : ''}</option>
      <option value={UNFILED}>Chưa phân loại{tree ? ` (${tree.unfiledCount})` : ''}</option>
      {flattenTree(folders).map(({ folder, depth }) => <option key={folder.id} value={folder.id}>{'  '.repeat(depth - 1)}{depth > 1 ? '› ' : ''}{folder.name} ({folderContents(folders, folder.id).documents})</option>)}
    </select>
  </aside>;
}
