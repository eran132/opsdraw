import { autoLayout, type Diagram, type LayoutDirection } from '@opsdraw/core';

export interface LayoutRequest {
  id: number;
  diagram: Diagram;
  direction: LayoutDirection;
}

export type LayoutResponse = { id: number; diagram: Diagram } | { id: number; error: string };

interface Pending {
  resolve(d: Diagram): void;
  reject(e: Error): void;
  fallback(): void;
}

/** `null` once the worker is known not to work here; layouts then run on the main thread. */
let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (e: MessageEvent<LayoutResponse>) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      pending.delete(e.data.id);
      if ('error' in e.data) job.reject(new Error(e.data.error));
      else job.resolve(e.data.diagram);
    });
    // The worker failed to load or crashed: finish its jobs here and stop using it.
    w.addEventListener('error', () => {
      w.terminate();
      worker = null;
      const jobs = [...pending.values()];
      pending.clear();
      jobs.forEach((j) => j.fallback());
    });
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * ELK auto-layout, run in a Web Worker so large diagrams don't freeze the editor.
 * Falls back to the main thread where workers are unavailable.
 */
export function layoutDiagram(diagram: Diagram, direction: LayoutDirection = 'RIGHT') {
  const w = getWorker();
  if (!w) return autoLayout(diagram, direction);
  return new Promise<Diagram>((resolve, reject) => {
    const id = ++nextId;
    const fallback = () => autoLayout(diagram, direction).then(resolve, reject);
    pending.set(id, { resolve, reject, fallback });
    try {
      w.postMessage({ id, diagram, direction } satisfies LayoutRequest);
    } catch {
      // Not cloneable (should not happen for plain diagrams): lay it out here instead.
      pending.delete(id);
      void fallback();
    }
  });
}
