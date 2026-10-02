// Gold's MYSTERY GIFT (gen2/core/MysteryGift.ts, gen2/ui/MysteryGiftScreen.ts):
// the cart's weighted pick, the day's limits, two Gold games swapping gifts
// over a loopback link, and the TRAINER HOUSE's CAL2 that a gift leaves.
import { afterEach, describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { CableClub } from "../voxelmon/game/gen2/core/CableClub.ts";
import { MysteryGift, MYSTERY_GIFT_DECOS, MYSTERY_GIFT_ITEMS, randomSample, type GiftRecord } from "../voxelmon/game/gen2/core/MysteryGift.ts";
import { MysteryGiftScreen } from "../voxelmon/game/gen2/ui/MysteryGiftScreen.ts";
import { TrainerHouse } from "../voxelmon/game/gen2/world/TrainerHouse.ts";
import { MainMenu } from "../voxelmon/game/gen2/ui/MainMenu.ts";
import { LoopbackLink, type LinkTransport } from "../voxelmon/game/world/link.ts";

const gold = haveGoldGen();

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

function goldGame(name: string, id: number, party: [string, number][]): any {
  const game: any = Game2.new();
  game.load({ startWorld: false });
  game.save = game.save ?? {};
  game.save.player = { ...(game.save.player ?? {}), name, id };
  game.save.party = party.map(([s, l]) => Mon.stampOT(game.save, Mon.new(game.data, s, l, {})));
  game.input = fakeInput();
  return game;
}

const record = (over: Partial<GiftRecord>): GiftRecord => ({
  game: "gold", id: 1, name: "X", caught: 0, sentDeco: false, whichItem: 0, whichDeco: 0,
  waiting: false, count: 0, party: [], ...over,
});

afterEach(() => {
  CableClub.transport = null;
});

describe("gen2 MYSTERY GIFT", () => {
  test(".RandomSample: the bands and the trainer ID's bits", () => {
    const seq = (...v: number[]) => () => v.shift() ?? 0;
    // 90%: a = 3 -> 6 + bit 2 of the low byte
    expect(randomSample(0, 0b100, seq(200, 3))).toBe(7);
    expect(randomSample(0, 0, seq(200, 3))).toBe(6);
    // a = 0 reads bit 7
    expect(randomSample(0, 0x80, seq(200, 0))).toBe(1);
    // 10% then 80%: 16 + 2a + bit (a - 1) of the high byte
    expect(randomSample(0b10, 0, seq(10, 60, 2))).toBe(16 + 4 + 1);
    // then 24 + (hi >> 4) & 7
    expect(randomSample(0x50, 0, seq(10, 10, 60))).toBe(24 + 5);
    // then 32 or 33 by the high bit
    expect(randomSample(0x80, 0, seq(10, 10, 10))).toBe(33);
    expect(randomSample(0x00, 0, seq(10, 10, 10))).toBe(32);
    // every index lands inside both tables
    for (let k = 0; k < 2000; k++) {
      const i = randomSample(k & 0xff, (k * 37) & 0xff);
      expect(i).toBeLessThan(Math.min(MYSTERY_GIFT_ITEMS.length, MYSTERY_GIFT_DECOS.length));
    }
  });

  test("the cart's checks, in order: five a day, one per person, a gift waiting, the friend's", () => {
    const save: any = { mysteryGift: { unlocked: true } };
    const me = record({ id: 10 });
    for (let id = 1; id <= 5; id++) {
      expect(MysteryGift.receive(save, me, record({ id, whichItem: id })).kind).toBe("item");
      MysteryGift.take(save);
    }
    expect(MysteryGift.receive(save, me, record({ id: 6 })).kind).toBe("fiveADay");
    const s2: any = { mysteryGift: { unlocked: true } };
    MysteryGift.receive(s2, me, record({ id: 7 }));
    MysteryGift.take(s2);
    expect(MysteryGift.receive(s2, me, record({ id: 7 })).kind).toBe("oneADay");
    expect(MysteryGift.receive(s2, record({ waiting: true }), record({ id: 8 })).kind).toBe("giftWaiting");
    expect(MysteryGift.receive(s2, me, record({ id: 9, waiting: true })).kind).toBe("friendNotReady");
    // a decoration once; the second copy is the item instead
    const s3: any = { mysteryGift: { unlocked: true } };
    expect(MysteryGift.receive(s3, me, record({ id: 1, sentDeco: true, whichDeco: 2, whichItem: 34 }))).toMatchObject({ kind: "deco", deco: 27 });
    expect(MysteryGift.receive(s3, me, record({ id: 2, sentDeco: true, whichDeco: 2, whichItem: 34 }))).toMatchObject({ kind: "item", item: "RARE_CANDY" });
  });

  test("a new day forgets the day's partners; locked stays locked", () => {
    const save: any = { mysteryGift: { unlocked: true, ids: [1, 2] } };
    MysteryGift.dayPassed(save, { day: 100 }); // never armed: run out
    expect(save.mysteryGift.ids).toEqual([]);
    save.mysteryGift.ids = [3];
    MysteryGift.dayPassed(save, { day: 100 });
    expect(save.mysteryGift.ids).toEqual([3]);
    MysteryGift.dayPassed(save, { day: 101 });
    expect(save.mysteryGift.ids).toEqual([]);
    const locked: any = {};
    MysteryGift.dayPassed(locked, { day: 5 });
    expect(locked.mysteryGift.unlocked).toBe(false);
    MysteryGift.unlock(locked);
    expect(locked.mysteryGift).toMatchObject({ unlocked: true, item: 0 });
  });

  test.skipIf(!gold)("two Gold games swap gifts over the link; the TRAINER HOUSE gets the partner", () => {
    useGoldGen();
    const a = goldGame("AAA", 0x1234, [["CYNDAQUIL", 20], ["PIDGEY", 12]]);
    const b = goldGame("BBB", 0xbeef, [["TOTODILE", 22]]);
    for (const g of [a, b]) MysteryGift.unlock(g.save);
    // the main menu offers it once unlocked
    const menu = MainMenu.new(a, { save: a.save, onMysteryGift: () => {} });
    expect(menu.list.items.map((i: any) => i.value)).toContain("gift");
    const link = new LoopbackLink();
    const ends: LinkTransport[] = [link.a, link.b];
    CableClub.transport = () => ends.shift() ?? null;
    let closed = 0;
    const sa = MysteryGiftScreen.new(a, { save: a.save, onClose: () => closed++ });
    const sb = MysteryGiftScreen.new(b, { save: b.save, onClose: () => closed++ });
    const step = (): void => {
      for (const [g, s] of [[a, sa], [b, sb]] as const) {
        g.input.step();
        s.update();
      }
    };
    a.input.press("a");
    b.input.press("a");
    for (let k = 0; k < 300 && !(sa.phase === "message" && sb.phase === "message"); k++) step();
    expect(sa.phase).toBe("message");
    expect(sb.phase).toBe("message");
    expect(["item", "deco"]).toContain(String(sa.result?.kind));
    expect(["item", "deco"]).toContain(String(sb.result?.kind));
    expect(sa.pages[0]).toStartWith("BBB sent");
    expect(sb.pages[0]).toStartWith("AAA sent");
    expect(a.save.mysteryGift.ids).toEqual([0xbeef]);
    expect(b.save.mysteryGift.ids).toEqual([0x1234]);
    // the TRAINER HOUSE: BBB, with BBB's TOTODILE at 22 and its moves
    expect(TrainerHouse.hasCustomTrainer(a.save)).toBe(true);
    const cal2 = TrainerHouse.lookup(a.data.trainers, a.save, TrainerHouse.CAL, TrainerHouse.CAL2)!;
    expect(cal2.name).toBe("BBB");
    expect(cal2.trainerType).toBe("TRAINERTYPE_MOVES");
    expect(cal2.roster.map((m: any) => [m.species, m.level])).toEqual([["TOTODILE", 22]]);
    expect(cal2.roster[0].moves.length).toBeGreaterThan(0);
    // what each got was decided by the other's record
    if (sa.result?.kind === "item") expect(a.save.mysteryGift.item).toBe(MYSTERY_GIFT_ITEMS[sb.mine!.whichItem]);
    // A through the words, back to the menu
    for (let k = 0; k < 6; k++) {
      a.input.press("a");
      b.input.press("a");
      step();
      step();
    }
    expect(closed).toBe(2);
    // again today with the same friend: one a day per person
    const link2 = new LoopbackLink();
    const ends2: LinkTransport[] = [link2.a, link2.b];
    CableClub.transport = () => ends2.shift() ?? null;
    MysteryGift.take(a.save);
    MysteryGift.take(b.save);
    const ta = MysteryGiftScreen.new(a, { save: a.save });
    const tb = MysteryGiftScreen.new(b, { save: b.save });
    a.input.press("a");
    b.input.press("a");
    for (let k = 0; k < 300 && !(ta.phase === "message" && tb.phase === "message"); k++) {
      for (const [g, s] of [[a, ta], [b, tb]] as const) {
        g.input.step();
        s.update();
      }
    }
    expect(ta.result?.kind).toBe("oneADay");
    expect(tb.result?.kind).toBe("oneADay");
  });

  test.skipIf(!gold)("B on the linking screen cancels", () => {
    useGoldGen();
    const a = goldGame("AAA", 1, [["CYNDAQUIL", 5]]);
    MysteryGift.unlock(a.save);
    const link = new LoopbackLink();
    CableClub.transport = () => link.a;
    const s = MysteryGiftScreen.new(a, { save: a.save });
    a.input.press("a");
    a.input.step();
    s.update();
    expect(s.phase).toBe("linking");
    a.input.press("b");
    a.input.step();
    s.update();
    expect(s.phase).toBe("message");
    expect(s.pages[0]).toBe("The link has been\ncancelled.");
  });
});
