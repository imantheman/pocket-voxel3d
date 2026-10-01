// wCmdQueue: engine/overworld/cmd_queue.asm and home/stone_queue.asm.
// A port of gen1recomp src/world/gen2/CmdQueue.lua at bdfac727 (MIT).
//
// Four five-byte slots, polled once a frame by HandleCmdQueue, written by the
// `writecmdqueue` script command and cleared by `delcmdqueue`.
//
// Only one of the five queue types does anything a player can see, and it is
// the one that matters most: CMDQUEUE_STONETABLE is what makes a boulder pushed
// onto a hole fall through it. Two maps use it -- Ice Path B1F and Blackthorn
// Gym 2F -- and Ice Path gates Blackthorn, so without this the eighth badge is
// unreachable.
//
//   CmdQueue_Null       ret
//   CmdQueue_Type1      SetXYCompareFlags
//   CmdQueue_StoneTable the boulder check below
//   CmdQueue_Type3      ret
//   CmdQueue_Type4      an hSCY shake, unreferenced by any map
//
// love-free: the caller supplies the objects, the warps and a collision lookup.
//
// Port shape: the queue is a 0-based JS array of CAPACITY slots (the Lua's
// queue[1..4]); the SLOT NUMBERS this module hands back (write's answer) stay
// Lua's 1-based ones.

import { Strings } from "../shared/core/Strings.ts";

/** One stonetable row: `db warp, object / dw script`. */
export interface StoneRow {
  warp: number;
  object: number;
  /** An inlined command list (STONE_TABLES) or a scripts.json key (extracted). */
  script: any;
}

export interface CmdQueueEntry {
  kind: number;
  rows?: StoneRow[];
  mapId?: string;
  extracted?: boolean;
  [key: string]: any;
}

export type CmdQueueSlots = (CmdQueueEntry | undefined)[];

/** What HandleCmdQueue reads off one map object. */
export interface CmdQueueObject {
  id: number;
  movement?: number;
  cellX: number;
  cellY: number;
  moving?: boolean;
  visible?: boolean;
  [key: string]: any;
}

export interface CmdQueueCtx {
  objects?: CmdQueueObject[];
  warps?: { x: number; y: number; [key: string]: any }[];
  collisionAt: (x: number, y: number) => number | undefined;
}

// Lua: CmdQueue.lua:36 -- CheckPitTile (home/map_objects.asm): COLL_PIT and
// COLL_PIT_68.
const PIT: Record<number, true> = { 0x60: true, 0x68: true };

// Lua: CmdQueue.lua:182 -- the event flags this cache assigns:
//   EVENT_BOULDER_IN_ICE_PATH_1..4   1801..1804  (the B1F boulders themselves)
//   EVENT_BOULDER_IN_ICE_PATH_1A..4A 1805..1808  (their twins one floor down,
//       on ICE_PATH_B2F_MAHOGANY_SIDE -- clearing one is what makes the fallen
//       boulder appear down there)
// Consecutive `const`s in constants/event_flags.asm.
const ICE_PATH_BOULDER_EVENT = [1805, 1806, 1807, 1808];

// Lua: CmdQueue.lua:184-206 -- maps/IcePathB1F.asm .FinishBoulder, shared by
// all four rows: pause 30 / scall .BoulderFallsThrough / opentext / writetext /
// waitbutton / closetext / end, where .BoulderFallsThrough is playsound
// SFX_STRENGTH + earthquake 80 (two pixels for sixteen frames).
function boulderScript(objectId: number, clearEvent: number | undefined, text: string): any[] {
  const script: any[] = [
    { op: "disappear", object: objectId },
  ];
  if (clearEvent != null) {
    script.push({ op: "clearevent", event: clearEvent });
  }
  script.push({ op: "pause", frames: 30 });
  script.push({ op: "playsound", id: 27 }); // SFX_STRENGTH
  script.push({ op: "earthquake", param: 80 });
  script.push({ op: "opentext" });
  // `rawtext` is the port's own command, not the cart's: `writetext` names a
  // key into text.json and this string was never extracted.
  script.push({ op: "rawtext", text });
  script.push({ op: "waitbutton" });
  script.push({ op: "closetext" });
  script.push({ op: "end" });
  return script;
}

// Lua: CmdQueue.lua:208-209
const ICE_PATH_TEXT = Strings.source("The boulder fell\nthrough.");
const BLACKTHORN_TEXT = Strings.source("The boulder fell\nthrough!");

export const CmdQueue = {
  // Lua: CmdQueue.lua:25
  CAPACITY: 4,

  // Lua: CmdQueue.lua:27-33 -- HandleQueuedCommand.Jumptable order
  // (constants/script_constants.asm).
  NULL: 0,
  TYPE1: 1,
  STONETABLE: 2,
  TYPE3: 3,
  TYPE4: 4,
  NUM_TYPES: 5,

  // Lua: CmdQueue.lua:38-41 -- SPRITEMOVEDATA_STRENGTH_BOULDER. The check is on
  // the MOVEMENT type, not on SPRITE_BOULDER: Blackthorn Gym 2F has six
  // boulders and only three of them are in its stone table, but all six carry
  // this movedata.
  BOULDER_MOVEDATA: 0x19,

  // Lua: CmdQueue.lua:43-45
  new(): CmdQueueSlots {
    return [];
  },

  // Lua: CmdQueue.lua:47-53 -- ClearCmdQueue: every slot's TYPE byte zeroed.
  // Called on a map load, which is why a queue never survives a warp and every
  // map that needs one writes it back from a MAPCALLBACK_CMDQUEUE callback.
  clear(queue: CmdQueueSlots): CmdQueueSlots {
    for (let i = 0; i < CmdQueue.CAPACITY; i++) queue[i] = undefined;
    return queue;
  },

  // Lua: CmdQueue.lua:55-66 -- WriteCmdQueue -> .GetNextEmptyEntry. A full
  // queue sets carry and the write is simply DROPPED; there is no error path
  // and no overwrite. Answers the 1-based slot number, or undefined.
  write(queue: CmdQueueSlots, entry: unknown): number | undefined {
    if (entry === null || typeof entry !== "object") return undefined;
    const e = entry as CmdQueueEntry;
    if (e.kind == null || (e.kind as unknown) === false) return undefined;
    for (let i = 0; i < CmdQueue.CAPACITY; i++) {
      if (queue[i] == null) {
        queue[i] = e;
        return i + 1;
      }
    }
    return undefined;
  },

  // Lua: CmdQueue.lua:68-81 -- DelCmdQueue. Answers whether it FOUND and
  // deleted an entry of that type -- the opposite of what `delcmdqueue` writes
  // to wScriptVar, because Script_delcmdqueue's `ret c` returns on the delete
  // with wScriptVar still 0 and only falls through to TRUE when the loop ran
  // off the end.
  delete(queue: CmdQueueSlots, kind: unknown): boolean {
    for (let i = 0; i < CmdQueue.CAPACITY; i++) {
      const entry = queue[i];
      if (entry && entry.kind === kind) {
        queue[i] = undefined;
        return true;
      }
    }
    return false;
  },

  // Lua: CmdQueue.lua:83-89
  count(queue: CmdQueueSlots): number {
    let n = 0;
    for (let i = 0; i < CmdQueue.CAPACITY; i++) {
      if (queue[i]) n = n + 1;
    }
    return n;
  },

  // Lua: CmdQueue.lua:91-104 -- .IsObjectOnWarp's `.check_on_warp`: a linear
  // walk of the map's warp_events for one at the object's cell, answering the
  // warp NUMBER rather than a boolean. The number is 1-based (`ld a,
  // [wCurMapWarpEventCount] / sub d / inc a`), the numbering `stonetable`'s
  // first byte uses. The cart subtracts 4 from the object's stored coordinates
  // (the map border's offset); the port stores plain map cells.
  warpNumberAt(warps: { x: number; y: number }[] | undefined, x: number, y: number): number | undefined {
    const list = warps ?? [];
    for (let i = 0; i < list.length; i++) {
      const warp = list[i]!;
      if (warp.x === x && warp.y === y) return i + 1;
    }
    return undefined;
  },

  // Lua: CmdQueue.lua:106-114 -- .IsObjectInStoneTable: walk `db warp, object /
  // dw script` rows until $ff. BOTH bytes have to match, which is what keeps a
  // boulder pushed onto the wrong hole from falling through it.
  stoneRow(rows: StoneRow[] | undefined, warpNumber: number, objectId: number): StoneRow | undefined {
    for (const row of rows ?? []) {
      if (row.warp === warpNumber && row.object === objectId) return row;
    }
    return undefined;
  },

  // Lua: CmdQueue.lua:116-140 -- CmdQueue_StoneTable. Four gates on the object
  // before HandleStoneQueue is even called, all load bearing:
  //   OBJECT_SPRITE non-zero   -- a disappeared boulder has no struct left
  //   OBJECT_MOVEMENT_TYPE     -- SPRITEMOVEDATA_STRENGTH_BOULDER
  //   CheckPitTile             -- the tile UNDER the boulder is a hole
  //   OBJECT_WALKING STANDING  -- not mid-push, or it would fall a step early
  // The loop returns on the FIRST boulder that falls, so two boulders never
  // drop on the same frame. Lua returned (row, obj): a TUPLE here.
  stoneFall(entry: CmdQueueEntry | undefined, ctx: CmdQueueCtx | undefined): [StoneRow, CmdQueueObject] | undefined {
    const rows = entry ? entry.rows : undefined;
    if (!rows) return undefined;
    for (const obj of (ctx ? ctx.objects : undefined) ?? []) {
      if (obj.visible !== false
          && obj.movement === CmdQueue.BOULDER_MOVEDATA
          && !obj.moving) {
        const coll = ctx!.collisionAt(obj.cellX, obj.cellY);
        if (coll != null && PIT[coll]) {
          const warp = CmdQueue.warpNumberAt(ctx!.warps, obj.cellX, obj.cellY);
          const row = warp != null ? CmdQueue.stoneRow(rows, warp, obj.id) : undefined;
          if (row) return [row, obj];
        }
      }
    }
    return undefined;
  },

  // Lua: CmdQueue.lua:142-155 -- HandleCmdQueue: every slot, in order, once a
  // frame. Only STONETABLE produces anything for the caller to act on; the
  // other four are the cart's own `ret`s and its unreferenced hSCY shake.
  // Lua returned (row, obj, slot); its one caller (World:handleCmdQueue) reads
  // only the row, so the port returns the row alone.
  poll(queue: CmdQueueSlots, ctx: CmdQueueCtx): StoneRow | undefined {
    for (let i = 0; i < CmdQueue.CAPACITY; i++) {
      const entry = queue[i];
      if (entry && entry.kind === CmdQueue.STONETABLE) {
        const fell = CmdQueue.stoneFall(entry, ctx);
        if (fell) return fell[0];
      }
    }
    return undefined;
  },

  // Lua: CmdQueue.lua:157-232 -- the two stone tables. DATA the extractor
  // could not reach when Brian wrote this (a stone table hangs off a
  // MAPCALLBACK_CMDQUEUE callback), hand-ported with their source cited; when
  // the cache carries the callback these become the fallback rather than the
  // source (World:writeCmdQueue prefers an extracted entry). Object ids are the
  // cart's own (`object_const_def` is `const_def 2`, so the first object_event
  // is id 2); warp numbers are 1-based into the map's warp_events.
  STONE_TABLES: {
    // maps/IcePathB1F.asm IcePathB1FSetUpStoneTableCallback.
    ICE_PATH_B1F: [
      { warp: 3, object: 2,
        script: boulderScript(2, ICE_PATH_BOULDER_EVENT[0], ICE_PATH_TEXT) },
      { warp: 4, object: 3,
        script: boulderScript(3, ICE_PATH_BOULDER_EVENT[1], ICE_PATH_TEXT) },
      { warp: 5, object: 4,
        script: boulderScript(4, ICE_PATH_BOULDER_EVENT[2], ICE_PATH_TEXT) },
      { warp: 6, object: 5,
        script: boulderScript(5, ICE_PATH_BOULDER_EVENT[3], ICE_PATH_TEXT) },
    ],
    // maps/BlackthornGym2F.asm. Note the warp order: BOULDER1 goes to warp 5,
    // BOULDER2 to warp 3 and BOULDER3 to warp 4 -- transcribed rather than
    // tidied. These three clear no event: the boulder is simply gone.
    BLACKTHORN_GYM_2F: [
      { warp: 5, object: 4, script: boulderScript(4, undefined, BLACKTHORN_TEXT) },
      { warp: 3, object: 5, script: boulderScript(5, undefined, BLACKTHORN_TEXT) },
      { warp: 4, object: 6, script: boulderScript(6, undefined, BLACKTHORN_TEXT) },
    ],
  } as Record<string, StoneRow[]>,

  // Lua: CmdQueue.lua:234-240 -- MAPCALLBACK_CMDQUEUE's whole job on both maps:
  // `writecmdqueue .CommandQueue` where the entry is `cmdqueue
  // CMDQUEUE_STONETABLE, .StoneTable`.
  mapEntry(mapId: string): CmdQueueEntry | undefined {
    const rows = CmdQueue.STONE_TABLES[mapId];
    if (!rows) return undefined;
    return { kind: CmdQueue.STONETABLE, rows, mapId };
  },

  // Lua: CmdQueue.lua:242-261 -- the same entry taken from the cache: the
  // extractor follows `writecmdqueue`'s operand into the stonetable, so a row
  // names a scripts.json key rather than an inlined command list. Undefined
  // for a cache that predates that, or for any of the four queue types nothing
  // acts on, so the caller falls back to STONE_TABLES.
  fromExtracted(entry: any, mapId: string): CmdQueueEntry | undefined {
    if (entry === null || typeof entry !== "object") return undefined;
    if (entry.type !== CmdQueue.STONETABLE) return undefined;
    const rows: StoneRow[] = [];
    for (const row of entry.rows ?? []) {
      if (row.warp != null && row.object != null && row.scriptKey != null) {
        rows.push({ warp: row.warp, object: row.object, script: row.scriptKey });
      }
    }
    if (rows.length === 0) return undefined;
    return { kind: CmdQueue.STONETABLE, rows, mapId, extracted: true };
  },
};

export default CmdQueue;
