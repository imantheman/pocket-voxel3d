// A Citra tour of the Gold/Silver/Crystal bottom screen for screenshots
// (bundled in place of game-gold.js; the Kanto games' is
// tools/bottom_shots_kanto_entry.ts): the card's save continued with a full
// party (a ten-letter nickname, an egg, a poisoned mon), six-figure money,
// most badges and a long play time; then each page tapped through the touch
// bits -- PARTY, three mons' pages, BADGE, CARD, MAP -- and a wild battle's
// panel (its text, the menu, the moves). Each is shot to the card
// (shot_N_b.ppm) with a "[pv] bpshot N name" line in pvlog.txt. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
/** A held touch at bottom-screen pixel (x, y), as the host packs it. */
const touch = (x: number, y: number): number => 0x100 | ((x >> 1) << 9) | ((y >> 1) << 17);
/** The centre of panel cell (cx, cy) (16 px cells on the 320x240 screen). */
const cell = (cx: number, cy: number): number => touch(cx * 16 + 8, cy * 16 + 8);

let started = false;
let world = 0;
let shots = 0;
let i = 0;
let step = 0;
let stepAt = 0;
let state: any = null;

const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};

function dressSave(): void {
  const s = game.save;
  const party: any[] = (s.party ?? []).slice(0, 6);
  const fill = ["FERALIGATR", "AMPHAROS", "PIDGEOTTO", "GENGAR", "TOGEPI", "HOOTHOOT"];
  for (const sp of fill) {
    if (party.length >= 6) break;
    if (party.some((m) => m.species === sp)) continue;
    party.push(Mon.new(game.data, sp, 20 + party.length * 6, {}));
  }
  s.party = party;
  if (party[1]) party[1].nickname = "FLAMEWHEEL";
  if (party[2]) party[2].status = "psn";
  if (party[3]) party[3].hp = Math.max(1, Math.floor((party[3].maxHp ?? party[3].stats?.hp ?? party[3].hp) / 5));
  if (party[5]) party[5].isEgg = true;
  s.player ??= {};
  s.player.money = 148250;
  s.player.johtoBadges = { ZEPHYR: true, HIVE: true, PLAIN: true, FOG: true, STORM: true, MINERAL: true };
  s.player.kantoBadges = { BOULDER: true, THUNDER: true };
  s.pokedex ??= {};
  s.pokedex.caught ??= {};
  s.pokedex.seen ??= {};
  for (let n = 1; n <= 112; n++) {
    s.pokedex.seen[n] = true;
    if (n <= 63) s.pokedex.caught[n] = true;
  }
  s.playTime = { ...(s.playTime ?? {}), hours: 103, minutes: 7 };
}

type Step = { name: string; tap?: [number, number]; set?: () => void; pad?: () => number; frames?: number; shoot?: boolean };
const bs = (): any => state;
const STEPS: Step[] = [
  { name: "party" },
  { name: "mon1", tap: [3, 2] },
  { name: "mon2", tap: [3, 6] },
  { name: "mon3", tap: [3, 6] },
  { name: "mon4", tap: [3, 6] },
  { name: "badges", tap: [7, 14] },
  { name: "card", tap: [12, 14] },
  { name: "map", tap: [18, 14], frames: 90 },
  { name: "party_again", tap: [1, 14] },
  // a wild battle's panel
  { name: "battle_text", set: () => {
    seed(0x2929);
    const wild: any = Mon.new(game.data, "SENTRET", 12, {});
    const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
    Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { game.stack.pop(); } });
    state = game.stack.top();
  }, frames: 70 },
  { name: "battle_menu", pad: () => (bs()?.phase === "menu" ? 0 : i % 16 === 0 ? VOX_BTN.a : 0), frames: 500 },
  { name: "battle_moves", pad: () => (bs()?.phase === "menu" && (bs()?.messageTimer ?? 0) <= 0 && i % 16 === 0 ? VOX_BTN.a : 0), frames: 60 },
];

g.frame = (_b: number): void => {
  i++;
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
    game.options.battleView = "3d";
  }
  let b = 0;
  if (game.world?.map) world++;
  if (world === 60) {
    dressSave();
    stepAt = i + 90;
  }
  if (world > 60) {
    const s = STEPS[step];
    if (s) {
      if (s.pad) b |= s.pad();
      // a tap: four frames down at the step's start, then up
      const into = i - (stepAt - (s.frames ?? 60));
      if (s.tap && into >= 0 && into < 4) b |= cell(s.tap[0], s.tap[1]);
      if (i >= stepAt) {
        if (s.shoot !== false) shot(s.name);
        step++;
        const n = STEPS[step];
        if (n) {
          n.set?.();
          stepAt = i + (n.frames ?? 60);
        } else {
          console.log("[pv] bpshot done");
        }
      }
    }
  }
  mainFrame(b);
};
