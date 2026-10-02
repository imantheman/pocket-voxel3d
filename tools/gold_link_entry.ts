// A Citra check of Gold's CABLE CLUB against another console (cc_linkdrive.ps1
// with PV_GOLD_LINK=1): the card's save continued, the player put in front of
// a Pokémon Center 2F receptionist -- the TIME CAPSULE's (third) unless
// ONLY="trade" (the TRADE CENTER's, first) -- and A pressed now and then
// through the ROM's own conversation, the save, the walk in, the machine and
// the trade screen, until the party has changed hands once; then B, out of
// the screen and the room. The stack, the party and the phase are logged.
// Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { TimeCapsule } from "../voxelmon/game/gen2/core/TimeCapsule.ts";

declare const ONLY: string;
const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const trade = typeof ONLY !== "undefined" && ONLY === "trade";

let started = false;
let n = 0;
let placed = false;
let firstSpecies = "";
let traded = false;
let lastTop = "";
let lastMap = "";

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
  }
  n++;
  const w = game.world;
  let pad = 0;
  if (w?.map && n >= 120) {
    if (!placed) {
      placed = true;
      // the receptionists stand at (5,2) / (9,2) / (13,3); the player below
      if (trade) w.warpToMapId("POKECENTER_2F", 5, 3, "up");
      else w.warpToMapId("POKECENTER_2F", 13, 4, "up");
      // the TIME CAPSULE takes only Gen 1 mons: keep those (or one GEODUDE)
      if (!trade) {
        // and opens once BILL has been met (EVENT_MET_BILL cleared; it starts
        // set, hiding him) -- the card's save is from before that
        w.events.set(1810, false);
        w.setEngineFlag(82, false);
        const party = game.save.party.filter((m: any) => TimeCapsule.isGen1Species(game.data, m.species));
        if (party.length === 0) party.push(Mon.stampOT(game.save, Mon.new(game.data, "GEODUDE", 15, {})));
        game.save.party = party;
      }
      // the CABLE CLUB opens once the MYSTERY EGG is with ELM
      // (EVENT_GAVE_MYSTERY_EGG_TO_ELM); the card's save is from before that
      w.events.set(31, true);
      firstSpecies = String(game.save.party?.[0]?.species ?? "");
      console.log(`[pv] bench link: to the ${trade ? "TRADE CENTER" : "TIME CAPSULE"} desk, party ${game.save.party.map((m: any) => m.species).join(",")}`);
    }
    const top = game.stack.top();
    const topId = String(top?.screenId ?? "-");
    if (topId !== lastTop || w.map.id !== lastMap) {
      console.log(`[pv] bench link: ${w.map.id} top ${topId} phase ${top?.phase ?? "-"} tick ${n}`);
      lastTop = topId;
      lastMap = w.map.id;
    }
    if (!traded && game.save.party?.[0]?.species && game.save.party[0].species !== firstSpecies) {
      traded = true;
      console.log(`[pv] bench link: traded ${firstSpecies} for ${game.save.party[0].species} (ot ${game.save.party[0].otName}, item ${game.save.party[0].item ?? "-"})`);
    }
    if (n % 30 === 0) {
      // (on the trade screen this side only answers: two consoles both
      // proposing wait out the answer timer on each other)
      // -- against another Gold, seat 0 proposes and seat 1 answers)
      const proposer = trade && game.cableClub().seat() === 0;
      if (!traded) pad = topId === "Gen2LinkTradeMenu" && top.phase === "pick" && !proposer ? 0 : VOX_BTN.a;
      // after the trade: out of the screen (B), then A through the texts out
      else pad = topId === "Gen2LinkTradeMenu" && top.phase === "pick" ? VOX_BTN.b : VOX_BTN.a;
    }
    // in the room: to this side's stool (the machine answers only from the
    // stools: its bg events face right and left), facing the machine
    if (!traded && w.map.id !== "POKECENTER_2F" && !top && !w.busy?.() && n % 30 === 15) {
      const p = w.player;
      const right = game.cableClub().seat() === 1;
      const tx = right ? 6 : 3;
      const face = right ? "left" : "right";
      if (p && p.cellY > 5) pad = VOX_BTN.up;
      else if (p && p.cellY === 5 && p.cellX < tx) pad = VOX_BTN.right;
      else if (p && p.cellY === 5 && p.cellX > tx) pad = VOX_BTN.left;
      else if (p && p.cellY === 5) pad = VOX_BTN.up;
      else if (p && p.facing !== face) pad = right ? VOX_BTN.left : VOX_BTN.right;
    }
  }
  mainFrame((b & ~0xff) | pad);
};
