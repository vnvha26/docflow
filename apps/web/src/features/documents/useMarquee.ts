import { useEffect, useRef, useState } from 'react';
import { boxBetween, edgeScroll, mergeSelection, movedEnough, shiftBox, touches } from '../../lib/marquee';
import type { Box, Point } from '../../lib/marquee';

const BLOCKED = 'button, a, input, select, textarea, label, summary, details, dialog, .folder-pane, .document-type, .document-info';
const AREA = '.account-main';
const ROW = '[data-document-id]';
const KEEPS = '.document-list, .bulk-bar';

function mayStart(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(AREA)) && !target.closest(BLOCKED);
}

export function useMarquee(enabled: boolean, selected: readonly string[], apply: (ids: string[]) => void) {
  const [box, setBox] = useState<Box | null>(null);
  const armed = useRef(false);
  const latest = useRef({ selected, apply });
  latest.current = { selected, apply };

  useEffect(() => {
    if (!enabled) return;
    let start: Point | null = null;
    let pointer: Point = { x: 0, y: 0 };
    let original: string[] = [];
    let base: string[] = [];
    let active = false;
    let outside = false;
    let frame = 0;

    const update = () => {
      if (!start) return;
      const area = shiftBox(boxBetween(start, { x: pointer.x + window.scrollX, y: pointer.y + window.scrollY }), -window.scrollX, -window.scrollY);
      const hit: string[] = [];
      for (const row of document.querySelectorAll<HTMLElement>(ROW)) {
        const bounds = row.getBoundingClientRect();
        if (row.dataset.documentId && touches(area, { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })) hit.push(row.dataset.documentId);
      }
      setBox(area);
      latest.current.apply(mergeSelection(base, hit));
    };

    const tick = () => {
      const step = edgeScroll(pointer.y, window.innerHeight);
      if (step) {
        const before = window.scrollY;
        window.scrollBy(0, step);
        if (window.scrollY !== before) update();
      }
      frame = requestAnimationFrame(tick);
    };

    const finish = () => {
      start = null;
      armed.current = false;
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      document.body.classList.remove('marquee-active');
      setBox(null);
    };

    const down = (event: MouseEvent) => {
      finish();
      if (event.button !== 0 || !mayStart(event.target)) return;
      start = { x: event.pageX, y: event.pageY };
      pointer = { x: event.clientX, y: event.clientY };
      original = [...latest.current.selected];
      base = event.ctrlKey || event.metaKey || event.shiftKey ? original : [];
      outside = base.length === 0 && original.length > 0 && !(event.target as Element).closest(KEEPS);
      armed.current = true;
    };

    const move = (event: MouseEvent) => {
      if (!start) return;
      if ((event.buttons & 1) === 0) { finish(); return; }
      pointer = { x: event.clientX, y: event.clientY };
      if (!active) {
        if (!movedEnough(start, { x: event.pageX, y: event.pageY })) return;
        active = true;
        document.body.classList.add('marquee-active');
        frame = requestAnimationFrame(tick);
      }
      window.getSelection()?.removeAllRanges();
      update();
    };

    const up = () => {
      if (start && !active && outside) latest.current.apply([]);
      finish();
    };

    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !active) return;
      latest.current.apply(original);
      finish();
    };

    document.addEventListener('mousedown', down);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', finish);
    return () => {
      finish();
      document.removeEventListener('mousedown', down);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', finish);
    };
  }, [enabled]);

  return { box, armed };
}
