// Debug: a lead with no PP left (Struggle) against a Ghost, driven through
// the battle screen -- does the battle end? (bun tools/dbg_gold_struggle.ts)
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";

useGoldGen();
seed(1);
const game: any = Game2.new();
game.load({ startWorld: true });
const lcd = new Lcd(new RecorderHost());
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
const foe = process.argv[2] ?? "HAUNTER";
const lead = Mon.new(game.data, "TYPHLOSION", 100, { dvs: perfect() });
for (const m of lead.moves) m.pp = 0;
if (process.env.LOWHP) lead.hp = 1;
game.save.party = process.env.TWO ? [lead, Mon.new(game.data, "FERALIGATR", 60, { dvs: perfect() })] : [lead];
const wild: any = Mon.new(game.data, foe, Number(process.env.LEVEL ?? 20), { dvs: perfect() });
const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
let done = false;
Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { done = true; game.stack.pop(); } });
const st = game.stack.top();
let last = "";
for (let f = 0; f < 6000 && !done; f++) {
  let b = 0;
  const top = game.stack.top();
  if (top && top !== st && top.screenId === "Gen2PartyMenu") {
    // the forced switch: log what it is and try a pad pattern
    if (f % 30 === 0) console.log(f, "party", "index", top.index, "prompt", JSON.stringify(top.prompt ?? "").slice(0, 40), "keys", Object.keys(top).filter((k) => /index|cursor|sel|row/i.test(k)).join(","));
    const pattern = (process.env.PAT ?? "d.a.").split("");
    const c = pattern[Math.floor(f / 6) % pattern.length];
    b = f % 6 === 0 ? (c === "d" ? VOX_BTN.down : c === "a" ? VOX_BTN.a : c === "b" ? VOX_BTN.b : 0) : 0;
  } else if (st.phase === "menu" && f % 4 === 0) b = st.menuIndex === 1 ? VOX_BTN.a : VOX_BTN.up;
  else if (f % 8 === 0) b = VOX_BTN.a;
  game.frame(b);
  game.draw(lcd);
  lcd.end();
  const now = `${st.phase} ${JSON.stringify(st.message ?? "").slice(0, 50)} foe=${battle.enemy?.mon?.hp ?? battle.enemy?.hp}`;
  if (now !== last) {
    console.log(f, now);
    last = now;
  }
}
console.log(done ? "battle ended" : "STUCK", "after", foe);
