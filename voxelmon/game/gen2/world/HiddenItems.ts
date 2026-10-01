// Hidden items: engine/events/checkforhiddenitems.asm (the ITEMFINDER sweep)
// and the BGEVENT_ITEM arm of the bg event dispatch (`.itemifset` in
// engine/overworld/events.asm, reached from home/map.asm
// CheckIfFacingTileCoordIsBGEvent), whose body is HiddenItemScript
// (engine/events/hidden_item.asm).
// A port of gen1recomp src/world/gen2/HiddenItems.lua at bdfac727 (MIT).
//
// A `bg_event x, y, BGEVENT_ITEM, Label` does NOT name a script. Its operand
// points at `hiddenitem item, flag` (`dwb flag, item`, macros/scripts/maps.asm),
// and the extractor carries those two numbers on the bg event row as
// `hiddenItem = { item, event }`.
//
// love-free: the caller supplies the map def, the player cell, the flag store
// and a name-to-id sfx resolver, and gets back a command list for the VM.

import { Strings } from "../shared/core/Strings.ts";
import { truthy } from "../platform/lua.ts";
import type { Events } from "./Events.ts";

/** `sfxId(label, fallback)`: a pokegold sfx label against this cache's table. */
export type SfxIdFn = (label: string, fallback: number) => unknown;

export interface HiddenItemRow {
  x: number;
  y: number;
  item: any;
  event: number;
}

// Lua: HiddenItems.lua:24-30 -- constants/hardware.inc: the screen is 20x18
// TILES and a walk cell is two tiles on a side, so SCREEN_WIDTH / 4 and
// SCREEN_HEIGHT / 4 are half a screen in cells. RGBDS divides integers, so
// 18 / 4 is 4 and 18 / 2 is 9: the sweep box is NOT symmetric about the
// player and transcribing it as one loses a row.
const HALF_SCREEN_X = 5;
const HALF_SCREEN_Y = 4;
const SCREEN_CELLS_X = 10;
const SCREEN_CELLS_Y = 9;

// Lua: HiddenItems.lua:32-36 -- constants/sfx_constants.asm, resolved by LABEL
// at call time; the ids here are only the fallback.
const SFX_SECOND_PART_OF_ITEMFINDER: [string, number] = ["Sfx_SecondPartOfItemfinder", 18];
const SFX_TRANSACTION: [string, number] = ["Sfx_Transaction", 34];
const SFX_ITEM: [string, number] = ["Sfx_Item", 1];

// Lua: HiddenItems.lua:38-49 -- data/text/common_1.asm and common_2.asm. None
// of these four is reachable from a script pointer, so there is no text.json
// key to name them by.
const TEXT_PLAYER_FOUND = Strings.source("{PLAYER} found\n{STRBUF}.");
const TEXT_BUT_NO_SPACE = Strings.source("But {PLAYER} has\nno space left…");
const TEXT_ITEMFINDER_NEARBY = Strings.source(
  "Yes! ITEMFINDER\nindicates there's\nan item nearby.");
const TEXT_ITEMFINDER_NOPE = Strings.source(
  "Nope! ITEMFINDER\nisn't responding.");

// Lua: HiddenItems.lua:51-62 -- the ITEMBALL pair is NOT the hidden item's
// pair. FindItemInBallScript writes _FoundItemText and _CantCarryItemText
// (data/text/common_2.asm:199 and :206): the found line ends on "!" where the
// hidden item's ends on ".", and the full-pocket line is three lines where
// _ButNoSpaceText is two. The `\v` is the `cont` in that third line.
const TEXT_FOUND_ITEM = Strings.source("{PLAYER} found\n{STRBUF}!");
const TEXT_CANT_CARRY = Strings.source(
  "But {PLAYER} can't\ncarry any more\vitems!");

// Lua `sfxId and sfxId(label, id) or id`.
function resolveSfx(sfxId: SfxIdFn | undefined, sfx: [string, number]): unknown {
  const id = sfxId ? sfxId(sfx[0], sfx[1]) : undefined;
  return truthy(id) ? id : sfx[1];
}

export const HiddenItems = {
  // Lua: HiddenItems.lua:21-22 -- constants/script_constants.asm BGEVENT_*.
  BGEVENT_ITEM: 7,

  // Lua: HiddenItems.lua:64-71 -- the `hiddenitem` pair on a bg event row, or
  // undefined when the row is not one.
  dataOf(bgEvent: any): { item: any; event: number } | undefined {
    if (bgEvent === null || typeof bgEvent !== "object") return undefined;
    if (bgEvent.kind !== HiddenItems.BGEVENT_ITEM) return undefined;
    const data = bgEvent.hiddenItem;
    if (data === null || typeof data !== "object" || !truthy(data.item)) return undefined;
    return data;
  },

  // Lua: HiddenItems.lua:73-85 -- every still-unfound hidden item on a map, in
  // bg_event order. `events` is the wEventFlags store (Events.ts); an absent
  // one means "nothing found yet".
  unfound(mapDef: any, events?: Events | null): HiddenItemRow[] {
    const out: HiddenItemRow[] = [];
    for (const ev of (mapDef ? mapDef.bgEvents : undefined) ?? []) {
      const data = HiddenItems.dataOf(ev);
      if (data && !(events && events.get(data.event))) {
        out.push({ x: ev.x, y: ev.y, item: data.item, event: data.event });
      }
    }
    return out;
  },

  // Lua: HiddenItems.lua:87-106 -- CheckForHiddenItems' box. The cart takes
  // the BOTTOM RIGHT corner of the screen (player + half a screen on each
  // axis) and computes corner minus event coordinate as an unsigned byte.
  // Carry -- past the corner -- skips it, and so does a difference of a whole
  // screen or more. So the surviving box is
  //   x in [player - 4 .. player + 5]   (10 cells, the player left of centre)
  //   y in [player - 4 .. player + 4]   (9 cells, the player centred)
  // which is the visible screen, not a radius: the ITEMFINDER really does
  // answer for an item the player can see but has walked past.
  onScreen(px: number, py: number, ex: number, ey: number): boolean {
    const dx = (px + HALF_SCREEN_X) - ex;
    const dy = (py + HALF_SCREEN_Y) - ey;
    if (dx < 0 || dx >= SCREEN_CELLS_X) return false;
    if (dy < 0 || dy >= SCREEN_CELLS_Y) return false;
    return true;
  },

  // Lua: HiddenItems.lua:108-118 -- the whole of CheckForHiddenItems: the
  // first unfound hidden item on screen, or undefined. The cart returns a bare
  // carry; the row is returned here and a caller that wants the boolean tests
  // for undefined.
  nearby(mapDef: any, px: number | undefined, py: number | undefined, events?: Events | null): HiddenItemRow | undefined {
    if (!(mapDef && px != null && py != null)) return undefined;
    for (const row of HiddenItems.unfound(mapDef, events)) {
      if (HiddenItems.onScreen(px, py, row.x, row.y)) return row;
    }
    return undefined;
  },

  // Lua: HiddenItems.lua:120-136 -- the hidden item at a cell, if still
  // unfound. `.itemifset` checks the flag FIRST and jumps to `.dontread` when
  // it is set, so an already-taken hidden item does not eat the A press: the
  // press falls through to TryTileCollisionEvent as if the bg event were not
  // there at all.
  at(mapDef: any, cx: number, cy: number, events?: Events | null): HiddenItemRow | undefined {
    for (const ev of (mapDef ? mapDef.bgEvents : undefined) ?? []) {
      if (ev.x === cx && ev.y === cy) {
        const data = HiddenItems.dataOf(ev);
        if (data && !(events && events.get(data.event))) {
          return { x: ev.x, y: ev.y, item: data.item, event: data.event };
        }
        return undefined;
      }
    }
    return undefined;
  },

  // Lua: HiddenItems.lua:138-173 -- HiddenItemScript
  // (engine/events/hidden_item.asm), command for command:
  //   opentext / readmem wHiddenItemID / getitemname STRING_BUFFER_3,
  //   USE_SCRIPT_VAR / writetext .PlayerFoundItemText / giveitem ITEM_FROM_MEM /
  //   iffalse .bag_full / callasm SetMemEvent / specialsound / itemnotify /
  //   sjump .finish
  // The item is baked into the list (built per pickup). `callasm SetMemEvent`
  // is the flag write, and lands only where the item was really taken -- a
  // full pack leaves it findable again. `rawtext` is the port's own command.
  pickupScript(item: any, event: number): any[] {
    const bagFull = [
      { op: "promptbutton" },
      { op: "rawtext", text: TEXT_BUT_NO_SPACE },
      { op: "waitbutton" },
      { op: "closetext" },
      { op: "end" },
    ];
    return [
      { op: "opentext" },
      { op: "getitemname", item },
      { op: "rawtext", text: TEXT_PLAYER_FOUND },
      { op: "giveitem", item, quantity: 1 },
      { op: "iffalse", script: bagFull },
      { op: "setevent", event },
      { op: "specialsound" },
      { op: "itemnotify" },
      { op: "closetext" },
      { op: "end" },
    ];
  },

  // Lua: HiddenItems.lua:175-249 -- FindItemInBallScript
  // (engine/events/misc_scripts.asm:9), command for command:
  //   callasm .TryReceiveItem / iffalse .no_room / disappear LAST_TALKED /
  //   opentext / writetext .FoundItemText / playsound SFX_ITEM / pause 60 /
  //   itemnotify / closetext / end
  //   .no_room: opentext / writetext .FoundItemText / waitbutton /
  //   writetext .CantCarryItemText / waitbutton / closetext / end
  // The A-press arm for an OBJECTTYPE_ITEMBALL object (the extractor read the
  // item/quantity pair into `def.itemball`). `.TryReceiveItem` does BOTH the
  // GetItemName and the ReceiveItem before a box is drawn, so both come first
  // here; the sound is an unconditional `playsound SFX_ITEM`, not
  // `specialsound`; `disappear` lands BEFORE the text; and the success arm
  // holds on `pause 60` under the found line before itemnotify.
  // `disappear` stands in for the hidden item's flag write
  // (World:disappearObject sets the object's own event flag). The pause
  // operand is the cart's literal 60; the x2 of Script_pause lives on
  // Vm:pauseFrames.
  ballPickupScript(item: any, quantity: number | undefined, objectId: unknown, sfxId?: SfxIdFn): any[] {
    const noRoom = [
      { op: "opentext" },
      { op: "rawtext", text: TEXT_FOUND_ITEM },
      { op: "waitbutton" },
      { op: "rawtext", text: TEXT_CANT_CARRY },
      { op: "waitbutton" },
      { op: "closetext" },
      { op: "end" },
    ];
    return [
      { op: "getitemname", item },
      { op: "giveitem", item, quantity: quantity ?? 1 },
      { op: "iffalse", script: noRoom },
      { op: "disappear", object: objectId },
      { op: "opentext" },
      // `playsound` leads the text rather than trailing it, and the `pause 60`
      // rides the text row as `hold`, because this port's box takes its own
      // button and pops on it. The cart prints the found line and the
      // itemnotify line into the SAME box with `playsound SFX_ITEM / pause 60`
      // between them (misc_scripts.asm:13-17); `stay` + `hold` keeps the one
      // box up for the jingle and the pause, and World:showText hands it
      // straight over to the itemnotify page in the frame the hold drains.
      { op: "playsound", id: resolveSfx(sfxId, SFX_ITEM) },
      { op: "rawtext", text: TEXT_FOUND_ITEM, stay: true, hold: 60 },
      { op: "itemnotify" },
      { op: "closetext" },
      { op: "end" },
    ];
  },

  // Lua: HiddenItems.lua:251-287 -- ItemFinder's two queued scripts
  // (engine/items/itemfinder.asm). .ItemfinderSound is `ld c, 4` around
  // WaitPlaySFX SFX_SECOND_PART_OF_ITEMFINDER then WaitPlaySFX
  // SFX_TRANSACTION, and WaitPlaySFX waits BEFORE it plays, so the wait leads
  // each of the eight sounds -- the last one is left ringing under the box.
  // The cart's `refreshmap` and `special UpdateTimePals` are dropped: the port
  // draws the PACK as a state over an untouched world, and its `refreshmap`
  // would be a real map reload.
  itemfinderScript(found: unknown, sfxId?: SfxIdFn): any[] {
    const script: any[] = [];
    if (truthy(found)) {
      for (let n = 1; n <= 4; n++) {
        for (const sfx of [SFX_SECOND_PART_OF_ITEMFINDER, SFX_TRANSACTION]) {
          script.push({ op: "waitsfx" });
          script.push({ op: "playsound", id: resolveSfx(sfxId, sfx) });
        }
      }
    }
    script.push({ op: "opentext" });
    script.push({
      op: "rawtext",
      text: truthy(found) ? TEXT_ITEMFINDER_NEARBY : TEXT_ITEMFINDER_NOPE,
    });
    script.push({ op: "waitbutton" });
    script.push({ op: "closetext" });
    script.push({ op: "end" });
    return script;
  },
};

export default HiddenItems;
