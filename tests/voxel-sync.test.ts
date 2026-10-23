// SYNC (voxelmon/game/sync/model.ts): the title-screen save transfer with
// the PC/phone games (PVS1). The networking is the host's (Rust, tested in
// crates/pocketvoxel-sync); here a stand-in for the `voxel.sync*` natives
// drives the screen: its rows, the two-press confirm, the status lines, the
// install path's outcomes, and the title rows that open it in both
// generations.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { loadRuntimeData, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { CONFIRM, SEARCHING, SyncModel, hostSync, syncAccepts, type SyncNative } from "../voxelmon/game/sync/model.ts";
import { validateGen1 } from "../voxelmon/game/ui/syncscreen.ts";
import { SYNC_TEXT } from "../voxelmon/game/ui/title.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { SaveSerializer } from "../voxelmon/game/gen2/shared/core/SaveSerializer.ts";
import * as saveio from "../voxelmon/game/gen2/platform/saveio.ts";
import { validateGen2 } from "../voxelmon/game/gen2/ui/SyncScreen.ts";

/** The host's natives, as the screen sees them. */
class FakeSync implements SyncNative {
  openResult = 1;
  hasSave = true;
  peers: string[] = [];
  events: string[] = [];
  offers: string[] = [];
  pulls: string[] = [];
  text: string | undefined;
  installResult = "";
  installs: string[] = [];
  discards = 0;
  closes = 0;
  t = 100;
  onInstall?: (text: string) => void;
  open(): number { return this.openResult; }
  poll(): string {
    const out = [`S\t${this.openResult === 1 ? "open" : "error\tport 47610 busy"}`, `H\t${this.hasSave ? 1 : 0}`, ...this.peers, ...this.events];
    this.events = [];
    return out.join("\n");
  }
  offer(id: string): number { this.offers.push(id); return 1; }
  pull(id: string): number { this.pulls.push(id); return 1; }
  received(): string | undefined { return this.text; }
  install(): string {
    this.installs.push(this.text ?? "");
    if (this.installResult === "") this.onInstall?.(this.text ?? "");
    return this.installResult;
  }
  discard(): void { this.discards++; this.text = undefined; }
  close(): void { this.closes++; }
  now(): number { return this.t * 1e6; }
  /** As the Rust side writes a peer record. */
  peer(id: string, game: string, name: string, offered = false, platform = "pc"): string {
    return `P\t${id}\t${platform}\t${game}\t${offered ? 1 : 0}\t${name}`;
  }
}

const RED_SAVE = 'return {\n  player = {\n    name = "ISAAC",\n  },\n  version = "red",\n}\n';
const NONE = {};
const A = { a: true };
const B = { b: true };
const DOWN = { down: true };
const UP = { up: true };

function model(fake: FakeSync | null, game = "red"): SyncModel {
  const m = new SyncModel({ game, native: fake, validate: (t) => validateGen1(game, t) });
  m.open();
  return m;
}

describe("the SYNC screen", () => {
  test("without the natives (or wifi) it says so and BACK still works", () => {
    const m = model(null);
    expect(m.status).toBe("ERROR: NO WIFI");
    expect(m.rows.map((r) => r.label)).toEqual(["BACK"]);
    expect(m.update(A)).toBe("close");

    const f = new FakeSync();
    f.openResult = 0;
    const n = model(f);
    expect(n.status).toBe("ERROR: NO WIFI");
    expect(n.rowText(16)).toEqual(["BACK"]);
    expect(n.update(B)).toBe("close");
    expect(f.closes).toBe(1);
  });

  test("an open that fails for another reason shows the host's reason", () => {
    const f = new FakeSync();
    f.openResult = -1;
    const m = model(f);
    expect(m.status).toBe("ERROR: PORT 47610 BUSY");
  });

  test("rows: ACCEPT on an offer, GET, SEND with a save, other games listed but not pickable, BACK", () => {
    const f = new FakeSync();
    f.peers = [f.peer("aa", "red", "DESKTOP"), f.peer("bb", "gold", "PHONE"), f.peer("cc", "red", "LAPTOP", true, "android")];
    const m = model(f);
    expect(m.status).toBe(SEARCHING);
    expect(m.title).toBe("SYNC RED");
    expect(m.rows.map((r) => r.label)).toEqual(["GET DESKTOP", "SEND DESKTOP", "PHONE", "ACCEPT LAPTOP", "GET LAPTOP", "SEND LAPTOP", "BACK"]);
    expect(m.rowText(16)[2]).toBe("PHONE       GOLD");
    // the cursor steps over the other game's row
    expect(m.index).toBe(0);
    m.update(DOWN);
    expect(m.index).toBe(1);
    m.update(DOWN);
    expect(m.index).toBe(3);
    m.update(UP);
    expect(m.index).toBe(1);
    // no save of our own: no SEND
    f.hasSave = false;
    m.update(NONE);
    expect(m.rows.map((r) => r.kind)).toEqual(["get", "other", "accept", "get", "back"]);
  });

  test("GET takes two A presses within three seconds", () => {
    const f = new FakeSync();
    f.peers = [f.peer("aa", "red", "DESKTOP")];
    const m = model(f);
    m.update(A);
    expect(m.status).toBe(CONFIRM);
    expect(f.pulls).toEqual([]);
    f.t += 2.5;
    m.update(A);
    expect(f.pulls).toEqual(["aa"]);
    expect(m.status).toBe("RECEIVING FROM DESKTOP...");
  });

  test("the confirm lapses after three seconds, and moving away disarms it", () => {
    const f = new FakeSync();
    f.peers = [f.peer("aa", "red", "DESKTOP")];
    const m = model(f);
    m.update(A);
    f.t += 3.5;
    m.update(NONE);
    expect(m.status).toBe(SEARCHING);
    m.update(A);
    expect(m.status).toBe(CONFIRM);
    expect(f.pulls).toEqual([]);
    m.update(DOWN); // SEND
    expect(m.status).toBe(SEARCHING);
    m.update(UP);
    m.update(A);
    expect(f.pulls).toEqual([]);
    expect(m.status).toBe(CONFIRM);
  });

  test("ACCEPT is a GET: two presses, then a pull", () => {
    const f = new FakeSync();
    f.peers = [f.peer("cc", "red", "LAPTOP", true)];
    f.events = ["O\tLAPTOP"];
    const m = model(f);
    expect(m.status).toBe("LAPTOP OFFERS A SAVE");
    expect(m.rows[0]!.label).toBe("ACCEPT LAPTOP");
    m.update(A);
    expect(m.status).toBe(CONFIRM);
    m.update(A);
    expect(f.pulls).toEqual(["cc"]);
  });

  test("SEND only offers", () => {
    const f = new FakeSync();
    f.peers = [f.peer("aa", "red", "DESKTOP")];
    const m = model(f);
    m.update(DOWN);
    m.update(A);
    expect(f.offers).toEqual(["aa"]);
    expect(f.pulls).toEqual([]);
    expect(m.status).toBe("OFFERED TO DESKTOP");
  });

  test("a received save is read by the game's reader, then installed by the host", () => {
    const f = new FakeSync();
    f.peers = [f.peer("aa", "red", "DESKTOP")];
    const m = model(f);
    m.update(A);
    m.update(A);
    f.text = RED_SAVE;
    f.events = ["R\tDESKTOP\t" + RED_SAVE.length];
    m.update(NONE);
    expect(f.installs).toEqual([RED_SAVE]);
    expect(m.status).toBe("GOT DESKTOP'S SAVE!");
    expect(m.installed).toBe(true);
  });

  test("refusals: not a save, another game's save, the host's own refusal, a card error", () => {
    const f = new FakeSync();
    f.peers = [f.peer("aa", "red", "DESKTOP")];
    const m = model(f);
    const land = (text: string): void => {
      f.text = text;
      f.events = ["R\tDESKTOP\t1"];
      m.update(NONE);
    };
    land("os.execute('x')");
    expect(m.status).toBe("REFUSED: NOT A SAVE");
    expect(f.discards).toBe(1);
    land(RED_SAVE.replace('"red"', '"gold"'));
    expect(m.status).toBe("REFUSED: SAVE IS GOLD");
    land('return { player = { name = "X" } }');
    expect(m.status).toBe("REFUSED: SAVE HAS NO GAME");
    expect(f.installs).toEqual([]);
    f.installResult = "R:NOT A SAVE";
    land(RED_SAVE);
    expect(m.status).toBe("REFUSED: NOT A SAVE");
    f.installResult = "E:SD CARD WRITE FAILED";
    land(RED_SAVE);
    expect(m.status).toBe("ERROR: SD CARD WRITE FAILED");
    expect(m.installed).toBe(false);
  });

  test("a failed pull says why; B closes the sockets", () => {
    const f = new FakeSync();
    f.peers = [f.peer("aa", "red", "DESKTOP")];
    const m = model(f);
    m.update(A);
    m.update(A);
    f.events = ["F\tDESKTOP\tconnection dropped"];
    m.update(NONE);
    expect(m.status).toBe("ERROR: CONNECTION DROPPED");
    expect(m.update(B)).toBe("close");
    expect(f.closes).toBe(1);
  });

  test("the status wraps to the text box", () => {
    const m = model(null);
    m.status = CONFIRM;
    expect(m.statusLines(18)).toEqual(["A AGAIN: OVERWRITE", "YOUR SAVE"]);
    m.status = "RECEIVING FROM ABCDEFGHIJKLMNOPQRST...";
    expect(m.statusLines(18)).toEqual(["RECEIVING FROM", "ABCDEFGHIJKLMNOPQR"]);
  });

  test("a long list scrolls with the cursor", () => {
    const f = new FakeSync();
    f.peers = ["a1", "a2", "a3", "a4"].map((id) => f.peer(id, "red", id.toUpperCase()));
    const m = model(f);
    expect(m.rows.length).toBe(9);
    expect(m.scrollTop(5)).toBe(0);
    for (let i = 0; i < 6; i++) m.update(DOWN);
    expect(m.index).toBe(6);
    expect(m.scrollTop(5)).toBe(4);
  });
});

describe("what a received save must be", () => {
  test("version rules: the same game; Blue also takes its old red-tagged saves", () => {
    expect(syncAccepts("red", "red")).toBe(true);
    expect(syncAccepts("red", "blue")).toBe(false);
    expect(syncAccepts("blue", "blue")).toBe(true);
    expect(syncAccepts("blue", "red")).toBe(true);
    expect(syncAccepts("yellow", "red")).toBe(false);
    expect(syncAccepts("gold", "silver")).toBe(false);
  });

  test("Gen 1: CONTINUE's reader, the version, a player", () => {
    expect(validateGen1("red", RED_SAVE)).toBe(null);
    expect(validateGen1("blue", RED_SAVE)).toBe(null);
    expect(validateGen1("yellow", RED_SAVE)).toBe("SAVE IS RED");
    expect(validateGen1("red", "return {")).toBe("NOT A SAVE");
    expect(validateGen1("red", 'return { version = "red" }')).toBe("NOT A SAVE");
    expect(validateGen1("red", "print('hi')")).toBe("NOT A SAVE");
  });

  test("Gen 2: the save serializer's reader (no trailing code) and the version", () => {
    const ok = 'return {\n  player = {\n    name = "KRIS",\n  },\n  version = "crystal",\n}\n';
    expect(validateGen2("crystal", ok)).toBe(null);
    expect(validateGen2("gold", ok)).toBe("SAVE IS CRYSTAL");
    expect(validateGen2("crystal", ok + "os.exit()")).toBe("NOT A SAVE");
    expect(validateGen2("crystal", "return 5")).toBe("NOT A SAVE");
  });
});

/** Installs the natives on globalThis.voxel for the game code to find. */
function withNatives(f: FakeSync): void {
  (globalThis as any).voxel = {
    syncOpen: () => f.open(),
    syncPoll: () => f.poll(),
    syncOffer: (id: string) => f.offer(id),
    syncPull: (id: string) => f.pull(id),
    syncReceived: () => f.received(),
    syncInstall: () => f.install(),
    syncDiscard: () => f.discard(),
    syncClose: () => f.close(),
  };
}
afterEach(() => {
  delete (globalThis as any).voxel;
});

const root = join(import.meta.dir, "..");
const redDir = join(root, "dist/voxelmon/gen");
const red: VoxelmonData | null = existsSync(join(redDir, "pokemon.json")) ? await loadRuntimeData(redDir) : null;

describe("the Gen 1 title's SYNC row", () => {
  class Card extends RecorderHost {
    card: string | undefined;
    saveData(): string | undefined { return this.card; }
    saveWrite(t: string): boolean { this.card = t; return true; }
  }
  function boot(host: Card): VoxelmonGame {
    const game = new VoxelmonGame(red!, host, 1);
    game.newGame();
    for (let k = 0; k < 400 && (game as any).title()?.phase !== "menu"; k++) game.tick(k % 8 === 0 ? VOX_BTN.start : 0);
    game.tick(0);
    return game;
  }
  const press = (g: VoxelmonGame, b: number): void => { g.tick(b); g.tick(0); };

  test.skipIf(!red)("no natives, no row", () => {
    expect(hostSync()).toBe(null);
    const g = boot(new Card());
    expect((g as any).title().menu).not.toContain(SYNC_TEXT);
  });

  test.skipIf(!red)("SYNC under NEW GAME; a received save makes CONTINUE appear", () => {
    const f = new FakeSync();
    f.hasSave = false;
    f.peers = [f.peer("aa", "red", "DESKTOP")];
    const host = new Card();
    f.onInstall = (t) => host.saveWrite(t); // the host writes the card and its save buffer
    withNatives(f);
    const g = boot(host);
    const menu: string[] = (g as any).title().menu;
    expect(menu.slice(0, 2)).toEqual(["NEW GAME", SYNC_TEXT]);
    press(g, VOX_BTN.down);
    press(g, VOX_BTN.a);
    expect(g.stackKinds().at(-1)).toBe("sync");
    expect(g.stackKinds()).toContain("title");
    const v: any = (g as any).syncView();
    expect(v.title).toBe("SYNC RED");
    expect(v.rows).toEqual(["GET DESKTOP", "BACK"]);
    press(g, VOX_BTN.a);
    expect((g as any).syncView().status).toEqual(["A AGAIN: OVERWRITE", "YOUR SAVE"]);
    press(g, VOX_BTN.a);
    expect(f.pulls).toEqual(["aa"]);
    f.text = RED_SAVE;
    f.events = ["R\tDESKTOP\t1"];
    g.tick(0);
    expect((g as any).syncView().status).toEqual(["GOT DESKTOP'S", "SAVE!"]);
    press(g, VOX_BTN.b);
    expect(f.closes).toBe(1);
    expect(g.stackKinds().at(-1)).toBe("title");
    const t: any = (g as any).title();
    expect(t.menu.slice(0, 3)).toEqual(["CONTINUE", "NEW GAME", SYNC_TEXT]);
    expect(t.menu[t.index]).toBe(SYNC_TEXT);
  });
});

describe("the Gen 2 main menu's SYNC row", () => {
  const gold = haveGoldGen();
  test.skipIf(!gold)("SYNC under NEW GAME, the screen, and CONTINUE after a save lands", () => {
    useGoldGen();
    const io = saveio.memorySaveIo();
    saveio.setSaveIo(io);
    try {
      const f = new FakeSync();
      f.hasSave = false;
      f.peers = [f.peer("aa", "gold", "DESKTOP"), f.peer("bb", "red", "OTHER")];
      f.onInstall = (t) => io.write(t);
      withNatives(f);
      const game: any = Game2.new();
      game.load({ startWorld: false });
      game.showMainMenu();
      let menu: any = game.stack.top();
      const values = menu.list.items.map((i: any) => i.value);
      expect(values.slice(0, 2)).toEqual(["new", "sync"]);
      expect(menu.hasSave).toBe(false);
      menu.choose("sync");
      const scr: any = game.stack.top();
      expect(scr.screenId).toBe("Gen2Sync");
      expect(scr.model.rows.map((r: any) => r.label)).toEqual(["GET DESKTOP", "OTHER", "BACK"]);
      scr.drawPanel(); // draws without throwing
      const save = Save.newGame();
      f.text = SaveSerializer.encode(save);
      const step = (keys: string[]): void => {
        const real = game.input;
        game.input = { wasPressed: (k: string) => keys.includes(k) };
        scr.update();
        game.input = real;
      };
      step(["a"]);
      step(["a"]);
      expect(f.pulls).toEqual(["aa"]);
      f.events = ["R\tDESKTOP\t1"];
      step([]);
      expect(scr.model.status).toBe("GOT DESKTOP'S SAVE!");
      step(["b"]);
      menu = game.stack.top();
      expect(menu.screenId).toBe("Gen2MainMenu");
      expect(menu.hasSave).toBe(true);
      expect(menu.list.items[0].value).toBe("continue");
      // the cursor comes back on SYNC, the row that was left
      expect(menu.list.items[menu.list.index - 1].value).toBe("sync");
    } finally {
      saveio.setSaveIo(undefined);
    }
  });

  test.skipIf(!gold)("no natives, no row", () => {
    useGoldGen();
    const game: any = Game2.new();
    game.load({ startWorld: false });
    game.showMainMenu();
    expect(game.stack.top().list.items.map((i: any) => i.value)).not.toContain("sync");
  });
});

