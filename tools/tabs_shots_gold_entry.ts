// A Citra tour of the Gold/Silver/Crystal bottom screen's tab row with the
// ENHANCEMENTS tab (bundled in place of game-gold.js): the card's save
// continued; for each tab style (ui/Companion.ts TabStyle) the PARTY page
// with CHEATS off and on, and the ENHANCEMENTS page; then, in the style
// that ships, the ENHANCEMENTS page worked by touch (VISIBLE WILD stepped,
// EXP FOR CATCHING on) and OPTION's ENHANCEMENTS page showing the same
// values, then the CARD and CHEATS pages under the new row. Each is shot to
// the card (shot_N.ppm top, shot_N_b.ppm bottom) with a "[pv] bpshot N name"
// line. Nothing is saved. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { TAB_STYLE } from "../voxelmon/game/gen2/ui/Companion.ts";

const g = globalThis as unknown as { goldGame: any; goldCompanion: any; frame: (b: number) => void };
const game = g.goldGame;
const companion = g.goldCompanion;
const mainFrame = g.frame;
const touch = (x: number, y: number): number => 0x100 | ((x >> 1) << 9) | ((y >> 1) << 17);
const cell = (cx: number, cy: number): number => touch(cx * 16 + 8, cy * 16 + 8);

let i = 0;
let started = false;
let built = false;
let shots = 0;
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};

type Step = { at: number; run: () => void };
const steps: Step[] = [];
let clock = 0;
const then = (wait: number, run: () => void): void => {
  clock += wait;
  steps.push({ at: clock, run });
};
let held = 0;
let heldUntil = 0;
const tapCell = (cx: number, cy: number): void => {
  held = cell(cx, cy);
  heldUntil = i + 4;
};
/** A tap on the tab for `page`, wherever this style stands it. */
const tapTab = (page: string): void => {
  const t = companion.tabs(game).find((x: any) => x.page === page);
  if (t) tapCell(t.x, t.row);
};

function tour(): void {
  for (const style of ["card", "id", "extras"]) {
    then(1, () => { companion.tabStyle = style; game.options.cheats = false; });
    then(2, () => tapTab("party"));
    then(60, () => shot(`${style}_party_cheats_off`));
    then(2, () => { game.options.cheats = true; });
    then(60, () => shot(`${style}_party_cheats_on`));
    then(2, () => tapTab("enh"));
    then(60, () => shot(`${style}_enhancements`));
  }
  // the style that ships, worked
  then(1, () => { companion.tabStyle = TAB_STYLE; game.options.cheats = false; });
  then(2, () => tapTab("enh"));
  then(60, () => shot("enh_page"));
  then(2, () => tapCell(4, 12)); // VISIBLE WILD -> SOME
  then(20, () => tapCell(4, 12)); // -> MANY
  then(20, () => tapCell(4, 4)); // EXP FOR CATCHING on
  then(60, () => shot("enh_page_stepped"));
  then(2, () => {
    while (game.stack.top()) game.stack.pop();
    game.showOptions();
    game.stack.top().focusRow?.("visibleWild");
  });
  then(80, () => shot("option_enhancements_mirror"));
  then(2, () => { while (game.stack.top()) game.stack.pop(); game.options.cheats = true; });
  then(2, () => tapTab("card"));
  then(60, () => shot("card_page"));
  then(2, () => tapCell(8, 6)); // the card turned over: the badges
  then(60, () => shot("card_badges"));
  then(2, () => tapTab("cheats"));
  then(60, () => shot("cheats_page"));
  then(2, () => tapTab("map"));
  then(60, () => shot("map_page"));
  then(30, () => console.log("[pv] bpshot done"));
}

g.frame = (b: number): void => {
  i++;
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.persistOptions = () => undefined;
    for (const k of ["visibleWild", "expForCatching", "partyExpShare", "tradeEvoLv40", "hmsWithoutMove", "cheats", "gameSpeed"]) delete game.options[k];
    game.options.view = "3d";
  }
  if (!built && game.world?.map && game.phase === "play") {
    built = true;
    const s = game.save;
    if (!(s.party ?? []).length) s.party = [Mon.new(game.data, "CYNDAQUIL", 20, {})];
    s.player.money = 148250;
    clock = i + 120;
    tour();
  }
  while (steps.length && i >= steps[0]!.at) steps.shift()!.run();
  const t = i < heldUntil ? held : 0;
  // the camera's bits kept; the pad and the touch are the tour's
  mainFrame((b & 0xff000000) | t);
};
