import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUploads } from './upload-summary.ts';
import type { UploadItem, UploadState } from './upload-summary.ts';

const item = (name: string, state: UploadState, message?: string, savedAs?: string): UploadItem => ({ key: name, name, state, message, savedAs });

test('one file: the result names the file', () => {
  assert.equal(summarizeUploads([]), null);
  assert.deepEqual(summarizeUploads([item('hop-dong.pdf', 'uploading')]), { tone: 'busy', text: 'Đang tải lên “hop-dong.pdf”…', details: [] });
  assert.deepEqual(summarizeUploads([item('hop-dong.pdf', 'done')]), { tone: 'done', text: 'Đã tải lên tệp “hop-dong.pdf”.', details: [] });
  assert.equal(summarizeUploads([item('hop-dong.pdf', 'duplicate')])?.text, 'Không tải “hop-dong.pdf” vì đã có trong thư viện.');
  assert.deepEqual(summarizeUploads([item('anh.png', 'error', 'Chỉ hỗ trợ tệp PDF, DOCX và TXT.')]),
    { tone: 'error', text: 'Không tải lên được “anh.png”: Chỉ hỗ trợ tệp PDF, DOCX và TXT.', details: [] });
});

test('a file saved under another name says which name', () => {
  assert.equal(summarizeUploads([item('hop-dong.pdf', 'done', undefined, 'hop-dong (2)')])?.text,
    'Đã tải lên tệp “hop-dong.pdf”, lưu với tên “hop-dong (2)” vì tên này đã có trong thư mục.');
  assert.deepEqual(summarizeUploads([item('a.pdf', 'done', undefined, 'a (2)'), item('b.pdf', 'done'), item('c.png', 'error', 'Sai loại.')]), {
    tone: 'warn', text: 'Đã tải lên 2 tệp · 1 tệp lỗi.', details: ['“c.png”: Sai loại.', '“a.pdf”: lưu với tên “a (2)” vì tên đã có trong thư mục.'],
  });
  assert.equal(summarizeUploads([item('a.pdf', 'done', undefined, 'a (2)'), item('b.pdf', 'done')])?.tone, 'done');
});

test('several files: progress while uploading, then counts with the reason for each failure', () => {
  assert.equal(summarizeUploads([item('a', 'done'), item('b', 'uploading'), item('c', 'waiting')])?.text, 'Đang tải lên 2/3 tệp…');
  assert.deepEqual(summarizeUploads([item('a', 'done'), item('b', 'done')]), { tone: 'done', text: 'Đã tải lên 2 tệp.', details: [] });
  assert.deepEqual(summarizeUploads([item('a', 'done'), item('b', 'duplicate'), item('c', 'error', 'Tệp vượt quá 50 MB.')]), {
    tone: 'warn', text: 'Đã tải lên 1 tệp · bỏ qua 1 tệp đã có · 1 tệp lỗi.', details: ['“c”: Tệp vượt quá 50 MB.'],
  });
  assert.deepEqual(summarizeUploads([item('a', 'error', 'Lỗi 1'), item('b', 'error')]), {
    tone: 'error', text: 'Không tải lên được 2 tệp.', details: ['“a”: Lỗi 1', '“b”: Chưa thể tải lên. Vui lòng thử lại.'],
  });
});

test('duplicates: waiting for a choice, then supplemented, restored or skipped', () => {
  const asking: UploadItem = { key: 'a', name: 'a.pdf', state: 'asking' };
  assert.deepEqual(summarizeUploads([asking]), { tone: 'warn', text: 'Tệp “a.pdf” đã có trong thư viện; đang chờ bạn chọn cách xử lý.', details: [] });
  assert.equal(summarizeUploads([asking, item('b', 'done'), { ...asking, key: 'c', name: 'c.pdf' }])?.text, '2 tệp đã có trong thư viện; đang chờ bạn chọn cách xử lý.');
  assert.equal(summarizeUploads([asking, item('b', 'uploading')])?.tone, 'busy', 'uploads still running come first');
  assert.equal(summarizeUploads([{ key: 'a', name: 'a.pdf', state: 'supplemented', target: 'Hợp đồng' }])?.text, 'Đã bổ sung bản gốc cho “Hợp đồng”.');
  assert.equal(summarizeUploads([{ key: 'a', name: 'a.pdf', state: 'restored', target: 'Hợp đồng' }])?.text, 'Đã khôi phục “Hợp đồng” từ thùng rác, không cần tải lại.');
  assert.deepEqual(summarizeUploads([
    item('a', 'done'), { key: 'b', name: 'b.pdf', state: 'supplemented', target: 'Hợp đồng' }, { key: 'c', name: 'c.pdf', state: 'restored', target: 'Hóa đơn' }, item('d', 'duplicate'),
  ]), {
    tone: 'done', text: 'Đã tải lên 1 tệp · bổ sung bản gốc cho 1 tài liệu · khôi phục 1 mục từ thùng rác · bỏ qua 1 tệp đã có.',
    details: ['“b.pdf”: bổ sung bản gốc cho “Hợp đồng”.', '“c.pdf”: khôi phục “Hóa đơn” từ thùng rác.'],
  });
  assert.equal(summarizeUploads([item('a', 'duplicate'), item('b', 'duplicate')])?.text, 'Bỏ qua 2 tệp đã có.');
});
