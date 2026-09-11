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
  /** Closes every pushed menu down to the overworld — a field HM move
   * (CUT/FLASH) needs the menu gone before it runs. */
  closeToOverworld(): void;
  overworld: { runScript(rows: unknown[], onDone?: () => void): void };
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
  /** STATS, SWITCH, then CUT/FLASH if the selected mon knows them, then
   * CANCEL — the renderer (scene.ts) draws exactly this list, so the box
   * only needs to grow/shrink with it, never guess at its contents. */
  submenuItems: string[];
}

/** The two field moves this port wires up outside battle (PartyMenu.lua's
 * HM dispatch) — voxelmon/game/world/script.ts's use_cut/use_flash verbs. */
const FIELD_MOVES = ["CUT", "FLASH"] as const;

export class PartyState implements GameState {
  readonly kind = "party";
  private index = 0;
  private mode: "list" | "submenu" = "list";
  private submenuIndex = 0;
  // PartyMenu.lua swapFrom: the first pick, held while choosing the partner.
  private swapFrom: number | null = null;

  /**
   * `opts.onPick` turns the screen into a chooser (PartyMenu.lua's
   * ChoosePokemon-for-an-item mode): picking a mon closes the screen and
   * hands its index back instead of opening the STATS/SWITCH submenu. The
   * bag uses it to pick who learns a TM/HM.
   */
  constructor(private game: PartyGame, private opts?: { onPick?: (index: number) => void }) {}

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
      const pick = this.opts?.onPick;
      if (pick) {
        this.game.pop();
        pick(this.index);
        return;
      }
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

  // PartyMenu.lua's HM submenu: STATS/SWITCH are always offered; CUT/FLASH
  // only appear when the mon the submenu was opened on actually knows them
  // (mon.moves, battle/mon.ts's MoveSlot.id — the same id space
  // constants.hmMoves would use if the cook ever populated it).
  private submenuItems(): string[] {
    const mon = this.party()[this.index];
    const knows = (id: string) => mon?.moves?.some((m) => m.id === id) ?? false;
    const items = ["STATS", "SWITCH"];
    for (const id of FIELD_MOVES) if (knows(id)) items.push(id);
    items.push("CANCEL");
    return items;
  }

  private updateSubmenu(p: any): void {
    const items = this.submenuItems();
    const n = items.length;
    if (p.up) this.submenuIndex = (this.submenuIndex + n - 1) % n;
    if (p.down) this.submenuIndex = (this.submenuIndex + 1) % n;
    if (p.b) { this.mode = "list"; return; }
    if (!p.a) return;
    const label = items[this.submenuIndex];
    this.mode = "list";
    if (label === "STATS") this.game.push(new SummaryState(this.game, this.index));
    else if (label === "SWITCH") this.swapFrom = this.index;
    else if ((FIELD_MOVES as readonly string[]).includes(label!)) this.useFieldMove(label as "CUT" | "FLASH");
    // else CANCEL: already back to list
  }

  // PartyMenu.lua's HM dispatch: closes every menu on top of the overworld
  // (pokered backs all the way out too) and lets the move's own verb
  // (world/script.ts use_cut/use_flash) decide the effect and the text —
  // CUT checks the tile the player faces, FLASH just needs to run.
  private useFieldMove(moveId: "CUT" | "FLASH"): void {
    const mon = this.party()[this.index];
    const name = mon?.nickname ?? this.game.data.pokemon?.[mon?.species]?.name ?? mon?.species ?? "";
    this.game.closeToOverworld();
    const verb = moveId === "CUT" ? "use_cut" : "use_flash";
    this.game.overworld.runScript([[verb, name]]);
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
      submenuItems: this.submenuItems(),
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
