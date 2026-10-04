// gen1recomp src/core/gen2/BattleTower.lua (bdfac727, MIT): Crystal's Battle
// Tower -- pokecrystal engine/events/battle_tower/battle_tower.asm:1,
// engine/events/battle_tower/rules.asm:27 and load_trainer.asm, over the
// importer's Crystal-only `battleTower` block (trainers.json).

import { Breeding } from "./Breeding.ts";
import { HallOfFame } from "./HallOfFame.ts";
import { Mon } from "../battle/Mon.ts";
import { Save } from "./Save.ts";

type Rec = any;
/** Brian's 1-based `random(n) -> 1..n` (Specials.random). */
type Random = (n: number) => number;

const counter = (value: unknown): number => Math.max(0, Math.floor(Number(value) || 0));

// rules.asm:218-277 CheckPartyValueIsUnique: eggs skipped on both sides and a
// zero value never collides
function valuesUnique(party: Rec[], get: (mon: Rec) => unknown): boolean {
  for (let i = 0; i < party.length - 1; i++) {
    const mon = party[i];
    if (Breeding.isEgg(mon)) continue;
    const value = get(mon);
    if (value == null || value === 0) continue;
    for (let j = i + 1; j < party.length; j++) {
      const other = party[j];
      if (!Breeding.isEgg(other) && get(other) === value) return false;
    }
  }
  return true;
}

// load_trainer.asm:24-38 and :101-166 reroll until the roll passes; one draw
// from the survivors is the same distribution and cannot spin. An empty
// survivor set is where the cart's own loop would hang, so it draws unfiltered.
function drawFiltered(count: number, random: Random, accept: (row: number) => boolean): number {
  const pool: number[] = [];
  for (let i = 1; i <= count; i++) if (accept(i)) pool.push(i);
  if (pool.length === 0) return random(count);
  return pool[random(pool.length) - 1]!;
}

export const BattleTower = {
  // constants/battle_tower_constants.asm:1-7
  PARTY_LENGTH: 3,
  STREAK_LENGTH: 7,
  NUM_UNIQUE_MON: 21,
  NUM_UNIQUE_TRAINERS: 70,
  TRAINERDATALENGTH: 36,
  // :47 GS_BALL_AVAILABLE
  GS_BALL_AVAILABLE: 0x0b,
  // :55-61
  NO_CHALLENGE: 0,
  SAVED_AND_LEFT: 1,
  CHALLENGE_IN_PROGRESS: 2,
  WON_CHALLENGE: 3,
  RECEIVED_REWARD: 4,
  // :63-67
  REWARD_QUANTITY: 5,
  MIN_REWARD: "HP_UP",
  MAX_REWARD: "CALCIUM",
  SKIPPED_REWARD: "LUCKY_PUNCH",
  FALLBACK_REWARD: "POTION",
  // battle_tower.asm:1471-1492 bit 0, :978-1008 bit 1 of sBattleTowerSaveFileFlags
  SAVEFILE_REGISTERED: 1,
  SAVEFILE_EXPLANATION: 2,
  // :11-43
  ACTIONS: {
    CHECK_EXPLANATION_READ: 0, SET_EXPLANATION_READ: 1, GET_CHALLENGE_STATE: 2,
    SAVE_AND_QUIT: 3, CHALLENGECANCELED: 4, ACTION_05: 5, ACTION_06: 6,
    SAVELEVELGROUP: 7, LOADLEVELGROUP: 8, CHECKSAVEFILEISYOURS: 9, ACTION_0A: 10,
    GSBALL: 11, ACTION_0C: 12, ACTION_0D: 13, EGGTICKET: 14, ACTION_0F: 15,
    ACTION_10: 16, ACTION_11: 17, ACTION_12: 18, ACTION_13: 19, ACTION_14: 20,
    ACTION_15: 21, ACTION_16: 22, ACTION_17: 23, LEVEL_CHECK: 24, UBERS_CHECK: 25,
    RESETDATA: 26, GIVEREWARD: 27, ACTION_1C: 28, ACTION_1D: 29,
    CHOOSEREWARD: 30, SAVEOPTIONS: 31,
  } as Record<string, number>,
  NUM_ACTIONS: 32,
  // ram/wram.asm:1703 wNrOfBeatenBattleTowerTrainers (BattleTowerBattleRoom.asm:38 readmem)
  WRAM_NR_BEATEN: 0xcf64,
  // :49-53 `battletowertext`
  TEXT_INTRO: 1,
  TEXT_WIN: 2,
  TEXT_LOSS: 3,
  // rules.asm:39-55, in the order BattleTower_ExecuteJumptable prints them
  RULE_HEADER_TEXT: "_ExcuseMeYoureNotReadyText",
  RULE_FAIL_TEXTS: [
    "_OnlyThreeMonMayBeEnteredText",
    "_TheMonMustAllBeDifferentKindsText",
    "_TheMonMustNotHoldTheSameItemsText",
    "_YouCantTakeAnEggText",
  ],
  // rules.asm:61-68
  RULE_TAIL_TEXT: "_BattleTowerReturnWhenReadyText",
  // rules.asm:28-31 wStringBuffer2
  RULE_PARTY_COUNT_TEXT: "3",
  // mobile/mobile_46.asm:3936-3958 BattleTower_UbersCheck
  UBERS: { MEWTWO: true, MEW: true, LUGIA: true, HO_OH: true, CELEBI: true } as Record<string, boolean>,
  UBER_MIN_LEVEL: 70,
  // mobile_46.asm:3869-3887
  MAX_LEVEL_GROUP: 10,
  PRE_HOF_LEVEL_GROUPS: 4,

  // ram/sram.asm:147-172, on top of Save.battleTowerState
  state(save: Rec): Rec {
    const tower = Save.battleTowerState(save);
    tower.levelGroup = counter(tower.levelGroup); // sBTChoiceOfLevelGroup
    tower.saveFileFlags = counter(tower.saveFileFlags) % 256; // sBattleTowerSaveFileFlags
    if (!tower.trainers || typeof tower.trainers !== "object") tower.trainers = []; // sBTTrainers
    if (tower.reentry == null) tower.reentry = false; // battle_tower.asm:1449-1469 s5_aa8d
    return tower;
  },

  // battle_tower.asm:1471-1483 and :984-989: `and 1` / `and 2` -- the MASKED byte
  saveFileFlag(save: Rec, mask: number): number {
    const tower = BattleTower.state(save);
    return Math.floor(tower.saveFileFlags / mask) % 2 === 1 ? mask : 0;
  },

  setSaveFileFlag(save: Rec, mask: number): number {
    const tower = BattleTower.state(save);
    if (Math.floor(tower.saveFileFlags / mask) % 2 === 0) tower.saveFileFlags += mask;
    return tower.saveFileFlags;
  },

  // battle_tower.asm:890-904
  resetTrainers(save: Rec): Rec {
    const tower = BattleTower.state(save);
    tower.trainers = [];
    tower.streak = 0;
    return tower;
  },

  // battle_tower.asm:1016-1022
  setChallengeState(save: Rec, state: number): number {
    const tower = BattleTower.state(save);
    tower.challenge = counter(state);
    return tower.challenge;
  },

  // rules.asm:206-211
  partyCountOk(party: Rec[]): boolean {
    return party.length === BattleTower.PARTY_LENGTH;
  },
  // rules.asm:213-216
  speciesUnique(party: Rec[]): boolean {
    return valuesUnique(party, (mon) => mon?.species);
  },
  // rules.asm:279-282
  itemsUnique(party: Rec[]): boolean {
    return valuesUnique(party, (mon) => mon?.item);
  },
  // rules.asm:284-299
  partyHasEgg(party: Rec[]): boolean {
    return party.some((mon) => Breeding.isEgg(mon));
  },

  // rules.asm:27-37 and :94-103: every check runs, the first failure prints
  // the header first, a tail line follows any failure. [labels, any]
  checkRules(party: Rec[] | undefined): [string[], boolean] {
    const list = party ?? [];
    const failed = [
      !BattleTower.partyCountOk(list),
      !BattleTower.speciesUnique(list),
      !BattleTower.itemsUnique(list),
      BattleTower.partyHasEgg(list),
    ];
    const lines: string[] = [];
    let any = false;
    BattleTower.RULE_FAIL_TEXTS.forEach((text, i) => {
      if (!failed[i]) return;
      if (!any) {
        any = true;
        lines.push(BattleTower.RULE_HEADER_TEXT);
      }
      lines.push(text);
    });
    if (any) lines.push(BattleTower.RULE_TAIL_TEXT);
    return [lines, any];
  },

  // mobile_46.asm:1156-1166: the Hall of Fame flag opens rooms above L40
  levelGroupCount(save: Rec): number {
    return HallOfFame.hasEntered(save) ? BattleTower.MAX_LEVEL_GROUP : BattleTower.PRE_HOF_LEVEL_GROUPS;
  },

  levelGroupRows(save: Rec): { group: number; level: number }[] {
    const rows: { group: number; level: number }[] = [];
    for (let group = 1; group <= BattleTower.levelGroupCount(save); group++) rows.push({ group, level: group * 10 });
    return rows;
  },

  // mobile_46.asm:1264-1267 `dec a / and $fe / srl a`, the BATTLE ROOM pair
  roomOf(group: number): number {
    return Math.floor((Math.max(1, counter(group)) - 1) / 2);
  },

  // mobile_46.asm:3892-3934 BattleTower_LevelCheck
  levelCheck(party: Rec[] | undefined, group: number): boolean {
    const cap = counter(group) * 10;
    return (party ?? []).some((mon) => (Number(mon.level) || 0) > cap);
  },

  // mobile_46.asm:3936-3989: below the L70 rooms an uber under L70 is refused
  ubersCheck(party: Rec[] | undefined, group: number): string | undefined {
    if (counter(group) >= BattleTower.UBER_MIN_LEVEL / 10) return undefined;
    for (const mon of party ?? []) {
      if (BattleTower.UBERS[mon.species] && (Number(mon.level) || 0) < BattleTower.UBER_MIN_LEVEL) return mon.species;
    }
    return undefined;
  },

  // battle_tower.asm:955-976: a `maskbits` roll over HP_UP..CALCIUM that
  // folds the overshoot back and rerolls LUCKY_PUNCH. `order` is the Lua's
  // 1-based itemOrder table (index -> name).
  rollReward(order: Record<number, string> | string[] | undefined, random: Random): string | undefined {
    if (!order || typeof order !== "object") return undefined;
    const at = (i: number): string | undefined => (Array.isArray(order) ? order[i - 1] : order[i]);
    let low: number | undefined;
    let high: number | undefined;
    const indices = Array.isArray(order) ? order.map((_, i) => i + 1) : Object.keys(order).map(Number);
    for (const i of indices) {
      if (at(i) === BattleTower.MIN_REWARD) low = i;
      if (at(i) === BattleTower.MAX_REWARD) high = i;
    }
    if (low === undefined || high === undefined) return undefined;
    const span = high - low + 1;
    let mask = 1;
    while (mask < span) mask *= 2;
    for (let n = 0; n < 64; n++) {
      let roll = random(mask) % mask;
      if (roll >= span) roll -= span;
      const item = at(low + roll);
      if (item !== BattleTower.SKIPPED_REWARD) return item;
    }
    return at(low);
  },

  // battle_tower.asm:906-933: five of the reward only fit with a free ITEM
  // slot or room for five more on the stack; otherwise the desk hands over a POTION
  rewardFits(slots: number, capacity: number, held: number | undefined): boolean {
    if (counter(slots) < counter(capacity)) return true;
    if (held == null) return false;
    return counter(held) < 99 - BattleTower.REWARD_QUANTITY + 1;
  },

  // trainers.json `battleTower`, absent on Gold and Silver
  roster(data: Rec): Rec {
    const trainers = data && (data.gen2Trainers || data.trainers);
    const roster = trainers && trainers.battleTower;
    if (!roster || typeof roster !== "object") return undefined;
    if (!Array.isArray(roster.trainers) || !Array.isArray(roster.groups)) return undefined;
    return roster;
  },

  // ram/sram.asm:162-173 sBTMonOfTrainers: the last two teams' species
  prevTeams(save: Rec): { prev: string[]; prevPrev: string[] } {
    const tower = BattleTower.state(save);
    let teams = tower.prevTeams;
    // Save.battleTowerState seeds `[]`: a Lua table, an object here
    if (!teams || typeof teams !== "object" || Array.isArray(teams)) {
      teams = {};
      tower.prevTeams = teams;
    }
    if (!Array.isArray(teams.prev)) teams.prev = [];
    if (!Array.isArray(teams.prevPrev)) teams.prevPrev = [];
    return teams;
  },

  // load_trainer.asm:104-105 reads the room back as `dec a`; battle_tower.asm
  // :1129-1141 can only save 1..10
  opponentGroup(levelGroup: number, roster: Rec): number {
    const groups = (roster && roster.levelGroups) || BattleTower.MAX_LEVEL_GROUP;
    const group = counter(levelGroup);
    if (group < 1) return 1;
    if (group > groups) return groups;
    return group;
  },

  // load_trainer.asm:22-60: refused while it names anybody in sBTTrainers;
  // the winner goes in the slot sNrOfBeatenBattleTowerTrainers points at
  chooseTrainer(save: Rec, roster: Rec, random: Random): Rec {
    const tower = BattleTower.state(save);
    // :29-37, the ceiling read out of the cart (Crystal 1.0 can only draw 21)
    let ceiling = counter(roster.sampleTrainers);
    if (ceiling < 1 || ceiling > roster.trainers.length) ceiling = roster.trainers.length;
    const seen = new Set<number>();
    for (let slot = 0; slot < BattleTower.STREAK_LENGTH; slot++) {
      const held = Number(tower.trainers[slot]);
      if (tower.trainers[slot] != null && Number.isFinite(held)) seen.add(held);
    }
    const index = drawFiltered(ceiling, random, (row) => !seen.has(row - 1));
    tower.trainers[Math.min(counter(tower.streak), BattleTower.STREAK_LENGTH - 1)] = index - 1;
    return roster.trainers[index - 1];
  },

  // load_trainer.asm:94-208: three draws, each refusing a species or ITEM
  // this team holds and any species from the last two teams
  chooseTeam(save: Rec, roster: Rec, group: number, random: Random): Rec[] {
    const rows: Rec[] = roster.groups[group - 1] ?? [];
    const teams = BattleTower.prevTeams(save);
    const picked: Rec[] = [];
    const species = new Set<string>();
    const items = new Set<string>();
    for (let n = 0; n < BattleTower.PARTY_LENGTH; n++) {
      const index = drawFiltered(rows.length, random, (row) => {
        const mon = rows[row - 1];
        if (!mon) return false;
        if (species.has(mon.species)) return false;
        if (mon.item != null && items.has(mon.item)) return false;
        if (teams.prev.includes(mon.species)) return false;
        if (teams.prevPrev.includes(mon.species)) return false;
        return true;
      });
      const mon = rows[index - 1];
      if (!mon) break;
      picked.push(mon);
      species.add(mon.species);
      if (mon.item != null) items.add(mon.item);
    }
    // :195-206: this team becomes sBTMonPrevTrainer, the displaced one PrevPrev
    teams.prevPrev = teams.prev;
    teams.prev = picked.map((mon) => mon.species);
    return picked;
  },

  // the whole of `special LoadOpponentTrainerAndPokemon`, as one record (the
  // cart keeps it in unsaved WRAM; only sBTTrainers and the two teams are saved)
  drawOpponent(data: Rec, save: Rec, random: Random, levelGroup: number): Rec {
    const roster = BattleTower.roster(data);
    if (!roster) return undefined;
    const group = BattleTower.opponentGroup(levelGroup, roster);
    const trainer = BattleTower.chooseTrainer(save, roster, random);
    if (!trainer) return undefined;
    const rows = BattleTower.chooseTeam(save, roster, group, random);
    return {
      index: trainer.index,
      name: trainer.name,
      class: trainer.class,
      classId: trainer.classId,
      sprite: roster.classSprites && roster.classSprites[trainer.classId],
      group,
      rows,
    };
  },

  // battle_tower.asm:549-570: the streak counter steps BEFORE the battle
  beginBattle(save: Rec): number {
    const tower = BattleTower.state(save);
    tower.challenge = BattleTower.CHALLENGE_IN_PROGRESS;
    tower.streak = counter(tower.streak) + 1;
    return tower.streak;
  },

  // ReadBTTrainerParty copies the whole party_struct into wOTPartyMon: the
  // stored stats go on top of Mon.new's; the ROM nicknames never show
  battleParty(data: Rec, rows: Rec[] | undefined): Rec[] {
    const party: Rec[] = [];
    for (const row of rows ?? []) {
      let moves: Rec[] | undefined;
      if (row.moves && row.moves.length > 0) {
        moves = row.moves.map((id: string, slot: number) => {
          const def = data && data.moves && data.moves[id];
          const max = (def && def.pp) || 0;
          return { id, pp: (row.pp && row.pp[slot]) ?? max, maxPp: max };
        });
      }
      const dvs = row.dvs || {};
      const statExp = row.statExp || {};
      const mon: Rec = Mon.new(data, row.species, row.level, {
        moves,
        item: row.item,
        dvs: { attack: dvs.attack, defense: dvs.defense, speed: dvs.speed, special: dvs.special },
        statExp: { hp: statExp.hp, attack: statExp.attack, defense: statExp.defense, speed: statExp.speed, special: statExp.special },
        happiness: row.happiness,
      });
      if (!mon) continue;
      if (row.stats) mon.stats = { ...row.stats };
      mon.maxHp = row.maxHp ?? mon.maxHp;
      mon.hp = row.hp ?? mon.maxHp;
      mon.experience = row.experience ?? mon.experience;
      party.push(mon);
    }
    return party;
  },
};

export default BattleTower;
