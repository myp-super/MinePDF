import { TranslationError } from './errors';

export interface HedgedTask<T> {
  id: string;
  run: (signal: AbortSignal) => Promise<T>;
}

/**
 * Starts the preferred provider immediately, then lets the next provider
 * "hedge" after a short grace period. A fast success cancels all slower work;
 * a fast failure starts the next provider without waiting for the grace timer.
 */
export function firstSuccessfulHedged<T>(
  tasks: HedgedTask<T>[],
  signal: AbortSignal,
  hedgeDelayMs = 850,
): Promise<{ id: string; value: T }> {
  if (!tasks.length) return Promise.reject(new TranslationError('PROVIDER_UNAVAILABLE', 'No translation provider is available', true));

  return new Promise((resolve, reject) => {
    let nextIndex = 0;
    let failures = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastError: unknown = new TranslationError('PROVIDER_UNAVAILABLE', 'All translation providers failed', true);
    const controllers = new Set<AbortController>();

    const clearHedge = (): void => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      hedgeTimer = null;
    };
    const abortChildren = (): void => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
    const finishAbort = (): void => {
      if (settled) return;
      settled = true;
      clearHedge();
      abortChildren();
      reject(new TranslationError('ABORTED', 'Translation cancelled', false));
    };
    const queueNext = (): void => {
      clearHedge();
      if (settled || nextIndex >= tasks.length) return;
      hedgeTimer = setTimeout(() => {
        hedgeTimer = null;
        startNext();
      }, hedgeDelayMs);
    };
    const startNext = (): void => {
      if (settled || signal.aborted || nextIndex >= tasks.length) return;
      clearHedge();
      const task = tasks[nextIndex++];
      const controller = new AbortController();
      controllers.add(controller);
      void task.run(controller.signal).then((value) => {
        controllers.delete(controller);
        if (settled) return;
        settled = true;
        clearHedge();
        abortChildren();
        signal.removeEventListener('abort', finishAbort);
        resolve({ id: task.id, value });
      }).catch((error: unknown) => {
        controllers.delete(controller);
        if (settled || controller.signal.aborted) return;
        lastError = error;
        failures++;
        if (failures >= tasks.length) {
          settled = true;
          clearHedge();
          signal.removeEventListener('abort', finishAbort);
          reject(lastError);
          return;
        }
        // Do not make the user wait out the hedge delay after an immediate error.
        startNext();
      });
      queueNext();
    };

    signal.addEventListener('abort', finishAbort, { once: true });
    if (signal.aborted) finishAbort();
    else startNext();
  });
}
