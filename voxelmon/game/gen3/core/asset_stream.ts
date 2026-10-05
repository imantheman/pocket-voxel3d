// Port of gen1recomp src/core/game3/asset_stream.lua (GPLv3 + additional terms; see LICENSE.md).
// One CPU worker, bounded decoded residency, and a shared upload budget.
//
// NOT FAITHFUL: no love.thread on the 3DS, so startWorker() always fails and
// every asset takes Brian's synchronous path (s:get decodes on demand;
// prefetched jobs never get a worker result). His single-threaded fallback is
// exactly that path. Upload coroutines are generator functions: an `upload`
// yields "texture" between layers (coroutine.yield) and returns the value;
// coroutine.resume is gen.next(), status "dead" is `done`.

import { D as Decode } from "./asset_decode.ts";
import { SessionLifecycle as Lifecycle } from "../shared/core/SessionLifecycle.ts";
import { Timer } from "../platform/timer.ts";
import { pairs, ipairs, len, remove, type LuaTable } from "../platform/lt.ts";
import { tostring } from "../../../import/gen3/lua.ts";

export type Upload = (data: any) => Generator<unknown, any, unknown>;
export type Publish = (key: any, value: any, err?: any) => void;

interface Job {
  id: number;
  kind: string;
  key: any;
  root: string;
  owner: AssetStream;
  spec: any;
  priority: number;
  cancelled?: boolean;
  cancelSignal?: { push(v: unknown): void; getCount(): number };
  data?: any;
  error?: any;
  done?: boolean;
  sent?: boolean;
  co?: Generator<unknown, any, unknown>;
}

export interface AssetStream {
  kind: string;
  cache: any;
  root: string;
  upload: Upload | undefined;
  publish: Publish;
  pending: Record<string, Job | null>;
  cancelled?: boolean;
  cancel(): void;
  decoded(key: any): boolean;
  retain(wanted: Record<string, unknown>): void;
  prefetch(key: any, priority?: number): void;
  get(key: any): [any, string?];
  submit?(key: any, payload: any, priority?: number): void;
}

let queue: LuaTable = [null];
let jobs: Record<number, Job | null> = {};
let serial = 0;
// love.thread objects: never created here (see header)
let thread: any, input: any, output: any, active: Job | undefined;

// Lua: asset_stream.lua:9
function cancel(job: Job): void {
  job.cancelled = true;
  if (job.cancelSignal) job.cancelSignal.push(true);
}

// Lua: asset_stream.lua:13
const clock = (): number => Timer.getTime();

// Lua: asset_stream.lua:14
function record(job: { kind: string; key: any }, phase: string, seconds: number, route: string): void {
  if (Stream.onTiming) Stream.onTiming(job.kind, job.key, phase, seconds, route);
  // NOT FAITHFUL: no environment on the 3DS, so POKEPORT_ASSET_PROFILE is never "1"
}

// Lua: asset_stream.lua:20
function startWorker(): boolean {
  if (thread) return true;
  // NOT FAITHFUL: love.thread is absent (see header): the Lua's
  // `if not (love and love.thread ...) then return false end`.
  return false;
}

// coroutine.resume for an upload generator: [ok, value, dead]
function step(co: Generator<unknown, any, unknown>): [boolean, any, boolean] {
  try {
    const r = co.next();
    return [true, r.value, r.done === true];
  } catch (e) {
    return [false, e instanceof Error ? e.message : e, true];
  }
}

export const Stream = {
  UPLOAD_BUDGET: 0.002,
  MAX_DECODED: 4,
  MAX_PENDING: 64,
  workerFailed: false as boolean,
  _uploadedThisFrame: false as boolean,
  lastOverBudget: undefined as number | undefined,
  onTiming: undefined as undefined | ((kind: string, key: any, phase: string, seconds: number, route: string) => void),

  // Lua: asset_stream.lua:31
  shutdown(): void {
    Stream.cancelPending();
    if (thread) {
      input.clear(); input.push({ stop: true }); thread.wait();
    }
    thread = undefined; input = undefined; output = undefined; active = undefined;
    queue = [null]; jobs = {};
    Stream._uploadedThisFrame = false;
    Stream.workerFailed = false;
  },

  // Lua: asset_stream.lua:41
  cancelPending(): void {
    for (const [, job] of pairs<Job>(jobs)) {
      cancel(job);
      job.owner.pending[job.key] = null;
    }
    jobs = {};
  },

  // Lua: asset_stream.lua:48
  frameComplete(): void { Stream._uploadedThisFrame = false; },

  // Lua: asset_stream.lua:58
  new(kind: string, cache: any, root: string, upload: Upload | undefined, publish: Publish): AssetStream {
    const s: AssetStream = {
      kind, cache, root, upload, publish, pending: {},
      // Lua: asset_stream.lua:60
      cancel(): void {
        this.cancelled = true;
        for (const [, job] of pairs<Job>(this.pending)) { cancel(job); jobs[job.id] = null; }
        this.pending = {};
      },
      // Lua: asset_stream.lua:65
      decoded(key: any): boolean {
        const job = this.pending[key];
        return job != null && job.data != null;
      },
      // Lua: asset_stream.lua:69
      retain(wanted: Record<string, unknown>): void {
        for (const [key, job] of pairs<Job>(this.pending)) {
          if (!wanted[key]) {
            cancel(job); jobs[job.id] = null; this.pending[key] = null;
          }
        }
      },
      // Lua: asset_stream.lua:76
      prefetch(key: any, priority?: number): void {
        if (this.cancelled) return;
        const p = this.pending[key];
        if (p) { p.priority = priority ?? p.priority; return; }
        let count = 0;
        for (const _ of pairs(this.pending)) count = count + 1;
        if (count >= Stream.MAX_PENDING) return;
        serial = serial + 1;
        const spec = this.cache && this.cache.assetWorkerSpec && this.cache.assetWorkerSpec(root, kind, key);
        const job: Job = { id: serial, kind, key, root, owner: this, spec, priority: priority ?? 1 };
        this.pending[key] = job; jobs[serial] = job;
        queue[len(queue) + 1] = job;
      },
      // Lua: asset_stream.lua:88 -- [value] or [undefined, err]
      get(key: any): [any, string?] {
        Stream.poll();
        const job = this.pending[key];
        let data = job && job.data;
        if (data == null) {
          if (job && job.cancelSignal) job.cancelSignal.push(true);
          const start = clock();
          const decode = (Decode as Record<string, any>)[kind] as (c: any, r: string, k: any) => [any, string?];
          const [d, err] = decode(cache, root, key);
          data = d;
          record({ kind, key }, "decode", clock() - start, "sync");
          if (data == null) return [undefined, err];
        }
        const start = clock();
        const co = (job && job.co) || upload!(data);
        let value: any;
        for (;;) {
          const [ok, res, dead] = step(co);
          if (!ok) {
            if (job) { job.cancelled = true; jobs[job.id] = null; this.pending[key] = null; }
            return [undefined, tostring(res)];
          }
          value = res;
          if (dead) break;
        }
        if (job) { job.cancelled = true; jobs[job.id] = null; this.pending[key] = null; }
        publish(key, value);
        record({ kind, key }, "upload", clock() - start, data === (job && job.data) ? "decoded" : "sync");
        return [value];
      },
    };
    return s;
  },

  // Lua: asset_stream.lua:120
  // CPU results are published on receipt, without consuming a graphics slice.
  newTask(kind: string, publish: Publish): AssetStream {
    const payloads: Record<string, any> = {};
    const cache = {
      assetWorkerSpec: (_root: string, _kind: string, key: any) => ({ task: true, payload: payloads[key] }),
    };
    const s = Stream.new(kind, cache, "", undefined, (key, data, err) => {
      payloads[key] = null;
      publish(key, data, err);
    });
    // Lua: asset_stream.lua:129
    s.submit = function (key: any, payload: any, priority?: number): void {
      payloads[key] = payload;
      this.prefetch(key, priority);
      payloads[key] = null;
    };
    return s;
  },

  // Lua: asset_stream.lua:137
  poll(): void {
    if (output) {
      const result = output.pop();
      if (result) {
        if (result.fatal) {
          if (active) { active.spec = undefined; active.sent = false; }
          Stream.workerFailed = true; active = undefined;
          console.log("[game3/asset] worker unavailable: " + tostring(result.fatal));
        }
        const job = jobs[result.id];
        if (active && active.id === result.id) active = undefined;
        if (job && !job.cancelled) {
          job.data = result.data; job.error = result.error; job.done = true;
          record(job, "decode", result.seconds, "worker");
          if (job.spec.task) {
            job.owner.publish(job.key, job.data, job.error);
            job.owner.pending[job.key] = null; jobs[job.id] = null; job.cancelled = true;
          }
        }
      }
    }
    if (thread && thread.getError()) {
      if (active) { active.spec = undefined; active.sent = false; }
      thread = undefined; input = undefined; output = undefined; active = undefined;
      Stream.workerFailed = true;
    }
    if (active) return;
    let decoded = 0;
    for (const [, job] of ipairs<Job>(queue)) if (!job.cancelled && job.data != null) decoded = decoded + 1;
    let nextJob: Job | undefined;
    for (const [, job] of ipairs<Job>(queue)) {
      if (!job.cancelled && !job.done && job !== active && !job.sent) {
        if (job.spec && (job.spec.task || decoded < Stream.MAX_DECODED)
          && (!nextJob || job.priority < nextJob.priority)) nextJob = job;
      }
    }
    if (nextJob && !Stream.workerFailed && startWorker()) {
      // Unreachable here (startWorker is false): the Lua sends the job to the worker.
      nextJob.sent = true; active = nextJob;
      input.push({
        id: nextJob.id, kind: nextJob.kind, key: nextJob.key, root: nextJob.root,
        spec: nextJob.spec, cancelSignal: nextJob.cancelSignal,
      });
    }
    // Unknown/custom caches prepare synchronously only when explicitly consumed.
  },

  // Lua: asset_stream.lua:182
  update(): void {
    Stream.poll();
    if (Stream._uploadedThisFrame) return;
    const start = clock();
    for (let i = len(queue); i >= 1; i--) if (queue[i].cancelled) remove(queue, i);
    let nextJob: Job | undefined;
    for (const [, job] of ipairs<Job>(queue)) {
      if (job.data != null && (!nextJob || job.priority < nextJob.priority)) nextJob = job;
    }
    const job = nextJob;
    if (job) {
      Stream._uploadedThisFrame = true;
      if (!job.co) job.co = job.owner.upload!(job.data);
      const t = clock();
      const [ok, value, dead] = step(job.co);
      if (!ok) {
        job.error = tostring(value); job.done = true; job.data = undefined;
        job.co = undefined;
      } else if (dead) {
        job.owner.publish(job.key, value);
        job.owner.pending[job.key] = null; jobs[job.id] = null; job.cancelled = true;
      }
      record(job, "upload_step", clock() - t, "warm");
      // A texture upload (including animation catch-up on publication) is
      // atomic. One coroutine slice per render frame prevents catch-up ticks
      // and a second ready asset from silently exceeding the upload budget.
      if (clock() - start > Stream.UPLOAD_BUDGET) Stream.lastOverBudget = clock() - start;
    }
  },
};

// Lua: asset_stream.lua:49-56 (module load)
{
  const L = Lifecycle as typeof Lifecycle & { _game3AssetShutdownRegistered?: boolean };
  if (!L._game3AssetShutdownRegistered) {
    L._game3AssetShutdownRegistered = true;
    L.registerProcessShutdown(() => {
      // package.loaded["src.core.game3.asset_stream"]: this module
      const current = Stream;
      if (current) current.shutdown();
    });
  }
}

export default Stream;
