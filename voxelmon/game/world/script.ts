// Map-script execution. Ports gen1recomp src/script/ScriptRunner.lua's
// coroutine model as a resumable generator: scripts are lists of
// ["command", args...] rows; blocking commands park the generator and a
// completion callback resumes it (ScriptRunner.lua:93 new, :119 run,
// :233 update).
//
// Only the slice's verb set is ported from src/script/Commands.lua:
// show_text :81, jump :143, ask :154, face_player :162, set_flag :168,
// check_flag :176, jump_if_true :205, jump_if_false :209, give_item :220,
// warp :308, wait :316, move_player :330, label :1005, emote :1014,
// play_once :533, heal_party :587, fade :1216.
//
// The set is exactly what the cooked maps' hand-ported scripts invoke
// (mapscripts.ts): everything upstream reaches for outside those scripts —
// object visibility, forced-walk cutscenes, trainer engagement, the naming
// screen, the dex rating — belongs to the rungs docs/VOXEL.md §10 defers.

import type { VoxelmonData } from "../data.ts";
import * as Bag from "../rules/bag.ts";
import { FADE_OUT_TO_WHITE } from "../rules/timing.ts";
import { CELL_PX, FX_FRAME_CUT_TREE, Q4 } from "../../../contracts/spec/voxel-spec.ts";
import type { Dir } from "./collision.ts";
import type { NPC } from "./npc.ts";

import { newMon, markOwned } from "../battle/mon.ts";
import { martStock } from "./marts.ts";

export type ScriptRow = [string, ...unknown[]];

export interface ScriptSave {
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  bagOrder?: string[];
  player: { name: string; rival: string };
  /** Cut-tree cells permanently chopped, per map id then `"cx,cy"` — see
   * OverworldShell's SaveSlice.cutTrees (same field, narrower view). */
  cutTrees?: Record<string, Record<string, boolean>>;
}

/** The services a command reaches — the overworld hands itself in. */
export interface ScriptWorld {
  data: VoxelmonData;
  save: ScriptSave;
  /** Push a dialogue box; onDone fires when it closes. */
  showText(text: string, onDone: () => void): void;
  /** Push a dialogue box with a YES/NO choice; choice(yes) fires instead. */
  showChoice(text: string, choice: (yes: boolean) => void): void;
  /** Resolve a TEXT_* constant through the current map's pointers. */
  resolveText(textId: string): string | null;
  startWarpTo(mapId: string, x: number, y: number, facing: Dir, onDone: () => void): void;
  scriptMove(entity: { moving: boolean }, dir: Dir, tiles: number, onDone?: () => void): void;
  player: { moving: boolean; facingCell(): [number, number] };
  /** The current map: just enough for a field-move verb (use_cut) to check
   * the faced cell against cook-time cuttableCells and know this map's
   * numeric id for the stamp op. */
  map: {
    id: string;
    def: { index: number };
    isCuttableCell(cx: number, cy: number): boolean;
  };
  setEmote(entity: unknown, bubble: number, frames: number, onDone: () => void): void;
  /** Pokemon.lua:90 heal, over the whole party. */
  healParty(): void;
  /** Music.lua:playOnce — a one-shot song; onDone fires when it ends. */
  playOnce(songId: string, onDone: () => void): void;
  /** The fade overlay's ramp (Commands.lua:1216); the port holds frames. */
  fade(dir: "in" | "out", frames: number, onDone: () => void): void;
  /** Screen-space portrait (voxel `pic` op): the intro speech, battle intros. */
  showPic(page: number, x: number, y: number, w: number, h: number): void;
  hidePic(): void;
  /** Turn an NPC to face the player (NPC.lua facePlayer). */
  facePlayer(npc: NPC): void;
  /** Toggle a cooked map decoration stamp (host.stamp) — see
   * OverworldShell.stamp. */
  stamp(mapId: number, cx: number, cy: number, on: boolean): void;
  /** Scene-wide colour multiply (host.tint) — see OverworldShell.tint. */
  tint(abgr: number): void;
  /** Field effect billboard at Q4 world px; frame < 0 clears it. */
  fieldFx(x: number, z: number, frame: number): void;
}

export interface ScriptContext {
  world: ScriptWorld;
  runner: ScriptRunner;
  npc?: NPC;
  lastCheck?: boolean;
  onDone?: () => void;
}

// Commands.lua:1024 EMOTE_BUBBLES (data.field.emotionBubbles order; matches
// the spec's EMOTE shock/question/happy = 1/2/3)
const EMOTE_BUBBLES: Record<string, number> = { shock: 1, question: 2, happy: 3 };

/** HM Cut's tree animation (pokered AnimateCutTree): the sprite flickers on
 * and off over the tree before the block changes. Beats alternate on/off, so
 * an even count ends with it hidden. */
const CUT_ANIM_BEATS = 8;
const CUT_ANIM_BEAT_FRAMES = 5;

type Verb = (ctx: ScriptContext, ...args: unknown[]) => Generator<void, string | number | void>;

// Commands.lua:70 show_text's lookup: a text label first, then the map's
// TEXT_* pointers, and a hand-written row's literal string last. subs
// replaces the dynamic {TOKEN}s the extracted line carries.
function scriptText(
  w: ScriptWorld,
  textId: string,
  subs?: Record<string, string>,
): string {
  let text =
    (w.data.text as Record<string, string> | undefined)?.[textId] ??
    w.resolveText(textId) ??
    textId;
  if (subs) {
    for (const [token, value] of Object.entries(subs)) {
      text = text.replace(new RegExp(`\\{${token}:?\\w*\\}`, "g"), value);
    }
  }
  return text;
}

// Commands.lua:70 show_text
function* show_text(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  const text = scriptText(
    ctx.world,
    args[0] as string,
    args[1] as Record<string, string> | undefined,
  );
  console.log("show_text[" + String(args[0]).slice(0, 28) + "] len=" + (text?.length ?? -1));
  ctx.world.showText(text, () => {
    console.log("show_text done");
    runner.resume();
  });
  yield;
}

// Commands.lua:154 ask — show_text with opts.choice, so the YES/NO box pops
// over the still-visible text; the answer lands in ctx.lastCheck. It goes
// through show_text, so it takes the same subs.
function* ask(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  const text = scriptText(
    ctx.world,
    args[0] as string,
    args[1] as Record<string, string> | undefined,
  );
  ctx.world.showChoice(text, (yes) => {
    ctx.lastCheck = yes;
    runner.resume();
  });
  yield;
}

// Commands.lua:168 set_flag (Flags.set: save.flags keyed by pokered event
// constant names)
function* set_flag(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  ctx.world.save.flags[args[0] as string] = true;
}

// Commands.lua:220 give_item — adds to the bag and shows the "got item!"
// box; a full bag halts the script so later set_flag rows don't burn the
// gift (pokered's `jr nc, .bag_full`). The jingle (sound_get_item_1) is
// out of the slice's scope; the box waits on A/B like every other.
function* give_item(ctx: ScriptContext, ...args: unknown[]): Generator<void, number | void> {
  const itemId = args[0] as string;
  const count = (args[1] as number | undefined) ?? 1;
  const gotText = args[2] as string | false | undefined;
  const w = ctx.world;
  const runner = ctx.runner;
  if (!Bag.add(w.save, itemId, count, w.data)) {
    w.showText("You can't carry\nany more items!", () => runner.resume());
    yield;
    return Number.POSITIVE_INFINITY;
  }
  const def = w.data.items?.[itemId];
  const name = def?.name ?? itemId;
  if (gotText !== false) {
    // gotText picks the script's own received-text (a label or a literal);
    // pokered copies the item name into wStringBuffer first, so the extracted
    // line's {RAM:wStringBuffer} slot is where the name goes.
    const text =
      gotText === undefined
        ? `{PLAYER} got\n${name}!`
        : scriptText(w, gotText as string, { "RAM:wStringBuffer": name });
    w.showText(text, () => runner.resume());
    yield;
  }
}

// Commands.lua:308 warp
function* warp(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  ctx.world.startWarpTo(
    args[0] as string,
    args[1] as number,
    args[2] as number,
    args[3] as Dir,
    () => runner.resume(),
  );
  yield;
}

// Commands.lua:316 wait
function* wait(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  ctx.runner.waitingFrames = args[0] as number;
  yield;
}

// Commands.lua:330 move_player (walkEntity)
function* move_player(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  ctx.world.scriptMove(ctx.world.player, args[0] as Dir, (args[1] as number | undefined) ?? 1, () =>
    runner.resume(),
  );
  yield;
}

// Commands.lua:1014 emote — the emotion-bubble hold
// (engine/overworld/emotion_bubbles.asm); blocks frames (default 60, the
// trainer-sight hold). target "player", or nil for the talking NPC.
function* emote(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const targetArg = args[0] as string | undefined;
  const bubble = args[1] as string | number | undefined;
  const frames = (args[2] as number | undefined) ?? 60;
  const entity = targetArg === "player" ? ctx.world.player : ctx.npc;
  if (!entity) return;
  const runner = ctx.runner;
  const kind =
    typeof bubble === "number" ? bubble : EMOTE_BUBBLES[bubble ?? "shock"] ?? 1;
  ctx.world.setEmote(entity, kind, frames, () => runner.resume());
  yield;
}

// Commands.lua:143 jump — the runner resolves a number to a row and a string
// to a label ("end" halts).
function* jump(_ctx: ScriptContext, ...args: unknown[]): Generator<void, string | number> {
  return args[0] as string | number;
}

// Commands.lua:162 face_player
function* face_player(ctx: ScriptContext): Generator<void, void> {
  if (ctx.npc) ctx.world.facePlayer(ctx.npc);
}

// Commands.lua:176 check_flag (Flags.get: absent reads false)
function* check_flag(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  ctx.lastCheck = ctx.world.save.flags[args[0] as string] === true;
}

// Commands.lua:205 jump_if_true / :209 jump_if_false — no jump when the test
// fails, so the runner falls through to the next row.
function* jump_if_true(
  ctx: ScriptContext,
  ...args: unknown[]
): Generator<void, string | number | void> {
  if (ctx.lastCheck) return args[0] as string | number;
}

function* jump_if_false(
  ctx: ScriptContext,
  ...args: unknown[]
): Generator<void, string | number | void> {
  if (!ctx.lastCheck) return args[0] as string | number;
}

// Commands.lua:1005 label — a jump target, and nothing at runtime.
function* label(): Generator<void, void> {}

// Commands.lua:587 heal_party (Pokemon.heal: full HP, status cleared, PP
// restored) — the POKéMON CENTER heal Mom performs at home.
function* heal_party(ctx: ScriptContext): Generator<void, void> {
  ctx.world.healParty();
}

// Commands.lua:533 play_once — a one-shot song that BLOCKS until it ends
// (runner.waitingCheck on Music.oneShotPlaying).
function* play_once(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  ctx.world.playOnce(args[0] as string, () => runner.resume());
  yield;
}

// Commands.lua:1216 fade — the overlay ramp, out to the colour then back in.
// The voxel slice has no overlay op, so the ramp is the held frames the port
// spends on every other fade (game.ts WarpFadeState); the colour argument is
// carried for the citation and ignored.
function* fade(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const dir = args[0] === "in" ? "in" : "out";
  // parseFadeArgs (Commands.lua:1200): either order, the number is frames
  const frames =
    (typeof args[1] === "number" ? args[1] : typeof args[2] === "number" ? args[2] : undefined) ??
    FADE_OUT_TO_WHITE;
  const runner = ctx.runner;
  ctx.world.fade(dir, frames, () => runner.resume());
  yield;
}


// oaks_lab.lua rung: the starter choice. give_pokemon is real; the object and
// audio verbs are honest no-ops so upstream scripts run end to end instead of
// dying on an unknown row (ScriptRunner.lua:158 does the same for old content).
function* give_pokemon(ctx: ScriptContext, ...args: unknown[]): Generator<void, number | void> {
  const species = args[0] as string;
  const level = (args[1] as number | undefined) ?? 5;
  const w = ctx.world as any;
  // Commands.lua:695-696 — a received mon is owned (+seen) whether or not the
  // party has room, so the starter and every gift fill the dex.
  markOwned(w.save, species);
  const party = w.save.party as any[];
  if (party.length >= 6) return;
  const mon = newMon(w.data, species, level);
  party.push(mon);
  // The script's own _OaksLabReceivedMonText row prints the line; the
  // nickname prompt is the only thing this verb waits on.
  const runner = ctx.runner;
  if (typeof w.askNickname === "function") {
    const label = w.data.pokemon?.[species]?.name ?? species;
    w.askNickname(label, (name: string | null) => {
      if (name) mon.nickname = name;
      runner.resume();
    });
    yield;
  }
}

function* noop_object(): Generator<void, number | void> { return; }
function* noop_audio(): Generator<void, number | void> { return; }

function* walk_route(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  // ["walk_route", ref, [[x,y],[x,y],...]]
  const runner = ctx.runner;
  (ctx.world as any).walkRoute?.(args[0], args[1] as [number, number][],
    () => runner.resume());
  yield;
}

function* start_battle(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  // ["start_battle", "trainer", "OPP_PROF_OAK", 3]
  const kind = String(args[0] ?? "trainer");
  const id = String(args[1] ?? "");
  const idx = (args[2] as number) ?? 1;
  // opts.loseable marks a battle whose loss heals-and-continues (the early
  // rival) instead of blacking out.
  const opts = (args[3] as { loseable?: boolean } | undefined) ?? {};
  const runner = ctx.runner;
  const w = ctx.world as any;
  if (kind === "trainer" && w.startTrainerBattle) {
    w.startTrainerBattle(id, idx, undefined, (won: boolean) => {
      // expose the result so a script can jump_if_false past its rewards on a
      // loss (home/battle.asm returns to the map only after a win otherwise).
      ctx.lastCheck = !!won;
      runner.resume();
    }, opts.loseable === true);
    yield;
    return;
  }
  // ["start_battle", "wild", "MAROWAK", 30, { noCatch, disguised }] — a wild
  // battle a script opens rather than one the grass rolled. lastCheck is the
  // defeat test the tower branches on: a win, and also a POKE DOLL escape,
  // which leaves wBattleResult untouched and so reads as a defeat
  // (PokemonTower6FMarowakBattleScript's "and a / jr nz").
  if (kind === "wild" && w.startWildBattle) {
    const wopts = opts as { noCatch?: boolean; disguised?: boolean };
    w.startWildBattle(id, idx, wopts, (result: string | null) => {
      ctx.lastCheck = result === "win";
      runner.resume();
    });
    yield;
  }
}

function* move_player_to(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  (ctx.world as any).movePlayerTo?.(args[0] as number, args[1] as number,
    () => runner.resume());
  yield;
}

function* place_npc(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  (ctx.world as any).placeNpc?.(
    args[0] as string, args[1] as number, args[2] as number,
    (args[3] as string) ?? "down",
  );
}

// gen1recomp Commands.lua:540-546 show_object/hide_object -> toggleObject:
// writes save.objectToggles[map][name] (WorldAPI.lua:127-133, the same store
// the spawn filter reads) so a CROSS-MAP toggle persists — Oak's lab hiding
// the Viridian sleeper takes effect when Viridian is next entered — then
// applies it live if the object is on the current map. Rows come as
// ["<verb>", MAP, NAME]; the legacy ["<verb>", NAME] form targets current map.
function toggleObject(ctx: ScriptContext, args: unknown[], visible: boolean): void {
  const w = ctx.world as any;
  const hasMap = args.length >= 2;
  const curMap = String(w.map?.id ?? "");
  const mapId = hasMap ? String(args[0]) : curMap;
  const name = String(hasMap ? args[1] : args[0]);
  const key = name.toUpperCase().replace(/^TEXT_/, "");
  const save = w.save as { objectToggles?: Record<string, Record<string, boolean>> };
  save.objectToggles = save.objectToggles ?? {};
  save.objectToggles[mapId] = save.objectToggles[mapId] ?? {};
  save.objectToggles[mapId][key] = visible;
  // live-apply on the current map (setObjectHidden resolves by name/text);
  // hidden is the inverse of visible
  if (mapId === curMap) w.setObjectHidden?.(name, !visible);
}

function* hide_object(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  toggleObject(ctx, args, false);
}

function* show_object(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  toggleObject(ctx, args, true);
}

function* face_object(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  (ctx.world as any).faceObject?.(args[0], (args[1] as string) ?? "down");
}

function* move_npc_to(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  (ctx.world as any).moveNpcTo?.(args[0], args[1] as number, args[2] as number,
    () => runner.resume());
  yield;
}

function* pic(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  ctx.world.showPic(
    args[0] as number, args[1] as number, args[2] as number,
    args[3] as number, args[4] as number,
  );
}

function* pic_hide(ctx: ScriptContext): Generator<void, void> {
  ctx.world.hidePic();
}

// host.stamp — toggle a cooked map decoration by cell. Args:
// [mapId, cx, cy, on]. The S.S. Anne sailing-off animation (mapscripts.ts
// VERMILION_DOCK) drives this directly; use_cut below is the other caller.
function* stamp(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  ctx.world.stamp(
    args[0] as number,
    args[1] as number,
    args[2] as number,
    args[3] !== false,
  );
}

// HM CUT's field effect (voxelmon/game/ui/partyscreen.ts's field-move
// submenu entry runs this via VoxelmonGame.overworld.runScript). Checks the
// cell the player faces against the cook-time cuttableCells marker
// (voxelmon/cook/structures.ts); a cell already chopped this save
// (save.cutTrees) reads the same as never having had a tree there, matching
// pokered leaving a plain path behind. args: [monName] — the moving
// pokémon's name for _UsedCutText's {RAM:wNameBuffer} slot.
function* use_cut(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const w = ctx.world;
  const runner = ctx.runner;
  const monName = (args[0] as string) ?? "";
  const [fx, fy] = w.player.facingCell();
  const key = `${fx},${fy}`;
  const already = w.save.cutTrees?.[w.map.id]?.[key];
  if (w.map.isCuttableCell(fx, fy) && !already) {
    // pokered AnimateCutTree: the cut-tree sprite flickers over the tree for
    // four on/off beats before the block changes. The sprite sits on the
    // emote page (cook/atlas.ts buildEmotePage) and is drawn by the fieldFx
    // op; the timing lives here rather than in the host, so the host has no
    // animation state to keep.
    const cx = Math.round((fx * CELL_PX + CELL_PX / 2) * Q4);
    const cz = Math.round((fy * CELL_PX + CELL_PX / 2) * Q4);
    for (let beat = 0; beat < CUT_ANIM_BEATS; beat++) {
      w.fieldFx(cx, cz, beat % 2 === 0 ? FX_FRAME_CUT_TREE : -1);
      runner.waitingFrames = CUT_ANIM_BEAT_FRAMES;
      yield;
    }
    w.fieldFx(0, 0, -1);
    w.stamp(w.map.def.index, fx, fy, false);
    // Hiding the stamp only removes the geometry; the block is still a tree,
    // so the cell has to be opened up as well or the tree disappears and the
    // player still cannot walk through it.
    (w.map as unknown as { markCut?: (x: number, y: number) => void }).markCut?.(fx, fy);
    w.save.cutTrees ??= {};
    w.save.cutTrees[w.map.id] ??= {};
    w.save.cutTrees[w.map.id][key] = true;
    w.showText(scriptText(w, "_UsedCutText", { "RAM:wNameBuffer": monName }), () => runner.resume());
  } else {
    w.showText(scriptText(w, "_NothingToCutText"), () => runner.resume());
  }
  yield;
}

// HM FLASH's field effect: lifts the dark-cave dimming (OverworldShell's
// DARK_MAPS / world/overworld.ts setMap) for the rest of this visit.
// pokered lets Flash fire anywhere — harmless outside a dark cave, since
// tint there is already full brightness — so no facing/location check.
function* use_flash(ctx: ScriptContext): Generator<void, void> {
  const w = ctx.world;
  const runner = ctx.runner;
  w.tint(0xffff_ffff);
  w.showText(scriptText(w, "_FlashLightsAreaText"), () => runner.resume());
  yield;
}

// Commands.lua:852 open_mart — the clerk's mart list (entry.mart) opens the
// ShopMenu and the runner yields until QUIT resumes it, exactly like
// start_battle. Stock is resolved from the current map + text const.
function* open_mart(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  const w = ctx.world as unknown as {
    map?: { id: string };
    openShop?: (stock: string[], onQuit: () => void) => void;
  };
  const stock = martStock(w.map?.id ?? "", String(args[0] ?? ""));
  if (stock && w.openShop) {
    w.openShop(stock, () => runner.resume());
    yield;
  }
}

// Commands.lua check_item (item_bag.asm IsItemInBag): lastCheck = the bag
// holds at least one of the id. Gates OaksLabOak1Text's parcel/poke-ball
// branches (oaks_lab.lua).
function* check_item(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const inv = (ctx.world.save as { inventory?: Record<string, number> }).inventory ?? {};
  ctx.lastCheck = (inv[args[0] as string] ?? 0) > 0;
}

// Commands.lua take_item (Bag.remove): drop qty (default 1) of an id, the
// parcel hand-off in oaks_lab.lua's got_parcel branch.
function* take_item(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  Bag.remove(ctx.world.save, args[0] as string, (args[1] as number | undefined) ?? 1);
}

// Commands.lua clear_flag (Flags.clear) — the counterpart to set_flag;
// delete so a later check_flag reads false (oaks_lab.lua arms the Route 22
// rematch by clearing EVENT_2ND_ROUTE22_RIVAL_BATTLE).
function* clear_flag(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  delete ctx.world.save.flags[args[0] as string];
}

// Commands.lua check_dex_owned (pokedex_own count): lastCheck = owned-species
// count >= N. OaksLabOak1Text's dex-rating gate (#600). save.pokedex.owned is
// outside ScriptSave, so read it defensively.
function* check_dex_owned(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const need = (args[0] as number | undefined) ?? 1;
  const owned =
    (ctx.world.save as { pokedex?: { owned?: Record<string, boolean> } }).pokedex?.owned ?? {};
  let n = 0;
  for (const k in owned) if (owned[k]) n += 1;
  ctx.lastCheck = n >= need;
}

// Commands.lua dex_rating (DisplayDexRating, engine/events/pokedex_rating.asm):
// the seen/owned tally Oak reads out. No rating UI in the slice, so this is an
// honest no-op like push_screen — the rows around it still run.
function* dex_rating(): Generator<void, void> {}

// Commands.lua:895 rival_battle — the rival's team counters your starter:
// party = baseParty + offset, offset from data.field.starterCounterpicks
// (else the CHOSE_* fallback: Squirtle +1, Bulbasaur +2, Charmander +0),
// then hand off to start_battle so the win result still lands in
// ctx.lastCheck for the scene's jump_if_false.
function* rival_battle(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const oppClass = args[0] as string;
  const baseParty = (args[1] as number | undefined) ?? 1;
  // 3rd arg is an options object: { offsets?, loseable? }. loseable marks the
  // early Route 22 rival as heal-and-continue on a loss.
  const opts =
    (args[2] as { offsets?: Record<string, number>; loseable?: boolean } | undefined) ?? {};
  const save = ctx.world.save as { flags: Record<string, boolean> };
  const offsets =
    opts.offsets ??
    ((ctx.world.data as { field?: { starterCounterpicks?: Record<string, number> } }).field
      ?.starterCounterpicks);
  let offset = 0;
  if (offsets) {
    for (const [flag, mapped] of Object.entries(offsets)) {
      if (save.flags?.[flag]) {
        offset = mapped;
        break;
      }
    }
  } else if (save.flags?.EVENT_CHOSE_SQUIRTLE) {
    offset = 1;
  } else if (save.flags?.EVENT_CHOSE_BULBASAUR) {
    offset = 2;
  }
  yield* start_battle(ctx, "trainer", oppClass, baseParty + offset, { loseable: opts.loseable });
}

// Commands.lua:1061 walk_npc — chained scriptMove along an explicit direction
// list (a scripted exit walk); blocks until the last step lands. ref "player"
// or an object name/sprite.
function* walk_npc(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  const w = ctx.world as unknown as {
    player: { moving: boolean };
    findNpc?: (ref: unknown) => { moving: boolean } | null;
    scriptMove: (e: { moving: boolean }, dir: Dir, n: number, onDone?: () => void) => void;
  };
  const ref = args[0];
  const dirs = (args[1] as Dir[] | undefined) ?? [];
  const entity = ref === "player" ? w.player : w.findNpc?.(ref);
  if (!entity || dirs.length === 0) return;
  let i = 0;
  const step = () => {
    if (i >= dirs.length) {
      runner.resume();
      return;
    }
    w.scriptMove(entity, dirs[i++], 1, step);
  };
  step();
  yield;
}

// story2.lua engageSuperNerd -> ow:engageTrainer: force a trainer object's
// battle (no sight line), blocking until it resolves. No-op if already beaten.
function* engage_trainer(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  const w = ctx.world as unknown as {
    findNpc?: (ref: unknown) => any;
    trainerDefeated?: (npc: any) => boolean;
    engageTrainer?: (npc: any, onDone?: () => void) => void;
  };
  const npc = w.findNpc?.(args[0]);
  // lastCheck reports whether the trainer STANDS defeated afterwards, so a
  // script can gate its aftermath on the win the way pokered's text_asm does
  // (Rocket Hideout B4F only drops the LIFT KEY once its grunt is beaten).
  // An already-beaten trainer is a no-op that still reports true — that is
  // the reprint path, not a failure.
  if (!npc || !w.engageTrainer) { ctx.lastCheck = false; return; }
  if (w.trainerDefeated?.(npc)) { ctx.lastCheck = true; return; }
  w.engageTrainer(npc, () => {
    ctx.lastCheck = w.trainerDefeated?.(npc) === true;
    runner.resume();
  });
  yield;
}

// A heal point sets where a blackout warps you (pokered wLastBlackoutMap):
// the last Pokémon Center you healed at. Recorded at the spot you healed from.
function* set_heal_point(ctx: ScriptContext): Generator<void, void> {
  const w = ctx.world as any;
  const p = w.player;
  const save = ctx.world.save as {
    lastHeal?: {
      map: string;
      x: number;
      y: number;
      outdoor?: { id: string; x: number; y: number };
    };
    lastOutdoor?: { id: string; x: number; y: number };
  };
  save.lastHeal = {
    map: String(w.map?.id ?? ""),
    x: (p?.cellX as number) ?? 0,
    y: (p?.cellY as number) ?? 0,
    // The PC door is a LAST_MAP warp — remember the outdoor map it exits to
    // (the town you walked in from) so a blackout warp restores the right
    // return. Without it, leaving the PC uses a stale lastOutdoor and drops
    // you at the wrong exit (e.g. Diglett's Cave instead of Viridian City).
    outdoor: save.lastOutdoor ? { ...save.lastOutdoor } : undefined,
  };
}

// gen1recomp Commands.lua:807-823 old_man_demo: the Viridian catch tutorial's
// BATTLE_TYPE_OLD_MAN wild battle — the old man throws one POKé BALL at a wild
// WEEDLE and nothing is kept. Hands off to the shell like start_battle and
// blocks until the demo battle finishes (battle.onFinish -> runner.resume).
// The demo battle engine is staged separately; until it lands, startOldManDemo
// is absent and the tutorial dialogue simply continues past the demo.
function* old_man_demo(ctx: ScriptContext): Generator<void, void> {
  const runner = ctx.runner;
  const w = ctx.world as any;
  if (typeof w.startOldManDemo === "function") {
    w.startOldManDemo(() => runner.resume());
    yield;
  }
}

const VERBS: Record<string, Verb> = {
  show_text,
  ask,
  jump,
  jump_if_true,
  jump_if_false,
  label,
  face_player,
  check_flag,
  set_flag,
  give_item,
  warp,
  wait,
  move_player,
  heal_party,
  play_once,
  fade,
  emote,
  pic,
  pic_hide,
  stamp,
  use_cut,
  use_flash,
  give_pokemon,
  hide_object,
  show_object,
  face_object,
  move_npc_to,
  place_npc,
  move_player_to,
  start_battle,
  open_mart,
  walk_route,
  check_item,
  take_item,
  clear_flag,
  check_dex_owned,
  dex_rating,
  rival_battle,
  walk_npc,
  engage_trainer,
  set_heal_point,
  old_man_demo,
  push_screen: noop_object,
  play_sound: noop_audio,
  play_music: noop_audio,
  stop_music: noop_audio,
};

/** ScriptRunner.lua:26 scanLabels — first row wins, 1-based like the Lua. */
function scanLabels(script: ScriptRow[]): Map<string, number> {
  const labels = new Map<string, number>();
  script.forEach((row, i) => {
    if (row[0] === "label" && typeof row[1] === "string" && !labels.has(row[1])) {
      labels.set(row[1], i + 1);
    }
  });
  return labels;
}

export class ScriptRunner {
  private co: Generator<void, void> | null = null;
  waitingFrames: number | null = null;
  ctx: ScriptContext | null = null;
  private resuming = false;
  private world: ScriptWorld;

  constructor(world: ScriptWorld) {
    this.world = world;
  }

  // ScriptRunner.lua:101
  isRunning(): boolean {
    return this.co !== null;
  }

  // ScriptRunner.lua:119 run
  run(script: ScriptRow[], extra?: { npc?: NPC; onDone?: () => void }): void {
    if (this.isRunning()) throw new Error("script already running");
    const ctx: ScriptContext = { world: this.world, runner: this, ...extra };
    this.ctx = ctx;
    this.co = this.exec(script, ctx);
    this.resume();
  }

  // ScriptRunner.lua:143 exec — a command list whose verbs return a jump
  // target: a row number (1-based like the Lua), a label name, "end" to halt,
  // or nothing to fall through.
  private *exec(script: ScriptRow[], ctx: ScriptContext): Generator<void, void> {
    const labels = scanLabels(script);
    let pc = 1;
    while (pc <= script.length) {
      const row = script[pc - 1];
      const name = row[0];
      const fn = VERBS[name];
      if (!fn) {
        // v1 skip: old content degrades instead of dying, but never in
        // silence — ScriptRunner.lua:158 logs the row it dropped.
        console.warn(`script: unknown command '${name}' (skipped)`);
        pc += 1;
        continue;
      }
      const jump = yield* fn(ctx, ...row.slice(1));
      if (typeof jump === "number") {
        pc = jump;
      } else if (typeof jump === "string") {
        if (jump === "end") break;
        const target = labels.get(jump);
        if (target === undefined) throw new Error(`jump to missing label '${jump}' at row ${pc}`);
        pc = target;
      } else {
        pc += 1;
      }
    }
    const done = ctx.onDone;
    if (done) done();
  }

  // ScriptRunner.lua:197 resume — advance the parked generator; a finished
  // generator frees the runner.
  resume(): void {
    const co = this.co;
    if (!co) return;
    // ScriptRunner.lua:199-207: a completion callback can fire SYNCHRONOUSLY
    // from inside the running generator (a text box that closes on the tick
    // it opened, a warp whose destination is locked). Re-entering it would
    // throw and kill the script, so land the pending yield and continue on
    // the next update tick instead.
    if (this.resuming) {
      this.waitingFrames = 1;
      return;
    }
    this.resuming = true;
    let r: IteratorResult<void, void>;
    try {
      r = co.next();
    } finally {
      this.resuming = false;
    }
    if (r.done) {
      if (this.co === co) {
        this.co = null;
        this.waitingFrames = null;
      }
    }
  }

  // ScriptRunner.lua:233 update — frame waits re-resume every step.
  update(): void {
    if (this.isRunning() && this.waitingFrames !== null) {
      this.waitingFrames -= 1;
      if (this.waitingFrames <= 0) {
        this.waitingFrames = null;
        this.resume();
      }
    }
  }
}
