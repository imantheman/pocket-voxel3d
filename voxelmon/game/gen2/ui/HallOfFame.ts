// The Hall of Fame: a port of gen1recomp src/ui/gen2/HallOfFame.lua
// (bdfac727, MIT) -- pokegold engine/events/halloffame.asm, both halves:
//
//   AnimateHallOfFame   each party member enters (AnimateHOFMonEntrance),
//                       gets DisplayHOFMon plus "New Hall of Famer!", its cry
//                       and 180 frames, then HOF_AnimatePlayerPic ends on the
//                       player's own card
//   _HallOfFamePC       LoadHOFTeam walks the roster newest first and
//                       DisplayHOFMon shows one mon at a time; A is next mon,
//                       START is next team, B leaves
//
// THE ENTRANCE IS A SCROLL, not a sprite move. AnimateHOFMonEntrance blanks
// the tilemap, lays ONE pic into it, and animates hSCX and hSCY:
//
//   HOF_SlideBackpic    hSCX $90, +4 a frame until it reads $70
//   HOF_SlideFrontpic   hSCX -2 a frame until it reads 0
//
// COORDINATES are taken literally off the hlcoord lines, and the placements
// are built as data so a test can assert them.
//
// On the Gold screen a pic mid-slide is off the 8px grid, so it is drawn as
// objects over the blank white BG -- the same picture the scrolled BG gives,
// since nothing else is on screen. Once settled it lands on the grid as cells.
//
// ProfOaksPCRating, which the cart prints into the bottom box afterwards,
// needs Oak's PC (still a stub in Brian's Specials) and so the box is drawn
// empty, exactly as it is before that farcall.

import { Assets } from "../shared/render/Assets.ts";
import { Chrome } from "./Chrome.ts";
import { CommonText } from "../core/CommonText.ts";
import { HallOfFame as Core, type HofEntry } from "../core/HallOfFame.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Save as Gen2Save } from "../core/Save.ts";
import { MonAnimView } from "../shared/render/MonAnimView.ts";
import { Music } from "../shared/core/Music.ts";
import { Palettes } from "../world/Palettes.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Sprites, type PicCtx } from "../shared/pokemon/Sprites.ts";
import { TileSheet } from "./TileSheet.ts";
import { Unown } from "../core/Unown.ts";
import G, { type LcdImage, type Quad } from "../platform/screen.ts";
import { tonumber, tostring } from "../platform/lua.ts";

type Colors = readonly (readonly number[])[];

const SCREEN_W = 160;
const SCREEN_H = 144;

// Lua: HallOfFame.lua:67 -- AnimateHOFMonEntrance puts the backpic at hlcoord
// 6, 6 and the frontpic at 6, 5; HOF_AnimatePlayerPic puts the player's
// backpic at 6, 6 and the trainer pic at 12, 5.
const BACKPIC_X = 6;
const BACKPIC_Y = 6;
const FRONTPIC_X = 6;
const FRONTPIC_Y = 5;
const TRAINERPIC_X = 12;
const TRAINERPIC_Y = 5;
const PIC_TILES = 7;

// Lua: HallOfFame.lua:73 -- the scroll registers the two slide loops walk.
const SCY_START = 0xd0;
const BACKPIC_SCX_START = 0x90;
const BACKPIC_SCX_END = 0x70;
const BACKPIC_STEP = 4;
const FRONTPIC_STEP = 2;
const TRAINER_SCX_START = 0xc0;

// Lua: HallOfFame.lua:79 -- .DisplayNewHallOfFamer: `ld c, 180 / call DelayFrames`.
const FAMER_FRAMES = 180;
// ../pokecrystal/engine/events/halloffame.asm:126-130
const ANIM_FAMER_FRAMES = 60;
// AnimateHallOfFame .done: RotateThreePalettesRight, then `ld c, 8`.
const END_FRAMES = 8;

const HOF_MUSIC = "Music_HallOfFame";

// Lua: HallOfFame.lua:97 -- the labels the three header strings live under.
const LABELS = {
  NEW_FAMER: "AnimateHallOfFame.String_NewHallOfFamer",
  TIME_FAMER: "_HallOfFamePC.TimeFamer",
  HOF_MASTER: "_HallOfFamePC.HOFMaster",
};

// Lua: HallOfFame.lua:107 -- PadFrontpic centres a 5x5 or 6x6 pic in 7x7.
const PIC_PAD: Record<number, [number, number]> = { 7: [0, 0], 6: [1, 1], 5: [1, 2] };

const WHITE = [255, 255, 255];

export interface Placement {
  text: string;
  x: number;
  y: number;
}

// Lua: HallOfFame.lua:115
function put(list: Placement[], text: unknown, x: number, y: number): Placement[] {
  if (text == null) return list;
  list.push({ text: tostring(text), x, y });
  return list;
}

// Lua: CommonText.lua:41 CommonText.plain -- not in core/CommonText.ts yet.
function plain(body: unknown): unknown {
  if (typeof body !== "string") return body;
  return body.split("{DONE}").join("").split("{PROMPT}").join("");
}

// Lua: HallOfFame.lua:129
function levelText(level: unknown): string {
  const lv = Math.max(1, Math.floor(tonumber(level) ?? 1));
  // PrintLevel: a three-digit level overwrites the <LV> tile.
  if (lv >= 100) return tostring(lv);
  return "<LV>" + tostring(lv);
}

// Lua: HallOfFame.lua:139 -- GetGender's three answers.
function genderGlyph(gender: unknown): string | undefined {
  if (gender === "male") return "♂";
  if (gender === "female") return "♀";
  return undefined;
}

// Lua: HallOfFame.lua:598 -- hSCX / hSCY applied to one coordinate; the BG
// map wraps every 256 pixels, so both copies are returned.
function scrolled(base: number, register: number): [number, number] {
  const value = (((base - register) % 256) + 256) % 256;
  return [value, value - 256];
}

export interface HallOfFameOpts {
  mode?: "induct" | "view";
  save?: any;
  entry?: HofEntry;
  text?: any;
  pokemon?: any;
  palettes?: any;
  onDone?: () => void;
}

export class HallOfFame {
  [key: string]: any;
  static isOpaque = true;
  isOpaque = true;

  // Lua: HallOfFame.lua:90 -- the leading spaces are load bearing: PrintNum
  // writes the count over them at hlcoord 2, 2.
  static NEW_FAMER = "New Hall of Famer!";
  static TIME_FAMER = "    -Time Famer";
  static HOF_MASTER = "    HOF Master!";
  static LABELS = LABELS;
  static WHITE = WHITE;
  static PIC_PAD = PIC_PAD;
  static FAMER_FRAMES = FAMER_FRAMES;
  static ANIM_FAMER_FRAMES = ANIM_FAMER_FRAMES;
  static END_FRAMES = END_FRAMES;
  static SCY_START = SCY_START;
  static BACKPIC_SCX_START = BACKPIC_SCX_START;
  static BACKPIC_SCX_END = BACKPIC_SCX_END;
  static TRAINER_SCX_START = TRAINER_SCX_START;

  game: any;
  data: any;
  save: any;
  mode: "induct" | "view" = "induct";
  onDone?: () => void;
  textData: any;
  pokemon: any;
  palettes: any;
  picCache: Record<string, LcdImage | false> = {};
  frames = 0;
  done = false;
  scx = 0;
  scy = 0;
  playerBackPath: string | undefined;
  trainerPicPath: string | undefined;
  portrait: TileSheet | undefined;
  portraitWide = 5;
  portraitTiles = 35;
  team = 1;
  index = 1;
  entry: HofEntry | undefined;
  phase: string | undefined;
  timer = 0;
  picAnim: MonAnimView | null = null;
  constructing: boolean | undefined;
  pendingDone: boolean | undefined;

  // Lua: HallOfFame.lua:122 -- the text a placement list writes at (x, y).
  static at(placements: Placement[] | undefined, x: number, y: number): string | undefined {
    for (const entry of placements ?? []) {
      if (entry.x === x && entry.y === y) return entry.text;
    }
    return undefined;
  }

  // Lua: HallOfFame.lua:149 -- DisplayHOFMon, hlcoord for hlcoord. `def` is
  // the species row, for the dex number and the base name.
  static monPlacements(mon: any, def: any): Placement[] {
    mon = mon ?? {};
    const out: Placement[] = [];
    // `.print_id_no` is jumped to for an EGG.
    if (mon.species !== "EGG") {
      // (1,13) '№' and (2,13) '.' are two `ld [hli]` writes.
      put(out, "№.", 1, 13);
      put(out, Chrome.number(def ? def.dex ?? 0 : 0, 3, true), 3, 13);
      put(out, (def && def.name) || mon.species, 7, 13);
      put(out, genderGlyph(mon.gender), 18, 13);
      // (8,14) is a bare '/', so the nickname starts at (9,14).
      put(out, "/", 8, 14);
      put(out, mon.nickname || mon.name || mon.species, 9, 14);
      put(out, levelText(mon.level), 1, 16);
    }
    // '<ID>' '№' '/' at (7,16)-(9,16), then five digits at (10,16).
    put(out, "<ID>№/", 7, 16);
    put(out, Chrome.number(mon.otId || 0, 5, true), 10, 16);
    return out;
  }

  // Lua: HallOfFame.lua:182 -- the header line.
  // BUG (docs/bugs_and_glitches.md): "HOF Master!" is compared against
  // HOF_MASTER_COUNT + 1 while the counter stops AT HOF_MASTER_COUNT, so the
  // title can never print. Transcribed with the off-by-one intact.
  static headerPlacements(mode: string, winCount: unknown, text: any): Placement[] {
    const out: Placement[] = [];
    const line = (label: string, fallback: string): string => {
      const extracted = plain(CommonText.get(text, label));
      return (extracted as string | undefined) ?? fallback;
    };
    if (mode === "induct") {
      put(out, line(LABELS.NEW_FAMER, HallOfFame.NEW_FAMER), 1, 2);
      return out;
    }
    const wins = tonumber(winCount) ?? 0;
    if (wins >= Core.MASTER_COUNT + 1) {
      put(out, line(LABELS.HOF_MASTER, HallOfFame.HOF_MASTER), 1, 2);
      return out;
    }
    put(out, line(LABELS.TIME_FAMER, HallOfFame.TIME_FAMER), 1, 2);
    put(out, Chrome.number(wins, 3), 2, 2);
    return out;
  }

  // Lua: HallOfFame.lua:203 -- HOF_AnimatePlayerPic's text.
  static playerPlacements(save: any): Placement[] {
    save = save ?? {};
    const player = save.player ?? {};
    const time = save.playTime ?? {};
    const out: Placement[] = [];
    put(out, player.name || "GOLD", 2, 4);
    put(out, "<ID>№/", 1, 6);
    put(out, Chrome.number(player.id || 0, 5, true), 4, 6);
    put(out, "PLAY TIME", 1, 8);
    // `ld de, wGameTimeHours / lb bc, 2, 3`, HALLOFFAME_COLON, then minutes.
    put(out, Chrome.number(time.hours || 0, 3), 3, 9);
    put(out, ":", 6, 9);
    put(out, Chrome.number(time.minutes || 0, 2, true), 7, 9);
    return out;
  }

  // Lua: HallOfFame.lua:224
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: HallOfFame.lua:225
  drawsWidescreen(): boolean {
    return true;
  }

  // Lua: HallOfFame.lua:235 -- opts: mode ("induct" | "view"), save, entry,
  // text, onDone()
  static new(game: any, opts?: HallOfFameOpts): HallOfFame {
    const o = opts ?? {};
    const self = new HallOfFame();
    self.game = game;
    const data = (game && game.data) || {};
    self.data = data;
    self.save = o.save ?? (game ? game.save : undefined);
    self.mode = o.mode ?? "induct";
    self.onDone = o.onDone;
    // text.lua, for the three header strings.
    self.textData = o.text ?? (game && game.world ? game.world.text : undefined);
    self.pokemon = o.pokemon ?? data.pokemon;
    self.palettes = o.palettes ?? data.gen2Palettes;
    self.picCache = {};
    self.frames = 0;
    self.done = false;
    // Hardware registers, the only state the entrance animation has.
    self.scx = 0;
    self.scy = 0;

    const menuGfx = data.gen2MenuGfx ?? {};
    // HOF_AnimatePlayerPic calls GetPlayerBackpic.
    const female = Gen2Save.isFemale(self.save);
    const hud = menuGfx.battleHud ?? {};
    self.playerBackPath = Sprites.playerPic((female && hud.playerBackFemale) || hud.playerBack, {
      side: "back", kind: "hof", data,
    })[0];
    // HOF_LoadTrainerFrontpic's ChrisPic / KrisPic.
    // NOT FAITHFUL (to the Lua): pokegold's HOF_AnimatePlayerPic loads
    // TRAINER_CLASS CAL (halloffame.asm:556 `ld a, CAL` / GetTrainerPic). Brian
    // falls back to the card portrait because his cache had no CAL pic; this
    // importer extracts it, so Gold shows the cart's own picture.
    const pics = hud.trainerPics ?? {};
    self.trainerPicPath = (female && pics.KRIS) || pics.CHRIS || pics.CAL;
    const card = menuGfx.trainerCard;
    if (card && card.card) {
      // GetCardPic's KrisCardPic arm.
      self.portrait = TileSheet.new({
        path: (female && card.cardFemale) || card.card,
        wide: card.cardTilesWide || 16, firstTile: 0,
      });
      self.portraitWide = card.portraitWide || 5;
      self.portraitTiles = card.portraitTiles || 35;
    }

    if (self.mode === "view") {
      // _HallOfFamePC: the team and the mon inside it both start at zero. An
      // empty roster ends the screen, deferred to the first update.
      self.team = 1;
      self.index = 1;
      self.constructing = true;
      self.enterView();
      self.constructing = undefined;
    } else {
      self.entry = o.entry ?? Core.team(self.save, 1);
      self.index = 1;
      self.playMusic(HOF_MUSIC);
      self.enterMon();
    }
    return self;
  }

  // Lua: HallOfFame.lua:308
  playMusic(song: string): void {
    const audio = this.data && this.data.audio;
    if (audio && audio.songs && audio.songs[song]) {
      // HallOfFame_PlayMusicDE plays MUSIC_NONE for a frame first.
      Music.stop();
      Music.play(this.data, song, true, { reason: "halloffame" });
    }
  }

  // Lua: HallOfFame.lua:318
  playCry(species: string | undefined): void {
    if (!species) return;
    const cries = this.data && this.data.audio && this.data.audio.cries;
    if (cries && cries[species]) Sound.playCry(this.data, species);
  }

  // Lua: HallOfFame.lua:329 -- the mon the current phase is about.
  currentMon(): any {
    const entry = this.entry;
    return entry && entry.mons ? entry.mons[this.index - 1] : undefined;
  }

  // Lua: HallOfFame.lua:336 -- AnimateHOFMonEntrance.
  enterMon(): void {
    const mon = this.currentMon();
    if (!mon) return this.enterPlayer();
    this.phase = "backpic";
    this.scy = SCY_START;
    this.scx = BACKPIC_SCX_START;
    this.timer = 0;
  }

  // Lua: HallOfFame.lua:347 -- _HallOfFamePC .DisplayMonAndStrings.
  enterView(): void {
    this.entry = Core.team(this.save, this.team);
    if (!this.entry) return this.finish();
    const mon = this.currentMon();
    if (!mon) {
      // `.fail` -> carry -> .start_button -> the next team.
      this.team = this.team + 1;
      this.index = 1;
      return this.enterView();
    }
    this.phase = "display";
    this.scx = 0;
    this.scy = 0;
    this.playCry(mon.species);
    this.startPicAnim();
  }

  // Lua: HallOfFame.lua:363
  enterDisplay(): void {
    this.phase = "display";
    this.scx = 0;
    this.scy = 0;
    this.playCry((this.currentMon() ?? {}).species);
    this.startPicAnim();
    this.timer = this.picAnim ? ANIM_FAMER_FRAMES : FAMER_FRAMES;
  }

  // Lua: HallOfFame.lua:373 -- ../pokegold/engine/events/halloffame.asm:124-125
  startPicAnim(): void {
    const mon = this.currentMon();
    const [path, , vanilla] = this.monPicPath(mon, false);
    this.picAnim = MonAnimView.start(
      mon ? this.speciesDef(mon.species) : undefined, mon, "hof",
      (p) => this.image(p), undefined, {
        resolve: (sheet) => Sprites.pic(sheet, this.picCtx(mon, false, "hof_anim")),
        staticReplaced: MonAnimView.replaced(vanilla, path),
      },
    );
  }

  // Lua: HallOfFame.lua:387 -- ../pokecrystal/engine/gfx/pic_animation.asm:79-89
  stepPicAnim(): boolean {
    const anim = this.picAnim;
    if (!anim) return false;
    if (anim.step()) this.picAnim = null;
    return true;
  }

  // Lua: HallOfFame.lua:394
  picAnimFrame(): [LcdImage, Quad, number] | null {
    const anim = this.picAnim;
    if (!anim) return null;
    return anim.frame();
  }

  // Lua: HallOfFame.lua:402 -- HOF_AnimatePlayerPic.
  enterPlayer(): void {
    this.phase = "playerBack";
    this.scy = SCY_START;
    this.scx = BACKPIC_SCX_START;
    // wMusicFade = 4 happens at .done, after the player pic.
  }

  // Lua: HallOfFame.lua:410
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.constructing) {
      this.pendingDone = true;
      return;
    }
    if (this.onDone) this.onDone();
  }

  // Lua: HallOfFame.lua:425
  slideBackpic(): boolean {
    if (this.scx === BACKPIC_SCX_END) return true;
    this.scx = (this.scx + BACKPIC_STEP) % 256;
    return this.scx === BACKPIC_SCX_END;
  }

  // Lua: HallOfFame.lua:431
  slideFrontpic(): boolean {
    if (this.scx === 0) return true;
    this.scx = (((this.scx - FRONTPIC_STEP) % 256) + 256) % 256;
    return this.scx === 0;
  }

  // Lua: HallOfFame.lua:439 -- the induction's own step, one frame at a time.
  step(): boolean {
    if (this.done) return true;
    this.frames = this.frames + 1;

    if (this.phase === "backpic") {
      if (this.slideBackpic()) {
        // The frontpic is prepared and hSCY zeroed before HOF_SlideFrontpic.
        this.phase = "frontpic";
        this.scy = 0;
      }
      return false;
    }

    if (this.phase === "frontpic") {
      if (this.slideFrontpic()) this.enterDisplay();
      return false;
    }

    if (this.phase === "display") {
      if (this.stepPicAnim()) return false;
      if (this.mode === "view") return false;
      this.timer = this.timer - 1;
      if (this.timer > 0) return false;
      // `inc [hl]` on wHallOfFameMonCounter; PARTY_LENGTH or a -1 species ends it.
      this.index = this.index + 1;
      if (this.index > Core.PARTY_LENGTH || !this.currentMon()) {
        this.enterPlayer();
      } else {
        this.enterMon();
      }
      return false;
    }

    if (this.phase === "playerBack") {
      if (this.slideBackpic()) {
        this.phase = "playerFront";
        this.scy = 0;
        this.scx = TRAINER_SCX_START;
      }
      return false;
    }

    if (this.phase === "playerFront") {
      if (this.slideFrontpic()) {
        this.phase = "player";
        this.timer = END_FRAMES;
        // wMusicFade = 4: the Hall of Fame theme rings out under the card.
        Music.fadeOut(4);
      }
      return false;
    }

    if (this.phase === "player") {
      this.timer = this.timer - 1;
      if (this.timer <= 0) this.finish();
      return this.done;
    }

    return false;
  }

  // Lua: HallOfFame.lua:502 -- A is the next mon, START the next team, B out.
  viewInput(input: any): void {
    if (!input) return;
    if (input.wasPressed("b")) return this.finish();
    if (input.wasPressed("start")) {
      this.team = this.team + 1;
      this.index = 1;
      return this.enterView();
    }
    if (input.wasPressed("a")) {
      this.index = this.index + 1;
      if (this.index > Core.PARTY_LENGTH || !this.currentMon()) {
        this.team = this.team + 1;
        this.index = 1;
      }
      return this.enterView();
    }
  }

  // Lua: HallOfFame.lua:520
  update(_dt?: number): void {
    if (this.pendingDone) {
      this.pendingDone = undefined;
      if (this.onDone) this.onDone();
      return;
    }
    if (this.done) return;
    if (this.mode === "view") {
      this.frames = this.frames + 1;
      // ../pokecrystal/engine/events/halloffame.asm:313-317
      if (this.stepPicAnim()) return;
      return this.viewInput(this.game ? this.game.input : undefined);
    }
    this.step();
  }

  // Lua: HallOfFame.lua:540
  image(path: string | undefined): LcdImage | undefined {
    if (!path) return undefined;
    let cached = this.picCache[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path);
      } catch {
        cached = false;
      }
      this.picCache[path] = cached;
    }
    return cached || undefined;
  }

  // Lua: HallOfFame.lua:551
  speciesDef(species: string | undefined): any {
    return species && this.pokemon ? this.pokemon[species] : undefined;
  }

  // Lua: HallOfFame.lua:560 -- takes the RECORD: the entry carries the DVs so
  // the viewer can name the form (GetUnownLetter, halloffame.asm:225-238).
  picCtx(mon: any, back: boolean, kind: string): PicCtx & { letter?: number; shiny?: boolean } {
    return {
      species: mon ? mon.species : undefined,
      side: back ? "back" : "front",
      kind,
      mon,
      data: this.data,
      letter: Unown.monLetter(mon),
      shiny: !!(mon && mon.shiny),
    };
  }

  // Lua: HallOfFame.lua:572
  monPicPath(mon: any, back: boolean): [string | undefined, boolean, string | undefined] {
    const def = this.speciesDef(mon ? mon.species : undefined);
    if (!def) return [undefined, false, undefined];
    let vanilla = back ? def.spriteBack : def.spriteFront;
    if (mon.species === Unown.SPECIES) {
      vanilla = Unown.formSprite(this.pokemon, Unown.monLetter(mon), back) || vanilla;
    }
    const [path, trueColor] = Sprites.pic(vanilla, this.picCtx(mon, back, "hof"));
    return [path, trueColor, vanilla];
  }

  // Lua: HallOfFame.lua:584
  monPic(mon: any, back: boolean): [LcdImage | undefined, boolean] {
    const [path, trueColor] = this.monPicPath(mon, back);
    if (!path) return [undefined, false];
    return [this.image(path), trueColor];
  }

  // Lua: HallOfFame.lua:590
  monColors(mon: any): Colors | undefined {
    if (!(this.palettes && mon && mon.species)) return undefined;
    return Palettes.monColors(this.palettes, mon.species, mon.shiny);
  }

  // NOT FAITHFUL (to the Lua): Brian draws the player's two pictures with no
  // palette. HOF_AnimatePlayerPic zeroes wCurPartySpecies and loads
  // SCGB_PLAYER_OR_MON_FRONTPIC_PALS (halloffame.asm:543-546), i.e. the
  // PLAYER trainer palette, so that is what they draw through here.
  playerColors(): Colors | undefined {
    return this.palettes ? Palettes.trainerColors(this.palettes, "PLAYER") : undefined;
  }

  // Lua: HallOfFame.lua:605 -- an image at a tile coordinate through the
  // current scroll, padded into the 7x7 block the way PlaceGraphic pads it.
  drawScrolled(
    image: LcdImage | undefined, tileX: number, tileY: number, colors: Colors | undefined,
    quad?: Quad | null, size?: number | null, trueColor?: boolean,
  ): void {
    if (!image) return;
    if (trueColor && GbcPalette.mode === "gbc") colors = undefined;
    const wide = Math.floor((size || image.getWidth()) / 8);
    const pad = PIC_PAD[wide] ?? PIC_PAD[PIC_TILES]!;
    const baseX = tileX * 8 + pad[0] * 8;
    const baseY = tileY * 8 + pad[1] * 8;
    const xs = scrolled(baseX, this.scx);
    const ys = scrolled(baseY, this.scy);
    G.setColor(1, 1, 1, 1);
    const body = (): void => {
      for (const x of xs) {
        for (const y of ys) {
          if (quad) G.draw(image, quad, x, y);
          else G.draw(image, x, y);
        }
      }
    };
    if (colors && GbcPalette.available()) GbcPalette.with(colors, body);
    else body();
  }

  // Lua: HallOfFame.lua:634 -- the player's front picture.
  drawPortrait(tileX: number, tileY: number): void {
    const pic = this.image(this.trainerPicPath);
    if (pic) return this.drawScrolled(pic, tileX, tileY, this.playerColors());
    if (!(this.portrait && this.portrait.available())) return;
    const wide = this.portraitWide;
    const high = Math.floor((this.portraitTiles || 35) / wide);
    // A 5x7 portrait standing in for a 7x7 pic sits on the same ground line
    // and centred, which is what PadFrontpic would have done to it.
    const padX = Math.floor((PIC_TILES - wide) / 2);
    const padY = PIC_TILES - high;
    const xs = scrolled((tileX + padX) * 8, this.scx);
    const ys = scrolled((tileY + padY) * 8, this.scy);
    for (const x of xs) {
      for (const y of ys) {
        G.push();
        G.translate(x, y);
        this.portrait.block(0, wide, high, 0, 0);
        G.pop();
      }
    }
  }

  // Lua: HallOfFame.lua:659
  drawPlacements(list: Placement[] | undefined): void {
    for (const entry of list ?? []) Chrome.print(entry.text, entry.x, entry.y);
  }

  // Lua: HallOfFame.lua:668 -- DisplayHOFMon's two boxes: `lb bc, 3,
  // SCREEN_WIDTH - 2` at (0,0) and `lb bc, 4, 18` at (0,12).
  drawMonPanel(): void {
    const mon = this.currentMon();
    Chrome.clear();
    Chrome.textbox(0, 0, 18, 3);
    Chrome.textbox(0, 12, 18, 4);
    const def = mon ? this.speciesDef(mon.species) : undefined;
    const frame = this.picAnimFrame();
    if (frame) {
      const [sheet, quad, size] = frame;
      this.drawScrolled(sheet, FRONTPIC_X, FRONTPIC_Y, this.monColors(mon), quad, size, this.picAnim!.trueColor);
    } else {
      const [image, trueColor] = this.monPic(mon, false);
      this.drawScrolled(image, FRONTPIC_X, FRONTPIC_Y, this.monColors(mon), null, null, trueColor);
    }
    this.drawPlacements(HallOfFame.headerPlacements(this.mode, this.entry ? this.entry.winCount : undefined, this.textData));
    this.drawPlacements(HallOfFame.monPlacements(mon, def));
  }

  // Lua: HallOfFame.lua:690 -- HOF_AnimatePlayerPic's card: `lb bc, 8, 9` at
  // (0,2) and `lb bc, 4, 18` at (0,12). The bottom box is left empty.
  drawPlayerPanel(): void {
    Chrome.clear();
    Chrome.textbox(0, 2, 9, 8);
    Chrome.textbox(0, 12, 18, 4);
    this.drawPortrait(TRAINERPIC_X, TRAINERPIC_Y);
    this.drawPlacements(HallOfFame.playerPlacements(this.save));
  }

  // Lua: HallOfFame.lua:698
  drawPanel(): void {
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 0, 0, SCREEN_W, SCREEN_H);

    // Both entry points put FontBattleExtra in the $60 slot first: '№' ($74)
    // and '<ID>' ($73) are that sheet's glyphs.
    const wasBattle = Font.useBattleExtra(true);

    if (this.phase === "backpic") {
      const mon = this.currentMon();
      const [image, trueColor] = this.monPic(mon, true);
      this.drawScrolled(image, BACKPIC_X, BACKPIC_Y, this.monColors(mon), null, null, trueColor);
    } else if (this.phase === "frontpic") {
      const mon = this.currentMon();
      const [image, trueColor] = this.monPic(mon, false);
      this.drawScrolled(image, FRONTPIC_X, FRONTPIC_Y, this.monColors(mon), null, null, trueColor);
    } else if (this.phase === "display") {
      this.drawMonPanel();
    } else if (this.phase === "playerBack") {
      this.drawScrolled(this.image(this.playerBackPath), BACKPIC_X, BACKPIC_Y, this.playerColors());
    } else if (this.phase === "playerFront") {
      this.drawPortrait(TRAINERPIC_X, TRAINERPIC_Y);
    } else if (this.phase === "player") {
      this.drawPlayerPanel();
    }
    Font.useBattleExtra(wasBattle);
    G.setColor(1, 1, 1, 1);
  }

  // Lua: HallOfFame.lua:734
  draw(): void {
    Chrome.withClip(() => this.drawPanel());
  }

  // Lua: HallOfFame.lua:738
  drawWidescreen(winW: number, winH: number): void {
    Chrome.withPanel(winW, winH, 0, 0, 0, () => this.drawPanel());
  }
}

export default HallOfFame;
