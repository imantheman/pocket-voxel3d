// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). What the 3DS entries (main.ts, worldbench.ts) share: the
// world's scene ops over the QuickJS natives, world.json, the host's button
// word, and the bench scripts.

import { native } from "../../quickjs-host.ts";
import { ENT_FLOATS, parseWorldJson, type WorldJson, type WorldOps } from "./worldview.ts";

/** The natives, with the ones only some binaries have. */
export const nat = native as typeof native & {
  g3Ents?(records: Float32Array, count: number): void;
  g3Strips?(mode: number, r: number, g: number, b: number, a: number): void;
  g3HostKeys?(mask: number): void;
  flatWorld?(on: number): void;
  screenshot?(): void;
};

/** The world's scene ops over the natives. */
export function worldOps(): WorldOps {
  const n = nat;
  return {
    mapShow: (s, id, ox, oy) => n.mapShow(s, id, ox, oy),
    mapHide: (s) => n.mapHide(s),
    cam: (x, y) => n.cam(x, y),
    pitch: (r) => n.pitch(r),
    tint: (c) => n.tint(c),
    flatWorld: (on) => n.flatWorld?.(on),
    g3Ents: (r, k) => n.g3Ents?.(r.subarray(0, k * ENT_FLOATS), k),
    strips: (mode, r, g, b, a) => n.g3Strips?.(mode, r, g, b, a),
  };
}

/** world.json, which the host hands FireRed as its "gamedata" (main.rs GAMEDATA_PATH). */
export function loadWorld(): WorldJson | null {
  let text: string | undefined;
  try { text = nat.gamedata(); } catch { text = undefined; }
  const world = parseWorldJson(text);
  console.log(`[pv] g3 world: ${world ? Object.keys(world.maps).length + " maps" : "no world.json (VIEW 2D only)"}`);
  return world;
}

/** An exception as text: QuickJS's stack does not carry the message. */
export const errText = (e: unknown): string => `${String(e)} ${String((e as Error)?.stack ?? "")}`;

export type FrameFn = (buttons: number) => void;
export const setFrame = (f: FrameFn): void => { (globalThis as unknown as { frame: FrameFn }).frame = f; };

/** The host's button word (main.rs) in Input.hostButtons' layout: bits 0-7
 *  are the same (X already rides START); L and R arrive as presses in bits
 *  27 / 26 and become a one-tick hold in 8 / 9. */
export function padBits(b: number): number {
  return (b & 0xff) | (((b >>> 27) & 1) << 8) | (((b >>> 26) & 1) << 9);
}

const KEY_BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7, L: 8, R: 9 };

/** Host buttons a bench can hold (gen3::inject_keys): the camera's. */
const HOST_KEY_BIT: Record<string, number> = { ZL: 0, ZR: 1, CL: 2, CR: 3, CU: 4, CD: 5 };

/** A bench walk, "tick:KEYS,..." (keys joined by +; held until the next entry). */
export class BenchScript {
  private steps: [number, number][] = [];
  private i = 0;
  held = 0;
  constructor(s: string) {
    for (const part of s.split(",").filter(Boolean)) {
      const [t, keys] = part.split(":");
      let m = 0;
      let h = 0;
      for (const k of (keys ?? "").split("+").filter(Boolean)) {
        const hk = HOST_KEY_BIT[k.toUpperCase()];
        if (hk != null) h |= 1 << hk;
        else m |= 1 << (KEY_BIT[k.toUpperCase()] ?? 31);
      }
      this.steps.push([Number(t), (m & 0xfff) | (h << 16)]);
    }
    this.steps.sort((a, b) => a[0] - b[0]);
  }
  /** The guest keys held at `tick` (and the host's, sent to g3HostKeys). */
  at(tick: number): number {
    while (this.i < this.steps.length && this.steps[this.i]![0] <= tick) this.held = this.steps[this.i++]![1];
    nat.g3HostKeys?.(this.held >>> 16);
    return this.held & 0xffff;
  }
}

/** "90,300" -> the shown frames to photograph. */
export function shotSet(s: string): Set<number> {
  return new Set(s.split(",").filter(Boolean).map(Number));
}
