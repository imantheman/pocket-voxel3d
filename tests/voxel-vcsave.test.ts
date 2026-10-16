// VC saves: the Gen 1 cartridge save <-> Lua save converter
// (voxelmon/game/vc/cartsave.ts) and the ROM facts it writes with
// (voxelmon/import/stages/vcsave.ts).
//
// The data-gated parts need dist/voxelmon/{,blue/,yellow/}gen with
// vcsave.json (bun tools/voxel.ts import, or bun tools/vc_gamedata.ts
// <rom> --json <gen>/vcsave.json). Real cartridge saves are read from
// VC_REAL_SAVES (a folder of .sav files, named *yellow* / *blue* / else Red)
// when it is set, and saves the real ROM wrote in mGBA from VC_ROM_SAVES
// (same naming); neither is ever committed.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { loadRuntimeData, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { encodeSave } from "../voxelmon/game/save-lua.ts";
import { decodeSave } from "../voxelmon/game/save-read.ts";
import * as L from "../voxelmon/game/vc/layout.ts";
import { M } from "../voxelmon/game/vc/layout.ts";
import { cartSummary, cartToSave, checksum, isCartSave, saveToCart } from "../voxelmon/game/vc/cartsave.ts";

const root = join(import.meta.dir, "..");
const dirs = { red: "dist/voxelmon/gen", blue: "dist/voxelmon/blue/gen", yellow: "dist/voxelmon/yellow/gen" } as const;
type V = keyof typeof dirs;
const sets: Partial<Record<V, VoxelmonData>> = {};
for (const v of Object.keys(dirs) as V[]) {
  const d = join(root, dirs[v]);
  if (existsSync(join(d, "pokemon.json")) && existsSync(join(d, "vcsave.json"))) {
    sets[v] = await loadRuntimeData(d);
    // (an imported dataset says which game it is in version.json, which the
    // runtime loader leaves out; a cooked gamedata.json carries it)
    (sets[v] as { version?: string }).version ??= v;
  }
}
const has = (v: V): boolean => !!sets[v]?.vcsave;

describe("the cartridge layout", () => {
  test("the documented anchors fall out of the main-data offsets", () => {
    const abs = (k: number): number => L.MAIN + k;
    expect(L.MAIN).toBe(0x25a3);
    expect(abs(M.money)).toBe(0x25f3);
    expect(abs(M.rivalName)).toBe(0x25f6);
    expect(abs(M.options)).toBe(0x2601);
    expect(abs(M.badges)).toBe(0x2602);
    expect(abs(M.playerId)).toBe(0x2605);
    expect(abs(M.pikachuHappiness)).toBe(0x271c);
    expect(abs(M.numPcItems)).toBe(0x27e6);
    expect(abs(M.curBox)).toBe(0x284c);
    expect(abs(M.numHofTeams)).toBe(0x284e);
    expect(abs(M.coins)).toBe(0x2850);
    expect(abs(M.events)).toBe(0x29f3);
    expect(abs(M.playHours)).toBe(0x2ced);
    expect(L.SPRITE_DATA).toBe(0x2d2c);
    expect(L.PARTY).toBe(0x2f2c);
    expect(L.CUR_BOX).toBe(0x30c0);
    expect(L.MAIN_CHECKSUM).toBe(0x3523);
    expect(L.BOX_BANKS[0] + L.BOX_BANK_CHECKSUM).toBe(0x5a4c);
    expect(L.BOX_BANKS[1] + L.BOX_BANK_CHECKSUM).toBe(0x7a4c);
  });

  test("the checksum is the complement of the byte sum", () => {
    const b = new Uint8Array([1, 2, 3, 250]);
    expect(checksum(b, 0, 4)).toBe(~(1 + 2 + 3 + 250) & 0xff);
    const blank = new Uint8Array(L.SAVE_SIZE).fill(0xff);
    expect(isCartSave(blank)).toBe(false);
    expect(cartSummary(blank)).toBeNull();
    expect(isCartSave(new Uint8Array(100))).toBe(false);
  });
});

/** A Lua save with something in every field the converter maps. */
function richSave(data: VoxelmonData, v: V): any {
  const game = new VoxelmonGame(data, new RecorderHost(), 1);
  game.newGame();
  const s: any = JSON.parse(JSON.stringify(game.save));
  const yellow = v === "yellow";
  s.player = { ...s.player, name: "ASH", rival: "GARY", id: 0x1234, map: "VIRIDIAN_CITY", x: 23, y: 26, facing: "down" };
  const mon = (species: string, level: number, extra: any = {}) => ({
    species, level, exp: level * level * level, hp: 20, catchRate: 45, status: null,
    dvs: { attack: 10, defense: 5, speed: 12, special: 3, hp: 0b0101 },
    statExp: { hp: 100, attack: 200, defense: 300, speed: 400, special: 500 },
    stats: { hp: 40, attack: 30, defense: 28, speed: 33, special: 25 },
    moves: [{ id: "TACKLE", pp: 30, ppUps: 1 }, { id: "GROWL", pp: 40 }], ...extra,
  });
  s.party = [
    mon(yellow ? "PIKACHU" : "BULBASAUR", 14, { nickname: "SPROUT" }),
    mon("PIDGEY", 9, { status: "PSN" }),
    mon("ABRA", 12, { otName: "BRIAN", otId: 777, traded: true }),
  ];
  s.boxes = Array.from({ length: 12 }, () => []);
  s.boxes[0] = [mon("RATTATA", 4)];
  s.boxes[7] = [mon("ZUBAT", 8, { nickname: "BAT" })];
  s.currentBox = 1;
  s.inventory = { POTION: 5, POKE_BALL: 10, BOULDERBADGE: 1, CASCADEBADGE: 1, TM_MEGA_PUNCH: 1, HM_CUT: 1 };
  s.bagOrder = ["POKE_BALL", "POTION", "TM_MEGA_PUNCH", "HM_CUT"];
  s.pcItems = { POTION: 1, ANTIDOTE: 3 };
  s.pcOrder = ["POTION", "ANTIDOTE"];
  s.money = 123456;
  s.coins = 4321;
  s.flags = { EVENT_GOT_STARTER: true, EVENT_GOT_POKEDEX: true, EVENT_GOT_OLD_ROD: true, EVENT_BEAT_BROCK: true, EVENT_RECEIVED_BIKE_VOUCHER: true };
  if (!yellow) s.flags.EVENT_CHOSE_BULBASAUR = true;
  s.pokedex = { owned: { PIDGEY: true, ABRA: true }, seen: { PIDGEY: true, ABRA: true, ZUBAT: true } };
  s.options = { textSpeed: 1, animations: false, battleStyle: "set" };
  s.playTime = 3 * 3600 + 25 * 60 + 9;
  s.visited = { PALLET_TOWN: true, VIRIDIAN_CITY: true, PEWTER_CITY: true };
  s.lastOutdoor = { id: "VIRIDIAN_CITY", x: 23, y: 26 };
  s.daycare = { mon: mon("ODDISH", 10), steps: 250, depositLevel: 10 };
  s.hallOfFame = [[{ species: "PIDGEY", level: 50, nickname: "WINGS" }, { species: "ABRA", level: 48 }]];
  if (yellow) { s.pikachuHappiness = 140; s.pikachuMood = 120; s.rivalStarter = 2; }
  return s;
}

for (const v of Object.keys(dirs) as V[]) {
  describe(`${v}: Lua save <-> cartridge save`, () => {
    test.skipIf(!has(v))("every mapped field survives Lua -> SRAM -> Lua", () => {
      const data = sets[v]!;
      const src = richSave(data, v);
      const w = saveToCart(src, data as never, null);
      expect(w.notes).toEqual([]);
      expect(isCartSave(w.bytes)).toBe(true);
      const { save: back, notes } = cartToSave(w.bytes, data as never);
      expect(notes).toEqual([]);
      expect(back.player).toMatchObject({ name: "ASH", rival: "GARY", id: 0x1234, map: "VIRIDIAN_CITY", x: 23, y: 26 });
      expect(back.money).toBe(123456);
      expect(back.coins).toBe(4321);
      expect(back.playTime).toBe(src.playTime);
      expect(back.options).toMatchObject({ textSpeed: 1, animations: false, battleStyle: "set" });
      expect(back.inventory).toEqual(src.inventory);
      expect(back.bagOrder).toEqual(src.bagOrder);
      expect(back.pcItems).toEqual(src.pcItems);
      expect(back.flags).toMatchObject(src.flags);
      expect(back.visited).toEqual(src.visited);
      expect(Object.keys(back.pokedex.owned).sort()).toEqual(["ABRA", "PIDGEY"]);
      expect(back.pokedex.seen.ZUBAT).toBe(true);
      expect(back.party.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        const a = src.party[i], b = back.party[i];
        for (const k of ["species", "level", "exp", "hp", "catchRate", "status", "dvs", "statExp", "stats", "moves", "nickname"]) expect(b[k]).toEqual(a[k]);
      }
      expect(back.party[0].otName).toBeUndefined();
      expect(back.party[2]).toMatchObject({ otName: "BRIAN", otId: 777, traded: true });
      expect(back.boxes[0][0].species).toBe("RATTATA");
      expect(back.boxes[7][0]).toMatchObject({ species: "ZUBAT", nickname: "BAT", level: 8 });
      // the day-care's walk is exp on the cartridge, at the level it went in at
      expect(back.daycare.mon.exp).toBe(1000 + 250);
      expect(back.daycare.depositLevel).toBe(10);
      expect(back.hallOfFame).toEqual(src.hallOfFame);
      if (v === "yellow") expect(back).toMatchObject({ pikachuHappiness: 140, pikachuMood: 120, rivalStarter: 2 });
      else expect(back.flags.EVENT_CHOSE_BULBASAUR).toBe(true);
    });

    test.skipIf(!has(v))("SRAM -> Lua -> SRAM is byte for byte", () => {
      const data = sets[v]!;
      const first = saveToCart(richSave(data, v), data as never, null).bytes;
      const lua = decodeSave(encodeSave(cartToSave(first, data as never).save));
      const again = saveToCart(lua, data as never, first).bytes;
      const diffs: string[] = [];
      for (let i = 0; i < L.SAVE_SIZE; i++) if (again[i] !== first[i]) diffs.push(`${i.toString(16)}:${first[i]}>${again[i]}`);
      expect(diffs.slice(0, 20)).toEqual([]);
    });

    test.skipIf(!has(v))("the port's ENHANCEMENTS and CHEATS settings never reach the cartridge", () => {
      // extras.ts: port-only option keys. The cart's option byte holds text
      // speed, animations and battle style only; the rest must change nothing.
      const data = sets[v]!;
      const plain = saveToCart(richSave(data, v), data as never, null).bytes;
      const s = richSave(data, v);
      Object.assign(s.options, {
        expForCatching: true, partyExpShare: true, tradeEvoLv40: true, hmsWithoutMove: true, cheats: true,
        wildEncounters: "none", alwaysCatch: true, instantVictory: true, infiniteMoney: true,
      });
      const withExtras = saveToCart(s, data as never, null).bytes;
      expect(Buffer.from(withExtras).equals(Buffer.from(plain))).toBe(true);
      const back = cartToSave(withExtras, data as never).save as { options: Record<string, unknown> };
      expect(Object.keys(back.options).sort()).toEqual(["animations", "battleStyle", "textSpeed"]);
      // INFINITE MONEY's 999999 is the cart's own ceiling: it goes over whole
      s.money = 999999;
      expect((cartToSave(saveToCart(s, data as never, null).bytes, data as never).save as { money: number }).money).toBe(999999);
    });

    test.skipIf(!has(v))("the current map's engine state is the ROM's, on every map", () => {
      const data = sets[v]!;
      const s = richSave(data, v);
      let n = 0;
      for (const [mapId, vc] of Object.entries(data.vcsave!.maps)) {
        if (!(data as any).maps[mapId]) continue;
        s.player.map = mapId; s.player.x = 4; s.player.y = 5;
        const b = saveToCart(s, data as never, null).bytes;
        const hdr = Buffer.from(b.subarray(L.MAIN + M.mapHeader, L.MAIN + M.mapHeader + 10)).toString("hex");
        expect(hdr).toBe(vc.h);
        const width = parseInt(vc.h.slice(4, 6), 16);
        const view = b[L.MAIN + M.viewPointer]! | (b[L.MAIN + M.viewPointer + 1]! << 8);
        expect(view).toBe(0xc6e8 + 7 + width + (width + 6) * 2 + 2);
        expect(b[L.MAIN + M.yBlock]).toBe(1);
        n++;
      }
      expect(n).toBeGreaterThan(200);
    });

    test.skipIf(!has(v))("a save on the cartridge save's own map keeps the game's bytes", () => {
      const data = sets[v]!;
      const s = richSave(data, v);
      const first = saveToCart(s, data as never, null).bytes;
      const tmpl = new Uint8Array(first);
      tmpl[L.SPRITE_DATA + 16 + 4] = 0x77; // an NPC mid-walk
      s.player.x = 24; // one step east, same map
      const b = saveToCart(s, data as never, tmpl).bytes;
      expect(b[L.SPRITE_DATA + 16 + 4]).toBe(0x77);
      expect(b[L.MAIN + M.xCoord]).toBe(24);
    });
  });
}

/** Saves found in a folder, with the game each is for. */
function savesIn(dir: string | undefined): { file: string; v: V }[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sav")).map((f) => ({
    file: join(dir, f),
    v: (/yellow/i.test(f) ? "yellow" : /blue/i.test(f) ? "blue" : "red") as V,
  }));
}

describe("real cartridge saves", () => {
  const real = savesIn(process.env.VC_REAL_SAVES);
  test.skipIf(real.length === 0)("read and written back byte for byte", () => {
    for (const { file, v } of real) {
      const data = sets[v];
      if (!data?.vcsave) continue;
      const b = new Uint8Array(readFileSync(file));
      if (!isCartSave(b)) continue; // an empty (never saved) file
      const lua = decodeSave(encodeSave(cartToSave(b, data as never).save));
      const again = saveToCart(lua, data as never, b).bytes;
      expect(`${file}: ${Buffer.from(again).equals(Buffer.from(b.subarray(0, L.SAVE_SIZE)))}`).toBe(`${file}: true`);
    }
  });
});

/** From the title, CONTINUE, until the overworld runs. */
function continueGame(data: VoxelmonData, luaText: string): VoxelmonGame {
  class Card extends RecorderHost {
    saveData(): string | undefined { return luaText; }
  }
  const game = new VoxelmonGame(data, new Card(), 1);
  game.newGame();
  game.tick(VOX_BTN.start); game.tick(0);
  game.tick(VOX_BTN.a); game.tick(0);
  for (let i = 0; i < 400 && game.stackKinds().at(-1) !== "overworld"; i++) game.tick(i % 2 ? VOX_BTN.a : 0);
  return game;
}

describe("a cartridge save continues in this game", () => {
  for (const v of Object.keys(dirs) as V[]) {
    test.skipIf(!has(v))(`${v}: CONTINUE from a converted save lands on its spot with its party`, () => {
      const data = sets[v]!;
      const sram = saveToCart(richSave(data, v), data as never, null).bytes;
      const game = continueGame(data, encodeSave(cartToSave(sram, data as never).save));
      const ow: any = (game as any).overworld;
      expect(game.stackKinds().at(-1)).toBe("overworld");
      expect([ow.mapId ?? ow.map?.id, ow.player.cellX, ow.player.cellY]).toEqual(["VIRIDIAN_CITY", 23, 26]);
      expect(game.save.party.map((m: any) => m.species)).toEqual(richSave(data, v).party.map((m: any) => m.species));
    });
  }
  const romSaves = savesIn(process.env.VC_ROM_SAVES);
  test.skipIf(romSaves.length === 0)("saves the real ROM wrote continue too", () => {
    for (const { file, v } of romSaves) {
      const data = sets[v];
      if (!data?.vcsave) continue;
      const b = new Uint8Array(readFileSync(file));
      const lua = cartToSave(b, data as never).save;
      const game = continueGame(data, encodeSave(lua));
      const ow: any = (game as any).overworld;
      expect(`${file} ${game.stackKinds().at(-1)}`).toBe(`${file} overworld`);
      expect([ow.mapId ?? ow.map?.id, ow.player.cellX, ow.player.cellY]).toEqual([lua.player.map, lua.player.x, lua.player.y]);
      expect(game.save.party.length).toBe(lua.party.length);
    }
  });
});

/** A console with a VC title: its save in memory, writes recorded. */
class VcConsole extends RecorderHost {
  lua: string | undefined;
  vc: Uint8Array | undefined;
  luaWrites: string[] = [];
  vcWrites: Uint8Array[] = [];
  constructor(lua: string | undefined, vc: Uint8Array | undefined) {
    super();
    this.lua = lua;
    this.vc = vc;
  }
  saveData(): string | undefined { return this.lua; }
  saveWrite(text: string): void { this.luaWrites.push(text); this.lua = text; }
  vcData(): Uint8Array | undefined { return this.vc ? new Uint8Array(this.vc) : undefined; }
  vcWrite(b: Uint8Array): boolean { this.vcWrites.push(new Uint8Array(b)); this.vc = new Uint8Array(b); return true; }
}

function toTitleMenu(game: VoxelmonGame): any {
  game.tick(VOX_BTN.start); game.tick(0);
  return (game as any).title();
}

describe("CONTINUE's choice and where SAVE goes", () => {
  test.skipIf(!has("red"))("with both saves: a choice, each with its info box", () => {
    const data = sets.red!;
    const lua = richSave(data, "red");
    lua.player.name = "LUAKID";
    lua.player.map = "PALLET_TOWN"; lua.player.x = 5; lua.player.y = 6;
    const vcSave = richSave(data, "red");
    const host = new VcConsole(encodeSave(lua), saveToCart(vcSave, data as never, null).bytes);
    const game = new VoxelmonGame(data, host, 1);
    game.newGame();
    toTitleMenu(game);
    expect((game as any).title().menu[0]).toBe("CONTINUE");
    game.tick(VOX_BTN.a); game.tick(0);
    let t = (game as any).title();
    expect(t.phase).toBe("pick");
    expect(t.menu).toEqual(["LUA SAVE", "VC SAVE"]);
    expect(t.panel[0]).toBe("PLAYER  LUAKID");
    game.tick(VOX_BTN.down); game.tick(0);
    t = (game as any).title();
    expect(t.panel).toEqual(["PLAYER     ASH", "BADGES       2", "POKéDEX      2", "TIME      3:25"]);
    game.tick(VOX_BTN.a); game.tick(0);
    // a step a frame: logged, converted, walked in
    expect(game.stackKinds().at(-1)).toBe("vccontinue");
    for (let i = 0; i < 4; i++) game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("overworld");
    expect(game.saveTarget).toBe("vc");
    expect(game.save.player.name).toBe("ASH");
    game.writeSave();
    expect(host.luaWrites).toEqual([]);
    expect(host.vcWrites.length).toBe(1);
    expect(isCartSave(host.vcWrites[0])).toBe(true);
    expect(cartSummary(host.vcWrites[0])!.name).toBe("ASH");
  });

  test.skipIf(!has("red"))("picking the Lua save saves to the Lua file only", () => {
    const data = sets.red!;
    const host = new VcConsole(encodeSave(richSave(data, "red")), saveToCart(richSave(data, "red"), data as never, null).bytes);
    const game = new VoxelmonGame(data, host, 1);
    game.newGame();
    toTitleMenu(game);
    game.tick(VOX_BTN.a); game.tick(0);
    game.tick(VOX_BTN.a); game.tick(0); // LUA SAVE, first
    expect(game.saveTarget).toBe("lua");
    game.writeSave();
    expect(host.luaWrites.length).toBe(1);
    expect(host.vcWrites).toEqual([]);
  });

  test.skipIf(!has("red"))("a VC save alone: the choice offers just it; B goes back", () => {
    const data = sets.red!;
    const host = new VcConsole(undefined, saveToCart(richSave(data, "red"), data as never, null).bytes);
    const game = new VoxelmonGame(data, host, 1);
    game.newGame();
    expect(toTitleMenu(game).menu[0]).toBe("CONTINUE");
    game.tick(VOX_BTN.a); game.tick(0);
    expect((game as any).title().menu).toEqual(["VC SAVE"]);
    game.tick(VOX_BTN.b); game.tick(0);
    expect((game as any).title().phase).toBe("menu");
  });

  test.skipIf(!has("red"))("an empty VC save, or none: CONTINUE is what it always was", () => {
    const data = sets.red!;
    for (const vc of [new Uint8Array(L.SAVE_SIZE).fill(0xff), undefined]) {
      const host = new VcConsole(encodeSave(richSave(data, "red")), vc);
      const game = new VoxelmonGame(data, host, 1);
      game.newGame();
      toTitleMenu(game);
      game.tick(VOX_BTN.a); game.tick(0);
      expect(game.stackKinds().at(-1)).toBe("overworld");
      expect(game.saveTarget).toBe("lua");
    }
    // and with no save at all, no CONTINUE
    const game = new VoxelmonGame(data, new VcConsole(undefined, new Uint8Array(L.SAVE_SIZE)), 1);
    game.newGame();
    expect(toTitleMenu(game).menu[0]).toBe("NEW GAME");
  });

  test.skipIf(!has("red"))("a VC save the host cannot write says so and keeps the session's target", () => {
    const data = sets.red!;
    class Refuses extends VcConsole { vcWrite(): boolean { return false; } vcErr(): string { return "commit failed"; } }
    const host = new Refuses(undefined, saveToCart(richSave(data, "red"), data as never, null).bytes);
    const game = new VoxelmonGame(data, host, 1);
    game.newGame();
    toTitleMenu(game);
    game.tick(VOX_BTN.a); game.tick(0);
    game.tick(VOX_BTN.a); game.tick(0);
    for (let i = 0; i < 4; i++) game.tick(0);
    game.writeSave();
    expect(game.lastSaveOk).toBe(false);
    expect(host.luaWrites).toEqual([]);
    expect(game.stackKinds().at(-1)).toBe("textbox");
  });
});

describe("a VC continue that goes wrong never hangs", () => {
  function atChoice(data: VoxelmonData): { game: VoxelmonGame; logs: string[] } {
    const host = new VcConsole(undefined, saveToCart(richSave(data, "red"), data as never, null).bytes);
    const game = new VoxelmonGame(data, host, 1);
    game.newGame();
    toTitleMenu(game);
    game.tick(VOX_BTN.a); game.tick(0);
    return { game, logs: [] };
  }
  test.skipIf(!has("red"))("a conversion that throws: logged, a message, then the title", () => {
    const data = sets.red!;
    const { game } = atChoice(data);
    (game as any).vcConvert = () => { throw new Error("bad bytes"); };
    const seen: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { seen.push(a.join(" ")); };
    try {
      game.tick(VOX_BTN.a); game.tick(0);
      for (let i = 0; i < 4; i++) game.tick(0);
    } finally { console.log = log; }
    expect(seen.some((l) => l.includes("vc: continue FAILED: bad bytes"))).toBe(true);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(game.saveTarget).toBe("lua");
    for (let i = 0; i < 600 && game.stackKinds().at(-1) !== "title"; i++) game.tick(i % 2 ? VOX_BTN.a : 0);
    expect(game.stackKinds().at(-1)).toBe("title");
  });

  test.skipIf(!has("red"))("a step the host cut off (the deadline) is noticed on the next frame", () => {
    const data = sets.red!;
    const { game } = atChoice(data);
    game.tick(VOX_BTN.a); game.tick(0); // the log-only first step
    const state: any = (game as any).stack.at(-1);
    expect(state.kind).toBe("vccontinue");
    // what an uncatchable interrupt leaves behind: the step marked running
    state.running = 1;
    game.tick(0);
    expect(game.stackKinds()).not.toContain("vccontinue");
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(game.saveTarget).toBe("lua");
  });
});

describe("a cartridge save with junk in it", () => {
  test.skipIf(!has("yellow"))("converts with notes instead of failing", () => {
    const data = sets.yellow!;
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (let round = 0; round < 20; round++) {
      const b = new Uint8Array(L.SAVE_SIZE);
      for (let i = 0; i < b.length; i++) b[i] = rnd();
      b[L.MAIN_CHECKSUM] = checksum(b, L.PLAYER_NAME, L.MAIN_CHECKSUM);
      const { save } = cartToSave(b, data as never);
      expect(typeof save.player.map).toBe("string");
      expect(Array.isArray(save.party)).toBe(true);
      for (const m of save.party) expect(m.level >= 1 && m.level <= 100 && m.hp <= m.stats.hp).toBe(true);
    }
  });
});

/** The cartridge's own checksum rules, computed here independently of
 *  cartsave.ts: each one the complement of the low byte of a plain sum. */
function cartChecksumsOk(b: Uint8Array): string[] {
  const bad: string[] = [];
  const sum = (from: number, to: number): number => {
    let s = 0;
    for (let i = from; i < to; i++) s += b[i]!;
    return ~s & 0xff;
  };
  // bank 1: sPlayerName ($2598) up to the checksum byte ($3523)
  if (sum(0x2598, 0x3523) !== b[0x3523]) bad.push("main");
  // banks 2 and 3: six boxes each, the whole bank's sum, then one per box
  for (const bank of [0x4000, 0x6000]) {
    if (sum(bank, bank + 0x1a4c) !== b[bank + 0x1a4c]) bad.push(`bank ${bank.toString(16)}`);
    for (let n = 0; n < 6; n++) {
      const o = bank + n * 0x462;
      if (sum(o, o + 0x462) !== b[bank + 0x1a4d + n]) bad.push(`box ${bank.toString(16)}:${n}`);
    }
  }
  return bad;
}

/** A new game as NEW GAME leaves it: the bedroom, the names given, nothing
 *  yet (before Oak). `starter`: a few minutes on, the first mon in hand and
 *  standing on Route 1. */
function earlySave(data: VoxelmonData, v: V, starter: boolean): any {
  const game = new VoxelmonGame(data, new RecorderHost(), 1);
  game.newGame();
  const s: any = JSON.parse(JSON.stringify(game.save));
  s.player.name = "RED";
  s.player.rival = "BLUE";
  s.player.id = 0x4d2;
  if (!starter) return s;
  const species = v === "yellow" ? "PIKACHU" : "SQUIRTLE";
  s.party = [{
    species, level: 5, exp: 135, hp: 20, catchRate: v === "yellow" ? 163 : 45, status: null,
    dvs: { attack: 9, defense: 8, speed: 7, special: 6, hp: 0b1010 },
    statExp: { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 },
    stats: { hp: 20, attack: 11, defense: 10, speed: 13, special: 11 },
    moves: [{ id: v === "yellow" ? "THUNDERSHOCK" : "TACKLE", pp: 30 }, { id: "GROWL", pp: 40 }],
  }];
  s.pokedex = { owned: { [species]: true }, seen: { [species]: true } };
  s.flags = { ...s.flags, EVENT_FOLLOWED_OAK_INTO_LAB: true, EVENT_OAK_ASKED_TO_CHOOSE_MON: true, EVENT_GOT_STARTER: true, EVENT_BATTLED_RIVAL_IN_OAKS_LAB: true };
  if (v !== "yellow") s.flags.EVENT_CHOSE_SQUIRTLE = true;
  if (v === "yellow") { s.pikachuHappiness = 90; s.pikachuMood = 80; }
  s.player.map = "ROUTE_1"; s.player.x = 9; s.player.y = 30; s.player.facing = "up";
  s.lastOutdoor = { id: "ROUTE_1", x: 9, y: 30 };
  s.visited = { PALLET_TOWN: true };
  s.playTime = 7 * 60 + 12;
  return s;
}

for (const v of Object.keys(dirs) as V[]) {
  describe(`${v}: an early new game saved straight to the VC title`, () => {
    for (const starter of [false, true]) {
      const what = starter ? "with the first mon, on Route 1" : "in the bedroom, before Oak";
      test.skipIf(!has(v))(`${what}: a valid cartridge save that reads back`, () => {
        const data = sets[v]!;
        const src = earlySave(data, v, starter);
        const w = saveToCart(src, data as never, null);
        expect(w.notes).toEqual([]);
        const b = w.bytes;
        expect(isCartSave(b)).toBe(true);
        expect(cartChecksumsOk(b)).toEqual([]);
        const m = (k: number): number => b[L.MAIN + k]!;
        // the lists the cartridge walks: a count, then $FF after the last
        const party = starter ? 1 : 0;
        expect(b[L.PARTY]).toBe(party);
        expect(b[L.PARTY + 1 + party]).toBe(0xff);
        expect(m(M.numBagItems)).toBe(0);
        expect(b[L.MAIN + M.bagItems]).toBe(0xff);
        expect(m(M.numPcItems)).toBe(1);
        expect(b[L.MAIN + M.pcItems + 2]).toBe(0xff);
        expect(b[L.CUR_BOX]).toBe(0);
        expect(b[L.CUR_BOX + 1]).toBe(0xff);
        for (const bank of L.BOX_BANKS) for (let n = 0; n < 6; n++) {
          expect(b[bank + n * L.BOX_SIZE]).toBe(0);
          expect(b[bank + n * L.BOX_SIZE + 1]).toBe(0xff);
        }
        expect(m(M.numHofTeams)).toBe(0);
        // the map's engine state is the ROM's for the spot it is on
        const map = starter ? "ROUTE_1" : "REDS_HOUSE_2F";
        const hdr = Buffer.from(b.subarray(L.MAIN + M.mapHeader, L.MAIN + M.mapHeader + 10)).toString("hex");
        expect(hdr).toBe(data.vcsave!.maps[map]!.h);
        // and it reads back as the game it was
        const { save: back, notes } = cartToSave(b, data as never);
        expect(notes).toEqual([]);
        expect(back.player).toMatchObject({ name: "RED", rival: "BLUE", id: 0x4d2, map, x: src.player.x, y: src.player.y });
        expect(back.party.length).toBe(party);
        expect(back.pcItems).toEqual({ POTION: 1 });
        expect(back.hallOfFame ?? []).toEqual([]);
        if (starter) {
          expect(back.party[0]).toMatchObject({ species: src.party[0].species, level: 5, hp: 20 });
          expect(back.flags).toMatchObject({ EVENT_GOT_STARTER: true, EVENT_BATTLED_RIVAL_IN_OAKS_LAB: true });
          if (v === "yellow") expect(back).toMatchObject({ pikachuHappiness: 90, pikachuMood: 80 });
          else expect(back.flags.EVENT_CHOSE_SQUIRTLE).toBe(true);
        }
        // and a second save over the first is byte for byte the same
        const again = saveToCart(decodeSave(encodeSave(back)), data as never, b).bytes;
        const diffs: string[] = [];
        for (let i = 0; i < L.SAVE_SIZE; i++) if (again[i] !== b[i]) diffs.push(`${i.toString(16)}:${b[i]}>${again[i]}`);
        expect(diffs.slice(0, 20)).toEqual([]);
      });
    }
  });
}

/** Wait for a YES/NO and answer it: the confirm opens on NO. */
function answer(game: VoxelmonGame, yes: boolean): boolean {
  for (let i = 0; i < 400; i++) {
    if (game.stackKinds().at(-1) === "choice") {
      game.tick(0);
      if (yes) { game.tick(VOX_BTN.up); game.tick(0); }
      game.tick(VOX_BTN.a); game.tick(0);
      for (let k = 0; k < 20; k++) game.tick(0);
      return true;
    }
    game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
  }
  return false;
}

describe("NEW GAME's choice of where it saves", () => {
  /** The title's NEW GAME picked (it follows CONTINUE when there is a save). */
  function newGameAt(host: VcConsole, data: VoxelmonData): VoxelmonGame {
    const game = new VoxelmonGame(data, host, 1);
    game.newGame();
    const t = toTitleMenu(game);
    const i = t.menu.indexOf("NEW GAME");
    for (let k = 0; k < i; k++) { game.tick(VOX_BTN.down); game.tick(0); }
    game.tick(VOX_BTN.a); game.tick(0);
    return game;
  }

  test.skipIf(!has("red"))("no VC title: no question, and SAVE writes the Lua file", () => {
    const data = sets.red!;
    const host = new VcConsole(encodeSave(richSave(data, "red")), undefined);
    const game = newGameAt(host, data);
    expect(game.stackKinds()).not.toContain("title");
    expect(game.saveTarget).toBe("lua");
    game.writeSave();
    expect(host.luaWrites.length).toBe(1);
    expect(host.vcWrites).toEqual([]);
  });

  test.skipIf(!has("red"))("LUA SAVE, first and the default: the Lua file, as today", () => {
    const data = sets.red!;
    const host = new VcConsole(encodeSave(richSave(data, "red")), saveToCart(richSave(data, "red"), data as never, null).bytes);
    const game = newGameAt(host, data);
    const t = (game as any).title();
    expect(t.phase).toBe("pick");
    expect(t.menu).toEqual(["LUA SAVE", "VC SAVE"]);
    expect(t.index).toBe(0);
    expect(t.panel).toBeUndefined();
    game.tick(VOX_BTN.a); game.tick(0);
    expect(game.stackKinds()).not.toContain("title");
    expect(game.saveTarget).toBe("lua");
    game.writeSave();
    expect(host.luaWrites.length).toBe(1);
    expect(host.vcWrites).toEqual([]);
  });

  test.skipIf(!has("red"))("VC SAVE over a VC game: asked first; NO is the choice again, YES saves there", () => {
    const data = sets.red!;
    const old = saveToCart(richSave(data, "red"), data as never, null).bytes;
    const host = new VcConsole(undefined, old);
    const game = newGameAt(host, data);
    game.tick(VOX_BTN.down); game.tick(0);
    game.tick(VOX_BTN.a); game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(answer(game, false)).toBe(true);
    expect(game.stackKinds().at(-1)).toBe("title");
    expect((game as any).title().phase).toBe("pick");
    expect(game.saveTarget).toBe("lua");
    expect(host.vcWrites).toEqual([]);
    game.tick(VOX_BTN.a); game.tick(0);
    expect(answer(game, true)).toBe(true);
    expect(game.stackKinds()).not.toContain("title");
    expect(game.saveTarget).toBe("vc");
    game.save.player.name = "NEWKID";
    game.writeSave();
    expect(host.luaWrites).toEqual([]);
    expect(host.vcWrites.length).toBe(1);
    const b = host.vcWrites[0]!;
    expect(isCartSave(b)).toBe(true);
    expect(cartChecksumsOk(b)).toEqual([]);
    // a whole new cartridge save: nothing of the game it replaced
    const { save } = cartToSave(b, data as never);
    expect(save.player.name).toBe("NEWKID");
    expect(save.party).toEqual([]);
    expect(save.hallOfFame ?? []).toEqual([]);
    expect(save.boxes.every((x: unknown[]) => x.length === 0)).toBe(true);
    expect(save.money).toBe(3000);
    // the next save is over this one, and still the new game
    game.save.money = 2500;
    game.writeSave();
    expect(host.vcWrites.length).toBe(2);
    const next = cartToSave(host.vcWrites[1]!, data as never).save;
    expect(next.money).toBe(2500);
    expect(next.hallOfFame ?? []).toEqual([]);
  });

  test.skipIf(!has("red"))("VC SAVE on an empty VC save: no question", () => {
    const data = sets.red!;
    const host = new VcConsole(encodeSave(richSave(data, "red")), new Uint8Array(L.SAVE_SIZE).fill(0xff));
    const game = newGameAt(host, data);
    expect((game as any).title().menu).toEqual(["LUA SAVE", "VC SAVE"]);
    game.tick(VOX_BTN.down); game.tick(0);
    game.tick(VOX_BTN.a); game.tick(0);
    expect(game.stackKinds()).not.toContain("title");
    expect(game.saveTarget).toBe("vc");
    game.writeSave();
    expect(host.vcWrites.length).toBe(1);
    expect(cartChecksumsOk(host.vcWrites[0]!)).toEqual([]);
  });

  test.skipIf(!has("red"))("B leaves the choice for the menu", () => {
    const data = sets.red!;
    const host = new VcConsole(undefined, saveToCart(richSave(data, "red"), data as never, null).bytes);
    const game = newGameAt(host, data);
    game.tick(VOX_BTN.b); game.tick(0);
    expect((game as any).title().phase).toBe("menu");
  });
});

/** A save partway through the opening, as this game holds it. */
function openingSave(data: VoxelmonData, v: V, stage: "start" | "choosing" | "starter" | "battled" | "parcel" | "delivered" | "lesson"): any {
  const s = earlySave(data, v, stage !== "start" && stage !== "choosing");
  s.flags = {};
  const f = s.flags;
  const at = (k: string[]): void => { for (const n of k) f[n] = true; };
  if (stage !== "start") at(["EVENT_OAK_APPEARED_IN_PALLET", "EVENT_FOLLOWED_OAK_INTO_LAB", "EVENT_FOLLOWED_OAK_INTO_LAB_2", "EVENT_OAK_ASKED_TO_CHOOSE_MON"]);
  if (["starter", "battled", "parcel", "delivered", "lesson"].includes(stage)) at(["EVENT_GOT_STARTER"]);
  if (["battled", "parcel", "delivered", "lesson"].includes(stage)) at(["EVENT_BATTLED_RIVAL_IN_OAKS_LAB"]);
  if (["parcel", "delivered", "lesson"].includes(stage)) at(["EVENT_GOT_OAKS_PARCEL"]);
  if (["delivered", "lesson"].includes(stage)) at(["EVENT_OAK_GOT_PARCEL", "EVENT_GOT_POKEDEX"]);
  if (stage === "lesson") at(["EVENT_COMPLETED_CATCH_TRAINING"]);
  s.inventory = stage === "parcel" ? { OAKS_PARCEL: 1 } : {};
  s.bagOrder = Object.keys(s.inventory);
  return s;
}

const progress = (b: Uint8Array, at: number): number => b[L.MAIN + M.progress + at]!;

for (const v of Object.keys(dirs) as V[]) {
  describe(`${v}: scene steps the cartridge keeps per map`, () => {
    const y = v === "yellow";
    // [stage, the lab, the first town, the shop, the second town]
    const expected: [Parameters<typeof openingSave>[2], number, number, number, number][] = [
      ["start", 0, 0, 0, 0],
      ["choosing", 6, y ? 8 : 5, 0, 0],
      ["starter", y ? 12 : 10, y ? 8 : 5, 0, 0],
      ["battled", y ? 22 : 18, y ? 8 : 5, 0, 0],
      ["parcel", y ? 22 : 18, y ? 8 : 5, 2, 0],
      ["delivered", y ? 22 : 18, y ? 8 : 5, 2, y ? 1 : 0],
      ["lesson", y ? 22 : 18, y ? 8 : 5, 2, y ? 2 : 0],
    ];
    for (const [stage, lab, town, shop, city] of expected) {
      test.skipIf(!has(v))(`${stage}: written from the flags, over any step the replaced save had`, () => {
        const data = sets[v]!;
        const s = openingSave(data, v, stage);
        // over a save whose steps are all wrong, and over none at all
        const junk = saveToCart(richSave(data, v), data as never, null).bytes;
        for (const at of [0, 1, 4, 29]) junk[L.MAIN + M.progress + at] = 0x0b;
        for (const tmpl of [junk, null]) {
          const b = saveToCart(s, data as never, tmpl).bytes;
          expect([progress(b, 0), progress(b, 1), progress(b, 29), progress(b, 4)]).toEqual([lab, town, shop, city]);
          expect(cartChecksumsOk(b)).toEqual([]);
        }
      });
    }

    test.skipIf(!has(v))("the parcel errand: done in this game, then saved over a VC save from before it", () => {
      const data = sets[v]!;
      // the VC save from before: the shop still waiting to call the player over
      const before = saveToCart(openingSave(data, v, "battled"), data as never, null).bytes;
      expect(progress(before, 29)).toBe(0);
      const after = openingSave(data, v, "parcel");
      after.player.map = "VIRIDIAN_MART"; after.player.x = 3; after.player.y = 6;
      const b = saveToCart(after, data as never, before).bytes;
      // the shop's idle step: the clerk does not call the player over again
      expect(progress(b, 29)).toBe(2);
      // and one parcel, however many this game had
      after.inventory.OAKS_PARCEL = 2;
      const twice = saveToCart(after, data as never, before).bytes;
      const back = cartToSave(twice, data as never).save;
      expect(back.inventory.OAKS_PARCEL).toBe(1);
    });
  });
}

describe("key items never stack", () => {
  test.skipIf(!has("yellow"))("read as one and written as one; counted items keep their counts", () => {
    const data = sets.yellow!;
    const s = openingSave(data, "yellow", "parcel");
    s.inventory = { OAKS_PARCEL: 2, POKE_FLUTE: 3, SILPH_SCOPE: 1, POTION: 7, SAFARI_BALL: 30 };
    s.bagOrder = Object.keys(s.inventory);
    const b = saveToCart(s, data as never, null).bytes;
    const count = (id: string): number => {
      const code = (data as any).items[id].index;
      for (let i = 0; i < b[L.MAIN + M.numBagItems]!; i++) {
        if (b[L.MAIN + M.bagItems + i * 2] === code) return b[L.MAIN + M.bagItems + i * 2 + 1]!;
      }
      return 0;
    };
    expect([count("OAKS_PARCEL"), count("POKE_FLUTE"), count("SILPH_SCOPE"), count("POTION"), count("SAFARI_BALL")]).toEqual([1, 1, 1, 7, 30]);
    // a VC save the bug already doubled: the parcel twice, comes back once
    const doubled = new Uint8Array(b);
    doubled[L.MAIN + M.bagItems + 1] = 2; // the first slot is the parcel
    doubled[L.MAIN_CHECKSUM] = checksum(doubled, L.PLAYER_NAME, L.MAIN_CHECKSUM);
    const back = cartToSave(doubled, data as never).save;
    expect(back.inventory).toMatchObject({ OAKS_PARCEL: 1, POKE_FLUTE: 1, SILPH_SCOPE: 1, POTION: 7, SAFARI_BALL: 30 });
  });
});

describe("the parcel errand, VC save into this game", () => {
  /** Hold a direction until the player has moved (or the map changed). */
  function walk(game: VoxelmonGame, btn: number): void {
    const ow: any = game.overworld;
    const where = (): string => `${mapOf(game)},${ow.player?.cellX},${ow.player?.cellY}`;
    const from = where();
    for (let i = 0; i < 240; i++) {
      game.tick(btn);
      if (where() !== from && game.stackKinds().at(-1) === "overworld") break;
    }
    for (let i = 0; i < 90; i++) game.tick(0);
  }

  const mapOf = (game: VoxelmonGame): string => {
    const ow: any = game.overworld;
    return ow.mapId ?? ow.map?.id;
  };
  for (const v of ["red", "yellow"] as V[]) {
    test.skipIf(!has(v))(`${v}: continued in the shop after the errand, out the door and back in: no second parcel`, () => {
      const data = sets[v]!;
      const s = openingSave(data, v, "parcel");
      s.player.map = "VIRIDIAN_MART"; s.player.x = 3; s.player.y = 6;
      s.lastOutdoor = { id: "VIRIDIAN_CITY", x: 29, y: 20 };
      s.inventory = { OAKS_PARCEL: 1 };
      const cart = saveToCart(s, data as never, null).bytes;
      const host = new VcConsole(undefined, cart);
      const game = new VoxelmonGame(data, host, 1);
      game.newGame();
      // (Yellow's title drops its logo in before it takes a button)
      for (let i = 0; i < 400 && (game as any).title()?.phase !== "menu"; i++) game.tick(i % 2 ? VOX_BTN.start : 0);
      game.tick(0);
      game.tick(VOX_BTN.a); game.tick(0); // CONTINUE: the choice (VC SAVE alone)
      game.tick(VOX_BTN.a); game.tick(0);
      for (let i = 0; i < 6; i++) game.tick(0);
      expect(game.stackKinds().at(-1)).toBe("overworld");
      const ow: any = game.overworld;
      expect(mapOf(game)).toBe("VIRIDIAN_MART");
      walk(game, VOX_BTN.down); // onto the mat
      walk(game, VOX_BTN.down); // out of the door
      expect(mapOf(game)).toBe("VIRIDIAN_CITY");
      walk(game, VOX_BTN.up); // (turn)
      walk(game, VOX_BTN.up); // back in
      expect(mapOf(game)).toBe("VIRIDIAN_MART");
      for (let i = 0; i < 120; i++) game.tick(0);
      expect(game.stackKinds().at(-1)).toBe("overworld");
      expect(game.save.inventory.OAKS_PARCEL).toBe(1);
      // and saved back to the VC title: the shop at its idle step
      game.writeSave();
      expect(progress(host.vcWrites.at(-1)!, 29)).toBe(2);
    });
  }
});

describe("the ship's rival, which the cartridge records by its step alone", () => {
  for (const v of ["red", "yellow"] as V[]) {
    test.skipIf(!has(v))(`${v}: beaten here -> the deck's idle step; the idle step read back -> beaten`, () => {
      const data = sets[v]!;
      const s = openingSave(data, v, "lesson");
      s.player.map = "SS_ANNE_2F"; s.player.x = 36; s.player.y = 10;
      const before = saveToCart(s, data as never, null).bytes;
      expect(progress(before, 117)).toBe(0);
      expect(cartToSave(before, data as never).save.flags.EVENT_BEAT_SS_ANNE_RIVAL).toBeUndefined();
      s.flags.EVENT_BEAT_SS_ANNE_RIVAL = true;
      const after = saveToCart(s, data as never, before).bytes;
      expect(progress(after, 117)).toBe(4);
      expect(cartToSave(after, data as never).save.flags.EVENT_BEAT_SS_ANNE_RIVAL).toBe(true);
    });
  }
});
