import { analyze, type Analysis } from ".";

export interface Request {
  id: number;
  text: string;
}
export type Reply = { id: number; ok: true; analysis: Analysis } | { id: number; ok: false; error: string };

/** One check: the worker's whole job, also used directly where there is no worker. */
export function handle(req: Request): Reply {
  try {
    return { id: req.id, ok: true, analysis: analyze(req.text) };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
