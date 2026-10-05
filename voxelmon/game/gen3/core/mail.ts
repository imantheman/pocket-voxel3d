// Port of gen1recomp src/core/game3/mail.lua (GPLv3 + additional terms; see LICENSE.md).
// The save-block mail pool (gSaveBlock1Ptr->mail) and the held-mail helpers
// (pokefirered/src/mail_data.c). The pool is a Lua sequence of MAIL_COUNT
// records (`[null, rec1, ..., rec16]`); a record's `words` is a sequence too.
// mail id N lives at pool[N + 1], as in the Lua.

import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { seq } from "../platform/lt.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MailRecord {
  words: (number | null)[];
  playerName: string;
  trainerId: number;
  species: number;
  itemId: number;
  design?: number;
  [k: string]: any;
}

export interface DaycareMail { message: MailRecord; otName: string; monName: string }

// pokefirered/include/constants/global.h:43
const MAIL_COUNT = 16;
// pokefirered/include/constants/global.h:65
const MAIL_WORDS_COUNT = 9;
// pokefirered/include/constants/global.h:78
const PARTY_SIZE = 6;
// pokefirered/include/constants/items.h:451
const MAIL_NONE = 0xFF;
// pokefirered/include/constants/items.h:4
const ITEM_NONE = 0;
// pokefirered/include/mail.h:21 FIRST_MAIL_IDX
const ITEM_ORANGE_MAIL = 121;
// pokefirered/include/constants/easy_chat.h:1091
const EC_WORD_UNDEFINED = 0xFFFF;
// pokefirered/include/constants/species.h:5
const SPECIES_BULBASAUR = 1;
// pokefirered/include/constants/species.h:208
const SPECIES_UNOWN = 201;
// pokefirered/src/mail_data.c:8
const UNOWN_OFFSET = 30000;
// pokefirered/include/pokemon.h:273
const NUM_UNOWN_FORMS = 28;

// pokefirered/src/mail_data.c:167 ItemIsMail
const MAIL_ITEMS: Record<number, boolean> = {
  121: true, 122: true, 123: true, 124: true,
  125: true, 126: true, 127: true, 128: true,
  129: true, 130: true, 131: true, 132: true,
};

function isTable(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object";
}

// Lua: mail.lua:51
// pokefirered/src/pokemon_icon.c:1080 GetUnownLetterByPersonality
function unown_letter(personality: unknown): number {
  let p = tonumber(personality) ?? 0;
  if (p === 0) return 0;
  p = p % 0x100000000;
  if (p < 0) p += 0x100000000; // Lua % is floored
  const b3 = Math.floor(p / 0x1000000) % 4;
  const b2 = Math.floor(p / 0x10000) % 4;
  const b1 = Math.floor(p / 0x100) % 4;
  return (b3 * 64 + b2 * 16 + b1 * 4 + (p % 4)) % NUM_UNOWN_FORMS;
}

// Lua: mail.lua:148
function set_held_item(mon: any, itemId: number): void {
  mon.item = itemId;
  mon.heldItem = itemId;
}

export const Mail = {
  MAIL_COUNT,
  MAIL_WORDS_COUNT,
  MAIL_NONE,
  PARTY_SIZE,
  ITEM_NONE,
  EC_WORD_UNDEFINED,

  // Lua: mail.lua:40
  isMailItem(itemId: unknown): boolean {
    return MAIL_ITEMS[tonumber(itemId) ?? -1] === true;
  },

  // Lua: mail.lua:45
  // pokefirered/include/mail.h:23 ITEM_TO_MAIL
  designOf(itemId: unknown): number | undefined {
    if (!Mail.isMailItem(itemId)) return undefined;
    return (tonumber(itemId) ?? 0) - ITEM_ORANGE_MAIL;
  },

  // Lua: mail.lua:62
  // pokefirered/src/mail_data.c:75 SpeciesToMailSpecies
  speciesToMailSpecies(species: unknown, personality: unknown): number {
    const s = tonumber(species) ?? 0;
    if (s === SPECIES_UNOWN) {
      return unown_letter(personality) + UNOWN_OFFSET;
    }
    return s;
  },

  // Lua: mail.lua:71 -- [species, unownLetter]
  // pokefirered/src/mail_data.c:84 MailSpeciesToSpecies
  mailSpeciesToSpecies(mailSpecies: unknown): [number, number] {
    const m = tonumber(mailSpecies) ?? 0;
    if (m >= UNOWN_OFFSET && m < UNOWN_OFFSET + NUM_UNOWN_FORMS) {
      return [SPECIES_UNOWN, m - UNOWN_OFFSET];
    }
    return [m, 0];
  },

  // Lua: mail.lua:80
  // pokefirered/src/mail_data.c:18 ClearMailStruct
  clear(record?: any): MailRecord {
    record = isTable(record) ? record : {};
    const words = isTable(record.words) ? record.words : seq<number>();
    for (let i = 1; i <= MAIL_WORDS_COUNT; i++) words[i] = EC_WORD_UNDEFINED;
    record.words = words;
    record.playerName = "";
    record.trainerId = 0;
    record.species = SPECIES_BULBASAUR;
    record.itemId = ITEM_NONE;
    delete record.design;
    return record as MailRecord;
  },

  // Lua: mail.lua:93
  copy(record: any): MailRecord | undefined {
    if (!isTable(record)) return undefined;
    const words = seq<number>();
    for (let i = 1; i <= MAIL_WORDS_COUNT; i++) {
      words[i] = tonumber(record.words != null ? record.words[i] : undefined) ?? EC_WORD_UNDEFINED;
    }
    const out: MailRecord = {
      words,
      playerName: tostring(record.playerName ?? ""),
      trainerId: tonumber(record.trainerId) ?? 0,
      species: tonumber(record.species) ?? SPECIES_BULBASAUR,
      itemId: tonumber(record.itemId) ?? ITEM_NONE,
    };
    const design = tonumber(record.design);
    if (design != null) out.design = design;
    return out;
  },

  // Lua: mail.lua:109
  isEmpty(record: any): boolean {
    return !isTable(record) || (tonumber(record.itemId) ?? ITEM_NONE) === ITEM_NONE;
  },

  // Lua: mail.lua:114
  // pokefirered/include/global.h:798 gSaveBlock1Ptr->mail
  pool(session: any): any {
    if (!isTable(session)) return undefined;
    let pool = session.mail;
    if (!isTable(pool)) {
      pool = seq();
      session.mail = pool;
    }
    for (let i = 1; i <= MAIL_COUNT; i++) {
      if (!isTable(pool[i])) pool[i] = Mail.clear(undefined);
    }
    return pool;
  },

  // Lua: mail.lua:127
  slot(session: any, mailId: unknown): MailRecord | undefined {
    const id = tonumber(mailId);
    if (id == null || id === MAIL_NONE || id < 0 || id >= MAIL_COUNT) return undefined;
    const pool = Mail.pool(session);
    return (pool && pool[id + 1]) || undefined;
  },

  // Lua: mail.lua:134
  get(session: any, mailId: unknown): MailRecord | undefined {
    const record = Mail.slot(session, mailId);
    if (Mail.isEmpty(record)) return undefined;
    return record;
  },

  // Lua: mail.lua:141
  // pokefirered/src/mail_data.c:32 MonHasMail
  monHasMail(mon: any): boolean {
    if (!isTable(mon)) return false;
    const mailId = tonumber(mon.mail);
    if (mailId == null || mailId === MAIL_NONE) return false;
    return Mail.isMailItem(mon.item ?? mon.heldItem);
  },

  // Lua: mail.lua:154
  // pokefirered/src/mail_data.c:41 GiveMailToMon
  giveMailToMon(session: any, mon: any, itemIdIn: unknown): number {
    const itemId = tonumber(itemIdIn) ?? ITEM_NONE;
    const pool = Mail.pool(session);
    if (!(pool && isTable(mon))) return MAIL_NONE;
    for (let id = 0; id <= PARTY_SIZE - 1; id++) {
      const record = pool[id + 1];
      if ((tonumber(record.itemId) ?? ITEM_NONE) === ITEM_NONE) {
        Mail.clear(record);
        record.playerName = tostring(session.name ?? session.playerName ?? "");
        record.trainerId = tonumber(session.trainerId ?? session.id ?? session.playerId) ?? 0;
        record.species = Mail.speciesToMailSpecies(mon.species ?? mon.speciesId, mon.personality);
        record.itemId = itemId;
        record.design = Mail.designOf(itemId);
        if (record.design == null) delete record.design;
        mon.mail = id;
        set_held_item(mon, itemId);
        return id;
      }
    }
    return MAIL_NONE;
  },

  // Lua: mail.lua:176
  // pokefirered/src/mail_data.c:100 GiveMailToMon2
  giveMailToMon2(session: any, mon: any, record: any): number {
    if (!isTable(record)) return MAIL_NONE;
    const itemId = tonumber(record.itemId) ?? ITEM_NONE;
    const mailId = Mail.giveMailToMon(session, mon, itemId);
    if (mailId === MAIL_NONE) return MAIL_NONE;
    const pool = Mail.pool(session);
    pool[mailId + 1] = Mail.copy(record);
    mon.mail = mailId;
    set_held_item(mon, itemId);
    return mailId;
  },

  // Lua: mail.lua:189
  // pokefirered/src/mail_data.c:123 TakeMailFromMon
  takeMailFromMon(session: any, mon: any): MailRecord | undefined {
    if (!Mail.monHasMail(mon)) return undefined;
    const record = Mail.slot(session, mon.mail);
    if (record) record.itemId = ITEM_NONE;
    delete mon.mail;
    set_held_item(mon, ITEM_NONE);
    return record;
  },

  // Lua: mail.lua:199
  // pokefirered/src/daycare.c:427 StorePokemonInDaycare
  takeMonMailForDaycare(session: any, mon: any, otName: unknown, monName: unknown): DaycareMail | undefined {
    if (!Mail.monHasMail(mon)) return undefined;
    const message = Mail.copy(Mail.slot(session, mon.mail));
    Mail.takeMailFromMon(session, mon);
    if (!message) return undefined;
    // pokefirered/include/global.h:533 struct DayCareMail
    return { message, otName: tostring(otName ?? ""), monName: tostring(monName ?? "") };
  },

  // Lua: mail.lua:209
  // pokefirered/src/daycare.c:526 TakeSelectedPokemonFromDaycare
  giveDaycareMailToMon(session: any, mon: any, daycareMail: any): boolean {
    if (!isTable(daycareMail)) return false;
    const message = daycareMail.message;
    if (Mail.isEmpty(message)) return false;
    if (Mail.giveMailToMon2(session, mon, message) === MAIL_NONE) return false;
    // pokefirered/src/daycare.c:614 ClearDaycareMonMail
    daycareMail.otName = "";
    daycareMail.monName = "";
    Mail.clear(message);
    return true;
  },

  // Lua: mail.lua:221
  export(session: any): any {
    if (!isTable(session) || !isTable(session.mail)) return undefined;
    const pool = Mail.pool(session);
    if (!pool) return undefined;
    const out: any = seq();
    let used = false;
    for (let i = 1; i <= MAIL_COUNT; i++) {
      out[i] = Mail.copy(pool[i]);
      if (!Mail.isEmpty(out[i])) used = true;
    }
    if (!used) return undefined;
    return out;
  },

  // Lua: mail.lua:234
  restore(saved: any): any {
    if (!isTable(saved)) return undefined;
    const pool: any = seq();
    for (let i = 1; i <= MAIL_COUNT; i++) {
      const record = saved[i];
      pool[i] = (isTable(record) && Mail.copy(record)) || Mail.clear(undefined);
    }
    return pool;
  },
};

export default Mail;
