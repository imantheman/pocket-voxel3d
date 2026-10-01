// Shared fixture for the START-menu screen tests (tests/voxel-gen2-ui-start*.test.ts):
// a loaded Game2 with a played save -- party, bag, Pokédex, phone -- plus an
// Lcd to draw into, a pad driver and PNG shots.

import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Phone } from "../voxelmon/game/gen2/core/Phone.ts";
import { fixedClock, setClockSource } from "../voxelmon/game/gen2/platform/clock.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { memorySaveIo, setSaveIo } from "../voxelmon/game/gen2/platform/saveio.ts";
import G, { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { Input } from "../voxelmon/game/gen2/shared/core/Input.ts";
import { MenuFade } from "../voxelmon/game/gen2/ui/MenuFade.ts";

export type Btn = keyof typeof VOX_BTN;

export interface UiRig {
  game: any;
  lcd: Lcd;
  io: ReturnType<typeof memorySaveIo>;
  clock: ReturnType<typeof fixedClock>;
}

/** The played save: two mons, a bag in every pocket, a Pokédex, two phone numbers. */
export function playedSave(game: any): any {
  const save = game.save;
  const data = game.data;
  save.player.name = "GOLD";
  save.player.id = 12345;
  save.rival.name = "SILVER";
  save.player.money = 3000;
  save.player.badges.ZEPHYRBADGE = true;
  const cynda = Mon.new(data, "CYNDAQUIL", 5, { caughtLevel: 5, caughtLocation: 1 });
  const pidgey = Mon.new(data, "PIDGEY", 7, { item: "BERRY", caughtLevel: 7 });
  (cynda as any).ot = save.player.name;
  (cynda as any).otId = save.player.id;
  (pidgey as any).ot = save.player.name;
  (pidgey as any).otId = save.player.id;
  save.party = [cynda, pidgey];
  save.inventory = { POTION: 3, ANTIDOTE: 1, POKE_BALL: 5, GREAT_BALL: 2, BICYCLE: 1, TM_HEADBUTT: 1, HM_CUT: 1 };
  save.bagOrder = ["POTION", "ANTIDOTE", "POKE_BALL", "GREAT_BALL", "BICYCLE", "TM_HEADBUTT", "HM_CUT"];
  for (const s of ["CHIKORITA", "CYNDAQUIL", "TOTODILE", "PIDGEY", "SENTRET", "HOOTHOOT", "RATTATA"]) save.pokedex.seen[s] = true;
  for (const s of ["CYNDAQUIL", "PIDGEY"]) save.pokedex.caught[s] = true;
  Phone.addContact(save, 1); // PHONE_MOM
  Phone.addContact(save, 4); // PHONE_ELM
  save.playTime = { hours: 1, minutes: 23, seconds: 4, frames: 0 };
  return save;
}

/**
 * Minimal stand-ins for modules other agents are still porting (only while
 * they are stubs): MenuFade's white fades become "no fade", which is what
 * Game2 does for an item that has none.
 */
function standIns(): void {
  const MF = MenuFade as unknown as Record<string, any>;
  if (String(MF.openWhite).includes("notPorted")) {
    MF.openWhite = () => undefined;
    MF.closeWhite = () => undefined;
  }
}

/**
 * Game2.new + load (without the copyright boot, which would push the intro
 * screens), the played save, a memory save store and a fixed clock.
 */
export function rig(): UiRig {
  standIns();
  useGoldGen();
  seed(2026);
  const io = memorySaveIo();
  setSaveIo(io);
  const clock = fixedClock({ year: 2026, month: 9, day: 30, hour: 10, min: 15 });
  setClockSource(clock);
  const game: any = Game2.new();
  game.showCopyright = () => {};
  game.load({ startWorld: false });
  game.stack.clear();
  game.phase = "play";
  playedSave(game);
  const lcd = new Lcd(new RecorderHost());
  setLcd(lcd);
  return { game, lcd, io, clock };
}

/** Cook the tile pages once (async: shot-node is Bun-only). */
export async function tiles(): Promise<void> {
  const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  useGoldTiles();
}

/** One logic frame with `buttons` held. */
export function frame(game: any, buttons = 0): void {
  Input.setButtons(buttons);
  Input.step();
  game.stack.update(1 / 60);
}

/** Press and release a button, then let `settle` idle frames run. */
export function press(game: any, btn: Btn, settle = 2): void {
  frame(game, VOX_BTN[btn]);
  for (let i = 0; i < settle; i++) frame(game);
}

export function idle(game: any, n: number): void {
  for (let i = 0; i < n; i++) frame(game);
}

/**
 * Game2.draw's play branch without a world: a widescreen top draws itself,
 * an opaque base gets a white panel, otherwise the stack draws over holes
 * (the 3D world).
 */
export function draw(rigOrGame: UiRig | any, lcd?: Lcd): void {
  const game = rigOrGame.game ?? rigOrGame;
  const target = lcd ?? rigOrGame.lcd;
  setLcd(target);
  target.begin();
  resetDrawState();
  const stack = game.stack;
  const top = stack.top();
  const baseIdx = stack.visibleBase();
  const base = stack.states[baseIdx];
  const wide = top && top.drawsWidescreen && top.drawsWidescreen() && top.drawWidescreen ? top : null;
  if (wide) {
    wide.drawWidescreen(160, 144);
    return;
  }
  if (base && base.isOpaque) {
    if (base.drawWidescreen) base.drawWidescreen(160, 144);
    else {
      G.setColor(1, 1, 1, 1);
      G.rectangle("fill", 0, 0, 160, 144);
    }
  }
  stack.draw();
}

/** Draw and, when GOLD_SHOTS is set, write `<name>.png`. */
export async function shot(r: UiRig, name: string): Promise<void> {
  draw(r);
  if (!process.env.GOLD_SHOTS) return;
  const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  shotLcd(r.lcd.s, `${process.env.GOLD_SHOTS}/${name}.png`);
}

/** Id of the top screen's class (StartMenu, PartyMenu, ...). */
export function topName(game: any): string | undefined {
  const t = game.stack.top();
  return t ? t.constructor?.name : undefined;
}
