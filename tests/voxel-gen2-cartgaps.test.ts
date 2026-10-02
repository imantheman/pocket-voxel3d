// What the Gold/Silver carts did that the port had left out (the 2026-10-02
// audit): wild held items, the wall TOWN MAP, PROF.OAK's rating at the end
// of the HALL OF FAME, and the clock-reset password.
import { describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { rollWildItem } from "../voxelmon/game/gen2/world/World.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { ResetClock, clockResetPassword } from "../voxelmon/game/gen2/ui/ResetClock.ts";
import { Clock } from "../voxelmon/game/gen2/core/Clock.ts";

const gold = haveGoldGen();

/** A roll function that hands out `bytes` in order. */
function rolls(...bytes: number[]): (n: number) => number {
  let i = 0;
  return () => bytes[i++] ?? 0;
}

describe("wild held items", () => {
  test("75% none, then 8% of the rest Item2, else Item1", () => {
    const miltank = { items: ["MOOMOO_MILK", "MOOMOO_MILK"] };
    const pair = { items: ["MYSTERYBERRY", "MOON_STONE"] };
    expect(rollWildItem(pair, rolls(191))).toBeUndefined();
    expect(rollWildItem(pair, rolls(192, 20))).toBe("MYSTERYBERRY");
    expect(rollWildItem(pair, rolls(255, 19))).toBe("MOON_STONE");
    expect(rollWildItem(miltank, rolls(200, 0))).toBe("MOOMOO_MILK");
  });

  test("an empty slot rolls to nothing: CHANSEY's LUCKY EGG is the 2% one", () => {
    const chansey = { items: { "2": "LUCKY_EGG" } };
    expect(rollWildItem(chansey, rolls(255, 50))).toBeUndefined();
    expect(rollWildItem(chansey, rolls(255, 5))).toBe("LUCKY_EGG");
    expect(rollWildItem({ items: [] }, rolls(255, 0))).toBeUndefined();
    expect(rollWildItem(undefined)).toBeUndefined();
  });

  test.skipIf(!gold)("a wild battle's mon comes out holding its roll", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    game.writeSave = () => [true];
    for (let k = 0; k < 30; k++) game.frame(0);
    const w = game.world;
    let held = 0;
    let none = 0;
    for (let i = 0; i < 200; i++) {
      const wild: any = { species: "MILTANK", level: 5 };
      const base = game.stack.states.length;
      w.startBattle({ wild }, () => {});
      while (game.stack.states.length > base) game.stack.pop();
      if (wild.item === "MOOMOO_MILK") held++;
      else if (wild.item == null) none++;
    }
    expect(held + none).toBe(200);
    // 25% expected: comfortably inside 10..45%
    expect(held).toBeGreaterThan(20);
    expect(held).toBeLessThan(90);
  });
});

describe("the wall TOWN MAP", () => {
  test.skipIf(!gold)("OverworldTownMap opens the region map; B puts it away and the script goes on", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    game.writeSave = () => [true];
    for (let k = 0; k < 30; k++) game.frame(0);
    const w = game.world;
    const id = w.constants.specialOrder.indexOf("OverworldTownMap");
    expect(id).toBeGreaterThanOrEqual(0);
    w.vm.start([{ op: "special", id }, { op: "end" }]);
    for (let k = 0; k < 20; k++) game.frame(0);
    const top = game.stack.top();
    expect(top?.screenId ?? top?.constructor?.name).toContain("Pokegear");
    expect(top.townMap).toBe(true);
    for (let k = 0; k < 6; k++) game.frame(k === 0 ? VOX_BTN.b : 0);
    expect(game.stack.top()?.townMap).toBeUndefined();
    for (let k = 0; k < 20; k++) game.frame(0);
    expect(w.vm.running()).toBe(false);
  });
});

describe("the clock reset password", () => {
  function fakeGame() {
    let now = new Set<string>();
    let held = new Set<string>();
    return {
      options: {},
      input: {
        wasPressed: (b: string) => now.has(b),
        isDown: (b: string) => now.has(b) || held.has(b),
      },
      tap(screen: any, b?: string) {
        now = new Set(b ? [b] : []);
        screen.update();
        now = new Set();
        for (let i = 0; i < 120 && screen.typer && !screen.typer.done(); i++) screen.update();
      },
      hold(bs: string[]) {
        held = new Set(bs);
      },
    };
  }

  test.skipIf(!gold)(".CalculatePassword: ID bytes + the name's first five + the money's three", () => {
    useGoldGen();
    Game2.new().load({ startWorld: false });
    // GOLD = $86 $8E $8B $83 (546); ID $1234 (18 + 52); 3000 = $000BB8 (0 + 11 + 184)
    expect(clockResetPassword({ player: { id: 0x1234, name: "GOLD", money: 3000 } })).toBe(811);
    // only five characters count
    const five = clockResetPassword({ player: { id: 0, name: "ABCDE", money: 0 } });
    expect(clockResetPassword({ player: { id: 0, name: "ABCDEFG", money: 0 } })).toBe(five);
  });

  test.skipIf(!gold)("the right password flags the save; CONTINUE then sets the clock", () => {
    useGoldGen();
    Game2.new().load({ startWorld: false });
    const save: any = { player: { id: 7, name: "GOLD", money: 0 }, rtc: {} };
    const pw = clockResetPassword(save);
    const g = fakeGame();
    let saved = 0;
    let outcome: boolean | undefined;
    const s: any = ResetClock.new(g, { mode: "password", save, persist: () => saved++, onDone: (ok) => (outcome = ok) });
    g.tap(s);
    expect(s.step).toBe("ask");
    g.tap(s, "down"); // NO -> YES
    g.tap(s, "a");
    g.tap(s);
    expect(s.step).toBe("digits");
    // dial the password in, digit by digit from the left
    const want = String(pw).padStart(5, "0").split("").map(Number);
    for (let i = 0; i < 4; i++) g.tap(s, "left");
    want.forEach((d, i) => {
      for (let k = 0; k < d; k++) g.tap(s, "up");
      if (i < 4) g.tap(s, "right");
    });
    g.tap(s, "a");
    expect(save.rtc.resetPending).toBe(true);
    expect(saved).toBe(1);
    for (let i = 0; i < 4 && outcome === undefined; i++) g.tap(s, "a");
    expect(outcome).toBe(true);

    // the restart: Saturday 23:59
    const r: any = ResetClock.new(g, { mode: "restart", save, persist: () => saved++, onDone: (ok) => (outcome = ok) });
    outcome = undefined;
    for (let i = 0; i < 6 && r.step !== "edit"; i++) g.tap(r, "a");
    expect(r.step).toBe("edit");
    r.day = 6;
    r.hour = 23;
    r.field = 2;
    r.minute = 58;
    g.tap(r, "up");
    expect(r.minute).toBe(59);
    g.tap(r, "a");
    g.tap(r);
    expect(r.step).toBe("confirm");
    g.tap(r, "a"); // YES
    for (let i = 0; i < 4 && outcome === undefined; i++) g.tap(r, "a");
    expect(outcome).toBe(true);
    expect(save.rtc.resetPending).toBeUndefined();
    expect(Clock.weekday(save)).toBe(6);
    expect(Clock.hour(save)).toBe(23);
    expect(Clock.minute(save)).toBe(59);
  });

  test.skipIf(!gold)("a wrong password changes nothing", () => {
    useGoldGen();
    Game2.new().load({ startWorld: false });
    const save: any = { player: { id: 7, name: "GOLD", money: 0 }, rtc: {} };
    const g = fakeGame();
    let outcome: boolean | undefined;
    const s: any = ResetClock.new(g, { mode: "password", save, onDone: (ok) => (outcome = ok) });
    g.tap(s);
    g.tap(s, "down");
    g.tap(s, "a");
    g.tap(s);
    g.tap(s, "a"); // 00000
    for (let i = 0; i < 4 && outcome === undefined; i++) g.tap(s, "a");
    expect(outcome).toBe(false);
    expect(save.rtc.resetPending).toBeUndefined();
  });
});
