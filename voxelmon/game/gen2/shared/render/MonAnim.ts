// gen1recomp src/render/MonAnim.lua (bdfac727): the front-pic animation
// script runner.
// ../pokecrystal/engine/gfx/pic_animation.asm:544 ConvertAndApplyBitmask
// ../pokecrystal/engine/gfx/pic_animation.asm:356 PokeAnim_DoAnimScript
//
// Anim data is the importer's (pokemon.json `anim`): `tiles`, `play`/`idle`
// scripts as rows [command, param], `frames` [{ bitmask, tiles }] and
// `bitmasks`. Frame numbers are the Lua's 1-based script commands.

export interface MonAnimData {
  tiles?: number;
  sheet?: string;
  play?: number[][];
  idle?: number[][];
  frames?: { bitmask: number; tiles: number[] }[];
  bitmasks?: number[][];
  [key: string]: unknown;
}

// MonAnim.lua:50 -- ../pokecrystal/engine/gfx/pic_animation.asm:69-77, :150-164
const SCENES: Record<string, string[]> = {
  battle: ["setup", "play"],
  battleSlow: ["setup2", "play"],
  menu: ["setup", "play", "wait", "idle", "play"],
  trade: ["idle", "play2", "idle", "play", "wait", "cry", "setup", "play"],
  evolve: ["idle", "play", "wait", "cryNoWait", "setup", "play"],
  hatch: ["idle", "play", "cryNoWait", "setup", "play", "wait", "idle", "play"],
  hof: ["setup", "play", "wait", "idle", "play"],
};

export class MonAnim {
  /** MonAnim.lua:9 -- .Sizes db 4, 5, 7 */
  static BITMASK_BYTES: Record<number, number> = { 5: 4, 6: 5, 7: 7 };
  static END = 0xff;
  static SETREPEAT = 0xfe;
  static DOREPEAT = 0xfd;
  static SCENE_WAIT = 18;

  data: MonAnimData;
  steps: string[];
  onCry: ((step: string) => void) | undefined;
  step = 1;
  frame = 0;
  speed = 0;
  script: number[][] | null = null;
  pc = 1;
  repeatTimer = 0;
  waiting = false;
  waitCounter = 0;
  sceneWait: number | null = null;
  done = false;

  constructor(data: MonAnimData, steps: string[], onCry?: (step: string) => void) {
    this.data = data;
    this.steps = steps;
    this.onCry = onCry;
  }

  /**
   * MonAnim.lua:18 -- .NextBit walks the row first, so bit i is row
   * i % height, column i / height. 0-based tile ids, one per pic tile.
   */
  static tileMap(data: MonAnimData | null | undefined, frame?: number): number[] | null {
    const tiles = data?.tiles;
    if (!tiles) return null;
    const count = tiles * tiles;
    const out: number[] = [];
    for (let i = 0; i < count; i++) out[i] = i;
    if (!frame || frame <= 0) return out;
    const row = data.frames?.[frame - 1];
    const mask = row && data.bitmasks ? data.bitmasks[row.bitmask - 1] : undefined;
    if (!(row && mask)) return null;
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      const byte = mask[Math.floor(i / 8)] ?? 0;
      if (Math.floor(byte / 2 ** (i % 8)) % 2 === 1) {
        const id = row.tiles[cursor];
        if (id == null) return null;
        out[i] = id;
        cursor += 1;
      }
    }
    return out;
  }

  /** MonAnim.lua:43 -- PokeAnim_GetDuration: a * (1 + speed / 16), 8 bits. */
  static duration(param: number, speed?: number): number {
    param = ((param % 256) + 256) % 256;
    const scaled = Math.floor((param * (speed ?? 0)) / 16) % 256;
    return (scaled + param) % 256;
  }

  /** MonAnim.lua:67 */
  static scenes(): Record<string, string[]> {
    return SCENES;
  }

  /** MonAnim.lua:69 */
  static new(data: MonAnimData | null | undefined, scene?: string, onCry?: (step: string) => void): MonAnim | null {
    const steps = SCENES[scene ?? "battle"];
    if (!(data && steps && data.play && data.play.length > 0)) return null;
    return new MonAnim(data, steps, onCry);
  }

  /** MonAnim.lua:89 */
  finished(): boolean {
    return this.done;
  }

  /** MonAnim.lua:93 -- command 0 is the base picture. */
  currentFrame(): number {
    return this.frame;
  }

  /** MonAnim.lua:95 */
  beginScript(rows: number[][] | undefined, speed: number): void {
    this.script = rows ?? [];
    this.speed = speed;
    this.pc = 1;
    this.repeatTimer = 0;
    this.waiting = false;
    this.waitCounter = 0;
  }

  /** MonAnim.lua:106 -- one tick of PokeAnim_DoAnimScript; true at endanim. */
  runScript(): boolean {
    if (this.waiting) {
      this.waitCounter = (this.waitCounter - 1 + 256) % 256;
      if (this.waitCounter === 0) this.waiting = false;
      return false;
    }
    for (let n = 0; n < 256; n++) {
      const row = this.script![this.pc - 1];
      this.pc += 1;
      if (row == null) return true;
      const command = row[0]!;
      if (command === MonAnim.END) {
        return true;
      } else if (command === MonAnim.SETREPEAT) {
        this.repeatTimer = row[1]!;
      } else if (command === MonAnim.DOREPEAT) {
        // .DoRepeat returns on both `ret z` (:397-406)
        if (this.repeatTimer === 0) return false;
        this.repeatTimer -= 1;
        if (this.repeatTimer === 0) return false;
        this.pc = row[1]! + 1;
      } else {
        this.frame = command;
        this.waiting = true;
        this.waitCounter = MonAnim.duration(row[1]!, this.speed);
        // StartWaitAnim falls through into .WaitAnim (:383-388)
        this.waitCounter = (this.waitCounter - 1 + 256) % 256;
        if (this.waitCounter === 0) this.waiting = false;
        return false;
      }
    }
    return true;
  }

  /** MonAnim.lua:143 -- one scene command per frame (AnimateFrontpic's .loop). */
  update(): void {
    if (this.done) return;
    const step = this.steps[this.step - 1];
    if (step == null) {
      // PokeAnim_Finish's DeinitFrames puts the base picture back (:224-228)
      this.frame = 0;
      this.done = true;
      return;
    }
    if (step === "setup" || step === "setup2" || step === "idle") {
      const rows = step === "idle" ? this.data.idle : this.data.play;
      this.beginScript(rows, step === "setup2" ? 4 : 0);
      this.step += 1;
      return;
    }
    if (step === "wait") {
      this.sceneWait = (this.sceneWait ?? MonAnim.SCENE_WAIT) - 1;
      if (this.sceneWait <= 0) {
        this.sceneWait = null;
        this.step += 1;
      }
      return;
    }
    if (step === "cry" || step === "cryNoWait") {
      // ../pokecrystal/engine/gfx/pic_animation.asm:230-244
      if (this.onCry) this.onCry(step);
      this.step += 1;
      return;
    }
    if (this.runScript()) {
      // ../pokecrystal/engine/gfx/pic_animation.asm:196-215
      if (step !== "play2") this.frame = 0;
      this.step += 1;
    }
  }
}

export default MonAnim;
