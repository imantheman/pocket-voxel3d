// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The per-frame DRAW LIST the guest's love.graphics shim
// records and the host (or the desktop rasteriser) draws. All transform maths
// and shape triangulation happen in the guest; the list carries only state
// changes and two primitives:
//
//   OP_TARGET  canvasId (0 = the frame)
//   OP_CLEAR   r g b a                       (0..1)
//   OP_STATE   blend effect nParams p0..p7 scissorX scissorY scissorW scissorH (scissor -1 = none)
//   OP_QUAD    tex x0 y0 x1 y1 x2 y2 x3 y3 u0 v0 u1 v1 r g b a     (corners TL TR BR BL)
//   OP_TRIS    n r g b a  x0 y0 x1 y1 x2 y2 ...                   (n flat triangles)
//   OP_BATCH   batch tex a b c d e f r g b a                       (a sprite batch the host holds
//              -- G3Host.batchUpload -- drawn under the affine x' = a x + c y + e,
//              y' = b x + d y + f, every quad tinted r g b a)
//
// Texture ids name host textures: cooked pack images, guest uploads and
// canvases (see textures.ts).

export const OP_TARGET = 1;
export const OP_CLEAR = 2;
export const OP_STATE = 3;
export const OP_QUAD = 4;
export const OP_TRIS = 5;
export const OP_BATCH = 6;

export const BLEND_ALPHA = 0;
/** "alpha", "premultiplied" */
export const BLEND_ALPHA_PREMUL = 1;
export const BLEND_ADD = 2;
/** "add", "premultiplied" */
export const BLEND_ADD_PREMUL = 3;
/** "multiply", "premultiplied" (LÖVE refuses multiply with alphamultiply) */
export const BLEND_MULTIPLY = 4;
/** "replace", "premultiplied" / "replace", "alphamultiply" */
export const BLEND_REPLACE = 5;
export const BLEND_SUBTRACT = 6;

export const STATE_PARAMS = 16;

export class DrawList {
  // The numbers, in the layout above, written straight into f32 storage: the
  // 3DS host takes the floats as they are (a JS number[] cost 2.8 ms a frame
  // to convert there). Grown by doubling, never shrunk.
  private f = new Float32Array(16384);
  private n = 0;
  // the state last written, so OP_STATE goes out only on a change
  private blend = -1;
  private effect = -1;
  private params: number[] = [];
  private paramsRef: number[] | undefined;
  private scissor: [number, number, number, number] = [-2, -2, -2, -2];
  /** Bumped whenever the host's state is unknown again (reset, target):
   *  graphics.ts re-sends its state when this moves. */
  epoch = 0;
  /** Counts the ops that are not primitives (target, clear, state), so a
   *  stretch of the list can be checked to hold primitives only (graphics.ts
   *  DrawMemo). */
  stateOps = 0;

  /** The list so far (a view: valid until the next write after a reset). */
  get buf(): Float32Array {
    return this.f.subarray(0, this.n);
  }
  get length(): number {
    return this.n;
  }

  private room(k: number): void {
    if (this.n + k <= this.f.length) return;
    let cap = this.f.length * 2;
    while (cap < this.n + k) cap *= 2;
    const g = new Float32Array(cap);
    g.set(this.f.subarray(0, this.n));
    this.f = g;
  }

  reset(): void {
    this.epoch++;
    this.n = 0;
    this.blend = -1;
    this.effect = -1;
    this.params = [];
    this.paramsRef = undefined;
    this.scissor = [-2, -2, -2, -2];
  }

  /** A copy of the list from `start` to its end. */
  copyFrom(start: number): Float32Array {
    return this.f.slice(start, this.n);
  }

  /** Recorded primitives (copyFrom), appended as they are. */
  append(src: Float32Array): void {
    const k = src.length;
    if (this.n + k > this.f.length) this.room(k);
    this.f.set(src, this.n);
    this.n += k;
  }

  target(canvasId: number): void {
    this.stateOps++;
    this.room(2);
    this.f[this.n++] = OP_TARGET;
    this.f[this.n++] = canvasId;
    // a new target starts from unknown state on the host
    this.blend = -1;
    this.epoch++;
  }

  clear(r: number, g: number, b: number, a: number): void {
    this.stateOps++;
    this.room(5);
    const f = this.f;
    let n = this.n;
    f[n++] = OP_CLEAR; f[n++] = r; f[n++] = g; f[n++] = b; f[n++] = a;
    this.n = n;
  }

  state(blend: number, effect: number, params: number[], scissor: [number, number, number, number] | undefined): void {
    const sc = scissor ?? NO_SCISSOR;
    if (blend === this.blend && effect === this.effect && sc[0] === this.scissor[0] && sc[1] === this.scissor[1]
        && sc[2] === this.scissor[2] && sc[3] === this.scissor[3]
        && (params === this.paramsRef || sameParams(params, this.params))) return;
    this.stateOps++;
    this.blend = blend;
    this.effect = effect;
    this.params = params.slice();
    this.paramsRef = params;
    this.scissor = [sc[0], sc[1], sc[2], sc[3]];
    this.room(4 + STATE_PARAMS + 4);
    const f = this.f;
    let n = this.n;
    f[n++] = OP_STATE; f[n++] = blend; f[n++] = effect; f[n++] = Math.min(params.length, STATE_PARAMS);
    for (let i = 0; i < STATE_PARAMS; i++) f[n++] = params[i] ?? 0;
    f[n++] = sc[0]; f[n++] = sc[1]; f[n++] = sc[2]; f[n++] = sc[3];
    this.n = n;
  }

  quad(tex: number, c: number[], u0: number, v0: number, u1: number, v1: number,
    r: number, g: number, b: number, a: number): void {
    this.room(18);
    const f = this.f;
    let n = this.n;
    f[n++] = OP_QUAD; f[n++] = tex;
    f[n++] = c[0]!; f[n++] = c[1]!; f[n++] = c[2]!; f[n++] = c[3]!;
    f[n++] = c[4]!; f[n++] = c[5]!; f[n++] = c[6]!; f[n++] = c[7]!;
    f[n++] = u0; f[n++] = v0; f[n++] = u1; f[n++] = v1;
    f[n++] = r; f[n++] = g; f[n++] = b; f[n++] = a;
    this.n = n;
  }

  /** quad() with its corners as scalars (the hot path: no array per quad). */
  quad8(tex: number, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
    u0: number, v0: number, u1: number, v1: number, r: number, g: number, b: number, a: number): void {
    if (this.n + 18 > this.f.length) this.room(18);
    const f = this.f;
    let n = this.n;
    f[n++] = OP_QUAD; f[n++] = tex;
    f[n++] = x0; f[n++] = y0; f[n++] = x1; f[n++] = y1;
    f[n++] = x2; f[n++] = y2; f[n++] = x3; f[n++] = y3;
    f[n++] = u0; f[n++] = v0; f[n++] = u1; f[n++] = v1;
    f[n++] = r; f[n++] = g; f[n++] = b; f[n++] = a;
    this.n = n;
  }

  batch(id: number, tex: number, a: number, b: number, c: number, d: number, e: number, f0: number,
    r: number, g: number, bl: number, al: number): void {
    if (this.n + 13 > this.f.length) this.room(13);
    // a batch's quads live on the host, re-sent only when graphics.ts draws
    // it: a replayed copy of this op could draw stale ones (DrawMemo)
    this.stateOps++;
    const f = this.f;
    let n = this.n;
    f[n++] = OP_BATCH; f[n++] = id; f[n++] = tex;
    f[n++] = a; f[n++] = b; f[n++] = c; f[n++] = d; f[n++] = e; f[n++] = f0;
    f[n++] = r; f[n++] = g; f[n++] = bl; f[n++] = al;
    this.n = n;
  }

  /** A quad's two flat triangles (p0 p1 p2, p0 p2 p3), as tris() writes a
   *  rectangle's six points: the scalar hot path, nothing allocated. */
  rect(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
    r: number, g: number, b: number, a: number): void {
    if (this.n + 18 > this.f.length) this.room(18);
    const f = this.f;
    let n = this.n;
    f[n++] = OP_TRIS; f[n++] = 2; f[n++] = r; f[n++] = g; f[n++] = b; f[n++] = a;
    f[n++] = x0; f[n++] = y0; f[n++] = x1; f[n++] = y1; f[n++] = x2; f[n++] = y2;
    f[n++] = x0; f[n++] = y0; f[n++] = x2; f[n++] = y2; f[n++] = x3; f[n++] = y3;
    this.n = n;
  }

  tris(points: number[], r: number, g: number, b: number, a: number): void {
    const k = Math.floor(points.length / 6);
    if (k === 0) return;
    this.room(6 + k * 6);
    const f = this.f;
    let n = this.n;
    f[n++] = OP_TRIS; f[n++] = k; f[n++] = r; f[n++] = g; f[n++] = b; f[n++] = a;
    for (let i = 0; i < k * 6; i++) f[n++] = points[i]!;
    this.n = n;
  }
}

const NO_SCISSOR: [number, number, number, number] = [-1, -1, -1, -1];

function sameParams(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
