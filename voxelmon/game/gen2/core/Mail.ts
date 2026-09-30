// gen1recomp src/core/gen2/Mail.lua at bdfac727 (MIT): the ten mail items,
// the letter a party mon carries, and the MAILBOX the PC keeps
// (engine/pokemon/mail.asm, mail_2.asm; the `mailmsg` struct of ram/sram.asm).
//
// sPartyMail is six structs indexed BY PARTY SLOT, not by mon, which is why
// removeSlot / swapSlots exist: a departing mon shifts the letters behind it.
//
// Indexing: party slots and mailbox indices in this API stay 1-based as the
// Lua passes them; storage is `save.mail.party[slot - 1]` (sparse JS array)
// and `save.mail.box[index - 1]` (dense JS array).

import { Runtime } from "../shared/mods/Runtime.ts";
import { removeAt, sortedKeys, sub, tonumber, tostring, truthy } from "../platform/lua.ts";

/** One `mailmsg` struct. */
export interface MailEntry {
  /** the MAIL item id, which picks the stationery */
  type: string;
  /** up to MAIL_MSG_LENGTH characters; a "\n" is one character */
  message: string;
  author: string;
  authorId: number;
  species?: any;
}

/** save.mail: sPartyMail (sparse, slot s at party[s - 1]) and sMailboxes. */
export interface MailState {
  party: (MailEntry | undefined)[];
  box: MailEntry[];
}

/** One report.lostMail row. `slot` is the Lua slot (1-based), or the raw key when out of range. */
export interface LostMail {
  where: "party" | "box" | "mail";
  slot?: number | string;
  why: string;
}

type SaveLike = Record<string, any> | null | undefined;

// Lua: Mail.lua:45-48 -- data/items/mail_items.asm MailItems, in its order.
const ITEMS: string[] = [
  "FLOWER_MAIL", "SURF_MAIL", "LITEBLUEMAIL", "PORTRAITMAIL", "LOVELY_MAIL",
  "EON_MAIL", "MORPH_MAIL", "BLUESKY_MAIL", "MUSIC_MAIL", "MIRAGE_MAIL",
];

// Lua: Mail.lua:55-60 -- the 0-based *_MAIL_INDEX block of mail_2.asm.
const INDEX: Record<string, number> = {};
const IS_MAIL: Record<string, boolean> = {};
ITEMS.forEach((id, i) => {
  INDEX[id] = i;
  IS_MAIL[id] = true;
});

// Lua: Mail.lua:181-187 -- mail.written (a Gen 2 invention).
function emitWritten(entry: MailEntry, slot: number, mon: any, source: "compose" | "script"): void {
  if (!Runtime.wants("mail.written")) return;
  Runtime.emit("mail.written", {
    entry, slot, mon,
    message: entry.message, author: entry.author, source,
  });
}

// Lua: Mail.lua:276 -- the mail.read latch (one event per opened letter).
let lastRead: MailEntry | undefined;

// Lua: Mail.lua:282-294
function emitRead(entry: unknown, top: string, bottom: string): void {
  if (entry === null || typeof entry !== "object") return;
  if (!Runtime.wants("mail.read")) {
    lastRead = undefined;
    return;
  }
  if (lastRead === entry) return;
  lastRead = entry as MailEntry;
  const e = entry as MailEntry;
  Runtime.emit("mail.read", {
    entry, message: e.message, author: e.author,
    top, bottom,
  });
}

// Lua: Mail.lua:434-451 -- returns [clean, why] (the Lua's two values).
function cleanEntry(entry: any): [MailEntry | undefined, string | undefined] {
  if (entry === null || typeof entry !== "object") return [undefined, "not a struct"];
  if (!Mail.isMail(entry.type)) return [undefined, "not a MAIL item"];
  const message = tostring(truthy(entry.message) ? entry.message : "");
  const trimmed = Mail.trim(message);
  const author = sub(tostring(truthy(entry.author) ? entry.author : ""), 1, Mail.AUTHOR_LENGTH);
  let authorId = tonumber(entry.authorId) ?? 0;
  if (authorId !== Math.floor(authorId) || authorId < 0 || authorId > 0xffff) {
    authorId = 0;
  }
  return [{
    type: entry.type,
    message: trimmed,
    author,
    authorId,
    species: entry.species,
  }, trimmed !== message ? "message trimmed" : undefined];
}

export const Mail = {
  // Lua: Mail.lua:31-39 -- constants/item_data_constants.asm etc.
  MAIL_MSG_LENGTH: 0x20,
  MAIL_LINE_LENGTH: 0x10,
  MAILBOX_CAPACITY: 10,
  /** NAME_LENGTH - 1 */
  AUTHOR_LENGTH: 10,
  PARTY_LENGTH: 6,

  ITEMS,
  INDEX,

  // Lua: Mail.lua:63-67 -- POKEMAIL_* (const_def, 0-based).
  POKEMAIL_WRONG_MAIL: 0,
  POKEMAIL_CORRECT: 1,
  POKEMAIL_REFUSED: 2,
  POKEMAIL_NO_MAIL: 3,
  POKEMAIL_LAST_MON: 4,

  /** Lua: Mail.lua:72 -- ItemIsMail, the cart's only definition of mail. */
  isMail(itemId: unknown): boolean {
    return itemId != null && IS_MAIL[itemId as string] === true;
  },

  /** Lua: Mail.lua:76 */
  monHoldsMail(mon: any): boolean {
    return mon !== null && typeof mon === "object" && Mail.isMail(mon.item);
  },

  // ---- Storage ----------------------------------------------------------

  /**
   * Lua: Mail.lua:88 -- save.mail, created on demand ({party: [], box: []}),
   * with either half filled in when missing. A non-table save gets a
   * throwaway state.
   */
  state(save: SaveLike): MailState {
    if (save === null || typeof save !== "object") return { party: [], box: [] };
    let state = save.mail;
    if (state === null || typeof state !== "object") {
      state = { party: [], box: [] };
      save.mail = state;
    }
    state.party = truthy(state.party) ? state.party : [];
    state.box = truthy(state.box) ? state.box : [];
    return state as MailState;
  },

  /** Lua: Mail.lua:103 -- one `mailmsg`. */
  entry(itemId: string, message?: string, author?: string, authorId?: number, species?: any): MailEntry {
    return {
      type: itemId,
      message: truthy(message) ? message! : "",
      author: truthy(author) ? author! : "",
      authorId: truthy(authorId) ? authorId! : 0,
      species,
    };
  },

  /** Lua: Mail.lua:116 -- a party letter (slot 1-based); re-arms the read latch. */
  get(save: SaveLike, slot: number): MailEntry | undefined {
    Mail.armRead();
    return Mail.state(save).party[slot - 1];
  },

  /** Lua: Mail.lua:121 */
  set(save: SaveLike, slot: number, entry: MailEntry | undefined): boolean {
    if (!(truthy(slot) && slot >= 1 && slot <= Mail.PARTY_LENGTH)) return false;
    Mail.state(save).party[slot - 1] = entry;
    return true;
  },

  /** Lua: Mail.lua:127 */
  clear(save: SaveLike, slot: number): void {
    delete Mail.state(save).party[slot - 1];
  },

  /** Lua: Mail.lua:136 -- RemoveMonFromPartyOrBox's "Mail time!" shift-up. */
  removeSlot(save: SaveLike, slot: number): void {
    const party = Mail.state(save).party;
    if (!(truthy(slot) && slot >= 1)) return;
    for (let i = slot; i <= Mail.PARTY_LENGTH - 1; i++) {
      if (party[i] === undefined) delete party[i - 1];
      else party[i - 1] = party[i];
    }
    delete party[Mail.PARTY_LENGTH - 1];
  },

  /** Lua: Mail.lua:147 -- SwitchPartyMons carries each letter with its mon. */
  swapSlots(save: SaveLike, a: number, b: number): void {
    const party = Mail.state(save).party;
    const pa = party[a - 1];
    const pb = party[b - 1];
    if (pb === undefined) delete party[a - 1];
    else party[a - 1] = pb;
    if (pa === undefined) delete party[b - 1];
    else party[b - 1] = pa;
  },

  /** Lua: Mail.lua:155 -- IsAnyMonHoldingMail. */
  anyMonHoldingMail(save: SaveLike): boolean {
    const party: any[] = (save && save.party) || [];
    for (const mon of party) {
      if (mon == null) break; // ipairs stops at the first hole
      if (Mail.monHoldsMail(mon)) return true;
    }
    return false;
  },

  // ---- Writing ----------------------------------------------------------

  /** Lua: Mail.lua:194 -- ComposeMailMessage's tail (mon_menu.asm). */
  compose(save: SaveLike, slot: number, message: string, mon: any, itemId: string): boolean {
    if (!(truthy(save) && truthy(slot) && truthy(itemId))) return false;
    const player = save!.player || {};
    const entry = Mail.entry(itemId, Mail.trim(message),
      sub(player.name || "", 1, Mail.AUTHOR_LENGTH), player.id || 0,
      mon && mon.species);
    const ok = Mail.set(save, slot, entry);
    if (ok) emitWritten(entry, slot, mon, "compose");
    return ok;
  },

  /** Lua: Mail.lua:209 -- GivePokeMail: the letter lands on the LAST party member. */
  give(save: SaveLike, itemId: string, message: string): boolean {
    const party: any[] | undefined = save ? save.party : undefined;
    if (!(party && party.length > 0 && Mail.isMail(itemId))) return false;
    const slot = party.length;
    const mon = party[slot - 1];
    mon.item = itemId;
    const entry = Mail.entry(itemId, Mail.trim(message),
      sub(tostring(mon.otName || mon.ot || ""), 1, Mail.AUTHOR_LENGTH),
      mon.otId || 0, mon.species);
    const ok = Mail.set(save, slot, entry);
    if (ok) emitWritten(entry, slot, mon, "script");
    return ok;
  },

  /** Lua: Mail.lua:227 -- trim to MAIL_MSG_LENGTH characters (not bytes). */
  trim(message: unknown): string {
    const text = tostring(truthy(message) ? message : "");
    const out: string[] = [];
    let count = 0;
    for (const ch of Mail.characters(text)) {
      if (count >= Mail.MAIL_MSG_LENGTH) break;
      out.push(ch);
      count = count + 1;
    }
    return out.join("");
  },

  /**
   * Lua: Mail.lua:240 -- the Lua walks UTF-8 bytes so "é" is one character;
   * a JS string iterates by code point, which is the same split.
   */
  characters(text: string): string[] {
    return Array.from(text);
  },

  /** Lua: Mail.lua:278 */
  armRead(): void {
    lastRead = undefined;
  },

  /**
   * Lua: Mail.lua:296 -- MailGFX_PlaceMessage's two rows. Returns
   * [top, bottom] (the Lua's two values): split on "\n" if the message has
   * one, else by MAIL_LINE_LENGTH characters.
   */
  lines(entry: MailEntry | undefined | null): [string, string] {
    const message: string = (entry !== null && typeof entry === "object" && truthy(entry.message) ? entry.message : "") as string;
    let top: string;
    let bottom: string;
    const nl = message.indexOf("\n");
    if (nl >= 0) {
      top = message.slice(0, nl);
      bottom = message.slice(nl + 1);
    } else {
      const chars = Mail.characters(message);
      if (chars.length <= Mail.MAIL_LINE_LENGTH) {
        top = message;
        bottom = "";
      } else {
        top = chars.slice(0, Mail.MAIL_LINE_LENGTH).join("");
        bottom = chars.slice(Mail.MAIL_LINE_LENGTH).join("");
      }
    }
    emitRead(entry, top, bottom);
    return [top, bottom];
  },

  // ---- The MAILBOX --------------------------------------------------------

  /** Lua: Mail.lua:316 */
  mailboxCount(save: SaveLike): number {
    return Mail.state(save).box.length;
  },

  /** Lua: Mail.lua:322 -- sMailboxes; re-arms the read latch. */
  mailbox(save: SaveLike): MailEntry[] {
    Mail.armRead();
    return Mail.state(save).box;
  },

  /** Lua: Mail.lua:327 */
  mailboxFull(save: SaveLike): boolean {
    return Mail.mailboxCount(save) >= Mail.MAILBOX_CAPACITY;
  },

  /**
   * Lua: Mail.lua:336 -- SendMailToPC: false when the mon holds no mail or
   * the MAILBOX is full; on success the struct moves, the slot is cleared
   * and the mon's item is cleared.
   */
  sendToPc(save: SaveLike, slot: number): boolean {
    const mon = save && save.party && save.party[slot - 1];
    if (!(mon && Mail.monHoldsMail(mon))) return false;
    if (Mail.mailboxFull(save)) return false;
    const state = Mail.state(save);
    let entry = state.party[slot - 1];
    if (!entry) {
      // A mail ITEM with no struct behind it: the cart would copy zero
      // bytes, so send a blank letter rather than dropping the item.
      entry = Mail.entry(mon.item, "", "", 0, mon.species);
    }
    state.box.push(entry);
    delete state.party[slot - 1];
    mon.item = undefined;
    return true;
  },

  /** Lua: Mail.lua:356 -- DeleteMailFromPC (index 1-based); the removed entry. */
  deleteFromPc(save: SaveLike, index: number): MailEntry | undefined {
    const box = Mail.state(save).box;
    if (!box[index - 1]) return undefined;
    return removeAt(box, index);
  },

  /** Lua: Mail.lua:366 -- MoveMailFromPCToParty (index, slot 1-based). */
  moveFromPcToParty(save: SaveLike, index: number, slot: number): boolean {
    const box = Mail.state(save).box;
    const entry = box[index - 1];
    const mon = save && save.party && save.party[slot - 1];
    if (!(entry && mon)) return false;
    Mail.set(save, slot, entry);
    mon.item = entry.type;
    removeAt(box, index);
    return true;
  },

  // ---- CheckPokeMail ----------------------------------------------------

  /**
   * Lua: Mail.lua:394 -- CheckPokeMail (mail.asm). `slot` is 1-based, or
   * undefined for the B press. Returns a POKEMAIL_* code; on CORRECT the
   * mon leaves the party and the mail shifts with it.
   */
  checkPokeMail(save: SaveLike, slot: number | undefined | null, expected: unknown): number {
    if (!truthy(slot)) return Mail.POKEMAIL_REFUSED;
    const s = slot as number;
    const mon = save && save.party && save.party[s - 1];
    if (!(mon && Mail.monHoldsMail(mon))) return Mail.POKEMAIL_NO_MAIL;
    const entry = Mail.get(save, s);
    const got: string = (entry && entry.message) || "";
    if (typeof expected !== "string" || expected === "") {
      // No expected message resolved: WRONG_MAIL changes nothing.
      return Mail.POKEMAIL_WRONG_MAIL;
    }
    if (sub(got, 1, expected.length) !== expected) {
      return Mail.POKEMAIL_WRONG_MAIL;
    }
    // CheckCurPartyMonFainted: carry when this is the last conscious mon.
    let healthy = 0;
    const party: any[] = save!.party;
    for (let i = 1; i <= party.length; i++) {
      const member = party[i - 1];
      if (member == null) break;
      if (i !== s && (member.hp || 0) > 0) healthy = healthy + 1;
    }
    if ((mon.hp || 0) > 0 && healthy === 0) return Mail.POKEMAIL_LAST_MON;
    removeAt(party, s);
    Mail.removeSlot(save, s);
    return Mail.POKEMAIL_CORRECT;
  },

  // ---- Save hygiene -----------------------------------------------------

  /**
   * Lua: Mail.lua:454 -- quarantine pass over save.mail. Rebuilds
   * save.mail.party (sparse array, slot s at [s - 1]) and save.mail.box
   * (at most MAILBOX_CAPACITY), each entry cleaned to a MailEntry; drops or
   * trims what the cart could not have written and appends a row per
   * problem to report.lostMail (created if missing). Returns that list.
   *
   * state.party is read as the brief's sparse array (index i = slot i + 1);
   * a plain object (a Lua table decoded with its own keys) is read with its
   * keys as the Lua slot numbers.
   */
  validate(save: SaveLike, report?: { lostMail?: LostMail[]; [k: string]: any } | null): LostMail[] {
    const lost: LostMail[] = (report && report.lostMail) || [];
    if (report) report.lostMail = lost;
    if (save === null || typeof save !== "object") return lost;
    const raw = save.mail;
    if (raw != null && typeof raw !== "object") {
      lost.push({ where: "mail", why: "not a table" });
      save.mail = undefined;
    }
    const state = Mail.state(save);

    const party: (MailEntry | undefined)[] = [];
    const rawParty: Record<string, any> = state.party as any;
    const isArray = Array.isArray(rawParty);
    for (const key of sortedKeys(rawParty)) {
      const entry = rawParty[key];
      if (entry === undefined) continue; // a hole: pairs() never sees it
      const n = tonumber(key);
      const slot = n === undefined ? undefined : isArray ? n + 1 : n;
      if (!(slot !== undefined && slot === Math.floor(slot)
          && slot >= 1 && slot <= Mail.PARTY_LENGTH)) {
        lost.push({ where: "party", slot: isArray && slot !== undefined ? slot : key, why: "slot out of range" });
      } else {
        const [clean, why] = cleanEntry(entry);
        if (clean) {
          party[slot - 1] = clean;
          if (why) {
            lost.push({ where: "party", slot, why });
          }
        } else {
          lost.push({ where: "party", slot, why: why! });
        }
      }
    }
    state.party = party;

    const box: MailEntry[] = [];
    const rawBox: any[] = Array.isArray(state.box) ? state.box : [];
    for (const entry of rawBox) {
      if (entry == null) break; // ipairs stops at the first hole
      const [clean, why] = cleanEntry(entry);
      if (!clean) {
        lost.push({ where: "box", slot: box.length + 1, why: why! });
      } else if (box.length >= Mail.MAILBOX_CAPACITY) {
        lost.push({ where: "box", slot: box.length + 1, why: "MAILBOX full" });
      } else {
        box.push(clean);
        if (why) {
          lost.push({ where: "box", slot: box.length, why });
        }
      }
    }
    state.box = box;
    return lost;
  },
};

export default Mail;
