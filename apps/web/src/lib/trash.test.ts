import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentsLabel, daysLeft, entryTitle, folderContents, locationLabel, remainingLabel, restoreMessage, undoTargets } from './trash.ts';
import type { RestoreResult, TrashEntry } from './trash.ts';

const now = Date.parse('2026-11-13T10:00:00.000Z');
const at = (days: number) => ({ expiresAt: new Date(now + days * 86_400_000).toISOString() });

test('days left are rounded up and never negative', () => {
  assert.equal(daysLeft(at(30), now), 30);
  assert.equal(daysLeft(at(29.2), now), 30);
  assert.equal(daysLeft(at(0.1), now), 1);
  assert.equal(daysLeft(at(-3), now), 0);
  assert.equal(remainingLabel(at(12), now), 'Còn 12 ngày');
  assert.equal(remainingLabel(at(0.5), now), 'Còn dưới 1 ngày');
  assert.equal(remainingLabel(at(-1), now), 'Sắp bị xóa vĩnh viễn');
});

test('an item says what it is, what it holds and where it was', () => {
  assert.equal(entryTitle({ kind: 'DOCUMENT', name: 'Hợp đồng' }), 'Hợp đồng');
  assert.equal(entryTitle({ kind: 'ORIGINAL', name: 'Hợp đồng' }), 'Bản gốc của “Hợp đồng”');
  assert.equal(contentsLabel({ kind: 'DOCUMENT', documentCount: 0, folderCount: 0 }), null);
  assert.equal(contentsLabel({ kind: 'FOLDER', documentCount: 3, folderCount: 2 }), '2 thư mục con, 3 tài liệu');
  assert.equal(contentsLabel({ kind: 'FOLDER', documentCount: 0, folderCount: 0 }), '0 tài liệu');
  assert.equal(locationLabel({ kind: 'DOCUMENT', location: 'Nhà › Hóa đơn' }), 'Nhà › Hóa đơn');
  assert.equal(locationLabel({ kind: 'DOCUMENT', location: null }), 'Chưa phân loại');
  assert.equal(locationLabel({ kind: 'FOLDER', location: null }), 'Cấp ngoài cùng');
});

test('the restore message says where the item went and whether its name changed', () => {
  const result = (patch: Partial<RestoreResult>): RestoreResult => ({ kind: 'DOCUMENT', name: 'Hợp đồng', renamed: false, moved: false, folderId: null, location: null, ...patch });
  assert.equal(restoreMessage(result({ location: 'Nhà' })), 'Đã khôi phục tài liệu về “Nhà”.');
  assert.equal(restoreMessage(result({})), 'Đã khôi phục tài liệu về “Chưa phân loại”.');
  assert.equal(restoreMessage(result({ renamed: true, name: 'Hợp đồng (2)', location: 'Nhà' })), 'Đã khôi phục tài liệu về “Nhà”, lưu với tên “Hợp đồng (2)” vì ở đó đã có tên trùng.');
  assert.equal(restoreMessage(result({ moved: true })), 'Thư mục cũ không còn nên tài liệu được đưa về “Chưa phân loại”.');
  assert.equal(restoreMessage(result({ kind: 'FOLDER', name: 'Nhà' })), 'Đã khôi phục thư mục về cấp ngoài cùng.');
  assert.equal(restoreMessage(result({ kind: 'FOLDER', moved: true, location: 'Gốc' })), 'Thư mục cũ không còn nên thư mục được đưa về “Gốc”.');
  assert.equal(restoreMessage(result({ kind: 'ORIGINAL' })), 'Đã khôi phục bản gốc của “Hợp đồng”; xem và tải lại được ngay.');
  assert.equal(restoreMessage(result({ kind: 'ORIGINAL', inTrash: true })), 'Đã khôi phục bản gốc của “Hợp đồng”, nhưng tài liệu này vẫn đang nằm trong thùng rác; hãy khôi phục cả tài liệu để xem được.');
});

test('a folder about to be deleted counts every subfolder and document inside', () => {
  const folders = [
    { id: 'home', parentId: null, documentCount: 1 }, { id: 'bills', parentId: 'home', documentCount: 2 }, { id: 'y2026', parentId: 'bills', documentCount: 4 },
    { id: 'other', parentId: null, documentCount: 8 },
  ];
  assert.deepEqual(folderContents(folders, 'home'), { folders: 2, documents: 7 });
  assert.deepEqual(folderContents(folders, 'y2026'), { folders: 0, documents: 4 });
  assert.deepEqual(folderContents([{ id: 'a', parentId: 'b', documentCount: 1 }, { id: 'b', parentId: 'a', documentCount: 1 }], 'a'), { folders: 1, documents: 2 });
});

test('undo picks exactly the trash items of what was just deleted', () => {
  const entry = (id: string, kind: TrashEntry['kind'], documentId: string | null, folderId: string | null): TrashEntry => ({
    id, kind, documentId, folderId, name: id, location: null, documentCount: 0, folderCount: 0, deletedAt: '2026-11-13T00:00:00.000Z', expiresAt: '2026-12-13T00:00:00.000Z',
  });
  const entries = [entry('t1', 'DOCUMENT', 'd1', null), entry('t2', 'ORIGINAL', 'd1', null), entry('t3', 'DOCUMENT', 'd2', null), entry('t4', 'FOLDER', null, 'f1'), entry('t5', 'DOCUMENT', 'd3', null)];
  const ids = (kind: TrashEntry['kind'], targets: string[]) => undoTargets(entries, { kind, ids: targets }).map((item) => item.id);
  assert.deepEqual(ids('DOCUMENT', ['d1', 'd3']), ['t1', 't5']);
  assert.deepEqual(ids('ORIGINAL', ['d1']), ['t2']);
  assert.deepEqual(ids('FOLDER', ['f1']), ['t4']);
  assert.deepEqual(ids('FOLDER', ['d1']), [], 'a document id never matches a folder item');
  assert.deepEqual(ids('DOCUMENT', []), []);
});
