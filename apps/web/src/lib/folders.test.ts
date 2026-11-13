import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCreateIn, childrenOf, depthOf, flattenTree, folderNameProblem, heightOf, moveProblem, pathLabel, pathOf } from './folders.ts';
import type { Folder } from './folders.ts';

const folder = (id: string, parentId: string | null, name = id): Folder => ({
  id, parentId, name, purpose: null, documentCount: 0, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
});
const tree = [
  folder('home', null, 'Nhà Cầu Giấy'), folder('bills', 'home', 'Hóa đơn'), folder('y2026', 'bills', '2026'), folder('q4', 'y2026', 'Quý 4'),
  folder('t10', 'q4', 'Tháng 10'), folder('contracts', 'home', 'Hợp đồng'), folder('bike', null, 'Xe máy'), folder('work', null, 'công việc'),
  folder('a10', 'bike', 'Ảnh 10'), folder('a2', 'bike', 'Ảnh 2'),
];

test('folders are listed as a tree, siblings in Vietnamese alphabetical order with numbers by value', () => {
  assert.deepEqual(childrenOf(tree, null).map((item) => item.name), ['công việc', 'Nhà Cầu Giấy', 'Xe máy']);
  assert.deepEqual(childrenOf(tree, 'bike').map((item) => item.name), ['Ảnh 2', 'Ảnh 10']);
  assert.deepEqual(flattenTree(tree).map((row) => `${row.depth}:${row.folder.id}`),
    ['1:work', '1:home', '2:bills', '3:y2026', '4:q4', '5:t10', '2:contracts', '1:bike', '2:a2', '2:a10']);
});

test('a path runs from the outermost folder to the folder itself', () => {
  assert.deepEqual(pathOf(tree, 'q4').map((item) => item.id), ['home', 'bills', 'y2026', 'q4']);
  assert.deepEqual(pathOf(tree, null), []);
  assert.deepEqual(pathOf(tree, 'missing'), []);
  assert.equal(pathLabel(tree, 'bills'), 'Nhà Cầu Giấy › Hóa đơn');
  assert.equal(depthOf(tree, 't10'), 5);
  assert.deepEqual(['home', 'bills', 't10', 'bike'].map((id) => heightOf(tree, id)), [4, 3, 0, 1]);
});

test('a new folder is allowed down to level 5 only', () => {
  assert.equal(canCreateIn(tree, null), true);
  assert.equal(canCreateIn(tree, 'q4'), true);
  assert.equal(canCreateIn(tree, 't10'), false);
});

test('moving a folder: never into itself or below itself, and the whole subtree must fit in 5 levels', () => {
  assert.match(moveProblem(tree, 'home', 'home') ?? '', /chính nó/);
  assert.match(moveProblem(tree, 'home', 'q4') ?? '', /chính nó/);
  assert.match(moveProblem(tree, 'bike', 'q4') ?? '', /5 cấp/);
  assert.match(moveProblem(tree, 'home', 'work') ?? '', /5 cấp/);
  assert.equal(moveProblem(tree, 'bike', 'y2026'), null);
  assert.equal(moveProblem(tree, 'bills', null), null);
  assert.equal(moveProblem(tree, 'contracts', 'q4'), null);
  assert.match(moveProblem(tree, 'contracts', 't10') ?? '', /5 cấp/);
});

test('a broken parent loop from the server cannot hang the page', () => {
  const loop = [folder('a', 'b'), folder('b', 'a')];
  assert.ok(pathOf(loop, 'a').length <= 3);
  assert.deepEqual(flattenTree(loop), []);
  assert.ok(heightOf(loop, 'a') <= 3);
});

test('folder names: required, at most 100 characters, no slashes', () => {
  assert.equal(folderNameProblem('  Nhà Cầu Giấy '), null);
  assert.equal(folderNameProblem('x'.repeat(100)), null);
  assert.equal(folderNameProblem('   '), 'Nhập tên thư mục.');
  assert.match(folderNameProblem('x'.repeat(101)) ?? '', /100 ký tự/);
  assert.match(folderNameProblem('a/b') ?? '', /\//);
  assert.match(folderNameProblem('a\\b') ?? '', /\//);
});
