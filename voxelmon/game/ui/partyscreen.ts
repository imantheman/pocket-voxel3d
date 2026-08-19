// The POKéMON screen. The party list (PartyMenu.lua DrawPartyMenu /
// ChooseNextMon :4097) plus a compact per-mon summary (StatusScreen /
// StatusScreen2). Reads save.party directly — the same party_struct the
// battle port already renders in battle/ui.ts.
import type { GameState } from "../game.ts";
import type { PartyMon } from "../battle/mon.ts";

interface PartyGame {
  input: any;
  push(s: GameState): void;
  pop(): void;
  save: any;
  data: any;
}

export interface PartyEntry {
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  status: string | null;
}

export interface PartyView {
  entries: PartyEntry[];
  index: number;
  mode: "list" | "submenu";
  submenuIndex: number;
  swapFrom: number | null;
}

export class PartyState implements GameState {
  readonly kind = "party";
  private index = 0;
  private mode: "list" | "submenu" = "list";
  private submenuIndex = 0;
  // PartyMenu.lua swapFrom: the first pick, held while choosing the partner.
  private swapFrom: number | null = null;

  constructor(private game: PartyGame) {}

  private party(): PartyMon[] {
    return (this.game.save.party ?? []) as PartyMon[];
  }

  update(): void {
    const p = this.game.input.pressed;
    if (this.mode === "submenu") return this.updateSubmenu(p);
    const n = this.party().length + 1; // + CANCEL
    if (p.up) this.index = (this.index + n - 1) % n;
    if (p.down) this.index = (this.index + 1) % n;
    if (p.b || (p.a && this.index === n - 1)) {
      if (this.swapFrom !== null) { this.swapFrom = null; return; } // cancel the swap
      this.game.pop();
      return;
    }
    if (p.a && this.index < this.party().length) {
      if (this.swapFrom !== null) {
        // second pick: swap the two slots (PartyMenu.lua:563-566)
        if (this.swapFrom !== this.index) {
          const party = this.party();
          const tmp = party[this.swapFrom]!;
          party[this.swapFrom] = party[this.index]!;
          party[this.index] = tmp;
        }
        this.swapFrom = null;
      } else {
        this.mode = "submenu";
        this.submenuIndex = 0;
      }
    }
  }

  private updateSubmenu(p: any): void {
    if (p.up) this.submenuIndex = (this.submenuIndex + 2) % 3;
    if (p.down) this.submenuIndex = (this.submenuIndex + 1) % 3;
    if (p.b) { this.mode = "list"; return; }
    if (!p.a) return;
    this.mode = "list";
    if (this.submenuIndex === 0) this.game.push(new SummaryState(this.game, this.index)); // STATS
    else if (this.submenuIndex === 1) this.swapFrom = this.index; // SWITCH
    // else CANCEL: already back to list
  }

  view(): PartyView {
    const entries = this.party().map((m) => ({
      name: m.nickname ?? this.game.data.pokemon?.[m.species]?.name ?? m.species,
      level: m.level,
      hp: m.hp,
      maxHp: m.stats?.hp ?? m.hp,
      status: m.status ?? null,
    }));
    return {
      entries,
      index: this.index,
      mode: this.mode,
      submenuIndex: this.submenuIndex,
      swapFrom: this.swapFrom,
    };
  }
}

export interface SummaryView {
  name: string;
  species: string;
  level: number;
  hp: number;
  maxHp: number;
  status: string | null;
  types: string[];
  stats: { atk: number; def: number; spd: number; spc: number };
  moves: { name: string; pp: number }[];
}

export class SummaryState implements GameState {
  readonly kind = "summary";

  constructor(private game: PartyGame, private slot: number, private mon?: PartyMon) {}

  update(): void {
    const p = this.game.input.pressed;
    if (p.a || p.b) this.game.pop();
  }

  view(): SummaryView {
    const m = this.mon ?? ((this.game.save.party ?? []) as PartyMon[])[this.slot];
    const def = this.game.data.pokemon?.[m.species];
    const moves = (m.moves ?? []).map((ms) => ({
      name: this.game.data.moves?.[ms.id]?.name ?? ms.id,
      pp: ms.pp,
    }));
    return {
      name: m.nickname ?? def?.name ?? m.species,
      species: def?.name ?? m.species,
      level: m.level,
      hp: m.hp,
      maxHp: m.stats?.hp ?? m.hp,
      status: m.status ?? null,
      types: def?.types ?? [],
      stats: {
        atk: m.stats?.attack ?? 0,
        def: m.stats?.defense ?? 0,
        spd: m.stats?.speed ?? 0,
        spc: m.stats?.special ?? 0,
      },
      moves,
    };
  }
}
