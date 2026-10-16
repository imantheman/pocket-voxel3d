// A Citra shot of the gear's HOME on Red/Blue/Yellow, built against any
// commit (it touches nothing VISIBLE WILD added): the card's save continued,
// every app on offer (the TOWN MAP, the dex, OPTION's CHEATS row ON), HOME
// shot; then CHEATS off and HOME shot again. Each is shot to the card
// (shot_N.ppm top, shot_N_b.ppm bottom) with a "[pv] bpshot N name" line.
// The before/after pair for the ENHANCEMENTS app's place on HOME. Never
// shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;
const R = 1 << 26;

let i = 0;
let continued = false;
let at = -1;
let shots = 0;
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};

g.frame = (b: number): void => {
  i++;
  let pad = 0;
  const top = game.stack?.[game.stack.length - 1];
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  } else if (at < 0 && top?.kind === "overworld") {
    at = i + 60;
  }
  if (at >= 0) {
    const t = i - at;
    if (t === 0) {
      const s = game.save;
      s.options = { ...(s.options ?? {}), view: "3d", cheats: true };
      (s.inventory ??= {}).TOWN_MAP = 1;
      (s.flags ??= {}).EVENT_GOT_POKEDEX = true;
      // away and back: the gear redraws a still HOME only when its key moves
      game.setGearView("party");
    }
    if (t === 3) game.setGearView("home");
    if (t === 60) shot("home_all_apps");
    if (t === 70) { game.save.options.cheats = false; game.setGearView("party"); }
    if (t === 73) game.setGearView("home");
    if (t === 130) shot("home_no_cheats");
    if (t === 190) console.log("[pv] bpshot done");
  }
  mainFrame((b & ~0xff & ~R) | pad);
};
