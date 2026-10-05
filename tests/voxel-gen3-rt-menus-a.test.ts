// The gen3 runtime's party, summary and PC screens (ui/party_menu,
// party_chrome, summary_menu, summary_chrome, box_storage_ui, pc_chrome,
// pc_menu, item_pc) on real FireRed cache data: a party of three real mons,
// each screen drawn through the love.graphics shim into the DesktopHost
// rasteriser (PNGs in /tmp/g3shots), and the cursors driven with Input actions.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { G } from "../voxelmon/game/gen3/platform/graphics.ts";
import { encodePng } from "../voxelmon/import/gen3/png.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const GBA = join(ROOT, "data/generated/gba");
const SHOTS = "/tmp/g3shots";

function shot(host: DesktopHost, name: string): void {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), encodePng(240, 160, host.pixels()));
}
function px(host: DesktopHost, x: number, y: number): [number, number, number] {
  const p = host.pixels(), o = (y * 240 + x) * 4;
  return [p[o]!, p[o + 1]!, p[o + 2]!];
}
/** A region's distinct colours. */
function colours(host: DesktopHost, x0: number, y0: number, w: number, h: number): Set<string> {
  const s = new Set<string>();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) s.add(px(host, x, y).join(","));
  return s;
}
interface Sheet { w: number; h: number; px: Uint8Array }
function sheet(rel: string, w: number, h: number): Sheet {
  const b = new Uint8Array(readFileSync(join(GBA, rel)));
  expect(b.length).toBe(w * h * 4);
  return { w, h, px: b };
}
/** Every opaque texel of an 8x8 sheet tile drawn at (dx, dy) matches the screen. */
function tileMatches(host: DesktopHost, s: Sheet, tile: number, dx: number, dy: number): { bad: number; ink: number } {
  let bad = 0, ink = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const o = (y * s.w + tile * 8 + x) * 4;
    if (s.px[o + 3] !== 255) continue;
    ink++;
    const got = px(host, dx + x, dy + y);
    if (got[0] !== s.px[o] || got[1] !== s.px[o + 1] || got[2] !== s.px[o + 2]) bad++;
  }
  return { bad, ink };
}

describe.skipIf(!existsSync(GBA))("gen3 runtime: party, summary and PC screens", async () => {
  const host = new DesktopHost(ROOT);
  setHost(host);
  const { seq, len } = await import("../voxelmon/game/gen3/platform/lt.ts");
  const { Input } = await import("../voxelmon/game/gen3/shared/core/Input.ts");
  const { Party } = await import("../voxelmon/game/gen3/core/party.ts");
  const { Storage } = await import("../voxelmon/game/gen3/core/storage.ts");
  const { Stack } = await import("../voxelmon/game/gen3/ui/stack.ts");
  const { SummaryMenu } = await import("../voxelmon/game/gen3/ui/summary_menu.ts");
  const { SummaryChrome } = await import("../voxelmon/game/gen3/ui/summary_chrome.ts");
  const { BoxStorageUI } = await import("../voxelmon/game/gen3/ui/box_storage_ui.ts");
  const { PcChrome } = await import("../voxelmon/game/gen3/ui/pc_chrome.ts");
  const { PartyMenu } = await import("../voxelmon/game/gen3/ui/party_menu.ts");

  // A party of three real mons: VENUSAUR 36 (full HP), PIKACHU 22 (half: a
  // yellow bar), GYARADOS 30 (low: a red bar).
  const session: any = { name: "RED", trainerId: 31337, party: seq() };
  for (const [sp, lv] of [[3, 36], [25, 22], [130, 30]] as [number, number][]) {
    const [ok] = Party.giveMon(session, sp, lv);
    expect(ok).toBe(true);
  }
  const [venusaur, pikachu, gyarados] = [session.party[1], session.party[2], session.party[3]];
  pikachu.hp = Math.floor(pikachu.maxHp / 2);
  gyarados.hp = Math.max(1, Math.floor(gyarados.maxHp / 6));
  Storage.ensure(session);

  /** One press of a button through the real Input module, handed to a screen. */
  function tap(btn: string, handle: (input: any) => void): void {
    Input.sourcePress(btn, "test");
    Input.step();
    handle(Input);
    Input.sourceRelease(btn, "test");
    Input.step();
  }
  function frame(draw: () => void, name?: string): void {
    G.beginFrame();
    G.clear(0, 0, 0, 1);
    draw();
    G.endFrame();
    if (name) shot(host, name);
  }

  test("the party is three real mons", () => {
    expect(len(session.party)).toBe(3);
    expect(venusaur.species).toBe(3);
    expect(venusaur.maxHp).toBeGreaterThan(90);
    expect(venusaur.hp).toBe(venusaur.maxHp);
  });

  test("summary: INFO, SKILLS, MOVES and the move detail page, driven by Input", () => {
    Stack.clear();
    SummaryMenu.openMenu(session.party, 1, { session });
    expect(SummaryMenu.isOpen()).toBe(true);
    expect(SummaryMenu._page).toBe(SummaryMenu.PAGE_INFO);
    const settle = (): void => { for (let i = 0; i < 30; i++) SummaryMenu.update(1 / 60); };
    settle();
    frame(() => SummaryMenu.draw(), "summary_info.png");
    const info = host.pixels().slice();

    tap("right", (i) => SummaryMenu.handleInput(i));
    expect(SummaryMenu._page).toBe(SummaryMenu.PAGE_SKILLS);
    // a frame mid-slide draws too
    SummaryMenu.update(1 / 60 * 8);
    frame(() => SummaryMenu.draw(), "summary_slide.png");
    settle();
    frame(() => SummaryMenu.draw(), "summary_skills.png");
    expect(Buffer.compare(Buffer.from(info), Buffer.from(host.pixels()))).not.toBe(0);

    // The HP bar on SKILLS is the ROM's hp_bar_green tiles: the "HP" label
    // (tile 9) and the left cap (tile 10) at the manifest's hpBar position.
    const m = SummaryChrome.manifest();
    const bar = (m && m.coords && m.coords.hpBar) ?? { x: 168, y: 32 };
    const green = sheet("pokemon/summary/hp_bar_green.rgba", 96, 8);
    const label = tileMatches(host, green, 9, bar.x, bar.y);
    expect(label.ink).toBeGreaterThan(5);
    expect(label.bad).toBe(0);
    const full = tileMatches(host, green, 8, bar.x + 2 * 8, bar.y); // a full fill tile
    expect(full.bad).toBe(0);

    tap("right", (i) => SummaryMenu.handleInput(i));
    settle();
    expect(SummaryMenu._page).toBe(SummaryMenu.PAGE_MOVES);
    frame(() => SummaryMenu.draw(), "summary_moves.png");

    tap("a", (i) => SummaryMenu.handleInput(i));
    settle();
    expect(SummaryMenu._page).toBe(SummaryMenu.PAGE_MOVES_INFO);
    frame(() => SummaryMenu.draw(), "summary_moves_info.png");

    // down a mon, then the SKILLS page shows PIKACHU's yellow bar
    tap("b", (i) => SummaryMenu.handleInput(i));
    settle();
    tap("left", (i) => SummaryMenu.handleInput(i));
    settle();
    tap("down", (i) => SummaryMenu.handleInput(i));
    settle();
    expect(SummaryMenu._cursor).toBe(2);
    expect(SummaryMenu._page).toBe(SummaryMenu.PAGE_SKILLS);
    frame(() => SummaryMenu.draw(), "summary_skills_pikachu.png");
    const yellow = sheet("pokemon/summary/hp_bar_yellow.rgba", 96, 8);
    expect(tileMatches(host, yellow, 9, bar.x, bar.y).bad).toBe(0);
    tap("down", (i) => SummaryMenu.handleInput(i));
    settle();
    frame(() => SummaryMenu.draw(), "summary_skills_gyarados.png");
    const red = sheet("pokemon/summary/hp_bar_red.rgba", 96, 8);
    expect(tileMatches(host, red, 9, bar.x, bar.y).bad).toBe(0);

    tap("b", (i) => SummaryMenu.handleInput(i));
    expect(SummaryMenu.isOpen()).toBe(false);
  });

  test("summary: the move swap on the detail page reorders the moves", () => {
    Stack.clear();
    SummaryMenu.openMenu(session.party, 1, { session, page: SummaryMenu.PAGE_MOVES });
    const before = [venusaur.moves[1], venusaur.moves[2]];
    tap("a", (i) => SummaryMenu.handleInput(i));
    for (let i = 0; i < 30; i++) SummaryMenu.update(1 / 60);
    tap("a", (i) => SummaryMenu.handleInput(i)); // pick move 1
    tap("down", (i) => SummaryMenu.handleInput(i));
    frame(() => SummaryMenu.draw(), "summary_move_swap.png");
    tap("a", (i) => SummaryMenu.handleInput(i)); // swap with move 2
    expect([venusaur.moves[1], venusaur.moves[2]]).toEqual([before[1], before[0]]);
    tap("a", (i) => SummaryMenu.handleInput(i)); // and back
    tap("up", (i) => SummaryMenu.handleInput(i));
    tap("a", (i) => SummaryMenu.handleInput(i));
    expect([venusaur.moves[1], venusaur.moves[2]]).toEqual(before);
    SummaryMenu.close();
  });

  test("PC box view: wallpaper, frame, mon icons; move a mon from box 1 to box 2", () => {
    Stack.clear();
    const st = Storage.ensure(session);
    // a box mon: deposit a fourth mon given straight to box 1 slot 1
    const extra: any = { name: "RED", trainerId: 31337, party: seq() };
    Party.giveMon(extra, 1, 12); // BULBASAUR
    const bulba = extra.party[1];
    st.boxes[1]!.mons[1] = bulba;
    st.currentBox = 1;

    BoxStorageUI.show({ session, subMode: "move" });
    expect(BoxStorageUI.isOpen()).toBe(true);
    for (let i = 0; i < 10; i++) BoxStorageUI.update(1 / 60);
    frame(() => BoxStorageUI.draw(), "pc_box1.png");
    // the wallpaper fills 80..240 x 16..160 with many colours; box 1 is FOREST
    expect(colours(host, 80, 40, 160, 100).size).toBeGreaterThan(4);
    const box1 = host.pixels().slice();

    // A on slot 1 -> action menu; MOVE is the first row
    tap("a", (i) => BoxStorageUI.handleInput(i));
    expect(BoxStorageUI.mode).toBe("action_menu");
    frame(() => BoxStorageUI.draw(), "pc_action_menu.png");
    tap("a", (i) => BoxStorageUI.handleInput(i));
    expect(BoxStorageUI.holdingMon).toBe(bulba);
    // up to the box title, right to box 2, down to slot 1, A to drop
    tap("up", (i) => BoxStorageUI.handleInput(i));
    expect(BoxStorageUI.cursorSlot).toBe(0);
    tap("right", (i) => BoxStorageUI.handleInput(i));
    expect(st.currentBox).toBe(2);
    frame(() => BoxStorageUI.draw(), "pc_box2_holding.png");
    expect(Buffer.compare(Buffer.from(box1), Buffer.from(host.pixels()))).not.toBe(0);
    tap("down", (i) => BoxStorageUI.handleInput(i));
    tap("a", (i) => BoxStorageUI.handleInput(i));
    expect(BoxStorageUI.holdingMon).toBeNull();
    expect(st.boxes[2]!.mons[1]).toBe(bulba);
    expect(st.boxes[1]!.mons[1] ?? null).toBeNull();
    frame(() => BoxStorageUI.draw(), "pc_box2.png");

    // the party drawer: up twice to PARTY POKeMON, A
    tap("up", (i) => BoxStorageUI.handleInput(i));
    tap("up", (i) => BoxStorageUI.handleInput(i));
    expect(BoxStorageUI.cursorSlot).toBe(-10);
    tap("a", (i) => BoxStorageUI.handleInput(i));
    expect(BoxStorageUI.mode).toBe("party_drawer");
    frame(() => BoxStorageUI.draw(), "pc_party_drawer.png");
    tap("b", (i) => BoxStorageUI.handleInput(i));
    tap("b", (i) => BoxStorageUI.handleInput(i));
    expect(BoxStorageUI.isOpen()).toBe(false);
    expect(PcChrome.wallpaperNames()[1]).toBe("forest");
  });

  test("party menu: draws the slots and HP bars, and SWITCH reorders the party", () => {
    Stack.clear();
    PartyMenu.show(session.party, null, { session });
    expect(PartyMenu.open).toBe(true);
    expect(PartyMenu.mode).toBe("list");
    expect(PartyMenu.cursor).toBe(1);
    for (let i = 0; i < 30; i++) PartyMenu.update(1 / 60);
    frame(() => PartyMenu.draw(), "party_menu.png");
    // the background, three filled slots and their HP bars draw something
    expect(colours(host, 0, 0, 240, 160).size).toBeGreaterThan(12);
    const first = host.pixels().slice();

    // Move the cursor: down to PIKACHU, the frame changes
    tap("down", (i) => PartyMenu.handleInput(i));
    expect(PartyMenu.cursor).toBe(2);
    PartyMenu.update(1 / 60);
    frame(() => PartyMenu.draw(), "party_menu_cursor2.png");
    expect(Buffer.compare(Buffer.from(first), Buffer.from(host.pixels()))).not.toBe(0);
    tap("up", (i) => PartyMenu.handleInput(i));
    expect(PartyMenu.cursor).toBe(1);

    // A -> the action list; down to SWITCH (VENUSAUR knows no field move)
    tap("a", (i) => PartyMenu.handleInput(i));
    expect(PartyMenu.mode).toBe("action");
    frame(() => PartyMenu.draw(), "party_menu_actions.png");
    const actions: string[] = [];
    for (let i = 1; i <= len(PartyMenu.ACTIONS); i++) {
      const a = PartyMenu.ACTIONS[i];
      actions.push(String(typeof a === "object" && a ? (a.id ?? a.label ?? a.name) : a));
    }
    let sw = 1;
    while (!/switch/i.test(actions[PartyMenu.actionCursor - 1] ?? "") && sw++ < 8) {
      tap("down", (i) => PartyMenu.handleInput(i));
    }
    expect(actions[PartyMenu.actionCursor - 1]).toMatch(/switch/i);
    tap("a", (i) => PartyMenu.handleInput(i));
    expect(PartyMenu.mode).toBe("switch");
    expect(PartyMenu.switchFrom).toBe(1);
    tap("down", (i) => PartyMenu.handleInput(i));
    tap("down", (i) => PartyMenu.handleInput(i));
    expect(PartyMenu.cursor).toBe(3);
    frame(() => PartyMenu.draw(), "party_menu_switching.png");
    tap("a", (i) => PartyMenu.handleInput(i));
    for (let i = 0; i < 60; i++) PartyMenu.update(1 / 60);
    expect(session.party[1]).toBe(gyarados);
    expect(session.party[3]).toBe(venusaur);
    expect(session.party[2]).toBe(pikachu);
    expect(PartyMenu.mode).toBe("list");
    frame(() => PartyMenu.draw(), "party_menu_switched.png");

    tap("b", (i) => PartyMenu.handleInput(i));
    expect(PartyMenu.open).toBe(false);
  });
});
