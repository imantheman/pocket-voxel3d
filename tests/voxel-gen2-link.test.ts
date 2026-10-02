// Gold's CABLE CLUB (gen2/core/CableClub.ts, gen2/ui/LinkTradeMenu.ts) and its
// TIME CAPSULE (gen2/core/TimeCapsule.ts, voxelmon/game/battle/timecapsule.ts):
// two Gold games trading over a loopback link, and the conversions to and from
// the Kanto games' terms.
import { describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { LinkTradeMenu } from "../voxelmon/game/gen2/ui/LinkTradeMenu.ts";
import { TimeCapsule } from "../voxelmon/game/gen2/core/TimeCapsule.ts";
import { startLinkBattle } from "../voxelmon/game/gen2/core/LinkBattle2.ts";
import { LINK_SEATS, LinkSession, LoopbackLink } from "../voxelmon/game/world/link.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";

const gold = haveGoldGen();

/** A per-game input: `press(btn)` is seen by the next update only. */
function fakeInput() {
  let now = new Set<string>();
  let next = new Set<string>();
  return {
    press: (b: string) => next.add(b),
    step: () => {
      now = next;
      next = new Set();
    },
    wasPressed: (b: string) => now.has(b),
    isDown: (b: string) => now.has(b),
  };
}

function goldGame(name: string, party: [string, number][]): any {
  const game: any = Game2.new();
  game.load({ startWorld: true });
  game.save.player.name = name;
  game.save.player.id = name === "AAA" ? 11111 : 22222;
  game.save.party = party.map(([s, l]) => Mon.stampOT(game.save, Mon.new(game.data, s, l, {})));
  game.writeSave = () => [true];
  game.input = fakeInput();
  // StateStack is one module-wide stack; two games in one process each get
  // their own (a console only ever runs one)
  const states: any[] = [];
  game.stack = {
    states,
    push: (s: any) => { states.push(s); return s; },
    pop: () => states.pop(),
    top: () => states[states.length - 1],
    clear: () => { states.length = 0; },
  };
  return game;
}

describe("gen2 CABLE CLUB", () => {
  test.skipIf(!gold)("two Gold games trade over the link, and stay on the trade screen", () => {
    useGoldGen();
    const a = goldGame("AAA", [["CYNDAQUIL", 10], ["PIDGEY", 5]]);
    const b = goldGame("BBB", [["TOTODILE", 10], ["SENTRET", 5]]);
    const link = new LoopbackLink();
    for (const [g, end, nonce] of [[a, link.a, 2], [b, link.b, 1]] as const) {
      const club = g.cableClub();
      club.request("trade");
      club.session = new LinkSession(end, g.save.player.name, nonce, { game: "gold", gen: 2, mode: "gen2" }, false);
      club.session.open();
    }
    const both = (n: number, each?: (k: number) => void): void => {
      for (let k = 0; k < n; k++) {
        each?.(k);
        for (const g of [a, b]) {
          g.input.step();
          g.serviceLink();
          g.stack.top()?.update?.();
        }
      }
    };
    both(10);
    expect(a.cableClub().session.state).toBe("linked");
    expect(a.cableClub().otherPlayerLinkMode()).toBe(1); // a Gen 2 game on the other end
    for (const g of [a, b]) {
      g.stack.push(LinkTradeMenu.new(g, { club: g.cableClub(), capsule: false, onDone: () => g.stack.pop() }));
    }
    both(20);
    const ma = a.stack.top();
    expect(ma.phase).toBe("pick");
    expect(ma.theirs.map((m: any) => m.species)).toEqual(["TOTODILE", "SENTRET"]);
    // A: mine 0, theirs 0, YES
    a.input.press("a");
    both(3);
    a.input.press("a");
    both(3);
    expect(ma.phase).toBe("confirm");
    a.input.press("a");
    both(10);
    const mb = b.stack.top();
    expect(mb.phase).toBe("confirm"); // B answers the offer
    b.input.press("a");
    // both through the commit, the animation and the texts, pressing A now and then
    both(4000, (k) => {
      if (k % 15 === 0) {
        if (a.stack.top() !== ma || ma.phase === "message") a.input.press("a");
        if (b.stack.top() !== mb || mb.phase === "message") b.input.press("a");
      }
    });
    expect(a.save.party[0].species).toBe("TOTODILE");
    expect(b.save.party[0].species).toBe("CYNDAQUIL");
    expect(a.save.party[0].traded).toBe(true);
    expect(a.save.party[0].otName).toBe("BBB");
    expect(b.save.party[0].otId).toBe(11111);
    expect(a.save.pokedex.caught.TOTODILE).toBe(true);
    // the next round: back on the screen, both parties as they are now
    expect(a.stack.top()).toBe(ma);
    expect(ma.phase).toBe("pick");
    expect(ma.theirs[0].species).toBe("CYNDAQUIL");
    // CANCEL leaves
    a.input.press("b");
    both(5);
    expect(a.stack.top()).not.toBe(ma);
  });
});

/** Two Gold games, linked for the COLOSSEUM, fight to the end pressing A;
 *  every turn both consoles' HP must agree. The turns, as A saw them. */
function colosseum(pa: [string, number][], pb: [string, number][], setup?: (a: any, b: any) => void): string[] {
    useGoldGen();
    const a = goldGame("AAA", pa);
    const b = goldGame("BBB", pb);
    setup?.(a, b);
    const partyBefore = JSON.stringify(a.save.party);
    const link = new LoopbackLink();
    for (const [g, end, nonce] of [[a, link.a, 2], [b, link.b, 1]] as const) {
      const club = g.cableClub();
      club.request("battle");
      club.session = new LinkSession(end, g.save.player.name, nonce, { game: "gold", gen: 2, mode: "gen2" }, false);
      club.session.open();
    }
    const step = (): void => {
      for (const g of [a, b]) {
        g.input.step();
        g.serviceLink();
        g.stack.top()?.update?.();
      }
    };
    for (let k = 0; k < 10; k++) step();
    const done = { a: false, b: false };
    startLinkBattle(a, a.cableClub(), () => { done.a = true; });
    startLinkBattle(b, b.cableClub(), () => { done.b = true; });
    const turns: string[] = [];
    let seen = 0;
    for (let k = 0; k < 60000 && !(done.a && done.b); k++) {
      if (k % 12 === 0) {
        for (const g of [a, b]) {
          const top = g.stack.top();
          // a party list (the pick after a faint): the cursor on a mon that
          // can fight
          if (top?.screenId === "Gen2PartyMenu" && !top.itemResult) {
            const i = top.party.findIndex((m: any) => (m.hp ?? 0) > 0);
            if (i >= 0) top.index = i + 1;
          }
          g.input.press("a");
        }
      }
      step();
      const da = a.cableClub().battle as any;
      const db = b.cableClub().battle as any;
      if (da && db && da.turn === db.turn && da.turn > seen) {
        seen = da.turn;
        const ba = da.battle;
        const bb = db.battle;
        turns.push(`${ba.player.species}:${ba.player.hp} ${ba.enemy.species}:${ba.enemy.hp}`);
        // each console's player is the other's enemy, HP for HP
        expect(ba.player.species).toBe(bb.enemy.species);
        expect(ba.player.hp).toBe(bb.enemy.hp);
        expect(ba.enemy.hp).toBe(bb.player.hp);
      }
    }
    if (!(done.a && done.b)) {
      for (const g of [a, b]) {
        const d = g.cableClub().battle as any;
        console.log(g.save.player.name, g.stack.states.map((x: any) => `${x.screenId}:${x.phase}`).join(">"),
          "turn", d?.turn, "mine", JSON.stringify(d?.mine), "pend", d?.battle?.pendingEnemySwitch, d?.battle?.pendingSwitch,
          "peek", JSON.stringify(g.cableClub().session?.peekAction?.()), "over", d?.battle?.over, "msg", g.stack.top()?.message);
      }
      console.log(turns.join(" | "));
    }
    expect(done.a && done.b).toBe(true);
    expect(seen).toBeGreaterThan(1);
    const oa = a.cableClub().battle;
    expect(oa).toBe(null);
    // the save's party is untouched (the battle fought on a copy)
    expect(JSON.stringify(a.save.party)).toBe(partyBefore);
    return turns;
}

describe("gen2 COLOSSEUM", () => {
  test.skipIf(!gold)("two Gold games battle over the link and agree on every turn", () => {
    for (let n = 0; n < 4; n++) {
      const turns = colosseum([["CYNDAQUIL", 14], ["PIDGEY", 7]], [["TOTODILE", 14], ["SENTRET", 7]]);
      expect(turns.length).toBeGreaterThan(1);
    }
  });
  test.skipIf(!gold)("a double faint: both consoles pick their next mon at once", () => {
    const turns = colosseum([["GEODUDE", 20], ["PIDGEY", 7]], [["TOTODILE", 10], ["SENTRET", 7]], (a) => {
      a.save.party[0].moves = [{ id: "SELFDESTRUCT", pp: 5, maxPp: 5 }];
    });
    expect(turns[0]).toBe("GEODUDE:0 TOTODILE:0");
    expect(turns[1]).toMatch(/^PIDGEY:\d+ SENTRET:\d+$/);
  });
});

const genDir = join(import.meta.dir, "..", "dist/voxelmon/gen");
const hasKanto = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
const kantoData: VoxelmonData | null = hasKanto ? await loadRuntimeData(genDir) : null;

class SaveHost extends RecorderHost {
  saved: string | undefined;
  pic(): void {}
  picHide(): void {}
  saveWrite(text: string): void { this.saved = text; }
  saveData(): string | undefined { return this.saved; }
}

describe("gen2 TIME CAPSULE to a Kanto game", () => {
  test.skipIf(!gold || !hasKanto)("a Red console and Gold's TIME CAPSULE trade, each in its own terms", () => {
    useGoldGen();
    // Red: in its TRADE CENTER, seated, as the Kanto link tests stand it
    const data = { ...(kantoData as object), cookedMaps: [...((kantoData as any).cookedMaps ?? []), "TRADE_CENTER", "COLOSSEUM"] };
    const red = new VoxelmonGame(data as never, new SaveHost(), 1);
    red.newGame();
    red.closeToOverworld();
    red.save.player.name = "RED";
    red.save.party.length = 0;
    red.save.party.push(newMon(kantoData!, "PIKACHU", 12, red.battleRng));
    const wire = new LoopbackLink();
    red.linkCarrier = wire.a;
    red.overworld.setMap("TRADE_CENTER", 4, 2, "down");
    expect(red.overworld.openLink()).toBe(true);
    // Gold: its TIME CAPSULE's session on the other end
    const gold2 = goldGame("GOLD", [["GEODUDE", 15]]);
    const club = gold2.cableClub();
    club.request("capsule");
    club.session = new LinkSession(wire.b, "GOLD", 1, { game: "gold", gen: 2, mode: "gen1" }, false);
    club.session.open();
    for (let i = 0; i < 8; i++) { red.overworld.link!.poll(); gold2.serviceLink(); }
    expect(red.overworld.link!.state).toBe("linked");
    expect(red.overworld.link!.peerIdent?.game).toBe("gold");
    expect(club.otherPlayerLinkMode()).toBe(0); // a Gen 1 game on the other end
    expect(club.sameMode()).toBe(true);
    const seat = LINK_SEATS[red.overworld.link!.seat()]!;
    red.overworld.setMap("TRADE_CENTER", seat.seat.x, seat.seat.y, seat.facing as never);
    for (let i = 0; i < 8; i++) red.tick(0);
    // Gold at its machine: its begin pulls Red to the table
    const menu = LinkTradeMenu.new(gold2, { club, capsule: true, onDone: () => gold2.stack.pop() });
    gold2.stack.push(menu);
    for (let i = 0; i < 4000; i++) {
      if (red.save.party[0]!.species === "GEODUDE" && gold2.save.party[0].species === "PIKACHU") break;
      red.tick(i % 2 === 0 ? VOX_BTN.a : 0);
      if (i % 15 === 0 && (gold2.stack.top() !== menu || menu.phase === "confirm" || menu.phase === "message")) gold2.input.press("a");
      gold2.input.step();
      gold2.serviceLink();
      gold2.stack.top()?.update?.();
    }
    // Red got a Gen 1 GEODUDE, its numbers its own game's
    const got = red.save.party[0]!;
    expect(got.species).toBe("GEODUDE");
    expect(got.level).toBe(15);
    expect(got.otName).toBe("GOLD");
    expect(typeof got.stats.special).toBe("number");
    // Gold got a Gen 2 PIKACHU: the split specials, and its catch rate (190) held
    const pika = gold2.save.party[0];
    expect(pika.species).toBe("PIKACHU");
    expect(pika.stats.specialAttack).toBeGreaterThan(0);
    expect(pika.item).toBe("BERRY");
    expect(pika.otName).toBe("RED");
    expect(pika.happiness).toBe(70);
  });
});

describe("gen2 TIME CAPSULE", () => {
  test.skipIf(!gold)("which parties can travel: a species, a move, MAIL", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    const ok = [Mon.new(game.data, "PIKACHU", 20, {})!];
    expect(TimeCapsule.compatibility(game.data, ok).code).toBe(0);
    const newSpecies = [Mon.new(game.data, "PIKACHU", 20, {})!, Mon.new(game.data, "CHIKORITA", 5, {})!];
    const a = TimeCapsule.compatibility(game.data, newSpecies);
    expect(a.code).toBe(1);
    expect(a.buffers[0]).toBe("CHIKORITA");
    const newMove = Mon.new(game.data, "PIKACHU", 20, {})!;
    newMove.moves[0] = { id: "SKETCH", pp: 1, maxPp: 1 };
    const b = TimeCapsule.compatibility(game.data, [newMove]);
    expect(b.code).toBe(2);
    expect(b.buffers).toEqual(["PIKACHU", "SKETCH"]);
    const mail = Mon.new(game.data, "PIKACHU", 20, {})!;
    mail.item = "FLOWER_MAIL";
    expect(TimeCapsule.compatibility(game.data, [mail]).code).toBe(3);
  });

  test.skipIf(!gold)("a mon to the past and back: species names, the catch rate as the held item", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    const mime = Mon.new(game.data, "MR__MIME", 30, {})!;
    mime.item = "LEFTOVERS";
    const past: any = TimeCapsule.toGen1(game.data, mime);
    expect(past.species).toBe("MR_MIME");
    expect(past.level).toBe(30);
    expect(past.catchRate).toBe(game.data.items.LEFTOVERS.index);
    expect(typeof past.stats.special).toBe("number");
    // a Kanto SNORLAX (catch rate 25) arrives holding LEFTOVERS; a 255 holds a BERRY
    const snorlax = { species: "SNORLAX", level: 40, exp: 0, catchRate: 25, hp: 100, status: "PSN",
      dvs: { attack: 15, defense: 10, speed: 10, special: 10 }, statExp: {},
      stats: { hp: 200, attack: 100, defense: 60, speed: 30, special: 60 },
      moves: [{ id: "BODY_SLAM", pp: 10, ppUps: 1 }, { id: "REST", pp: 5 }] };
    const back = TimeCapsule.toGen2(game.data, snorlax);
    expect(back.item).toBe("LEFTOVERS");
    expect(back.status).toBe("poison");
    expect(back.stats.specialAttack).toBeGreaterThan(0);
    expect(back.moves[0].maxPp).toBe(15 + 3); // BODY SLAM 15, one PP UP
    expect(back.hp).toBe(Math.round((100 * back.stats.hp) / 200));
    expect(back.shiny).toBe(true); // ATK 15 / DEF SPD SPC 10
    expect(TimeCapsule.toGen2(game.data, { ...snorlax, catchRate: 255 }).item).toBe("BERRY");
    expect(TimeCapsule.toGen2(game.data, { ...snorlax, species: "FARFETCHD" }).species).toBe("FARFETCH_D");
  });
});
