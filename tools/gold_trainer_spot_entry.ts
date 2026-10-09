// A Citra check of a trainer spotting the player in Gold (cc_gold_bench.sh
// tools/gold_trainer_spot_entry.ts; VIEW2D=1 for the 2D view): the card's
// save continued, the player set down two cells in front of the first
// unbeaten-made trainer on a route, and the "!" bubble (showemote) and the
// walk that follows logged frame by frame, with top-screen shots while the
// bubble is up and after it goes. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

declare const VIEW2D: boolean;
const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const MAPS = ["ROUTE_30", "ROUTE_31", "ROUTE_32", "ROUTE_33", "ROUTE_34", "ROUTE_35", "ROUTE_36"];
const DELTA: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const BACK: Record<string, string> = { up: "down", down: "up", left: "right", right: "left" };
let started = false;
let worldFrames = 0;
let mapI = 0;
let phase = "warp";
let wait = 0;
let emoteAt = -1;
let goneAt = -1;
let movedAt = -1;
let trainer: any = null;
let shots = 0;
const log = (s: string): void => console.log("[pv] kfix: " + s);

g.frame = (_b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = typeof VIEW2D !== "undefined" && VIEW2D ? "2d" : "3d";
  }
  const w = game.world;
  if (w?.map) worldFrames++;
  if (worldFrames > 30) {
    if (phase === "warp" && mapI < MAPS.length) {
      w.warpToMapId(MAPS[mapI++], 5, 5, "down");
      phase = "find";
      wait = 0;
    } else if (phase === "find" && ++wait > 40) {
      trainer = null;
      for (const npc of w.npcs ?? []) {
        const rec = npc.def?.trainer;
        const sight = npc.def?.sight ?? 0;
        if (!rec || sight < 2 || !DELTA[npc.facing]) continue;
        trainer = npc;
        break;
      }
      if (!trainer) {
        phase = "warp";
      } else {
        const rec = trainer.def.trainer;
        if (rec.event != null) w.events.set(rec.event, false);
        w.refusedTrainers = {};
        const [dx, dy] = DELTA[trainer.facing]!;
        const tx = trainer.cellX + dx * 2;
        const ty = trainer.cellY + dy * 2;
        log(`map ${w.map.id}: trainer at ${trainer.cellX},${trainer.cellY} facing ${trainer.facing} sight ${trainer.def.sight}; player to ${tx},${ty} view ${game.options.view}`);
        w.setMap(w.map.id, tx, ty, BACK[trainer.facing]);
        phase = "watch";
        wait = 0;
      }
    } else if (phase === "watch") {
      wait++;
      // setMap reloads the map: the trainer is a new object at the same cell
      if (wait === 1) {
        const [cx, cy] = [trainer.cellX, trainer.cellY];
        trainer = (w.npcs ?? []).find((n: any) => n.cellX === cx && n.cellY === cy) ?? trainer;
      }
      const up = !!w.emote;
      if (up && emoteAt < 0) {
        emoteAt = wait;
        log(`emote up at ${wait} (frames ${w.emote.left}, over the trainer: ${w.emote.entity === trainer})`);
      }
      if (!up && emoteAt >= 0 && goneAt < 0) {
        goneAt = wait;
        log(`emote gone at ${wait}: up ${goneAt - emoteAt} frames`);
      }
      if (emoteAt >= 0 && movedAt < 0 && trainer && trainer.moving) {
        movedAt = wait;
        log(`trainer walks at ${wait}: ${movedAt - emoteAt} frames after the bubble`);
      }
      if (emoteAt >= 0 && shots < 3) {
        const age = wait - emoteAt;
        if (age === 10 || age === 50 || (goneAt >= 0 && age === goneAt - emoteAt + 6)) {
          shots++;
          log(`shot ${shots} at bubble age ${age}`);
          native.screenshot?.();
        }
      }
      if (wait === 600 && emoteAt < 0) log("no emote in 600 frames");
    }
  }
  mainFrame(0);
};
