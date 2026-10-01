// The Gold boot cinema (voxelmon/game/gen2/ui): the sprite-anim runtime
// (SpriteAnims), the GAME FREAK splash (GameFreakPresents), the Gold intro
// movie (GoldSilverIntro) and the title screen (TitleState), each driven
// through Game2's own boot calls with the real cooked data. Shots of the
// main states go to $GOLD_SHOTS.

import { describe, expect, test } from "bun:test";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd, LCD_HOLE, renderLcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { GameFreakPresents } from "../voxelmon/game/gen2/ui/GameFreakPresents.ts";
import { GoldSilverIntro } from "../voxelmon/game/gen2/ui/GoldSilverIntro.ts";
import { SpriteAnims } from "../voxelmon/game/gen2/ui/SpriteAnims.ts";
import { TitleState } from "../voxelmon/game/gen2/ui/TitleState.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";

const gold = haveGoldGen();
const SHOTS = process.env.GOLD_SHOTS;

async function shot(lcd: Lcd, name: string): Promise<void> {
  if (!SHOTS) return;
  const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  shotLcd(lcd.s, `${SHOTS}/${name}.png`);
}

async function loaded(): Promise<{ game: Game2; lcd: Lcd }> {
  useGoldGen();
  const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  useGoldTiles();
  const game = Game2.new();
  const lcd = new Lcd(new RecorderHost());
  setLcd(lcd);
  game.load({ startWorld: false });
  game.stack.clear();
  return { game, lcd };
}

const top = (game: Game2): any => game.stack.top();
const noHoles = (lcd: Lcd): boolean => !renderLcd(lcd.s, () => 0).includes(LCD_HOLE);

describe("gen2 SpriteAnims", () => {
  test("the sine table and the 8-bit sine/cosine bytes", () => {
    expect(SpriteAnims.SINE[0]).toBe(0);
    expect(SpriteAnims.SINE[16]).toBe(0x100);
    expect(SpriteAnims.sine(16, 4)).toBe(4);
    // the down half comes back in two's complement
    expect(SpriteAnims.sine(48, 4)).toBe(0xfc);
    expect(SpriteAnims.cosine(0, 8)).toBe(8);
    expect(SpriteAnims.sine(64 + 16, 0x90)).toBe(0x90);
  });

  test("structs: first free slot, framesets with restart/end/delete, OAM bytes", () => {
    const sys = SpriteAnims.new();
    const a = sys.init("GS_INTRO_SHELLDER", 7 * 8, 18 * 8)!;
    const b = sys.init("GS_INTRO_SHELLDER", 10 * 8, 14 * 8)!;
    expect([a.index, b.index]).toEqual([1, 2]);
    let oam = sys.playFrame();
    expect(oam.length).toBe(8);
    // dbsprite -1, -1, 0, 0, $00 at (56, 144): y = 144 - 8
    expect(oam[0]).toEqual({ y: 136, x: 48, tile: 0x6c, attr: 0 });
    // a duration-8 frame shows 9 ticks: SHELLDER_1, then SHELLDER_2, then restart
    for (let i = 0; i < 9; i++) oam = sys.playFrame();
    expect(oam[0]!.tile).toBe(0x6e);
    for (let i = 0; i < 9; i++) oam = sys.playFrame();
    expect(oam[0]!.tile).toBe(0x6c);
    // a fireball steps small -> medium -> big (2 ticks each), then deletes itself
    sys.clear();
    sys.init("GS_INTRO_FIREBALL", 84, 100);
    for (let i = 0; i < 6; i++) sys.playFrame();
    expect(sys.activeCount()).toBe(1);
    sys.playFrame();
    expect(sys.activeCount()).toBe(0);
    // ten structs, then nil
    sys.clear();
    for (let i = 0; i < 10; i++) expect(sys.init("GS_INTRO_BUBBLE", 0, 0)).not.toBe(null);
    expect(sys.init("GS_INTRO_BUBBLE", 0, 0)).toBe(null);
  });

  test("the splash star spirals in over 64 frames and raises the flag", () => {
    const sys = SpriteAnims.new();
    sys.vtileBase = 0x8d;
    const st = sys.init("GS_GAMEFREAK_LOGO_STAR", 88, 84)!;
    st.var1 = 0x80;
    let frames = 0;
    while (sys.flag === 0 && frames < 200) {
      sys.playFrame();
      frames++;
    }
    expect(frames).toBe(65);
    expect(sys.activeCount()).toBe(0);
  });
});

describe("gen2 boot cinema", () => {
  test.skipIf(!gold)(
    "GAME FREAK splash -> onDone(false) -> the intro runs to its end -> title; START skips",
    async () => {
      const { game, lcd } = await loaded();
      game.showGameFreak();
      const splash = top(game);
      expect(splash).toBeInstanceOf(GameFreakPresents);
      const doneArgs: unknown[] = [];
      const onDone = splash.onDone;
      splash.onDone = (skipped: boolean) => {
        doneArgs.push(skipped);
        onDone(skipped);
      };
      let f = 0;
      while (top(game) === splash && f < 1000) {
        game.frame(0);
        f++;
        game.draw(lcd);
        if (f === 30) await shot(lcd, "gamefreak_0");
        if (f === 110) {
          expect(noHoles(lcd)).toBe(true);
          // logo placed, sparkles flying
          expect(splash.scene).toBe(2);
          expect(lcd.s.objs.length).toBeGreaterThan(15);
          await shot(lcd, "gamefreak_1");
        }
        if (f === 260) {
          expect(splash.scene).toBe(4);
          await shot(lcd, "gamefreak_2");
        }
      }
      console.log("GAME FREAK splash frames:", f);
      expect(doneArgs).toEqual([false]);
      expect(f).toBeGreaterThan(300);
      expect(f).toBeLessThan(400);

      // the intro, pushed by onDone(false)
      const intro = top(game) as GoldSilverIntro;
      expect(intro).toBeInstanceOf(GoldSilverIntro);
      expect(intro.assets).toBeTruthy();
      const entered: Record<number, number> = {};
      const want: [number, number, string][] = [
        [2, 70, "intro_01"], // underwater: Shellders and bubbles, the water bending
        [3, 300, "intro_02"], // the climb: Magikarp school
        [4, 60, "intro_03"], // the surface: Lapras
        [7, 100, "intro_04"], // grass: Jigglypuff and notes
        [8, 150, "intro_05"], // Pikachu's charge
        [15, 40, "intro_06"], // Charizard breathes the fireball
      ];
      const extra: [number, number, string][] = [
        [11, 90, "intro_07"], // a starter flashes across the silhouette
        [12, 2, "intro_08"],
      ];
      f = 0;
      let scene = 0;
      while (top(game) === intro && f < 4000) {
        game.frame(0);
        f++;
        if (intro.scene !== scene) {
          scene = intro.scene;
          entered[scene] = f;
        }
        game.draw(lcd);
        for (const [s, at, name] of [...want, ...extra]) {
          if (scene === s && f - entered[s]! === at) {
            expect(noHoles(lcd)).toBe(true);
            await shot(lcd, name);
          }
        }
      }
      console.log("intro frames:", f, "scenes:", JSON.stringify(entered));
      expect(intro.finished).toBe(true);
      expect(intro.skipped).toBe(false);
      for (let s = 2; s <= 17; s++) expect(entered[s]).toBeDefined();
      expect(f).toBeGreaterThan(2000);
      expect(top(game)).toBeInstanceOf(TitleState);

      // START skips the movie straight to the title
      game.showIntro();
      const again = top(game) as GoldSilverIntro;
      for (let i = 0; i < 30; i++) game.frame(0);
      game.frame(VOX_BTN.start);
      expect(again.skipped).toBe(true);
      expect(top(game)).toBeInstanceOf(TitleState);

      // a skipped splash goes straight to the title too
      game.showGameFreak();
      game.frame(0);
      game.frame(VOX_BTN.a);
      for (let i = 0; i < 20; i++) game.frame(0);
      expect(top(game)).toBeInstanceOf(TitleState);
    },
    600_000,
  );

  test.skipIf(!gold)("the title: Ho-Oh, clouds, trails; START/A continue; it times out", async () => {
    const { game, lcd } = await loaded();
    let continued = 0;
    let timedOut = 0;
    game.stack.push(
      TitleState.new(game, { title: game.titleData, onContinue: () => continued++, onTimeout: () => timedOut++ }),
    );
    const title = top(game) as TitleState;
    expect(title.screenColor).not.toBe(null);
    expect(title.hoohColor.length).toBe(5);
    for (let i = 0; i < 200; i++) game.frame(0);
    game.draw(lcd);
    expect(noHoles(lcd)).toBe(true);
    expect(lcd.s.objs.length).toBeGreaterThan(20);
    expect(lcd.s.lineTarget).toBe(2);
    await shot(lcd, "title");
    for (let i = 0; i < 37; i++) game.frame(0);
    game.draw(lcd);
    await shot(lcd, "title_b");
    game.frame(VOX_BTN.start);
    expect(continued).toBe(1);
    game.frame(0);
    game.frame(VOX_BTN.a);
    expect(continued).toBe(2);

    // no input: the fade starts at timeoutFrames and onTimeout fires 60 frames on
    const idle = TitleState.new(game, { title: game.titleData, onTimeout: () => timedOut++ });
    game.stack.clear();
    game.stack.push(idle);
    let f = 0;
    while (timedOut === 0 && f < 6000) {
      game.frame(0);
      f++;
    }
    expect(timedOut).toBe(1);
    expect(f).toBe((game.titleData.timeoutFrames ?? 5056) + 60);
  }, 120_000);
});
