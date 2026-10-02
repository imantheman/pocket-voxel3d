// Gold's service owner: a port of gen1recomp src/core/Game2.lua (bdfac727).
// It owns the data tables, input, state stack, world and save state for a
// Gold boot, and everything under gen2/ reaches shared services through it.
//
// Boot: copyright -> GameFreak Presents -> GS intro -> title -> main menu ->
// Oak speech -> New Bark Town (world/World.ts).
//
// What is not here, and why:
// - the desktop window: viewport, letterboxing, zoom, tilt, shader
//   pipelines, touch overlay, gamepads, hotkeys, mods, sync, Discord. The
//   3DS host owns the window, and nothing else of the kind exists.
// - FixedStep: the 3DS host calls the guest once per 60 Hz logic step
//   (psp-main's frame(buttons)), so `frame` is the FixedStep callback's body
//   and runs exactly once per call.
// - drawing into a canvas: `draw()` composes the frame onto the Gold screen
//   (platform/lcd.ts) the way drawScene composed its canvas -- the world is
//   the voxel scene underneath (platform/worldview.ts), and the screens
//   draw over it, their untouched cells left as holes.

import { CableClub } from "./CableClub.ts";
import { drawMap2D } from "../platform/map2d.ts";
import { is2d } from "../../viewmode.ts";
import { loadGenerated } from "../platform/data.ts";
import type { Lcd } from "../platform/lcd.ts";
import G, { resetDrawState, setLcd } from "../platform/screen.ts";
import { osTime as clockNow } from "../platform/clock.ts";
import { AutoInput } from "./AutoInput.ts";
import { Clock } from "./Clock.ts";
import { Save } from "./Save.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { Input } from "../shared/core/Input.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { StateStack, type State } from "../shared/core/StateStack.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { TextBox, type TextBoxOpts } from "../shared/render/TextBox.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { MapNameSign } from "../world/MapNameSign.ts";
import { World } from "../world/World.ts";
import { Mon } from "../battle/Mon.ts";
import { Happiness } from "./Happiness.ts";
import { ItemEffects } from "./ItemEffects.ts";
import { Evolution } from "./Evolution.ts";
import { Nests } from "./Nests.ts";
import { Phone } from "./Phone.ts";
import { Decorations } from "./Decorations.ts";
import { Apricorns } from "./Apricorns.ts";
import { PokedexText } from "./PokedexText.ts";
import { Palettes } from "../world/Palettes.ts";
import { MenuFade } from "../ui/MenuFade.ts";

function noop(): void {}

/**
 * `target[key]` = the generated table `name`, parsed the first time anything
 * reads it rather than at boot: on the 3DS every table parsed is heap, and
 * the credits or the battle animations need not cost anything until they
 * run. After the first read (or any write) it is an ordinary property, so
 * the Lua's `self.data.gen2Maps = ...` semantics are unchanged.
 */
function lazyTable(target: Record<string, unknown>, key: string, name: string, fallback?: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      const value = loadGenerated(name) ?? fallback;
      Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
      return value;
    },
    set(value: unknown) {
      Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
    },
  });
}

// Game2.lua:106
function visibleBaseState(stack: typeof StateStack): State | null {
  const state = stack.states[stack.visibleBase()];
  return state && stack.renderVisible(state) ? state : null;
}

/**
 * Game2.lua:133 -- NewGame's OakSpeech runs InitClock first, so every new
 * game anchors wStartHour/wStartMinute (10:00 by default) before the world.
 */
function anchorNewGameClock(save: any): boolean {
  if (Clock.isSet(save)) return false;
  return Clock.setTime(save, Clock.DEFAULT_HOUR, Clock.DEFAULT_MINUTE);
}

// Game2.lua:541
const HM_MOVES: Record<string, boolean> = {
  CUT: true,
  FLY: true,
  SURF: true,
  STRENGTH: true,
  FLASH: true,
  WATERFALL: true,
  WHIRLPOOL: true,
};

export class Game2 {
  [key: string]: any;
  static anchorNewGameClock = anchorNewGameClock;

  speedOverride: number | null = null;
  world: any = null;
  status: string | null = null;
  phase: "boot" | "play" | "error" = "boot";
  input = Input;
  autoInput: any;
  stack = StateStack.init();
  save: any;
  data: any = { audio: {}, pokemon: {} };
  titleData: any = null;
  oakSpeechData: any = null;
  fontData: any = null;
  options: any;
  /** Quarter turns the 3D camera has been swung (the host's bits 24-25), so
   *  the walk keeps "up" meaning away from the camera -- 0 in VIEW 2D. The
   *  Kanto games' overworld.camTurns. */
  camTurns = 0;
  /** The camera's yaw in radians (5.6-degree steps), for the free walk;
   *  undefined on a host that never sends it (tests, the desktop). */
  camYaw: number | undefined = undefined;
  /** The circle pad, -1..1 each axis with +y UP the pad, for the free walk;
   *  undefined on a host that only sends buttons. Menus never read it. */
  stick: { x: number; y: number } | undefined = undefined;
  sessionStartedAt: number;
  joyLatch: { start?: boolean; select?: boolean } | null = null;
  stringBuffer?: string;
  onExit?: () => void;

  /** Game2.lua:141 */
  constructor() {
    this.autoInput = AutoInput.new();
    this.save = Save.newGame();
    this.options = Save.loadOptions();
    this.save.options = this.options;
    this.sessionStartedAt = clockNow();
    anchorNewGameClock(this.save);
  }

  static new(): Game2 {
    return new Game2();
  }

  persistOptions(): void {
    try {
      Save.saveOptions(this.options);
    } catch {
      // Game2.lua:187 pcalls it
    }
  }

  writeOptions(): void {
    this.persistOptions();
  }

  /** Game2.lua:197 -- mod save buckets; no mods here. */
  adoptSave(save: any, _seedBuckets?: boolean): void {
    if (!save) return;
    save.modData = save.modData ?? {};
  }

  /** Game2.lua:232 */
  startWorld(): boolean {
    if (this.world && this.world.map) {
      this.phase = "play";
      return true;
    }
    this.world = World.new(this);
    if (!this.world.load()) {
      this.status = this.world.status;
      this.phase = "error";
      return false;
    }
    this.phase = "play";
    return true;
  }

  showOakSpeech(): void {
    this.stack.clear();
    this.phase = "boot";
    Screens.push(this, "Gen2OakSpeech", {
      data: this.oakSpeechData ?? {},
      font: this.fontData,
      onDone: () => {
        this.stack.clear();
        this.startWorld();
      },
    });
  }

  /** Game2.lua:262 */
  newGame(): void {
    this.save = Save.newGame({ playerName: this.save.player.name });
    this.save.options = this.options;
    this.sessionStartedAt = clockNow();
    anchorNewGameClock(this.save);
    this.adoptSave(this.save);
    ModRuntime.emit("save.created", { save: this.save });
    this.showOakSpeech();
  }

  /** Game2.lua:282 */
  continueGame(save: any): void {
    if (!save) {
      this.newGame();
      return;
    }
    this.save = save;
    this.sessionStartedAt = clockNow();
    this.adoptSave(save);
    Mon.syncSaveIdentity(save, this.data);
    this.save.options = this.options;
    this.applyOptions();
    this.stack.clear();
    this.world = null;
    this.startWorld();
    if (ModRuntime.wants("save.loaded")) ModRuntime.emit("save.loaded", { save, meta: save.meta });
  }

  showMainMenu(): void {
    this.stack.clear();
    this.phase = "boot";
    Screens.push(this, "Gen2MainMenu", {
      onNewGame: () => this.newGame(),
      onContinue: (save: any) => this.continueGame(save),
      onOption: () => this.showOptions(() => this.showMainMenu()),
      onExit: this.onExit,
    });
  }

  returnToTitle(): void {
    Music.stop();
    this.stack.clear();
    this.world = null;
    this.showTitle();
  }

  softReset(): void {
    Music.stop();
    this.stack.clear();
    this.world = null;
    this.showCopyright();
  }

  showOptions(onDone?: () => void): void {
    Screens.push(this, "Gen2OptionsMenu", {
      options: this.options,
      onDone: (options: any) => {
        this.options = options;
        if (this.save) this.save.options = options;
        this.applyOptions();
        this.persistOptions();
        onDone?.();
      },
    });
  }

  showTitle(): void {
    this.stack.clear();
    this.phase = "boot";
    Screens.push(this, "Gen2TitleState", {
      title: this.titleData ?? {},
      onContinue: () => this.showMainMenu(),
      onTimeout: () => this.showCopyright(),
    });
  }

  showIntro(): void {
    this.stack.clear();
    this.phase = "boot";
    const id = GameVersion.engine() === "crystal" ? "Gen2CrystalIntro" : "Gen2GoldSilverIntro";
    Screens.push(this, id, { onDone: () => this.showTitle() });
  }

  showGameFreak(): void {
    this.stack.clear();
    this.phase = "boot";
    const id = GameVersion.engine() === "crystal" ? "Gen2CrystalSplash" : "Gen2GameFreakPresents";
    Screens.push(this, id, {
      title: this.titleData ?? {},
      oakSpeech: this.oakSpeechData ?? {},
      onDone: (skipped: boolean) => (skipped ? this.showTitle() : this.showIntro()),
    });
  }

  showCopyright(): void {
    this.stack.clear();
    this.phase = "boot";
    Screens.push(this, "Gen2CopyrightSplash", {
      title: this.titleData ?? {},
      onDone: () => this.showGameFreak(),
    });
  }

  /** Game2.lua:434 */
  openStartMenu(): void {
    this.world?.cancelMapNameSign?.();
    this.world?.player?.stopForEvent();
    Screens.push(this, "Gen2StartMenu", {
      save: this.save,
      onClose: () => this.stack.pop(),
      onChoose: (id: string) => this.openStartMenuItem(id),
    });
  }

  openStartMenuItem(id: string): void {
    const party = this.save?.party;
    const white = MenuFade.openWhite(id, party ? party.length : 0);
    if (!white) return this.pushStartMenuItem(id);
    Screens.push(this, "Gen2MenuFade", { kind: "out", white, onDone: () => this.pushStartMenuItem(id) });
  }

  closeStartMenuItem(id: string): void {
    this.stack.pop();
    const white = MenuFade.closeWhite(id);
    if (!white) return;
    Screens.push(this, "Gen2MenuFade", { kind: "in", white });
  }

  /** Game2.lua:469 */
  pushStartMenuItem(id: string): void {
    const back = (): void => this.closeStartMenuItem(id);
    if (id === "pokedex") {
      Screens.push(this, "Gen2PokedexMenu", { onClose: back });
    } else if (id === "pokemon") {
      Screens.push(this, "Gen2PartyMenu", { prompt: "choose", submenu: true, onCancel: back });
    } else if (id === "pack") {
      Screens.push(this, "Gen2PackMenu", { onClose: back, onChoose: (itemId: string) => this.useFieldItem(itemId) });
    } else if (id === "pokegear") {
      Screens.push(this, "Gen2Pokegear", {
        onClose: back,
        currentLandmark: this.currentLandmark(),
        onCall: (call: any) => this.runPokegearCall(call),
      });
    } else if (id === "status") {
      Screens.push(this, "Gen2TrainerCard", { onClose: back });
    } else if (id === "save") {
      Screens.push(this, "Gen2SaveMenu", {
        save: this.snapshotSave(),
        writer: () => this.writeSave(),
        onDone: () => {
          this.stack.pop(); // the save screen
          this.stack.pop(); // and the start menu, like .Exit does
        },
      });
    } else if (id === "option") {
      this.showOptions(back);
    } else if (id === "dev") {
      Screens.push(this, "Gen2DevMenu", { onClose: back });
    }
  }

  /** Game2.lua:522 */
  runPokegearCall(call: any): boolean {
    if (!(call && call.kind === "call") || call.wrongNumber) return false;
    const vm = this.world?.vm;
    const key = call.scriptKey;
    if (!(vm && key && vm.scripts[key])) return false;
    if (vm.running()) return false;
    vm.curPhoneCaller = call.contact;
    const ok = vm.start(key);
    if (ok) call.ranScript = true;
    return ok;
  }

  /** Game2.lua:544 -- the level-up / TM "is trying to learn" flow. */
  learnMoveOn(mon: any, moveId: string, onDone?: (learned: boolean) => void): void {
    const moveDef = (this.data.moves ?? {})[moveId];
    const moveName = moveDef?.name ?? moveId;
    const name = mon.nickname ?? mon.name ?? mon.species ?? "?";
    const [ok, reason, entry] = Mon.learnMove(mon, moveId, this.data) as [boolean, string, any];
    const finish = (learned: boolean): void => onDone?.(learned);
    if (ok) {
      return this.say(Strings.get("%s learned\n%s!", name, moveName), () => finish(true), TextBox.soundOpts(this, "Sfx_DexFanfare5079"));
    }
    if (reason !== "full") return finish(false);
    const decline = (): void => this.say(Strings.get("%s\ndid not learn\v%s.", name, moveName), () => finish(false));
    let pickMove: () => void;
    let askStop: () => void;
    const askForget = (): void => {
      this.stack.push(
        TextBox.new(
          this,
          Strings.get(
            "%s is\ntrying to learn\v%s.\fBut %s\ncan't learn more\vthan four moves.\fDelete an older\nmove to make room\vfor %s?",
            name,
            moveName,
            name,
            moveName,
          ),
          undefined,
          { choice: (yes) => (yes ? pickMove() : askStop()) },
        ),
      );
    };
    askStop = (): void => {
      this.stack.push(
        TextBox.new(this, Strings.get("Stop learning\n%s?", moveName), undefined, {
          choice: (yes) => (yes ? decline() : askForget()),
        }),
      );
    };
    const pushList = (): void => {
      Screens.push(this, "Gen2MoveDeleter", {
        mon,
        moves: this.data.moves,
        layout: "forget",
        onCancel: () => {
          this.stack.pop(); // the move list
          this.stack.pop(); // the question it stood on
          askStop();
        },
        onChoose: (slot: number) => {
          // slot is the Lua's 1-based move slot
          const old = mon.moves[slot - 1];
          this.stack.pop(); // the move list
          if (old && HM_MOVES[old.id]) return this.say(Strings.get("HM moves can't be\nforgotten now."), pushList);
          this.stack.pop(); // the question the list stood on
          const oldDef = (this.data.moves ?? {})[old?.id];
          const oldName = oldDef?.name ?? old?.id ?? "?";
          mon.moves[slot - 1] = entry;
          ModRuntime.emit("pokemon.move_learned", { mon, moveId });
          this.say(
            Strings.get("1, 2 and…\u0001 Poof!\u0001\f%s forgot\n%s.\fAnd…\f%s learned\n%s!", name, oldName, name, moveName),
            () => finish(true),
            TextBox.soundOpts(this, "Sfx_DexFanfare5079", { pauseSounds: { 1: "Sfx_SwitchPokemon" } }),
          );
        },
      });
    };
    pickMove = (): void => {
      this.stack.push(TextBox.new(this, Strings.get("Which move should\nbe forgotten?"), undefined, { stay: { onShown: pushList } }));
    };
    askForget();
  }

  /** Game2.lua:638 -- TMs and HMs pick a mon; everything else is a party item. */
  useFieldItem(itemId: string): void {
    const def = (this.data.items ?? {})[itemId];
    const moveId = def?.teaches;
    if (!moveId) return this.usePartyItem(itemId);
    const moveName = (this.data.moves ?? {})[moveId]?.name ?? moveId;
    Screens.push(this, "Gen2PartyMenu", {
      prompt: "choose",
      onCancel: () => this.stack.pop(),
      onChoose: (_index: number, mon: any) => {
        this.stack.pop();
        const learnable: string[] = this.data.pokemon?.[mon.species]?.tmhm ?? [];
        if (!learnable.includes(moveId)) {
          this.say(Strings.get("%s can't learn %s!", Mon.displayName(mon), moveName));
          return;
        }
        for (const move of mon.moves ?? []) {
          if (move.id === moveId) {
            this.say(Strings.get("%s already knows %s!", Mon.displayName(mon), moveName));
            return;
          }
        }
        this.learnMoveOn(mon, moveId, (learned) => {
          if (!learned) return;
          if (String(itemId).startsWith("HM_")) return;
          Happiness.change(mon, "LEARNMOVE");
          this.consumeItem(itemId);
        });
      },
    });
  }

  consumeItem(itemId: string): void {
    if (!this.save?.inventory) return;
    const left = (this.save.inventory[itemId] ?? 1) - 1;
    if (left > 0) this.save.inventory[itemId] = left;
    else delete this.save.inventory[itemId];
  }

  restartMapMusicAfterEvolution(): void {
    this.world?.restoreMapMusic?.();
  }

  /** Game2.lua:703 */
  afterRareCandy(mon: any, result: any, onDone?: () => void): void {
    const data = this.data;
    const queue: string[] = [...(result.learned ?? [])];
    const evolve = (): void => {
      const entry = Evolution.checkMon(data, mon, { timeOfDay: Palettes.clockDaytime() });
      if (!entry) {
        onDone?.();
        return;
      }
      const party: any[] = this.save?.party ?? [];
      const at = party.indexOf(mon);
      Screens.push(this, "Gen2EvolutionAnim", {
        mon,
        entry,
        index: at >= 0 ? at + 1 : undefined,
        party,
        save: this.save,
        onDone: () => {
          this.stack.pop();
          this.restartMapMusicAfterEvolution();
          onDone?.();
        },
      });
    };
    const nextMove = (): void => {
      const moveId = queue.shift();
      if (!moveId) return evolve();
      this.learnMoveOn(mon, moveId, () => nextMove());
    };
    nextMove();
  }

  /** Game2.lua:753 */
  usePartyItem(itemId: string): void {
    const action = ItemEffects.partyAction(itemId, this.data);
    if (!action) return;
    const party: any[] = this.save?.party ?? [];
    if (party.length === 0) {
      this.say(Strings.get("You don't have a\n#MON!"));
      return;
    }
    const openMenu = (): any => {
      const menu = this.stack.top();
      return menu && menu.showItemResult ? menu : null;
    };
    const finish = (result: any, mon: any, slot: number, before: number | undefined): void => {
      const menu = openMenu();
      if (!result.used) {
        this.say(result.text, menu ? () => this.stack.pop() : undefined);
        return;
      }
      if (action === "stone") {
        if (menu) this.stack.pop();
        const p: any[] = this.save?.party ?? [];
        const at = p.indexOf(mon);
        Screens.push(this, "Gen2EvolutionAnim", {
          mon,
          entry: result.evolution,
          index: at >= 0 ? at + 1 : undefined,
          party: p,
          save: this.save,
          force: true,
          onDone: (evolution: any) => {
            if (evolution?.evolved) this.consumeItem(itemId);
            this.stack.pop();
            this.restartMapMusicAfterEvolution();
          },
        });
        return;
      }
      this.consumeItem(itemId);
      if (!menu) {
        if (action === "candy") {
          this.say(result.text, () => this.afterRareCandy(mon, result), result.sfx ? TextBox.soundOpts(this, result.sfx) : undefined);
        } else {
          this.say(result.text);
        }
        return;
      }
      const climbs = (action === "heal" || action === "revive") && before !== undefined && mon.hp && mon.hp !== before;
      menu.showItemResult(slot, {
        fromHp: climbs ? before : undefined,
        toHp: climbs ? mon.hp : undefined,
        sfx: climbs ? "Sfx_Potion" : result.sfx,
        text: result.text,
        onDone: () => {
          this.stack.pop();
          if (action === "candy") this.afterRareCandy(mon, result);
        },
      });
    };
    Screens.push(this, "Gen2PartyMenu", {
      prompt: "useItem",
      onCancel: () => this.stack.pop(),
      onChoose: (slot: number, mon: any) => {
        const before = mon?.hp;
        if (action !== "pp") {
          finish(ItemEffects.useOnMon(itemId, mon, this.data), mon, slot, before);
          return;
        }
        const row = ItemEffects.RESTORE_PP?.[itemId] ?? {};
        if (row.each || mon.isEgg) {
          finish(ItemEffects.usePpItem(itemId, mon, undefined, this.data), mon, slot, before);
          return;
        }
        Screens.push(this, "Gen2MoveDeleter", {
          mon,
          moves: this.data.moves,
          onCancel: () => this.stack.pop(),
          onChoose: (moveSlot: number) => {
            this.stack.pop(); // the move list
            finish(ItemEffects.usePpItem(itemId, mon, moveSlot, this.data), mon, slot, before);
          },
        });
      },
    });
  }

  /** Game2.lua:858 */
  useSelectItem(): void {
    this.world.player?.stopForEvent();
    const [outcome, itemId] = this.world.useSelectItem() as [string, string];
    if (outcome === "not_registered") {
      this.say(Strings.get("An item in your\nPACK may be\fregistered for use\non SELECT Button."));
    } else if (outcome === "cant_use" || outcome === "nowhere") {
      this.say(Strings.get("OAK: {PLAYER}!\nThis isn't the\vtime to use that!"));
    } else if (outcome === "repel_active") {
      this.say(Strings.get("The REPEL used\nearlier is still\vin effect."));
    } else if (outcome === "repel_used") {
      const name = (this.data.items ?? {})[itemId]?.name ?? itemId;
      this.say(Strings.get("{PLAYER} used the\n%s.", name));
    } else if (outcome === "trophy_sent") {
      this.say(Strings.get("There was a trophy\ninside!\fThe trophy was\nsent home."), undefined, TextBox.soundOpts(this, "Sfx_DexFanfare5079"));
    }
  }

  say(text: string, onDone?: () => void, opts?: TextBoxOpts): void {
    this.stack.push(TextBox.new(this, text, onDone, opts));
  }

  currentLandmark(): unknown {
    const map = this.world?.map?.def;
    return Nests.landmarkId(this.data, map?.landmark);
  }

  /** Game2.lua:910 -- fold the live world back into the save table. */
  snapshotSave(): any {
    const world = this.world;
    if (world && world.map && world.player) {
      this.save.position = {
        map: world.map.id,
        x: world.player.cellX,
        y: world.player.cellY,
        facing: world.player.facing,
      };
      this.save.events = world.events ? world.events.serialize() : this.save.events;
      this.save.mapScenes = world.mapScenes ?? this.save.mapScenes;
      this.save.playerState = world.playerState ?? this.save.playerState;
      this.save.scriptMem = world.vm ? world.vm.serializeMem() : this.save.scriptMem;
      this.save.variableSprites = world.variableSprites ?? this.save.variableSprites;
      this.save.backupWarp = world.backupWarp ?? this.save.backupWarp;
    }
    this.save.options = this.options;
    return this.save;
  }

  /** Game2.lua:959 */
  writeSave(): [boolean, unknown?] {
    if (ModRuntime.call("save.write", () => true, this) === false) return [false];
    const save = this.snapshotSave();
    const result = Save.save(save);
    return Array.isArray(result) ? (result as [boolean, unknown?]) : [!!result];
  }

  quickSaveAllowed(): boolean {
    const w = this.world;
    if (!w || !(w.map && w.player) || !w.acceptsMenuInput) return true;
    return w.acceptsMenuInput() === true;
  }

  /** Game2.lua:1008 */
  load(opts: { startWorld?: boolean } = {}): void {
    Input.init();
    this.applyOptions();
    this.titleData = loadGenerated("title") ?? {};
    this.oakSpeechData = loadGenerated("oak_speech") ?? {};
    this.data.font = loadGenerated("font");
    this.fontData = this.data.font;
    this.data.audio = loadGenerated("audio") ?? {};
    this.data.pokemon = loadGenerated("pokemon") ?? {};
    this.data.items = loadGenerated("items") ?? {};
    this.data.moves = loadGenerated("moves") ?? {};
    this.data.type_chart = loadGenerated("type_chart") ?? {};
    const chart = this.data.type_chart;
    if (chart.matchups && !chart.foresightFolded) {
      for (const row of chart.foresightMatchups ?? []) chart.matchups.push(row);
      chart.foresightFolded = true;
    }
    this.data.gen2HeldItems = ItemEffects.heldItemsFrom(this.data.items);
    const heldBefore = ItemEffects.heldSnapshot(this.data.gen2HeldItems);
    lazyTable(this.data, "gen2Palettes", "palettes");
    lazyTable(this.data, "gen2Icons", "icons");
    lazyTable(this.data, "gen2Pokedex", "pokedex");
    lazyTable(this.data, "gen2Landmarks", "landmarks");
    lazyTable(this.data, "gen2Sprites", "sprites");
    lazyTable(this.data, "gen2MenuGfx", "menu_gfx");
    lazyTable(this.data, "gen2Intro", "intro");
    lazyTable(this.data, "gen2Credits", "credits");
    lazyTable(this.data, "gen2Diploma", "diploma");
    lazyTable(this.data, "gen2Trade", "trade");
    lazyTable(this.data, "gen2Trainers", "trainers");
    lazyTable(this.data, "gen2Encounters", "encounters");
    lazyTable(this.data, "gen2BattleAnims", "battle_anims");
    lazyTable(this.data, "gen2Constants", "constants");
    lazyTable(this.data, "gen2Maps", "maps");
    lazyTable(this.data, "gen2Tilesets", "tilesets");
    lazyTable(this.data, "gen2Roofs", "roofs");
    lazyTable(this.data, "gen2Field", "field");
    lazyTable(this.data, "gen2Marts", "marts");
    lazyTable(this.data, "gen2Scripts", "scripts");
    lazyTable(this.data, "gen2StdScripts", "std_scripts");
    lazyTable(this.data, "gen2Text", "text");
    lazyTable(this.data, "text", "rom_text", {});
    lazyTable(this.data, "gen2EventTables", "events");
    lazyTable(this.data, "gen2InitialEvents", "initial_events");
    lazyTable(this.data, "trainers", "trainers");
    ItemEffects.applyHeldItems(this.data, heldBefore);
    Phone.useRegistry(this.data);
    Decorations.useRegistry(this.data);
    Apricorns.useRegistry(this.data);
    PokedexText.apply(this.data);
    if (this.data.font) {
      try {
        Font.load(this.data);
      } catch (e) {
        Logger.error("font: %s", String(e));
      }
    }
    Strings.load(this.data);
    this.adoptSave(this.save, true);
    ModRuntime.emit("save.created", { save: this.save });
    ModRuntime.emit("game.ready", { game: this });
    // POKEPORT_DRIVER's shortcut straight into the world (tests)
    if (opts.startWorld) this.startWorld();
    else this.showCopyright();
  }

  inFillBoot(): boolean {
    return this.phase === "boot" && this.stack.top() !== undefined;
  }

  logicSpeed(): number {
    return Math.max(1, Number(this.speedOverride ?? this.options?.speed ?? 1) || 1);
  }

  /**
   * One 60 Hz step: Game2:update's per-step audio work, then the FixedStep
   * callback (Game2.lua:1236), with the pad's buttons for this step.
   */
  frame(buttons: number): void {
    Music.update(this.data);
    if (this.world && this.world.map) MapNameSign.frame(this.world);
    Input.setButtons(buttons);
    ModRuntime.call("input.step", noop, this, 1 / 60);
    this.autoInput.step(this.input);
    this.input.step();
    if (this.input.isDown("a") && this.input.isDown("b") && this.input.isDown("start") && this.input.isDown("select")) {
      Input.reset();
      this.softReset();
      return;
    }
    const top = this.stack.top();
    if (top && typeof top.update === "function") {
      top.update(1 / 60);
      return;
    }
    if (this.phase !== "play" || !this.world) return;
    Save.tickPlayTime(this.save);
    // a free walk stands on its cell for a button (a menu, a talk, an item):
    // whatever it starts steps from the cell (the Kanto free walk's snap)
    if (this.input.wasPressed("a") || this.input.wasPressed("start") || this.input.wasPressed("select")) {
      this.world.freeSnap?.();
    }
    const accepts = this.world.acceptsMenuInput();
    let latch = this.joyLatch;
    if (accepts) {
      this.joyLatch = null;
      if (this.input.wasPressed("start") || (latch?.start && this.input.isDown("start"))) {
        this.openStartMenu();
        return;
      }
      if (this.input.wasPressed("select") || (latch?.select && this.input.isDown("select"))) {
        this.useSelectItem();
        return;
      }
    } else {
      if (!latch) latch = this.joyLatch = {};
      if (this.input.wasPressed("start")) latch.start = true;
      if (this.input.wasPressed("select")) latch.select = true;
    }
    this.world.pollInput(this.input);
    if (this.input.wasPressed("a")) this.world.interact();
    this.world.step();
  }

  /** Game2.lua:1727 -- the base screen's paper colour for text boxes. */
  textboxPaper(): number[] | undefined {
    const base = visibleBaseState(this.stack);
    return base && base.paperColor ? base.paperColor() : undefined;
  }

  /** True when the voxel world shows this frame (drawScene's frameWorldActive). */
  frameWorldActive = false;

  /**
   * Game2.lua:1816 drawScene, onto the Gold screen: during boot the screens
   * fill it; in play the world is the scene underneath and the stack draws
   * over it, unless an opaque screen covers everything.
   */
  draw(lcd: Lcd): void {
    setLcd(lcd);
    lcd.begin();
    resetDrawState();
    lcd.shown = true;
    this.frameWorldActive = false;
    const W = 160;
    const H = 144;
    const top = this.stack.top();
    const base = visibleBaseState(this.stack);
    const wideOf = (s: State | null | undefined): State | null =>
      s && s.drawsWidescreen && s.drawsWidescreen() && s.drawWidescreen ? s : null;
    const wide = (top && this.stack.renderVisible(top) ? wideOf(top) : null) ?? wideOf(base);
    if (this.inFillBoot()) {
      if (wide) {
        wide.drawWidescreen(W, H);
        if (wide !== top || this.stack.states.length - 1 > this.stack.visibleBase()) this.stack.draw();
      } else {
        G.setColor(1, 1, 1, 1);
        G.rectangle("fill", 0, 0, W, H);
        this.stack.draw();
      }
      return;
    }
    if (this.world && this.world.map) {
      // A battle staged in 3D with screens over it (its party, its pack and
      // what they open): those are the bottom screen's (ui/Companion.ts),
      // and the top keeps the arena and the HUDs, as the Kanto games' 3D
      // battles keep theirs.
      const routed = this.stagedBattleBelow();
      if (routed) {
        this.frameWorldActive = true;
        const b = routed.battle;
        if (b.drawsWidescreen && b.drawsWidescreen() && b.drawWidescreen) b.drawWidescreen(W, H);
        else b.draw?.();
        return;
      }
      if (wide) {
        wide.drawWidescreen(W, H);
        if (wide !== top) this.stack.draw();
        return;
      }
      if (base && base.isOpaque) {
        // a battle staged in the voxel world (platform/battlestage.ts) shows
        // the world through its open field, undimmed
        if (base.staged3d) this.frameWorldActive = true;
        if (base.drawWidescreen) base.drawWidescreen(W, H);
        else {
          G.setColor(1, 1, 1, 1);
          G.rectangle("fill", 0, 0, W, H);
        }
        this.stack.draw();
        return;
      }
      // the world is the voxel scene; the stack draws over its holes -- or,
      // with VIEW 2D, the map drawn on the Gold screen itself (map2d.ts)
      this.frameWorldActive = true;
      // (2D SCREEN / 2D ZOOM's canvas reaches past the box: not while a
      // fade or a battle's wipe covers the box, so the sides go dark too)
      if (is2d(this.options?.view)) {
        const boxed = this.worldFaded() || top?.screenId === "Gen2BattleTransition";
        drawMap2D(this.world, this.data, boxed ? undefined : this.options);
      }
      this.coverFadedWorld();
      this.world.drawOverlay?.();
      if (this.stack.top()) this.stack.draw();
      return;
    }
    // Game2.lua:2000 -- the boot failed
    GbcPalette.clear();
    G.clear(0.07, 0.05, 0.02);
    Font.draw("POKEMON GOLD", 32, 48);
    Font.draw(String(this.status ?? "No world").slice(0, 20), 0, 72);
  }

  /** The CABLE CLUB's session (core/CableClub.ts), made on first use. */
  private club: CableClub | null = null;
  cableClub(): CableClub {
    return (this.club ??= new CableClub(this));
  }
  /** Once a frame (gen2/main.ts): the link, when one is open. */
  serviceLink(): void {
    this.club?.service();
  }

  /**
   * The battle staged in 3D on the stack and the screens standing over it,
   * or null when there is none or nothing is over it: those screens draw on
   * the bottom screen (ui/Companion.ts) and the top keeps the battle.
   */
  stagedBattleBelow(): { battle: State; above: State[] } | null {
    const states = this.stack.states;
    for (let i = states.length - 1; i >= 0; i--) {
      const s = states[i] as State & { screenId?: string; staged3d?: boolean };
      if (s && s.screenId === "Gen2BattleState") {
        return s.staged3d && i < states.length - 1 ? { battle: s, above: states.slice(i + 1) } : null;
      }
    }
    return null;
  }

  /**
   * The world's fade to white or black (World.lua's fade ramp: warps, the
   * map-setup white hold, fade specials). The Lua remapped its map canvas
   * along the ramp; the voxel world has no such pass, so past the ramp's
   * midpoint the Gold screen covers the 3D view in the fade's colour -- a
   * two-step fade rather than four, but no hard cut.
   */
  private coverFadedWorld(): void {
    if (!this.worldFaded()) return;
    if (this.world.fade === "black") G.setColor(0, 0, 0, 1);
    else G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 0, 0, 160, 144);
  }

  /** Past the fade ramp's midpoint (or held there): coverFadedWorld covers the world. */
  private worldFaded(): boolean {
    const w = this.world;
    if (!w || !w.fade) return false;
    const level = typeof w.fadeLevel === "number" ? w.fadeLevel : 1;
    return level >= 0.5 || w.fadeHold != null;
  }

  /** Game2.lua:2304 -- the options the 3DS still has a use for. */
  applyOptions(): void {
    const options = this.options ?? {};
    const music = Music as unknown as { applyOptions?(o: unknown): void };
    const sound = Sound as unknown as { applyOptions?(o: unknown): void };
    try {
      music.applyOptions?.(options);
      sound.applyOptions?.(options);
    } catch {
      // sound is optional until its port lands
    }
    GbcPalette.applyOptions(options);
    Font.setFrame(options.frame ?? 1);
  }

  reset(): void {
    try {
      this.stack.clear();
    } catch {
      // Game2.lua:2531 pcalls it
    }
    this.world?.release?.();
  }
}

export default Game2;
