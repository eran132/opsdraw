import { restoreWorkerGlobals } from './layout.worker-env';
import { autoLayout } from '@opsdraw/core';
import type { LayoutRequest, LayoutResponse } from './layout';

restoreWorkerGlobals();

addEventListener('message', (event: MessageEvent<LayoutRequest>) => {
  const { id, diagram, direction } = event.data;
  autoLayout(diagram, direction).then(
    (result) => postMessage({ id, diagram: result } satisfies LayoutResponse),
    (e: unknown) =>
      postMessage({ id, error: String((e as Error)?.message ?? e) } satisfies LayoutResponse),
  );
});
