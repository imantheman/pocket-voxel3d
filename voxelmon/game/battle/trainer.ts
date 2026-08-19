// Trainer battles over the wild-battle engine. The differences are narrow:
// the enemy has a party (send the next mon instead of ending), escape is
// refused, and a win pays out baseMoney * top level.
import { WildBattle, type BattleSave } from "./battle.ts";
import type { VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { newMon, type PartyMon } from "./mon.ts";

interface TrainerDef {
  id: string;
  name: string;
  baseMoney?: number;
  aiMods?: number[];
  parties: { species: string; level: number }[][];
}

export class TrainerBattle extends WildBattle {
  readonly isTrainer = true;
  readonly trainerName: string;
  private enemyParty: PartyMon[] = [];
  private enemyIndex = 0;
  private baseMoney: number;

  /** `partyIndex` is the 1-based variant from the script row. */
  constructor(
    data: VoxelmonData,
    save: BattleSave,
    rng: Rng,
    trainerId: string,
    partyIndex = 1,
    displayName?: string,
  ) {
    const def = (data as unknown as { trainers: Record<string, TrainerDef> })
      .trainers[trainerId];
    const roster = def?.parties?.[partyIndex - 1] ?? def?.parties?.[0] ?? [];
    const lead = roster[0] ?? { species: "RATTATA", level: 2 };
    super(data, save, rng, lead.species, lead.level);

    this.trainerName = displayName ?? def?.name ?? trainerId;
    this.baseMoney = def?.baseMoney ?? 0;
    this.enemyParty = roster.map((m) => newMon(data, m.species, m.level, rng));
    this.enemyIndex = 0;
  }

  /** Trainers send out their lead instead of it "appearing" wild
   * (common_text.asm TrainerSentOutText). */
  override enemyIntro(): void {
    this.act(() => this.audioCues.push(`cry:${this.enemy.mon.species}`));
    this.say(`${this.trainerName} sent\nout ${this.enemy.name}!`);
  }

  /** Trainers refuse escape (tryRun's trainer branch). */
  override runRoll(_playerSpeed: number, _enemySpeed: number): boolean {
    this.say("There's no escaping\na trainer battle!");
    return false;
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
    this.sayNext(`${this.trainerName} sent out\n${next.species}!`);
    this.act(() => this.swapEnemy(next));
  }
}
