// Port of gen1recomp src/core/game3/battle/anim_sprites.lua (GPLv3 + additional terms; see LICENSE.md).
// Fixed-pool battle anim particles (pret OAM sprite slots analogue).
// No per-frame table.insert/nil churn — acquire overwrites, release clears active.

import { tostring } from "../../../../import/gen3/lua.ts";
import { len, pairs, sort, type LuaTable } from "../../platform/lt.ts";
import { AnimCoords } from "./anim_coords.ts";

/** A pooled particle. Callers hang their own fields on it (Brian's sprites are open tables). */
export type AnimSprite = Record<string, any> & { data: Record<number, any> };

// Lua: anim_sprites.lua:57
function clear_slot(s: AnimSprite): void {
  for (const k of Object.keys(s)) {
    if (k !== "data") delete s[k];
  }
  s.active = false;
  s.x = 0;
  s.y = 0;
  s.ox = 0;
  s.oy = 0;
  s.z = AnimSprites.Z.MID_FIELD;
  s.priority = 2;
  s.subpriority = 0;
  s.alpha = 1;
  s.hFlip = false;
  s.vFlip = false;
  s.rotation = 0;
  s.scaleX = 1;
  s.scaleY = 1;
  s.blendMode = "alpha"; // "alpha" | "add"
  s.visible = true;
  s.w = 16;
  s.h = 16;
  s.palSlot = 0; // index into VM pal buffers
  // (Brian's second sweep of "_" / RESET_KEYS fields is subsumed: every key but
  // data was already cleared above.)
  s.visible = true;
  s.alpha = 1;
  for (let i = 0; i <= 7; i++) {
    s.data[i] = 0;
  }
}

// Lua: anim_sprites.lua:111
function new_slot(): AnimSprite {
  const s: AnimSprite = { data: {} };
  for (let i = 0; i <= 7; i++) s.data[i] = 0;
  clear_slot(s);
  return s;
}

export const AnimSprites: Record<string, any> = {
  MAX: 128,
  Z: {
    GLOBAL_BEHIND: 10,
    ENEMY_BEHIND: 90,
    ENEMY_MON: 100,
    ENEMY_FRONT: 110,
    MID_FIELD: 150,
    PLAYER_BEHIND: 190,
    PLAYER_MON: 200,
    PLAYER_FRONT: 210,
    GLOBAL_FRONT: 900,
  },

  RESET_KEYS: {
    customDraw: true, invisible: true, objBlend: true, palBlend: true,
    affineMode: true, aff: true, animNum: true, animCmdIndex: true,
    animDelayCounter: true, animLoopCounter: true, animEnded: true,
    animPaused: true, animBeginning: true, affineAnimPaused: true,
    affineAnimEnded: true, affineAnimBeginning: true, pretHFlip: true,
    pretVFlip: true, oamPriority: true, cb: true,
  } as Record<string, boolean>,

  _pool: null as LuaTable,
  _overflowLogged: false,
  /** Set by anim_port g4_pret (AnimSprites.animate = ...); nil until then. */
  animate: null as ((s: AnimSprite) => void) | null,

  // Lua: anim_sprites.lua:29 -- Slot-based dynamic Z calculation (supports 1v1 and 2v2 double battles).
  slotZ(slot: unknown, layer: string): number {
    let slotId = 1;
    if (typeof slot === "number") {
      slotId = slot;
    } else if (slot === "player" || slot === "player_left") {
      slotId = 2;
    } else if (slot === "player_right") {
      slotId = 4;
    } else if (slot === "enemy_right") {
      slotId = 3;
    } else { // "enemy" or "enemy_left"
      slotId = 1;
    }

    if (layer === "behind") {
      return (slotId * 100) - 10;
    } else if (layer === "mon") {
      return (slotId * 100);
    } else if (layer === "front") {
      return (slotId * 100) + 10;
    } else if (layer === "global_behind") {
      return 10;
    } else if (layer === "global_front") {
      return 900;
    }
    return (slotId * 100) + 10;
  },

  // Lua: anim_sprites.lua:118
  init(): void {
    if (AnimSprites._pool) return;
    AnimSprites._pool = [null];
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      AnimSprites._pool[i] = new_slot();
    }
    AnimSprites._overflowLogged = false;
  },

  // Lua: anim_sprites.lua:127
  reset(): void {
    AnimSprites.init();
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      clear_slot(AnimSprites._pool[i]);
    }
    AnimSprites._overflowLogged = false;
  },

  // Lua: anim_sprites.lua:136 -- Sweep and destroy any active particles bound to a fainted/switched host battler.
  clearHost(hostId: unknown): void {
    if (hostId == null || hostId === false) return;
    AnimSprites.init();
    const want = AnimCoords.idOf(hostId);
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      const s = AnimSprites._pool[i];
      if (s.active && s.hostId != null && (s.hostId === hostId || (want != null && AnimCoords.idOf(s.hostId) === want))) {
        clear_slot(s);
      }
    }
  },

  // Lua: anim_sprites.lua:150 -- Acquire a free slot. Returns sprite or nil if pool exhausted.
  acquire(opts?: Record<string, any>): AnimSprite | null {
    AnimSprites.init();
    opts = opts || {};
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      const s = AnimSprites._pool[i];
      if (!s.active) {
        clear_slot(s);
        s.active = true;
        s.x = opts.x ?? 0;
        s.y = opts.y ?? 0;
        s.z = opts.z ?? AnimSprites.Z.MID_FIELD;
        s.priority = opts.priority ?? 2;
        s.subpriority = opts.subpriority ?? 0;
        s.hostId = opts.hostId;
        s.tag = opts.tag;
        s.template = opts.template;
        s.image = opts.image;
        s.quad = opts.quad;
        s.w = opts.w ?? 16;
        s.h = opts.h ?? 16;
        s.hFlip = !!opts.hFlip;
        s.vFlip = !!opts.vFlip;
        s.rotation = opts.rotation ?? 0;
        s.scaleX = opts.scaleX ?? 1;
        s.scaleY = opts.scaleY ?? 1;
        s.originX = opts.originX;
        s.originY = opts.originY;
        s.blendMode = opts.blendMode ?? "alpha";
        s.callback = opts.callback;
        s.palSlot = opts.palSlot ?? 0;
        s.monoTint = opts.monoTint;
        if (opts.data) {
          for (const [k, v] of pairs(opts.data)) {
            s.data[k as number] = v;
          }
        }
        return s;
      }
    }
    if (!AnimSprites._overflowLogged) {
      console.log("[battle.anim] sprite pool exhausted (" + tostring(AnimSprites.MAX) + ")");
      AnimSprites._overflowLogged = true;
    }
    return null;
  },

  // Lua: anim_sprites.lua:196
  release(sprite: AnimSprite | null | undefined): void {
    if (!sprite) return;
    clear_slot(sprite);
  },

  // Lua: anim_sprites.lua:201
  activeCount(): number {
    AnimSprites.init();
    let n = 0;
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      if (AnimSprites._pool[i].active) n = n + 1;
    }
    return n;
  },

  // Lua: anim_sprites.lua:210
  forEachActive(fn: (s: AnimSprite, i: number) => void): void {
    AnimSprites.init();
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      const s = AnimSprites._pool[i];
      if (s.active) fn(s, i);
    }
  },

  // Lua: anim_sprites.lua:218
  update(): void {
    AnimSprites.init();
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      const s = AnimSprites._pool[i];
      if (s.active && s.callback) {
        try {
          s.callback(s);
        } catch (err) {
          console.log("[battle.anim] sprite cb: " + tostring(err));
          AnimSprites.release(s);
        }
      }
      if (s.active && s._g4anim && AnimSprites.animate) {
        try {
          AnimSprites.animate(s);
        } catch (err) {
          console.log("[battle.anim] sprite anim: " + tostring(err));
          try { AnimSprites.release(s); } catch { /* pcall */ }
        }
      }
    }
  },

  // Lua: anim_sprites.lua:240 -- Collect active sprites sorted by z and subpriority, filtered by optional [minZ, maxZ] range.
  sortedDrawList(out: LuaTable, minZ?: number | null, maxZ?: number | null): LuaTable {
    out = out || [null];
    for (let i = len(out); i >= 1; i--) out[i] = null;
    AnimSprites.init();
    for (let i = 1; i <= AnimSprites.MAX; i++) {
      const s = AnimSprites._pool[i];
      if (s.active && s.visible) {
        const z = s.z ?? AnimSprites.Z.MID_FIELD;
        if ((minZ == null || z >= minZ) && (maxZ == null || z <= maxZ)) {
          out[len(out) + 1] = s;
        }
      }
    }
    sort(out, (a: any, b: any) => {
      const za = a.z ?? AnimSprites.Z.MID_FIELD;
      const zb = b.z ?? AnimSprites.Z.MID_FIELD;
      if (za !== zb) return za < zb;
      const sa = a.subpriority ?? 0;
      const sb = b.subpriority ?? 0;
      if (sa !== sb) return sa < sb;
      return false;
    });
    return out;
  },
};

export default AnimSprites;
