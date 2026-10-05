// The FireRed runtime's menus, cluster B: start menu, bag (every pocket), TM
// case, shop, options, save, trainer card, Pokédex, and the coins / berry
// powder boxes, on real FireRed cache data, drawn through the love.graphics
// shim into the DesktopHost rasteriser. Screenshots go to /tmp/g3shots/.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { encodePng } from "../voxelmon/import/gen3/png.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const GBA = join(ROOT, "data/generated/gba");
const SHOTS = "/tmp/g3shots";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A pad that reports `keys` pressed this frame (Brian's input:wasPressed). */
function pad(...keys: string[]): { wasPressed(k: string): boolean; isDown(k: string): boolean } {
  return { wasPressed: (k) => keys.includes(k), isDown: (k) => keys.includes(k) };
}

describe.skipIf(!existsSync(GBA))("gen3 runtime: menus B", async () => {
  const host = new DesktopHost(ROOT);
  setHost(host);
  const { setAudio, silentAudio } = await import("../voxelmon/game/gen3/platform/audio.ts");
  setAudio(silentAudio());
  // Game3 loads the whole runtime (and core/lazy_modules) in its own order.
  const { Game3 } = await import("../voxelmon/game/gen3/core/Game3.ts");
  const { Runtime } = await import("../voxelmon/game/gen3/core/runtime.ts");
  const { G3Lazy } = await import("../voxelmon/game/gen3/core/lazy_registry.ts");
  // map_sections_extract (an importer module) reads the importer's bound cache
  const { CacheFs: ImportCacheFs } = await import("../voxelmon/import/gen3/cache.ts");
  const { makeCache } = await import("../voxelmon/import/gen3/fsio.ts");
  ImportCacheFs.bind(makeCache(ROOT));
  const { G } = await import("../voxelmon/game/gen3/platform/graphics.ts");
  const { Schema } = await import("../voxelmon/game/gen3/core/save_schema_firered.ts");
  const { Dex } = await import("../voxelmon/game/gen3/core/dex.ts");
  const { Flags } = await import("../voxelmon/game/gen3/core/scripting/flags.ts");
  const { Stack } = await import("../voxelmon/game/gen3/ui/stack.ts");
  const { StartMenu } = await import("../voxelmon/game/gen3/ui/start_menu.ts");
  const { SaveMenu } = await import("../voxelmon/game/gen3/ui/save_menu.ts");
  const { OptionMenu } = await import("../voxelmon/game/gen3/ui/option_menu.ts");
  const { Rows } = await import("../voxelmon/game/gen3/ui/option_rows.ts");
  const { TrainerCard } = await import("../voxelmon/game/gen3/ui/trainer_card.ts");
  const { Pokedex } = await import("../voxelmon/game/gen3/ui/pokedex.ts");
  const { Options } = await import("../voxelmon/game/gen3/core/options.ts");
  const { RomText } = await import("../voxelmon/game/gen3/core/rom_text.ts");
  const { SaveData } = await import("../voxelmon/game/gen3/shared/core/SaveData.ts");
  const { memorySaveStore, setSaveStore, saveStore } = await import("../voxelmon/game/gen3/platform/savefs.ts");
  const { GameVersion } = await import("../voxelmon/game/gen3/shared/core/GameVersion.ts");

  function shot(name: string): void {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, name), encodePng(240, 160, host.pixels()));
  }
  function px(x: number, y: number): [number, number, number] {
    const p = host.pixels(), o = (y * 240 + x) * 4;
    return [p[o]!, p[o + 1]!, p[o + 2]!];
  }
  /** Pixels in a box that are not `bg`. */
  function ink(x0: number, y0: number, x1: number, y1: number, bg: number[]): number {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const c = px(x, y);
      if (c[0] !== bg[0] || c[1] !== bg[1] || c[2] !== bg[2]) n++;
    }
    return n;
  }
  /**
   * The share of the screen's pixels (where the sheet is opaque) that equal a
   * 240x160 cache chrome sheet: the real FRLG background is on screen.
   */
  function chromeShare(rel: string): number {
    const sheet = new Uint8Array(readFileSync(join(GBA, rel)));
    expect(sheet.length).toBe(240 * 160 * 4);
    const p = host.pixels();
    let same = 0, opaque = 0;
    for (let o = 0; o < sheet.length; o += 4) {
      if (sheet[o + 3] !== 255) continue;
      opaque++;
      if (p[o] === sheet[o] && p[o + 1] === sheet[o + 1] && p[o + 2] === sheet[o + 2]) same++;
    }
    return opaque ? same / opaque : 0;
  }
  /** Draw `fn` over a field-ish backdrop and save it. */
  function frame(name: string, fn: () => void, bg: [number, number, number] = [0.25, 0.5, 0.35]): void {
    G.beginFrame();
    G.clear(bg[0], bg[1], bg[2], 1);
    fn();
    G.endFrame();
    shot(name);
  }

  const { Bag } = await import("../voxelmon/game/gen3/core/bag.ts");
  const { ItemsData } = await import("../voxelmon/game/gen3/core/items_data.ts");
  const { Storage } = await import("../voxelmon/game/gen3/core/storage.ts");
  const { Options: Opts } = await import("../voxelmon/game/gen3/core/options.ts");
  const { BagMenu } = await import("../voxelmon/game/gen3/ui/bag_menu.ts");
  const { ShopMenu } = await import("../voxelmon/game/gen3/ui/shop_menu.ts");
  const { TmCase } = await import("../voxelmon/game/gen3/ui/tm_case.ts");
  const { BerryPouch } = await import("../voxelmon/game/gen3/ui/berry_pouch.ts");
  const { Fade } = await import("../voxelmon/game/gen3/ui/fade.ts");
  const { seq } = await import("../voxelmon/game/gen3/platform/lt.ts");
  const POTION = 13, ANTIDOTE = 14, POKE_BALL = 4, TM01 = 289, TM28 = 316, BICYCLE = 360, ORAN = 139, PECHA = 136;

  // A FireRed session part-way through: two badges, a Pokédex, some mons.
  // NOT Schema.newGame: its newGameInit still reaches the trainer_fan_club stub.
  GameVersion.set("firered");
  ItemsData.applyProfile(undefined);
  const session: any = {
    schemaVersion: Schema.VERSION, engine: "game3", version: "firered", generation: 3,
    name: "RED", rivalName: "BLUE", gender: 0, trainerId: 24601, id: 24601, playerId: 24601, secretId: 1,
    money: 3000, coins: 0, berryPowder: 0, party: seq(), bag: Bag.new(), dex: Dex.new(),
    map: "FR_PALLET_TOWN", x: 6, y: 8, facing: "down", healMap: "FR_PALLET_TOWN", healX: 6, healY: 8,
    flags: {}, vars: {}, playtime: { hours: 12, minutes: 34, seconds: 0 }, move_overlay: {},
  };
  session.storage = Storage.new();
  Opts.ensure(session);
  const store = { flags: session.flags, vars: session.vars };
  Flags.setFlag(store, null, 0x828, true); // FLAG_SYS_POKEMON_GET
  Flags.setFlag(store, null, 0x829, true); // FLAG_SYS_POKEDEX_GET
  Flags.setFlag(store, null, 0x820, true); // FLAG_BADGE01_GET
  Flags.setFlag(store, null, 0x821, true); // FLAG_BADGE02_GET
  for (const sp of [1, 4, 7, 10, 16, 19, 25]) Dex.setSeen(session.dex, sp);
  for (const sp of [1, 16, 25]) Dex.setCaught(session.dex, sp);
  const game: any = Game3.new();
  game.session = session;
  game.phase = "field";
  Runtime._game = game;
  Runtime.session = session;

  test("start menu: FRLG entries, cursor, draw", () => {
    Stack.clear();
    StartMenu.resetCursor();
    StartMenu.show({ session, game });
    expect(StartMenu.isOpen()).toBe(true);
    const ids: string[] = [];
    for (let i = 1; StartMenu.ENTRIES[i]; i++) ids.push(StartMenu.ENTRIES[i].id);
    expect(ids).toEqual(["pokedex", "pokemon", "bag", "trainer", "save", "option", "exit"]);
    // the player's name stands in for PLAYER in the trainer row
    expect(StartMenu.ENTRIES[4].label).toBe("RED");
    expect(StartMenu.ENTRIES[1].label).toBe(RomText.at("sStartMenuActionTable", 0));
    StartMenu.move(1);
    StartMenu.move(1);
    expect(StartMenu.cursor).toBe(3);
    StartMenu.move(-3);
    expect(StartMenu.cursor).toBe(7); // wraps
    StartMenu.move(-4);
    frame("menus_b_start.png", () => StartMenu.draw());
    // the window is (22,1) 7 wide; white interior with ink in it
    expect(px(23 * 8 + 4, 2 * 8 + 1)).toEqual([255, 255, 255]);
    expect(ink(22 * 8, 1 * 8, 29 * 8, 15 * 8, [255, 255, 255])).toBeGreaterThan(300);
    // EXIT asks first
    StartMenu.cursor = 7;
    StartMenu.confirm();
    expect(StartMenu._confirmExit).toBe(true);
    StartMenu.cancel();
    expect(StartMenu._confirmExit).toBe(false);
    StartMenu.close(true);
    expect(Stack.has("start")).toBe(false);
  });

  test("bag: every pocket, the action menu", () => {
    Stack.clear();
    Bag.add(session.bag, POTION, 3);
    Bag.add(session.bag, ANTIDOTE, 1);
    Bag.add(session.bag, POKE_BALL, 5);
    Bag.add(session.bag, BICYCLE, 1);
    Bag.add(session.bag, TM01, 1);
    Bag.add(session.bag, TM28, 2);
    BagMenu.show(session.bag, { session });
    BagMenu.settle();
    const order = ItemsData.BAG_POCKET_ORDER;
    const pockets: string[] = [];
    for (let i = 1; order[i] != null; i++) pockets.push(order[i]);
    expect(pockets).toEqual(["ITEMS", "KEY_ITEMS", "POKE_BALLS"]);
    const seen: Record<string, number[]> = {};
    for (let p = 1; p <= pockets.length; p++) {
      expect(BagMenu.pocketIdx).toBe(p);
      const rows: any = BagMenu.list();
      const ids: number[] = [];
      for (let i = 1; rows[i]; i++) if (rows[i].id != null) ids.push(rows[i].id);
      seen[pockets[p - 1]!] = ids;
      frame(`menus_b_bag_${p}_${pockets[p - 1]!.toLowerCase()}.png`, () => BagMenu.draw());
      if (p < pockets.length) {
        BagMenu.handleInput(pad("right"));
        BagMenu.settle();
      }
    }
    expect(seen.ITEMS).toEqual([POTION, ANTIDOTE]);
    expect(seen.KEY_ITEMS).toContain(BICYCLE);
    expect(seen.POKE_BALLS).toEqual([POKE_BALL]);
    // ITEMS again, A on POTION opens USE / GIVE / TOSS
    BagMenu.show(session.bag, { session, pocket: "ITEMS" });
    BagMenu.settle();
    BagMenu.handleInput(pad("a"));
    expect(BagMenu.mode).toBe("action");
    frame("menus_b_bag_action.png", () => BagMenu.draw());
    BagMenu.handleInput(pad("b"));
    BagMenu.handleInput(pad("b"));
    BagMenu.settle();
    expect(BagMenu.isOpen()).toBe(false);
  });

  test("TM case: the TMs, sorted, with the move name", () => {
    Stack.clear();
    TmCase.show(session, session.bag, {});
    const rows: any = TmCase.list();
    expect(rows[1].id).toBe(TM01);
    expect(rows[2].id).toBe(TM28);
    expect(G3Lazy["src.ui.game3.tm_case_chrome"].ready()).toBe(true);
    frame("menus_b_tmcase.png", () => TmCase.draw());
    // FRLG's TM case background (items/tm_case/bg_male.rgba) fills the screen
    expect(chromeShare("items/tm_case/bg_male.rgba")).toBeGreaterThan(0.6);
    TmCase.handleInput(pad("a"));
    expect(TmCase.mode).toBe("action");
    TmCase.handleInput(pad("b"));
    TmCase.handleInput(pad("b"));
    expect(TmCase.open).toBe(false);
  });

  test("shop: buy a POTION, money drops by its price", () => {
    Stack.clear();
    const pump = (k: string): void => {
      ShopMenu.handleInput(pad(k));
      for (let i = 0; i < 60 && Fade.isActive(); i++) Fade.tick(1 / 60);
    };
    const price = ItemsData.info(POTION)!.price;
    expect(price).toBe(300);
    const money0 = session.money, potions0 = Bag.get(session.bag, POTION);
    ShopMenu.show({ items: seq(POTION, ANTIDOTE, POKE_BALL), session });
    frame("menus_b_shop_root.png", () => ShopMenu.draw());
    pump("a"); // BUY
    expect(ShopMenu.mode).toBe("buy");
    expect(G3Lazy["src.ui.game3.shop_chrome"].ready()).toBe(true);
    frame("menus_b_shop_buy.png", () => ShopMenu.draw());
    // the Poké Mart buy screen's background (items/shop/bg.rgba)
    expect(chromeShare("items/shop/bg.rgba")).toBeGreaterThan(0.6);
    pump("a"); // POTION -> quantity
    expect(ShopMenu.mode).toBe("buy_qty");
    pump("a"); // x01
    expect(ShopMenu.mode).toBe("buy_confirm");
    pump("a"); // YES
    expect(ShopMenu.mode).toBe("buy_msg");
    frame("menus_b_shop_bought.png", () => ShopMenu.draw());
    expect(session.money).toBe(money0 - price);
    expect(Bag.get(session.bag, POTION)).toBe(potions0 + 1);
    pump("a");
    pump("b");
    pump("b");
    expect(ShopMenu.open).toBe(false);
  });

  test("berry pouch: FRLG's pouch screen", () => {
    Stack.clear();
    Bag.add(session.bag, ORAN, 3);
    Bag.add(session.bag, PECHA, 1);
    BerryPouch.show(session, session.bag, {});
    const rows: any = BerryPouch.list();
    expect([rows[1].id, rows[2].id].sort()).toEqual([PECHA, ORAN].sort());
    expect(G3Lazy["src.ui.game3.berry_pouch_chrome"].ready()).toBe(true);
    frame("menus_b_berry_pouch.png", () => BerryPouch.draw());
    expect(chromeShare("items/berry_pouch/bg_male.rgba")).toBeGreaterThan(0.6);
    BerryPouch.handleInput(pad("b"));
    expect(BerryPouch.open).toBe(false);
  });

  test("options: rows, change TEXT SPEED, page in and out of a group", () => {
    Stack.clear();
    OptionMenu.show({ session, game });
    expect(OptionMenu.isOpen()).toBe(true);
    const top = OptionMenu._pages[1];
    const ids: string[] = [];
    for (let i = 1; top.rows[i]; i++) ids.push(top.rows[i].id);
    expect(ids).toEqual(["group.speed", "group.video", "group.graphics", "group.audio", "performance",
      "group.battle", "group.extras", "buttonMode", "controls", "mods"]);
    // touch rows and ORIENTATION are dropped on a non-mobile host
    const flat: string[] = [];
    for (let i = 1; OptionMenu._flat[i]; i++) flat.push(OptionMenu._flat[i].id);
    expect(flat).not.toContain("orientation");
    expect(flat).not.toContain("touchControls");
    frame("menus_b_options_top.png", () => OptionMenu.draw());

    // SPEED group -> TEXT SPEED
    OptionMenu.handleInput(pad("a"));
    const speed = OptionMenu._pages[2];
    expect(speed.rows[1].id).toBe("textSpeed");
    const block = Options.block(OptionMenu._ctx.options);
    const before = block.textSpeed ?? 0;
    const label0 = speed.rows[1].value(OptionMenu._ctx);
    OptionMenu.handleInput(pad("right"));
    expect(block.textSpeed).toBe((before + 1) % 3);
    const label1 = speed.rows[1].value(OptionMenu._ctx);
    expect(label1).not.toBe(label0);
    expect(label1).toBe(RomText.at("sTextSpeedOptions", block.textSpeed));
    frame("menus_b_options_speed.png", () => OptionMenu.draw());
    // the blue help bar across the top
    expect(px(4, 4)).toEqual([0, 123, 197]);
    OptionMenu.handleInput(pad("left"));
    expect(block.textSpeed).toBe(before);
    // inert desktop rows do nothing harmful: their stored value survives a step
    const video = Rows.build(OptionMenu._ctx);
    let vsync: any;
    for (let i = 1; video[i]; i++) if (video[i].id === "vsync") vsync = video[i];
    OptionMenu._ctx.options.vsync = "adaptive";
    vsync.step(OptionMenu._ctx, 1);
    expect(OptionMenu._ctx.options.vsync).toBe("adaptive");
    expect(vsync.value(OptionMenu._ctx)).toBe("----");
    OptionMenu.handleInput(pad("b"));
    expect(OptionMenu._pages.length - 1 >= 1).toBe(true);
    OptionMenu.handleInput(pad("b"));
    expect(OptionMenu.isOpen()).toBe(false);
  });

  test("trainer card: front and back of the FireRed card", () => {
    Stack.clear();
    TrainerCard.show({ session });
    const c = TrainerCard._card;
    expect(c.playerName).toBe("RED");
    expect(c.trainerId).toBe(24601);
    expect(c.money).toBe(session.money);
    expect(c.hasPokedex).toBe(true);
    expect(c.caughtMonsCount).toBe(3);
    expect(c.badges[1]).toBe(true);
    expect(c.badges[2]).toBe(true);
    expect(c.badges[3]).toBe(false);
    expect(TrainerCard.countBadges(session)).toBe(2);
    const texts = TrainerCard.frontTexts(c, false).map((t: any) => t.text);
    expect(texts).toContain(RomText.plain("gText_TrainerCardIDNo") + "24601");
    expect(texts).toContain(" 12");
    expect(texts).toContain("34");
    frame("menus_b_tcard_front.png", () => TrainerCard.draw());
    // the card art covers the screen (not the fallback rectangles)
    expect(ink(0, 0, 240, 160, [64, 128, 89])).toBeGreaterThan(30000);
    // A flips: down 77 in steps of 7, then up in steps of 5
    TrainerCard.handleInput(pad("a"));
    expect(TrainerCard._flip).toBeDefined();
    for (let i = 0; i < 6; i++) TrainerCard.update();
    frame("menus_b_tcard_flip.png", () => TrainerCard.draw());
    for (let i = 0; i < 40 && TrainerCard._flip; i++) TrainerCard.update();
    expect(TrainerCard._flip).toBeUndefined();
    expect(TrainerCard.side).toBe("back");
    frame("menus_b_tcard_back.png", () => TrainerCard.draw());
    TrainerCard.handleInput(pad("a")); // A on the back closes
    expect(TrainerCard.isOpen()).toBe(false);
  });

  test("pokedex: table of contents, the numerical list, an entry (both pages)", () => {
    Stack.clear();
    Pokedex.show(session.dex, { session });
    expect(Pokedex.screen).toBe("mode_select");
    expect(Pokedex.MODES[Pokedex.modeCursor].id).toBe("numerical_kanto");
    frame("menus_b_dex_toc.png", () => Pokedex.draw());
    Pokedex.handleInput(pad("a"));
    expect(Pokedex.screen).toBe("ordered_list");
    frame("menus_b_dex_list.png", () => Pokedex.draw());
    // BULBASAUR is caught: open its entry
    Pokedex.handleInput(pad("a"));
    expect(Pokedex.screen).toBe("data");
    expect(Pokedex.selectedSpecies).toBe(1);
    frame("menus_b_dex_entry.png", () => Pokedex.draw());
    Pokedex.handleInput(pad("a"));
    expect(Pokedex.dataPage).toBe(2);
    frame("menus_b_dex_entry2.png", () => Pokedex.draw());
    Pokedex.handleInput(pad("a"));
    expect(Pokedex.screen).toBe("ordered_list");
    // down to PIKACHU's row (25), seen + caught
    for (let i = 0; i < 24; i++) Pokedex.handleInput(pad("down"));
    expect(Pokedex.listCursor).toBe(25);
    frame("menus_b_dex_list25.png", () => Pokedex.draw());
    Pokedex.handleInput(pad("b"));
    Pokedex.handleInput(pad("b"));
    expect(Pokedex.isOpen()).toBe(false);
  });

  test("coins and berry powder boxes register lazily and draw", () => {
    const Coins = G3Lazy["src.ui.game3.coins_box"];
    const Powder = G3Lazy["src.ui.game3.berry_powder_box"];
    expect(Coins).toBeDefined();
    expect(Powder).toBeDefined();
    Coins.show(0, 5, 12345);
    expect(Coins.amount()).toBe(9999);
    Powder.show(321);
    expect(Powder.amountText(Powder.amount())).toBe("  321");
    frame("menus_b_coins_powder.png", () => { Coins.draw(); Powder.draw(); });
    Coins.hide();
    Powder.hide();
  });

  test("save: through save_menu into a memory save store, and it reloads", () => {
    setSaveStore(memorySaveStore());
    SaveData.resetSlotState();
    Stack.clear();
    SaveMenu.show({ session, game });
    expect(SaveMenu.locationName(session)).toBe("PALLET TOWN");
    expect(SaveMenu.countBadges(session)).toBe(2);
    expect(SaveMenu.countDex(session)).toBe(3);
    frame("menus_b_save_confirm.png", () => SaveMenu.draw());
    SaveMenu.confirm(); // YES -> overwrite?
    expect(SaveMenu._phase).toBe("overwrite");
    SaveMenu.confirm(); // YES -> write
    expect(SaveMenu._error).toBeUndefined();
    expect(SaveMenu._phase).toBe("saved");
    frame("menus_b_save_done.png", () => SaveMenu.draw());
    SaveMenu.confirm();
    expect(SaveMenu.isOpen()).toBe(false);

    const [back] = SaveData.load("firered");
    expect(back).toBeDefined();
    expect(back.name).toBe("RED");
    expect(back.money).toBe(session.money);
    expect(back.trainerId).toBe(24601);
    const reloaded = Schema.fromSaveTable(back);
    expect(Dex.isCaught(reloaded.dex, 25)).toBe(true);
    expect(Flags.getFlag({ flags: reloaded.flags }, null, 0x821)).toBe(true);
    expect(saveStore().read(SaveData.saveFilename())).toContain('name = "RED"');
  });
});
