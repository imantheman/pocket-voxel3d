// The Kanto half of a two-emulator link check (cc_linkdrive.ps1 with
// PV_GOLD_LINK=1: this on citra2's card, tools/gold_link_entry.ts on
// citra3's): the card's save continued from the title -- the player stands
// at the CABLE CLUB desk -- and A pressed now and then through the desk, the
// TRADE CENTER pick and the trade screen, so this side picks its first mon and
// the other side's first and proposes; until the party has changed hands.
// Never shipped.
import "../voxelmon/game/psp-main.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const A = 1 << 4;
const START = 1 << 6;
let continued = false;
let i = 0;
let first = "";
let traded = false;
let lastKinds = "";

g.frame = (b: number): void => {
  const top = game.stack?.[game.stack.length - 1];
  let pad = 0;
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  } else if (game.save?.party?.length) {
    if (!first) {
      first = String(game.save.party[0].species);
      console.log(`[pv] bench link: kanto at ${game.overworld?.map?.id}, party ${game.save.party.map((m: any) => m.species).join(",")}`);
    }
    const kinds = (game.stack ?? []).map((s: any) => s.kind).join(">");
    if (kinds !== lastKinds) {
      console.log(`[pv] bench link: kanto ${game.overworld?.map?.id} stack ${kinds} tick ${i}`);
      lastKinds = kinds;
    }
    if (!traded && game.save.party[0].species !== first) {
      traded = true;
      const m = game.save.party[0];
      console.log(`[pv] bench link: kanto traded ${first} for ${m.species} L${m.level} (ot ${m.otName}, special ${m.stats?.special}, exp ${m.exp}, catchRate ${m.catchRate})`);
    }
    if (!traded && i % 30 === 0) pad = A;
  }
  i++;
  mainFrame((b & ~0xff) | pad);
};
