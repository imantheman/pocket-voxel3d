// The Gold boot screens and the shared view helpers (voxelmon/game/gen2/ui:
// CopyrightSplash, MainMenu, BlankScreen, MenuFade, WaitPlaySFX, IntroFade,
// Typer, TileSheet; shared MonAnim, Marquee, GameSpeed, LogicClock, Palette,
// Sprites), then the whole boot end to end through Game2: copyright ->
// GAME FREAK -> intro -> title -> main menu -> Oak -> name -> the world's
// handoff. Shots of each stage go to $GOLD_SHOTS.

import { describe, expect, test } from "bun:test";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd, LCD_HOLE, renderLcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { GameSpeed } from "../voxelmon/game/gen2/shared/core/GameSpeed.ts";
import { LogicClock } from "../voxelmon/game/gen2/shared/core/LogicClock.ts";
import { MonAnim } from "../voxelmon/game/gen2/shared/render/MonAnim.ts";
import { Palette } from "../voxelmon/game/gen2/shared/render/Palette.ts";
import { GbcPalette } from "../voxelmon/game/gen2/shared/render/GbcPalette.ts";
import { Sprites } from "../voxelmon/game/gen2/shared/pokemon/Sprites.ts";
import { Marquee } from "../voxelmon/game/gen2/shared/ui/Marquee.ts";
import { BlankScreen } from "../voxelmon/game/gen2/ui/BlankScreen.ts";
import { CopyrightSplash } from "../voxelmon/game/gen2/ui/CopyrightSplash.ts";
import { IntroFade } from "../voxelmon/game/gen2/ui/IntroFade.ts";
import { MainMenu } from "../voxelmon/game/gen2/ui/MainMenu.ts";
import { MenuFade } from "../voxelmon/game/gen2/ui/MenuFade.ts";
import { TileSheet } from "../voxelmon/game/gen2/ui/TileSheet.ts";
import { Typer } from "../voxelmon/game/gen2/ui/Typer.ts";
import { WaitPlaySFX } from "../voxelmon/game/gen2/ui/WaitPlaySFX.ts";

const gold = haveGoldGen();
const SHOTS = process.env.GOLD_SHOTS;

async function shot(lcd: Lcd, name: string): Promise<void> {
  if (!SHOTS) return;
  const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  shotLcd(lcd.s, `${SHOTS}/${name}.png`);
}

async function boot(): Promise<{ game: Game2; lcd: Lcd }> {
  useGoldGen();
  const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  useGoldTiles();
  const game = Game2.new();
  const lcd = new Lcd(new RecorderHost());
  setLcd(lcd);
  return { game, lcd };
}

/** A game whose data is loaded but whose boot screens are not pushed. */
async function loaded(): Promise<{ game: Game2; lcd: Lcd }> {
  const r = await boot();
  r.game.load({ startWorld: false });
  r.game.stack.clear();
  return r;
}

function frameInk(lcd: Lcd): number {
  // how many cells are not holes and not blank tile 0
  let n = 0;
  for (let ty = 0; ty < 18; ty++) for (let tx = 0; tx < 20; tx++) if (lcd.s.attrs[ty * 32 + tx]! & 0x10 ? false : lcd.s.cells[ty * 32 + tx] !== 0) n++;
  return n;
}

describe("gen2 shared view helpers", () => {
  test("Typer types a page one letter per delay and reveals by span", () => {
    useGoldGen();
    const game = { save: { options: { textSpeed: "MID" } }, input: { isDown: () => false } };
    const screen: any = { game };
    Typer.say(screen, ["AB\nC", "NEXT"]);
    expect(screen.typer.total).toBe(3);
    expect(Typer.text(screen)).toEqual(["", ""]);
    Typer.step(screen);
    Typer.step(screen);
    expect(Typer.typing(screen)).toBe(true);
    Typer.step(screen);
    expect(Typer.text(screen)).toEqual(["A", ""]);
    for (let i = 0; i < 6; i++) Typer.step(screen);
    expect(Typer.typing(screen)).toBe(false);
    expect(Typer.text(screen)).toEqual(["AB", "C"]);
    Typer.turn(screen, screen.message);
    expect(screen.message.page).toBe(2);
    expect(screen.typer.page).toEqual(["NEXT"]);
    expect(Typer.arrowOn({ arrowBlink: 15 })).toBe(true);
    expect(Typer.arrowOn({ arrowBlink: 16 })).toBe(false);
  });

  test("IntroFade steps rBGP through the cart's rows, 8 frames a step", () => {
    const owner: any = {};
    let done = false;
    IntroFade.run(owner, ["outWhite", "inBlack"], () => (done = true));
    expect(owner.fade.bgp()).toBe(0x90);
    for (let i = 0; i < 8; i++) IntroFade.advance(owner);
    expect(owner.fade.bgp()).toBe(0x40);
    for (let i = 0; i < 16; i++) IntroFade.advance(owner);
    expect(owner.fade.kind).toBe("inBlack");
    expect(owner.fade.bgp()).toBe(0xff);
    for (let i = 0; i < 32; i++) IntroFade.advance(owner);
    expect(done).toBe(true);
    expect(IntroFade.busy(owner)).toBe(false);
    expect(IntroFade.frames("outBlack")).toBe(32);
    // paint folds the byte into the palette draws go through, then restores it
    IntroFade.run(owner, ["outBlack"]);
    for (let i = 0; i < 24; i++) IntroFade.advance(owner);
    let inside: number | null = null;
    IntroFade.paint(owner, 160, 144, () => (inside = GbcPalette.bgp));
    expect(inside!).toBe(0xff);
    expect(GbcPalette.bgp).toBe(null);
  });

  test("MonAnim runs a script with repeats and the bitmask tile map", () => {
    // frame 1 for 2 ticks, repeat twice back to row 2, end
    const data = {
      tiles: 5,
      play: [[0xfe, 2], [1, 2], [0xfd, 1], [0xff, 0]],
      frames: [{ bitmask: 1, tiles: [100, 101] }],
      bitmasks: [[0b101, 0, 0, 0]],
    };
    const anim = MonAnim.new(data, "battle")!;
    anim.update(); // setup
    const frames: number[] = [];
    for (let i = 0; i < 20 && !anim.finished(); i++) {
      anim.update();
      frames.push(anim.currentFrame());
    }
    expect(anim.finished()).toBe(true);
    expect(frames.filter((f) => f === 1).length).toBeGreaterThanOrEqual(2);
    const map = MonAnim.tileMap(data, 1)!;
    expect(map[0]).toBe(100);
    expect(map[1]).toBe(1);
    expect(map[2]).toBe(101);
    expect(MonAnim.duration(10, 4)).toBe(12);
  });

  test("Marquee, GameSpeed, LogicClock and Palette keep the Lua's arithmetic", () => {
    expect(Marquee.at("ABCDEFGH", 6, 0)).toBe("ABCDEF");
    expect(Marquee.at("ABCDEFGH", 6, 1.3)).toBe("BCDEFG");
    expect(Marquee.at("ABCDEFGH", 6, 1.9)).toBe("CDEFGH");
    expect(GameSpeed.levelLabel(1)).toBe("NORMAL");
    expect(GameSpeed.cycle(200, 1)).toBe(1);
    expect(GameSpeed.clamp(7)).toBe(4);
    expect(GameSpeed.optionKey("battle")).toBe("speedBattle");
    expect(LogicClock.cycle("60")).toBe("gb");
    expect(LogicClock.label("gb")).toBe("59.73HZ");
    expect(Palette.ramp("m:9bbc0f")![0]).toEqual([155, 188, 15]);
    expect(Palette.label("m:9bbc0f")).toBe("GREEN");
    expect(Palette.categoryOf(Palette.monoRamp(0xff, 0x50, 0x50))).toBe("single");
  });

  test.skipIf(!gold)("Sprites resolves the vanilla pic as [path, trueColor]; TileSheet draws cells", async () => {
    const { game, lcd } = await loaded();
    const [path, tc] = Sprites.path(game.data, "MARILL", "front");
    expect(path).toBe("battle/front/marill");
    expect(tc).toBe(false);
    lcd.begin();
    resetDrawState();
    const sheet = TileSheet.new({ path: "battle/front/marill", wide: 7 });
    expect(sheet.available()).toBe(true);
    expect(sheet.draw(3, 2, 2)).toBe(true);
    expect(lcd.s.cells[2 * 32 + 2]).toBe(sheet.image()!.ids[3]);
    expect(TileSheet.new({ path: "no/such" }).available()).toBe(false);
  });

  test("WaitPlaySFX holds no longer than its frame budget", () => {
    const pending = WaitPlaySFX.arm("SFX_NOPE", 3);
    expect(pending.name).toBe("SFX_NOPE");
    let n = 0;
    while (WaitPlaySFX.waiting(pending) && n < 100) n++;
    expect(n).toBeLessThanOrEqual(3);
    expect(WaitPlaySFX.waiting(null)).toBe(false);
  });
});

describe("gen2 boot screens", () => {
  test.skipIf(!gold)("the copyright card: the cooked splash, 100 frames, A skips", async () => {
    const { game, lcd } = await loaded();
    let done = 0;
    const card = CopyrightSplash.new(game, { title: game.titleData, onDone: () => done++ });
    expect(card.image).not.toBe(null);
    game.stack.push(card);
    for (let i = 0; i < 99; i++) game.frame(0);
    expect(done).toBe(0);
    game.draw(lcd);
    // opaque: no holes, and the card's lines have ink
    const f = renderLcd(lcd.s, () => 0);
    expect(f.includes(LCD_HOLE)).toBe(false);
    expect(frameInk(lcd)).toBeGreaterThan(10);
    await shot(lcd, "boot_copyright");
    game.frame(0);
    expect(done).toBe(1);
    game.frame(0);
    expect(done).toBe(1);
    const skip = CopyrightSplash.new(game, { title: game.titleData, onDone: () => done++ });
    game.stack.clear();
    game.stack.push(skip);
    game.frame(0);
    game.frame(VOX_BTN.a);
    expect(done).toBe(2);
  });

  test.skipIf(!gold)("the main menu: NEW GAME/OPTION without a save; CONTINUE's panel with one", async () => {
    const { game, lcd } = await loaded();
    const picked: string[] = [];
    const menu = MainMenu.new(game, {
      hasSave: false,
      onNewGame: () => picked.push("new"),
      onOption: () => picked.push("option"),
    });
    expect(menu.list.items.map((i) => i.label)).toEqual(["NEW GAME", "OPTION"]);
    game.stack.push(menu);
    game.frame(0);
    game.draw(lcd);
    await shot(lcd, "boot_mainmenu");
    expect(renderLcd(lcd.s, () => 0).includes(LCD_HOLE)).toBe(false);
    game.frame(VOX_BTN.down);
    game.frame(0);
    game.frame(VOX_BTN.a);
    expect(picked).toEqual(["option"]);

    const save = { player: { name: "GOLD" }, badges: [], pokedex: { caught: {} }, playTime: { hours: 3, minutes: 7 } };
    const cont: unknown[] = [];
    const withSave = MainMenu.new(game, {
      save,
      clock: { hour: 9, minute: 5, weekday: 2 },
      onContinue: (s) => cont.push(s),
    });
    expect(withSave.list.items[0]!.label).toBe("CONTINUE");
    game.stack.clear();
    game.stack.push(withSave);
    game.frame(0);
    game.draw(lcd);
    await shot(lcd, "boot_mainmenu_save");
    game.frame(VOX_BTN.a);
    expect(withSave.phase).toBe("confirm");
    game.frame(0);
    game.frame(VOX_BTN.a); // inside the 20-frame delay: ignored
    expect(cont.length).toBe(0);
    for (let i = 0; i < 20; i++) game.frame(0);
    game.draw(lcd);
    await shot(lcd, "boot_continue_panel");
    game.frame(VOX_BTN.a);
    expect(cont).toEqual([save]);
  });

  test.skipIf(!gold)("BlankScreen holds white 4 frames; MenuFade ramps and pops itself", async () => {
    const { game, lcd } = await loaded();
    let blank = 0;
    game.stack.push(BlankScreen.new(game, { onDone: () => blank++ }));
    for (let i = 0; i < 3; i++) game.frame(0);
    expect(blank).toBe(0);
    game.frame(0);
    expect(blank).toBe(1);

    game.stack.clear();
    let faded = 0;
    const fade = MenuFade.new(game, { kind: "out", white: 4, onDone: () => faded++ });
    expect(fade.total).toBe(MenuFade.OUT_FRAMES + 4);
    expect(fade.level()).toBe(0.25);
    expect(fade.bgp()).toBe(0x90);
    game.stack.push(fade);
    for (let i = 0; i < 7; i++) game.frame(0);
    expect(fade.level()).toBe(1);
    lcd.begin();
    resetDrawState();
    fade.drawWidescreen(160, 144);
    expect(renderLcd(lcd.s, () => 0).includes(LCD_HOLE)).toBe(false);
    for (let i = 0; i < 6; i++) game.frame(0);
    expect(faded).toBe(1);
    expect(game.stack.top()).toBeUndefined();
    const back = MenuFade.new(game, { kind: "in", white: 2 });
    expect(back.level()).toBe(1);
    back.frame = 5;
    expect(back.level()).toBe(0.5);
    expect(MenuFade.openWhite("pokemon", 3)).toBe(MenuFade.PARTY_WHITE + 9);
    expect(MenuFade.closeWhite("pokegear")).toBe(MenuFade.exitWhite() + 4);
  });
});

describe("gen2 boot, end to end", () => {
  test.skipIf(!gold)(
    "copyright -> GAME FREAK -> intro -> title -> main menu -> Oak -> name -> the world",
    async () => {
      const { game, lcd } = await boot();
      let handoff = 0;
      (game as any).startWorld = () => {
        handoff++;
        game.phase = "play";
        return true;
      };
      game.load();
      const seen: string[] = [];
      const firstFrame: Record<string, number> = {};
      let name = "";
      let at = 0;
      const shots: [string, number][] = [];
      const MAX = 40000;
      let f = 0;
      for (; f < MAX && handoff === 0; f++) {
        const top = game.stack.top() as any;
        const now = top?.constructor?.name ?? "none";
        if (now !== name) {
          name = now;
          at = 0;
          if (!(now in firstFrame)) {
            firstFrame[now] = f;
            seen.push(now);
          }
        }
        at++;
        let buttons = 0;
        const tap = (bit: number, every = 8): number => (at % every === 0 ? bit : 0);
        switch (name) {
          case "TitleState":
            if (at > 240) buttons = tap(VOX_BTN.start);
            break;
          case "MainMenu":
            if (at > 30) buttons = tap(VOX_BTN.a, 12);
            break;
          case "CopyrightSplash":
          case "GameFreakPresents":
          case "GoldSilverIntro":
            break;
          default:
            // Oak's speech and everything it pushes: keep pressing A
            buttons = tap(VOX_BTN.a, 10);
        }
        game.frame(buttons);
        game.draw(lcd);
        const stageShot = (label: string, when: number): void => {
          if (at === when) shots.push([label, f]);
        };
        if (name === "CopyrightSplash") stageShot("e2e_01_copyright", 60);
        if (name === "GameFreakPresents") {
          stageShot("e2e_02_gamefreak_a", 120);
          stageShot("e2e_02_gamefreak_b", 300);
        }
        if (name === "GoldSilverIntro" && at % 450 === 100) shots.push([`e2e_03_intro_${String(Math.floor(at / 450)).padStart(2, "0")}`, f]);
        if (name === "TitleState") stageShot("e2e_04_title", 200);
        if (name === "MainMenu") stageShot("e2e_05_mainmenu", 20);
        if (name !== "TitleState" && name !== "MainMenu" && !["CopyrightSplash", "GameFreakPresents", "GoldSilverIntro"].includes(name) && at % 100 === 5) {
          shots.push([`e2e_06_${name}_${String(f).padStart(5, "0")}`, f]);
        }
        if (shots.length && shots[shots.length - 1]![1] === f) await shot(lcd, shots[shots.length - 1]![0]);
      }
      console.log("boot stages:", seen.map((s) => `${s}@${firstFrame[s]}`).join(" -> "), "handoff at", f);
      expect(seen.slice(0, 7)).toEqual(["CopyrightSplash", "GameFreakPresents", "GoldSilverIntro", "TitleState", "MainMenu", "InitClock", "OakSpeech"]);
      expect(seen).toContain("NamePick");
      expect(seen).toContain("NamingScreen");
      expect(handoff).toBe(1);
    },
    600_000,
  );
});

