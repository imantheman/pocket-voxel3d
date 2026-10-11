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
    game.writeSave();
    expect(game.lastSaveOk).toBe(false);
    expect(host.luaWrites).toEqual([]);
    expect(game.stackKinds().at(-1)).toBe("textbox");
  });
});
