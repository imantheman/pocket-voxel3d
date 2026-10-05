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
//
// Texture ids name host textures: cooked pack images, guest uploads and
// canvases (see textures.ts).

export const OP_TARGET = 1;
export const OP_CLEAR = 2;
export const OP_STATE = 3;
export const OP_QUAD = 4;
export const OP_TRIS = 5;

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
  /** The numbers, in the layout above. */
  buf: number[] = [];
  // the state last written, so OP_STATE goes out only on a change
  private blend = -1;
  private effect = -1;
  private params: number[] = [];
  private scissor: [number, number, number, number] = [-2, -2, -2, -2];

  reset(): void {
    this.buf.length = 0;
    this.blend = -1;
    this.effect = -1;
    this.params = [];
    this.scissor = [-2, -2, -2, -2];
  }

  target(canvasId: number): void {
    this.buf.push(OP_TARGET, canvasId);
    // a new target starts from unknown state on the host
    this.blend = -1;
  }

  clear(r: number, g: number, b: number, a: number): void {
    this.buf.push(OP_CLEAR, r, g, b, a);
  }

  state(blend: number, effect: number, params: number[], scissor: [number, number, number, number] | undefined): void {
    const sc = scissor ?? [-1, -1, -1, -1];
    if (blend === this.blend && effect === this.effect && sc[0] === this.scissor[0] && sc[1] === this.scissor[1]
        && sc[2] === this.scissor[2] && sc[3] === this.scissor[3] && sameParams(params, this.params)) return;
    this.blend = blend;
    this.effect = effect;
    this.params = params.slice();
    this.scissor = [sc[0], sc[1], sc[2], sc[3]];
    this.buf.push(OP_STATE, blend, effect, Math.min(params.length, STATE_PARAMS));
    for (let i = 0; i < STATE_PARAMS; i++) this.buf.push(params[i] ?? 0);
    this.buf.push(sc[0], sc[1], sc[2], sc[3]);
  }

  quad(tex: number, c: number[], u0: number, v0: number, u1: number, v1: number,
    r: number, g: number, b: number, a: number): void {
    this.buf.push(OP_QUAD, tex, c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!, c[6]!, c[7]!, u0, v0, u1, v1, r, g, b, a);
  }

  tris(points: number[], r: number, g: number, b: number, a: number): void {
    const n = Math.floor(points.length / 6);
    if (n === 0) return;
    this.buf.push(OP_TRIS, n, r, g, b, a);
    for (let i = 0; i < n * 6; i++) this.buf.push(points[i]!);
  }
}

function sameParams(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
