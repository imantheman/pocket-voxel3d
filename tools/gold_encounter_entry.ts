// A Citra check of Gold's wild encounters the way they happen in play
// (cc_gold_bench.sh tools/gold_encounter_entry.ts): the card's save
// continued, the player put on a patch of Route 29's tall grass and walked
// back and forth through it until a wild Pokémon jumps out; then A through
// the battle (RUN) and back to the grass, again and again. Logged: the tick
// the encounter fires, the tick the battle's menu comes up, and Gold's own
// step/draw/lcd/view split. ONLY="view,battles" at bundle time: those, a top-screen
// shot (native screenshot) of every battle's menu. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

declare const ONLY: string;

const g = globalThis as unknown as { goldGame: any; goldProf: boolean; frame: (b: number) => void };
g.goldProf = true;
// INTRO=1 at bundle time: the bottom screen's battle page off (A/B timing)
declare const INTRO: boolean;
if (typeof INTRO !== "undefined") (globalThis as { noBattlePanel?: boolean }).noBattlePanel = true;
const game = g.goldGame;
const mainFrame = g.frame;

let started = false;
let n = 0;
let placed = false;
let grass: [number, number] | null = null;
let fired = -1;
let lastTop = "";
let walkLeft = true;
let shots = 0;
let menuSeen = 0;
let movesSeen = 0;
let overSeen = 0;

/** A tall-grass cell on the current map with grass on both sides of it. */
function findGrass(w: any): [number, number] | null {
  const map = w.map;
  if (!map) return null;
  const width = (map.width ?? 0) * 2;
  const height = (map.height ?? 0) * 2;
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
    // ONLY="view,battles" at bundle time (e.g. "2d,3d"); else VIEW 3D, BATTLES 3D
    const [view, battles] = typeof ONLY !== "undefined" ? ONLY.split(",") : ["3d", "3d"];
    game.options.view = view ?? "3d";
    game.options.battleView = battles ?? "3d";
    // then any key=value options after them (old option keys no row shows)
    for (const kv of typeof ONLY !== "undefined" ? ONLY.split(",").slice(2) : []) {
      const [k, v] = kv.split("=");
      if (k) game.options[k] = v;
    }
  }
  n++;
  const w = game.world;
  const top = game.stack.top();
  const topId: string = top?.screenId ?? "world";
  if (topId !== lastTop) {
    console.log(`[pv] bench top ${topId} at tick ${n}`);
    if (topId === "Gen2BattleTransition" && fired < 0) fired = n;
    lastTop = topId;
  }
  if (top?.screenId === "Gen2BattleState" && top.phase === "menu" && fired >= 0) {
    console.log(`[pv] bench encounter to battle menu: ${n - fired} ticks`);
    // a shot of every battle's menu (ONLY), numbered as the log counts them
    if (typeof ONLY !== "undefined") {
      console.log(`[pv] bench battle ${shots++} shot`);
      native.screenshot?.();
    }
    fired = -2;
  }
  let pad = 0;
  if (w?.map && n > 120) {
    if (!placed) {
      placed = true;
      if (w.map.id !== "ROUTE_29") w.warpToMapId("ROUTE_29", 30, 10, "down");
    } else if (!grass && !top) {
      grass = findGrass(w);
      console.log(`[pv] bench grass at ${grass ? grass.join(",") : "none"}`);
      if (grass) w.warpToMapId(w.map.id, grass[0], grass[1], "left");
    } else if (!top) {
      // back and forth across the patch
      if (fired === -2) fired = -1;
      const p = w.player;
      if (grass && !p.moving) {
        if (p.cellX <= grass[0] - 1) walkLeft = false;
        if (p.cellX >= grass[0] + 1) walkLeft = true;
      }
      pad = walkLeft ? VOX_BTN.left : VOX_BTN.right;
    } else if (top.screenId === "Gen2BattleState") {
      // ONLY: on the menu a second, a shot; FIGHT, the move list a second,
      // a shot; back, then RUN as below
      if (typeof ONLY !== "undefined" && top.phase === "menu" && menuSeen >= 0) {
        menuSeen++;
        if (menuSeen === 60 || menuSeen === 150) {
          console.log(`[pv] bench battle ${shots++} shot (${top.phase})`);
          native.screenshot?.();
        }
        if (menuSeen === 90) pad = VOX_BTN.a; // FIGHT (the cursor starts there)
        // then <PK><MN> and PACK, each opened on the bottom screen a second
        if (menuSeen === 170) { top.menuIndex = 2; pad = VOX_BTN.a; }
        if (menuSeen === 200) { top.menuIndex = 3; pad = VOX_BTN.a; }
        if (menuSeen === 230) top.menuIndex = 1;
        if (menuSeen < 240) { mainFrame((b & ~0xff) | pad); return; }
      }
      if (typeof ONLY !== "undefined" && top.phase === "moves") {
        movesSeen++;
        if (movesSeen === 50) {
          console.log(`[pv] bench battle ${shots++} shot (${top.phase})`);
          native.screenshot?.();
        }
        if (movesSeen === 80) { pad = VOX_BTN.b; menuSeen = 100; }
        mainFrame((b & ~0xff) | pad);
        return;
      }
      // RUN: down then right to it, A; text: A
      if (n % 12 === 0) {
        if (top.phase === "menu") {
          const run = 4;
          pad = (top.menuIndex ?? 1) < run ? (n % 24 === 0 ? VOX_BTN.right : VOX_BTN.down) : VOX_BTN.a;
        } else pad = VOX_BTN.a;
      }
    } else if (typeof ONLY !== "undefined" && (top.screenId === "Gen2PartyMenu" || top.screenId === "Gen2PackMenu")) {
      // a second on it, a shot (both screens), then B back to the battle
      overSeen++;
      if (overSeen === 60) {
        console.log(`[pv] bench battle ${shots++} shot (${top.screenId})`);
        native.screenshot?.();
      }
      if (overSeen === 90) { pad = VOX_BTN.b; overSeen = 0; }
    } else if (n % 12 === 0) pad = VOX_BTN.a;
  }
  mainFrame((b & ~0xff) | pad);
};
