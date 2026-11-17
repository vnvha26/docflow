import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canViewOriginal, DOCX_MIME, fileTypeLabel, formatBytes, infoLine, isChanging, isProcessing, matchesFilters, MAX_UPLOAD_BYTES, precheck, problemMessage,
  titleProblem,
} from './documents.ts';
import type { DocumentFilters, DocumentStatus, DocumentSummary, DocumentTypeFilter } from './documents.ts';

const doc = (patch: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id: '00000000-0000-4000-8000-000000000001', title: 'Hợp đồng', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
  typeCode: null, folderId: null, status: 'SUCCEEDED', problem: null, file: { name: 'a.pdf', mimeType: 'application/pdf', byteSize: 1000 },
  originalAvailable: true, originalDeleting: false, pageCount: null, summary: null, originalInTrash: false, ...patch,
});
const file = (mimeType: string) => ({ name: 'a', mimeType, byteSize: 1 });
const STATUSES: DocumentStatus[] = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNSUPPORTED'];

test('filters: by file type; no filter keeps everything', () => {
  const mimes: Record<DocumentTypeFilter, string[]> = {
    pdf: ['application/pdf'], docx: [DOCX_MIME], txt: ['text/plain'], md: ['text/markdown'], image: ['image/png', 'image/jpeg', 'image/webp'],
  };
  for (const [type, own] of Object.entries(mimes) as [DocumentTypeFilter, string[]][]) {
    for (const other of Object.values(mimes).flat()) {
      assert.equal(matchesFilters(doc({ file: file(other) }), { type }), own.includes(other), `${type} vs ${other}`);
    }
  }
  const empty: DocumentFilters = {};
  for (const status of STATUSES) assert.equal(matchesFilters(doc({ status }), empty), true);
  assert.equal(matchesFilters(doc({ file: file('image/png') }), { type: 'pdf' }), false);
});

test('info line: type, pages, then size once read or the reading state; a missing original is flagged', () => {
  assert.equal(infoLine(doc({ pageCount: 3, file: { name: 'a.pdf', mimeType: 'application/pdf', byteSize: 1258291 } })), 'PDF · 3 trang · 1,2 MB');
  assert.equal(infoLine(doc({ file: file(DOCX_MIME), status: 'PENDING' })), 'DOCX · Chờ đọc nội dung…');
  assert.equal(infoLine(doc({ file: file('text/plain'), status: 'PROCESSING', pageCount: 0 })), 'TXT · Đang đọc nội dung…');
  assert.equal(infoLine(doc({ status: 'UNSUPPORTED' })), 'PDF · Không đọc được');
  assert.equal(infoLine(doc({ pageCount: 2, originalAvailable: false, originalInTrash: true })), 'PDF · 2 trang · 1000 B · Bản gốc trong thùng rác');
  assert.equal(infoLine(doc({ pageCount: 2, originalAvailable: false })), 'PDF · 2 trang · 1000 B · Không còn bản gốc');
  assert.equal(infoLine(doc({ originalAvailable: false, originalDeleting: true })), 'PDF · 1000 B', 'still being deleted: the page shows that separately');
  assert.equal(infoLine(doc({ status: 'PENDING', originalAvailable: false })), 'PDF · Chờ đọc nội dung…');
  assert.match(infoLine(doc({ pageCount: 1200 })), /^PDF · 1[.\s ]?200 trang · /);
  assert.equal(fileTypeLabel(doc({ file: file('application/zip') })), 'TỆP');
  assert.equal(infoLine(doc({ file: { name: 'a.md', mimeType: 'text/markdown', byteSize: 2048 } })), 'Markdown · 2,0 KB');
  assert.equal(infoLine(doc({ file: { name: 'a.jpg', mimeType: 'image/jpeg', byteSize: 2048 }, status: 'UNSUPPORTED', problem: 'IMAGE_NO_TEXT' })), 'Ảnh JPG · 2,0 KB',
    'an image is not an error: it simply has no text yet');
});

test('problem message: only for unread files whose details are kept; unknown codes get a general hint', () => {
  assert.equal(problemMessage(doc()), null);
  assert.equal(problemMessage(doc({ status: 'PENDING', problem: 'NO_TEXT_LAYER' })), null);
  assert.match(problemMessage(doc({ status: 'UNSUPPORTED', problem: 'NO_TEXT_LAYER' })) ?? '', /ảnh scan/);
  assert.match(problemMessage(doc({ status: 'UNSUPPORTED', problem: 'SOMETHING_NEW' })) ?? '', /^Không đọc được nội dung/);
  assert.match(problemMessage(doc({ status: 'FAILED', problem: null })) ?? '', /Tải lại đúng tệp này/);
  assert.match(problemMessage(doc({ status: 'FAILED', problem: 'SOURCE_UNAVAILABLE' })) ?? '', /Bản tạm/);
  assert.equal(problemMessage(doc({ status: 'UNSUPPORTED', problem: 'IMAGE_NO_TEXT', file: file('image/png') })), null);
});

test('the page keeps asking while a file is being read or its original is being deleted', () => {
  assert.deepEqual(STATUSES.filter((status) => isProcessing({ status })), ['PENDING', 'PROCESSING']);
  assert.equal(isChanging(doc()), false);
  assert.equal(isChanging(doc({ status: 'PENDING' })), true);
  assert.equal(isChanging(doc({ originalDeleting: true })), true);
});

test('the original can be viewed only while it is stored and the type has a viewer', () => {
  for (const mimeType of ['application/pdf', 'text/plain', 'text/markdown', DOCX_MIME, 'image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(canViewOriginal(doc({ file: file(mimeType) })), true, mimeType);
    assert.equal(canViewOriginal(doc({ file: file(mimeType), originalAvailable: false })), false, mimeType);
  }
  assert.equal(canViewOriginal(doc({ file: file('image/svg+xml') })), false);
});

test('precheck: extension, emptiness and the size limit, with the limit itself allowed', () => {
  const pick = (name: string, size: number) => ({ name, size }) as File;
  assert.equal(precheck(pick('hop-dong.pdf', 10)), null);
  assert.equal(precheck(pick('HOP-DONG.DOCX', 10)), null);
  assert.equal(precheck(pick('ghi.chu.txt', MAX_UPLOAD_BYTES)), null);
  for (const name of ['anh.png', 'ANH.JPEG', 'a.jpg', 'a.webp', 'ghi-chu.md', 'readme.markdown']) assert.equal(precheck(pick(name, 10)), null, name);
  assert.equal(precheck(pick('logo.svg', 10)), 'Chỉ hỗ trợ tệp PDF, DOCX, TXT, Markdown và ảnh PNG, JPG, WebP.');
  assert.equal(precheck(pick('bang.xlsx', 10)), 'Chỉ hỗ trợ tệp PDF, DOCX, TXT, Markdown và ảnh PNG, JPG, WebP.');
  assert.equal(precheck(pick('pdf', 10)), 'Chỉ hỗ trợ tệp PDF, DOCX, TXT, Markdown và ảnh PNG, JPG, WebP.');
  assert.equal(precheck(pick('khong-duoi', 10)), 'Chỉ hỗ trợ tệp PDF, DOCX, TXT, Markdown và ảnh PNG, JPG, WebP.');
  assert.equal(precheck(pick('rong.txt', 0)), 'Tệp rỗng, không có gì để lưu.');
  assert.equal(precheck(pick('to.pdf', MAX_UPLOAD_BYTES + 1)), 'Tệp vượt quá 50 MB.');
});

test('sizes are shown in the nearest unit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(20 * 1024), '20 KB');
  assert.equal(formatBytes(150e6), '143,1 MB');
  assert.equal(formatBytes(1024 ** 3), '1,00 GB');
});

test('filters: a folder view keeps only that folder, "none" only unfiled documents', () => {
  const inside = doc({ folderId: 'f1' });
  assert.equal(matchesFilters(inside, { folder: 'f1' }), true);
  assert.equal(matchesFilters(inside, { folder: 'f2' }), false);
  assert.equal(matchesFilters(inside, { folder: 'none' }), false);
  assert.equal(matchesFilters(doc(), { folder: 'none' }), true);
  assert.equal(matchesFilters(doc(), { folder: 'f1' }), false);
  assert.equal(matchesFilters(inside, {}), true);
  assert.equal(matchesFilters(inside, { folder: 'f1', type: 'docx' }), false);
});

test('a document name must not be blank or longer than 255 characters', () => {
  assert.equal(titleProblem('Hợp đồng'), null);
  assert.equal(titleProblem('x'.repeat(255)), null);
  assert.equal(titleProblem('   '), 'Nhập tên tài liệu.');
  assert.equal(titleProblem('x'.repeat(256)), 'Tên tài liệu không được vượt quá 255 ký tự.');
});
