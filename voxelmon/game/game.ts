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
import { healMon, markOwned, newMon, type PartyMon } from "./battle/mon.ts";
import { SafariBattle } from "./battle/safari.ts";
import { computeStaging, namedPage, picPageFor, type BattleStaging } from "./battle/staging.ts";
import { BattleUi } from "./battle/ui.ts";
import type { VoxelmonData } from "./data.ts";
import type { VoxelHost } from "./host.ts";
import { Input } from "./input.ts";
import { seededRng, type Rng } from "./rng.ts";
import { apply as applyEvolution, checkParty, pendingFor } from "./rules/evolution.ts";
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
import { inSafariStepZone, type SafariState } from "./world/safari.ts";
import {
  applyDaycareGrowth, daycareQuote, fillDaycareText, type DaycareState,
} from "./world/daycare.ts";
import { paginate, substitute, Textbox, TEXT_SPEED_DEFAULT, type TextboxOpts } from "./world/textbox.ts";
import { NamingState } from "./ui/naming.ts";
import { TitleState, titlePage } from "./ui/title.ts";
import { IntroState } from "./ui/intro.ts";
import { StartMenuState } from "./ui/startmenu.ts";
import { DevMenuState } from "./ui/devmenu.ts";
import { CARD_PIC_RECT, TrainerCardState } from "./ui/trainercard.ts";
import { CreditsState, HallOfFameState } from "./ui/hofscreen.ts";
import { DiplomaState } from "./ui/diploma.ts";
import { TradeScreenState } from "./ui/tradescreen.ts";
import { TradeAnimState, TRADE_PIC_CELL } from "./ui/tradeanim.ts";
import { LinkBattle } from "./battle/linkbattle.ts";
import { TRADE_MINE_ROW, TRADE_THEIRS_ROW } from "./ui/tradescreen.ts";
import {
  hostTransport, LINK_ANSWER_FRAMES, LINK_ROOM, LINK_WAIT_FRAMES, type LinkSession,
  type LinkTransport,
} from "./world/link.ts";
import { EvolutionState, type EvolutionView } from "./ui/evoscreen.ts";
import {
  applyPostGameHome, POST_GAME_HOME, postGameRescue, recordHallOfFame,
} from "./world/halloffame.ts";
import { CAMERA_SPEED_DEFAULT_Q8, CAMERA_SPEEDS, OptionsMenuState } from "./ui/optionsmenu.ts";
import { cellsToPicRect } from "./ui/trainercard.ts";
import { EVO_PIC_CELL } from "./ui/evoscreen.ts";
import { partyIconCell, SUMMARY_PIC_CELL } from "./ui/partyscreen.ts";
import { PrizeState } from "./ui/prizescreen.ts";
import { SlotMachineState } from "./ui/slotmachine.ts";
import { BikeShopState } from "./ui/bikeshop.ts";
import {
  countOwned, fillAideText, oaksAideFlag, OAKS_AIDES,
} from "./world/oaksaide.ts";
import { PRIZE_WINDOWS } from "./world/gamecorner.ts";
import { gearViewStep } from "./ui/kantogear.ts";
import { count as badgeCount } from "./rules/badges.ts";

/** save.asm:164-181 — DelayFrames 120 over "Now saving...", then 30. */
const SAVE_HOLD = 120;
const SAVE_DONE_HOLD = 30;
import { WarpPickerState } from "./ui/warppicker.ts";
import { FlyPickerState } from "./ui/flypicker.ts";
import { FloorPickerState } from "./ui/floorpicker.ts";
import {
  floorsOf as elevatorFloors,
  seedExit as seedElevatorExit,
  setExit as setElevatorExit,
} from "./world/elevator.ts";
import { backfillVisited, flyDestinations } from "./world/fly.ts";
import { isOutside } from "./world/map.ts";
import { adjacentSnorlax, SNORLAX_LEVEL } from "./world/snorlax.ts";
import { MoveForgetState } from "./ui/moveforget.ts";
import { BagState } from "./ui/bagscreen.ts";
import { PartyState } from "./ui/partyscreen.ts";
import { ShopState } from "./ui/shopscreen.ts";
import { VENDING_DRINKS } from "./world/vending.ts";
import { fishingCatch, isRod } from "./world/fishing.ts";
import * as Items from "./rules/items.ts";
import { BoxState } from "./ui/boxscreen.ts";
import { PcState } from "./ui/pcscreen.ts";
import { PokedexState } from "./ui/pokedexscreen.ts";
import { encodeSave } from "./save-lua.ts";
import { decodeSave } from "./save-read.ts";
import * as Bag from "./rules/bag.ts";
/** Must match Version.saveFormat in the recomp. */
const SAVE_FORMAT = 4;   // Version.lua saveFormat
/**
 * The intro's portraits, by the name the cook files them under. The numbers
 * are the pages a pak cooked before `atlas.picTrainer` existed put them on;
 * they are wrong for any pak cooked since, which is why nothing reads them
 * unless the dataset has no names at all.
 */
const PIC_NAMES = { oak: "prof.oak", player: "red", rival: "rival1" } as const;
const PIC_FALLBACK = { oak: 406, player: 408, rival: 409, nidorino: 164 };

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
    opts?: TextboxOpts,
  ) {
    this.box = new Textbox(
      text,
      { player: game.save.player.name, rival: game.save.player.rival },
      { speed: game.textSpeed(), ...opts },
    );
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
    // an auto box closes on a timer, and a beep would announce a press that
    // never happened
    if (
      !this.box.isAuto &&
      ((wasDone && this.box.closed) || (wasWaiting && !this.box.waiting))
    ) {
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
      // EndTrainerBattle re-runs the floor's door callback (home/trainers.asm
      // BIT_CUR_MAP_LOADED_1): the Rocket Hideout's lift gate opens the
      // moment its last guard falls, not on the next visit. After done(),
      // which is what records the win the gate is waiting on.
      else this.game.overworld.refreshDoors();
      // OverworldController.lua:3851-3894 afterBattle: EvolveAfterBattle runs
      // for every exit (the blackout heals first, :3882; other exits run it
      // straight away, :3892). This call was orphaned in the dead legacy block
      // below when the teardown moved to the pop+resume path above — without it
      // no mon ever evolves. The evolution pages push over the overworld the
      // battle just handed back to.
      this.game.runEvolutions(b.leveledUp);
      // A catch that filled a new dex number shows its entry
      // (item_effects.asm _ItemUseBallText06 -> predef ShowPokedexData).
      //
      // DEVIATION: the original shows it DURING the catch, over the battle
      // screen; gen1recomp queues it as a ui row on the battle's own queue.
      // This battle has no UI queue — its rows are text, waits and acts — so
      // the page comes up as the battle hands back, one beat later. Nothing
      // else can be queued behind it: a catch ends the battle, and awards no
      // exp, so there are no level-ups or evolutions to sequence against.
      const caught = b.caughtNewSpecies;
      if (caught) {
        b.caughtNewSpecies = null;
        this.game.showCaughtDexEntry(caught);
      }
      // Spending the last SAFARI BALL ends the GAME, not just the battle —
      // the PA calls it and the warp home belongs to the overworld, so the
      // battle only flags it.
      if ((b as { outOfBalls?: boolean }).outOfBalls) {
        this.game.overworld.safariGameOver("_OutOfSafariBallsText");
      }
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
        // The ROLE is the battle's (BattleState.lua computeMusicKind): this
        // was pinned to "wild", so every trainer fought to the wild theme.
        this.audio.playBattle(bv.battle.musicKind());
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
      // The boot movie and the title own the music while they are on top:
      // PlayIntro runs its copyright card in silence and its splash over
      // one sound effect, and the title claims its own theme on its second
      // tick. The staged world's theme is still NOTED, so the hand-off
      // after the title -- the theme holding through Oak's speech until
      // the speech itself starts the bedroom's -- sees the map as already
      // accounted for, exactly as it did when the theme used to play.
      const top = this.stack[this.stack.length - 1];
      if (top?.kind === "intro" || top?.kind === "title") {
        this.audio.noteMap(mapId);
      } else {
        this.audio.startMap(mapId, !!this.save.onBike);
      }
    }
  }

  /** Play what the battle queued, in the order it queued it. */
  private drainBattleCues(battle: WildBattle): void {
    const cues = battle.audioCues;
    for (const cue of cues) {
      if (cue.startsWith("cry:")) {
        this.audio.playCry(cue.slice(4));
      } else if (cue.startsWith("move:")) {
        // "move:<sfx>:<pitch>:<tempo>" — a battle move's sound with the
        // modifiers its MoveSoundTable row carries.
        const [name, pitch, tempo] = cue.slice(5).split(":");
        this.audio.playSfx(name, Number(pitch) || 0, Number(tempo) || undefined);
      } else if (cue.startsWith("sfx:")) {
        this.audio.playSfx(cue.slice(4));
      } else if (cue.startsWith("music:victory")) {
        // "music:victory:<kind>" — the battle names the theme, since only it
        // knows whether a faint ended the fight (trainer.ts victoryMusicKind).
        const kind = cue.slice("music:victory:".length);
        this.audio.playVictory(kind || "wild");
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
              // `visited` postdates the saves that will be loaded here, so a
              // save from before FLY existed gets its record reconstructed
              // from what it already proves -- otherwise a finished game comes
              // back with nowhere to fly to.
              backfillVisited(this.save as never);
              // A save the old induction wrote in the hall itself resumes
              // in the bedroom, where the write now puts it.
              postGameRescue(this.save as never);
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
   * A cold start: the world staged, the title behind it, and the boot movie
   * on top of both (PlayIntro, engine/movie/intro.asm).
   *
   * Separate from `newGame` on purpose. newGame is what every test and
   * every offline tool calls to get a staged world and a title screen, and
   * three minutes of copyright card is not what any of them asked for --
   * the movie belongs to the console starting up, so the console's entry
   * point is what asks for it.
   */
  boot(): void {
    this.newGame();
    this.push(new IntroState(this as never, () => {}));
  }

  /**
   * The blackout path a lost battle takes (pokered HandleBlackOut,
   * engine/battle/core.asm:1157+: heal the party, special-warp to the last
   * Pokémon center). v1: full heal + the warp fade to save.lastHeal; the
   * money halving (ResetStatusAndHalveMoneyOnBlackout) has no money field
   * to act on in this slice.
   */
  blackout(): void {
    // ResetStatusAndHalveMoneyOnBlackout (engine/events/black_out.asm): the
    // party is healed and the wallet halved, out of battle or in.
    for (const mon of this.save.party) healMon(this.data, mon);
    this.save.money = Math.floor((this.save.money ?? 0) / 2);
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
    // The link before the frame: it has to be read whatever is on screen.
    this.overworld.serviceLink();
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
    this.audio.startMap(mapId, !!this.save.onBike);
  }

  showText(text: string, onDone?: () => void): void {
    this.push(new TextBoxState(this, text, onDone));
  }

  /**
   * A box that closes on a timer rather than a press (save.asm's "Now
   * saving..." / GameSavedText). `sfx` fires the moment the text finishes,
   * so the hold covers the jingle.
   */
  showAuto(text: string, delay: number, opts?: { sfx?: string; onDone?: () => void }): void {
    if (opts?.sfx) this.audio.playSfx(opts.sfx);
    this.push(new TextBoxState(this, text, opts?.onDone, undefined, { auto: { delay } }));
  }

  /** save.options.textSpeed — frames per glyph (ui/optionsmenu.ts). */
  textSpeed(): number {
    const v = (this.save as { options?: { textSpeed?: number } }).options?.textSpeed;
    return typeof v === "number" && v > 0 ? v : TEXT_SPEED_DEFAULT;
  }

  /**
   * save.options.cameraSpeed -> the Q8 multiplier the host swings the
   * camera by (spec `camSpeed`): SLOW is half the tuned rate, FAST is
   * near twice it. Unset, or anything unknown, is NORMAL.
   */
  /**
   * The circle pad, from the host each frame: raw units out of `range` on
   * each axis, +y up the pad. Kept as -1..1 for the free walk to steer by.
   */
  setStick(x: number, y: number, range: number): void {
    const r = range > 0 ? range : 1;
    this.overworld.stick = {
      x: Math.max(-1, Math.min(1, x / r)),
      y: Math.max(-1, Math.min(1, y / r)),
    };
  }

  cameraSpeedQ8(): number {
    const v = (this.save as { options?: { cameraSpeed?: string } }).options?.cameraSpeed;
    return CAMERA_SPEEDS.find((s) => s.key === v)?.q8 ?? CAMERA_SPEED_DEFAULT_Q8;
  }

  /** save.options.animations — BattleState.lua:2544 animationsOn. */
  animationsOn(): boolean {
    return (this.save as { options?: { animations?: boolean } }).options?.animations !== false;
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
      // The movie, not the two text pages this used to be: the two forms
      // trade places faster and faster over "What? X is evolving!", B calls
      // it off, and the congratulations page and the evolved species' learn
      // check follow it (ui/evoscreen.ts).
      this.push(
        new EvolutionState(
          this as never,
          row.mon,
          row.to,
          "LEVEL",
          (mon, to) =>
            applyEvolution(this.data, mon, to, (this.save as { pokedex?: never }).pokedex),
          () => this.learnMovesAtLevel(row.mon, () => step(i + 1)),
        ),
      );
    };
    step(0);
  }

  /** The evolution movie's view, for the scene (ui/evoscreen.ts). */
  evolutionScreen(): EvolutionView | null {
    const top = this.stack[this.stack.length - 1] as GameState & {
      view?: () => EvolutionView;
    };
    return top?.kind === "evolution" ? (top.view?.() ?? null) : null;
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
    // Inside a running SAFARI game the wild battle is the BALL/BAIT/ROCK/RUN
    // one (battle/safari.ts): no player mon, and the wild mon can bolt.
    const safari = (this.save as { safari?: SafariState | null }).safari;
    if (safari && inSafariStepZone(this.overworld.map.id)) {
      this.push(new BattleGameState(this, species, level,
        new SafariBattle(this.data, this.save, this.battleRng, species, level, safari)));
      return;
    }
    // The tower's wild GASTLYs and HAUNTERs are ordinary fights, scope or
    // no scope -- catchable, beatable, seen. A deliberate departure from
    // the ROM, whose IsGhostBattle disguises every wild mon in the tower
    // until the scope is carried (Isaac): only the MAROWAK at the top is
    // the GHOST here, and that one is the 6F script's, not the grass's.
    this.push(new BattleGameState(this, species, level,
      new WildBattle(this.data, this.save, this.battleRng, species, level)));
  }

  // SceneView -----------------------------------------------------------

  uiBox(): UiBoxSource | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i] as GameState & Partial<UiBoxSource>;
      if (s.box) return s as GameState & UiBoxSource;
    }
    return null;
  }

  /** One of the intro portraits: the cook's page, else the old literal. */
  private picNamed(which: keyof typeof PIC_NAMES): number {
    const p = namedPage(this.data as never, "picTrainer", PIC_NAMES[which]);
    return p >= 0 ? p : PIC_FALLBACK[which];
  }

  /** Oak's speech + the two name entries (post-title). */
  startIntro(): void {
    // Oak's speech has its own theme; startMap here would hand it the
    // bedroom's song, which is Pallet Town's.
    this.audio?.play?.("Music_MeetProfOak");
    const P_OAK = this.picNamed("oak");
    const P_PLR = this.picNamed("player");
    const P_RIV = this.picNamed("rival");
    const nido = picPageFor(this.data as never, "NIDORINO");
    const P_NIDO = nido >= 0 ? nido : PIC_FALLBACK.nidorino;
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

    // oak_speech2.asm ChoosePlayerName / ChooseRivalName: a menu of NEW
    // NAME and the three presets first (DefaultNamesPlayerList, field
    // .presetNames); NEW NAME opens the keyboard, which starts empty and
    // falls back to the first preset on an empty confirm.
    const presets = (this.data as {
      field?: { presetNames?: { customOption?: string; player?: string[]; rival?: string[] } };
    }).field?.presetNames;
    const askName = (
      title: string,
      list: string[] | undefined,
      fallback: string,
      onDone: (name: string) => void,
    ): void => {
      const names = list && list.length > 0 ? list : [fallback];
      const custom = presets?.customOption ?? "NEW NAME";
      this.push(new NamingState(this, {
        title,
        pick: [custom, ...names],
        onDone: (choice: string) => {
          if (choice !== custom) {
            onDone(choice);
            return;
          }
          this.push(new NamingState(this, { title, fallback: names[0], onDone }));
        },
      }));
    };

    run(A, () => {
      askName("YOUR NAME?", presets?.player, "RED", (name: string) => {
        this.save.player.name = name;
        run(B, () => {
          askName("RIVAL'S NAME?", presets?.rival, "BLUE", (rival: string) => {
            this.save.player.rival = rival;
            run(C, () => {
              // The intro theme holds until something claims the music;
              // hand it to the spawn map once the shrink finishes.
              this.audio?.startMap?.("REDS_HOUSE_2F");
            });
          });
        });
      });
    });
  }

  pic(): unknown {
    let top = this.stack[this.stack.length - 1] as any;
    // The evolution movie's last page -- the congratulations, or the
    // called-off line -- is a textbox pushed OVER the movie, and the settled
    // form has to stay on screen under it. Falling through to the world's
    // own pic here painted whatever the overworld last showed into the
    // movie's cut-out instead.
    const under = this.stack[this.stack.length - 2] as any;
    if (top?.kind === "textbox" && under?.kind === "evolution") top = under;
    // The boot movie draws in screen space and has already worked out
    // every rect it wants, so it hands the list straight through.
    if (top?.kind === "intro") return top.view().pics;
    // The title lays itself out in GB space, like the movie (ui/title.ts).
    if (top?.kind === "title") return top.view().pics;
    if (top?.kind === "trainercard") {
      // DrawTrainerInfo's portrait, upper-right of the info card. The card
      // clears those ui cells (scene.ts) so this shows through them.
      const v = top.view();
      if (v.picPage < 0) return [];
      const r = CARD_PIC_RECT;
      return [{ page: v.picPage, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "summary") {
      // status_screen.asm:170 draws the front pic at (1,0), seven cells
      // square, over the tile frame; the scene cuts those cells out. (The
      // ROM mirrors it -- LoadFlippedFrontSpriteByMonIndex -- which the
      // pic op cannot, so it faces the way it does everywhere else.)
      const v = top.view() as { speciesId: string };
      const page = picPageFor(this.data as never, v.speciesId);
      if (page < 0) return [];
      const r = cellsToPicRect(SUMMARY_PIC_CELL);
      return [{ page, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "party") {
      // The icon beside each name. The ROM has a separate icon sheet; this
      // pak carries front pics, so each mon's front pic sits in the two-
      // cell nook the icon would, the way the gear's party panel does it.
      const v = top.view() as { entries: { species: string }[] };
      const out: { page: number; x: number; y: number; w: number; h: number }[] = [];
      v.entries.forEach((e, i) => {
        const page = picPageFor(this.data as never, e.species);
        if (page < 0) return;
        const r = cellsToPicRect(partyIconCell(i));
        out.push({ page, x: r.x, y: r.y, w: r.w, h: r.h });
      });
      return out;
    }
    if (top?.kind === "tradeanim") {
      // The mon of the beat, in the same nook the summary puts one in. The
      // gap has none on purpose: it is the part where it is in the cable.
      const v = top.view() as { mon: { species: string } | null };
      if (!v?.mon) return [];
      const page = picPageFor(this.data as never, v.mon.species);
      if (page < 0) return [];
      const r = cellsToPicRect(TRADE_PIC_CELL);
      return [{ page, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "tradescreen") {
      // Both parties get their icon in the nook beside the name, the way
      // the party menu does it.
      const v = top.view() as {
        mine: { species: string }[]; theirs: { species: string }[];
      };
      const out: { page: number; x: number; y: number; w: number; h: number }[] = [];
      const add = (list: { species: string }[], row0: number) => {
        list.forEach((e, i) => {
          const page = picPageFor(this.data as never, e.species);
          if (page < 0) return;
          const r = cellsToPicRect({ x: 1, y: row0 + i, w: 1, h: 1 });
          out.push({ page, x: r.x, y: r.y, w: r.w, h: r.h });
        });
      };
      add(v.theirs, TRADE_THEIRS_ROW);
      add(v.mine, TRADE_MINE_ROW);
      return out;
    }
    if (top?.kind === "evolution") {
      // EvolutionState.lua centres the form on the GB screen: x = (160 - w)
      // / 2, y = max(8, 64 - h), for a 56x56 pic. Scaled into the UI frame
      // that is (187, 15) at 106 px, which is where the battle and the
      // hall of fame put a mon too.
      const v = top.view() as { picPage: number };
      if (!v || v.picPage < 0) return [];
      const r = cellsToPicRect(EVO_PIC_CELL);
      return [{ page: v.picPage, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "halloffame") {
      // The inductee, centred the way HallOfFameDisplayMonInfo places it.
      const v = top.view();
      if (!v.mon || v.mon.picPage < 0) return [];
      return [{ page: v.mon.picPage, x: 188, y: 40, w: 112, h: 112 }];
    }
    if (top?.kind === "credits") {
      // Credits.lua's mon sits to the left of the staff names.
      const v = top.view();
      if (v.picPage < 0) return [];
      return [{ page: v.picPage, x: 40, y: 68, w: 96, h: 96 }];
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

  /**
   * oaks_aide verb -> OaksAideScript (engine/events/oaks_aide.asm). He asks
   * whether you have the kinds, then checks the DEX himself rather than
   * taking your word for it, and reads the real tally back at you either
   * way — which is why this is a flow and not script rows.
   */
  openOaksAide(textId: string, onDone?: () => void): void {
    const post = OAKS_AIDES[textId];
    if (!post) { onDone?.(); return; }
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const line = (k: string, fallback: string): string => t[k] ?? fallback;
    const itemName = this.data.items?.[post.item]?.name ?? post.item;
    const flag = oaksAideFlag(post.item);
    const fill = (k: string, fallback: string, num?: number): string =>
      fillAideText(line(k, fallback), { num, item: itemName });

    // Already paid out: he just explains the thing forever after.
    if (this.save.flags?.[flag]) {
      this.showText(fill(post.repeatText, `I gave you the\n${itemName}!`), onDone);
      return;
    }
    this.showChoice(
      fill("_OaksAideHiText", "Hi! Remember me?\nI'm PROF.OAK's\nAIDE!", post.threshold),
      (yes) => {
        if (!yes) {
          this.showText(fill("_OaksAideComeBackText", "Oh. I see.", post.threshold), onDone);
          return;
        }
        // He counts for himself — saying yes with eight kinds gets Uh-oh.
        const owned = countOwned(this.save as never);
        if (owned < post.threshold) {
          this.showText(fill("_OaksAideUhOhText", "Let's see...\nUh-oh!", owned), onDone);
          return;
        }
        if (!Bag.add(this.save, post.item, 1, this.data)) {
          this.showText(fill("_OaksAideNoRoomText", "Oh! You have no\nroom for it."), onDone);
          return;
        }
        this.save.flags[flag] = true;
        this.audio.playSfx("Get_Key_Item");
        this.showText(fill("_OaksAideHereYouGoText", "Great!\nHere you go!", owned), () => {
          this.showText(fill("_OaksAideGotItemText", `{PLAYER} got the\n${itemName}!`), onDone);
        });
      },
    );
  }

  /**
   * How far the player has swung the camera, in quarter turns, from the
   * host's button word. Only the overworld walk uses it.
   */
  setCamTurns(q: number): void {
    this.overworld.camTurns = q;
  }

  /** The camera's real yaw, radians, for free movement (world/freemove.ts). */
  setCamYaw(yaw: number): void {
    this.overworld.freeYaw = yaw;
  }

  /** Whether the last save reached the card (ui/devmenu.ts reports it). */
  lastSaveOk = true;

  /**
   * Write a file to the card and read it back, then say what happened -- on
   * screen, where it cannot be missed.
   *
   * Chasing a silent write failure from outside the console is close to
   * impossible: the game reads its maps happily, so the card looks fine, and
   * every failed write was being swallowed. This is the one place that can
   * answer it directly.
   */
  runWriteTest(): void {
    const h = (this as { host?: VoxelHost }).host;
    if (!h?.writeTest) {
      this.showText("This build cannot\ntest card writes.");
      return;
    }
    const ok = h.writeTest();
    if (ok) {
      this.showText("CARD WRITE OK\nwritetest.txt was\nwritten and read\nback.");
      return;
    }
    const why = (h.writeErr?.() ?? "unknown").slice(0, 40);
    this.showText(`CARD WRITE FAILED\n${why}`);
  }

  /**
   * A PC tile -> the machine's menu (ui/pcscreen.ts).
   *
   * The tile used to open Pokemon storage directly, which left the Item
   * Storage System with no way in -- items could go into the bag and never
   * out of it.
   */
  openPc(onDone?: () => void): void {
    this.push(new PcState(this as never, onDone));
  }

  pc(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "pc" ? top.view() : null;
  }

  /** Cursor row of whichever PC menu is open, for the renderer. */
  pcCursor(): number {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "pc" ? top.menuCursor() : 0;
  }

  /** ui/bikeshop.ts wants a sound for its own A/B, like every menu. */
  playSfx(name: string): void {
    this.audio.playSfx(name);
  }

  bikeShop(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "bikeshop" ? top.view() : null;
  }

  /**
   * open_bike_shop -> BikeShopClerkText (scripts/BikeShop.asm), which runs
   * three ways: the BICYCLE is already yours, you are carrying the BIKE
   * VOUCHER, or you get the sales pitch and the million-yen window.
   */
  openBikeShop(onDone?: () => void): void {
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const line = (k: string, fallback: string): string => t[k] ?? fallback;
    const save = this.save as { flags: Record<string, boolean> };

    // CheckEvent EVENT_GOT_BICYCLE. The bag is checked too: the BICYCLE is a
    // key item and cannot be tossed, so owning one is proof either way.
    if ((this.save.inventory?.BICYCLE ?? 0) > 0 || save.flags?.EVENT_GOT_BICYCLE) {
      this.showText(
        line("_BikeShopClerkHowDoYouLikeYourBicycleText", "How do you like\nyour new BICYCLE?"),
        onDone,
      );
      return;
    }

    // .dontHaveBike: IsItemInBag BIKE_VOUCHER
    if ((this.save.inventory?.BIKE_VOUCHER ?? 0) > 0) {
      this.showText(line("_BikeShopClerkOhThatsAVoucherText", "Oh, that's...\fA BIKE VOUCHER!"), () => {
        // GiveItem's `jr nc, .BagFull`: the voucher is only spent once the
        // BICYCLE is actually in the bag.
        if (!Bag.add(this.save, "BICYCLE", 1, this.data)) {
          this.showText(line("_BikeShopBagFullText", "You better make\nroom for this!"), onDone);
          return;
        }
        Bag.remove(this.save, "BIKE_VOUCHER", 1);
        save.flags.EVENT_GOT_BICYCLE = true;
        // BikeShopExchangedVoucherText carries sound_get_key_item.
        this.audio.playSfx("Get_Key_Item");
        this.showText(
          line("_BikeShopExchangedVoucherText", "{PLAYER} exchanged\nthe BIKE VOUCHER\nfor a BICYCLE."),
          onDone,
        );
      });
      return;
    }

    // .dontHaveVoucher: the welcome, then the BICYCLE/CANCEL window
    this.showText(line("_BikeShopClerkWelcomeText", "Hi! Welcome to\nour BIKE SHOP."), () => {
      const pitch = line("_BikeShopClerkDoYouLikeItText", "It's a cool BIKE!\nDo you want it?");
      // The window keeps the pitch's LAST page under it: PrintText hands
      // straight to HandleMenuInput without waiting, so the line is still
      // on screen while the menu is up.
      const pages = paginate(substitute(pitch, { player: this.save.player?.name }));
      const tail = pages[pages.length - 1]?.lines.join("\n") ?? null;
      const win = new BikeShopState(this as never, tail, (bought) => {
        const comeAgain = (): void => {
          this.showText(line("_BikeShopComeAgainText", "Come back again\nsome time!"), () => {
            win.close(); // the window, still up under the text
            onDone?.();
          });
        };
        // A million is out of anyone's reach, so YES only ever gets this.
        if (bought) this.showText(line("_BikeShopCantAffordText", "Sorry! You can't\nafford it!"), comeAgain);
        else comeAgain();
      });
      this.push(win);
    });
  }

  /**
   * StartMenu_Item -> UseItem for a key item that acts on the world. Only
   * the BICYCLE so far (ItemUseBicycle, engine/items/item_effects.asm).
   */
  useKeyItem(itemId: string): void {
    if (itemId === "BICYCLE") this.toggleBike();
    else if (itemId === "POKE_FLUTE") this.playPokeFlute();
    else if (isRod(itemId)) this.goFishing(itemId);
    else this.useFieldItem(itemId);
  }

  /** One line after another, then `onDone`. */
  showLines(lines: readonly string[], onDone?: () => void): void {
    const next = (i: number): void => {
      const line = lines[i];
      if (line === undefined) { onDone?.(); return; }
      this.showText(line, () => next(i + 1));
    };
    next(0);
  }

  /**
   * The escape warp (engine/overworld/special_warps.asm, BIT_ESCAPE_WARP): to
   * wLastBlackoutMap, the last POKeMON CENTER -- the ESCAPE ROPE's landing,
   * and DIG's and TELEPORT's (start_sub_menus.asm runs all three through
   * ItemUseEscapeRope). False with nowhere to go yet.
   */
  escapeWarp(): boolean {
    const heal = this.save.lastHeal as
      | { map: string; x: number; y: number; outdoor?: { id: string; x: number; y: number } }
      | undefined;
    if (!heal) return false;
    this.overworld.startWarpTo(heal.map, heal.x, heal.y, "down");
    // the heal point exits to the town it is IN, not the map we left from
    if (heal.outdoor) this.overworld.rememberOutdoor(heal.outdoor.id, heal.outdoor.x, heal.outdoor.y);
    return true;
  }

  /**
   * An item used from the bag that takes no Pokemon (rules/items.ts): the
   * REPELs, the ESCAPE ROPE, the COIN CASE, the TOWN MAP, the ITEMFINDER --
   * and anything battle-only used outside a battle, which gets OAK's line.
   */
  private useFieldItem(itemId: string): void {
    const r = Items.useItem(this.data, this.save as never, itemId, null, null);
    if (r.kind === "escape_rope") {
      // ItemUseEscapeRope: only inside the dungeon tilesets
      // (escape_rope_tilesets.asm), never in Agatha's room, and it sets
      // BIT_ESCAPE_WARP so the special warp lands at wLastBlackoutMap --
      // the last Pokemon Center, the same as Dig and Teleport.
      const map = this.overworld.map;
      const heal = this.save.lastHeal as
        | { map: string; x: number; y: number; outdoor?: { id: string; x: number; y: number } }
        | undefined;
      if (!map || !Items.ESCAPE_ROPE_TILESETS.has(map.def?.tileset) || map.id === "AGATHAS_ROOM" || !heal) {
        this.showText(Items.itemText(this.data, "_ItemUseNotTimeText",
          "OAK: {PLAYER}!\nThis isn't the\ntime to use that!", { player: this.save.player?.name ?? "RED" }));
        return;
      }
      Bag.remove(this.save, itemId, 1);
      this.escapeWarp();
      return;
    }
    if (r.kind === "townmap") {
      // The TOWN MAP is the gear's own map view, on the bottom screen.
      this.setGearView("map");
      return;
    }
    if (r.kind === "itemfinder") {
      // ItemUseItemfinder (engine/items/itemfinder.asm): a hidden item still
      // unfound within the window around the player, or not.
      const t = (this.data as { text?: Record<string, string> }).text ?? {};
      this.showText(this.overworld.hiddenItemNearby()
        ? (t._ItemfinderFoundItemText ?? "Yes! ITEMFINDER\nindicates there's\nan item nearby.")
        : (t._ItemfinderFoundNothingText ?? "Nope! ITEMFINDER\nisn't responding."));
      return;
    }
    if (r.kind === "consumed") Bag.remove(this.save, itemId, 1);
    this.showLines(r.msgs);
  }

  /**
   * Cast a rod at the water being faced (gen1recomp OverworldController
   * goFishing; engine/items/item_effects.asm FishingInit).
   *
   * Two refusals before any of it, both the original's. FishingInit opens
   * with `cp wWalkBikeSurfState, 2` and every ItemUseXRod jumps out on the
   * carry, so a rod on the water is OAK's "not the time", not a cast -- you
   * cannot fish while surfing. And a rod pointed at anything that is not
   * water says so.
   *
   * Then the dots, then the verdict. The bite goes straight into the battle
   * with no "appeared" line of its own, the way a hooked encounter does.
   */
  goFishing(rod: string): void {
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const line = (k: string, fallback: string): string =>
      (t[k] ?? fallback).replace(/\{PLAYER\}/g, String(this.save.player?.name ?? "RED"));
    const ow = this.overworld;
    const p = ow?.player;
    if (!p) return;
    if (p.surfing) {
      this.showText(line("_ItemUseNotTimeText",
        "OAK: {PLAYER}!\nThis isn't the\ntime to use that!"));
      return;
    }
    const [fx, fy] = p.facingCell();
    if (!ow.map?.inBounds(fx, fy) || !ow.map.isWaterCell(fx, fy)) {
      this.showText("No good! It's not\neven near water.");
      return;
    }
    const hooked = fishingCatch(this.data, rod, ow.map.id, () => this.rng.int(256));
    this.showText(". . .", () => {
      if (!hooked) {
        this.showText(line("_NoNibbleText", "Not even a nibble!"));
        return;
      }
      this.showText(line("_ItsABiteText", "Oh!\nIt's a bite!"), () => {
        this.startWildBattle(hooked.species, hooked.level, { hooked: true });
      });
    });
  }

  /**
   * ItemUsePokeFlute (engine/items/item_effects.asm).
   *
   * Standing next to a sleeping Snorlax, this is the ONLY thing that moves it
   * -- and until one moves, Fuchsia and everything past it is unreachable and
   * the game cannot be finished. Anywhere else the tune just plays.
   *
   * The order is the original's and it matters: the woke-up line, then
   * HideObject BEFORE the battle, then the battle. Hiding first is what makes
   * a blackout survivable -- lose to it and it is still gone, rather than
   * sitting in the road with its event half-set.
   *
   * The parting line is only for a Snorlax that wandered off. Catching it
   * skips that, since it did not go anywhere: it is in your party.
   */
  playPokeFlute(): void {
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const line = (k: string, fallback: string): string => t[k] ?? fallback;
    const found = adjacentSnorlax(
      this.overworld.map?.id ?? "",
      this.overworld.player,
      this.overworld.npcs as never,
      this.save.flags,
    );
    if (!found) {
      this.showText(line("_PlayedFluteNoEffectText",
        "Played the POKé\nFLUTE.\fNow, that's a\ncatchy tune!"));
      return;
    }
    const { spot } = found;
    const player = String(this.save.player?.name ?? "RED");
    this.showText(
      line("_PlayedFluteHadEffectText", "{PLAYER} played the\nPOKé FLUTE.")
        .replace(/\{PLAYER\}/g, player),
      () => {
        this.showText(line(spot.wokeText, "SNORLAX woke up!"), () => {
          // setObjectHidden alone is live-only: it hides the sprite for this
          // visit and forgets. The SAVE toggle is what objectVisible reads on
          // the next entry, and without it a beaten Snorlax is back in the
          // road with its flag already set -- which the flute then refuses to
          // wake, sealing the route for good.
          ((this.save as { objectToggles?: Record<string, Record<string, boolean>> })
            .objectToggles ??= {});
          const toggles = (this.save as unknown as {
            objectToggles: Record<string, Record<string, boolean>>;
          }).objectToggles;
          (toggles[spot.map] ??= {})[spot.object] = false;
          this.overworld.setObjectHidden(spot.object, true);
          this.startWildBattle(
            "SNORLAX", SNORLAX_LEVEL, undefined, (result) => {
              // Any non-blackout result settles it. A blackout does not come
              // back here at all, so reaching this point is already the
              // "survived" branch.
              this.save.flags[spot.beatFlag] = true;
              if (result === "caught") return;
              this.showText(line(spot.leftText, "SNORLAX returned to the mountains!"));
            },
          );
        });
      },
    );
  }

  /**
   * ItemUseBicycle: mount or dismount. The texts are the ROM's own split
   * pair, with wStringBuffer holding the item name.
   *
   * The Cycling Road's BIT_ALWAYS_ON_BIKE refusal (_CannotGetOffHereText)
   * is checked first, exactly as the original gates it ahead of UseItem —
   * the forced-bike stretch is not ported yet, so save.forcedBike is only
   * ever unset here, but the branch is the one the ROM takes.
   */
  toggleBike(): void {
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const line = (k: string, fallback: string): string => t[k] ?? fallback;
    const save = this.save as { onBike?: boolean; forcedBike?: boolean };
    const name = this.data.items?.BICYCLE?.name ?? "BICYCLE";
    const pair = (a: string, b: string): string =>
      `${line(a, "")}\n${line(b, "").replace(/\{RAM:\w+\}/g, name)}`;

    if (save.forcedBike) {
      this.showText(line("_CannotGetOffHereText", "You can't get off\nhere."));
      return;
    }
    if (save.onBike) {
      save.onBike = false;
      this.overworld.syncBike();
      this.startMapMusic(this.overworld.map.id);
      this.showText(pair("_GotOffBicycleText1", "_GotOffBicycleText2"));
      return;
    }
    if (!this.overworld.canRideHere()) {
      this.showText(line("_NoCyclingAllowedHereText", "No cycling\nallowed here."));
      return;
    }
    save.onBike = true;
    this.overworld.syncBike();
    this.startMapMusic(this.overworld.map.id);
    this.showText(pair("_GotOnBicycleText1", "_GotOnBicycleText2"));
  }

  /**
   * The DAY CARE gentleman (world/daycare.ts). Written as a flow rather than
   * script rows because it branches on a party pick in the middle, the same
   * reason the prize window is its own state.
   */
  /**
   * predef HallOfFamePC (engine/events/hall_of_fame.asm): write the record,
   * roll the induction, roll the credits — and then, instead of pokered's
   * `jp Init` soft reset to the title screen, put the player back in their
   * own bedroom in Pallet with everything they earned intact.
   *
   * The save is written at THE END, which is where the original writes it
   * too, so a champion who turns the console off on the credits still comes
   * back a champion.
   */
  recordHallOfFame(onDone?: () => void): void {
    const entry = recordHallOfFame(this.save as never);
    const finish = (): void => {
      // SaveGameData's neighbours: a healed party, home, and LAST_MAP moved
      // off the plateau so the bedroom door opens onto Pallet.
      this.healParty();
      applyPostGameHome(this.save as never);
      this.overworld.lastOutdoor = (this.save as { lastOutdoor?: unknown }).lastOutdoor as never;
      // Written as if already home. The player is still standing beside Oak
      // in the hall when this runs, and a save taken from the live position
      // came back THERE on CONTINUE -- in the hall, with the induction spent
      // and nowhere to go. SaveGameData in HallOfFamePC runs after the
      // player has been put in the bedroom, so that is what is saved.
      this.writeSave?.(POST_GAME_HOME);
      this.overworld.startWarpTo(
        POST_GAME_HOME.map, POST_GAME_HOME.x, POST_GAME_HOME.y, POST_GAME_HOME.facing,
      );
      onDone?.();
    };
    const rollCredits = (): void => {
      const screens =
        (this.data as { field?: { credits?: { screens?: unknown[] } } }).field?.credits?.screens
        ?? [];
      if (screens.length === 0) { finish(); return; }
      this.push(new CreditsState(this as never, screens as never, finish));
    };
    if (entry.length === 0) { rollCredits(); return; }
    this.push(new HallOfFameState(this as never, entry, rollCredits));
  }

  /**
   * The NAME RATER (scripts/NameRatersHouse.asm), via the open_name_rater
   * verb. His whole visit is menus over menus -- ask, party pick, ask,
   * keyboard -- so like the DAY CARE it lives here rather than as script
   * rows, and `onDone` resumes the script that opened him.
   *
   * NameRatersHouseCheckMonOTScript: a mon whose ORIGINAL TRAINER is not
   * the player cannot be renamed. He compliments its name instead, which
   * is how the ROM refuses.
   */
  openNameRater(onDone?: () => void): void {
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const fill = (k: string, fallback: string, name = ""): string =>
      (t[k] ?? fallback)
        .replace(/\{RAM:wNameBuffer\}/g, name)
        .replace(/\{RAM:wBuffer\}/g, name);
    // .did_not_rename -- every way out of his flow but the rename itself
    const bye = (): void =>
      this.showText(fill("_NameRatersHouseNameRaterComeAnyTimeYouLikeText",
        "Fine! Come any\ntime you like!"), onDone);

    this.showChoice(fill("_NameRatersHouseNameRaterWantMeToRateText",
      "Hello, hello!\nI am the official\nNAME RATER!\fWant me to rate\nthe nicknames of\nyour POKéMON?"), (yes) => {
      if (!yes) { bye(); return; }
      this.showText(fill("_NameRatersHouseNameRaterWhichPokemonText",
        "Which POKéMON\nshould I look at?"), () => {
        this.pickPartyMon((index) => {
          const mon = this.save.party[index];
          if (!mon) { bye(); return; }
          const def = this.data.pokemon[mon.species];
          const species = def?.name ?? mon.species;
          const cur = mon.nickname ?? species;
          if (mon.traded === true) {
            this.showText(fill("_NameRatersHouseNameRaterATrulyImpeccableNameText",
              "{RAM:wNameBuffer}, is it?\nThat is a truly\nimpeccable name!\fTake good care of\n{RAM:wNameBuffer}!", cur), onDone);
            return;
          }
          this.showChoice(fill("_NameRatersHouseNameRaterGiveItANiceNameText",
            "{RAM:wNameBuffer}, is it?\nThat is a decent\nnickname!\fBut, would you\nlike me to give\nit a nicer name?\fHow about it?", cur), (rename) => {
            if (!rename) { bye(); return; }
            this.showText(fill("_NameRatersHouseNameRaterWhatShouldWeNameItText",
              "Fine! What should\nwe name it?"), () => {
              this.askNickname(species, (name) => {
                // askNickname reports the DEFAULT back as null, which here
                // means "call it by its species name again".
                mon.nickname = name ?? undefined;
                this.showText(fill("_NameRatersHouseNameRaterPokemonHasBeenRenamedText",
                  "OK! This POKéMON\nhas been renamed\n{RAM:wBuffer}!\fThat's a better\nname than before!",
                  mon.nickname ?? species), onDone);
              });
            });
          });
        }, bye);
      });
    });
  }

  /** A party pick for a script: onPick(index) or onCancel on B / CANCEL. */
  pickPartyMon(onPick: (index: number) => void, onCancel: () => void): void {
    this.push(new PartyState(this as never, { onPick, onCancel }));
  }

  openDaycare(onDone?: () => void): void {
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const line = (k: string, fallback: string): string => t[k] ?? fallback;
    const dc = (this.save as { daycare?: DaycareState | null }).daycare;
    const name = (m: PartyMon): string =>
      m.nickname ?? this.data.pokemon[m.species]?.name ?? m.species;
    if (dc?.mon) { this.daycareCollect(dc, onDone); return; }

    this.showChoice(line("_DaycareGentlemanIntroText", "I run a DAYCARE."), (yes) => {
      if (!yes) {
        this.showText(line("_DaycareGentlemanComeAgainText", "come again."), onDone);
        return;
      }
      // He will not take your last one — you would be left with nothing.
      if (this.save.party.length < 2) {
        this.showText(
          line("_DaycareGentlemanOnlyHaveOneMonText", "You only have one\nPOKéMON with you."),
          onDone,
        );
        return;
      }
      this.showText(line("_DaycareGentlemanWhichMonText", "Which POKéMON\nshould I raise?"), () => {
        this.push(new PartyState(this as never, {
          onCancel: () => onDone?.(),
          onPick: (i: number) => {
            const mon = this.save.party[i];
            if (!mon) { onDone?.(); return; }
            // A mon carrying an HM cannot be boarded: the move would go with
            // it and could strand the player. (The ROM carries this line;
            // gen1recomp's script does not use it.)
            if (mon.moves.some((mv) => this.hmMoveIds().has(mv.id))) {
              this.showText(
                line("_DaycareGentlemanCantAcceptMonWithHMText",
                  "I can't accept a\nPOKéMON that\nknows an HM move."),
                onDone,
              );
              return;
            }
            this.save.party.splice(i, 1);
            (this.save as { daycare?: DaycareState | null }).daycare = {
              mon, steps: 0, depositLevel: mon.level,
            };
            const said = fillDaycareText(
              line("_DaycareGentlemanWillLookAfterMonText", "Fine, I'll look\nafter {RAM:wNameBuffer}."),
              { wNameBuffer: name(mon) },
            );
            this.showText(said, () => {
              this.showText(
                line("_DaycareGentlemanComeSeeMeInAWhileText", "Come see me in\na while."),
                onDone,
              );
            });
          },
        }));
      });
    });
  }

  /** The collection half: the quote, the fee, and only then the growth. */
  private daycareCollect(dc: DaycareState, onDone?: () => void): void {
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const line = (k: string, fallback: string): string => t[k] ?? fallback;
    const mon = dc.mon;
    const monName = mon.nickname ?? this.data.pokemon[mon.species]?.name ?? mon.species;
    const cap = this.data.constants?.levelCap ?? 100;
    const quote = daycareQuote(this.data, dc, cap);
    // Fold the walk in ONCE: leaving the steps on the record would count the
    // same distance again on the next visit.
    mon.exp = quote.exp;
    dc.steps = 0;
    const subs = {
      wNameBuffer: monName,
      wDayCareMonName: monName,
      wDayCareNumLevelsGrown: quote.levelsGrown,
      wDayCareTotalCost: quote.fee,
    };
    const status = quote.levelsGrown > 0
      ? line("_DaycareGentlemanMonHasGrownText", "Your {RAM:wNameBuffer}\nhas grown a lot!")
      : line("_DaycareGentlemanMonNeedsMoreTimeText", "Back already?");
    this.showText(fillDaycareText(status, subs), () => {
      if (this.save.party.length >= 6) {
        this.showText(
          line("_DaycareGentlemanNoRoomForMonText", "You have no room\nfor this POKéMON!"),
          onDone,
        );
        return;
      }
      const owe = fillDaycareText(
        line("_DaycareGentlemanOweMoneyText", "You owe me ¥{NUM:wDayCareTotalCost}\nfor the return\nof this POKéMON."),
        subs,
      );
      this.showChoice(owe, (yes) => {
        if (!yes) {
          this.showText(
            line("_DaycareGentlemanAllRightThenText", "All right then,\n")
              + line("_DaycareGentlemanComeAgainText", "come again."),
            onDone,
          );
          return;
        }
        if ((this.save.money ?? 0) < quote.fee) {
          this.showText(
            line("_DaycareGentlemanNotEnoughMoneyText", "Hey, you don't\nhave enough ¥!"),
            onDone,
          );
          return;
        }
        this.save.money = (this.save.money ?? 0) - quote.fee;
        applyDaycareGrowth(this.data, mon, dc.depositLevel ?? mon.level, quote.newLevel);
        this.save.party.push(mon);
        (this.save as { daycare?: DaycareState | null }).daycare = null;
        this.showText(
          line("_DaycareGentlemanHeresYourMonText", "Thank you! Here's\nyour POKéMON!"),
          () => {
            this.showText(
              fillDaycareText(
                line("_DaycareGentlemanGotMonBackText", "{PLAYER} got\n{RAM:wDayCareMonName} back!"),
                subs,
              ),
              onDone,
            );
          },
        );
      });
    });
  }

  /** A slot seat -> the machine (ui/slotmachine.ts). */
  openSlots(lucky: boolean): void {
    this.push(new SlotMachineState(this as never, this.battleRng, lucky));
  }

  slots(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "slots" ? top.view() : null;
  }

  /** open_prizes verb -> the GAME CORNER prize window (ui/prizescreen.ts). */
  openPrizes(window: number, onDone?: () => void): void {
    const prizes = PRIZE_WINDOWS[window - 1];
    if (!prizes) { onDone?.(); return; }
    this.push(new PrizeState(this as never, prizes, onDone));
  }

  prizes(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "prizes" ? top.view() : null;
  }

  /**
   * A prize mon (give_pokemon's path, without the nickname prompt the prize
   * counter does not run). False when the party is full — the port has no box
   * overflow here, so the sale is refused rather than the mon lost.
   */
  givePrizeMon(species: string, level: number): boolean {
    if (this.save.party.length >= 6) return false;
    this.save.party.push(newMon(this.data, species, level, this.battleRng));
    markOwned(this.save as never, species);
    return true;
  }

  /** open_mart verb -> push the mart shop; onQuit resumes the yielded runner. */
  openShop(stock: string[], onQuit?: () => void): void {
    this.push(new ShopState(this as any, stock, onQuit));
  }

  /** open_vending verb -> the same screen in its machine mode. */
  openVending(onQuit?: () => void): void {
    this.push(new ShopState(this as any, [...VENDING_DRINKS], onQuit, true));
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
        if (act === "save") this.openSaveScreen();
        if (act === "option") {
          this.push(new OptionsMenuState(this as any));
        }
      }),
    );
  }

  /**
   * START -> SAVE, the real flow (engine/menus/save.asm SaveScreen, via
   * gen1recomp StartMenu.lua:52-88): the PLAYER/BADGES/POKéDEX/TIME panel,
   * then "Would you like to SAVE the game?".
   *
   * On YES: "Now saving..." is a bare PlaceString held by DelayFrames 120 —
   * neither that page nor GameSavedText reaches TX_PROMPT_BUTTON, so neither
   * takes a press. The write itself is invisible, on the far side of the
   * hold, so it rides that box's onDone; the second box waits on SFX_SAVE
   * and then DelayFrames 30.
   */
  private openSaveScreen(): void {
    const save = this.save as {
      player: { name: string };
      pokedex?: { owned?: Record<string, boolean> };
      playTime?: number;
    };
    const name = save.player.name ?? "RED";
    const badges = badgeCount(this.data, this.save as never);
    const owned = Object.keys(save.pokedex?.owned ?? {}).length;
    const t = Math.max(0, Math.floor(save.playTime ?? 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor(t / 60) % 60;
    // The panel is its own window above the dialogue box, not text inside it:
    // it is four lines, and the dialogue box holds two, so paginating it
    // there would scroll PLAYER and BADGES away before they could be read.
    // It stays up for the whole flow, as SaveScreen's does.
    this.savePanelLines = [
      `PLAYER ${name}`,
      `BADGES    ${badges}`,
      `POKéDEX ${String(owned).padStart(3)}`,
      `TIME ${String(h).padStart(6)}:${String(m).padStart(2, "0")}`,
    ];
    const close = (): void => { this.savePanelLines = null; };
    this.showChoice("Would you like to\nSAVE the game?", (yes) => {
      if (!yes) { close(); return; }
      this.showAuto("Now saving...", SAVE_HOLD, {
        onDone: () => {
          this.writeSave();
          this.showAuto(`${name} saved\nthe game!`, SAVE_DONE_HOLD, {
            sfx: "Save",
            onDone: close,
          });
        },
      });
    });
  }

  // --- Kanto Gear (ui/kantogear.ts) ------------------------------------
  // Which companion view the bottom screen shows, and where its town-map
  // marker sits. Both are presentation state, not save state: a reload
  // opens on PARTY with the marker back on the player.
  gearView: "party" | "map" = "party";
  gearMapPick: string | null = null;

  setGearView(v: "party" | "map"): void {
    this.gearView = v;
    if (v !== "map") this.gearMapPick = null;
  }

  /**
   * L/R step the companion's view. The shoulder buttons used to cycle the
   * overworld map for debugging, which the DEV menu's WARP picker replaced —
   * that cycler had no way to pick a destination, which is why it went.
   */
  cycleGearView(dir: 1 | -1): void {
    this.setGearView(gearViewStep(this as never, dir));
  }

  setGearMapPick(id: string | null): void {
    this.gearMapPick = id;
  }

  private savePanelLines: string[] | null = null;

  /** SaveScreen's PLAYER/BADGES/POKéDEX/TIME window, while the flow is up. */
  savePanel(): string[] | null {
    return this.savePanelLines;
  }

  /**
   * Commit the save. The live position lives in overworld state; the recomp
   * keeps it in player.*, so it is copied over first and a save written here
   * resumes in exactly the same spot on the desktop build.
   */
  writeSave(at?: { map: string; x: number; y: number; facing: string }): void {
    const ow: any = this.overworld;
    const p: any = this.save.player;
    // `at` is a position the save should resume from that is not where the
    // player is standing (the Hall of Fame's write, which resumes at home).
    p.map = at?.map ?? ow.mapId ?? ow.map?.id ?? p.map;
    p.x = at?.x ?? ow.player?.cellX ?? p.x;
    p.y = at?.y ?? ow.player?.cellY ?? p.y;
    p.facing = at?.facing ?? ow.player?.facing ?? p.facing;
    const h: any = (this as any).host ?? (this as any).hostApi ?? (globalThis as any).voxel;
    if (!h?.saveWrite) {
      console.log("save: no host.saveWrite");
      return;
    }
    // A save that silently took nothing is the worst outcome there is: the
    // player is told it saved and finds out hours later. The host reports
    // whether the card actually took it, and if it did not, say so here
    // rather than anywhere the player will never look.
    const ok = h.saveWrite(encodeSave(this.save));
    this.lastSaveOk = ok !== false;
    if (ok === false) {
      const why = h.writeErr?.() ?? "";
      this.showText(`SAVE FAILED!\nThe SD card did\nnot take it.${why ? `\n${why.slice(0, 24)}` : ""}`);
    }
  }

  optionsMenu(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "options" ? top.view() : null;
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
        if (act === "cardtest") this.runWriteTest();
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
  /**
   * An item used on a party member from the bag (rules/items.ts): the
   * potions and cures, the revives, the ETHERs and ELIXERs, the vitamins,
   * PP UP, the evolution stones. `moveIndex` is the move an ETHER or PP UP
   * was pointed at; without one the move list opens first and comes back
   * here with the pick. The RARE CANDY keeps its own path, which does the
   * level-up's whole ceremony.
   */
  useItem(partyIndex: number, itemId: string, moveIndex?: number): void {
    if (itemId === "RARE_CANDY") { this.useRareCandy(partyIndex); return; }
    const mon = this.save.party[partyIndex];
    if (!mon) return;
    if (Items.needsMove(itemId) && moveIndex === undefined) {
      this.push(new MoveForgetState(this as never, mon, (slot) => {
        if (slot >= 0) this.useItem(partyIndex, itemId, slot);
      }, "CANCEL"));
      return;
    }
    const r = Items.useItem(this.data, this.save as never, itemId, mon, null, moveIndex);
    if (r.kind === "consumed") Bag.remove(this.save, itemId, 1);
    if (r.evolveTo) {
      // ItemUseEvoStone: the stone's evolution runs the same movie a
      // level's does, but cannot be called off, and the new form's learn
      // check follows it.
      const to = r.evolveTo;
      this.push(
        new EvolutionState(
          this as never,
          mon,
          to,
          "ITEM",
          (m, t) => applyEvolution(this.data, m, t, (this.save as { pokedex?: never }).pokedex),
          () => this.learnMovesAtLevel(mon, () => {}),
        ),
      );
      return;
    }
    this.showLines(r.msgs);
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

  /**
   * The carrier for the CABLE CLUB.
   *
   * Handed in by a test or a host that runs both sides (world/link.ts
   * LoopbackLink); otherwise the 3DS radio, or null on a build without one.
   */
  linkCarrier: LinkTransport | null = null;

  linkTransport(): LinkTransport | null {
    return this.linkCarrier ?? hostTransport();
  }

  /**
   * TRADE CENTER / COLOSSEUM / CANCEL, then wait for the peer to ask for the
   * same one. Written as a flow rather than script rows because the menu and
   * the waiting interleave: the choice goes out the moment it is made, and
   * the answer arrives whenever the other player gets round to it.
   */
  pickLinkRoom(session: LinkSession | null, done: (ok: boolean) => void): void {
    if (!session) { done(false); return; }
    const CANCEL = "CANCEL";
    this.push(
      new NamingState(this as never, {
        title: "CABLE CLUB",
        pick: ["TRADE CENTER", "COLOSSEUM", CANCEL],
        onDone: (choice: string) => {
          if (choice === CANCEL) {
            session.cancel();
            done(false);
            return;
          }
          session.chooseRoom(choice === "COLOSSEUM" ? LINK_ROOM.colosseum : LINK_ROOM.trade);
          this.overworld.waitLink(
            (s) => s.agreedRoom() !== null, LINK_WAIT_FRAMES, done, { pleaseWait: true },
          );
        },
      }),
    );
  }

  /**
   * The machine in the COLOSSEUM (engine/link/cable_club.asm's battle).
   *
   * Parties and half a seed each cross, and then nothing else but one
   * choice per turn: both consoles run the whole fight and arrive at the
   * same answer rather than one telling the other what happened. See
   * battle/linkbattle.ts for why that holds.
   */
  linkBattle(done?: () => void): void {
    const ow = this.overworld;
    const s = ow.link;
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const finish = () => done?.();
    const canceled = () =>
      this.showText(t._LinkCanceledText ?? "The link was\ncanceled.", finish);
    if (!s || s.state === "closed") { canceled(); return; }

    const wellFormed = (m: unknown): m is PartyMon => {
      const o = m as PartyMon | null;
      return (
        !!o && typeof o === "object" &&
        typeof o.species === "string" && !!this.data.pokemon?.[o.species] &&
        typeof o.level === "number" && o.level >= 1 && o.level <= 100 &&
        typeof o.hp === "number" && !!o.stats && Array.isArray(o.moves)
      );
    };

    // Whoever pressed first is the initiator and says begin; the console
    // pulled in by that begin finds it waiting and says nothing.
    if (!s.takeBegin()) s.begin();
    // A link battle leaves no mark: the ROM runs it on the party and then
    // restores it, and pays nothing out. Both are put back on the way out.
    const partyBefore = JSON.stringify(this.save.party);
    const moneyBefore = (this.save as { money?: number }).money;
    const myHalf = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
    s.sendParty({
      mons: JSON.parse(JSON.stringify(this.save.party)) as Record<string, unknown>[],
      otName: String(this.save.player?.name ?? "RED"),
      otId: Number((this.save.player as { id?: number } | undefined)?.id ?? 0),
    });
    s.sendSeed(myHalf);

    ow.waitLink(
      (x) => x.peerParty !== null && x.peerSeed !== null,
      LINK_WAIT_FRAMES,
      (ready) => {
        const theirParty = s.peerParty;
        const seed = s.battleSeed(myHalf);
        if (!ready || !theirParty || seed === null) { canceled(); return; }
        const theirs = theirParty.mons.filter(wellFormed) as unknown as PartyMon[];
        if (theirs.length === 0 || this.save.party.length === 0) { canceled(); return; }

        const battle = new LinkBattle(
          this.data, this.save as never, seededRng(seed),
          s.peerName, theirs, s as never, s.seat() === 1,
        );
        const st = new BattleGameState(this, "", 0, battle);
        // A link battle cannot be lost the way a trainer battle is -- there
        // is no blackout and no prize, the ROM just sends you back to the
        // room -- so the outcome is the script's to read, not money's.
        st.loseable = true;
        st.onDone = () => {
          const party = this.save.party;
          party.splice(0, party.length, ...(JSON.parse(partyBefore) as PartyMon[]));
          if (typeof moneyBefore === "number") (this.save as { money?: number }).money = moneyBefore;
          finish();
        };
        this.push(st);
      },
    );
  }

  /**
   * The table in the TRADE CENTER (engine/link/trade.asm).
   *
   * Both parties cross first, so the screen can show yours and theirs at
   * once the way the ROM's does, and so neither side has to take the
   * other's word for what it is sending: an offer is two indices into
   * parties both consoles already hold.
   *
   * Only one side ever reaches the confirm. Whoever picks a pair first is
   * proposing; the other's screen sees the offer land and steps aside to
   * answer it. There is no "your turn" in a Cable Club, just two people
   * reaching for the machine, so the wire decides it rather than a lock.
   */
  linkTrade(done?: () => void): void {
    const ow = this.overworld;
    const s = ow.link;
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    const finish = () => done?.();
    const say = (k: string, f: string, subs: Record<string, string>, after: () => void) => {
      let str = t[k] ?? f;
      str = str.replace(/\{PLAYER\}/g, String(this.save.player?.name ?? "RED"));
      str = str.replace(/\{RAM:(\w+)\}/g, (_m, n: string) => subs[n] ?? "");
      this.showText(str, after);
    };
    const log = (m: string) => {
      if ((globalThis as { voxel?: unknown }).voxel) console.log(`[pv] link: trade ${m}`);
    };
    const canceled = (after: () => void, why = "") => {
      log(`canceled${why ? ": " + why : ""}`);
      say("_LinkCanceledText", "The link was\ncanceled.", {}, after);
    };
    if (!s || s.state === "closed") { canceled(finish, "no link"); return; }

    const nameOf = (m: { nickname?: string; species: string }): string =>
      m.nickname ?? this.data.pokemon?.[m.species]?.name ?? m.species;

    /** Enough of a mon to be one. A peer can send anything. */
    const wellFormed = (m: unknown): m is PartyMon => {
      const o = m as PartyMon | null;
      return (
        !!o && typeof o === "object" &&
        typeof o.species === "string" && !!this.data.pokemon?.[o.species] &&
        typeof o.level === "number" && o.level >= 1 && o.level <= 100 &&
        typeof o.hp === "number" && !!o.stats && Array.isArray(o.moves)
      );
    };
    const entry = (m: PartyMon) => ({
      name: nameOf(m), level: m.level, species: m.species,
      hp: m.hp, maxHp: m.stats?.hp ?? m.hp, status: m.status ?? null,
    });

    // Whoever pressed first is the initiator and says begin; the console
    // pulled in by that begin finds it waiting and says nothing. Either
    // way the table is clear before the parties cross (link.ts begin()).
    if (!s.takeBegin()) s.begin();
    s.resetTrade();
    s.sendParty({
      mons: JSON.parse(JSON.stringify(this.save.party)) as Record<string, unknown>[],
      otName: String(this.save.player?.name ?? "RED"),
      otId: Number((this.save.player as { id?: number } | undefined)?.id ?? 0),
    });

    ow.waitLink((x) => x.peerParty !== null, LINK_WAIT_FRAMES, (arrived) => {
      const theirParty = s.peerParty;
      if (!arrived || !theirParty) { canceled(finish, "their party never came"); return; }
      const theirs = theirParty.mons.filter(wellFormed) as unknown as PartyMon[];
      if (theirs.length === 0) { canceled(finish, "their party was empty"); return; }
      log(`screen: ${this.save.party.length} of mine, ${theirs.length} of theirs`);

      /** Swap slot `mySlot` of mine for `theirSlot` of theirs. */
      const swap = (mySlot: number, theirSlot: number, after: () => void) => {
        const mine = this.save.party[mySlot];
        const got = theirs[theirSlot];
        if (!mine || !got) { canceled(after, "a slot was empty"); return; }
        log(`swap: my ${mine.species} for their ${got.species}`);
        const arrival: PartyMon = { ...got, traded: true,
          otName: theirParty.otName, otId: theirParty.otId };
        this.save.party[mySlot] = arrival;
        const dex = (this.save as { pokedex?: { seen?: Record<string, boolean>;
          owned?: Record<string, boolean> } }).pokedex;
        if (dex) {
          (dex.seen ??= {})[arrival.species] = true;
          (dex.owned ??= {})[arrival.species] = true;
        }
        // Saved the moment it changes hands, on both consoles: the ROM
        // saves before the link opens so a trade cannot be undone by a
        // reset, and a trade that is not written down yet still could be.
        ow.saveGame();
        s.resetTrade();
        this.push(new TradeAnimState(this as never, {
          sending: entry(mine),
          receiving: entry(arrival),
          peerName: s.peerName,
          onDone: () => {
            const subs = { wLinkEnemyTrainerName: s.peerName,
              wNameBuffer: nameOf(arrival), wStringBuffer: nameOf(mine),
              wNameOfPlayerMonToBeTraded: nameOf(mine) };
            say("_TradeWentToText", "{RAM:wStringBuffer} went\nto {RAM:wLinkEnemyTrainerName}.", subs, () =>
              say("_TradeTakeCareText", "Take good care of\n{RAM:wNameBuffer}.", subs, () => {
                // The four that only evolve by changing hands.
                const hit = pendingFor(this.data, arrival as never, { kind: "trade" });
                if (!hit) { after(); return; }
                this.push(new EvolutionState(
                  this as never, arrival as never, hit[0], "TRADE",
                  (mon, to) => applyEvolution(this.data, mon as never, to,
                    (this.save as { pokedex?: never }).pokedex),
                  after,
                ));
              }));
          },
        }));
      };

      const openScreen = () => {
        this.push(new TradeScreenState(this as never, {
          myName: String(this.save.player?.name ?? "RED"),
          peerName: s.peerName,
          mine: this.save.party.map(entry),
          theirs: theirs.map(entry),
          watch: s as unknown as { peerOffer: unknown; state: string },
          onDone: (choice) => {
            if (choice.kind === "cancel") { log("backed out of the screen"); s.answer(false); finish(); return; }
            if (choice.kind === "propose") {
              log(`proposed: my ${choice.give} for their ${choice.take}`);
              s.offer({ give: choice.give, take: choice.take });
              // Their yes or no, however long they take over it. A no, a
              // dropped link or a console gone quiet all end here, with
              // nothing moved on either side.
              ow.waitLink((x) => x.peerAnswer !== null, LINK_ANSWER_FRAMES, (answered) => {
                if (!answered || s.peerAnswer !== true) {
                  s.answer(false); s.resetTrade();
                  canceled(finish, !answered ? "no answer came" : "they said no");
                  return;
                }
                log("they said yes; committing");
                // A yes. Say so, and swap only once they have heard it:
                // the commit is what moves the mons on THEIR side, so it
                // must have landed before it moves them on this one.
                s.commit();
                ow.waitLink((x) => x.unacked() === 0, LINK_WAIT_FRAMES, (heard) => {
                  if (!heard) { s.resetTrade(); canceled(finish, "the commit never landed"); return; }
                  // I proposed: my `give` goes, their `take` comes back.
                  swap(choice.give, choice.take, finish);
                });
              });
              return;
            }
            // They proposed: their `give` comes to me, my `take` goes.
            const o = s.peerOffer;
            if (!o) { canceled(finish, "the offer vanished"); return; }
            const incoming = theirs[o.give];
            const outgoing = this.save.party[o.take];
            if (!incoming || !outgoing) { s.answer(false); canceled(finish, "the offer named an empty slot"); return; }
            log(`offered: their ${incoming.species} for my ${outgoing.species}`);
            const subs = { wLinkEnemyTrainerName: s.peerName,
              wNameBuffer: nameOf(incoming), wStringBuffer: nameOf(outgoing) };
            say("_TradeWillTradeText", "{RAM:wLinkEnemyTrainerName} will\ntrade {RAM:wNameBuffer}", subs, () => {
              let ask = t._TradeforText ?? "for {PLAYER}'s\n{RAM:wStringBuffer}.";
              ask = ask.replace(/\{PLAYER\}/g, String(this.save.player?.name ?? "RED"))
                       .replace(/\{RAM:(\w+)\}/g, () => nameOf(outgoing));
              this.showChoice(ask, (yes) => {
                log(yes ? "said yes; waiting for their commit" : "said no");
                s.answer(yes);
                if (!yes) { s.resetTrade(); canceled(finish, "I said no"); return; }
                // Their commit is the swap; a proposer that gave up in the
                // meantime says no instead (answer false), and either way
                // nothing moves here until they have spoken.
                ow.waitLink((x) => x.peerCommit || x.peerAnswer === false, LINK_WAIT_FRAMES, (spoke) => {
                  if (!spoke || !s.peerCommit) {
                    s.resetTrade();
                    canceled(finish, !spoke ? "their commit never came" : "they withdrew");
                    return;
                  }
                  swap(o.take, o.give, finish);
                });
              });
            });
          },
        }));
      };
      openScreen();
    });
  }

  /** open_diploma (world/script.ts): the completed-POKeDEX page. */
  openDiploma(onDone?: () => void): void {
    this.push(new DiplomaState(this as never, onDone));
  }

  /** ui/tradeanim.ts TradeAnimState.view, for scene.ts. */
  tradeAnim(): unknown {
    const top = this.stack[this.stack.length - 1] as GameState & { view?: () => unknown };
    return top?.kind === "tradeanim" ? (top.view?.() ?? null) : null;
  }

  /** ui/tradescreen.ts TradeScreenState.view, for scene.ts. */
  tradeScreen(): unknown {
    const top = this.stack[this.stack.length - 1] as GameState & { view?: () => unknown };
    return top?.kind === "tradescreen" ? (top.view?.() ?? null) : null;
  }

  /** ui/diploma.ts DiplomaState.view, for scene.ts. */
  diplomaScreen(): unknown {
    const top = this.stack[this.stack.length - 1] as GameState & { view?: () => unknown };
    return top?.kind === "diploma" ? (top.view?.() ?? null) : null;
  }

  /** ui/hofscreen.ts HallOfFameState.view, for scene.ts. */
  hallOfFameScreen(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "halloffame" ? top.view() : null;
  }

  /** ui/hofscreen.ts CreditsState.view, for scene.ts. */
  creditsScreen(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "credits" ? top.view() : null;
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

  /**
   * ItemUseTownMap's fly branch: pick a town you have been to, and go.
   *
   * A town you have not visited is not offered, and neither is the one you
   * are standing in — pokered will not fly you to your own feet. With nothing
   * to offer at all (a brand new save that has only seen Pallet, from Pallet)
   * the move just says it cannot be used here.
   */
  openFlyPicker(monName: string, onDone?: () => void): void {
    const t = (this.data as { text?: Record<string, string> }).text ?? {};
    // CheckIfInOutsideMap (home/overworld.asm): FLY only leaves from an
    // OVERWORLD or PLATEAU map. Without this you could fly out of a cave, out
    // of Silph Co -- and out of an Elite Four room, which undoes the whole
    // point of Lance's door locking behind you.
    const here = this.overworld.map?.def;
    if (here && !isOutside(here)) {
      this.showText(t._CannotFlyHereText ?? "You cannot FLY here.", onDone);
      return;
    }
    const dests = flyDestinations(
      (this.data as { field?: unknown }).field as never,
      this.save as never,
      this.overworld.map?.id,
    );
    if (dests.length === 0) {
      this.showText(t._CannotFlyHereText ?? "You cannot FLY\nhere.", onDone);
      return;
    }
    void monName; // the original names no mon on the way out, it just goes
    this.push(new FlyPickerState(
      this as never,
      dests,
      (dest) => this.overworld.startWarpTo(dest.map, dest.x, dest.y, "down", onDone),
      onDone,
    ));
  }

  /**
   * The lift panel (world/elevator.ts): pick a floor, and the car's exits
   * are rewritten to it. The player walks out of the car themselves, which
   * is how a Gen 1 lift moves anyone.
   */
  openElevator(elevatorMapId: string, onDone?: () => void): void {
    const floors = elevatorFloors(this.data, elevatorMapId);
    if (floors.length === 0) {
      onDone?.();
      return;
    }
    this.push(
      new FloorPickerState(
        this as never,
        floors,
        (floor) => {
          setElevatorExit(this.overworld.map?.def as never, floor);
          // ShakeElevator ends on the PA chime; the ride itself is not
          // animated here, so the chime is what says the car moved.
          this.audio?.playSfx?.("Safari_Zone_PA");
          onDone?.();
        },
        onDone,
      ),
    );
  }

  floorPicker(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "floorpicker" ? top.view() : null;
  }

  flyPicker(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "flypicker" ? top.view() : null;
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

  intro(): unknown {
    const top = this.stack[this.stack.length - 1] as any;
    return top?.kind === "intro" ? top.view() : null;
  }

  /**
   * A newly caught species' dex entry: the line, then the data page
   * (_ItemUseBallText06 + ShowPokedexData). The page opens in standalone
   * mode, so a button closes it rather than dropping into the dex list.
   */
  showCaughtDexEntry(species: string): void {
    const name = this.data.pokemon[species]?.name ?? species;
    this.showText(`New POKéDEX data\nwill be added for\n${name}!`, () => {
      this.push(new PokedexState(this as any, undefined, { species }));
    });
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
    opts?: { noCatch?: boolean; disguised?: boolean; unveil?: boolean; hooked?: boolean },
    onDone?: (result: BattleResult | null) => void,
  ): void {
    const battle = new WildBattle(this.data, this.save, this.battleRng, species, level);
    battle.noCatch = opts?.noCatch === true;
    if (opts?.disguised) battle.makeGhost();
    else if (opts?.unveil) battle.makeUnveiledGhost();
    battle.hooked = opts?.hooked === true;
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
