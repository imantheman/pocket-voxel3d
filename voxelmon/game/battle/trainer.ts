// Trainer battles over the wild-battle engine. The differences are narrow:
// the enemy has a party (send the next mon instead of ending), escape is
// refused, and a win pays out baseMoney * top level.
import { WildBattle, type BattleSave } from "./battle.ts";
import type { VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { makeBattler } from "./battler.ts";
import { newMon, markSeen, type PartyMon } from "./mon.ts";
import { TRAINER_INTRO_SFX_GAP } from "../rules/timing.ts";

/**
 * A trainer's mons all carry the same DVs: LoadEnemyMon reads wTrainerClass
 * and, for a trainer battle, loads ATKDEFDV_TRAINER / SPDSPCDV_TRAINER
 * ($98, $88) instead of rolling -- Atk 9, Def 8, Spd 8, Spc 8, so HP 8.
 * Never shiny in Gold, which is why no trainer's mon ever came over shiny.
 */
export const TRAINER_DVS = { hp: 8, attack: 9, defense: 8, speed: 8, special: 8 } as const;

interface TrainerDef {
  id: string;
  name: string;
  baseMoney?: number;
  aiMods?: number[];
  parties: { species: string; level: number }[][];
}

/**
 * The gym-leader fights, by class and the party index that IS the gym battle
 * (init_battle.asm's wGymLeaderNo is written only by the eight gym scripts).
 * Every leader has a single roster except Giovanni, whose gym team is his
 * third — parties 1 and 2 are the Rocket Hideout and Silph Co., which take
 * the ordinary trainer theme.
 */
const GYM_LEADER_PARTY: Record<string, number> = {
  OPP_BROCK: 1,
  OPP_MISTY: 1,
  OPP_LT_SURGE: 1,
  OPP_ERIKA: 1,
  OPP_KOGA: 1,
  OPP_SABRINA: 1,
  OPP_BLAINE: 1,
  OPP_GIOVANNI: 3,
};

/**
 * Red and Blue's extra moves for the big fights (engine/battle/
 * read_trainer_party.asm), written into the THIRD move slot after the party
 * loads. Checked byte for byte against both ROMs (one copy each, bank $0E):
 *
 *   LoneMoves   a gym leader's script sets wLoneAttackNo to its gym's
 *               number; the entry names a party mon (counting from 0) and
 *               the move -- Brock's ONIX BIDE ... Giovanni's RHYDON FISSURE
 *   TeamMoves   by class, to the FIFTH mon: Lorelei's LAPRAS BLIZZARD,
 *               Bruno's MACHAMP FISSURE, Agatha's GENGAR TOXIC, Lance's
 *               DRAGONITE BARRIER
 *   .ChampionRival  PIDGEOT gets SKY ATTACK, and his starter (the sixth)
 *               BLIZZARD / MEGA DRAIN / FIRE BLAST for BLASTOISE / VENUSAUR /
 *               CHARIZARD
 *
 * Yellow writes its trainers' moves another way (its own table, read from
 * the Yellow ROM) and takes none of these.
 */
const LONE_MOVES: Record<string, [number, string]> = {
  OPP_BROCK: [1, "BIDE"],
  OPP_MISTY: [1, "BUBBLEBEAM"],
  OPP_LT_SURGE: [2, "THUNDERBOLT"],
  OPP_ERIKA: [2, "MEGA_DRAIN"],
  OPP_KOGA: [3, "TOXIC"],
  OPP_SABRINA: [3, "PSYWAVE"],
  OPP_BLAINE: [3, "FIRE_BLAST"],
  OPP_GIOVANNI: [4, "FISSURE"],
};
const TEAM_MOVES: Record<string, string> = {
  OPP_LORELEI: "BLIZZARD",
  OPP_BRUNO: "FISSURE",
  OPP_AGATHA: "TOXIC",
  OPP_LANCE: "BARRIER",
};
const CHAMPION_STARTER_MOVE: Record<string, string> = {
  BLASTOISE: "BLIZZARD",
  VENUSAUR: "MEGA_DRAIN",
  CHARIZARD: "FIRE_BLAST",
};

/** `ld [wEnemyMon<n>Moves + 2], move`: the third slot (or the next, on a mon with fewer). */
function giveThirdMove(data: VoxelmonData, mon: PartyMon | undefined, move: string): void {
  if (!mon || !data.moves[move]) return;
  const slot = { id: move, pp: data.moves[move]!.pp ?? 0 };
  if (mon.moves.length >= 3) mon.moves[2] = slot;
  else if (!mon.moves.some((m) => m.id === move)) mon.moves.push(slot);
}

export function applySpecialTrainerMoves(
  data: VoxelmonData, trainerId: string, partyIndex: number, party: PartyMon[],
): void {
  // Yellow: its own SpecialTrainerMoves table, read from the ROM by the
  // import (trainers.json specialMoves) -- (mon, slot, move) into that slot
  const def = (data as unknown as { trainers?: Record<string, { specialMoves?: Record<string, [number, number, string][]> }> })
    .trainers?.[trainerId];
  const rows = def?.specialMoves?.[String(partyIndex)];
  if (rows) {
    for (const [n, slot, move] of rows) {
      const mon = party[n - 1];
      if (!mon || !data.moves[move]) continue;
      const entry = { id: move, pp: data.moves[move]!.pp ?? 0 };
      if (slot - 1 < mon.moves.length) mon.moves[slot - 1] = entry;
      else if (!mon.moves.some((m) => m.id === move)) mon.moves.push(entry);
    }
    return;
  }
  const v = (data as { version?: string }).version;
  if (v === "yellow" || v === "gold" || v === "silver") return;
  const lone = LONE_MOVES[trainerId];
  if (lone && GYM_LEADER_PARTY[trainerId] === partyIndex) giveThirdMove(data, party[lone[0]], lone[1]);
  const team = TEAM_MOVES[trainerId];
  if (team) giveThirdMove(data, party[4], team);
  if (trainerId === "OPP_RIVAL3") {
    giveThirdMove(data, party[0], "SKY_ATTACK");
    const starter = party[5];
    const move = starter ? CHAMPION_STARTER_MOVE[starter.species] : undefined;
    if (move) giveThirdMove(data, starter, move);
  }
}

export class TrainerBattle extends WildBattle {
  override isTrainerBattle(): boolean {
    return true;
  }

  readonly isTrainer = true;
  readonly trainerName: string;
  readonly trainerId: string;
  readonly partyIndex: number;
  protected enemyParty: PartyMon[] = [];
  protected enemyIndex = 0;
  private baseMoney: number;

  /** `partyIndex` is the 1-based variant from the script row. */
  constructor(
    data: VoxelmonData,
    save: BattleSave,
    rng: Rng,
    trainerId: string,
    partyIndex = 1,
    displayName?: string,
    /**
     * Mons to field instead of the trainer table's. A link battle's
     * opponent is another player's actual party -- their DVs, their
     * levels, their damage -- and rolling it from a species/level pair
     * would be a different team with the same names on it.
     */
    monRoster?: PartyMon[],
  ) {
    const def = (data as unknown as { trainers: Record<string, TrainerDef> })
      .trainers[trainerId];
    const roster = def?.parties?.[partyIndex - 1] ?? def?.parties?.[0] ?? [];
    const lead = monRoster?.[0] ?? roster[0] ?? { species: "RATTATA", level: 2 };
    super(data, save, rng, lead.species, lead.level);

    this.trainerId = trainerId;
    this.partyIndex = partyIndex;
    this.trainerName = displayName ?? def?.name ?? trainerId;
    this.baseMoney = def?.baseMoney ?? 0;
    this.enemyParty = monRoster
      ? monRoster.map((m) => ({ ...m }))
      : roster.map((m) => newMon(data, m.species, m.level, undefined, { ...TRAINER_DVS }));
    if (!monRoster) applySpecialTrainerMoves(data, trainerId, partyIndex, this.enemyParty);
    this.enemyIndex = 0;
    if (this.enemyParty[0]) {
      // super() built the lead from a species and a level, which rolled it
      // wild. Put the real mon -- a linked player's, or the trainer's own
      // fixed-DV one -- in its place.
      this.enemy = makeBattler(data, this.enemyParty[0], false);
    }
  }

  /**
   * BattleState.lua:1394 computeMusicKind. The champion gets the final theme;
   * gym leaders and Lance get the leader theme; everyone else the ordinary
   * trainer theme.
   *
   * "Gym leader" is the set of fights that write wGymLeaderNo, which is the
   * eight gym scripts and nothing else — so Giovanni's Rocket Hideout and
   * Silph Co. battles are ORDINARY trainer fights and only his Viridian gym
   * roster is a leader fight. That is why the party index is part of the test
   * rather than the class alone.
   */
  override musicKind(): string {
    if (this.trainerId === "OPP_RIVAL3") return "final";
    if (this.trainerId === "OPP_LANCE") return "gym";
    const gymParty = GYM_LEADER_PARTY[this.trainerId];
    if (gymParty !== undefined && gymParty === this.partyIndex) return "gym";
    return "trainer";
  }

  /**
   * A trainer's victory theme waits for the LAST mon (TrainerBattleVictory);
   * until then the battle theme keeps playing. This was firing on every faint,
   * so a trainer with a full party sounded beaten five times over.
   */
  protected override victoryMusicKind(): string | null {
    const more = this.enemyParty.some((m, i) => i > this.enemyIndex && m.hp > 0);
    if (more) return null;
    // Only gymWin/trainerWin/wildWin exist (audio.battle); the champion's
    // fight has no jingle of its own, so it takes the leader's.
    return this.musicKind() === "trainer" ? "trainer" : "gym";
  }

  /** Trainers send out their lead instead of it "appearing" wild
   * (common_text.asm TrainerSentOutText). */
  override enemyIntro(): void {
    // PrintBeginningBattleText .trainerBattle (common_text.asm): a trainer
    // battle opens on a sound of its own -- extracted as "Trainer_Appeared",
    // the header pokered names SFX_Silph_Scope -- and the ROM gives it a
    // clear window: PlaySound, WaitForSoundToFinish, then twenty frames
    // before anything else. Nothing had ever played it, so a trainer fight
    // started in silence where the ROM announces itself.
    this.act(() => this.audioCues.push("sfx:Trainer_Appeared"));
    this.queue.push({ wait: TRAINER_INTRO_SFX_GAP });
    this.say(`${this.trainerName} wants\nto fight!`);
    markSeen(this.save, this.enemy.mon.species); // BattleState.lua:718 — trainer lead sent out -> seen
    this.act(() => this.audioCues.push(`cry:${this.enemy.mon.species}`));
    this.say(`${this.trainerName} sent\nout ${this.enemy.name}!`);
  }

  /** Trainers refuse escape (tryRun's trainer branch). */
  override runRoll(_playerSpeed: number, _enemySpeed: number): boolean {
    this.say("There's no escaping\na trainer battle!");
    return false;
  }

  /** The party slots the trainer could still send out. */
  protected enemyBench(): number[] {
    return this.enemyParty
      .map((m, i) => (i !== this.enemyIndex && m.hp > 0 ? i : -1))
      .filter((i) => i >= 0);
  }

  /**
   * The trainer's switch, mid-turn: the new mon is out before the other
   * side's move lands, which is what a switch is for. Queued NEXT rather
   * than at the end, because the rest of the turn is already behind it.
   */
  override enemySwitch(slot: number): void {
    const next = this.enemyParty[slot];
    if (!next || next.hp <= 0 || slot === this.enemyIndex) return;
    this.enemyIndex = slot;
    markSeen(this.save, next.species);
    this.sayNext(`${this.trainerName} sent out\n${next.species}!`);
    this.actNext(() => this.swapEnemy(next));
  }

  override enemyMonFainted(): void {
    this.awardExp();
    const next = this.enemyParty.find((m, i) => i > this.enemyIndex && m.hp > 0);
    if (!next) {
      this.result = "win";
      this.afterQueue = "finish";
      const top = Math.max(...this.enemyParty.map((m) => m.level ?? 1));
      const money = this.baseMoney * top;
      if (money > 0) {
        const save = this.save as BattleSave & { money?: number };
        if (typeof save.money === "number") save.money += money;
        this.sayNext(`${this.trainerName} paid out\n$${money}!`);
      }
      return;
    }
    this.enemyIndex = this.enemyParty.indexOf(next);
    markSeen(this.save, next.species); // BattleState.lua:3256/3945 — enemy send-out -> seen
    if (this.offersShift()) {
      // EnemySendOut, BATTLE STYLE SHIFT: TrainerAboutToUseText over a
      // YES/NO; YES opens the party for a free switch first
      const name = this.data.pokemon[next.species]?.name ?? next.species;
      const text = ((this.data as { text?: Record<string, string> }).text?._TrainerAboutToUseText
        ?? "{RAM:wTrainerName} is\nabout to use\v{RAM:wEnemyMonNick}!\fWill {PLAYER}\nchange POKéMON?")
        .replace(/\{RAM:wTrainerName\}/g, this.trainerName)
        .replace(/\{RAM:wEnemyMonNick\}/g, name)
        .replace(/\{PLAYER\}/g, this.save.player?.name ?? "RED");
      this.sayChoiceNext(text, (yes) => {
        if (!yes) return;
        this.shiftSwitch = true;
        this.openParty(false);
      });
    }
    this.sayNext(`${this.trainerName} sent out\n${next.species}!`);
    this.act(() => this.swapEnemy(next));
  }

  /**
   * The SHIFT offer: the option (the cart's default), the player's mon still
   * standing, and someone on the bench to send in. Never in a link battle.
   */
  protected offersShift(): boolean {
    if ((this.save as { options?: { battleStyle?: string } }).options?.battleStyle === "set") return false;
    if (!this.player?.mon || this.player.mon.hp <= 0) return false;
    return this.save.party.some((m) => m !== this.player.mon && m.hp > 0);
  }
}
