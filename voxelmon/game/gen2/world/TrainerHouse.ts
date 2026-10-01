// gen1recomp src/world/gen2/TrainerHouse.lua at bdfac727 (MIT).
//
// The Viridian Trainer House: the one battle a day against CAL in the
// basement's TRAINING HALL (maps/TrainerHouseB1F.asm).
//
// The conversation itself is script bytecode: the coord_event on the doorway
// runs TrainerHouseReceptionistScript, which checks
// ENGINE_FOUGHT_IN_TRAINER_HALL_TODAY, asks `special TrainerHouse` whose
// opponent it is, walks the player in and starts the battle.  What that
// script needs from the port is the three compiled routines behind it, all
// about the SAME question: whether a Mystery Gift trade has left a custom
// trainer in SRAM.
//
//   TrainerHouse      engine/events/specials.asm -- sMysteryGiftTrainerHouseFlag
//                     into wScriptVar: CAL2 (the visitor) or CAL3 (the house's).
//   ReadTrainerParty  engine/battle/read_trainer_party.asm -- CAL2 is the ONLY
//                     trainer whose party does not come from parties.asm; its
//                     `.cal2` arm reads sMysteryGiftTrainer instead.
//   GetTrainerName    same file -- with the flag set CAL's name is copied out
//                     of sMysteryGiftPartnerName.
//
// MYSTERY GIFT IS OUT OF SCOPE (one of the six peripheral stubs in
// script/Specials): there is no second cartridge.  So the flag is permanently
// clear -- a cartridge that has never been linked -- and every routine takes
// its no-custom-data arm:
//   * the script gets FALSE both times and fights CAL3 (MEGANIUM, TYPHLOSION,
//     FERALIGATR at 50);
//   * a CAL2 lookup that reaches here anyway is answered with CAL3, because
//     parties.asm's CAL (2) row is DEAD DATA on the cart (ReadTrainerParty
//     branches to SRAM before it ever indexes the table);
//   * the name is the parties table's own "CAL".
//
// The once-a-day gate is not here: ENGINE_FOUGHT_IN_TRAINER_HALL_TODAY is a
// wDailyFlags1 bit, set by the script and cleared by core/Apricorns' daily
// reset.

import { Trainers, type TrainerRecord } from "./Trainers.ts";

export const TrainerHouse = {
  // Lua: TrainerHouse.lua:54 -- constants/trainer_constants.asm: the CAL class
  // and its three members.  CAL1 is the Route 27 battle, CAL2 the Mystery
  // Gift visitor, CAL3 the house's own.
  CAL: 12,
  CAL1: 1,
  CAL2: 2,
  CAL3: 3,

  // Lua: TrainerHouse.lua:60 -- constants/engine_flags.asm index 86, wDailyFlags1
  // bit DAILYFLAGS1_FOUGHT_IN_TRAINER_HALL_TODAY.
  ENGINE_FOUGHT_IN_TRAINER_HALL_TODAY: 86,

  // Lua: TrainerHouse.lua:68 -- sMysteryGiftTrainerHouseFlag (ram/sram.asm).
  // STUB, and a deliberate one: nothing in this port can run the infrared
  // trade that writes it.  A function so the day Mystery Gift lands there is
  // one place to teach about save.mysteryGift.
  hasCustomTrainer(save: any): boolean {
    const gift = save != null && typeof save === "object" ? save.mysteryGift : undefined;
    return !!(gift && gift.trainerHouse != null && gift.trainerHouse !== false);
  },

  // Lua: TrainerHouse.lua:78 -- ReadTrainerParty's `cp CAL / cp CAL2` pair:
  // which member should actually be loaded.  Only CAL2 is ever redirected,
  // and only when there is no custom trainer to redirect it to.
  resolveMember(save: any, cls: number, member: number): number {
    if (cls === TrainerHouse.CAL && member === TrainerHouse.CAL2
      && !TrainerHouse.hasCustomTrainer(save)) {
      return TrainerHouse.CAL3;
    }
    return member;
  },

  // Lua: TrainerHouse.lua:90 -- GetTrainerName's CAL arm.  The name the SRAM
  // copy would have supplied, or undefined for "fall through to the parties
  // table" (`.not_cal2`).
  customName(save: any, cls: number): string | undefined {
    if (cls !== TrainerHouse.CAL) return undefined;
    if (!TrainerHouse.hasCustomTrainer(save)) return undefined;
    const gift = save ? save.mysteryGift : undefined;
    return (gift && gift.partnerName) ?? undefined;
  },

  // Lua: TrainerHouse.lua:99 -- the lookup the World hands to the VM, with
  // the CAL2 redirect applied.  `trainerData` is the trainers table.
  lookup(trainerData: any, save: any, cls: number, member: number): TrainerRecord | undefined {
    return Trainers.lookup(trainerData, cls,
      TrainerHouse.resolveMember(save, cls, member));
  },

  // Lua: TrainerHouse.lua:104
  name(trainerData: any, save: any, cls: number, member: number): string | undefined {
    const custom = TrainerHouse.customName(save, cls);
    if (custom != null && (custom as unknown) !== false) return custom;
    const entry = TrainerHouse.lookup(trainerData, save, cls, member);
    return entry ? entry.name : undefined;
  },

  // Lua: TrainerHouse.lua:116 -- the daily gate, for a reader holding nothing
  // but a save file (the script owns both sides of it in game).
  foughtToday(save: any): boolean {
    const flags = save != null && typeof save === "object" ? save.engineFlags : undefined;
    return (flags ? flags[TrainerHouse.ENGINE_FOUGHT_IN_TRAINER_HALL_TODAY] : undefined) === true;
  },
};

export default TrainerHouse;
