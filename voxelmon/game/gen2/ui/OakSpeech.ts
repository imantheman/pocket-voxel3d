// gen1recomp src/ui/gen2/OakSpeech.lua (bdfac727): the Gen 2 Oak speech
// (pokegold OakSpeech in engine/menus/intro_menu.asm).
// Retail order: InitClock -> Oak -> Marill wipe (+ cry) -> Oak -> player pic ->
// NamePlayer -> ready -> ShrinkPlayer. Gender select is Crystal-later;
// InitClock is not, it is the very first thing OakSpeech farcalls
// (engine/menus/intro_menu.asm) and it is ui/InitClock.ts.
//
// The beats are a DATA TABLE for the same reason Gen 1's are: Gold has a real
// Oak speech, so it is the same extension point under the same names
// (hook intro.oak_speech.build; events intro.oak_speech.started / step /
// answered / finished). Step ids match Gen 1's wherever the moment is the
// same one -- oak_welcome, demo_mon, world_spiel, ask_player_name,
// name_player, legend, shrink -- plus Gold's own `init_clock` and
// `oak_study`.
//
// On the Gold screen: pics are tile grids (G.draw), the rotate reveal and the
// fades are rBGP bytes (GbcPalette.setBgp), the Marill wipe is the pic moving
// as objects until it lands on the grid.

import G, { type LcdImage } from "../platform/screen.ts";
import { CommonText } from "../core/CommonText.ts";
import { Save as Gen2Save } from "../core/Save.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { TextBox, type TextBoxOpts } from "../shared/render/TextBox.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { FieldMoves } from "../world/FieldMoves.ts";
import { Palettes } from "../world/Palettes.ts";
import { Chrome } from "./Chrome.ts";
import { IntroFade, type FadeKind } from "./IntroFade.ts";
import { NamePick } from "./NamePick.ts";

type Colors = readonly (readonly number[])[];

// Lua: OakSpeech.lua:60
const FADE_FRAMES = 24;
// Lua: OakSpeech.lua:62 -- pokecrystal/engine/menus/intro_menu.asm:875-888
const WIPE_FRAMES = 16;

// Lua: OakSpeech.lua:65 -- pokecrystal/engine/menus/intro_menu.asm:854-872
const FRONTPIC_BGP = [0x54, 0xa8, 0xfc, 0xf8, 0xf4, 0xe4];
const FRONTPIC_STEP = 10;
const ROTATE_FRAMES = FRONTPIC_BGP.length * FRONTPIC_STEP;

// Lua: OakSpeech.lua:82 -- ../pokecrystal/engine/menus/intro_menu.asm:802-851 ShrinkPlayer
const SHRINK_PIC1 = 8;
const SHRINK_PIC2 = 16;
const SHRINK_CLEAR = 24;
const SHRINK_ICON = 27;
const SHRINK_END = 77;
// Lua: OakSpeech.lua:93 -- ../pokecrystal/engine/menus/intro_menu.asm:945-948
const ICON_X = 64;
const ICON_Y = 60;

// Lua: OakSpeech.lua:95
const FALLBACKS: Record<string, string> = {
  _OakText1: Strings.source("Hello! Sorry to\nkeep you waiting!\fWelcome to the\nworld of POKéMON!\fMy name is OAK.\fPeople call me the\nPOKéMON PROF."),
  _OakText2: Strings.source("This world is in-\nhabited by crea-\vtures that we call\vPOKéMON."),
  _OakText4: Strings.source("People and POKéMON\nlive together by\fsupporting each\nother.\fSome people play\nwith POKéMON, some\vbattle with them."),
  _OakText5: Strings.source("But we don't know\neverything about\vPOKéMON yet.\fThere are still\nmany mysteries to\vsolve.\fThat's why I study\nPOKéMON every day."),
  _OakText6: Strings.source("Now, what did you\nsay your name was?"),
  _OakText7: Strings.source("{PLAYER}, are you\nready?\fYour very own\nPOKéMON story is\vabout to unfold.\fYou'll face fun\ntimes and tough\vchallenges.\fA world of dreams\nand adventures\fwith POKéMON\nawaits! Let's go!\fI'll be seeing you\nlater!"),
};

/** Lua: OakSpeech.lua:104 */
function tryImage(path: string | null | undefined): LcdImage | null {
  if (!path) return null;
  try {
    return Assets.image(path);
  } catch {
    return null;
  }
}

/**
 * Lua: OakSpeech.lua:114 -- naming presets are boot config the same way Gen 1
 * reads them (field.boot.namePresets); NamePick.presetsFor is the fallback.
 */
function namePresets(game: any, who: string, fallback: string[]): string[] {
  const boot = game && game.data && game.data.field && game.data.field.boot;
  const presets = boot && boot.namePresets && boot.namePresets[who];
  if (Array.isArray(presets) && presets.length > 0) return presets;
  return fallback;
}

/** A beat of the speech (see defaultSteps). */
export interface OakStep {
  id?: string;
  kind?: string;
  textKey?: string;
  text?: string;
  pic?: any;
  reveal?: string;
  fadeOut?: boolean;
  flip?: boolean;
  cry?: any;
  who?: string;
  saveKey?: string;
  presets?: string[];
  presetsWho?: string;
  presetsFallback?: string[];
  choices?: string[];
  values?: any[];
  tx?: number;
  ty?: number;
  tw?: number;
  cancelable?: boolean;
  run?: (speech: OakSpeech, done: () => void) => void;
  [key: string]: any;
}

interface Reveal {
  kind: string;
  t: number;
  dur: number;
  next?: (() => void) | undefined;
}

export interface OakSpeechOpts {
  onDone?: () => void;
  data?: any;
  font?: any;
}

// Lua: OakSpeech.lua:116 -- the identity a build hook falls back to
function sameSteps(steps: OakStep[]): OakStep[] {
  return steps;
}

export class OakSpeech {
  static isOpaque = true;
  static FRONTPIC_BGP = FRONTPIC_BGP;
  static FRONTPIC_STEP = FRONTPIC_STEP;
  static ROTATE_FRAMES = ROTATE_FRAMES;
  static WIPE_FRAMES = WIPE_FRAMES;
  static SHRINK_MUSIC_FADE = 32;
  static SHRINK_PIC1 = SHRINK_PIC1;
  static SHRINK_PIC2 = SHRINK_PIC2;
  static SHRINK_CLEAR = SHRINK_CLEAR;
  static SHRINK_ICON = SHRINK_ICON;
  static SHRINK_END = SHRINK_END;

  [key: string]: any;
  isOpaque = true;
  game: any;
  onDone: (() => void) | undefined;
  cfg: any;
  texts: Record<string, unknown>;
  oakPic: LcdImage | null;
  playerPic: LcdImage | null;
  playerPicFemale: LcdImage | null;
  demoSpecies: string;
  marillPic: LcdImage | null;
  marillTrueColor: boolean;
  shrinkPic1: LcdImage | null;
  shrinkPic2: LcdImage | null;
  music: string;
  palettes: any;
  oakColors: Colors | undefined;
  playerColors: Colors | undefined;
  playerColorsFemale: Colors | undefined;
  marillColors: Colors | undefined | null;
  picColors: Colors | undefined | null = null;
  fontOk = false;
  step = 0;
  steps: OakStep[] | null = null;
  answers: Record<string, unknown> = {};
  pic: LcdImage | null = null;
  picFlip = false;
  picReveal: Reveal | null = null;
  busy = false;
  shrink: { frame: number } | null = null;
  shrinkText: string[] | null = null;
  playerIcon: { image: LcdImage; colors: Colors | undefined } | null = null;
  autoConfirm?: boolean;
  faded?: boolean;
  musicStarted?: boolean;
  finished?: boolean;

  /** Lua: OakSpeech.lua:73 -- the rBGP byte the rotate reveal is on at frame t. */
  static frontpicBgp(t?: number): number {
    let k = Math.floor((t ?? 0) / FRONTPIC_STEP) + 1;
    if (k < 1) k = 1;
    if (k > FRONTPIC_BGP.length) k = FRONTPIC_BGP.length;
    return FRONTPIC_BGP[k - 1]!;
  }

  /** Lua: OakSpeech.lua:125 */
  constructor(game: any, opts: OakSpeechOpts = {}) {
    this.game = game;
    this.onDone = opts.onDone;
    const data = opts.data ?? {};
    this.cfg = data;
    this.texts = data.text ?? {};
    const gdata = game ? game.data : undefined;
    this.oakPic = tryImage(data.oakPic ?? "assets/generated/intro/oak.png");
    // player.sprite, where Gen 1's Oak speech raises it.
    this.playerPic = tryImage(Sprites.playerPic(data.playerPic ?? "assets/generated/intro/cal.png", { side: "front", kind: "intro", data: gdata })[0]);
    // DrawIntroPlayerPic's other arm, KrisPic under trainer class KRIS
    // (../pokecrystal/engine/gfx/player_gfx.asm:170-188).
    this.playerPicFemale = tryImage(Sprites.playerPic(data.playerPicFemale ?? "assets/generated/intro/kris.png", { side: "front", kind: "intro", data: gdata })[0]);
    this.demoSpecies = data.demoSpecies ?? "MARILL";
    const [marillPath, marillTrueColor] = Sprites.pic(data.marillPic ?? "assets/generated/battle/front/marill.png", {
      species: this.demoSpecies,
      side: "front",
      kind: "oak",
      data: gdata,
    });
    this.marillPic = tryImage(marillPath);
    this.marillTrueColor = marillTrueColor;
    this.shrinkPic1 = tryImage(data.shrink1 ?? "assets/generated/intro/shrink1.png");
    this.shrinkPic2 = tryImage(data.shrink2 ?? "assets/generated/intro/shrink2.png");
    this.music = data.music ?? "Music_Route30";
    // Every pic on this screen is loaded under SCGB_TRAINER_OR_MON_FRONTPIC_PALS:
    // the pic's own two shipped colours bracketed by white and black.
    // POKEMON_PROF for Oak, CAL for the player.
    const palettes = (gdata && gdata.gen2Palettes) || null;
    this.palettes = palettes;
    this.oakColors = Palettes.trainerColors(palettes, "POKEMON_PROF");
    this.playerColors = Palettes.trainerColors(palettes, "CAL");
    // KrisPalette is Falkner's row (../pokecrystal/data/trainers/palettes.asm:11-12).
    this.playerColorsFemale = Palettes.trainerColors(palettes, "FALKNER");
    this.marillColors = Palettes.monColors(palettes, this.demoSpecies);
    if (marillTrueColor && GbcPalette.mode === "gbc") this.marillColors = null;
    const font = opts.font;
    if (font) {
      try {
        Font.load({ font });
        this.fontOk = true;
      } catch {
        this.fontOk = false;
      }
    }
  }

  /** Lua: OakSpeech.lua:125 */
  static new(game: any, opts?: OakSpeechOpts): OakSpeech {
    return new OakSpeech(game, opts ?? {});
  }

  /** Lua: OakSpeech.lua:122 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: OakSpeech.lua:123 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: OakSpeech.lua:194 -- wPlayerGender (../pokecrystal/engine/menus/init_gender.asm:36-38). */
  gender(): string | undefined {
    const save = this.game && this.game.save;
    return (save && save.player && save.player.gender) || undefined;
  }

  /** Lua: OakSpeech.lua:202 -- DrawIntroPlayerPic reads the byte every time it runs; a tuple. */
  playerPicNow(): [LcdImage | null, Colors | undefined] {
    if (this.gender() === "female" && this.playerPicFemale) {
      return [this.playerPicFemale, this.playerColorsFemale ?? this.playerColors];
    }
    return [this.playerPic, this.playerColors];
  }

  /** Lua: OakSpeech.lua:209 */
  text(key: string): string {
    const t = this.texts[key];
    if (typeof t === "string" && t.length > 0) return t;
    return FALLBACKS[key] ?? "";
  }

  // ---------------------------------------------------------------- steps

  /** Lua: OakSpeech.lua:219 -- the vanilla beat list. */
  static defaultSteps(speech?: OakSpeech | null): OakStep[] {
    const steps: OakStep[] = [
      // `farcall InitClock` is the first line of OakSpeech.
      { id: "init_clock", kind: "initclock" },
      // Intro_PrepTrainerPic POKEMON_PROF, FadeInIntroPic, OakText1.
      { id: "oak_welcome", kind: "say", textKey: "_OakText1", pic: "oak", reveal: "rotate", fadeOut: true },
      // The Marill show-off: MovePicRight wipes it in, then its cry, then OakText2.
      { id: "demo_mon", kind: "demo" },
      // OakText4 over the same pic.
      { id: "world_spiel", kind: "say", textKey: "_OakText4", fadeOut: true },
      // Back to Oak for OakText5 (Gold's own beat).
      { id: "oak_study", kind: "say", textKey: "_OakText5", pic: "oak", reveal: "rotate", fadeOut: true },
      // The CAL frontpic comes up under the question NamePlayer answers.
      { id: "ask_player_name", kind: "say", textKey: "_OakText6", pic: "player", reveal: "rotate" },
      { id: "name_player", kind: "name", who: "player", saveKey: "name" },
      // OakText7 with the pic already up: NamePlayer walked it back itself.
      { id: "legend", kind: "say", textKey: "_OakText7", pic: "player" },
      { id: "shrink", kind: "shrink", textKey: "_OakText7" },
    ];
    // PlayerProfileSetup's `farcall InitGender` runs before OakSpeech is called.
    // ../pokecrystal/engine/menus/intro_menu.asm:61-67, :79-83
    const data = speech && speech.game && speech.game.data;
    if (FieldMoves.hasGenderChoice(data && data.gen2Sprites)) {
      steps.unshift({ id: "gender_select", kind: "gender", saveKey: "gender" });
    }
    return steps;
  }

  /** Lua: OakSpeech.lua:262 -- intro.oak_speech.build */
  buildSteps(): OakStep[] {
    const steps = OakSpeech.defaultSteps(this);
    if (!Runtime.wantsHook("intro.oak_speech.build")) return steps;
    const hooked = Runtime.call("intro.oak_speech.build", sameSteps, steps, this);
    if (!Array.isArray(hooked)) {
      Logger.error("intro.oak_speech.build returned %s; keeping vanilla steps", typeof hooked);
      return steps;
    }
    return hooked as OakStep[];
  }

  /**
   * Lua: OakSpeech.lua:276 -- `ld de, MUSIC_ROUTE_30 / call PlayMusic`.
   * ../pokecrystal/engine/menus/intro_menu.asm:632-633, init_gender.asm:59-65
   */
  startMusic(): void {
    if (this.musicStarted) return;
    this.musicStarted = true;
    const data = this.game && this.game.data;
    if (data && data.audio && data.audio.runtime) {
      Music.play(data, this.music, true, { reason: "oak_speech" } as any);
    }
  }

  /** Lua: OakSpeech.lua:285 */
  enter(): void {
    this.step = 0;
    this.answers = {};
    this.steps = this.buildSteps();
    if (!(this.steps[0] && this.steps[0].kind === "gender")) this.startMusic();
    if (Runtime.wants("intro.oak_speech.started")) {
      Runtime.emit("intro.oak_speech.started", { speech: this, steps: this.steps });
    }
    this.advance();
  }

  // ---------------------------------------------------------------- pics

  /** Lua: OakSpeech.lua:303 -- a step's `pic`; a tuple (image, colours). */
  resolvePic(desc: any): [LcdImage | null, Colors | undefined | null] {
    if (desc === "oak") return [this.oakPic, this.oakColors];
    if (desc === "player") return this.playerPicNow();
    if (desc === "demo") return [this.marillPic, this.marillColors];
    if (desc === null || typeof desc !== "object") return [null, null];
    if (desc.type === "pokemon") {
      const mon = this.game && this.game.data && this.game.data.pokemon;
      const def = mon && mon[desc.id];
      const [path, trueColor] = Sprites.pic(def && def.spriteFront, {
        species: desc.id,
        side: "front",
        kind: "oak",
        data: this.game && this.game.data,
      });
      let colors: Colors | undefined | null = desc.colors ?? Palettes.monColors(this.palettes, desc.id);
      if (trueColor && GbcPalette.mode === "gbc") colors = null;
      return [tryImage(path), colors];
    }
    if (desc.type === "trainer") {
      return [tryImage(desc.path), desc.colors ?? Palettes.trainerColors(this.palettes, desc.id)];
    }
    // { type = "image", path = ..., colors = ... }, and a pre-loaded image.
    if (desc.path) return [tryImage(desc.path), desc.colors];
    return [desc.image ?? null, desc.colors];
  }

  /** Lua: OakSpeech.lua:333 -- picFlip belongs to the pic, not the step. */
  applyPic(step: OakStep): void {
    if (step.pic == null) return;
    const [img, colors] = this.resolvePic(step.pic);
    this.pic = img;
    this.picColors = colors;
    this.picFlip = !!step.flip;
  }

  /** Lua: OakSpeech.lua:341 */
  reveal(kind: string, next?: () => void): void {
    let dur = FADE_FRAMES;
    if (kind === "wipe") dur = WIPE_FRAMES;
    else if (kind === "rotate") dur = ROTATE_FRAMES;
    this.picReveal = { kind, t: 0, dur, next };
  }

  /** Lua: OakSpeech.lua:356 */
  afterReveal(step: OakStep, fn: () => void): void {
    if (step.reveal) this.reveal(step.reveal, fn);
    else fn();
  }

  /** Lua: OakSpeech.lua:364 */
  showPic(img: LcdImage | null, reveal: string | null | undefined, next?: () => void, colors?: Colors | null): void {
    this.pic = img;
    this.picColors = colors;
    this.picFlip = false;
    if (reveal) this.reveal(reveal, next);
    else if (next) next();
  }

  /** Lua: OakSpeech.lua:375 */
  playCry(species: string): void {
    const data = this.game && this.game.data;
    if (data && data.audio && data.audio.cries && data.audio.cries[species]) Sound.playCry(data, species);
  }

  /** Lua: OakSpeech.lua:382 */
  playMarillCry(): void {
    this.playCry(this.demoSpecies);
  }

  /** Lua: OakSpeech.lua:387 -- `cry = true` means "the mon this step's pic shows". */
  runCry(step: OakStep): void {
    let cry = step.cry;
    if (!cry) return;
    if (cry === true) {
      if (step.pic && typeof step.pic === "object" && step.pic.type === "pokemon") cry = step.pic.id;
      else if (step.pic === "demo") cry = this.demoSpecies;
      else return;
    }
    this.playCry(cry);
  }

  // ---------------------------------------------------------------- beats

  /** Lua: OakSpeech.lua:404 */
  stepText(step: OakStep): string {
    if (step.text) return step.text;
    if (step.textKey) return this.text(step.textKey);
    return "";
  }

  /** Lua: OakSpeech.lua:410 */
  sayText(text: string, next?: (() => void) | null, opts?: TextBoxOpts): void {
    this.busy = true;
    this.game.stack.push(TextBox.new(this.game, text, () => {
      this.busy = false;
      if (next) next();
    }, opts));
  }

  /** Lua: OakSpeech.lua:418 */
  say(key: string, next?: () => void): void {
    this.sayText(this.text(key), next);
  }

  /**
   * Lua: OakSpeech.lua:426 -- `farcall InitClock` does not return until both
   * halves are confirmed, so the speech pushes the screen and only advances
   * on its way out.
   */
  openInitClock(): void {
    const game = this.game;
    if (!(game && game.stack)) return this.advance();
    this.busy = true;
    const faded = this.faded;
    this.faded = false;
    const pushed = Screens.push(game, "Gen2InitClock", {
      mode: "clock",
      save: game.save,
      autoConfirm: this.autoConfirm,
      fades: !this.autoConfirm,
      faded,
      onDone: () => {
        game.stack.pop();
        // ../pokecrystal/engine/menus/intro_menu.asm:629-635
        if (this.autoConfirm) {
          this.busy = false;
          return this.advance();
        }
        IntroFade.run(this, ["inBlack", "outWhite"], () => {
          this.busy = false;
          this.advance();
        });
      },
    });
    if (!pushed) {
      this.busy = false;
      this.advance();
    }
  }

  /**
   * Lua: OakSpeech.lua:460 -- InitGender, pushed where PlayerProfileSetup
   * farcalls it (../pokecrystal/engine/menus/intro_menu.asm:79-83).
   */
  openGenderSelect(step: OakStep): void {
    const game = this.game;
    if (!(game && game.stack)) {
      this.startMusic();
      return this.advance();
    }
    this.busy = true;
    const pushed = Screens.push(game, "Gen2GenderSelect", {
      save: game.save,
      fades: !this.autoConfirm,
      onDone: (gender: string) => {
        game.stack.pop();
        this.busy = false;
        // ../pokecrystal/engine/rtc/timeset.asm:22
        this.faded = !this.autoConfirm;
        // `ld hl, wPlayerName / ld de, .Chris|.Kris / call InitName`
        // (../pokecrystal/engine/menus/intro_menu.asm:768-781).
        const save = game.save;
        if (save && save.player) save.player.name = Gen2Save.defaultPlayerName(save.version, gender);
        this.recordAnswer(step, gender === "female" ? 2 : 1, gender === "female" ? "Girl" : "Boy", gender);
        this.startMusic();
        this.advance();
      },
    });
    if (!pushed) {
      this.busy = false;
      this.startMusic();
      this.advance();
    }
  }

  /** Lua: OakSpeech.lua:495 */
  openNamePick(step: OakStep): void {
    this.busy = true;
    const gender = this.gender();
    const [pic, picColors] = this.playerPicNow();
    Screens.push(this.game, "Gen2NamePick", {
      font: this.game.fontData,
      gender,
      // NamePlayer opens with MovePlayerPicRight, so the name menu owns the
      // pic while it is up.
      pic,
      picColors,
      presets: step.presets ?? namePresets(this.game, step.presetsWho ?? step.who ?? "player", step.presetsFallback ?? NamePick.presetsFor(gender)),
      onDone: (name?: string) => {
        name = name ?? NamePick.presetsFor(gender)[0];
        this.game.save.player.name = name;
        this.game.stack.pop(); // NamePick
        this.busy = false;
        this.recordAnswer(step, 1, name, name);
        this.advance();
      },
    });
  }

  /** Lua: OakSpeech.lua:522 -- the last page of a text, as its non-empty lines. */
  lastPageLines(key: string): string[] {
    const body = CommonText.plain(this.text(key));
    const pages = body.split("\f");
    const last = pages[pages.length - 1] ?? body;
    const lines: string[] = [];
    for (const line of last.split("\n")) if (line !== "") lines.push(line);
    if (lines.length === 0 && last !== "") lines[0] = last;
    return lines;
  }

  /** Lua: OakSpeech.lua:537 */
  startShrink(step?: OakStep): void {
    this.shrinkText = this.lastPageLines((step && step.textKey) || "_OakText7");
    this.shrink = { frame: 0 };
    this.playerIcon = null;
    const data = this.game && this.game.data;
    // ../pokecrystal/engine/menus/intro_menu.asm:806-812
    Music.fadeOut(OakSpeech.SHRINK_MUSIC_FADE);
    if (data && data.audio && data.audio.sfx && data.audio.sfx.Sfx_EscapeRope) Sound.play(data, "Sfx_EscapeRope");
  }

  /** Lua: OakSpeech.lua:551 -- ../pokecrystal/engine/menus/intro_menu.asm:911-950 Intro_PlacePlayerSprite */
  overworldIcon(): { image: LcdImage; colors: Colors | undefined } | null {
    const data = this.game && this.game.data;
    const sprites = data && data.gen2Sprites;
    const def = sprites && sprites[FieldMoves.playerSprite(this.gender())];
    const image = def && tryImage(def.image);
    if (!image) return null;
    const colors = data.gen2Palettes ? Palettes.spritePalette(data.gen2Palettes, "DAY", def) : undefined;
    return { image, colors };
  }

  /** Lua: OakSpeech.lua:565 -- a beat that produced a value. */
  recordAnswer(step: OakStep, index: number, label: unknown, value?: unknown): void {
    if (value === undefined) value = label;
    if (step.saveKey) this.answers[step.saveKey] = value;
    if (Runtime.wants("intro.oak_speech.answered")) {
      Runtime.emit("intro.oak_speech.answered", {
        speech: this,
        step,
        index,
        label,
        value,
        saveKey: step.saveKey,
      });
    }
  }

  /** Lua: OakSpeech.lua:586 -- a build wrapper's `choice` step: VerticalMenu. */
  openChoice(step: OakStep): void {
    const labels = step.choices ?? [];
    const left = step.tx ?? 0;
    const top = step.ty ?? 0;
    const width = step.tw ?? 10;
    const pushed = Screens.push(this.game, "Gen2ScriptMenu", {
      header: {
        left,
        top,
        right: left + width,
        bottom: top + labels.length * 2 + 1,
        items: labels,
        // STATICMENU_CURSOR; B is left enabled only when the step asks for it.
        dataFlags: 0x80,
        cursor: 1,
      },
      style: "vertical",
      onChoose: (index?: number) => {
        this.game.stack.pop();
        this.busy = false;
        if (index === 0 || index == null) {
          if (step.cancelable) return this.advance();
          index = 1;
        }
        const label = labels[index - 1];
        let value: unknown = label;
        if (step.values && step.values[index - 1] !== undefined) value = step.values[index - 1];
        this.recordAnswer(step, index, label, value);
        this.advance();
      },
    });
    if (!pushed) {
      this.busy = false;
      this.advance();
    }
  }

  /** Lua: OakSpeech.lua:623 -- pokecrystal/engine/menus/intro_menu.asm:649-650,672-673,687-688 */
  leaveBeat(step: OakStep): void {
    if (!step.fadeOut || this.autoConfirm) return this.advance();
    IntroFade.run(this, ["outWhite"], () => {
      this.pic = null;
      this.picColors = null;
      this.advance();
    });
  }

  /** Lua: OakSpeech.lua:631 */
  runStep(step: OakStep): void {
    const kind = step.kind ?? "say";
    if (kind === "gender") {
      this.openGenderSelect(step);
    } else if (kind === "initclock") {
      this.openInitClock();
    } else if (kind === "say") {
      this.applyPic(step);
      this.afterReveal(step, () => {
        this.runCry(step);
        this.sayText(this.stepText(step), () => this.leaveBeat(step));
      });
    } else if (kind === "demo") {
      // Intro_PrepMonFrontpic + MovePicRight + the cry, then OakText2.
      this.showPic(this.marillPic, "wipe", () => {
        this.playMarillCry();
        this.say("_OakText2", () => this.advance());
      }, this.marillColors);
    } else if (kind === "pic") {
      this.applyPic(step);
      this.afterReveal(step, () => {
        this.runCry(step);
        this.advance();
      });
    } else if (kind === "name") {
      this.openNamePick(step);
    } else if (kind === "yesno") {
      this.applyPic(step);
      this.afterReveal(step, () => {
        this.runCry(step);
        this.busy = true;
        this.sayText(this.stepText(step), null, {
          instant: true,
          choice: (yes: boolean) => {
            this.busy = false;
            const label = yes ? "YES" : "NO";
            let value: unknown = yes;
            if (step.values) value = yes ? step.values[0] : step.values[1];
            this.recordAnswer(step, yes ? 1 : 2, label, value);
            this.advance();
          },
        } as TextBoxOpts);
      });
    } else if (kind === "choice") {
      this.applyPic(step);
      this.afterReveal(step, () => {
        this.runCry(step);
        const text = this.stepText(step);
        if (text !== "") this.sayText(text, () => this.openChoice(step));
        else this.openChoice(step);
      });
    } else if (kind === "shrink") {
      this.startShrink(step);
    } else if (kind === "fn") {
      // full escape hatch: step.run(speech, done)
      if (typeof step.run === "function") step.run(this, () => this.advance());
      else this.advance();
    } else {
      Logger.warn("oak speech unknown step kind %s (id=%s); skipping", String(kind), String(step.id));
      this.advance();
    }
  }

  /** Lua: OakSpeech.lua:703 */
  advance(): void {
    this.step += 1;
    let steps = this.steps;
    if (!steps) {
      // enter() builds the list; keep a path for callers that advance early.
      steps = this.buildSteps();
      this.steps = steps;
    }
    const step = steps[this.step - 1];
    if (!step) return this.finish();
    if (Runtime.wants("intro.oak_speech.step")) {
      Runtime.emit("intro.oak_speech.step", { speech: this, step, index: this.step });
    }
    this.runStep(step);
  }

  /** Lua: OakSpeech.lua:721 -- guarded: a second emit would look like a second speech. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (Runtime.wants("intro.oak_speech.finished")) {
      Runtime.emit("intro.oak_speech.finished", { speech: this, answers: this.answers });
    }
    if (this.onDone) this.onDone();
  }

  /** Lua: OakSpeech.lua:735 */
  update(_dt?: number): void {
    // ../pokecrystal/home/fade.asm:22-101
    if (IntroFade.advance(this)) return;
    const r = this.picReveal;
    if (r) {
      r.t += 1;
      if (r.t >= r.dur) {
        this.picReveal = null;
        if (r.next) r.next();
      }
      return;
    }
    // ../pokecrystal/engine/menus/intro_menu.asm:820-851
    const s = this.shrink;
    if (!s) return;
    s.frame += 1;
    if (s.frame === SHRINK_PIC1) {
      this.pic = this.shrinkPic1 ?? this.pic;
    } else if (s.frame === SHRINK_PIC2) {
      this.pic = this.shrinkPic2 ?? this.pic;
    } else if (s.frame === SHRINK_CLEAR) {
      this.pic = null;
    } else if (s.frame === SHRINK_ICON) {
      this.playerIcon = this.overworldIcon();
    } else if (s.frame >= SHRINK_END) {
      this.shrink = null;
      // ../pokecrystal/engine/menus/intro_menu.asm:849-850
      IntroFade.run(this, ["outWhite"] as FadeKind[], () => {
        this.shrinkText = null;
        this.playerIcon = null;
        this.finish();
      });
    }
  }

  /** Lua: OakSpeech.lua:770 */
  drawPic(): void {
    const pic = this.pic;
    if (!pic) return;
    const [w, h] = pic.getDimensions();
    // Intro_PrepTrainerPic / PrepMonFrontpic: 7x7 cell at hlcoord 6,4.
    const x = 48 + Math.floor((8 - w / 8) / 2) * 8;
    const y = 32 + (7 - h / 8) * 8;
    const reveal = this.picReveal;
    let off = 0;
    let rotating = false;
    // NOT FAITHFUL: the Lua's alpha ramps ("fade", and "rotate" without a
    // palette) have no Gold screen form; the pic appears once half faded in.
    let hidden = false;
    if (reveal && reveal.kind === "fade") {
      hidden = Math.min(1, reveal.t / reveal.dur) < 0.5;
    } else if (reveal && reveal.kind === "wipe") {
      off = Math.floor((160 - x) * (1 - Math.min(1, reveal.t / reveal.dur)));
    } else if (reveal && reveal.kind === "rotate") {
      rotating = GbcPalette.available() && this.picColors != null;
      if (!rotating) hidden = Math.min(1, reveal.t / reveal.dur) < 0.5;
    }
    G.setColor(1, 1, 1, 1);
    if (hidden) return;
    const body = (): void => {
      if (this.picFlip) G.draw(pic, x + off + w, y, 0, -1, 1);
      else G.draw(pic, x + off, y);
    };
    if (this.picColors && GbcPalette.available()) {
      // pokecrystal/engine/menus/intro_menu.asm:858-860
      let previous: number | null = null;
      if (rotating) previous = GbcPalette.setBgp(OakSpeech.frontpicBgp(reveal!.t));
      try {
        GbcPalette.with(this.picColors, body);
      } finally {
        if (rotating) GbcPalette.setBgp(previous);
      }
    } else {
      body();
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: OakSpeech.lua:818 -- ../pokecrystal/engine/menus/intro_menu.asm:911-950 */
  drawPlayerIcon(): void {
    const icon = this.playerIcon;
    if (!icon || !icon.image) return;
    G.setColor(1, 1, 1, 1);
    const [w, h] = icon.image.getDimensions();
    const quad = G.newQuad(0, 0, Math.min(16, w), Math.min(16, h), w, h);
    if (icon.colors && GbcPalette.available()) {
      GbcPalette.with(icon.colors, () => G.draw(icon.image, quad, ICON_X, ICON_Y));
    } else {
      G.draw(icon.image, quad, ICON_X, ICON_Y);
    }
  }

  /** Lua: OakSpeech.lua:835 -- pokecrystal/engine/gfx/cgb_layouts.asm:895-904 */
  screenPalette(): Colors {
    return this.picColors ?? Chrome.DEFAULT_BOX_PALETTE;
  }

  /** Lua: OakSpeech.lua:839 */
  drawPanel(): void {
    const palette = this.screenPalette();
    Chrome.paletteFill(0, 0, 160, 144, palette);
    G.setColor(1, 1, 1, 1);
    this.drawPic();
    this.drawPlayerIcon();
    if (this.shrinkText && this.fontOk) {
      // home/text.asm:142 PrintText -> SetUpTextbox -> SpeechTextbox
      Chrome.paletteBox(0, 12, 20, 6, palette);
      let row = 14;
      for (const line of this.shrinkText) {
        if (row <= 16) Chrome.printThrough(line, 1, row, palette);
        row += 2;
      }
      G.setColor(1, 1, 1, 1);
    }
  }

  /** Lua: OakSpeech.lua:858 */
  drawBody(): void {
    IntroFade.paint(this, 160, 144, () => this.drawPanel());
  }

  /** Lua: OakSpeech.lua:863 -- ../pokecrystal/engine/menus/intro_menu.asm:875 */
  draw(): void {
    Chrome.withClip(() => this.drawBody());
  }

  /** Lua: OakSpeech.lua:867 */
  drawWidescreen(winW: number, winH: number): void {
    const [r, g, b] = IntroFade.surround(this, this.screenPalette(), 1, 1, 1);
    Chrome.withPanel(winW, winH, r, g, b, () => this.drawBody());
  }
}

export default OakSpeech;
