import { type CSSProperties, useId, useLayoutEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'issue-workbench:columns:v1';
const defaults = { queue: 270, notes: 350 };
type Widths = typeof defaults;
export type Pane = keyof Widths;

function readWidths(): Widths {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && [saved.queue, saved.notes].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      return { queue: saved.queue, notes: saved.notes };
    }
  } catch { /* Storage can be unavailable in an embedded browser; resizing still works. */ }
  return defaults;
}

export function useWorkbenchColumns() {
  const ref = useRef<HTMLElement>(null);
  const id = useId();
  const [preferred, setPreferred] = useState(readWidths);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    setWidth(element.getBoundingClientRect().width);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Match the container queries in the export adapter and column-separator.module.css.
  // Keep the preferred widths intact when a smaller host temporarily clamps them.
  const wide = width > 1100;
  const available = Math.max(0, width - 360 - (wide ? 16 : 8));
  let queue = Math.max(220, preferred.queue), notes = Math.max(300, preferred.notes);
  if (wide && queue + notes > available) {
    const scale = Math.max(0, available - 520) / (queue + notes - 520);
    queue = 220 + (queue - 220) * scale;
    notes = 300 + (notes - 300) * scale;
  } else if (!wide) queue = Math.min(queue, Math.max(220, available));

  function update(next: Widths, persist = true) {
    setPreferred(next);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Keep this session usable. */ }
    }
  }
  const reset = () => update(defaults);
  const pane = (name: Pane, value: number, min: number, max: number) => ({
    pane: name, value, min, max: Math.max(min, max), controls: `${id}-${name}`,
    change: (next: number, persist: boolean) => update({ ...preferred, [name]: next }, persist),
    reset,
  });
  return {
    ref,
    style: { '--queue-width': `${queue}px`, '--notes-width': `${notes}px` } as CSSProperties,
    queue: pane('queue', queue, 220, available - (wide ? notes : 0)),
    notes: pane('notes', notes, 300, available - queue),
  };
}
