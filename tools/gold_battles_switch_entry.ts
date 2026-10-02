// A Citra check of switching BATTLES 3D -> 2D through the OPTION screen
// (cc_gold_bench.sh tools/gold_battles_switch_entry.ts), Isaac's report: VIEW
// 3D, BATTLES 2D, and a wild battle came up over the 3D world with no white
// and no POKeMON. The card's save continued in VIEW 3D / BATTLES 3D; a wild
// battle in the grass of Route 29, RUN; then START > OPTION > GRAPHICS >
// BATTLES pressed to 2D and backed out of with B; then the grass again, a
// top-screen shot every two seconds of each battle. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;

let started = false;
let n = 0;
let placed = false;
let grass: [number, number] | null = null;
let walkLeft = true;
let battles = 0;
let phase: "grass" | "battle" | "menu" = "grass";
let menuAt = 0;
let lastTop = "";
let shots = 0;

function findGrass(w: any): [number, number] | null {
  const width = (w.map.width ?? 0) * 2;
  const height = (w.map.height ?? 0) * 2;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (w.grassAt(x, y) && w.grassAt(x - 1, y) && w.grassAt(x + 1, y)) return [x, y];
    }
  }
  return null;
}

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
    game.options.battleView = "3d";
    game.options.movement = "grid";
  }
  n++;
  const w = game.world;
  const top = game.stack.top();
  const topId: string = top?.screenId ?? "world";
  if (topId !== lastTop) {
    console.log(`[pv] bench top ${topId} at tick ${n} battles ${game.options.battleView}`);
    if (topId === "Gen2BattleState") battles++;
    lastTop = topId;
  }
  let pad = 0;
  if (w?.map && n > 120) {
    if (!placed) {
      placed = true;
      if (w.map.id !== "ROUTE_29") w.warpToMapId("ROUTE_29", 30, 10, "down");
    } else if (phase === "menu") {
      // START > OPTION, then the BATTLES row (GRAPHICS' page) by the cursor,
      // A to step it, B out of the page, the screen and the START menu
      menuAt++;
      if (menuAt === 1) {
        game.openStartMenu();
        game.pushStartMenuItem("option");
      } else if (menuAt === 30) {
        const opt = game.stack.top();
        console.log(`[pv] bench option screen ${opt?.screenId}`);
        opt?.focusRow?.("battleView");
      } else if (menuAt === 60) pad = VOX_BTN.a;
      else if (menuAt === 90) console.log(`[pv] bench BATTLES now ${game.options.battleView}`);
      else if (menuAt > 100 && menuAt % 20 === 0 && game.stack.top()) pad = VOX_BTN.b;
      else if (menuAt > 100 && !game.stack.top()) {
        console.log(`[pv] bench menus closed, BATTLES ${game.options.battleView}`);
        phase = "grass";
      }
    } else if (!top) {
      if (battles === 1 && phase === "battle") {
        phase = "menu";
        menuAt = 0;
      } else if (!grass) {
        grass = findGrass(w);
        if (grass) w.warpToMapId(w.map.id, grass[0], grass[1], "left");
      } else {
        const p = w.player;
        if (!p.moving) {
          if (p.cellX <= grass[0] - 1) walkLeft = false;
          if (p.cellX >= grass[0] + 1) walkLeft = true;
        }
        pad = walkLeft ? VOX_BTN.left : VOX_BTN.right;
      }
    } else if (top.screenId === "Gen2BattleState") {
      phase = "battle";
      if (battles >= 2 && n % 120 === 0 && shots++ < 6) native.screenshot?.();
      if (n % 12 === 0) {
        if (top.phase === "menu" && (battles < 2 || shots >= 6)) {
          pad = (top.menuIndex ?? 1) < 4 ? (n % 24 === 0 ? VOX_BTN.right : VOX_BTN.down) : VOX_BTN.a;
        } else if (top.phase !== "menu") pad = VOX_BTN.a;
      }
    } else if (n % 12 === 0) pad = VOX_BTN.a;
  }
  mainFrame((b & ~0xff) | pad);
};
