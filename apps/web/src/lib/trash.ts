import { authClient } from './api.ts';

export type TrashKind = 'DOCUMENT' | 'FOLDER' | 'ORIGINAL';

export interface TrashEntry {
  id: string;
  kind: TrashKind;
  documentId: string | null;
  folderId: string | null;
  name: string;
  location: string | null;
  documentCount: number;
  folderCount: number;
  deletedAt: string;
  expiresAt: string;
}

export interface RestoreResult {
  kind: TrashKind;
  name: string;
  renamed: boolean;
  moved: boolean;
  folderId: string | null;
  location: string | null;
}

export const TRASH_DAYS = 30;
const DAY_MS = 86_400_000;
const quoted = (name: string) => `“${name}”`;

export const kindLabels: Record<TrashKind, string> = { DOCUMENT: 'Tài liệu', FOLDER: 'Thư mục', ORIGINAL: 'Bản gốc' };

export function daysLeft(entry: Pick<TrashEntry, 'expiresAt'>, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(entry.expiresAt).getTime() - now) / DAY_MS));
}

export function remainingLabel(entry: Pick<TrashEntry, 'expiresAt'>, now = Date.now()): string {
  const days = daysLeft(entry, now);
  if (days === 0) return 'Sắp bị xóa vĩnh viễn';
  return days === 1 ? 'Còn dưới 1 ngày' : `Còn ${days} ngày`;
}

export function contentsLabel(entry: Pick<TrashEntry, 'kind' | 'documentCount' | 'folderCount'>): string | null {
  if (entry.kind !== 'FOLDER') return null;
  const parts = [];
  if (entry.folderCount) parts.push(`${entry.folderCount} thư mục con`);
  parts.push(`${entry.documentCount} tài liệu`);
  return parts.join(', ');
}

export function entryTitle(entry: Pick<TrashEntry, 'kind' | 'name'>): string {
  return entry.kind === 'ORIGINAL' ? `Bản gốc của ${quoted(entry.name)}` : entry.name;
}

export function locationLabel(entry: Pick<TrashEntry, 'kind' | 'location'>): string {
  if (entry.location) return entry.location;
  return entry.kind === 'FOLDER' ? 'Cấp ngoài cùng' : 'Chưa phân loại';
}

export function restoreMessage(result: RestoreResult): string {
  if (result.kind === 'ORIGINAL') return `Đã khôi phục bản gốc của ${quoted(result.name)}; xem và tải lại được ngay.`;
  const what = result.kind === 'FOLDER' ? 'thư mục' : 'tài liệu';
  const place = result.location ? quoted(result.location) : result.kind === 'FOLDER' ? 'cấp ngoài cùng' : quoted('Chưa phân loại');
  const where = result.moved ? `Thư mục cũ không còn nên ${what} được đưa về ${place}` : `Đã khôi phục ${what} về ${place}`;
  const name = result.renamed ? `, lưu với tên ${quoted(result.name)} vì ở đó đã có tên trùng` : '';
  return result.moved ? `${where}${name}.` : `${where}${name}.`;
}

export interface Undo { kind: TrashKind; ids: string[] }

export function undoTargets(entries: readonly TrashEntry[], undo: Undo): TrashEntry[] {
  return entries.filter((entry) => entry.kind === undo.kind && undo.ids.includes((entry.kind === 'FOLDER' ? entry.folderId : entry.documentId) ?? ''));
}

export function folderContents(folders: readonly { id: string; parentId: string | null; documentCount: number }[], folderId: string): { folders: number; documents: number } {
  const inside = [folderId];
  for (let index = 0; index < inside.length && inside.length <= folders.length; index++) {
    for (const folder of folders) {
      if (folder.parentId === inside[index] && !inside.includes(folder.id)) inside.push(folder.id);
    }
  }
  return {
    folders: inside.length - 1,
    documents: folders.filter((folder) => inside.includes(folder.id)).reduce((total, folder) => total + folder.documentCount, 0),
  };
}

export const trashApi = {
  async list() {
    return (await authClient.request<{ items: TrashEntry[] }>('/trash')).items;
  },
  restore(id: string, userId: string) {
    return authClient.request<RestoreResult>(`/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' }, { asUser: userId });
  },
  purge(id: string, userId: string) {
    return authClient.request<void>(`/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }, { asUser: userId });
  },
  empty(userId: string) {
    return authClient.request<{ purged: number }>('/trash', { method: 'DELETE' }, { asUser: userId });
  },
};
