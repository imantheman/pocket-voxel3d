// The DEV menu: the playtesting tools behind one START-menu entry, shown
// when the OPTION screen's DEV MENU is ON -- the Kanto games' ui/devmenu.ts
// and ui/warppicker.ts, on Gold's screen. Not a port of anything on the cart;
// nothing in here is reachable in a normal playthrough.
//
//   WARP        every map by name (it opens on the one you stand in); A
//               warps there, onto the map's first warp -- the one spot every
//               map is sure to have standable ground. Left/right page.
//   RARE CANDY  the PACK's RARE CANDY topped up to 99.
//   CARD TEST   writes a file to the SD card and reads it back, then says
//               whether that worked (a card gone read-only still reads its
//               maps perfectly, so nothing else gives it away).

import { Bag } from "../shared/inventory/Bag.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";

/** Rows of the WARP list on screen at once. */
const WARP_ROWS = 7;

type Phase = "menu" | "warp";

/** A map id as a WARP row: 17 tiles, the longest words shortened so the
 *  floors of a building (POKECENTER_1F / _2F) still tell apart. */
function warpLabel(id: string): string {
  return id.replace(/POKECENTER/g, "CENTER").replace(/SPEECH_HOUSE/g, "HOUSE").replace(/_/g, " ").slice(0, 17);
}

export interface DevMenuOpts {
  onClose?: () => void;
}

export class DevMenu {
  game: any;
  onClose: (() => void) | undefined;
  phase: Phase = "menu";
  list: any;
  warpList: any = null;
  /** The maps WARP offers, sorted (the list's values). */
  maps: string[] = [];

  constructor(game: any, opts: DevMenuOpts = {}) {
    this.game = game;
    this.onClose = opts.onClose;
    this.list = Chrome.List.new({
      items: [
        { label: "WARP", value: "warp" },
        { label: "RARE CANDY", value: "candy" },
        { label: "CARD TEST", value: "cardtest" },
        { label: "CANCEL", value: "exit" },
      ],
      x: 9,
      y: 2,
      spacing: 2,
      onChoose: (value: unknown) => this.pick(String(value)),
      onCancel: () => this.close(),
    });
  }

  static new(game: any, opts?: DevMenuOpts): DevMenu {
    return new DevMenu(game, opts);
  }

  close(): void {
    if (this.onClose) this.onClose();
  }

  pick(act: string): void {
    if (act === "exit") return this.close();
    if (act === "warp") return this.openWarp();
    if (act === "candy") return this.giveRareCandies();
    if (act === "cardtest") return this.runWriteTest();
  }

  // ---------------------------------------------------------------- WARP

  openWarp(): void {
    const world = this.game.world;
    const maps = (world && world.maps) || this.game.data?.maps || {};
    this.maps = Object.keys(maps).filter((id) => maps[id] && (maps[id].warps ?? []).length > 0).sort();
    if (this.maps.length === 0) return;
    const here = world && world.map ? world.map.id : undefined;
    const at = here ? this.maps.indexOf(here) : -1;
    this.warpList = Chrome.List.new({
      items: this.maps.map((id) => ({ label: warpLabel(id), value: id })),
      x: 2,
      y: 3,
      spacing: 2,
      rows: WARP_ROWS,
      index: at >= 0 ? at + 1 : 1,
      onChoose: (value: unknown) => this.warp(String(value)),
      onCancel: () => {
        this.phase = "menu";
        this.warpList = null;
      },
    });
    this.phase = "warp";
  }

  /** Warp onto `mapId`'s first warp, the menus closed under it. */
  warp(mapId: string): void {
    const world = this.game.world;
    const def = world && world.maps ? world.maps[mapId] : undefined;
    const w = (def && def.warps ? def.warps : [])[0];
    // this screen and the START menu under it: the warp lands on a bare world
    const stack = this.game.stack;
    while (stack && stack.top && stack.top() && stack.top() !== undefined) {
      const top = stack.top();
      if (top === this || (top && top.screenId === "Gen2StartMenu") || (top && top.screenId === "Gen2MenuFade")) {
        stack.pop();
      } else {
        break;
      }
    }
    if (world && w) world.warpToMapId(mapId, w.x, w.y, "down");
  }

  /** Left/right page the WARP list a screenful at a time. */
  page(delta: number): void {
    const list = this.warpList;
    if (!list) return;
    const n = this.maps.length;
    list.index = Math.max(1, Math.min(n, list.index + delta * WARP_ROWS));
    if (list.index < list.scroll + 1) list.scroll = list.index - 1;
    if (list.index > list.scroll + list.rows) list.scroll = list.index - list.rows;
  }

  // ---------------------------------------------------------- RARE CANDY

  /** A top-up to the stack's 99 rather than a fixed handful, so asking again
   *  near the cap never silently fails (Bag.add refuses past 99). */
  giveRareCandies(): void {
    const save = this.game.save;
    const have = (save && save.inventory && save.inventory.RARE_CANDY) || 0;
    const want = 99 - have;
    if (want <= 0) return this.say(Strings.source("You already have\n99 RARE CANDY!"));
    if (!Bag.add(save, "RARE_CANDY", want, this.game.data)) return this.say(Strings.source("The PACK is full!"));
    this.say(`Got ${want} RARE CANDY!\nNow ×99.`);
  }

  // ----------------------------------------------------------- CARD TEST

  runWriteTest(): void {
    const h = this.game.host;
    if (!h || !h.writeTest) return this.say(Strings.source("This build cannot\ntest card writes."));
    if (h.writeTest()) return this.say(Strings.source("CARD WRITE OK\fwritetest.txt was\nwritten and read\fback."));
    const why = String((h.writeErr && h.writeErr()) || "unknown").slice(0, 36);
    this.say(`CARD WRITE FAILED\f${why}`);
  }

  say(text: string): void {
    if (this.game.say) this.game.say(Strings.get(text));
  }

  // ------------------------------------------------------------- the loop

  update(_dt?: number): void {
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (this.phase === "warp" && this.warpList) {
      if (input.wasPressed("left")) return this.page(-1);
      if (input.wasPressed("right")) return this.page(1);
      if (input.wasPressed("start")) {
        this.phase = "menu";
        this.warpList = null;
        return;
      }
      this.warpList.update(input);
      return;
    }
    if (input.wasPressed("start")) return this.close();
    this.list.update(input);
  }

  draw(): void {
    if (this.phase === "warp" && this.warpList) {
      Chrome.box(0, 0, 20, 18);
      Chrome.print("WARP TO", 1, 1);
      Chrome.printRight(`${this.warpList.index}/${this.maps.length}`, 19, 1);
      this.warpList.draw();
      return;
    }
    Chrome.box(8, 0, 12, 10);
    this.list.draw();
  }
}

export default DevMenu;
