import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToAll, choiceLabel, defaultChoice, sha256Hex, situationText } from './duplicates.ts';
import type { DuplicateCheck, DuplicateChoice, DuplicateMatch } from './duplicates.ts';

const match = (patch: Partial<DuplicateMatch> = {}): DuplicateMatch => ({
  documentId: 'd1', title: 'Hợp đồng thuê nhà', folderId: 'f1', location: 'Nhà › Hợp đồng', state: 'full', sameFolder: true, trashId: null, ...patch,
});
const check = (primary: DuplicateMatch, options: DuplicateChoice[], others: DuplicateMatch[] = []): DuplicateCheck => ({ situation: 'ask', primary, matches: [primary, ...others], options });

test('the browser hash is the lowercase hex SHA-256 the server compares against', async () => {
  assert.equal(await sha256Hex(new Blob(['abc'])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new Blob([])), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('the safest choice is preselected: restore or supplement when offered, otherwise do not upload', () => {
  assert.equal(defaultChoice({ options: ['new', 'skip'] }), 'skip');
  assert.equal(defaultChoice({ options: ['supplement', 'new', 'skip'] }), 'supplement');
  assert.equal(defaultChoice({ options: ['restore', 'new', 'skip'] }), 'restore');
});

test('each situation is described with the document and where it is', () => {
  assert.equal(situationText(check(match(), ['new', 'skip'])), 'Tệp này đã có: “Hợp đồng thuê nhà” ngay trong thư mục này.');
  assert.equal(situationText(check(match({ sameFolder: false }), ['new', 'skip'])), 'Tệp này đã có: “Hợp đồng thuê nhà” ở “Nhà › Hợp đồng”.');
  assert.equal(situationText(check(match({ sameFolder: false, location: null }), ['new', 'skip'])), 'Tệp này đã có: “Hợp đồng thuê nhà” ở “Chưa phân loại”.');
  assert.match(situationText(check(match({ state: 'no-original', sameFolder: false }), ['supplement', 'new', 'skip'])), /không còn bản gốc\.$/);
  assert.match(situationText(check(match({ state: 'trashed', trashId: 't1' }), ['restore', 'new', 'skip'])), /đang nằm trong thùng rác \(vị trí cũ: “Nhà › Hợp đồng”\)\.$/);
  assert.match(situationText(check(match({ state: 'original-trashed', trashId: 't1' }), ['restore', 'new', 'skip'])), /^Bản gốc của “Hợp đồng thuê nhà” \(ngay trong thư mục này\)/);
  const inFolder = check(match({ state: 'trashed', trashId: 't9', trashFolder: 'Nhà cũ' }), ['restore', 'new', 'skip']);
  assert.equal(situationText(inFolder), 'Tài liệu “Hợp đồng thuê nhà” có cùng nội dung nằm trong thư mục “Nhà cũ” đang ở thùng rác; khôi phục sẽ trả lại cả thư mục đó.');
  assert.equal(choiceLabel('restore', inFolder), 'Khôi phục thư mục “Nhà cũ” từ thùng rác');
  const several = check(match(), ['new', 'skip'], [match({ documentId: 'd2', title: 'Bản sao', location: null }), match({ documentId: 'd3', title: 'Cũ', state: 'trashed' })]);
  assert.match(situationText(several), /Cũng có ở: “Bản sao” \(Chưa phân loại\), “Cũ” \(thùng rác\)\.$/);
});

test('choices are labelled for the situation', () => {
  const full = check(match(), ['new', 'skip']);
  assert.deepEqual(full.options.map((option) => choiceLabel(option, full)), ['Tải mới', 'Không tải']);
  const lost = check(match({ state: 'no-original', sameFolder: false }), ['supplement', 'new', 'skip']);
  assert.deepEqual(lost.options.map((option) => choiceLabel(option, lost)), ['Bổ sung bản gốc cho “Hợp đồng thuê nhà” ở “Nhà › Hợp đồng”', 'Tải mới vào đây', 'Không tải']);
  assert.equal(choiceLabel('restore', check(match({ state: 'trashed' }), ['restore', 'new', 'skip'])), 'Khôi phục từ thùng rác');
});

test('"apply to all" only changes the files that offer that choice', () => {
  const questions = [
    { key: 'a', check: { options: ['new', 'skip'] as DuplicateChoice[] } },
    { key: 'b', check: { options: ['restore', 'new', 'skip'] as DuplicateChoice[] } },
    { key: 'c', check: { options: ['supplement', 'new', 'skip'] as DuplicateChoice[] } },
  ];
  const current: Record<string, DuplicateChoice> = { a: 'skip', b: 'restore', c: 'supplement' };
  assert.deepEqual(applyToAll(questions, 'new', current), { a: 'new', b: 'new', c: 'new' });
  assert.deepEqual(applyToAll(questions, 'restore', current), { a: 'skip', b: 'restore', c: 'supplement' });
  assert.deepEqual(applyToAll(questions, 'skip', { a: 'new', b: 'new', c: 'new' }), { a: 'skip', b: 'skip', c: 'skip' });
  assert.deepEqual(current, { a: 'skip', b: 'restore', c: 'supplement' }, 'the current choices are not mutated');
});
