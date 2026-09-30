// `callasm` / `memcall` / `memcallasm` / `memjump`: the four script commands
// whose operand is not bytecode.
//
// Port of gen1recomp src/script/gen2/CallAsm.lua at bdfac727 (MIT).
//
// Script_callasm (engine/overworld/scripting.asm) `rst FarCall`s a far
// pointer as raw Game Boy code; no interpreter can run it, so each target
// routine needs a hand port, and this file is where they live.  Dispatch is
// BY ADDRESS: SITES maps the `bank:addr` pair (resolved against
// pokegold-symbols/pokegold.sym) onto a routine name, HANDLERS maps the name
// onto the port.
//
// wScriptVar: Script_callasm never touches it; only the TARGET routine does.
// A handler returns a byte only when its asm ends in `ld [wScriptVar], a`,
// and nil otherwise ("leave it alone").
//
// Nothing in the extracted cache reaches these (every row the extractor once
// found was mis-walked `hiddenitem` data); the real sites are engine scripts
// the port reaches through its hand-ported world flows, which is why
// CallAsm.run is a public entry beside CallAsm.dispatch.
//
// A handler takes the World (or anything shaped like it) as `ctx` and calls
// back into the module that already owns the behaviour.

import { format, mod, sortedKeys, tonumber, truthy } from "../platform/lua.ts";
import { Phone } from "../core/Phone.ts";
import { CallerBox } from "../ui/CallerBox.ts";
import { FieldMoves } from "../world/FieldMoves.ts";
import { Map as GbMap } from "../world/Map.ts";
import { StepEvents } from "../world/StepEvents.ts";

type Handler = (ctx: any) => number | undefined | null;

// ---- the site table ---------------------------------------------------------
//
// Every `callasm` / `memcall` / `memcallasm` / `memjump` operand in the cart,
// resolved against pokegold-symbols/pokegold.sym.  Lua: CallAsm.lua:57
const SITES: Record<string, string> = {
  // engine/overworld/scripting.asm: GiveItemScript's opening no-op.
  "25:6e71": "GiveItemScript_DummyFunction",
  // engine/overworld/events.asm
  "04:6994": "StartMenu",
  "04:76e9": "SelectMenu",
  "05:7312": "OverworldHatchEgg",
  "25:664f": "EnableWildEncounters",
  // engine/phone/phone.asm and engine/events/mom_phone.asm.
  "24:4277": "RingTwice_StartCall",
  "24:42df": "HangUp",
  "04:5800": "InitCallReceiveDelay",
  "24:4264": "LoadBillScript",
  "24:4272": "LoadElmScript",
  "3f:4db2": "MomTriesToBuySomething_ASMFunction",
  // engine/items/itemfinder.asm.
  "04:6960": "ItemfinderSound",
  // engine/events/fruit_trees.asm.
  "11:4041": "GetCurTreeFruit",
  "11:404c": "TryResetFruitTrees",
  "11:4055": "CheckFruitTree",
  "11:405f": "PickedFruitTree",
  // engine/events/sweet_scent.asm.
  "14:4725": "SweetScentEncounter",
  // engine/events/trainer_scripts.asm.
  "02:490e": "TrainerWalkToPlayer",
  // engine/events/squirtbottle.asm.
  "14:4786": "CheckCanUseSquirtbottle",
  // engine/events/hidden_item.asm.
  "04:7a11": "SetMemEvent",
  // engine/events/poisonstep.asm.
  "14:468e": "PlayPoisonSFX",
  "14:46b1": "CheckWhitedOut",
  // engine/events/whiteout.asm.
  "04:68c7": "OverworldBGMap",
  "04:68d7": "BattleBGMap",
  "04:68e0": "HalveMoney",
  "04:68ee": "GetWhiteoutSpawn",
  // engine/events/overworld.asm: the field moves.
  "03:474b": "GetPartyNickname",
  "03:4855": "CutDownTreeOrGrass",
  "23:4a6b": "BlindingFlash",
  "00:310a": "HideSprites",
  "23:4d65": "FlyFromAnim",
  "05:560c": "SkipUpdateMapSprites",
  "23:4dab": "FlyToAnim",
  "05:415c": "LoadWalkingSpritesGFX",
  "03:4b49": "CheckContinueWaterfall",
  "03:4d15": "SetStrengthFlag",
  "03:4d7b": "TryStrengthOW",
  "03:4e20": "DisappearWhirlpool",
  "23:4a8e": "ShakeHeadbuttTree",
  "03:4f7f": "HasRockSmash",
  "03:5096": "PutTheRodAway",
  "03:506d": "Fishing_CheckFacingUp",
  "14:454f": "LoadFishingGFX",
  "03:51c7": "AskCutScript_CheckMap",
  // engine/events/treemons.asm.
  "2e:6378": "TreeMonEncounter",
  "2e:63a1": "RockMonEncounter",
  // engine/events/misc_scripts.asm.
  "04:66d1": "TryReceiveItem",
};

// pokegold-symbols/pokesilver.sym: bank $03 sits two bytes earlier in Silver.
// Lua: CallAsm.lua:124
const SITES_SILVER: Record<string, string> = {
  "03:4749": "GetPartyNickname",
  "03:4853": "CutDownTreeOrGrass",
  "03:4b47": "CheckContinueWaterfall",
  "03:4d13": "SetStrengthFlag",
  "03:4d79": "TryStrengthOW",
  "03:4e1e": "DisappearWhirlpool",
  "03:4f7d": "HasRockSmash",
  "03:5094": "PutTheRodAway",
  "03:506b": "Fishing_CheckFacingUp",
  "03:51c5": "AskCutScript_CheckMap",
};

// pokecrystal-symbols/pokecrystal.sym: Crystal's own addresses for the same
// sites.  Lua: CallAsm.lua:138
const SITES_CRYSTAL: Record<string, string> = {
  "25:6f76": "GiveItemScript_DummyFunction",
  "04:65cd": "StartMenu",
  "04:7327": "SelectMenu",
  "05:6f5e": "OverworldHatchEgg",
  "25:6706": "EnableWildEncounters",
  "24:426f": "RingTwice_StartCall",
  "24:42eb": "HangUp",
  "04:53e5": "InitCallReceiveDelay",
  "24:425c": "LoadBillScript",
  "24:426a": "LoadElmScript",
  "3f:5017": "MomTriesToBuySomething_ASMFunction",
  "04:6599": "ItemfinderSound",
  "14:46ef": "SweetScentEncounter",
  "02:431e": "TrainerWalkToPlayer",
  "14:4753": "CheckCanUseSquirtbottle",
  "04:764f": "SetMemEvent",
  "14:4658": "PlayPoisonSFX",
  "14:467b": "CheckWhitedOut",
  "04:64fa": "OverworldBGMap",
  "04:650a": "BattleBGMap",
  "04:6513": "HalveMoney",
  "04:6527": "GetWhiteoutSpawn",
  "03:4706": "GetPartyNickname",
  "03:4810": "CutDownTreeOrGrass",
  "23:47e1": "BlindingFlash",
  "00:3016": "HideSprites",
  "23:4aed": "FlyFromAnim",
  "05:54f1": "SkipUpdateMapSprites",
  "23:4b33": "FlyToAnim",
  "05:4157": "LoadWalkingSpritesGFX",
  "03:4b38": "CheckContinueWaterfall",
  "03:4d12": "SetStrengthFlag",
  "03:4d78": "TryStrengthOW",
  "03:4e1d": "DisappearWhirlpool",
  "23:480a": "ShakeHeadbuttTree",
  "03:4f7c": "HasRockSmash",
  "03:5095": "PutTheRodAway",
  "03:506c": "Fishing_CheckFacingUp",
  "2e:44b3": "LoadFishingGFX",
  "03:51ba": "AskCutScript_CheckMap",
  "2e:41ea": "TreeMonEncounter",
  "2e:4219": "RockMonEncounter",
  // maps/BattleTowerHallway.asm:23-32
  "27:75cb": "BattleTowerHallwayChooseBattleRoomScript.asm_load_battle_room",
  "04:62f8": "TryReceiveItem",
};

// The three WRAM addresses `memcall` / `memcallasm` / `memjump` take instead
// of a routine: written at run time, nothing static to resolve.
// Lua: CallAsm.lua:191
const MEM_OPERANDS: Record<string, string> = {
  "00:cfd8": "wQueuedScriptBank",
  "00:ceed": "wPhoneScriptBank",
  "00:cf2a": "wCallerContact",
};

// ---- constants ----------------------------------------------------------------

// constants/map_object_constants.asm.  Lua: CallAsm.lua:201
const SPRITEMOVEDATA_SUDOWOODO = 0x17;

// constants/sfx_constants.asm, resolved by LABEL at call time; the numbers
// are only the fallback.  Lua: CallAsm.lua:206
const SFX_POISON: [string, number] = ["Sfx_Poison", 11];
const SFX_SECOND_PART_OF_ITEMFINDER: [string, number] = ["Sfx_SecondPartOfItemfinder", 18];
const SFX_TRANSACTION: [string, number] = ["Sfx_Transaction", 34];
const SFX_CALL: [string, number] = ["Sfx_Call", 106];

// ItemFinder.ItemfinderSound's `ld c, 4`.  Lua: CallAsm.lua:212
const ITEMFINDER_SFX_LOOPS = 4;

// data/maps/spawn_points.asm: GetWhiteoutSpawn's fallback.  Lua: CallAsm.lua:216
const SPAWN_HOME = "SPAWN_HOME";

// ---- ctx plumbing ---------------------------------------------------------------

// A handler talks to the World through its own methods, each optional (a
// headless test hands in a table with two of them).  Lua: CallAsm.lua:224
function call(ctx: any, name: string, ...args: any[]): any {
  const fn = ctx ? ctx[name] : undefined;
  if (typeof fn !== "function") return undefined;
  return ctx[name](...args);
}

// Lua: CallAsm.lua:230
function saveOf(ctx: any): any {
  return (ctx && ctx.game && ctx.game.save) || undefined;
}

// ---- the phone's caller-ID box ---------------------------------------------------
//
// Phone_TextboxWithName is the one routine here that DRAWS: the box is a
// state on the StateStack, pushed under the call's text pages; a no-op
// without a stack.  Lua: CallAsm.lua:246
const CALLER_BOX = "gen2CallerBox";

// Lua: CallAsm.lua:248
function stackOf(ctx: any): any {
  return (ctx && ctx.game && ctx.game.stack) || undefined;
}

// GetCallerClassAndName reads wCurCaller (engine/phone/phone.asm:471-475);
// vm.curPhoneCaller is this port's wCurCaller.  Lua: CallAsm.lua:257
function showCallerBox(ctx: any): void {
  const stack = stackOf(ctx);
  if (!stack) return;
  for (const state of stack.states ?? []) {
    if (state[CALLER_BOX]) return;
  }
  const contact = (ctx.vm && ctx.vm.curPhoneCaller) ?? 0;
  const data = ctx.game && ctx.game.data;
  // Phone.contactName answers (name, className): a pair in the port.
  const answer = Phone.contactName(contact, data && data.trainers);
  const [name, className] = Array.isArray(answer) ? answer : [answer, undefined];
  const box = CallerBox.new(name, className);
  box[CALLER_BOX] = true;
  stack.push(box);
}

// The box comes off by identity; StateStack:pop when it is the top so `exit`
// fires as for every other screen.  Lua: CallAsm.lua:280
function hideCallerBox(ctx: any): void {
  const stack = stackOf(ctx);
  const states = stack && stack.states;
  if (!states) return;
  for (let index = states.length - 1; index >= 0; index--) {
    if (states[index][CALLER_BOX]) {
      if (index === states.length - 1) {
        stack.pop();
      } else {
        states.splice(index, 1);
      }
      return;
    }
  }
}

const H: Record<string, Handler> = {};

// ---- engine/overworld/scripting.asm ------------------------------------------

// GiveItemScript_DummyFunction is one `ret`.  Lua: CallAsm.lua:303
H.GiveItemScript_DummyFunction = () => undefined;

// ---- engine/overworld/events.asm ---------------------------------------------

// SelectMenuScript's `callasm SelectMenu` reaches UseRegisteredItem
// (engine/overworld/select_menu.asm), which is World:useSelectItem.
// Lua: CallAsm.lua:314
H.SelectMenu = (ctx) => {
  call(ctx, "useSelectItem");
  return undefined;
};

// HatchEggScript is `callasm OverworldHatchEgg / end`; World:hatchEggs is
// HatchEggs (engine/pokemon/breeding.asm).  Lua: CallAsm.lua:322
H.OverworldHatchEgg = (ctx) => {
  call(ctx, "hatchEggs");
  return undefined;
};

// ---- engine/phone/phone.asm and engine/overworld/time.asm ----------------------

// RingTwice_StartCall: SFX_CALL and the caller-ID box
// (engine/phone/phone.asm:466, :474, :582); idempotent, since
// Script_ReceivePhoneCall rings TWICE.  Lua: CallAsm.lua:346
H.RingTwice_StartCall = (ctx) => {
  call(ctx, "playSfxNamed", SFX_CALL[0], SFX_CALL[1]);
  showCallerBox(ctx);
  return undefined;
};

// InitCallReceiveDelay (engine/overworld/time.asm): the caller-ID box comes
// down here (Script_ReceivePhoneCall's LAST row, engine/phone/phone.asm:431-438),
// then the receive countdown restarts.  Lua: CallAsm.lua:357
H.InitCallReceiveDelay = (ctx) => {
  hideCallerBox(ctx);
  const save = saveOf(ctx);
  if (!save) return undefined;
  const step = call(ctx, "stepContext");
  Phone.initReceiveDelay(save, step && step.phone);
  return undefined;
};

// ---- engine/items/itemfinder.asm ---------------------------------------------

// .ItemfinderSound: four rounds of SFX_SECOND_PART_OF_ITEMFINDER then
// SFX_TRANSACTION, back to back.  Lua: CallAsm.lua:377
H.ItemfinderSound = (ctx) => {
  for (let i = 1; i <= ITEMFINDER_SFX_LOOPS; i++) {
    call(ctx, "playSfxNamed", SFX_SECOND_PART_OF_ITEMFINDER[0],
      SFX_SECOND_PART_OF_ITEMFINDER[1]);
    call(ctx, "playSfxNamed", SFX_TRANSACTION[0], SFX_TRANSACTION[1]);
  }
  return undefined;
};

// ---- engine/events/fruit_trees.asm -------------------------------------------
//
// All four read wCurFruitTree, which is `ctx.curFruitTree`.

// GetCurTreeFruit: FruitTreeItems[wCurFruitTree - 1] -> wCurFruit; the hook
// already undoes the 1-based offset.  Lua: CallAsm.lua:395
H.GetCurTreeFruit = (ctx) => {
  const tree = (ctx && ctx.curFruitTree) ?? 0;
  const fruit = call(ctx, "fruitTreeItem", tree);
  ctx.curFruit = truthy(fruit) ? fruit : 0;
  return undefined;
};

// TryResetFruitTrees: gated on DAILYFLAGS1_ALL_FRUIT_TREES.  Lua: CallAsm.lua:403
H.TryResetFruitTrees = (ctx) => {
  call(ctx, "fruitTreeReset");
  return undefined;
};

// CheckFruitTree: CHECK_FLAG over wFruitTreeFlags into wScriptVar; the flag
// means "already picked".  Lua: CallAsm.lua:412
H.CheckFruitTree = (ctx) => {
  const tree = (ctx && ctx.curFruitTree) ?? 0;
  return truthy(call(ctx, "fruitTreePicked", tree)) ? 1 : 0;
};

// PickedFruitTree: SET_FLAG, no wScriptVar.  Lua: CallAsm.lua:418
H.PickedFruitTree = (ctx) => {
  const tree = (ctx && ctx.curFruitTree) ?? 0;
  call(ctx, "fruitTreePick", tree);
  return undefined;
};

// ---- engine/events/overworld.asm ---------------------------------------------

// GetPartyNickname: wCurPartyMon's nickname into the string buffer
// (`ctx.curPartyMon`, else the lead).  Lua: CallAsm.lua:430
H.GetPartyNickname = (ctx) => {
  let mon = ctx && ctx.curPartyMon;
  if (!mon) {
    const save = saveOf(ctx);
    mon = (save && save.party && save.party[0]) || undefined;
  }
  call(ctx, "setNickname", mon);
  return undefined;
};

// CutDownTreeOrGrass: World:replaceBlock over the cut block index.
// Lua: CallAsm.lua:448
H.CutDownTreeOrGrass = (ctx) => {
  const index = ctx && ctx.cutWhirlpoolBlockIndex;
  const blockId = ctx && ctx.cutWhirlpoolReplacement;
  if (index != null && blockId != null) call(ctx, "replaceBlock", index, blockId);
  return undefined;
};

// DisappearWhirlpool: CutDownTreeOrGrass with PlayWhirlpoolSound first
// -- engine/events/overworld.asm:1157-1164 (#1717, #1862).  Lua: CallAsm.lua:458
H.DisappearWhirlpool = (ctx) => {
  const index = ctx && ctx.cutWhirlpoolBlockIndex;
  const blockId = ctx && ctx.cutWhirlpoolReplacement;
  call(ctx, "playWhirlpoolSound", index, blockId);
  return undefined;
};

// BlindingFlash sets STATUSFLAGS_FLASH_F and reloads the palettes.
// Lua: CallAsm.lua:469
H.BlindingFlash = (ctx) => {
  if (!ctx) return undefined;
  ctx.flashUsed = true;
  if (truthy(call(ctx, "applyPalettes"))) call(ctx, "refreshMapImages");
  return undefined;
};

// .CheckContinueWaterfall: TRUE when the tile climbed onto is another
// waterfall tile.  Lua: CallAsm.lua:479
H.CheckContinueWaterfall = (ctx) => {
  const coll = call(ctx, "playerCollision");
  return truthy(FieldMoves.waterfallContinues(coll)) ? 1 : 0;
};

// SetStrengthFlag: BIKEFLAGS_STRENGTH_ACTIVE, wStrengthSpecies, then a tail
// call into GetPartyNickname.  Lua: CallAsm.lua:488
H.SetStrengthFlag = (ctx) => {
  ctx.strengthActive = true;
  const mon = ctx && ctx.curPartyMon;
  if (mon) ctx.strengthSpecies = mon.species;
  return H.GetPartyNickname!(ctx);
};

// TryStrengthOW's three answers (note the cart's inversion):
//   0  STRENGTH is already active
//   1  no mon knows it, or no PLAINBADGE
//   2  it may be switched on right now
// Lua: CallAsm.lua:501
H.TryStrengthOW = (ctx) => {
  const fieldCtx = call(ctx, "fieldContext");
  if (!fieldCtx) return 1;
  const result = FieldMoves.tryStrengthOW(fieldCtx);
  if (result.ok) return 2;
  if (fieldCtx.strengthActive) return 0;
  return 1;
};

// .CheckMap inside AskCutScript: CheckMapForSomethingToCut inverted into
// wScriptVar.  Lua: CallAsm.lua:514
H.AskCutScript_CheckMap = (ctx) => {
  const fieldCtx = call(ctx, "fieldContext");
  if (!fieldCtx) return 0;
  return truthy(FieldMoves.somethingToCut(fieldCtx)) ? 1 : 0;
};

// HasRockSmash is INVERTED: 1 when the party does NOT know ROCK SMASH.
// Lua: CallAsm.lua:525
H.HasRockSmash = (ctx) => {
  const mon = call(ctx, "partyMoveUser", "ROCK_SMASH");
  if (mon) {
    // engine/events/overworld.asm:1339
    ctx.curPartyMon = mon;
    return 0;
  }
  return 1;
};

// PutTheRodAway: wPlayerAction back to PLAYER_NORMAL (World's `fishing`
// state dropped).  Lua: CallAsm.lua:541
H.PutTheRodAway = (ctx) => {
  if (ctx) ctx.fishing = undefined;
  return undefined;
};

// Fishing_CheckFacingUp: `and $c / cp OW_UP`.  Lua: CallAsm.lua:548
H.Fishing_CheckFacingUp = (ctx) => {
  const player = ctx && ctx.player;
  return (player && player.facing === "up") ? 1 : 0;
};

// ---- engine/events/treemons.asm -----------------------------------------------

// TreeMonEncounter: World:tryHeadbutt fuses the roll with the startbattle,
// so "battle" is the 1.  Lua: CallAsm.lua:564
H.TreeMonEncounter = (ctx) => {
  const cell = ctx && ctx.curHeadbuttCell;
  if (!cell) return 0;
  return call(ctx, "tryHeadbutt", cell[0], cell[1]) === "battle" ? 1 : 0;
};

// RockMonEncounter writes NO wScriptVar (RockSmashScript reads
// wTempWildMonSpecies back with readmem).  Lua: CallAsm.lua:577
H.RockMonEncounter = (ctx) => {
  call(ctx, "rockMonEncounter");
  return undefined;
};

// ---- engine/events/sweet_scent.asm --------------------------------------------

// SweetScentEncounter: World:sweetScentEncounter.  Lua: CallAsm.lua:587
H.SweetScentEncounter = (ctx) => {
  return truthy(call(ctx, "sweetScentEncounter")) ? 1 : 0;
};

// ---- engine/events/trainer_scripts.asm ----------------------------------------

// TrainerWalkToPlayer: the World owns the path.  No wScriptVar.
// Lua: CallAsm.lua:596
H.TrainerWalkToPlayer = (ctx) => {
  call(ctx, "trainerApproach");
  return undefined;
};

// ---- engine/events/squirtbottle.asm -------------------------------------------

// .CheckCanUseSquirtbottle: Route 36, facing an object with
// SPRITEMOVEDATA_SUDOWOODO.  Lua: CallAsm.lua:606
H.CheckCanUseSquirtbottle = (ctx) => {
  const map = ctx && ctx.map;
  if (!(map && map.id === "ROUTE_36")) return 0;
  const player = ctx.player;
  if (!player) return 0;
  const delta = GbMap.DELTA[player.facing ?? "down"] ?? GbMap.DELTA.down!;
  const npc = call(ctx, "npcAt", player.cellX + delta[0], player.cellY + delta[1]);
  const def = npc && npc.def;
  if (def && def.movement === SPRITEMOVEDATA_SUDOWOODO) return 1;
  return 0;
};

// ---- engine/events/hidden_item.asm --------------------------------------------

// SetMemEvent: the flag number in wHiddenItemEvent, set AFTER the giveitem.
// Lua: CallAsm.lua:627
H.SetMemEvent = (ctx) => {
  const flag = ctx && ctx.hiddenItemEvent;
  if (flag != null && ctx.events) ctx.events.set(flag, true);
  return undefined;
};

// ---- engine/events/poisonstep.asm ---------------------------------------------

// .PlayPoisonSFX: SFX_POISON then LoadPoisonBGPals.
// engine/events/poisonstep.asm:101.  Lua: CallAsm.lua:637
H.PlayPoisonSFX = (ctx) => {
  call(ctx, "playSfxNamed", SFX_POISON[0], SFX_POISON[1]);
  call(ctx, "poisonBGFlash");
  return undefined;
};

// .CheckWhitedOut ends on CheckPlayerPartyForFitMon; `iffalse .whiteout`
// reads "no fit mon".  Lua: CallAsm.lua:651
H.CheckWhitedOut = (ctx) => {
  const save = saveOf(ctx);
  const party = (save && save.party) || [];
  return truthy(StepEvents.whitedOut(party)) ? 0 : 1;
};

// ---- engine/events/whiteout.asm -----------------------------------------------

// HalveMoney: the 24-bit wallet shifted right one bit (floor division); Mom's
// savings are untouched.  Lua: CallAsm.lua:665
H.HalveMoney = (ctx) => {
  const save = saveOf(ctx);
  const player = save && save.player;
  if (!player) return undefined;
  player.money = Math.floor((player.money ?? 0) / 2);
  return undefined;
};

// GetWhiteoutSpawn validates the blackoutmod pair against SpawnPoints and
// falls back to SPAWN_HOME; left on the ctx, not yet consumed.
// Lua: CallAsm.lua:682
H.GetWhiteoutSpawn = (ctx) => {
  const save = saveOf(ctx);
  const override = save && save.blackoutMap;
  const spawns = ctx && ctx.landmarks && ctx.landmarks.spawns;
  let answer = SPAWN_HOME;
  if (override && typeof spawns === "object" && spawns !== null) {
    // pairs() order is undefined in the Lua; sorted here for determinism.
    for (const id of sortedKeys(spawns)) {
      const row = spawns[id];
      if (typeof row === "object" && row !== null && row.map === override) {
        answer = id;
        break;
      }
    }
  }
  ctx.defaultSpawnpoint = answer;
  return undefined;
};

// ---- maps/BattleTowerHallway.asm

// maps/BattleTowerHallway.asm:23-32.  Lua: CallAsm.lua:702
H["BattleTowerHallwayChooseBattleRoomScript.asm_load_battle_room"] = (ctx) => {
  const vm = ctx && ctx.vm;
  return Math.floor(tonumber(vm && vm.btLevelGroup) ?? 0);
};

// ---- stubs ----------------------------------------------------------------------
//
// [name, wScriptVar or nil, reason].  A nil second field: the asm writes no
// wScriptVar, so neither does the stub.  Lua: CallAsm.lua:711
const STUB_ROWS: [string, number | undefined, string][] = [
  // Graphics and VRAM: the port's renderer draws its own way.
  ["OverworldBGMap", undefined, "ClearPalettes / ClearScreen / RotateThreePalettesLeft: the fade to white is the renderer's"],
  ["BattleBGMap", undefined, "SCGB_BATTLE_GRAYSCALE through GetSGBLayout: no SGB layout in this port"],
  ["HideSprites", undefined, "clears OAM for the FLY animation; the port hides the party sprite itself"],
  ["FlyFromAnim", undefined, "the bird's own frames; World:flyTo lifts the player under the setup script's fade instead"],
  ["FlyToAnim", undefined, "the landing frames; the same lift read backwards under the fade in"],
  ["SkipUpdateMapSprites", undefined, "suppresses one UpdateMapSprites while FLY is mid-air"],
  ["LoadWalkingSpritesGFX", undefined, "reloads the walking sprite bank after FLY lands"],
  ["LoadFishingGFX", undefined, "the rod and bobber tiles, which the extractor does not carry; World:updateFishing bobs the player instead"],
  ["ShakeHeadbuttTree", undefined, "the tree wobble frames; World:runHeadbutt owns the shake and the outcome"],
  // The START menu is a pushed screen, not a blocking call.
  ["StartMenu", undefined, "the START menu is a Screens.push state, not a blocking call"],
  // The phone: pointer plumbing the port's call descriptors make moot.
  ["HangUp", undefined, "the VM's own `hangup` op carries the Click! and SFX_HANG_UP; PhoneRing.script uses it in this row's place"],
  ["LoadBillScript", undefined, "writes wCallerContact for Script_SpecialBillCall; the call descriptor names the script key instead"],
  ["LoadElmScript", undefined, "writes wCallerContact for Script_SpecialElmCall; the call descriptor names the script key instead"],
  ["MomTriesToBuySomething_ASMFunction", undefined, "queues Mom's pages into wCallerContact; World:momTriesToBuy hands the same rows to PhoneRing.script"],
  // wEnabledPlayerEvents has no home in this port.
  ["EnableWildEncounters", undefined, "the port has no wEnabledPlayerEvents; the bit is never cleared"],
  // FindItemInBallScript's opener: a 0 or 1 would pick an arm at random.
  ["TryReceiveItem", undefined, "wItemBallItemID / wItemBallQuantity are set by a script path this port does not run"],
];

const STUBS: Record<string, Handler> = {};
const STUB_REASONS: Record<string, string> = {};

// Lua: CallAsm.lua:754
for (const [name, value, reason] of STUB_ROWS) {
  STUB_REASONS[name] = reason;
  STUBS[name] = () => value;
}

// The merged table; a name in both sets is a hard error.  Lua: CallAsm.lua:764
const ALL: Record<string, Handler> = {};
for (const name of Object.keys(H)) {
  ALL[name] = H[name]!;
}
for (const name of Object.keys(STUBS)) {
  if (ALL[name]) {
    throw new Error("gen2 callasm routine '" + name + "' is both implemented and stubbed");
  }
  ALL[name] = STUBS[name]!;
}

// ---- dispatch -------------------------------------------------------------------

// The `bank:addr` key, the same shape scripts.json uses.  Lua: CallAsm.lua:780
function key(bank?: number, addr?: number): string {
  return format("%02x:%04x", mod(bank ?? 0, 0x100), mod(addr ?? 0, 0x10000));
}

// The routine name for a site, or nil; `label` wins when the extractor has
// one.  Lua: CallAsm.lua:787
function nameFor(label: string | undefined, bank?: number, addr?: number): string | undefined {
  if (label && ALL[label]) return label;
  const k = key(bank, addr);
  return SITES[k] ?? SITES_SILVER[k] ?? SITES_CRYSTAL[k];
}

// Run a routine by name: the byte the asm leaves in wScriptVar, or nil.  A
// handler that throws must not take the script down.  Lua: CallAsm.lua:796
function run(ctx: any, name: string): number | undefined {
  const fn = ALL[name];
  if (!fn) return undefined;
  let value;
  try {
    value = fn(ctx);
  } catch {
    return undefined;
  }
  if (typeof value !== "number") return undefined;
  return mod(value, 0x100);
}

// The VM seam: Vm's `callasm` branch via World:callAsm.  Lua: CallAsm.lua:811
function dispatch(ctx: any, label: string | undefined, bank?: number, addr?: number): number | undefined {
  const name = nameFor(label, bank, addr);
  if (!name) return undefined;
  return run(ctx, name);
}

export const CallAsm = {
  SITES,
  SITES_SILVER,
  SITES_CRYSTAL,
  MEM_OPERANDS,
  HANDLERS: H,
  STUBS,
  STUB_REASONS,
  ALL,
  key,
  nameFor,
  run,
  dispatch,
};

export default CallAsm;
