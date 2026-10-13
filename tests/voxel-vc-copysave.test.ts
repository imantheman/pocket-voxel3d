// COPY SAVE (voxelmon/game/vc/copysave.ts): the title's transfer between
// the Lua save and the VC title's cartridge save, both ways, driven through
// the title as a player would. Needs the same data as voxel-vcsave.test.ts
// (dist/voxelmon/{,blue/,yellow/}gen with vcsave.json); real cartridge
// saves come from VC_REAL_SAVES and VC_ROM_SAVES when they are set (folders
// of .sav files named *yellow* / *blue* / else Red; never committed).

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
import { cartSummary, cartToSave, isCartSave, saveToCart } from "../voxelmon/game/vc/cartsave.ts";
import { COPY_SAVE_TEXT, copyMessage, copyPanel, panelLines, PANEL_INFO_COLS, wrapWhy } from "../voxelmon/game/vc/copysave.ts";

const root = join(import.meta.dir, "..");
const dirs = { red: "dist/voxelmon/gen", blue: "dist/voxelmon/blue/gen", yellow: "dist/voxelmon/yellow/gen" } as const;
type V = keyof typeof dirs;
const sets: Partial<Record<V, VoxelmonData>> = {};
for (const v of Object.keys(dirs) as V[]) {
  const d = join(root, dirs[v]);
  if (existsSync(join(d, "pokemon.json")) && existsSync(join(d, "vcsave.json"))) {
    sets[v] = await loadRuntimeData(d);
    (sets[v] as { version?: string }).version ??= v;
  }
}
const has = (v: V): boolean => !!sets[v]?.vcsave;
const T = COPY_SAVE_TEXT;

/** A Lua save with something in every field the converter maps. */
function richSave(data: VoxelmonData, v: V, name = "ASH"): any {
  const game = new VoxelmonGame(data, new RecorderHost(), 1);
  game.newGame();
  const s: any = JSON.parse(JSON.stringify(game.save));
  const yellow = v === "yellow";
  s.player = { ...s.player, name, rival: "GARY", id: 0x1234, map: "VIRIDIAN_CITY", x: 23, y: 26, facing: "down" };
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
  // this game's own settings beside the cartridge's three
  s.options = { textSpeed: 1, animations: false, battleStyle: "set", camera: "far", tiltShift: 2, movement: "free" };
  s.playTime = 3 * 3600 + 25 * 60 + 9;
  s.visited = { PALLET_TOWN: true, VIRIDIAN_CITY: true, PEWTER_CITY: true };
  s.lastOutdoor = { id: "VIRIDIAN_CITY", x: 23, y: 26 };
  s.daycare = { mon: mon("ODDISH", 10), steps: 250, depositLevel: 10 };
  s.hallOfFame = [[{ species: "PIDGEY", level: 50, nickname: "WINGS" }, { species: "ABRA", level: 48 }]];
  if (yellow) { s.pikachuHappiness = 140; s.pikachuMood = 120; s.rivalStarter = 2; }
  return s;
}

function cartChecksumsOk(b: Uint8Array): string[] {
  const bad: string[] = [];
  const sum = (from: number, to: number): number => {
    let s = 0;
    for (let i = from; i < to; i++) s += b[i]!;
    return ~s & 0xff;
  };
  if (sum(0x2598, 0x3523) !== b[0x3523]) bad.push("main");
  for (const bank of [0x4000, 0x6000]) {
    if (sum(bank, bank + 0x1a4c) !== b[bank + 0x1a4c]) bad.push(`bank ${bank.toString(16)}`);
    for (let n = 0; n < 6; n++) {
      const o = bank + n * 0x462;
      if (sum(o, o + 0x462) !== b[bank + 0x1a4d + n]) bad.push(`box ${bank.toString(16)}:${n}`);
    }
  }
  return bad;
}

/** A console with a VC title: both saves in memory, every write and copy recorded. */
class VcConsole extends RecorderHost {
  lua: string | undefined;
  vc: Uint8Array | undefined;
  luaWrites: string[] = [];
  vcWrites: Uint8Array[] = [];
  copies: string[] = [];
  constructor(lua: string | undefined, vc: Uint8Array | undefined) {
    super();
    this.lua = lua;
    this.vc = vc;
  }
  saveData(): string | undefined { return this.lua; }
  saveWrite(text: string): boolean { this.luaWrites.push(text); this.lua = text; return true; }
  saveKeepCopy(): boolean { if (this.lua) this.copies.push(this.lua); return true; }
  vcData(): Uint8Array | undefined { return this.vc ? new Uint8Array(this.vc) : undefined; }
  vcWrite(b: Uint8Array): boolean { this.vcWrites.push(new Uint8Array(b)); this.vc = new Uint8Array(b); return true; }
}

function boot(data: VoxelmonData, host: VcConsole): VoxelmonGame {
  const game = new VoxelmonGame(data, host, 1);
  game.newGame();
  // (Yellow's logo drops first; the menu waits for it)
  for (let k = 0; k < 400 && (game as any).title()?.phase !== "menu"; k++) game.tick(k % 8 === 0 ? VOX_BTN.start : 0);
  game.tick(0);
  return game;
}
const title = (game: VoxelmonGame): any => (game as any).title();
const top = (game: VoxelmonGame): string | undefined => game.stackKinds().at(-1);
/** The text of the text box on top, pages joined by \f. */
const boxText = (game: VoxelmonGame): string =>
  ((game as any).stack.at(-1).box.pages as { lines: string[] }[]).map((p) => p.lines.join("\n")).join("\f");

/** The title's cursor moved to entry `i` (never more than a lap). */
function moveTo(game: VoxelmonGame, i: number, btn: number = VOX_BTN.down): void {
  for (let k = 0; k < 12 && title(game)?.index !== i; k++) { game.tick(btn); game.tick(0); }
  expect(title(game)?.index).toBe(i);
}

/** From the main menu: COPY SAVE, then the choice's entries. */
function openCopy(game: VoxelmonGame): string[] {
  const t = title(game);
  expect(t?.phase).toBe("menu");
  const i = t.menu.indexOf(T.menu);
  expect(i).toBeGreaterThan(0);
  moveTo(game, i);
  game.tick(VOX_BTN.a); game.tick(0);
  const p = title(game);
  expect(p.phase).toBe("pick");
  return p.menu;
}

/** Type the question out until its YES/NO is up. */
function toChoice(game: VoxelmonGame): void {
  for (let i = 0; i < 400 && top(game) !== "choice"; i++) game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
  expect(top(game)).toBe("choice");
}

/** Press on until the title is back on top; the last text box's text. */
function toTitle(game: VoxelmonGame): string {
  let last = "";
  for (let i = 0; i < 2000 && top(game) !== "title"; i++) {
    if (top(game) === "textbox") last = boxText(game);
    game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
  }
  game.tick(0); // A let go, so the menu's next A is a press
  expect(top(game)).toBe("title");
  return last;
}

/**
 * COPY SAVE in one direction, answered YES (or NO): returns the panel the
 * confirm screen showed and the message at the end, with every log line.
 */
function copy(game: VoxelmonGame, dir: "lua-vc" | "vc-lua", yes = true): { panel: string[] | null; message: string; logs: string[] } {
  const menu = openCopy(game);
  const at = menu.indexOf(T.choices[dir]);
  expect(at).toBeGreaterThanOrEqual(0);
  moveTo(game, at);
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    game.tick(VOX_BTN.a); game.tick(0);
    const panel = game.savePanel();
    toChoice(game);
    game.tick(0);
    if (yes) { game.tick(VOX_BTN.up); game.tick(0); }
    game.tick(VOX_BTN.a); game.tick(0);
    const message = toTitle(game);
    return { panel, message, logs };
  } finally {
    console.log = log;
  }
}

/** Saves found in a folder, with the game each is for. */
function savesIn(dir: string | undefined): { file: string; v: V }[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sav")).map((f) => ({
    file: join(dir, f),
    v: (/yellow/i.test(f) ? "yellow" : /blue/i.test(f) ? "blue" : "red") as V,
  }));
}
const realSaves = [...savesIn(process.env.VC_REAL_SAVES), ...savesIn(process.env.VC_ROM_SAVES)]
  .map((s) => ({ ...s, bytes: new Uint8Array(readFileSync(s.file)) }))
  .filter((s) => isCartSave(s.bytes));

/** The fields the converter maps, as they should come back. */
function expectMapped(back: any, src: any): void {
  expect(back.player).toMatchObject({ name: src.player.name, rival: src.player.rival, id: src.player.id, map: src.player.map, x: src.player.x, y: src.player.y });
  expect(back.money).toBe(src.money);
  expect(back.coins).toBe(src.coins);
  expect(back.playTime).toBe(src.playTime);
  expect(back.options).toMatchObject({ textSpeed: src.options.textSpeed, animations: src.options.animations, battleStyle: src.options.battleStyle });
  expect(back.inventory).toEqual(src.inventory);
  expect(back.bagOrder).toEqual(src.bagOrder);
  expect(back.pcItems).toEqual(src.pcItems);
  expect(back.flags).toMatchObject(src.flags);
  // (the load repairs may add towns the save proves were reached)
  expect(back.visited).toMatchObject(src.visited);
  expect(Object.keys(back.pokedex.owned).sort()).toEqual(Object.keys(src.pokedex.owned).sort());
  expect(Object.keys(back.pokedex.seen).sort()).toEqual(Object.keys(src.pokedex.seen).sort());
  expect(back.party.length).toBe(src.party.length);
  for (let i = 0; i < src.party.length; i++) {
    const a = src.party[i], b = back.party[i];
    expect([b.species, b.level, b.exp, b.dvs, b.statExp, b.nickname ?? null]).toEqual([a.species, a.level, a.exp, a.dvs, a.statExp, a.nickname ?? null]);
    expect(b.moves.map((m: any) => m.id)).toEqual(a.moves.map((m: any) => m.id));
  }
  expect(back.boxes.map((b: any[]) => b.map((m) => m.species))).toEqual(src.boxes.map((b: any[]) => b.map((m) => m.species)));
  expect(back.currentBox).toBe(src.currentBox);
  expect(back.daycare?.mon?.species).toBe(src.daycare?.mon?.species);
  expect((back.hallOfFame ?? []).map((t: any[]) => t.map((m) => m.species))).toEqual((src.hallOfFame ?? []).map((t: any[]) => t.map((m: any) => m.species)));
  if (src.pikachuHappiness !== undefined) expect(back.pikachuHappiness).toBe(src.pikachuHappiness);
}

describe("COPY SAVE's strings", () => {
  test("every text box line fits 18 columns; the info boxes 17; the menu entries 9", () => {
    const lines: string[] = [];
    for (const d of ["lua-vc", "vc-lua"] as const) {
      lines.push(...T.ask[d].split("\n"));
      for (const st of ["read", "backup", "convert", "write"] as const) lines.push(...T.failed[st][d].split("\n"));
      lines.push(...T.kept[d].split("\n"));
      for (const s of [T.from[d], T.over[d], T.overEmpty[d]]) expect(s.length).toBeLessThanOrEqual(17);
      expect(T.choices[d].length).toBeLessThanOrEqual(9);
    }
    lines.push(T.working, T.done, ...T.kept.nothing.split("\n"));
    for (const l of lines) expect(`${l}: ${l.length <= 18}`).toBe(`${l}: true`);
    expect(T.menu.length).toBeLessThanOrEqual(9);
  });

  test("the confirm panel: the source's box, then the destination's (or empty)", () => {
    const a = { name: "ASH", badges: 2, owned: 2, seconds: 3 * 3600 + 25 * 60 };
    const b = { name: "YELLOWW", badges: 8, owned: 151, seconds: 999 * 3600 + 59 * 60 };
    expect(panelLines(a)).toEqual(["NAME     ASH", "BADGES     2", "POKéDEX    2", "TIME    3:25"]);
    expect(copyPanel("lua-vc", a, b)).toEqual(["COPY: LUA SAVE", ...panelLines(a), "REPLACE: VC SAVE", ...panelLines(b)]);
    expect(copyPanel("vc-lua", b, null)).toEqual(["COPY: VC SAVE", ...panelLines(b), "TO: LUA SAVE", "   (EMPTY)"]);
    // rows 7 down (lines 6 on) stay clear of the YES/NO window; all fit the panel
    for (const p of [copyPanel("lua-vc", a, b), copyPanel("vc-lua", b, null), copyPanel("lua-vc", { name: null, badges: null, owned: null, seconds: null }, b)]) {
      p.forEach((l, i) => expect(`${l}: ${l.length <= (i >= 6 ? PANEL_INFO_COLS : 17)}`).toBe(`${l}: true`));
    }
  });

  test("a failure says what, why, and what became of the destination", () => {
    expect(copyMessage("lua-vc", { ok: true })).toBe("Copied the save!");
    expect(copyMessage("lua-vc", { ok: false, stage: "read", why: "bad text" })).toBe("The LUA save could\nnot be read.\fbad text\fNothing was\ncopied.");
    expect(copyMessage("lua-vc", { ok: false, stage: "write", why: "commit failed" })).toBe("The VC save did\nnot take it.\fcommit failed\fThe VC save is\nleft as it was.");
    expect(copyMessage("vc-lua", { ok: false, stage: "write", why: "disk full", backedUp: true })).toBe("The LUA save could\nnot be written.\fdisk full\fA copy of the old\nLUA save is kept.");
    expect(copyMessage("vc-lua", { ok: false, stage: "write", why: "disk full" })).toEndWith("Nothing was\ncopied.");
    expect(wrapWhy("one two three four five six seven eight nine ten eleven twelve thirteen")).toEqual(["one two three four", "five six seven", "eight nine ten"]);
  });
});

describe("COPY SAVE on the title", () => {
  test.skipIf(!has("red"))("shown only with the VC title, and only with a save to copy", () => {
    const data = sets.red!;
    const lua = encodeSave(richSave(data, "red"));
    const vc = saveToCart(richSave(data, "red", "VCKID"), data as never, null).bytes;
    const empty = new Uint8Array(L.SAVE_SIZE).fill(0xff);
    expect(title(boot(data, new VcConsole(lua, vc))).menu).toEqual(["CONTINUE", "NEW GAME", "COPY SAVE", "OPTION", "MAP VIEWER"]);
    expect(title(boot(data, new VcConsole(lua, undefined))).menu).toEqual(["CONTINUE", "NEW GAME", "OPTION", "MAP VIEWER"]);
    expect(title(boot(data, new VcConsole(undefined, empty))).menu).toEqual(["NEW GAME", "OPTION", "MAP VIEWER"]);
    // a direction only where its source holds a game
    expect(openCopy(boot(data, new VcConsole(lua, vc)))).toEqual(["LUA TO VC", "VC TO LUA", "CANCEL"]);
    expect(openCopy(boot(data, new VcConsole(lua, empty)))).toEqual(["LUA TO VC", "CANCEL"]);
    expect(openCopy(boot(data, new VcConsole(undefined, vc)))).toEqual(["VC TO LUA", "CANCEL"]);
  });

  test.skipIf(!has("red"))("CANCEL and B go back to the menu; NO writes nothing", () => {
    const data = sets.red!;
    const host = new VcConsole(encodeSave(richSave(data, "red")), saveToCart(richSave(data, "red", "VCKID"), data as never, null).bytes);
    const game = boot(data, host);
    openCopy(game);
    game.tick(VOX_BTN.b); game.tick(0);
    expect(title(game).phase).toBe("menu");
    const menu = openCopy(game);
    moveTo(game, menu.indexOf("CANCEL"));
    game.tick(VOX_BTN.a); game.tick(0);
    expect(title(game).phase).toBe("menu");
    const r = copy(game, "lua-vc", false);
    expect(r.panel?.[0]).toBe("COPY: LUA SAVE");
    expect(host.vcWrites).toEqual([]);
    expect(host.luaWrites).toEqual([]);
    expect(host.copies).toEqual([]);
    expect(title(game).phase).toBe("menu");
    expect(title(game).menu[title(game).index]).toBe("COPY SAVE");
    expect(game.savePanel()).toBeNull();
  });
});

for (const v of Object.keys(dirs) as V[]) {
  describe(`${v}: COPY SAVE, LUA TO VC`, () => {
    test.skipIf(!has(v))("over a VC game: the confirm screen, a valid cartridge save, the title read afresh", () => {
      const data = sets[v]!;
      const src = richSave(data, v, "LUAKID");
      const old = realSaves.find((s) => s.v === v)?.bytes ?? saveToCart(richSave(data, v, "VCKID"), data as never, null).bytes;
      const oldSum = cartSummary(old)!;
      const host = new VcConsole(encodeSave(src), old);
      const game = boot(data, host);
      const r = copy(game, "lua-vc");
      expect(r.panel).toEqual([
        "COPY: LUA SAVE", ...panelLines({ name: "LUAKID", badges: 2, owned: 2, seconds: src.playTime }),
        "REPLACE: VC SAVE", ...panelLines(oldSum),
      ]);
      expect(r.message).toBe("Copied the save!");
      expect(host.vcWrites.length).toBe(1);
      expect(host.luaWrites).toEqual([]);
      expect(host.copies).toEqual([]);
      const b = host.vcWrites[0]!;
      expect(cartChecksumsOk(b)).toEqual([]);
      expectMapped(cartToSave(b, data as never).save, src);
      // the steps on pvlog
      const steps = r.logs.filter((l) => l.startsWith("[pv] vc: copy: "));
      expect(steps[0]).toContain("LUA TO VC: from LUAKID over");
      expect(steps.some((l) => l.includes("LUA TO VC: start"))).toBe(true);
      expect(steps.some((l) => l.includes("vc_backup"))).toBe(true);
      expect(steps.some((l) => l.includes("done:"))).toBe(true);
      // CONTINUE's boxes are the saves as they are now
      const ch = (game as any).saveChoices;
      expect(ch.vc.name).toBe("LUAKID");
      expect(ch.lua.name).toBe("LUAKID");
      expect(title(game).menu[title(game).index]).toBe("COPY SAVE");
      // and CONTINUE on the VC save now plays the Lua game
      moveTo(game, 0, VOX_BTN.up);
      game.tick(VOX_BTN.a); game.tick(0);
      game.tick(VOX_BTN.down); game.tick(0);
      game.tick(VOX_BTN.a); game.tick(0);
      for (let i = 0; i < 6; i++) game.tick(0);
      expect(game.saveTarget).toBe("vc");
      expect(game.save.player.name).toBe("LUAKID");
      expect(game.save.party.map((m: any) => m.species)).toEqual(src.party.map((m: any) => m.species));
    });

    test.skipIf(!has(v))("into an empty VC save: a fresh cartridge save", () => {
      const data = sets[v]!;
      const src = richSave(data, v, "LUAKID");
      const host = new VcConsole(encodeSave(src), new Uint8Array(L.SAVE_SIZE).fill(0xff));
      const game = boot(data, host);
      const r = copy(game, "lua-vc");
      expect(r.panel!.slice(5)).toEqual(["TO: VC SAVE", "   (EMPTY)"]);
      expect(r.message).toBe("Copied the save!");
      const b = host.vcWrites[0]!;
      expect(cartChecksumsOk(b)).toEqual([]);
      expect(r.logs.some((l) => l.includes("into a fresh cartridge save"))).toBe(true);
      expectMapped(cartToSave(b, data as never).save, src);
      // the menu now offers CONTINUE's choice of both
      expect((game as any).saveChoices.vc.name).toBe("LUAKID");
    });
  });

  describe(`${v}: COPY SAVE, VC TO LUA`, () => {
    test.skipIf(!has(v))("over a Lua save: backed up first, this game's options kept, and it continues", () => {
      const data = sets[v]!;
      const oldLua = richSave(data, v, "LUAKID");
      const oldText = encodeSave(oldLua);
      const vcSrc = richSave(data, v, "VCKID");
      vcSrc.player.map = "PEWTER_CITY"; vcSrc.player.x = 18; vcSrc.player.y = 26;
      vcSrc.money = 777;
      const vc = saveToCart(vcSrc, data as never, null).bytes;
      const host = new VcConsole(oldText, vc);
      const game = boot(data, host);
      const r = copy(game, "vc-lua");
      expect(r.panel![0]).toBe("COPY: VC SAVE");
      expect(r.panel![1]).toBe(panelLines(cartSummary(vc)!)[0]);
      expect(r.panel![5]).toBe("REPLACE: LUA SAVE");
      expect(r.message).toBe("Copied the save!");
      expect(host.vcWrites).toEqual([]);
      expect(host.copies).toEqual([oldText]);
      expect(host.luaWrites.length).toBe(1);
      const back: any = decodeSave(host.luaWrites[0]!);
      expect(back.player).toMatchObject({ name: "VCKID", map: "PEWTER_CITY", x: 18, y: 26 });
      expect(back.money).toBe(777);
      // the cartridge has no room for these: they stay the Lua save's
      expect(back.options).toMatchObject({ camera: "far", tiltShift: 2, movement: "free" });
      const steps = r.logs.filter((l) => l.startsWith("[pv] vc: copy: "));
      expect(steps.findIndex((l) => l.includes("backed up"))).toBeLessThan(steps.findIndex((l) => l.includes("writing the LUA save")));
      expect((game as any).saveChoices.lua.name).toBe("VCKID");
      // CONTINUE (the Lua save, first) walks into the VC game's spot
      moveTo(game, 0, VOX_BTN.up);
      game.tick(VOX_BTN.a); game.tick(0);
      game.tick(VOX_BTN.a); game.tick(0);
      for (let i = 0; i < 6; i++) game.tick(0);
      expect(game.saveTarget).toBe("lua");
      const ow: any = (game as any).overworld;
      expect([ow.mapId ?? ow.map?.id, ow.player.cellX, ow.player.cellY]).toEqual(["PEWTER_CITY", 18, 26]);
    });

    test.skipIf(!has(v))("with no Lua save: nothing to back up, a Lua save made", () => {
      const data = sets[v]!;
      const vc = saveToCart(richSave(data, v, "VCKID"), data as never, null).bytes;
      const host = new VcConsole(undefined, vc);
      const game = boot(data, host);
      const r = copy(game, "vc-lua");
      expect(r.panel!.slice(5)).toEqual(["TO: LUA SAVE", "   (EMPTY)"]);
      expect(r.message).toBe("Copied the save!");
      expect(host.copies).toEqual([]);
      expect(r.logs.some((l) => l.includes("no LUA save to back up"))).toBe(true);
      expect((decodeSave(host.luaWrites[0]!) as any).player.name).toBe("VCKID");
      // CONTINUE now there, with both
      expect(title(game).menu[0]).toBe("CONTINUE");
    });

    test.skipIf(!has(v))("Lua -> VC -> Lua through the title keeps every mapped field", () => {
      const data = sets[v]!;
      for (const start of [new Uint8Array(L.SAVE_SIZE).fill(0xff), saveToCart(richSave(data, v, "OLDVC"), data as never, null).bytes]) {
        const src = richSave(data, v, "LUAKID");
        const host = new VcConsole(encodeSave(src), start);
        const game = boot(data, host);
        expect(copy(game, "lua-vc").message).toBe("Copied the save!");
        expect(copy(game, "vc-lua").message).toBe("Copied the save!");
        const back: any = decodeSave(host.luaWrites.at(-1)!);
        expectMapped(back, src);
        expect(back.options).toMatchObject({ camera: "far", tiltShift: 2, movement: "free" });
      }
    });
  });
}

describe("COPY SAVE with real cartridge saves", () => {
  test.skipIf(realSaves.length === 0)("VC -> Lua -> VC writes what the converter writes, byte for byte", () => {
    for (const { file, v, bytes } of realSaves) {
      const data = sets[v];
      if (!data?.vcsave) continue;
      const host = new VcConsole(encodeSave(richSave(data, v)), bytes);
      const game = boot(data, host);
      expect(`${file}: ${copy(game, "vc-lua").message}`).toBe(`${file}: Copied the save!`);
      expect(`${file}: ${copy(game, "lua-vc").message}`).toBe(`${file}: Copied the save!`);
      const again = host.vcWrites.at(-1)!;
      // (a box bank the cartridge never wrote has no checksum of its own:
      // it comes back exactly as the cartridge left it)
      expect(`${file}: ${cartChecksumsOk(again).join(",")}`).toBe(`${file}: ${cartChecksumsOk(bytes).join(",")}`);
      // the converter's own round trip: the same bytes for a save from the
      // VC title, and for one the ROM wrote early on only the scene steps
      // it writes from the flags (SCENE_STEPS) differ
      const plain = saveToCart(decodeSave(encodeSave(cartToSave(bytes, data as never).save)) as never, data as never, bytes).bytes;
      expect(`${file}: ${Buffer.from(again).equals(Buffer.from(plain))}`).toBe(`${file}: true`);
      if (process.env.VC_REAL_SAVES && file.startsWith(process.env.VC_REAL_SAVES)) {
        expect(`${file}: ${Buffer.from(again).equals(Buffer.from(bytes.subarray(0, L.SAVE_SIZE)))}`).toBe(`${file}: true`);
      }
    }
  });
});

describe("COPY SAVE that goes wrong writes nothing", () => {
  const data = sets.red;
  const vcOf = (name: string): Uint8Array => saveToCart(richSave(data!, "red", name), data as never, null).bytes;

  test.skipIf(!has("red"))("an unreadable Lua save: said so, the VC save untouched", () => {
    const host = new VcConsole("this is not a save {{{", vcOf("VCKID"));
    const game = boot(data!, host);
    const r = copy(game, "lua-vc");
    expect(r.message.startsWith("The LUA save could\nnot be read.")).toBe(true);
    expect(r.message.endsWith("Nothing was\ncopied.")).toBe(true);
    expect(host.vcWrites).toEqual([]);
    expect(r.logs.some((l) => l.startsWith("[pv] vc: copy: FAILED at read"))).toBe(true);
    expect((game as any).saveChoices.vc.name).toBe("VCKID");
  });

  test.skipIf(!has("red"))("a VC write the host refuses: said so, the title's VC box as it was", () => {
    class Refuses extends VcConsole { vcWrite(): boolean { return false; } vcErr(): string { return "commit failed"; } }
    const host = new Refuses(encodeSave(richSave(data!, "red", "LUAKID")), vcOf("VCKID"));
    const game = boot(data!, host);
    const r = copy(game, "lua-vc");
    expect(r.message).toBe("The VC save did\nnot take it.\fcommit failed\fThe VC save is\nleft as it was.");
    expect((game as any).saveChoices.vc.name).toBe("VCKID");
  });

  test.skipIf(!has("red"))("a Lua backup that fails: the Lua save is not written", () => {
    class NoCopy extends VcConsole { saveKeepCopy(): boolean { return false; } writeErr(): string { return "card full"; } }
    const host = new NoCopy(encodeSave(richSave(data!, "red", "LUAKID")), vcOf("VCKID"));
    const game = boot(data!, host);
    const r = copy(game, "vc-lua");
    expect(r.message).toBe("The LUA save could\nnot be backed up.\fcard full\fNothing was\ncopied.");
    expect(host.luaWrites).toEqual([]);
    expect((game as any).saveChoices.lua.name).toBe("LUAKID");
  });

  test.skipIf(!has("red"))("a host with no way to keep a copy does not write over the Lua save", () => {
    const host = new VcConsole(encodeSave(richSave(data!, "red", "LUAKID")), vcOf("VCKID"));
    (host as any).saveKeepCopy = undefined;
    const game = boot(data!, host);
    const r = copy(game, "vc-lua");
    expect(r.message.startsWith("The LUA save could\nnot be backed up.")).toBe(true);
    expect(host.luaWrites).toEqual([]);
  });

  test.skipIf(!has("red"))("a Lua write the card refuses: said so, the copy of the old one named", () => {
    class Full extends VcConsole { saveWrite(): boolean { return false; } writeErr(): string { return "no space"; } }
    const host = new Full(encodeSave(richSave(data!, "red", "LUAKID")), vcOf("VCKID"));
    const game = boot(data!, host);
    const r = copy(game, "vc-lua");
    expect(r.message).toBe("The LUA save could\nnot be written.\fno space\fA copy of the old\nLUA save is kept.");
    expect(host.copies.length).toBe(1);
  });

  test.skipIf(!has("red"))("a conversion that throws: said so, nothing written", () => {
    const host = new VcConsole(encodeSave(richSave(data!, "red", "LUAKID")), vcOf("VCKID"));
    const game = boot(data!, host);
    const io = (game as any).copyIo.bind(game);
    (game as any).copyIo = () => ({ ...io(), toCart: () => { throw new Error("bad table"); } });
    const r = copy(game, "lua-vc");
    expect(r.message).toBe("The save could not\nbe converted.\fbad table\fNothing was\ncopied.");
    expect(host.vcWrites).toEqual([]);
  });
});
