import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxBetween, edgeScroll, mergeSelection, movedEnough, shiftBox, touches } from './marquee.ts';

test('the box is the same whichever corner the drag started from', () => {
  const expected = { left: 10, top: 20, width: 90, height: 60 };
  assert.deepEqual(boxBetween({ x: 10, y: 20 }, { x: 100, y: 80 }), expected);
  assert.deepEqual(boxBetween({ x: 100, y: 80 }, { x: 10, y: 20 }), expected);
  assert.deepEqual(boxBetween({ x: 100, y: 20 }, { x: 10, y: 80 }), expected);
  assert.deepEqual(shiftBox(expected, -5, -300), { left: 5, top: -280, width: 90, height: 60 });
});

test('a small wobble is still a click, not a selection drag', () => {
  assert.equal(movedEnough({ x: 0, y: 0 }, { x: 3, y: 3 }), false);
  assert.equal(movedEnough({ x: 0, y: 0 }, { x: 0, y: 6 }), true);
  assert.equal(movedEnough({ x: 10, y: 10 }, { x: 5, y: 6 }), true);
});

test('a row is hit when the box overlaps or just touches it', () => {
  const row = { left: 100, top: 100, width: 400, height: 60 };
  assert.equal(touches({ left: 0, top: 0, width: 50, height: 50 }, row), false);
  assert.equal(touches({ left: 0, top: 0, width: 100, height: 100 }, row), true);
  assert.equal(touches({ left: 300, top: 120, width: 0, height: 0 }, row), true);
  assert.equal(touches({ left: 0, top: 161, width: 900, height: 40 }, row), false);
  assert.equal(touches({ left: 501, top: 0, width: 50, height: 900 }, row), false);
  assert.equal(touches({ left: 0, top: 0, width: 900, height: 900 }, row), true);
});

test('holding Ctrl or Shift adds to the selection without duplicates', () => {
  assert.deepEqual(mergeSelection([], ['b', 'c']), ['b', 'c']);
  assert.deepEqual(mergeSelection(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(mergeSelection(['a'], []), ['a']);
});

test('the page scrolls only while the pointer is near the top or bottom edge', () => {
  assert.ok(edgeScroll(10, 800) < 0);
  assert.equal(edgeScroll(400, 800), 0);
  assert.ok(edgeScroll(790, 800) > 0);
});
