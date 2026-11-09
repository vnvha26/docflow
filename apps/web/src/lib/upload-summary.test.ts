import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUploads } from './upload-summary.ts';
import type { UploadItem, UploadState } from './upload-summary.ts';

const item = (name: string, state: UploadState, message?: string): UploadItem => ({ key: name, name, state, message });

test('one file: the result names the file', () => {
  assert.equal(summarizeUploads([]), null);
  assert.deepEqual(summarizeUploads([item('hop-dong.pdf', 'uploading')]), { tone: 'busy', text: 'Đang tải lên “hop-dong.pdf”…', details: [] });
  assert.deepEqual(summarizeUploads([item('hop-dong.pdf', 'done')]), { tone: 'done', text: 'Đã tải lên tệp “hop-dong.pdf”.', details: [] });
  assert.equal(summarizeUploads([item('hop-dong.pdf', 'duplicate')])?.text, 'Tệp “hop-dong.pdf” đã có sẵn trong thư viện, không lưu thêm.');
  assert.deepEqual(summarizeUploads([item('anh.png', 'error', 'Chỉ hỗ trợ tệp PDF, DOCX và TXT.')]),
    { tone: 'error', text: 'Không tải lên được “anh.png”: Chỉ hỗ trợ tệp PDF, DOCX và TXT.', details: [] });
});

test('several files: progress while uploading, then counts with the reason for each failure', () => {
  assert.equal(summarizeUploads([item('a', 'done'), item('b', 'uploading'), item('c', 'waiting')])?.text, 'Đang tải lên 2/3 tệp…');
  assert.deepEqual(summarizeUploads([item('a', 'done'), item('b', 'done')]), { tone: 'done', text: 'Đã tải lên 2 tệp.', details: [] });
  assert.deepEqual(summarizeUploads([item('a', 'done'), item('b', 'duplicate'), item('c', 'error', 'Tệp vượt quá 50 MB.')]), {
    tone: 'warn', text: 'Đã tải lên 1 tệp · 1 tệp đã có sẵn · 1 tệp lỗi.', details: ['“c”: Tệp vượt quá 50 MB.'],
  });
  assert.deepEqual(summarizeUploads([item('a', 'error', 'Lỗi 1'), item('b', 'error')]), {
    tone: 'error', text: 'Không tải lên được 2 tệp.', details: ['“a”: Lỗi 1', '“b”: Chưa thể tải lên. Vui lòng thử lại.'],
  });
});
