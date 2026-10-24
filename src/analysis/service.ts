import type { Analysis } from ".";
import { handle, type Reply, type Request } from "./protocol";

/** How long one check may take before it is stopped and reported as failed. */
export const LIMIT_MS = 30_000;

export interface Analyzer {
  /** Checks `text`. Starting another check stops this one: its promise then never settles. */
  run(text: string): Promise<Analysis>;
  /** Stops any check in progress. */
  cancel(): void;
  dispose(): void;
}

type MakeWorker = () => Worker;

const defaultWorker: MakeWorker | null =
  typeof Worker !== "undefined" ? () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) : null;

/**
 * The analysis service. Runs each check in a Web Worker; a newer request ends the worker that is
 * still busy with an older one, so a long check is really interrupted, not just ignored. Without
 * Worker support (unit tests) it runs the same check on the main thread, after a tick.
 */
export function createAnalyzer(makeWorker: MakeWorker | null = defaultWorker, limitMs = LIMIT_MS): Analyzer {
  let worker: Worker | null = null;
  let busy = false;
  let seq = 0;
  let pending: { id: number; resolve: (a: Analysis) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  const stop = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    if (worker && busy) {
      worker.terminate();
      worker = null;
    }
    busy = false;
  };

  const settle = (r: Reply) => {
    if (!pending || r.id !== pending.id) return; // an answer to a check that was replaced
    const p = pending;
    clearTimeout(p.timer);
    pending = null;
    busy = false;
    if (r.ok) p.resolve(r.analysis);
    else p.reject(new Error(r.error));
  };

  const ensure = (): Worker | null => {
    if (!makeWorker) return null;
    if (!worker) {
      worker = makeWorker();
      worker.onmessage = (e: MessageEvent<Reply>) => settle(e.data);
      worker.onerror = (e: ErrorEvent) => {
        e.preventDefault?.();
        const id = pending?.id;
        if (worker) worker.terminate();
        worker = null;
        if (id !== undefined) settle({ id, ok: false, error: e.message || "the checker stopped unexpectedly" });
      };
    }
    return worker;
  };

  return {
    run(text: string) {
      stop();
      const id = ++seq;
      return new Promise<Analysis>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending?.id !== id) return;
          stop();
          reject(new Error(`the check took longer than ${Math.round(limitMs / 1000)} s and was stopped`));
        }, limitMs);
        pending = { id, resolve, reject, timer };
        const req: Request = { id, text };
        let w: Worker | null = null;
        try {
          w = ensure();
        } catch {
          w = null; // no worker here (e.g. blocked): run on the main thread instead
        }
        if (w) {
          busy = true;
          w.postMessage(req);
        } else setTimeout(() => settle(handle(req)), 0);
      });
    },
    cancel: stop,
    dispose() {
      stop();
      worker?.terminate();
      worker = null;
    },
  };
}
