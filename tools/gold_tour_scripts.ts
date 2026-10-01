// Gold script tour: every map, every object and sign script started the way
// an A press starts it, then driven -- A through text and YES at prompts, the
// battle screen fought by a level-100 TYPHLOSION -- until the world is idle.
// Flags scripts that throw, log an error, or never let go.
//   bun tools/gold_tour_scripts.ts [first-map-prefix]
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Logger } from "../voxelmon/game/gen2/shared/core/Logger.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";

useGoldGen();
const errors: string[] = [];
Logger.sink = (line: string) => {
  if (/error|not ported|notported/i.test(line)) errors.push(line);
};
const only = process.argv[2];
const game: any = Game2.new();
game.load();
const lcd = new Lcd(new RecorderHost());
let i = 0;
const step = (b = 0) => {
  game.frame(b);
  game.draw(lcd);
  lcd.end();
  i++;
};
for (let f = 0; f < 7000 && !game.world?.map; f++) step(f % 40 === 0 ? 16 : 0);
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
const world = game.world;

/** The pad for one frame: the battle screen's own driver, else A every 8 frames. */
function pad(): number {
  const top = game.stack.top();
  if (top && top.screenId === "Gen2BattleState") {
    const phase: string = top.phase;
    const tick = i % 4 === 0;
    if (phase === "menu") {
      if (tick && top.menuIndex === 1 && (top.messageTimer ?? 0) <= 0) return VOX_BTN.a;
      if (tick && top.menuIndex !== 1) return VOX_BTN.up;
      return 0;
    }
    if (phase === "moves") {
      const moves: any[] = top.playerMoves();
      const disabled = (top.battle?.player ?? {}).volatile?.disabled;
      const target = Math.max(1, moves.findIndex((m: any) => (m.pp ?? 1) > 0 && m.id !== disabled) + 1);
      if (!tick) return 0;
      return top.moveIndex < target ? VOX_BTN.down : top.moveIndex > target ? VOX_BTN.up : VOX_BTN.a;
    }
  }
  // the credits wait for A after THE END, as on the cart
  if (top && top.screenId === "Gen2Credits") return i % 30 === 0 ? VOX_BTN.a : 0;
  // the Unown puzzle quits on START ("START: CANCEL"), as on the cart
  if (top && top.screenId === "Gen2UnownPuzzle") return i % 20 === 0 ? VOX_BTN.start : 0;
  // the naming screen: START jumps to END, A takes it
  if (top && top.screenId === "Gen2NamingScreen") return i % 20 === 0 ? VOX_BTN.start : i % 20 === 10 ? VOX_BTN.a : 0;
  // anything else open over the world (a shop, the PC...): only B,
  // which backs out of it
  if (top && top.screenId !== "Gen2BattleState") return i % 10 === 0 ? VOX_BTN.b : 0;
  return i % 8 === 0 ? VOX_BTN.a : 0;
}

const bad: string[] = [];
let ran = 0;
let clean = 0;
const t0 = performance.now();
const prefixes = only ? only.split(",") : [];
const ids = Object.keys(world.maps).sort().filter((id) => prefixes.length === 0 || prefixes.some((p) => id.startsWith(p)));
for (const id of ids) {
  const def = world.maps[id];
  const scripts: { kind: string; key: string; npcIndex?: number }[] = [];
  for (const o of def.objects ?? []) if (o && o.scriptKey && !o.trainer) scripts.push({ kind: "npc", key: o.scriptKey, npcIndex: o.index });
  for (const b of def.bgEvents ?? def.bg_events ?? []) if (b && b.scriptKey) scripts.push({ kind: "sign", key: b.scriptKey });
  for (const s of scripts) {
    ran++;
    errors.length = 0;
    const label = `${id} ${s.kind} ${s.key}`;
    try {
      game.save.party = [Mon.new(game.data, "TYPHLOSION", 100, { dvs: perfect() })];
      game.stack.clear();
      // a script the last one left hanging must not poison this one (the VM
      // has no stop; a warp does not clear it)
      world.vm.busy = false;
      world.vm.ctx = undefined;
      world.textbox = null;
      world.choicebox = null;
      world.moveState = null;
      const w = def.warps?.[0];
      world.warpToMapId(id, w ? w.x : def.width ?? 4, w ? w.y : def.height ?? 4, "down");
      for (let f = 0; f < 30 && world.busy(); f++) step(0);
      if (s.npcIndex != null) {
        const npc = (world.npcs ?? []).find((n: any) => n.def && n.def.index === s.npcIndex);
        if (npc) {
          world.talkNpc = npc;
          world.vm.lastTalked = (s.npcIndex ?? 0) + 1;
        }
      }
      world.vm.start(s.key);
      let f = 0;
      const budget = Number(process.env.BUDGET ?? 30000);
      for (; f < budget && (world.busy() || game.stack.top()); f++) step(pad());
      if (f >= budget) {
        bad.push(`${label}: still running after ${budget} frames (top ${game.stack.top()?.screenId ?? "-"}, text ${world.textbox ? "up" : "no"})`);
      } else if (errors.length) {
        bad.push(`${label}: ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
      } else {
        clean++;
      }
    } catch (e) {
      bad.push(`${label}: THREW ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" / ").slice(0, 300)}`);
    }
  }
}
console.log(`${ran} scripts over ${ids.length} maps in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${clean} clean, ${bad.length} flagged`);
for (const b of bad.slice(0, 80)) console.log("  " + b);
