// The Gen 2 battle-animation command interpreter: a port of gen1recomp
// src/battle/gen2/AnimRunner.lua (bdfac727, MIT).
//
// pokegold engine/battle_anims/anim_commands.asm: RunBattleAnimScript's frame
// loop and the 48-entry BattleAnimCommands jumptable it dispatches through.
// The scripts themselves are already disassembled into the cache by
// RomExtractorGen2 (`battle_anims.json`, voxelmon/import/gen2/battleanims.ts),
// keyed by their ROM address because that is what a branch names.
//
// One frame of an animation is exactly three things, in this order:
//
//   RunBattleAnimCommand   run script bytes until one asks to wait
//   ExecuteBGEffects       one pass over the five BG-effect structs
//   BattleAnim_UpdateOAM_All   one pass over the ten object structs
//
// so `step()` here is one 60 Hz frame and nothing else needs a clock.  The
// animation is over when a `ret` runs outside a subroutine, which is what
// BATTLEANIM_STOP_F means.
//
// Two things about the script format that are easy to get wrong and are
// already handled by the extractor, repeated here because this is where they
// bite: anything under $d0 is `anim_wait <n>` and carries no arguments, and a
// branch's target is the LAST two bytes of the command, which the extractor
// has already rewritten into a pool key.
//
// Love-free: sound and cries go out through the `hooks` table the battle
// screen supplies, so a test can step a whole animation and assert what it
// asked to play.
//
// Port notes: the order lists (constants.battleAnimGfxOrder, sfxOrder) are
// 0-based JSON arrays here, so the Lua's `order[id + 1]` is `order[id]`;
// `tileDict` and `loaded` are 0-based arrays of what the Lua kept as
// sequences.  The painter seam at the bottom (AnimPainter / draw) is ours.

import { AnimObjects, type AnimEnv, type AnimOamEntry } from "./AnimObjects.ts";
import { BgEffects, type BattlerSide, type BgEffectsPool, type LcdcTarget } from "./BgEffects.ts";
import { truthy } from "../platform/lua.ts";

// Lua: AnimObjects.u8, looked up at call time (never at module top level).
const u8 = (value: number): number => AnimObjects.u8(value);

// wBattleAnimTileDict is five {gfx id, tile id} pairs.
const NUM_TILEDICT_ENTRIES = 5;
// BATTLEANIM_BASE_TILE is 7*7; the sheets share the tiles above it up to
// vTiles1, so the running allocator stops at 128 - 49.
const MAX_ANIM_TILES = 128 - 49;

// BattleAnimCmd_BattlerGFX_*: the battlers' own pic tiles are registered in
// the dict at fixed ids rather than loaded from AnimObjGFX.  These are the
// ASM's `($80 - 6 - 7) - BATTLEANIM_BASE_TILE` and friends.
const BATTLER_TILES = {
  oneRow: { player: 0x80 - 6 - 7 - 49, enemy: 0x80 - 6 - 49 },
  twoRow: { player: 0x80 - 6 * 2 - 7 * 2 - 49, enemy: 0x80 - 6 * 2 - 49 },
};

// BattleAnimCmd_Cry's .CryData: a pitch and a length added to the mon's own
// cry, indexed by the command's argument masked to NUM_NOISE_CHANS.
const CRY_DATA: Record<number, { pitch: number; length: number }> = {
  0: { pitch: 0x0000, length: 0x00c0 },
  1: { pitch: 0x0000, length: 0x0040 },
  2: { pitch: 0x0000, length: 0x0000 },
  3: { pitch: 0x0000, length: 0x0000 },
};

// BattleAnimCmd_Sound's .GetPanning, indexed by the cry-track pair.
const PANNING: Record<number, number> = { 0: 0xf0, 1: 0x0f, 2: 0xf0, 3: 0x0f };

//--------------------------------------------------------------------------
// Types
//--------------------------------------------------------------------------

/** One decoded script row: [command, ...args] (battleanims.ts AnimRow). */
export type AnimRow = (string | number)[];

/** What the battle screen hands the runner for sound, cries and the ball wobble. */
export interface AnimHooks {
  sound?(name: string | undefined, panning: number, duration: number, id: number): void;
  cry?(side: BattlerSide, pitch: number, length: number): void;
  pokeballWobble?(): number | undefined;
}

export interface AnimRunnerOpts {
  /** the cache's battle_anims table */
  data?: Record<string, any>;
  /** the cache's constants table */
  constants?: Record<string, any>;
  /** hBattleTurn -- 0 while the player is attacking */
  battleTurn?: number;
  /** wBattleAnimParam, which the effect layer sets (hit count, stat direction, the Beat Up party slot...) */
  param?: number;
  /** the move (or ANIM_* id) whose script this is */
  animId?: string;
  hooks?: AnimHooks;
  /** the PAL_BATTLE_OB_* name for the ball being thrown */
  ballPalette?: string;
  sgb?: boolean;
  flying?: Partial<Record<BattlerSide, unknown>>;
  /** constants.sfxOrder, for naming `sound` ids (the Lua takes it from opts, not constants) */
  sfxOrder?: string[];
}

/** One wBattleAnimTileDict entry. */
export interface TileDictEntry {
  gfx: string | number;
  tile: number;
}

/** One sheet the script loaded, in load order (BattleAnimView's sheetForTile walks these). */
export interface LoadedSheet {
  gfx: string | number;
  tile: number;
  tiles: number;
  /** set on the two battler pseudo-sheets (BattlerGFX commands) */
  battler?: BattlerSide;
  rows?: number;
}

/** A picOverride value: what replaced a battler's pic (false: put back). */
export type PicOverride = "transform" | "substitute" | "minimize" | false | { kind: "beatup"; slot: number } | undefined;

/** One shadow-OAM entry (AnimObjects' type: sheet-relative tile, OAM-space x/y). */
export type { AnimOamEntry };

type AnimObjectsPool = ReturnType<typeof AnimObjects.new>;

//--------------------------------------------------------------------------
// The painter seam (ours, not in the Lua)
//--------------------------------------------------------------------------

/**
 * The BG layer for one frame: everything BattleAnimView.lua reads off
 * runner.bg, plus runner.picOverride. The arrays and records are the pool's
 * own (live, read-only for the painter).
 */
export interface AnimBgState {
  /** hSCX / hSCY bytes: whole-screen scroll */
  scx: number;
  scy: number;
  /** which register lyBackup lands in (undefined: none) */
  lcdc: LcdcTarget | undefined;
  /** the per-scanline window: rows lyStart < row <= lyEnd take lyBackup[row - 1] (home/lcd.asm, BattleAnimView.scanlines) */
  lyStart: number;
  lyEnd: number;
  /** wLYOverridesBackup, indices 0..0x90 */
  lyBackup: readonly number[];
  /** wBGP / wOBP0 / wOBP1 as DMG palette bytes ($e4 identity) */
  bgp: number;
  obp0: number;
  obp1: number;
  monShade: Readonly<Record<BattlerSide, number>>;
  hidden: Readonly<Record<BattlerSide, boolean>>;
  liftedRows: Readonly<Record<BattlerSide, readonly number[] | undefined>>;
  picSize: Readonly<Record<BattlerSide, number | undefined>>;
  slide: Readonly<Record<BattlerSide, number>>;
  surfWave: readonly number[] | undefined;
  picOverride: Readonly<Record<BattlerSide, PicOverride>>;
}

/** What the UI port implements (onto platform/lcd.ts). Added by the port; not in the Lua. */
export interface AnimPainter {
  /** One OAM entry of a loaded anim sheet: screen px = (OAM x - 8, OAM y - 16) exactly as BattleAnimView.lua:118-119 does,
   *  gfxKey = the importer's gfx key (battle_anims.gfx[name].image), tile = index within that sheet, wide = sheet width in tiles,
   *  attr = OAM flags (X/Y flip 0x20/0x40, priority 0x80, OAM_PAL1 0x10), palette = the PAL_BATTLE_OB_* name. */
  obj(x: number, y: number, gfxKey: string, tile: number, attr: number, palette: string | undefined, wide: number): void;
  /** An OAM entry that falls in a battler pseudo-sheet (the mons' own pic tiles, BattlerGFX commands): side + tile index. */
  battlerObj?(x: number, y: number, side: BattlerSide, tile: number, attr: number, palette: string | undefined): void;
  /** The BG layer for this frame: everything BattleAnimView reads off runner.bg (scx, scy, lcdc, lyStart, lyEnd, lyBackup[0..143],
   *  bgp/obp0/obp1 DMG bytes, monShade, hidden, liftedRows, picSize, slide, surfWave) plus runner.picOverride. */
  bgEffect(state: AnimBgState): void;
}

// An OBJ at OAM (x, y) draws at (x - 8, y - 16).  (BattleAnimView.lua:31)
const OAM_X_BIAS = 8;
const OAM_Y_BIAS = 16;

//--------------------------------------------------------------------------

/** AnimRunner.lua's local `Runner` metatable class. */
export class AnimRunnerInstance {
  data: Record<string, any>;
  constants: Record<string, any>;
  hooks: AnimHooks;
  env: AnimEnv;
  objects: AnimObjectsPool;
  bg: BgEffectsPool;
  animId: string | undefined;
  gfxOrder: (string | number)[];
  sfxOrder: string[];
  param: number;
  var = 0;
  delay = 0;
  loops = 0;
  inSubroutine = false;
  inLoop = false;
  stopped = false;
  keepSprites = false;
  frames = 0;
  tileDict: TileDictEntry[] = [];
  loaded: LoadedSheet[] = [];
  picOverride: Record<BattlerSide, PicOverride> = { player: undefined, enemy: undefined };
  /** The script position; `index` is 1-based into the row list, as in the Lua. */
  address: { key: string; index: number } | undefined = undefined;
  parent: { key: string; index: number } | undefined = undefined;

  // Lua: AnimRunner.lua:74
  constructor(opts?: AnimRunnerOpts) {
    opts = opts ?? {};
    this.data = opts.data ?? {};
    this.constants = opts.constants ?? {};
    this.hooks = opts.hooks ?? {};
    // Shared by both pools; the object functions and the BG effects read the
    // same hBattleTurn.
    this.env = {
      battleTurn: opts.battleTurn ?? 0,
      animId: opts.animId,
      ballPalette: opts.ballPalette,
      sgb: opts.sgb,
      flying: opts.flying ?? {},
    };
    this.objects = AnimObjects.new(this.data, this.constants, this.env);
    this.bg = BgEffects.new(this.constants, this.env);
    // engine/battle_anims/functions.asm:1158
    this.objects.hram = this.bg;
    this.animId = opts.animId; // wFXAnimID
    this.gfxOrder = this.constants.battleAnimGfxOrder ?? [];
    this.sfxOrder = opts.sfxOrder ?? [];

    this.param = opts.param ?? 0; // wBattleAnimParam
    this.var = 0; // wBattleAnimVar
    this.delay = 0; // wBattleAnimDelay
    this.loops = 0; // wBattleAnimLoops
  }

  // ClearBattleAnims: the whole animation block, then the entry point.
  // Lua: AnimRunner.lua:117
  start(scriptKey?: string): this {
    this.objects.clear();
    this.bg.reset();
    this.var = 0;
    this.delay = 0;
    this.loops = 0;
    this.inSubroutine = false;
    this.inLoop = false;
    this.stopped = false;
    this.keepSprites = false;
    this.frames = 0;
    this.tileDict = [];
    this.loaded = [];
    this.picOverride = { player: undefined, enemy: undefined };
    this.address = truthy(scriptKey) ? { key: scriptKey!, index: 1 } : undefined;
    this.parent = undefined;
    return this;
  }

  // Lua: AnimRunner.lua:139
  scriptRows(key: string): AnimRow[] | undefined {
    return (this.data.scripts ?? {})[key];
  }

  // GetBattleAnimByte, one decoded row at a time.
  // Lua: AnimRunner.lua:144
  fetch(): AnimRow | undefined {
    const at = this.address;
    if (!at) return undefined;
    const rows = this.scriptRows(at.key);
    if (!rows) return undefined;
    const row = rows[at.index - 1];
    if (!row) return undefined;
    at.index = at.index + 1;
    return row;
  }

  // The three "skip the branch target" tails: a conditional that does not take
  // its branch steps the address past the two address bytes, which in a decoded
  // row list is simply "carry on".
  // Lua: AnimRunner.lua:158
  jumpTo(key: string): void {
    this.address = { key, index: 1 };
  }

  //------------------------------------------------------------------------
  // The tile dict
  //------------------------------------------------------------------------

  // GetBattleAnimTileOffset: the dict is scanned for the gfx id and its tile
  // returned; a miss is 0, which is why an object whose sheet the script never
  // loaded draws whatever happens to sit at the base tile.
  // Lua: AnimRunner.lua:169
  tileOffsetFor(gfxId: string | number): number {
    for (let i = 0; i < NUM_TILEDICT_ENTRIES; i++) {
      const entry = this.tileDict[i];
      if (entry && entry.gfx === gfxId) return entry.tile;
    }
    return 0;
  }

  // BattleAnimCmd_1GFX..5GFX.  The running tile id restarts at 0 for every
  // command and each sheet is laid down after the last, so two animations that
  // load different sheet counts do not agree about where anything is -- which
  // is exactly why the dict exists.  Entries past the count are NOT cleared.
  // Lua: AnimRunner.lua:181
  loadGfx(names: (string | number)[]): void {
    let tile = 0;
    for (let slot = 0; slot < names.length; slot++) {
      const gfxId = names[slot];
      if (gfxId === undefined) break; // ipairs stops at the first nil
      if (tile >= MAX_ANIM_TILES) break;
      let name = gfxId;
      if (typeof gfxId === "number") {
        name = this.gfxOrder[gfxId] ?? gfxId;
      }
      this.tileDict[slot] = { gfx: name, tile };
      const sheet = (this.data.gfx ?? {})[name];
      this.loaded.push({
        gfx: name,
        tile,
        tiles: (sheet && sheet.tiles) || 0,
      });
      tile = tile + ((sheet && sheet.tiles) || 0);
    }
  }

  // engine/battle_anims/anim_commands.asm:755.  The jumptable crosses the macro
  // names: $d9 (anim_battlergfx_2row) dispatches to _1Row (#1401)
  // Lua: AnimRunner.lua:200
  loadBattlerGfx(rows: number): void {
    const tiles = rows === 2 ? BATTLER_TILES.twoRow : BATTLER_TILES.oneRow;
    // `slot` is the Lua's 1-based dict slot.
    let slot = 1;
    while (slot <= NUM_TILEDICT_ENTRIES && this.tileDict[slot - 1]) {
      slot = slot + 1;
    }
    if (slot + 1 > NUM_TILEDICT_ENTRIES) return;
    this.tileDict[slot - 1] = { gfx: "BATTLE_ANIM_GFX_PLAYERHEAD", tile: tiles.player };
    this.tileDict[slot] = { gfx: "BATTLE_ANIM_GFX_ENEMYFEET", tile: tiles.enemy };
    this.loaded.push({ gfx: "BATTLE_ANIM_GFX_PLAYERHEAD", tile: tiles.player, tiles: rows * 7, battler: "enemy", rows });
    this.loaded.push({ gfx: "BATTLE_ANIM_GFX_ENEMYFEET", tile: tiles.enemy, tiles: rows * 6, battler: "player", rows });
  }

  //------------------------------------------------------------------------

  // RunBattleAnimCommand: burn the delay, otherwise run script rows until one
  // of them asks to wait or the animation ends.
  // Lua: AnimRunner.lua:411
  runCommands(): void {
    if (this.delay !== 0) {
      this.delay = this.delay - 1;
      return;
    }
    for (let n = 0; n < 512; n++) {
      const row = this.fetch();
      if (!row) {
        this.stopped = true;
        return;
      }
      const cmd = row[0];
      if (cmd === "ret") {
        // A `ret` outside a subroutine is what ends the whole animation.
        if (!this.inSubroutine) {
          this.stopped = true;
          return;
        }
        C.ret!(this, row);
      } else if (cmd === "wait") {
        this.delay = (row[1] as number | undefined) ?? 0;
        return;
      } else {
        const fn = C[cmd as string];
        if (fn) fn(this, row);
      }
    }
    // A script that never waits would hang the battle; stopping is the only
    // honest thing to do with one.
    this.stopped = true;
  }

  // One frame.  Returns false once the animation is over.
  // Lua: AnimRunner.lua:444
  step(): boolean {
    if (this.stopped) return false;
    this.frames = this.frames + 1;
    this.runCommands();
    this.bg.playFrame();
    // A BG effect can ask for an object (the battler-pic ones do), and it has
    // to land before the object pass or it would be a frame late.
    for (const spawn of this.bg.takeSpawns()) {
      this.objects.queue(spawn.object, spawn.x, spawn.y, spawn.param, (gfx: string | number) => this.tileOffsetFor(gfx));
    }
    this.objects.playFrame();
    // Rollout hands the shake to the first object's Y offset.
    if (this.bg.rolloutYOffset != null) {
      const first = this.objects.structs[0];
      if (first && first.index !== 0) first.yOffset = this.bg.rolloutYOffset;
    }
    if (this.stopped) {
      // engine/battle_anims/anim_commands.asm:213
      if (!this.keepSprites) {
        this.objects.oam = [];
      } else {
        for (const obj of this.objects.oam) {
          obj.palette = "PAL_BATTLE_OB_ENEMY";
        }
      }
      return false;
    }
    return true;
  }

  // Lua: AnimRunner.lua:475
  oam(): AnimOamEntry[] {
    return this.objects.oam;
  }

  // Lua: AnimRunner.lua:476
  done(): boolean {
    return this.stopped;
  }

  //------------------------------------------------------------------------
  // The painter seam (ours, not in the Lua)
  //------------------------------------------------------------------------

  /**
   * Which loaded sheet a tile id falls in: BattleAnimView.lua:82 sheetForTile.
   * The `loaded` list is in load order and each entry knows its base tile and
   * its length, which is the same walk GetBattleAnimTileOffset does in reverse.
   */
  sheetForTile(tile: number): [LoadedSheet, number] | undefined {
    for (let i = this.loaded.length - 1; i >= 0; i--) {
      const entry = this.loaded[i]!;
      if (tile >= entry.tile && tile < entry.tile + Math.max(entry.tiles, 1)) {
        return [entry, tile - entry.tile];
      }
    }
    return undefined;
  }

  /** This frame's BG-layer state (BattleAnimView reads these off runner.bg). */
  bgState(): AnimBgState {
    const bg = this.bg;
    return {
      scx: bg.scx,
      scy: bg.scy,
      lcdc: bg.lcdc,
      lyStart: bg.lyStart,
      lyEnd: bg.lyEnd,
      lyBackup: bg.lyBackup,
      bgp: bg.bgp,
      obp0: bg.obp0,
      obp1: bg.obp1,
      monShade: bg.monShade,
      hidden: bg.hidden,
      liftedRows: bg.liftedRows,
      picSize: bg.picSize,
      slide: bg.slide,
      surfWave: bg.surfWave,
      picOverride: this.picOverride,
    };
  }

  /**
   * Hand this frame to a painter: every OAM entry resolved to its sheet the
   * way BattleAnimView.lua:110-148 drawObjects does (entries outside any
   * loaded sheet, and sheet rows past the image, are skipped as the view skips
   * them; battler pseudo-sheets go to battlerObj), then the BG state.
   */
  draw(painter: AnimPainter): void {
    const gfx = this.data.gfx ?? {};
    for (const obj of this.oam()) {
      const found = this.sheetForTile(obj.tile);
      if (!found) continue;
      const [entry, index] = found;
      const palette = typeof obj.palette === "string" ? obj.palette : undefined;
      const x = obj.x - OAM_X_BIAS;
      const y = obj.y - OAM_Y_BIAS;
      if (entry.battler) {
        painter.battlerObj?.(x, y, entry.battler, index, obj.attr, palette);
        continue;
      }
      const sheet = gfx[entry.gfx as string];
      if (!sheet || !sheet.image) continue;
      const wide: number = sheet.wide ?? 8;
      // BattleAnimView.lua:124-126: the quad's row must lie inside the image,
      // which the importer pads to whole rows of `wide` tiles.
      const imageRows = Math.ceil((sheet.tiles ?? 0) / wide);
      if (Math.floor(index / wide) >= imageRows) continue;
      painter.obj(x, y, sheet.image, index, obj.attr, palette, wide);
    }
    painter.bgEffect(this.bgState());
  }
}

//--------------------------------------------------------------------------
// BattleAnimCommands
//--------------------------------------------------------------------------

type CommandFn = (self: AnimRunnerInstance, row: AnimRow) => void;
const C: Record<string, CommandFn> = {};

// Lua: AnimRunner.lua:223
C.obj = (self, row) => {
  self.objects.queue(row[1]!, row[2] as number, row[3] as number, row[4] as number, (gfx: string | number) => self.tileOffsetFor(gfx));
};

// Lua: AnimRunner.lua:229
for (let count = 1; count <= 5; count++) {
  C[`${count}gfx`] = (self, row) => {
    const names: (string | number)[] = [];
    for (let i = 1; i <= count; i++) names[i - 1] = row[i]!;
    self.loadGfx(names);
  };
}

// Lua: AnimRunner.lua:237
C.incobj = (self, row) => {
  const st = self.objects.findByIndex(row[1] as number);
  if (st) st.jt = u8(st.jt + 1);
};

// Lua: AnimRunner.lua:242
C.setobj = (self, row) => {
  const st = self.objects.findByIndex(row[1] as number);
  if (st) st.jt = u8(row[2] as number);
};

// Lua: AnimRunner.lua:247
C.incbgeffect = (self, row) => {
  self.bg.incEffect(row[1]!);
};

// anim_commands.asm:317: $d9 (anim_battlergfx_2row) dispatches to _1Row
// Lua: AnimRunner.lua:250-251
C.battlergfx_1row = (self) => self.loadBattlerGfx(2);
C.battlergfx_2row = (self) => self.loadBattlerGfx(1);

// GetPokeBallWobble's answer, which the ball's own script then branches on.
// Lua: AnimRunner.lua:254
C.checkpokeball = (self) => {
  const wobble = self.hooks.pokeballWobble ? self.hooks.pokeballWobble() : undefined;
  self.var = truthy(wobble) ? (wobble as number) : 0;
};

// The commands that swap a battler's pic out for something else.  The port
// records which, and the view draws it.
//
// Every one of them branches on hBattleTurn the same way
// (engine/battle_anims/anim_commands.asm): `and a / jr z, .player`, and the
// .player arm is the one that writes vTiles2 tile $31, the 6x6 BACKPIC slot.
// So turn 0, the player attacking, always repaints the PLAYER's own pic, and
// the fall-through arm (tile $00, the 7x7 frontpic) repaints the enemy's.
// Lua: AnimRunner.lua:266
C.transform = (self) => {
  // BattleAnimCmd_Transform: .player loads wTempEnemyMonSpecies into the
  // backpic slot, i.e. the player's sprite becomes what it transformed into.
  const side: BattlerSide = self.env.battleTurn === 0 ? "player" : "enemy";
  self.picOverride[side] = "transform";
};

// Lua: AnimRunner.lua:273
C.raisesub = (self) => {
  const side: BattlerSide = self.env.battleTurn === 0 ? "player" : "enemy";
  self.picOverride[side] = "substitute";
};

// Lua: AnimRunner.lua:278
C.dropsub = (self) => {
  const side: BattlerSide = self.env.battleTurn === 0 ? "player" : "enemy";
  self.picOverride[side] = false;
};

// BattleAnimCmd_MinimizeOpp / GetMinimizePic: despite the name it shrinks the
// ATTACKER, because .player (turn 0) requests the 6x6 block at tile $31.  The
// other minimize opcode, $e9, is one of the dummies below.
// Lua: AnimRunner.lua:286
C.minimizeopp = (self) => {
  const side: BattlerSide = self.env.battleTurn === 0 ? "player" : "enemy";
  self.picOverride[side] = "minimize";
};

// Lua: AnimRunner.lua:291
C.beatup = (self) => {
  // wBattleAnimParam is the party slot whose pic to show.
  const side: BattlerSide = self.env.battleTurn === 0 ? "player" : "enemy";
  self.picOverride[side] = { kind: "beatup", slot: self.param };
};

// Lua: AnimRunner.lua:297
C.resetobp0 = (self) => {
  self.bg.obp0 = truthy(self.env.sgb) ? 0xf0 : 0xe0;
};

// Lua: AnimRunner.lua:301
C.sound = (self, row) => {
  const packed = (row[1] as number | undefined) ?? 0;
  // The first byte is BOTH the duration (its top six bits) and the cry-track
  // pair (its bottom two), which is why the same value reads twice here.
  const duration = packed >>> 2;
  let tracks = packed & 3;
  if (self.env.battleTurn !== 0) tracks = tracks ^ 1;
  const id = (row[2] as number | undefined) ?? 0;
  const name = self.sfxOrder[id];
  if (self.hooks.sound) {
    self.hooks.sound(name, PANNING[tracks] ?? 0xff, duration, id);
  }
};

// Lua: AnimRunner.lua:315
C.cry = (self, row) => {
  const slot = ((row[1] as number | undefined) ?? 0) & 3;
  const entry = CRY_DATA[slot] ?? CRY_DATA[0]!;
  const side: BattlerSide = self.env.battleTurn === 0 ? "player" : "enemy";
  if (self.hooks.cry) self.hooks.cry(side, entry.pitch, entry.length);
};

// Lua: AnimRunner.lua:322
C.clearobjs = (self) => self.objects.clearObjs();

// Lua: AnimRunner.lua:324-339
C.oamon = () => {};
C.oamoff = () => {};
C.updateactorpic = () => {};
// $e7 and $e8-$ed are `ret` on the cart; $f5-$f7 too.  $e9 is `minimize`, and
// it really is one of them: BattleAnimCmd_E8 through BattleAnimCmd_ED are six
// labels stacked on a single `ret` (engine/battle_anims/anim_commands.asm).
// The minimize animation that is actually drawn is $e2, minimizeopp above.
C.minimize = () => {};
C.unknown_e7 = () => {};
C.unknown_ea = () => {};
C.unknown_eb = () => {};
C.unknown_ec = () => {};
C.unknown_ed = () => {};
C.unknown_f5 = () => {};
C.unknown_f6 = () => {};
C.unknown_f7 = () => {};

// Lua: AnimRunner.lua:341
C.keepsprites = (self) => {
  self.keepSprites = true;
};

// Lua: AnimRunner.lua:343-345
C.bgp = (self, row) => {
  self.bg.bgp = row[1] as number;
};
C.obp0 = (self, row) => {
  self.bg.obp0 = row[1] as number;
};
C.obp1 = (self, row) => {
  self.bg.obp1 = row[1] as number;
};

// Lua: AnimRunner.lua:347
C.bgeffect = (self, row) => {
  self.bg.queue(row[1]!, row[2] as number, row[3] as number, row[4] as number);
};

// Lua: AnimRunner.lua:351-352
C.setvar = (self, row) => {
  self.var = u8(row[1] as number);
};
C.incvar = (self) => {
  self.var = u8(self.var + 1);
};

// Lua: AnimRunner.lua:354
C.if_var_equal = (self, row) => {
  if (row[1] === self.var) self.jumpTo(row[2] as string);
};

// Lua: AnimRunner.lua:358
C.if_param_equal = (self, row) => {
  if (row[1] === self.param) self.jumpTo(row[2] as string);
};

// Lua: AnimRunner.lua:362
C.if_param_and = (self, row) => {
  if ((self.param & ((row[1] as number | undefined) ?? 0)) !== 0) self.jumpTo(row[2] as string);
};

// The one conditional that CONSUMES what it tests: each pass decrements
// wBattleAnimParam, so `anim_jumpuntil` runs its block param times.
// Lua: AnimRunner.lua:368
C.jumpuntil = (self, row) => {
  if (self.param === 0) return;
  self.param = u8(self.param - 1);
  self.jumpTo(row[1] as string);
};

// Lua: AnimRunner.lua:374
C.jump = (self, row) => self.jumpTo(row[1] as string);

// Lua: AnimRunner.lua:376
C.loop = (self, row) => {
  const count = (row[1] as number | undefined) ?? 0;
  if (!self.inLoop) {
    // A count of 0 loops forever and never claims the loop flag.
    if (count !== 0) {
      self.inLoop = true;
      self.loops = u8(count - 1);
    }
    self.jumpTo(row[2] as string);
    return;
  }
  if (self.loops === 0) {
    self.inLoop = false;
    return; // falls through past the target
  }
  self.loops = self.loops - 1;
  self.jumpTo(row[2] as string);
};

// Lua: AnimRunner.lua:395
C.call = (self, row) => {
  self.parent = { key: self.address!.key, index: self.address!.index };
  self.inSubroutine = true;
  self.jumpTo(row[1] as string);
};

// Lua: AnimRunner.lua:401
C.ret = (self) => {
  self.inSubroutine = false;
  self.address = self.parent ? { key: self.parent.key, index: self.parent.index } : undefined;
};

//--------------------------------------------------------------------------

export const AnimRunner = {
  COMMANDS: C,
  NUM_TILEDICT_ENTRIES,
  MAX_ANIM_TILES,
  BATTLER_TILES,

  // opts: see AnimRunnerOpts.
  // Lua: AnimRunner.lua:74
  new(opts?: AnimRunnerOpts): AnimRunnerInstance {
    return new AnimRunnerInstance(opts);
  },

  // The script for a move, or nil when the cache has none (which is what an
  // unextracted or modded move looks like).
  // Lua: AnimRunner.lua:134
  scriptForMove(data: Record<string, any> | undefined, moveId: string | number): string | undefined {
    const moves = (data ?? {}).moves ?? {};
    return moves[moveId];
  },
};

export default AnimRunner;
