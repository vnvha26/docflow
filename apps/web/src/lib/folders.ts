import { authClient } from './api.ts';

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  purpose: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FolderTree { folders: Folder[]; unfiledCount: number; totalCount: number }
export interface FolderResult { folder: Folder; renamed: boolean }
export interface FolderRow { folder: Folder; depth: number }

export const MAX_FOLDER_DEPTH = 5;
export const MAX_FOLDER_NAME = 100;
export const MAX_FOLDER_PURPOSE = 500;
export const UNFILED = 'none';

const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
type Node = Pick<Folder, 'id' | 'parentId'>;

export function childrenOf<T extends Node & { name: string }>(folders: readonly T[], parentId: string | null): T[] {
  return folders.filter((folder) => folder.parentId === parentId).sort((left, right) => collator.compare(left.name, right.name) || left.id.localeCompare(right.id));
}

export function flattenTree(folders: readonly Folder[]): FolderRow[] {
  const rows: FolderRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    if (depth > folders.length) return;
    for (const folder of childrenOf(folders, parentId)) {
      rows.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 1);
  return rows;
}

export function pathOf<T extends Node>(folders: readonly T[], id: string | null): T[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: T[] = [];
  for (let current = id ? byId.get(id) : undefined; current && path.length <= folders.length; current = current.parentId ? byId.get(current.parentId) : undefined) {
    path.unshift(current);
  }
  return path;
}

export const depthOf = (folders: readonly Node[], id: string | null) => pathOf(folders, id).length;

export function heightOf(folders: readonly Node[], id: string): number {
  let level = [id];
  let height = 0;
  while (height <= folders.length) {
    level = folders.filter((folder) => folder.parentId !== null && level.includes(folder.parentId)).map((folder) => folder.id);
    if (!level.length) break;
    height++;
  }
  return height;
}

export const canCreateIn = (folders: readonly Node[], parentId: string | null) => depthOf(folders, parentId) < MAX_FOLDER_DEPTH;

export function moveProblem(folders: readonly Node[], folderId: string, targetId: string | null): string | null {
  if (pathOf(folders, targetId).some((folder) => folder.id === folderId)) return 'Không thể chuyển thư mục vào chính nó hoặc thư mục con của nó.';
  if (depthOf(folders, targetId) + 1 + heightOf(folders, folderId) > MAX_FOLDER_DEPTH) return `Thư mục chỉ được lồng tối đa ${MAX_FOLDER_DEPTH} cấp.`;
  return null;
}

export const pathLabel = (folders: readonly Folder[], id: string | null) => pathOf(folders, id).map((folder) => folder.name).join(' › ');

export function folderNameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Nhập tên thư mục.';
  if (name.length > MAX_FOLDER_NAME) return `Tên thư mục không được vượt quá ${MAX_FOLDER_NAME} ký tự.`;
  if (/[\\/]/.test(name)) return 'Tên thư mục không được chứa dấu / hoặc \\.';
  return null;
}

export const foldersApi = {
  tree() {
    return authClient.request<FolderTree>('/folders');
  },
  create(input: { name: string; purpose?: string | null; parentId?: string | null }, userId: string) {
    return authClient.request<FolderResult>('/folders', { method: 'POST', body: JSON.stringify(input) }, { asUser: userId });
  },
  update(id: string, input: { name?: string; purpose?: string | null; parentId?: string | null }, userId: string) {
    return authClient.request<FolderResult>(`/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }, { asUser: userId });
  },
};
