// Trainer battles over the wild-battle engine. The differences are narrow:
// the enemy has a party (send the next mon instead of ending), escape is
// refused, and a win pays out baseMoney * top level.
import { WildBattle, type BattleSave } from "./battle.ts";
import type { VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { makeBattler } from "./battler.ts";
import { newMon, markSeen, type PartyMon } from "./mon.ts";
import { TRAINER_INTRO_SFX_GAP } from "../rules/timing.ts";

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
      : roster.map((m) => newMon(data, m.species, m.level, rng));
    this.enemyIndex = 0;
    if (monRoster?.[0]) {
      // super() built the lead from a species and a level, which re-rolled
      // it. Put the real mon in its place.
      this.enemy = makeBattler(data, this.enemyParty[0]!, false);
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
    this.sayNext(`${this.trainerName} sent out\n${next.species}!`);
    this.act(() => this.swapEnemy(next));
  }
}
