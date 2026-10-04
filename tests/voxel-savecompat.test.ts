// Save swapping with gen1recomp, and a save that cannot be read never turning
// quietly into a new game (voxelmon/game/savecompat.ts, gen2/core/SaveScrub.ts,
// the CONTINUE / writeSave paths in game.ts and gen2's Save + MainMenu).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { encodeSave } from "../voxelmon/game/save-lua.ts";
import { decodeSave } from "../voxelmon/game/save-read.ts";
import { fromDisk, migratePc, syncItemBalls, toDisk } from "../voxelmon/game/savecompat.ts";
import * as Pc from "../voxelmon/game/world/pcitems.ts";
import { isStarterPikachu } from "../voxelmon/game/world/pikachu.ts";
import { scrubGen2Save } from "../voxelmon/game/gen2/core/SaveScrub.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { memorySaveIo, setSaveIo } from "../voxelmon/game/gen2/platform/saveio.ts";
import { gold, rig } from "./gen2-ui-d-harness.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
const data: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;

/** The host a cartridge has: one save slot, and the .unreadable copy beside it. */
class CardHost extends RecorderHost {
  saved: string | undefined;
  kept: string[] = [];
  /** What the card had at boot: what saveBackup copies (voxel_save_backup). */
  boot: string | undefined;
  backupWorks = true;
  constructor(initial?: string) {
    super();
    this.saved = initial;
    this.boot = initial;
  }
  pic(): void {}
  picHide(): void {}
  saveWrite(text: string): void {
    this.saved = text;
  }
  saveData(): string | undefined {
    return this.boot;
  }
  saveBackup(): boolean {
    if (!this.backupWorks) return false;
    if (this.boot !== undefined) this.kept.push(this.boot);
    return true;
  }
}

function tap(game: VoxelmonGame, mask: number): void {
  game.tick(mask);
  game.tick(0);
}

/** From the title, pick CONTINUE (the top entry when there is a save). */
function pressContinue(game: VoxelmonGame): void {
  tap(game, VOX_BTN.start); // PRESS START -> the menu
  tap(game, VOX_BTN.a); // CONTINUE
}

/** Every page of the text box on top, read off as it is dismissed. */
function readText(game: VoxelmonGame, maxTicks = 2000): string {
  const seen = new Set<unknown>();
  const text: string[] = [];
  let t = 0;
  while (game.stackKinds().at(-1) === "textbox" && t < maxTicks) {
    const top: any = (game as any).stack.at(-1);
    if (top?.box && !seen.has(top.box)) {
      seen.add(top.box);
      for (const p of top.box.pages ?? []) text.push(p.lines.join("\n"));
    }
    game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    t += 1;
  }
  game.tick(0);
  return text.join("\n");
}

/** A save the way gen1recomp v0.3.51 writes one (fields read off his files). */
function hisSave(): any {
  return {
    meta: { format: 5, engine: "gen1recomp" },
    version: "red",
    player: { name: "ASH", rival: "GARY", id: 4321, map: "VIRIDIAN_CITY", x: 10, y: 12, facing: "up", surfing: false },
    party: [
      { species: "SQUIRTLE", level: 9, hp: 28, maxHp: 28, moves: [{ id: "TACKLE", pp: 35 }], ot: "ASH", otId: 4321, traded: false },
      { species: "ABRA", level: 12, hp: 20, maxHp: 20, moves: [{ id: "TELEPORT", pp: 20 }], ot: "BRIAN", otId: 777, traded: true },
    ],
    boxes: [[{ species: "PIDGEY", level: 3, moves: [{ id: "GUST", pp: 35 }], ot: "ASH", otId: 4321 }]],
    inventory: { POTION: 3 },
    bagOrder: ["POTION"],
    pcItems: { POTION: 1, ANTIDOTE: 2 },
    pcOrder: ["POTION", "ANTIDOTE"],
    flags: { EVENT_GOT_STARTER: true },
    money: 1234,
    pokedex: { seen: { SQUIRTLE: true, ABRA: true }, owned: { SQUIRTLE: true, ABRA: true } },
    lastHeal: { map: "VIRIDIAN_POKECENTER", x: 3, y: 7 },
    lastOutdoor: { id: "VIRIDIAN_CITY", x: 23, y: 26 },
    usedPokecenter: true,
    surfingHighScore: 0x0420,
  };
}

/** The first map in the cooked data with an item ball on it. */
function anItemBall(d: VoxelmonData): { mapId: string; index: number; text: string } {
  for (const [mapId, m] of Object.entries((d as any).maps as Record<string, any>)) {
    for (const o of m.objects ?? []) {
      if (o.item && o.text && o.index !== undefined && !o.hidden) return { mapId, index: o.index, text: o.text };
    }
  }
  throw new Error("no item ball in the data");
}

// ---------------------------------------------------------------------------
// the field mapping, both ways
// ---------------------------------------------------------------------------

describe("gen1recomp's fields read as ours", () => {
  test.skipIf(!hasGen)("his own mon is yours; a traded one keeps its trainer", () => {
    const save = hisSave();
    const report = fromDisk(save, data as never);
    expect(report.lostMons).toEqual([]);
    expect(report.lostItems).toEqual([]);
    const [mine, traded] = save.party;
    expect(mine.otName).toBeUndefined();
    expect(traded.otName).toBe("BRIAN");
    expect(traded.otId).toBe(777);
    expect(traded.traded).toBe(true);
    expect(save.boxes[0][0].otName).toBeUndefined();
  });

  test.skipIf(!hasGen)("a mon with his trainer stamp but no traded flag is still someone else's", () => {
    const save = hisSave();
    delete save.party[1].traded;
    fromDisk(save, data as never);
    expect(save.party[1].otName).toBe("BRIAN");
    expect(save.party[1].traded).toBe(true);
  });

  test.skipIf(!hasGen)("his PC items are the PC's items", () => {
    const save = hisSave();
    fromDisk(save, data as never);
    expect(Pc.pcBag(save).inventory).toEqual({ POTION: 1, ANTIDOTE: 2 });
    expect(Pc.pcOrder(save)).toEqual(["POTION", "ANTIDOTE"]);
    expect(Pc.withdraw(save, "ANTIDOTE", 1, data as never)).toBe(true);
    expect(save.pcItems.ANTIDOTE).toBe(1);
    expect(save.inventory.ANTIDOTE).toBe(1);
  });

  test("this port's old pc bag folds into his fields", () => {
    const save: any = { pcItems: { POTION: 1 }, pc: { inventory: { POTION: 2, ETHER: 1 }, bagOrder: ["ETHER", "POTION"] } };
    migratePc(save);
    expect(save.pc).toBeUndefined();
    expect(save.pcItems).toEqual({ POTION: 3, ETHER: 1 });
    expect(save.pcOrder).toEqual(["ETHER", "POTION"]);
    // and pcBag does it on first use too
    const later: any = { pc: { inventory: { REPEL: 4 }, bagOrder: ["REPEL"] } };
    expect(Pc.pcBag(later).inventory).toEqual({ REPEL: 4 });
    expect(later.pc).toBeUndefined();
  });

  test("Yellow's surfing record: his field, and the old one read once", () => {
    const old: any = { player: { name: "Y" }, surfingHiScore: 0x0123 };
    fromDisk(old, {} as never);
    expect(old.surfingHighScore).toBe(0x0123);
    expect(old.surfingHiScore).toBeUndefined();
  });

  test("a heal point at a center means the nurse was used", () => {
    const save: any = { player: { name: "R" }, lastHeal: { map: "PEWTER_POKECENTER", x: 3, y: 7 } };
    fromDisk(save, {} as never);
    expect(save.usedPokecenter).toBe(true);
    const fresh: any = { player: { name: "R" }, lastHeal: { map: "PALLET_TOWN", x: 5, y: 6 } };
    fromDisk(fresh, {} as never);
    expect(fresh.usedPokecenter).toBeUndefined();
  });

  test("Yellow's own Pikachu stays the starter through his ID stamp", () => {
    const save: any = { version: "yellow", player: { name: "YELLOW", id: 99 } };
    expect(isStarterPikachu(save, { species: "PIKACHU" })).toBe(true);
    expect(isStarterPikachu(save, { species: "PIKACHU", otId: 99 })).toBe(true);
    expect(isStarterPikachu(save, { species: "PIKACHU", otName: "YELLOW", otId: 99 })).toBe(true);
    expect(isStarterPikachu(save, { species: "PIKACHU", otId: 12 })).toBe(false);
    expect(isStarterPikachu(save, { species: "PIKACHU", otName: "BRIAN", otId: 99 })).toBe(false);
  });
});

describe("our save written for gen1recomp", () => {
  test("every mon carries ot / otId, and the live save is untouched", () => {
    const live: any = {
      player: { name: "RED", id: 1000 },
      party: [{ species: "CHARMANDER" }, { species: "MR_MIME", otName: "TRADER", otId: 55, traded: true }],
      boxes: [[{ species: "RATTATA" }]],
      daycare: { mon: { species: "PIDGEY" }, steps: 4, depositLevel: 5 },
    };
    const before = JSON.stringify(live);
    const out = toDisk(live);
    expect(JSON.stringify(live)).toBe(before);
    expect(out.party[0]).toMatchObject({ ot: "RED", otId: 1000 });
    expect(out.party[1]).toMatchObject({ ot: "TRADER", otId: 55, traded: true });
    expect(out.boxes[0][0]).toMatchObject({ ot: "RED", otId: 1000 });
    expect(out.daycare.mon).toMatchObject({ ot: "RED", otId: 1000 });
    expect(out.meta.format).toBe(5);
  });

  test("an in-game trade (no trainer named) stays unnamed, and reads back the same", () => {
    const live: any = { player: { name: "RED", id: 1000 }, party: [{ species: "FARFETCHD", traded: true }] };
    const out = toDisk(live);
    expect(out.party[0].ot).toBeUndefined();
    expect(out.party[0].otId).toBeUndefined();
    const back: any = decodeSave(encodeSave(out));
    fromDisk(back, {} as never);
    expect(back.party[0].otName).toBeUndefined();
    expect(back.party[0].traded).toBe(true);
  });

  test("a save from a newer format still loads, with a warning", () => {
    const save: any = { meta: { format: 9 }, player: { name: "R" } };
    const r = fromDisk(save, {} as never);
    expect(r.newerFormat).toBe(9);
  });

  test.skipIf(!hasGen)("write, read back: the same save, own mons still own", () => {
    const save = hisSave();
    fromDisk(save, data as never);
    const text = encodeSave(toDisk(save));
    const again: any = decodeSave(text);
    fromDisk(again, data as never);
    expect(again.party[0].otName).toBeUndefined();
    expect(again.party[1].otName).toBe("BRIAN");
    expect(again.pcItems).toEqual(save.pcItems);
    expect(again.player).toEqual(save.player);
    expect(again.surfingHighScore).toBe(0x0420);
  });
});

describe("item balls taken, in both games' records", () => {
  test.skipIf(!hasGen)("his itemsTaken hides ours, and our pickup flag fills his", () => {
    const ball = anItemBall(data!);
    const key = `${ball.mapId}_obj_${ball.index}`;
    const flag = `EVENT_ITEMBALL_${ball.mapId}_${ball.text}`;
    const his: any = { flags: {}, itemsTaken: { [key]: true } };
    syncItemBalls(his, (data as any).maps);
    expect(his.flags[flag]).toBe(true);
    const ours: any = { flags: { [flag]: true } };
    syncItemBalls(ours, (data as any).maps);
    expect(ours.itemsTaken[key]).toBe(true);
    const none: any = { flags: {} };
    syncItemBalls(none, (data as any).maps);
    expect(none.itemsTaken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// what this game does not have: set aside, and brought back later
// ---------------------------------------------------------------------------

describe("unknown content is quarantined, as his validate does", () => {
  test.skipIf(!hasGen)("an unknown species, item, move and map", () => {
    const save = hisSave();
    save.party.push({ species: "FAKEMON_X", level: 50, moves: [] });
    save.party[0].moves.push({ id: "LASER_BEAM", pp: 5 });
    save.inventory.SUPER_GADGET = 2;
    save.bagOrder.push("SUPER_GADGET");
    save.pcItems.MOD_ORB = 1;
    save.player.map = "NEW_ISLAND";
    const r = fromDisk(save, data as never);
    expect(r.lostMons.map((m) => m.species)).toEqual(["FAKEMON_X"]);
    expect(r.lostItems.map((i) => i.id).sort()).toEqual(["MOD_ORB", "SUPER_GADGET"]);
    expect(r.droppedMoves).toEqual([{ species: "SQUIRTLE", move: "LASER_BEAM" }]);
    expect(save.party.map((m: any) => m.species)).toEqual(["SQUIRTLE", "ABRA"]);
    expect(save.bagOrder).toEqual(["POTION"]);
    expect(save.orphaned.mons[0].species).toBe("FAKEMON_X");
    expect(save.orphaned.items.length).toBe(2);
    // back at the last center rather than nowhere
    expect(save.player.map).toBe("VIRIDIAN_POKECENTER");
    expect([save.player.x, save.player.y]).toEqual([3, 7]);
  });

  test.skipIf(!hasGen)("a game that has them gets them back (box and PC)", () => {
    const save = hisSave();
    save.orphaned = {
      mons: [{ species: "PIKACHU", level: 5, moves: [{ id: "THUNDERSHOCK", pp: 30 }] }],
      items: [{ id: "ETHER", count: 2 }],
    };
    const r = fromDisk(save, data as never);
    expect(r.restoredMons).toEqual([{ species: "PIKACHU" }]);
    expect(save.boxes[0].some((m: any) => m.species === "PIKACHU")).toBe(true);
    expect(save.pcItems.ETHER).toBe(2);
    expect(save.orphaned).toBeUndefined();
  });

  test.skipIf(!hasGen)("a real save loses nothing", () => {
    const save = hisSave();
    const before = JSON.stringify({ party: save.party, inv: save.inventory, pc: save.pcItems });
    const r = fromDisk(save, data as never);
    expect(r.lostMons.length + r.lostItems.length + r.droppedMoves.length + r.remappedMaps.length).toBe(0);
    expect(save.orphaned).toBeUndefined();
    expect(save.party.length).toBe(2);
    expect(JSON.stringify(save.inventory)).toBe(JSON.stringify(JSON.parse(before).inv));
  });
});

// ---------------------------------------------------------------------------
// failing loudly: Red/Blue/Yellow
// ---------------------------------------------------------------------------

describe("an unreadable save is never quietly a new game", () => {
  test.skipIf(!hasGen)("CONTINUE says why and keeps the file; the first save keeps a copy", () => {
    const junk = "return { player = { name = \"RED\" ";
    const host = new CardHost(junk);
    const game = new VoxelmonGame(data!, host, 1);
    game.newGame();
    expect(game.stackKinds().at(-1)).toBe("title");
    pressContinue(game);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    const said = readText(game);
    expect(said).toContain("could");
    expect(game.unreadableSave).toBe(true);
    // the title is back, and nothing touched the card
    expect(game.stackKinds().at(-1)).toBe("title");
    expect(host.saved).toBe(junk);
    expect(host.kept).toEqual([]);
    // CONTINUE is still offered, and still refuses
    pressContinue(game);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    readText(game);
    // a new game's first save: the copy first, then the write
    game.closeToOverworld();
    game.writeSave();
    expect(host.kept).toEqual([junk]);
    expect(host.saved).not.toBe(junk);
    expect(game.unreadableSave).toBe(false);
    expect(game.lastSaveOk).toBe(true);
  });

  test.skipIf(!hasGen)("no copy, no write", () => {
    const junk = "not a save at all";
    const host = new CardHost(junk);
    host.backupWorks = false;
    const game = new VoxelmonGame(data!, host, 1);
    game.newGame();
    pressContinue(game);
    readText(game);
    game.closeToOverworld();
    game.writeSave();
    expect(host.saved).toBe(junk);
    expect(game.lastSaveOk).toBe(false);
    expect(readText(game)).toContain("SAVE FAILED");
    // DELETE is refused the same way
    game.deleteSave();
    expect(host.saved).toBe(junk);
  });

  test.skipIf(!hasGen)("a good save of his continues where he stood", () => {
    const host = new CardHost(encodeSave(hisSave()));
    const game = new VoxelmonGame(data!, host, 1);
    game.newGame();
    pressContinue(game);
    expect(game.stackKinds().at(-1)).toBe("overworld");
    const ow: any = game.overworld;
    expect(ow.map.id).toBe("VIRIDIAN_CITY");
    expect([ow.player.cellX, ow.player.cellY]).toEqual([10, 12]);
    expect(game.unreadableSave).toBe(false);
    // and what we write back carries his fields
    game.writeSave();
    const back: any = decodeSave(host.saved!);
    expect(back.party[0].ot).toBe("ASH");
    expect(back.party[1].ot).toBe("BRIAN");
    expect(back.player.surfing).toBe(false);
    expect(back.pcItems).toEqual({ POTION: 1, ANTIDOTE: 2 });
    expect(back.usedPokecenter).toBe(true);
  });

  test.skipIf(!hasGen)("a save holding something unknown loads, and says so", () => {
    const s = hisSave();
    s.party.push({ species: "FAKEMON_X", level: 50, moves: [] });
    const host = new CardHost(encodeSave(s));
    const game = new VoxelmonGame(data!, host, 1);
    game.newGame();
    pressContinue(game);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(readText(game)).toContain("set aside");
    expect(game.stackKinds().at(-1)).toBe("overworld");
    expect(game.save.party.length).toBe(2);
    game.writeSave();
    // what was set aside is still in the file, for a game that has it
    expect((decodeSave(host.saved!) as any).orphaned.mons[0].species).toBe("FAKEMON_X");
  });
});

// ---------------------------------------------------------------------------
// Gold / Silver
// ---------------------------------------------------------------------------

describe("Gold and Silver: unreadable saves and unknown content", () => {
  test("load says unreadable; save keeps a copy first", () => {
    const io = memorySaveIo("return { player = ");
    setSaveIo(io);
    const [data2, , err] = Save.load();
    expect(data2).toBeUndefined();
    expect(err).toContain("corrupt");
    expect(Save.unreadable()).toBe(true);
    const fresh = Save.newGame({ playerName: "GOLD" });
    const [ok] = Save.save(fresh);
    expect(ok).toBe(true);
    expect(io.backups).toEqual(["return { player = "]);
    expect(io.text).toContain("GOLD");
    expect(Save.unreadable()).toBe(false);
    setSaveIo(undefined);
  });

  test("a Gen 1 shaped file in the Gold slot is kept, not written over", () => {
    const gen1 = encodeSave({ player: { name: "RED", map: "NEW_BARK_TOWN" }, party: [] });
    const io = memorySaveIo(gen1);
    io.backup = () => false;
    setSaveIo(io);
    expect(Save.load()[2]).toBe("not a Gen 2 save");
    const [ok, why] = Save.save(Save.newGame({ playerName: "GOLD" }));
    expect(ok).toBe(false);
    expect(why).toContain("unreadable");
    expect(io.text).toBe(gen1);
    expect(Save.erase()).toBe(false);
    expect(io.text).toBe(gen1);
    setSaveIo(undefined);
  });

  test("a missing save is nothing to keep", () => {
    const io = memorySaveIo();
    setSaveIo(io);
    expect(Save.load()[2]).toBe("missing");
    expect(Save.unreadable()).toBe(false);
    expect(Save.save(Save.newGame({ playerName: "GOLD" }))[0]).toBe(true);
    expect(io.backups).toEqual([]);
    setSaveIo(undefined);
  });

  test.skipIf(!gold)("the main menu keeps CONTINUE, and CONTINUE says why", async () => {
    const r = await rig();
    setSaveIo(memorySaveIo("garbage {"));
    const { MainMenu } = await import("../voxelmon/game/gen2/ui/MainMenu.ts");
    let continued = false;
    const menu = new MainMenu(r.game, { onContinue: () => { continued = true; } });
    expect(menu.hasSave).toBe(true);
    expect(menu.loadErr).toContain("corrupt");
    menu.choose("continue");
    expect(continued).toBe(false);
    expect((r.game.stack.top() as any)?.isTextBox).toBe(true);
    setSaveIo(undefined);
  });

  test.skipIf(!gold)("unknown species, items and moves set aside; known ones untouched", async () => {
    const r = await rig();
    const d = r.game.data;
    const save: any = Save.newGame({ playerName: "GOLD" });
    save.party = [
      { species: "CYNDAQUIL", level: 5, moves: [{ id: "TACKLE", pp: 35 }, { id: "MOD_BEAM", pp: 5 }], item: "MOD_BERRY" },
      { species: "FAKEMON_Y", level: 9, moves: [] },
    ];
    save.inventory = { POTION: 2, WARP_CARD: 1 };
    save.pcItems = { POTION: 1 };
    save.dayCare = { man: { mon: { species: "FAKEMON_Z" } } };
    const rep = scrubGen2Save(save, d);
    expect(rep.lostMons.map((m) => m.species).sort()).toEqual(["FAKEMON_Y", "FAKEMON_Z"]);
    expect(rep.lostItems.map((i) => i.id).sort()).toEqual(["MOD_BERRY", "WARP_CARD"]);
    expect(rep.droppedMoves).toEqual([{ species: "CYNDAQUIL", move: "MOD_BEAM" }]);
    expect(save.party.length).toBe(1);
    expect(save.party[0].moves).toEqual([{ id: "TACKLE", pp: 35 }]);
    expect(save.inventory).toEqual({ POTION: 2 });
    expect(save.dayCare.man.mon).toBeUndefined();
    expect(save.orphaned.mons.length).toBe(2);
    // and they come back in a game that has them
    const known: any = { ...d, pokemon: { ...d.pokemon, FAKEMON_Y: {}, FAKEMON_Z: {} }, items: { ...d.items, WARP_CARD: {}, MOD_BERRY: {} } };
    const back = scrubGen2Save(save, known);
    expect(back.restoredMons).toBe(2);
    expect(back.restoredItems).toBe(2);
    expect(save.pcItems.WARP_CARD).toBe(1);
    expect(save.orphaned).toBeUndefined();
  });

  test.skipIf(!gold)("a real Gold save loses nothing", async () => {
    const r = await rig();
    const d = r.game.data;
    const save: any = Save.newGame({ playerName: "GOLD" });
    const species = Object.keys(d.pokemon).slice(0, 8);
    const items = Object.keys(d.items).filter((k) => !k.startsWith("NO_")).slice(0, 40);
    const moves = Object.keys(d.moves).slice(0, 4);
    save.party = species.slice(0, 6).map((s) => ({ species: s, level: 10, moves: moves.map((m) => ({ id: m, pp: 10 })), item: items[0] }));
    save.boxes = [species.map((s) => ({ species: s, level: 3, moves: [] }))];
    save.inventory = Object.fromEntries(items.map((i) => [i, 1]));
    save.pcItems = Object.fromEntries(items.slice(0, 10).map((i) => [i, 2]));
    const before = JSON.stringify(save);
    const rep = scrubGen2Save(save, d);
    expect(rep.lostMons.length + rep.lostItems.length + rep.droppedMoves.length).toBe(0);
    expect(JSON.stringify(save)).toBe(before);
  });
});
