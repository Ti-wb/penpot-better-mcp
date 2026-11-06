/** Retain recovery access on failed saving; close the transport only after drain. */
export function createShutdownHandler(shutdown: () => Promise<void>, closeTransport: () => Promise<void>, options: {
  onFailure: (error: unknown) => void;
  onComplete: () => void;
  retryMs?: number;
}) {
  let running: Promise<void> | undefined, retry: NodeJS.Timeout | undefined;
  let complete = false;
  const stop = (): Promise<void> => {
    if (complete) return Promise.resolve();
    if (running) return running;
    clearTimeout(retry);
    running = (async () => {
      try {
        await shutdown();
        await closeTransport();
        complete = true;
        options.onComplete();
      } catch (error) {
        try { options.onFailure(error); } catch { /* Logging cannot abandon saving. */ }
        retry = setTimeout(() => { void stop(); }, options.retryMs ?? 5000).unref();
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  return stop;
}
