// The Game shell: the state stack (overworld / textbox / stub-battle /
// warp-fade), the per-tick drive, and the boot that skips title/intro
// straight into the overworld like the reference test driver
// (tests/drivers/util.lua U.newGame ends standing in the bedroom;
// src/core/SaveData.lua:1345 newGame pins the spawn).
//
// One guest turn per host tick: tick(buttons) exactly once (docs/VOXEL.md
// §3). The tick is: input edges -> update the TOP state only (the Lua
// StateStack rule — everything beneath is frozen, which is also what makes
// the frame a script/box closes non-actionable for the world below) ->
// presentation emit -> frameDone.

import { fromSection, type AudioBanks } from "./audio/banks.ts";
import { AudioDirector } from "./audio/music.ts";
import { WildBattle, type BattleResult } from "./battle/battle.ts";
import { TrainerBattle } from "./battle/trainer.ts";
import { healMon, newMon, type PartyMon } from "./battle/mon.ts";
import { computeStaging, type BattleStaging } from "./battle/staging.ts";
import { BattleUi } from "./battle/ui.ts";
import type { VoxelmonData } from "./data.ts";
import type { VoxelHost } from "./host.ts";
import { Input } from "./input.ts";
import { seededRng, type Rng } from "./rng.ts";
import { apply as applyEvolution, checkParty } from "./rules/evolution.ts";
import { movesLearnedAt } from "./rules/experience.ts";
import { expForLevel } from "./rules/growth.ts";
import { calc as calcStats } from "./rules/stats.ts";
import { MAP_ENTRY_AFTER_BATTLE, POST_BATTLE_RETURN, YES_NO_ANSWER } from "./rules/timing.ts";
import {
  Scene,
  type BattleSceneView,
  type ChoiceSource,
  type Prof,
  type SceneView,
  type UiBoxSource,
} from "./scene.ts";
import { Overworld, type OverworldShell, type SaveSlice } from "./world/overworld.ts";
import { Textbox } from "./world/textbox.ts";
import { NamingState } from "./ui/naming.ts";
import { TitleState, TITLE_PAGES } from "./ui/title.ts";
import { StartMenuState } from "./ui/startmenu.ts";
import { DevMenuState } from "./ui/devmenu.ts";
import { CARD_PIC_RECT, TrainerCardState } from "./ui/trainercard.ts";
import { WarpPickerState } from "./ui/warppicker.ts";
import { MoveForgetState } from "./ui/moveforget.ts";
import { BagState } from "./ui/bagscreen.ts";
import { PartyState } from "./ui/partyscreen.ts";
import { ShopState } from "./ui/shopscreen.ts";
import { BoxState } from "./ui/boxscreen.ts";
import { PokedexState } from "./ui/pokedexscreen.ts";
import { encodeSave } from "./save-lua.ts";
import { decodeSave } from "./save-read.ts";
import * as Bag from "./rules/bag.ts";
/** Must match Version.saveFormat in the recomp. */
const SAVE_FORMAT = 4;   // Version.lua saveFormat
/** battle/trainer/red — the intro portrait, not title/player. */
const RED_PIC_PAGE = 408;

/** The full save: the overworld slice plus the party the battle port added. */
export interface GameSave extends SaveSlice {
  party: PartyMon[];
}

export interface GameState {
  readonly kind: string;
  update(): void;
}

class OverworldState implements GameState {
  readonly kind = "overworld";
  constructor(private ow: Overworld) {}
  update(): void {
    this.ow.update();
  }
}

class TextBoxState implements GameState, UiBoxSource {
  readonly kind = "textbox";
  readonly box: Textbox;
  private choicePushed = false;
  constructor(
    private game: VoxelmonGame,
    text: string,
    private onDone?: () => void,
    private choice?: (yes: boolean) => void,
  ) {
    this.box = new Textbox(text, {
      player: game.save.player.name,
      rival: game.save.player.rival,
    });
  }
  update(): void {
    // opts.choice (TextBox.lua:255): once the last page has typed out, the
    // YES/NO menu pops up over the still-visible text — before the box's
    // done-state can consume A as a close.
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice));
      }
      return;
    }
    const wasWaiting = this.box.waiting;
    const wasDone = this.box.done;
    this.box.update(this.game.input);
    // TextBox.lua:269 and :284 — A/B both close a finished box and advance a
    // waiting one, and each plays the Press_AB beep.
    if ((wasDone && this.box.closed) || (wasWaiting && !this.box.waiting)) {
      this.game.audio.playSfx("Press_AB");
    }
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice));
      }
      return;
    }
    if (this.box.closed) {
      this.game.pop();
      this.onDone?.();
    }
  }
}

class ChoiceState implements GameState, ChoiceSource {
  readonly kind = "choice";
  yes: boolean;
  /** The answer given, held on screen before it is handed back. */
  private pending: boolean | null = null;
  private holdFrames = 0;
  constructor(
    private game: VoxelmonGame,
    private cb: (yes: boolean) => void,
    opts?: { defaultNo?: boolean; noSound?: boolean },
  ) {
    // ChoiceBox.lua:16 — some of the original's prompts open on NO
    this.yes = !opts?.defaultNo;
    this.noSound = opts?.noSound === true;
  }
  private readonly noSound: boolean;
  update(): void {
    const input = this.game.input;
    // ChoiceBox.lua:34-45: BOTH branches of DisplayTwoOptionMenu hold 15
    // frames with the menu still up before TwoOptionMenu_RestoreScreenTiles
    // hands control back (engine/menus/text_box.asm:322-323, :333-334).
    if (this.pending !== null) {
      this.holdFrames -= 1;
      if (this.holdFrames <= 0) {
        const yes = this.pending;
        this.pending = null;
        this.game.pop(); // this choice
        this.game.pop(); // the text box under it (ChoiceBox pops both)
        this.cb(yes);
      }
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      this.yes = !this.yes;
    } else if (input.wasPressed("a")) {
      // HandleMenuInput_ (home/window.asm): SFX_PRESS_AB on A and B alike
      if (!this.noSound) this.game.audio.playSfx("Press_AB"); // ChoiceBox.lua:53
      this.pending = this.yes;
      this.holdFrames = YES_NO_ANSWER;
    } else if (input.wasPressed("b")) {
      if (!this.noSound) this.game.audio.playSfx("Press_AB"); // ChoiceBox.lua:59
      // .choseSecondMenuItem writes wCurrentMenuItem = 1 BEFORE the hold, so
      // the cursor visibly snaps to NO for those 15 frames
      this.yes = false;
      this.pending = false;
      this.holdFrames = YES_NO_ANSWER;
    }
  }
}

// The warp fade: 32 ticks of held world (Timing WARP_FADE_OUT — pokered
// GBFadeOutToBlack), the map switch at the midpoint, no fade back in
// (WARP_FADE_IN = 0: LoadGBPal restores the palettes in one write).
class WarpFadeState implements GameState {
  readonly kind = "warpfade";
  constructor(
    private game: VoxelmonGame,
    private frames: number,
    private midpoint: () => void,
    private onDone?: () => void,
  ) {}
  update(): void {
    this.frames -= 1;
    if (this.frames <= 0) {
      this.game.pop();
      this.midpoint();
      this.onDone?.();
    }
  }
}

// The real wild battle (replacing the overworld slice's StubBattle seam):
// the gen1recomp BattleState port in battle/battle.ts, staged in the voxel
// arena (battle/staging.ts) and drawn through the GB tile layer
// (battle/ui.ts). This state owns the battle's lifetime on the stack; the
// scene reads it through SceneView.battleView().
class BattleGameState implements GameState, BattleSceneView {
  readonly kind = "battle";
  readonly battle: WildBattle;
  readonly staging: BattleStaging | null;
  readonly ui = new BattleUi();

  onDone: (() => void) | null = null;
  // Loseable battles (the OaksLab / Route 22 rival) heal-and-continue on a
  // loss instead of blacking out — set by start_battle/rival_battle opts.
  loseable = false;
  private popped = false;

  constructor(
    private game: VoxelmonGame,
    species: string,
    level: number,
    prebuilt?: WildBattle,
  ) {
    this.battle = prebuilt ??
      new WildBattle(game.data, game.save, game.battleRng, species, level);
    // stage where the player stands; nothing moves the player — the camera
    // goes to the arena (docs/VOXEL.md §4)
    const ow = game.overworld;
    this.staging = computeStaging(ow.map, ow.player.cellX, ow.player.cellY, ow.player.surfing);
    this.battle.enter();
  }

  update(): void {
    const b = this.battle;
    if (b.finished) {
      // Pop BEFORE resuming: done() runs the script synchronously, and if
      // it pushes a textbox first, our own pop() would remove that instead
      // of this battle — the box disappears and its callback never fires.
      const done = this.onDone;
      this.onDone = null;
      if (this.popped) return;
      this.popped = true;
      this.game.pop();
      if (done) done();
      // A lost battle blacks out (heal + warp to the last heal point) unless
      // it's a designated loseable battle (the early rival), whose script
      // heals and continues. The block below is the legacy teardown, kept for
      // its notes; the live path pops + resumes above, so blackout goes here.
      if (b.finished === "lose" && !this.loseable) this.game.blackout();
      // OverworldController.lua:3851-3894 afterBattle: EvolveAfterBattle runs
      // for every exit (the blackout heals first, :3882; other exits run it
      // straight away, :3892). This call was orphaned in the dead legacy block
      // below when the teardown moved to the pop+resume path above — without it
      // no mon ever evolves. The evolution pages push over the overworld the
      // battle just handed back to.
      this.game.runEvolutions(b.leveledUp);
      return;
      // BattleState.lua:4647-4653 — teardown pops the battle screen FIRST,
      // and it is the map that holds: POST_BATTLE_RETURN before EnterMap
      // (home/overworld.asm:351-352) and then MapEntryAfterBattle's
      // GBFadeInFromWhite (:22, :749-753). The port renders both as held
      // frames, the convention WarpFadeState already uses for the warp fade.
      this.game.pop();
      // OverworldController.lua:3851-3894 afterBattle: the blackout warps to
      // the heal point FIRST and takes evolutions() as its callback (:3882),
      // every other exit runs them straight away (:3892).
      if (b.finished === "lose") this.game.blackout();
      this.game.pushWarpFade(
        POST_BATTLE_RETURN + MAP_ENTRY_AFTER_BATTLE,
        () => {},
        () => this.game.runEvolutions(b.leveledUp),
      );
      return;
    }
    b.update(this.game.input);
  }
}

export class VoxelmonGame implements OverworldShell, SceneView {
  readonly data: VoxelmonData;
  readonly host: VoxelHost;
  readonly input = new Input();
  /** Encounter roll stream. Tests may swap it after construction. */
  rng: Rng;
  /** NPC wander stream — separate so ambience can't perturb encounters. */
  npcRng: Rng;
  /** Battle stream — separate so in-battle rolls (enemy DVs, crits, catch
   * wobbles) can never perturb the overworld route's determinism. */
  battleRng: Rng;
  save!: GameSave;
  overworld!: Overworld;
  /** Music, SFX and cries: the POLICY, emitting audio ops. Silent until a
   *  caller hands it the manifest — setAudio(banks) on the Bun transport,
   *  setAudioFromPak() on device. A director with no manifest emits nothing. */
  audio = new AudioDirector(null);
  private stack: GameState[] = [];
  private scene: Scene;
  tickIndex = 0;
  /** Autopilot-only profiling hook (psp-main.ts installs it when the native
   * surface carries `now`/`perf` — the perf-runbook EBOOT alone). Splits
   * tick() into update / scene-emit / audio (and emit into its sections,
   * scene.ts) and reports 300-tick µs sums. Undefined in production and in
   * the Bun sim; gameplay never reads it. */
  prof?: Prof;
  // audio policy observation (the reference calls Music/Sound from the sites
  // themselves; the port watches the same state transitions from one place)
  private audioMap: string | null = null;
  private audioBattle = false;
  private audioRestored = false;

  constructor(data: VoxelmonData, host: VoxelHost, seed = 1) {
    this.data = data;
    this.host = host;
    this.rng = seededRng(seed >>> 0);
    // decorrelated second stream (fixed odd offset keeps seed 0 distinct)
    this.npcRng = seededRng(((seed >>> 0) ^ 0x9e3779b9) >>> 0);
    // third stream for battles (same decorrelation trick, distinct constant)
    this.battleRng = seededRng(((seed >>> 0) ^ 0x85ebca6b) >>> 0);
    this.scene = new Scene(host);
  }

  /**
   * Install the audio manifest — `null` means NO manifest, which is total
   * silence: the director resolves nothing and emits no op. Pass the Bun
   * transport's manifest (gen/audio.json); `setAudioFromPak()` is the device
   * path.
   *
   * The `audiodata` op fires either way, on EVERY host, so a recorded trace
   * carries the same op stream a device run replays (SCHEMA.md ".vtrace").
   * Only setAudioFromPak() reads the answer.
   */
  setAudio(banks: AudioBanks | null): void {
    void this.host.audiodata();
    this.audio = new AudioDirector(banks, this.host);
  }

  /**
   * Load the audio manifest from the pak's AUDI section, over the `audiodata`
   * op — the device transport. Only the JSON half is parsed; the programs
   * stay in the pak, where the core reads them (banks.ts fromSection). A pak
   * cooked without audio answers null and the director stays silent.
   */
  setAudioFromPak(): void {
    this.audio = new AudioDirector(fromSection(this.host.audiodata()), this.host);
  }

  /**
   * The audio policy, ported from the reference's call sites: map themes on
   * map entry (Music.lua:339 playMap), the battle theme and the wild mon's
   * cry on encounter (BattleState.lua:1458, :1496-1498), the victory jingle
   * the moment the win is decided (Music.lua:370), and the map theme back
   * when the battle closes (:407 restoreMap).
   */
  private driveAudio(): void {
    const bv = this.battleView();
    if (bv) {
      if (!this.audioBattle) {
        this.audioBattle = true;
        // play_battle_music.asm runs before the transition (:1458); the cry
        // and the victory theme are NOT observed from out here — the battle
        // queues them where the reference does and we drain them below.
        this.audio.playBattle("wild");
      }
      this.drainBattleCues(bv.battle);
      return;
    }
    if (this.audioBattle) {
      this.audioBattle = false;
      // the battle's own finish() already queued music:restore; this is the
      // backstop for a battle torn down without one
      if (!this.audioRestored) this.audio.restore();
      this.audioRestored = false;
      return;
    }
    const mapId = this.overworld.map.id;
    // A connection crossing switches the map at the START of the seam step;
    // its theme is owed to the frame the step LANDS (OverworldController.lua:
    // 1075), and the overworld pays it through startMapMusic. Observing the
    // map id here would jump the gun by a whole step.
    if (mapId !== this.audioMap && !this.overworld.pendingSeamMusic) {
      this.audioMap = mapId;
      this.audio.startMap(mapId);
    }
  }

  /** Play what the battle queued, in the order it queued it. */
  private drainBattleCues(battle: WildBattle): void {
    const cues = battle.audioCues;
    for (const cue of cues) {
      if (cue.startsWith("cry:")) {
        this.audio.playCry(cue.slice(4));
      } else if (cue.startsWith("sfx:")) {
        this.audio.playSfx(cue.slice(4));
      } else if (cue === "music:victory") {
        // Music.playVictory only has a jingle for a won fight
        this.audio.playVictory("wild");
      } else if (cue === "music:restore") {
        this.audio.restore();
        this.audioRestored = true;
        this.audioMap = this.overworld.map.id;
      }
    }
    cues.length = 0;
  }

  /**
   * Boot straight into the overworld, skipping title/intro like the
   * reference driver's U.newGame: SaveData.lua:1345 pins the spawn at
   * REDS_HOUSE_2F (3,6) facing down, and :1303-1305 defaultHeal resolves
   * the vanilla bedroom spawn to PALLET_TOWN (5,6) for lastHeal AND
   * lastOutdoor (wLastMap is zero-filled and PALLET_TOWN is map 0), which
   * is what makes the 1F exit mat's LAST_MAP warp work before the player
   * has ever been outdoors.
   */
  newGame(): void {
    // SaveData.lua:1566 newGame — same shape and key set the desktop
    // recomp writes, so a save from either side opens in the other.
    this.save = {
      meta: { format: SAVE_FORMAT, mods: {} },
      version: "red",
      player: {
        map: "REDS_HOUSE_2F",
        x: 3,
        y: 6,
        facing: "down",
        name: "RED",
        rival: "BLUE",
        id: Math.floor(Math.random() * 65536),
      },
      flags: {},
      inventory: {},
      pcItems: { POTION: 1 },
      party: [],
      box: {},
      money: 3000,
      defeatedTrainers: {},
      pokedex: { seen: {}, owned: {} },
      lastHeal: { map: "PALLET_TOWN", x: 5, y: 6 },
      lastOutdoor: { id: "PALLET_TOWN", x: 5, y: 6 },
      repelSteps: 0,
      modData: {},
      options: {},
    } as any;
    this.overworld = new Overworld(this);
    this.stack = [new OverworldState(this.overworld)];
    // Oak's speech: portrait + the extracted OakSpeech labels, then the two
    // name entries. gen1recomp src/ui/OakSpeech.lua order.
    this.overworld.enter("REDS_HOUSE_2F", 3, 6, "down");
    // Title screen first; the intro only runs once the player picks.
    (this as any).hasSave = !!this.host.saveData?.();
    // The title is a pushed state, so nothing calls startMap for it; the
    // theme has to be asked for directly.

    // enter() above starts the map theme; the title owns the music until
    // the player picks, so claim it after the world is staged.

    this.push(
      new TitleState(this as any, (choice) => {
        if (choice === "viewer") {
          (this.host as any).viewer?.();
          return;
        }
        if (choice === "continue") {
          const text = this.host.saveData?.();
          if (text) {
            try {
              this.save = decodeSave(text) as any;
              // The live position lives in player.* (SaveData.lua newGame);
              // lastOutdoor is only the palette/blackout anchor.
              const pl: any = this.save.player ?? {};
              const lo: any = this.save.lastOutdoor ?? {};
              this.overworld.enter(
                pl.map ?? lo.id ?? "PALLET_TOWN",
                pl.x ?? lo.x ?? 5,
                pl.y ?? lo.y ?? 6,
                pl.facing ?? "down",
              );
              return;
            } catch { /* fall through to a new game */ }
          }
        }
        this.startIntro();
      }),
    );
  }

  /**
   * The blackout path a lost battle takes (pokered HandleBlackOut,
   * engine/battle/core.asm:1157+: heal the party, special-warp to the last
   * Pokémon center). v1: full heal + the warp fade to save.lastHeal; the
   * money halving (ResetStatusAndHalveMoneyOnBlackout) has no money field
   * to act on in this slice.
   */
  blackout(): void {
    for (const mon of this.save.party) healMon(this.data, mon);
    const heal = this.save.lastHeal as
      | { map: string; x: number; y: number; outdoor?: { id: string; x: number; y: number } }
      | undefined;
    if (heal) {
      this.overworld.startWarpTo(heal.map, heal.x, heal.y, "down");
      // startWarpTo just remembered the map we fainted on as the outdoor side;
      // the heal point exits to the town it's IN, so restore that (setMap into
      // the PC doesn't rewrite it, so this sticks until you walk back out).
      if (heal.outdoor) {
        this.overworld.rememberOutdoor(heal.outdoor.id, heal.outdoor.x, heal.outdoor.y);
      }
    }
  }

  /**
   * DEBUG ONLY — cycles to the next/previous cooked map, landing at that
   * map's own first warp tile (its nearest door), for testing map geometry
   * (vertex-budget fixes, tileset issues) without walking the whole route.
   * Triggered by the 3DS host's L/R shoulder buttons (psp-main.ts frame(),
   * button-word bits 26/27) — outside VOX_BTN/Input on purpose: L/R have no
   * Game Boy equivalent, so this has no business in the ported input model.
   * A no-op mid-battle/mid-transition, or with fewer than 2 cooked maps.
   */
  debugCycleMap(direction: 1 | -1): void {
    if (this.battleView() || this.overworld.transitioning) return;
    const list = this.data.cookedMaps;
    if (!list || list.length < 2) return;
    const curId = this.overworld.map.id;
    let i = list.indexOf(curId);
    if (i < 0) i = 0;
    i = (i + direction + list.length) % list.length;
    const targetId = list[i]!;
    const dw = this.data.maps?.[targetId]?.warps?.[0];
    this.overworld.startWarpTo(targetId, dw?.x ?? 4, dw?.y ?? 4, "down");
  }

  /** Frames since save.playTime last ticked over; never persisted. */
  private playTimeFrames = 0;

  /**
   * save.playTime, the trainer card's TIME field. gen1recomp keeps it as
   * seconds (GenSave.lua:807 rebuilds it from the ROM's H/M/S/frame bytes),
   * so this counts whole seconds rather than adding 1/60 per frame — the
   * card only ever shows H:MM, and an integer keeps the Lua save file free
   * of accumulated float dust.
   */
  private advancePlayTime(): void {
    this.playTimeFrames += 1;
    if (this.playTimeFrames < 60) return;
    this.playTimeFrames = 0;
    const save = this.save as { playTime?: number };
    save.playTime = Math.floor(save.playTime ?? 0) + 1;
  }

  /** One guest turn per host tick — exactly once. */
  tick(buttons: number): void {
    const p = this.prof;
    const t0 = p ? p.now() : 0;
    this.input.setButtons(buttons);
    this.input.step();
    const top = this.stack[this.stack.length - 1];
    top?.update();
    this.advancePlayTime();
    const t1 = p ? p.now() : 0;
    this.scene.emit(this);
    const t2 = p ? p.now() : 0;
    this.driveAudio();
    this.host.frameDone(this.tickIndex, buttons);
    if (p) {
      p.upd += t1 - t0;
      p.emit += t2 - t1;
      p.aud += p.now() - t2;
      if (this.tickIndex % 300 === 299) {
        p.line(
          `j${this.tickIndex} upd ${Math.round(p.upd)} emit ${Math.round(p.emit)}` +
            ` aud ${Math.round(p.aud)} maps ${Math.round(p.maps)}` +
            ` ents ${Math.round(p.ents)} ui ${Math.round(p.ui)}`,
        );
        p.upd = p.emit = p.aud = p.maps = p.ents = p.ui = 0;
      }
    }
    this.tickIndex += 1;
  }

  // stack ---------------------------------------------------------------

  push(state: GameState): void {
    this.stack.push(state);
  }

  pop(): void {
    this.stack.pop();
  }

  /** Pop every pushed state back down to the base OverworldState (index 0,
   * never itself pushed/popped — see the boot-time `this.stack = [...]`
   * assignment). A field HM move (PartyState's CUT/FLASH submenu entries)
   * needs the menu stack fully closed before it acts on the overworld, the
   * way selecting CUT in pokered's own party menu backs all the way out. */
  closeToOverworld(): void {
    while (this.stack.length > 1) this.stack.pop();
  }

  top(): GameState | undefined {
    return this.stack[this.stack.length - 1];
  }

  stackKinds(): string[] {
    return this.stack.map((s) => s.kind);
  }

  // OverworldShell ------------------------------------------------------

  /** Commands.lua:587 heal_party — Pokemon.lua:90 heal over the party. */
  healParty(): void {
    for (const mon of this.save.party) healMon(this.data, mon);
  }

  /** host.stamp passthrough — see OverworldShell.stamp. */
  stamp(mapId: number, cx: number, cy: number, on: boolean): void {
    this.host.stamp(mapId, cx, cy, on ? 1 : 0);
  }

  fieldFx(x: number, z: number, frame: number): void {
    this.host.fieldFx?.(x, z, frame);
  }

  /** host.tint passthrough — see OverworldShell.tint. */
  tint(abgr: number): void {
    this.host.tint(abgr);
  }

  /** Music.lua:383 playOnce / :407 restoreMap, for the script verbs. */
  playOnce(song: string): void {
    this.audio.playOnce(song);
  }

  restoreMapMusic(): void {
    this.audio.restore();
  }

  /** Music.lua:339 playMap, from the site that owns the moment. */
  startMapMusic(mapId: string): void {
    this.audioMap = mapId;
    this.audio.startMap(mapId);
  }

  showText(text: string, onDone?: () => void): void {
    this.push(new TextBoxState(this, text, onDone));
  }

  showChoice(text: string, choice: (yes: boolean) => void): void {
    this.push(new TextBoxState(this, text, undefined, choice));
  }

  pushWarpFade(frames: number, midpoint: () => void, onDone?: () => void): void {
    this.push(new WarpFadeState(this, frames, midpoint, onDone));
  }

  /**
   * Evolution.lua:195-223 checkParty driving :156-178 evolve, one mon at a
   * time in party order. The Lua plays EvolutionState's flashing-forms movie
   * when it has graphics and falls back to the plain text flow otherwise;
   * this slice takes the fallback — the same two pages, the same apply, and
   * the evolved species' exact-level learn check afterwards (:174, the
   * evos_moves.asm EvolveMon -> LearnMoveFromLevelUp predef).
   */
  runEvolutions(leveledUp: ReadonlySet<PartyMon> | null | undefined): void {
    const pending = checkParty(this.data, this.save.party, leveledUp);
    if (pending.length === 0) return;
    const step = (i: number): void => {
      const row = pending[i];
      if (!row) return;
      const { mon, to } = row;
      const oldName = mon.nickname ?? this.data.pokemon[mon.species]!.name;
      const newName = this.data.pokemon[to]!.name;
      applyEvolution(this.data, mon, to);
      this.showText(
        `What?\n${oldName} is\nevolving!\fCongratulations!\nYour ${oldName}\nevolved into\n${newName}!`,
        () => {
          this.learnMovesAtLevel(mon, () => step(i + 1));
        },
      );
    };
    step(0);
  }

  /**
   * Evolution.lua:112-152 learnEvolutionMoves — the species' learnset at
   * exactly this level (movesLearnedAt, not movesAtLevel), each new move
   * announced on its own page. A full moveset offers the replace prompt.
   *
   * Shared with the RARE CANDY bump: item_effects.asm .useRareCandy calls the
   * same LearnMoveFromLevelUp predef the evolution path does, so both want
   * exactly this walk over the new level's learnset.
   */
  private learnMovesAtLevel(mon: PartyMon, onDone: () => void): void {
    const def = this.data.pokemon[mon.species]!;
    const learned = movesLearnedAt(def, mon.level);
    const name = mon.nickname ?? def.name;
    const step = (i: number): void => {
      const moveId = learned[i];
      if (!moveId) {
        onDone();
        return;
      }
      const mdef = this.data.moves[moveId];
      if (!mdef || mon.moves.some((mv) => mv.id === moveId)) {
        step(i + 1);
        return;
      }
      if (mon.moves.length < 4) {
        mon.moves.push({ id: moveId, pp: mdef.pp });
        this.showText(`${name} learned\n${mdef.name}!`, () => step(i + 1));
        return;
      }
      this.offerReplaceMove(mon, moveId, () => step(i + 1));
    };
    step(0);
  }

  /**
   * The replace-move prompt outside battle (pokered MoveLearnMenu), shared by
   * the evolution learnset and TM/HM teaching. In battle the same decision is
   * a phase on the battle itself (battle.ts updateForget), because the battle
   * owns its own input loop; here it is an ordinary party screen.
   *
   * An HM move cannot be chosen — Gen 1 has no Move Deleter, and forgetting
   * CUT or SURF can strand the player on a map they cannot leave.
   */
  private offerReplaceMove(mon: PartyMon, moveId: string, onDone: () => void): void {
    const def = this.data.pokemon[mon.species]!;
    const name = mon.nickname ?? def.name;
    const mname = this.data.moves[moveId]?.name ?? moveId;
    const decline = (): void => this.showText(`${name} did not learn\n${mname}!`, onDone);
    this.showChoice(
      `${name} is trying to\nlearn ${mname}!\fBut ${name} can't\nlearn more than\f4 moves!\f` +
        `Delete an older move\nto make room for\f${mname}?`,
      (yes) => {
        if (!yes) { decline(); return; }
        this.push(new MoveForgetState(this as any, mon, (slot) => {
          if (slot < 0) { decline(); return; }
          const old = mon.moves[slot]!;
          if (this.hmMoveIds().has(old.id)) {
            // Back to the list rather than cancelling the whole thing: the
            // player picked a move they are not allowed to lose, not "no".
            this.showText("HM moves can't be\nforgotten now!", () =>
              this.offerReplaceMove(mon, moveId, onDone));
            return;
          }
          const forgotten = this.data.moves[old.id]?.name ?? old.id;
          mon.moves[slot] = { id: moveId, pp: this.data.moves[moveId]?.pp ?? 0 };
          this.showText(
            `1, 2 and... Poof!\f${name} forgot\n${forgotten}!\fAnd...\f${name} learned\n${mname}!`,
            onDone,
          );
        }));
      },
    );
  }

  /** Moves an HM teaches, from the item data rather than a hardcoded list. */
  private hmMoveIds(): Set<string> {
    const out = new Set<string>();
    for (const it of Object.values(this.data.items ?? {})) {
      const m = (it as { machine?: { kind?: string; move?: string } }).machine;
      if (m?.kind === "HM" && m.move) out.add(m.move);
    }
    return out;
  }

  /**
   * pokered ItemUseTMHM: teach the machine's move to the chosen party mon.
   * Without this an HM is an item you can hold and never use, which is what
   * kept CUT/FLASH's field effects (world/script.ts use_cut/use_flash)
   * unreachable — no mon could ever know the move. A TM is consumed, an HM
   * is not (Gen 1 HMs are reusable). A full moveset keeps the same v1
   * deviation learnEvolutionMoves takes above: MoveLearnMenu is not in this
   * slice, so the mon declines rather than silently replacing a move.
   */
  teachMachine(partyIndex: number, itemId: string): void {
    const mon = this.save.party[partyIndex];
    const item = this.data.items?.[itemId];
    const moveId = item?.machine?.move;
    if (!mon || !item || !moveId) return;
    const def = this.data.pokemon[mon.species]!;
    const name = mon.nickname ?? def.name;
    const mdef = this.data.moves[moveId];
    const mname = mdef?.name ?? moveId;
    if (mon.moves.some((mv) => mv.id === moveId)) {
      this.showText(`${name} knows\n${mname} already!`);
      return;
    }
    if (!(def.tmhm ?? []).includes(moveId)) {
      this.showText(`${name} is not\ncompatible with\n${item.name}!`);
      return;
    }
    if (mon.moves.length >= 4) {
      // A TM is consumed only if the move is actually learned, so the charge
      // rides the prompt's outcome rather than being taken up front.
      this.offerReplaceMove(mon, moveId, () => {
        if (mon.moves.some((mv) => mv.id === moveId) && item.machine?.kind === "TM") {
          Bag.remove(this.save, itemId, 1);
        }
      });
      return;
    }
    mon.moves.push({ id: moveId, pp: mdef?.pp ?? 0 });
    if (item.machine?.kind === "TM") Bag.remove(this.save, itemId, 1);
    this.showText(`${name} learned\n${mname}!`);
  }

  // OverworldShell keeps the seam's method name (overworld.ts is another
  // task's file); since the battle port it constructs the REAL wild battle
  // (BattleState.newWild in the reference).
  pushStubBattle(species: string, level: number): void {
    this.push(new BattleGameState(this, species, level));
  }

  // SceneView -----------------------------------------------------------

  uiBox(): UiBoxSource | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i] as GameState & Partial<UiBoxSource>;
      if (s.box) return s as GameState & UiBoxSource;
    }
    return null;
  }

  /** Oak's speech + the two name entries (post-title). */
  startIntro(): void {
    // Oak's speech has its own theme; startMap here would hand it the
    // bedroom's song, which is Pallet Town's.
    this.audio?.play?.("Music_MeetProfOak");
    const P_OAK = 406, P_PLR = 408, P_RIV = 409, P_NIDO = 164;
    const A = [
      ["pic", P_OAK, 184, 24, 112, 112],
      ["show_text", "_OakSpeechText1"],
      ["pic", P_NIDO, 184, 24, 112, 112],
      ["show_text", "_OakSpeechText2A"],
      ["pic", P_OAK, 184, 24, 112, 112],
      ["show_text", "_OakSpeechText2B"],
      ["show_text", "_IntroducePlayerText"],
      ["pic", P_PLR, 184, 24, 112, 112],
    ] as const;
    const B = [
      ["pic", P_RIV, 184, 24, 112, 112],
      ["show_text", "_IntroduceRivalText"],
    ] as const;
    const C = [
      ["pic", P_PLR, 184, 24, 112, 112],
      ["show_text", "_OakSpeechText3"],
      ["pic", P_PLR, 184, 24, 112, 112],
      ["wait", 4],
      ["pic", P_PLR, 192, 32, 96, 96],
      ["wait", 4],
      ["pic", P_PLR, 200, 40, 80, 80],
      ["wait", 4],
      ["pic", P_PLR, 208, 48, 64, 64],
      ["wait", 4],
      ["pic", P_PLR, 216, 56, 48, 48],
      ["wait", 4],
      ["pic", P_PLR, 224, 64, 32, 32],
      ["wait", 4],
      ["pic_hide"],
    ] as const;

    const run = (rows: unknown, done: () => void) =>
      this.overworld.runScript(rows as never[], done);

    run(A, () => {
      this.push(new NamingState(this, {
        title: "YOUR NAME?", default: "RED",
        onDone: (name: string) => {
          this.save.player.name = name;
          run(B, () => {
            this.push(new NamingState(this, {
              title: "RIVAL'S NAME?", default: "BLUE",
              onDone: (rival: string) => {
                this.save.player.rival = rival;
                run(C, () => {
                  // The intro theme holds until something claims the music;
                  // hand it to the spawn map once the shrink finishes.
                  this.audio?.startMap?.("REDS_HOUSE_2F");
                });
              },
            }));
          });
        },
      }));
    });
  }

  pic(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    if (top?.kind === "title") {
      const v = top.view();
      // logo up top; Red on the left with the cycling mon beside him.
      const out: any[] = [{ page: TITLE_PAGES.logo, x: 96, y: 16, w: 288, h: 108 }];
      out.push({ page: RED_PIC_PAGE, x: 160, y: 132, w: 112, h: 112 });
      if (v.monPage >= 0) out.push({ page: v.monPage, x: 248, y: 140, w: 104, h: 104 });
      return out;
    }
    if (top?.kind === "trainercard") {
      // DrawTrainerInfo's portrait, upper-right of the info card. The card
      // clears those ui cells (scene.ts) so this shows through them.
      const v = top.view();
      if (v.picPage < 0) return [];
      const r = CARD_PIC_RECT;
      return [{ page: v.picPage, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "pokedex") {
      // DexEntryMenu.lua draws the front pic top-left of the DATA page. Uses
      // the same full-screen pic layer as the title mon; coordinates are in
      // that layer's ~2x space (see the title mon at w/h 104). Tune the four
      // DEX_SPRITE_* consts if it sits wrong on hardware.
      const v = top.view();
      if (v.mode === "entry" && v.entry && v.entry.spritePage >= 0) {
        return [{ page: v.entry.spritePage, x: 16, y: 24, w: 104, h: 104 }];
      }
      return [];
    }
    return this.overworld.picShown;
  }

  /** open_mart verb -> push the mart shop; onQuit resumes the yielded runner. */
  openShop(stock: string[], onQuit?: () => void): void {
    this.push(new ShopState(this as any, stock, onQuit));
  }

  /** PC tile -> Bill's PC box storage. */
  openBox(): void {
    this.push(new BoxState(this as any));
  }

  /** Mon cry for the box withdraw/release, via the audio director. */
  playCry(species: string): void {
    this.audio.playCry(species);
  }

  openStartMenu(): void {
    this.push(
      new StartMenuState(this as any, (act) => {
        // POKéMON and ITEM are their own screens; wired next.
        if (act === "pokedex") {
          // PokedexMenu.new(game, { onCancel }): B/QUIT return to the start
          // menu, whose saved cursor is still on POKéDEX.
          this.push(new PokedexState(this as any));
        }
        if (act === "item") {
          this.push(new BagState(this as any));
        }
        if (act === "pokemon") {
          this.push(new PartyState(this as any));
        }
        if (act === "trainer") {
          this.push(new TrainerCardState(this as any));
        }
        if (act === "dev") this.openDevMenu();
        if (act === "save") {
          // The recomp keeps the live position in player.*; copy it over
          // so the desktop build resumes exactly where the 3DS stood.
          const ow: any = this.overworld;
          const p: any = this.save.player;
          p.map = ow.mapId ?? ow.map?.id ?? p.map;
          p.x = ow.player?.cellX ?? p.x;
          p.y = ow.player?.cellY ?? p.y;
          p.facing = ow.player?.facing ?? p.facing;
          const h: any = (this as any).host ?? (this as any).hostApi ?? (globalThis as any).voxel;
          if (h?.saveWrite) h.saveWrite(encodeSave(this.save));
          else console.log("save: no host.saveWrite");
          this.pop();
        }
      }),
    );
  }

  /** START -> DEV (ui/devmenu.ts): the playtesting tools. */
  openDevMenu(): void {
    this.push(
      new DevMenuState(this as any, (act) => {
        if (act === "warp") {
          // Debug jump. Uses the ordinary warp path so the destination gets a
          // real map load, music, and heal-point handling — the point is to
          // land somewhere PLAYABLE, not to sightsee.
          const ow: any = this.overworld;
          const here = String(ow.mapId ?? ow.map?.id ?? "");
          this.push(new WarpPickerState(this as any, here, (mapId) => {
            // The picker popped itself; the dev and start menus are still
            // stacked under it, and the warp has to land on a bare overworld.
            this.closeToOverworld();
            const def: any = this.data.maps?.[mapId];
            // Warps name a destination warp, not a tile; the first warp of a
            // map is where its own door puts you, which is the one spot every
            // map is guaranteed to have standable ground.
            const w = (def?.warps ?? [])[0];
            ow.startWarpTo(mapId, w?.x ?? 1, w?.y ?? 1, "down", () => {});
          }));
        }
        if (act === "candy") this.giveRareCandies();
      }),
    );
  }

  /**
   * DEV -> RARE CANDY: fill the stack to the Gen 1 per-slot cap of 99
   * (AddItemToInventory's quantity limit, rules/bag.ts add). A top-up rather
   * than a fixed handful, so holding the menu open doesn't silently fail once
   * the stack is near the cap — Bag.add refuses the whole add if it would
   * pass 99.
   */
  private giveRareCandies(): void {
    const have = this.save.inventory?.RARE_CANDY ?? 0;
    const want = 99 - have;
    if (want <= 0) {
      this.showText("You already have\n99 RARE CANDY!");
      return;
    }
    if (!Bag.add(this.save, "RARE_CANDY", want, this.data)) {
      this.showText("The BAG is full!");
      return;
    }
    this.showText(`Got ${want} RARE CANDY!\nNow x99.`);
  }

  /**
   * Bag -> party chooser -> the item's effect (pokered UseItem, gen1recomp
   * ItemEffects.use). Only the items ui/bagscreen.ts offers land here; every
   * other item is still inert.
   */
  useItem(partyIndex: number, itemId: string): void {
    if (itemId === "RARE_CANDY") this.useRareCandy(partyIndex);
  }

  /**
   * item_effects.asm .useRareCandy, via gen1recomp ItemEffects.lua:372-390
   * and BagMenu.lua:279-322: one level, the exp that level starts at,
   * recalculated stats with current HP grown by the max-HP delta, then the
   * new level's learnset and a level evolution. Refused at the level cap,
   * and the candy is not spent on the refusal.
   *
   * One deviation: the Lua runs PrintStatsBox between the level text and the
   * moves. This port has no stat window outside battle, so the text runs
   * straight into the learnset.
   *
   * The bag stays open underneath (RARE_CANDY is in pokered's
   * UsableItems_PartyMenu, so .useItem_partyMenu returns to StartMenu_Item
   * with the cursor still on it) — mashing A burns through a stack.
   */
  private useRareCandy(partyIndex: number): void {
    const mon = this.save.party[partyIndex];
    if (!mon) return;
    const def = this.data.pokemon[mon.species]!;
    const name = mon.nickname ?? def.name;
    const cap = this.data.constants?.levelCap ?? 100;
    if (mon.level >= cap) {
      this.showText("It won't have any\neffect.");
      return;
    }
    Bag.remove(this.save, "RARE_CANDY", 1);
    mon.level += 1;
    mon.exp = expForLevel(def.growthRate, mon.level, this.data.growth_rates);
    const old = mon.stats;
    mon.stats = calcStats(def, mon.level, mon.dvs, mon.statExp);
    mon.hp = Math.min(mon.stats.hp, mon.hp + (mon.stats.hp - old.hp));
    this.showText(`${name} grew\nto level ${mon.level}!`, () => {
      this.learnMovesAtLevel(mon, () => this.runEvolutions(new Set([mon])));
    });
  }

  bag(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "bag" ? top.view() : null;
  }

  shop(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "shop" ? top.view() : null;
  }

  box(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "box" ? top.view() : null;
  }

  party(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "party" ? top.view() : null;
  }

  pokedexScreen(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "pokedex" ? top.view() : null;
  }

  summary(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "summary" ? top.view() : null;
  }

  startMenu(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "startmenu" ? top.view() : null;
  }

  trainerCard(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "trainercard" ? top.view() : null;
  }

  devMenu(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "devmenu" ? top.view() : null;
  }

  warpPicker(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "warppicker" ? top.view() : null;
  }

  moveForget(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "moveforget" ? top.view() : null;
  }

  title(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "title" ? top.view() : null;
  }

  /** Script-driven trainer battle (start_battle). */
  askNickname(defaultName: string, onDone: (name: string | null) => void): void {
    this.push(
      new NamingState(this, {
        title: `${defaultName} NICKNAME?`,
        default: defaultName,
        onDone: (n: string) => onDone(n === defaultName ? null : n),
      }),
    );
  }

  startTrainerBattle(trainerId: string, partyIndex = 1, name?: string, onDone?: (won: boolean) => void, loseable = false): void {
    const battle = new TrainerBattle(
      this.data, this.save, this.battleRng, trainerId, partyIndex, name,
    );
    const st = new BattleGameState(this, "", 0, battle);
    // Report the outcome so a script rewards only on a win (afterBattle).
    st.onDone = () => onDone?.(battle.finished === "win");
    st.loseable = loseable;
    this.push(st);
  }

  /**
   * A wild battle a SCRIPT opens, rather than one the encounter roll rolled
   * — the POKEMON TOWER 6F ghost. Same WildBattle the grass builds; the opts
   * carry the two things that make it a ghost, and onDone reports the result
   * so the script can branch on it the way start_battle does.
   *
   * `pokeDoll` in the result is the wBattleResult parity the tower leans on:
   * losing writes $1 and running writes $2, but ending it with a POKE DOLL
   * touches neither, so the script reads it as a defeat
   * (PokemonTower6FMarowakBattleScript's "and a / jr nz").
   */
  startWildBattle(
    species: string,
    level: number,
    opts?: { noCatch?: boolean; disguised?: boolean },
    onDone?: (result: BattleResult | null) => void,
  ): void {
    const battle = new WildBattle(this.data, this.save, this.battleRng, species, level);
    battle.noCatch = opts?.noCatch === true;
    battle.disguised = opts?.disguised === true;
    const st = new BattleGameState(this, species, level, battle);
    st.onDone = () => onDone?.(battle.finished);
    this.push(st);
  }

  /** Commands.lua:807-823 old_man_demo: the Viridian catch tutorial's
   * BATTLE_TYPE_OLD_MAN wild battle. Built like a scripted wild battle, flagged
   * as a demo, and pushed with an onDone that resumes the map script when it
   * ends (battle.onFinish -> runner.resume). Nothing is kept. */
  startOldManDemo(onDone?: () => void): void {
    const om =
      (this.data.field as { oldManBattle?: { species: string; level: number } } | undefined)
        ?.oldManBattle ?? { species: "WEEDLE", level: 5 };
    const battle = new WildBattle(this.data, this.save, this.battleRng, om.species, om.level);
    battle.makeOldManDemo();
    const st = new BattleGameState(this, "", 0, battle);
    st.onDone = () => onDone?.();
    this.push(st);
  }

  naming(): { view(): any } | null {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "naming" ? top : null;
  }

  uiChoice(): ChoiceSource | null {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "choice" ? (top as ChoiceState) : null;
  }

  battleView(): BattleSceneView | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i];
      if (s.kind === "battle") return s as BattleGameState;
    }
    return null;
  }
}
