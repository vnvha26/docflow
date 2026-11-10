import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canViewOriginal, DOCX_MIME, fileTypeLabel, formatBytes, infoLine, isChanging, isProcessing, matchesFilters, MAX_UPLOAD_BYTES, precheck, problemMessage,
} from './documents.ts';
import type { DocumentFilters, DocumentStatus, DocumentStatusFilter, DocumentSummary, DocumentTypeFilter } from './documents.ts';

const doc = (patch: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id: '00000000-0000-4000-8000-000000000001', title: 'Hợp đồng', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
  typeCode: null, status: 'SUCCEEDED', problem: null, file: { name: 'a.pdf', mimeType: 'application/pdf', byteSize: 1000 },
  originalAvailable: true, originalDeleting: false, pageCount: null, summary: null, detailsDeleted: false, ...patch,
});
const file = (mimeType: string) => ({ name: 'a', mimeType, byteSize: 1 });
const STATUSES: DocumentStatus[] = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNSUPPORTED'];

test('filters: each status filter picks exactly the states the server picks', () => {
  const expected: Record<DocumentStatusFilter, { kept: DocumentStatus[]; deleted: DocumentStatus[] }> = {
    read: { kept: ['SUCCEEDED'], deleted: [] },
    processing: { kept: ['PENDING', 'PROCESSING'], deleted: ['PENDING', 'PROCESSING'] },
    problem: { kept: ['FAILED', 'UNSUPPORTED'], deleted: [] },
    'details-deleted': { kept: [], deleted: STATUSES },
  };
  for (const [status, { kept, deleted }] of Object.entries(expected) as [DocumentStatusFilter, typeof expected.read][]) {
    assert.deepEqual(STATUSES.filter((state) => matchesFilters(doc({ status: state }), { status })), kept, `${status}, details kept`);
    assert.deepEqual(STATUSES.filter((state) => matchesFilters(doc({ status: state, detailsDeleted: true }), { status })), deleted, `${status}, details deleted`);
  }
});

test('filters: type and status combine; no filter keeps everything', () => {
  const mimes: Record<DocumentTypeFilter, string> = { pdf: 'application/pdf', docx: DOCX_MIME, txt: 'text/plain' };
  for (const [type, mimeType] of Object.entries(mimes) as [DocumentTypeFilter, string][]) {
    for (const other of Object.values(mimes)) {
      assert.equal(matchesFilters(doc({ file: file(other) }), { type }), other === mimeType, `${type} vs ${other}`);
    }
  }
  const empty: DocumentFilters = {};
  for (const status of STATUSES) assert.equal(matchesFilters(doc({ status, detailsDeleted: status === 'FAILED' }), empty), true);
  assert.equal(matchesFilters(doc({ file: file(DOCX_MIME), status: 'SUCCEEDED' }), { type: 'docx', status: 'read' }), true);
  assert.equal(matchesFilters(doc({ file: file(DOCX_MIME), status: 'FAILED' }), { type: 'docx', status: 'read' }), false);
  assert.equal(matchesFilters(doc({ file: file('text/plain'), status: 'SUCCEEDED' }), { type: 'docx', status: 'read' }), false);
  assert.equal(matchesFilters(doc({ file: file('image/png') }), { type: 'pdf' }), false);
});

test('info line: type, pages and reading state; a deleted detail layer replaces the state', () => {
  assert.equal(infoLine(doc({ pageCount: 25 })), 'PDF · 25 trang · Đã đọc nội dung');
  assert.equal(infoLine(doc({ file: file(DOCX_MIME), status: 'PENDING' })), 'DOCX · Chờ đọc nội dung');
  assert.equal(infoLine(doc({ file: file('text/plain'), status: 'PROCESSING', pageCount: 0 })), 'TXT · Đang đọc nội dung');
  assert.equal(infoLine(doc({ status: 'UNSUPPORTED' })), 'PDF · Không đọc được');
  assert.equal(infoLine(doc({ status: 'FAILED', detailsDeleted: true, pageCount: 2 })), 'PDF · 2 trang · Đã xóa bản chi tiết');
  assert.match(infoLine(doc({ pageCount: 1200 })), /^PDF · 1[.\s ]?200 trang · /);
  assert.equal(fileTypeLabel(doc({ file: file('image/png') })), 'TỆP');
});

test('problem message: only for unread files whose details are kept; unknown codes get a general hint', () => {
  assert.equal(problemMessage(doc()), null);
  assert.equal(problemMessage(doc({ status: 'PENDING', problem: 'NO_TEXT_LAYER' })), null);
  assert.match(problemMessage(doc({ status: 'UNSUPPORTED', problem: 'NO_TEXT_LAYER' })) ?? '', /ảnh scan/);
  assert.match(problemMessage(doc({ status: 'UNSUPPORTED', problem: 'SOMETHING_NEW' })) ?? '', /^Không đọc được nội dung/);
  assert.match(problemMessage(doc({ status: 'FAILED', problem: null })) ?? '', /Tải lại đúng tệp này/);
  assert.match(problemMessage(doc({ status: 'FAILED', problem: 'SOURCE_UNAVAILABLE' })) ?? '', /Bản tạm/);
  assert.equal(problemMessage(doc({ status: 'FAILED', problem: 'DETAILS_DELETED', detailsDeleted: true })), null);
  assert.equal(problemMessage(doc({ status: 'UNSUPPORTED', problem: 'NO_TEXT_LAYER', detailsDeleted: true })), null);
});

test('the page keeps asking while a file is being read or its original is being deleted', () => {
  assert.deepEqual(STATUSES.filter((status) => isProcessing({ status })), ['PENDING', 'PROCESSING']);
  assert.equal(isChanging(doc()), false);
  assert.equal(isChanging(doc({ status: 'PENDING' })), true);
  assert.equal(isChanging(doc({ originalDeleting: true })), true);
});

test('the original can be viewed only while it is stored and the type has a viewer', () => {
  for (const mimeType of ['application/pdf', 'text/plain', DOCX_MIME]) {
    assert.equal(canViewOriginal(doc({ file: file(mimeType) })), true, mimeType);
    assert.equal(canViewOriginal(doc({ file: file(mimeType), originalAvailable: false })), false, mimeType);
  }
  assert.equal(canViewOriginal(doc({ file: file('image/png') })), false);
});

test('precheck: extension, emptiness and the size limit, with the limit itself allowed', () => {
  const pick = (name: string, size: number) => ({ name, size }) as File;
  assert.equal(precheck(pick('hop-dong.pdf', 10)), null);
  assert.equal(precheck(pick('HOP-DONG.DOCX', 10)), null);
  assert.equal(precheck(pick('ghi.chu.txt', MAX_UPLOAD_BYTES)), null);
  assert.equal(precheck(pick('anh.png', 10)), 'Chỉ hỗ trợ tệp PDF, DOCX và TXT.');
  assert.equal(precheck(pick('pdf', 10)), 'Chỉ hỗ trợ tệp PDF, DOCX và TXT.');
  assert.equal(precheck(pick('khong-duoi', 10)), 'Chỉ hỗ trợ tệp PDF, DOCX và TXT.');
  assert.equal(precheck(pick('rong.txt', 0)), 'Tệp rỗng, không có gì để lưu.');
  assert.equal(precheck(pick('to.pdf', MAX_UPLOAD_BYTES + 1)), 'Tệp vượt quá 50 MB.');
});

test('sizes are shown in the nearest unit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20 * 1024), '20 KB');
  assert.equal(formatBytes(150e6), '143.1 MB');
  assert.equal(formatBytes(1024 ** 3), '1.00 GB');
});
