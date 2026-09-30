// Read-only Gen 2 battle state with the same shape as mod.battle on Gen 1: a
// port of gen1recomp src/battle/gen2/BattleAPI.lua (bdfac727, MIT).
//
// It reads game.stack's states (the Gold battle screen, ui/BattleState.ts)
// and never writes them except through the screen's own chooseMenu /
// chooseMove / cancelMove.  Those return the Lua's `true` / `nil, err` as a
// [ok, err] pair here.
//
// Slots in what this hands out (party[].slot, moves[].slot, intent.slot) keep
// the Lua's 1-based numbers: they are the mod-facing API's numbering. The
// arrays themselves are 0-based.

import { tostring, truthy } from "../platform/lua.ts";

export interface BattleMonCopy {
  species: any;
  name: any;
  level: any;
  hp: any;
  maxHp: any;
  status: any;
  active: boolean;
  slot?: number;
}

export interface BattleIntent {
  id: number;
  revision?: number;
  kind?: string;
  choice?: string;
  slot?: number;
  [k: string]: any;
}

// Lua's tostring(table) is "table: 0x..." -- an identity, which is what
// signature() leans on to notice a new screen or a swapped mon.  JS objects
// print as "[object Object]", so each object gets a stable id instead.
const tableIds = new WeakMap<object, number>();
let nextTableId = 1;
function luaTostring(v: unknown): string {
  if ((typeof v === "object" && v !== null) || typeof v === "function") {
    let id = tableIds.get(v as object);
    if (id === undefined) {
      id = nextTableId++;
      tableIds.set(v as object, id);
    }
    return `table: ${id}`;
  }
  return tostring(v);
}

// Lua: BattleAPI.lua:10
function activeBattle(game: any): [any, any] {
  const states: any[] = (truthy(game) && truthy(game.stack) ? game.stack.states : undefined) ?? [];
  let battle: any;
  for (let i = states.length - 1; i >= 0; i--) {
    const state = states[i];
    if (state.screenId === "Gen2BattleState" || truthy(state.isGen2BattleState)) {
      battle = state;
      break;
    }
  }
  return [battle, states[states.length - 1]];
}

// Lua: BattleAPI.lua:23
function monCopy(data: any, mon: any, active: unknown): BattleMonCopy | undefined {
  if (!truthy(mon)) return undefined;
  const def = truthy(data) && truthy(data.pokemon) ? data.pokemon[mon.species] : undefined;
  let name = mon.nickname;
  if (!truthy(name)) name = truthy(def) && truthy(def.name) ? def.name : mon.species;
  let maxHp = mon.maxHp;
  if (!truthy(maxHp)) maxHp = truthy(mon.stats) && truthy(mon.stats.hp) ? mon.stats.hp : mon.hp;
  return {
    species: mon.species,
    name,
    level: mon.level,
    hp: mon.hp,
    maxHp,
    status: mon.status,
    active: truthy(active) ? true : false,
  };
}

// Lua: BattleAPI.lua:33
function messageCopy(screen: any): string[] | undefined {
  if (!truthy(screen.message)) return undefined;
  const lines: string[] = tostring(screen.message).match(/[^\n]+/g) ?? [];
  return lines.length > 0 ? lines : undefined;
}

// Lua: BattleAPI.lua:42
function itemCopies(game: any, screen: any, catchable: unknown): any[] {
  const out: any[] = [];
  const inventory = (truthy(game.save) ? game.save.inventory : undefined) ?? {};
  // pairs(); the sort below fixes the order (ties by id for determinism)
  for (const id of Object.keys(inventory).sort()) {
    const count = inventory[id];
    const def = truthy(game.data.items) ? game.data.items[id] : undefined;
    if (count > 0 && truthy(def) && def.pocket === "BALL") {
      let catchChance: any = undefined;
      if (truthy(catchable) && truthy(screen.catchChance)) {
        const c = screen.catchChance(id);
        catchChance = truthy(c) ? c : undefined;
      }
      out.push({
        id,
        name: def.name ?? id,
        count,
        ball: true,
        needsTarget: false,
        catchChance,
      });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// Lua: BattleAPI.lua:57
function signature(game: any, screen: any, top: any): string {
  if (!truthy(screen)) return "none";
  const battle = screen.battle ?? {};
  const parts: string[] = [
    luaTostring(screen),
    luaTostring(top),
    luaTostring(screen.phase),
    luaTostring(screen.message),
    luaTostring(screen.messageTimer),
    luaTostring(screen.menuIndex),
    luaTostring(screen.moveIndex),
    luaTostring(battle.turn),
    luaTostring(battle.over),
    luaTostring(battle.outcome),
  ];
  // ipairs({ battle.player, battle.enemy }) stops at the first nil
  for (const mon of [battle.player, battle.enemy]) {
    if (mon == null) break;
    parts.push(luaTostring(mon));
    parts.push(luaTostring(truthy(mon) ? mon.hp : mon));
    parts.push(luaTostring(truthy(mon) ? mon.status : mon));
  }
  const party: any[] = (truthy(game.save) ? game.save.party : undefined) ?? battle.party ?? [];
  for (const mon of party) {
    if (mon == null) break;
    parts.push(luaTostring(mon));
    parts.push(luaTostring(mon.hp));
    parts.push(luaTostring(mon.status));
  }
  for (const item of itemCopies(game, screen, false)) {
    parts.push(`${item.id}=${luaTostring(item.count)}`);
  }
  return parts.join("|");
}

// Lua: BattleAPI.lua:89
function moveCopies(game: any, battle: any): any[] {
  const out: any[] = [];
  const moves: any[] = (truthy(battle.player) ? battle.player.moves : undefined) ?? [];
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    if (move == null) break;
    const def = (game.data.moves ?? {})[move.id] ?? {};
    out[i] = {
      slot: i + 1,
      id: move.id,
      name: def.name ?? move.id,
      pp: move.pp,
      maxPp: move.maxPp ?? def.pp ?? move.pp,
      type: def.type,
      power: def.power,
      accuracy: def.accuracy,
      disabled: battle.moveDisabled(battle.player, move.id),
    };
  }
  return out;
}

// Lua: BattleAPI.lua:101
function battleKind(screen: any): string {
  if (truthy(screen.tutorial)) return "oldman";
  return truthy(screen.battle) && truthy(screen.battle.wild) ? "wild" : "trainer";
}

// Lua: BattleAPI.lua:137
const MENU_CHOICES: Record<string, boolean> = { fight: true, party: true, item: true, run: true };

// Lua: BattleAPI.lua:139
function validSlot(slot: unknown): boolean {
  return typeof slot === "number" && slot % 1 === 0 && slot >= 1;
}

export class BattleAPI {
  game: any;
  revision: number;
  signature: string | undefined;
  lastIntentId: number | undefined;

  constructor(game: any) {
    this.game = game;
    this.revision = 0;
    this.signature = undefined;
    this.lastIntentId = undefined;
  }

  // Lua: BattleAPI.lua:6
  static new(game: any): BattleAPI {
    return new BattleAPI(game);
  }

  // Lua: BattleAPI.lua:80
  _revision(screen: any, top: any): number {
    const nextSignature = signature(this.game, screen, top);
    if (nextSignature !== this.signature) {
      this.signature = nextSignature;
      this.revision = this.revision + 1;
    }
    return this.revision;
  }

  // Lua: BattleAPI.lua:106
  snapshot(): Record<string, any> | undefined {
    const game = this.game;
    const [screen, top] = activeBattle(game);
    if (!truthy(screen) || !truthy(screen.battle)) return undefined;
    const battle = screen.battle;
    let prompt = "locked";
    if (top === screen && screen.phase === "menu") {
      prompt = "menu";
    } else if (top === screen && screen.phase === "moves") {
      prompt = "moves";
    } else if (top === screen && truthy(screen.message)) {
      prompt = "advance";
    } else if (truthy(top) && top.screenId === "Gen2PartyMenu") {
      prompt = "party";
    }
    const party: BattleMonCopy[] = [];
    const members: any[] = (truthy(game.save) ? game.save.party : undefined) ?? battle.party ?? [];
    for (let i = 0; i < members.length; i++) {
      const mon = members[i];
      if (mon == null) break;
      party[i] = monCopy(game.data, mon, mon === battle.player)!;
      party[i]!.slot = i + 1;
    }
    // `battle.wild and not screen.tutorial`
    const catchable = truthy(battle.wild) ? !truthy(screen.tutorial) : battle.wild;
    return {
      revision: this._revision(screen, top),
      kind: battleKind(screen),
      catchable,
      prompt,
      message: messageCopy(screen),
      turn: battle.turn ?? 0,
      player: monCopy(game.data, battle.player, true),
      enemy: monCopy(game.data, battle.enemy, true),
      party,
      moves: moveCopies(game, battle),
      // Targeted medicine remains screen-owned, but balls are complete semantic
      // records and can safely expose the same read-only preview as Gen 1.
      items: itemCopies(game, screen, catchable),
    };
  }

  // Lua: BattleAPI.lua:143 -- the Lua's `true` / `nil, err`, as a pair.
  submit(intent: unknown): [true] | [undefined, string] {
    if (typeof intent !== "object" || intent === null) return [undefined, "intent must be a table"];
    const it = intent as BattleIntent;
    if (typeof it.id !== "number" || it.id % 1 !== 0 || it.id < 1) {
      return [undefined, "intent id must be a positive integer"];
    }
    if (this.lastIntentId !== undefined && it.id <= this.lastIntentId) {
      return [undefined, "replayed intent"];
    }

    const [screen, top] = activeBattle(this.game);
    if (!truthy(screen) || !truthy(screen.battle)) return [undefined, "no battle"];
    if (it.revision !== this._revision(screen, top)) {
      return [undefined, "stale battle context"];
    }
    if (truthy(screen.tutorial)) return [undefined, "battle kind is not controllable"];
    if (top !== screen) return [undefined, "battle menu is covered"];

    const battle = screen.battle;
    let ok: unknown;
    let err: unknown;
    if (it.kind === "menu") {
      if (screen.phase !== "menu") return [undefined, "battle menu is not active"];
      if (!MENU_CHOICES[it.choice as string]) {
        return [undefined, "unknown battle menu choice"];
      }
      [ok, err] = screen.chooseMenu(it.choice);
    } else if (it.kind === "move") {
      if (screen.phase !== "moves") return [undefined, "move menu is not active"];
      if (truthy(screen.moveSwapIndex)) return [undefined, "move reorder is active"];
      const move =
        validSlot(it.slot) && truthy(battle.player) && truthy(battle.player.moves)
          ? battle.player.moves[it.slot! - 1]
          : undefined;
      if (!truthy(move)) return [undefined, "invalid move slot"];
      if ((move.pp ?? 0) <= 0) return [undefined, "move has no PP"];
      if (truthy(battle.moveDisabled(battle.player, move.id))) {
        return [undefined, "move is disabled"];
      }
      // the Lua's 1-based slot, as the screen's chooseMove(index) takes it
      [ok, err] = screen.chooseMove(it.slot);
    } else if (it.kind === "back") {
      [ok, err] = screen.cancelMove();
    } else {
      return [undefined, "unknown battle intent"];
    }
    if (!truthy(ok)) return [undefined, err as string];
    this.lastIntentId = it.id;
    this.signature = undefined;
    return [true];
  }
}

export default BattleAPI;
