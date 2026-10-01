// Gold battle tour: every trainer in the data, fought headless on the real
// battle screen by a level-100 TYPHLOSION using its first move, A through
// every message (B at a yes/no). Flags battles that throw, log an error, or
// do not end within the frame budget.
//   bun tools/gold_tour_battles.ts [max-trainers]
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Input } from "../voxelmon/game/gen2/shared/core/Input.ts";
import { Logger } from "../voxelmon/game/gen2/shared/core/Logger.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";

useGoldGen();
const errors: string[] = [];
Logger.sink = (line: string) => {
  if (/error/i.test(line)) errors.push(line);
};
const max = Number(process.argv[2] ?? 1e9);
seed(0x29);
const game: any = Game2.new();
try {
  game.load({ startWorld: false });
} catch {
  // the splash
}
game.stack.clear();
const lcd = new Lcd(new RecorderHost());
lcd.shown = true;
setLcd(lcd);
Input.reset();
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

// WILD=1: every species instead, as a level-30 wild mon (each one's front
// pic drawn, its moves used against you)
const wildMode = !!process.env.WILD;
const classes: Record<string, any> = wildMode
  ? { WILD: { trainers: Object.keys(game.data.pokemon).filter((sp) => sp !== "EGG").map((sp) => ({ name: sp, wild: sp })) } }
  : (game.data.trainers.classes as Record<string, any>);
const bad: string[] = [];
let fought = 0;
let ok = 0;
const phases = new Map<string, number>();
const t0 = performance.now();
outer: for (const [classId, cls] of Object.entries(classes)) {
  for (let ti = 0; ti < (cls.trainers?.length ?? 0); ti++) {
    if (fought >= max) break outer;
    const row = cls.trainers[ti];
    const label = `${classId} #${ti + 1} ${row.name ?? ""}`;
    fought++;
    errors.length = 0;
    try {
      seed(0x1000 + fought);
      const party = row.wild ? [] : row.party.map((r: any) =>
        Mon.new(game.data, r.species, r.level, {
          moves: r.moves && r.moves.length > 0
            ? r.moves.map((id: string) => ({ id, pp: game.data.moves[id].pp, maxPp: game.data.moves[id].pp }))
            : undefined,
          item: r.item,
          dvs: { attack: 9, defense: 8, speed: 8, special: 8 },
        }),
      );
      game.save.party = [Mon.new(game.data, "TYPHLOSION", 100, { dvs: perfect() })];
      const battle: any = row.wild
        ? Battle.new({ data: game.data, party: game.save.party, wild: Mon.new(game.data, row.wild, 30, { dvs: perfect() }), save: game.save })
        : Battle.new({
          data: game.data,
          party: game.save.party,
          trainer: { class: classId, classId, name: row.name, party, baseMoney: cls.baseMoney },
          save: game.save,
        });
      let done = false;
      game.stack.clear();
      Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { done = true; game.stack.pop(); } });
      const state = game.stack.top();
      let i = 0;
      for (; i < 20000 && !done; i++) {
        const phase: string = state.phase;
        const tick = i % 4 === 0;
        let b = 0;
        if (phase === "menu") {
          if (tick && state.menuIndex === 1 && (state.messageTimer ?? 0) <= 0) b = VOX_BTN.a;
          else if (tick && state.menuIndex !== 1) b = VOX_BTN.up;
        } else if (phase === "moves") {
          // the first move with PP left (an empty one is refused)
          const moves: any[] = state.playerMoves();
          const disabled = (battle.player ?? {}).volatile?.disabled;
          const target = Math.max(1, moves.findIndex((m: any) => (m.pp ?? 1) > 0 && m.id !== disabled) + 1);
          if (tick) b = state.moveIndex < target ? VOX_BTN.down : state.moveIndex > target ? VOX_BTN.up : VOX_BTN.a;
        } else if (i % 8 === 0) {
          b = state.yesNo || state.choice || /prompt|yesno|switch/i.test(phase) ? VOX_BTN.b : VOX_BTN.a;
        }
        Input.setButtons(b);
        Input.step();
        game.stack.update(1 / 60);
        lcd.begin();
        resetDrawState();
        game.stack.draw();
        lcd.end();
      }
      if (!done) {
        const ph = String(state.phase);
        phases.set(ph, (phases.get(ph) ?? 0) + 1);
        bad.push(`${label}: did not end in ${i} frames (phase ${ph}, top ${game.stack.top()?.screenId})`);
      } else if (errors.length) {
        bad.push(`${label}: ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
      } else {
        ok++;
      }
    } catch (e) {
      bad.push(`${label}: THREW ${String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join(" / ").slice(0, 400)}`);
    }
  }
}
console.log(`${fought} trainers in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${ok} clean, ${bad.length} flagged`);
if (phases.size) console.log("stuck phases:", [...phases.entries()].map(([k, v]) => `${k}=${v}`).join(" "));
for (const b of bad.slice(0, 60)) console.log("  " + b);
