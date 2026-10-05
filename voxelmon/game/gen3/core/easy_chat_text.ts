// Port of gen1recomp src/core/game3/easy_chat_text.lua (GPLv3 + additional terms; see LICENSE.md).
// A word carries its group's context, because the same English word means
// different things in different groups and the official translations do not
// agree on one wording: SHINE is a MOVE in one group and a FEELING in another,
// and words like ATTACK, BAG or CANCEL collide with menu labels this engine
// already translates elsewhere.  Strings() falls back to the plain key when a
// catalog has no context-specific entry, so a translation that does not care
// about the distinction still lands with one entry.

import { format, mod, tostring, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, pairs, len, seq, concat, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Dataset } from "./dataset.ts";
import { Pokemon } from "./pokemon.ts";

/** One easy chat group of the cache's easy_chat/words.lua. */
export interface EcGroup { id: number; name: string; numEnabled?: number; numWords?: number; words: LuaTable }
/** One word of a group: { id, text, value }. */
export interface EcWord { id: number; text: string; value?: number }

let groups: LuaTable | undefined;
let wordMap: Record<number, string> | undefined;

// Lua: easy_chat_text.lua:34
function ensureLoaded(): void {
  if (truthy(groups)) return;
  const rel = EasyChatText.FILE;
  const src = Dataset.cache().read(rel);
  if (!truthy(src)) throw new Error(rel + " is not in the cache");
  const [chunk, err] = luaLoad(src, "@" + rel);
  if (!chunk) throw new Error(err);
  EasyChatText.install(chunk());
}

// src/easy_chat.c:151
// Lua: easy_chat_text.lua:67
const VALUE_GROUPS: Record<number, string> = { 0: "species", 18: "move", 19: "move", 21: "species" };

/** The dataset's own name for one of those ids, or nil when it has none. */
// Lua: easy_chat_text.lua:71
function packName(groupId: number, index: unknown): string | undefined {
  const kind = VALUE_GROUPS[groupId];
  if (!truthy(kind) || typeof index !== "number" || index < 1) return undefined;

  let name: unknown;
  if (kind === "species") {
    name = Pokemon.name(index);
  } else {
    name = Pokemon.moveName(index);
  }

  if (typeof name !== "string" || name === "") return undefined;
  if (name === "-------" || name === "?????") return undefined;
  return name;
}

/**
 * The catalog's answer for the "group|word" key alone, or nil.  Strings()
 * falls back to the plain key, which is the right default for the vocabulary
 * but not for a name the dataset owns, so look the full key up as a source
 * of its own: that is exactly the entry Strings(raw, context) tries first.
 */
// Lua: easy_chat_text.lua:91
function contextEntry(raw: string, context: string): string | undefined {
  const key = context + "|" + raw;
  const hit = Strings.lookup(key);
  if (hit !== key) return hit;
  return undefined;
}

// Lua: easy_chat_text.lua:98
function labelEntry(key: string): string | undefined {
  const hit = Strings.lookup(key);
  if (hit !== key && hit !== "") return hit;
  return undefined;
}

/** One word, given its group and its index within that group. */
// Lua: easy_chat_text.lua:113
function resolve(raw: unknown, groupId: number, index: number): string {
  if (typeof raw !== "string" || raw === "") return truthy(raw) ? (raw as string) : "";
  if (raw === "???") return raw;
  const label = labelEntry(EasyChatText.wordLabel(EasyChatText.encodeWord(groupId, index)));
  if (truthy(label)) return label as string;
  const context = EasyChatText.context(groupId);
  if (truthy(VALUE_GROUPS[groupId])) {
    // A species or move name belongs to the dataset, so only an entry that
    // names the group -- written for this picker on purpose -- comes before
    // it.  The plain key does not: it is shared with menu labels like CUT or
    // FLASH, and one of those should not decide what a move is called here.
    const entry = contextEntry(raw, context);
    if (truthy(entry)) return entry as string;
    return packName(groupId, index) ?? Strings(raw, context);
  }
  return Strings(raw, context);
}

export const EasyChatText = {
  FILE: "data/generated/gba/easy_chat/words.lua",

  // include/constants/easy_chat.h:1091
  EC_WORD_UNDEFINED: 0xFFFF,
  // src/easy_chat_2.c:285
  PASSPHRASE_MYSTERY_EVENT: seq(5178, 6167, 4107, 8207),
  // src/easy_chat_2.c:297
  PASSPHRASE_QUESTIONNAIRE: seq(521, 5131, 4144, 4138),
  // src/easy_chat.c:66
  DEFAULT_PROFILE: seq(2601, 4128, 526, 2611),

  // Lua: easy_chat_text.lua:25
  install(words: any): void {
    const g = truthy(words) ? words.groups : undefined;
    if (!truthy(g)) throw new Error("easy chat words have no groups");
    groups = g;
    const map: Record<number, string> = {};
    wordMap = map;
    for (const [, group] of pairs<EcGroup>(g)) {
      for (const [, w] of ipairs<EcWord>(group.words)) {
        map[w.id] = w.text;
      }
    }
  },

  // Lua: easy_chat_text.lua:41
  groups(): LuaTable {
    ensureLoaded();
    return groups;
  },

  // Lua: easy_chat_text.lua:46
  group(groupId: number): EcGroup | undefined {
    return EasyChatText.groups()[groupId];
  },

  // Lua: easy_chat_text.lua:50
  rawWord(wordId: number | undefined): string {
    if (wordId == null || wordId === EasyChatText.EC_WORD_UNDEFINED) return "";
    ensureLoaded();
    return wordMap![wordId] ?? "???";
  },

  // Lua: easy_chat_text.lua:57 -- include/constants/easy_chat.h:1087; returns groupId, index
  decodeWord(wordId: number | undefined): [number, number] {
    if (wordId == null) return [0, 0];
    return [mod(Math.floor(wordId / 512), 128), mod(wordId, 512)];
  },

  // Lua: easy_chat_text.lua:62
  encodeWord(groupId?: number, index?: number): number {
    return mod(groupId ?? 0, 128) * 512 + mod(index ?? 0, 512);
  },

  // Lua: easy_chat_text.lua:104
  wordLabel(wordId: number): string {
    return format("easyChat.word[%d]", wordId);
  },

  // Lua: easy_chat_text.lua:108
  groupLabel(groupId: number): string {
    return format("easyChat.group[%d]", groupId);
  },

  /** The catalog context for a group id ("easyChat.FEELINGS"). */
  // Lua: easy_chat_text.lua:132
  context(groupId: number): string {
    const group = EasyChatText.group(groupId);
    return "easyChat." + tostring(group && truthy(group.name) ? group.name : groupId);
  },

  /** A group's name as the picker lists it down its left side. */
  // Lua: easy_chat_text.lua:138
  groupName(groupIn: number | EcGroup | undefined): string {
    let group = groupIn;
    if (typeof group === "number") {
      group = EasyChatText.group(group);
    }
    const name = group ? group.name : undefined;
    if (typeof name !== "string" || name === "") return "";
    return labelEntry(EasyChatText.groupLabel((group as EcGroup).id)) ?? Strings(name, "easyChat.group");
  },

  /** One word, by the id the save file stores. */
  // Lua: easy_chat_text.lua:148
  word(wordId: number | undefined): string {
    const raw = EasyChatText.rawWord(wordId);
    if (typeof raw !== "string" || raw === "") return truthy(raw) ? raw : "";
    const [groupId, index] = EasyChatText.decodeWord(wordId);
    return resolve(raw, groupId, index);
  },

  /**
   * A word the picker draws from its own group list, where the group is known
   * without decoding the id.
   */
  // Lua: easy_chat_text.lua:157
  wordInGroup(entry: EcWord | undefined, groupIn: number | EcGroup): string {
    const raw = entry ? entry.text : undefined;
    if (typeof raw !== "string" || raw === "") return truthy(raw) ? (raw as string) : "";
    let group = groupIn;
    if (typeof group === "object" && group !== null) group = group.id;
    const [, index] = EasyChatText.decodeWord((entry as EcWord).id);
    return resolve(raw, group as number, index);
  },

  // Lua: easy_chat_text.lua:166 -- src/easy_chat.c:188
  phrase(wordsIn?: LuaTable, columnsIn?: number, rowsIn?: number): string {
    const words = wordsIn ?? {};
    const columns = columnsIn ?? 2, rows = rowsIn ?? 2;
    const out: LuaTable = seq();
    let index = 1;
    for (let r = 1; r <= rows; r++) {
      const line: LuaTable = seq();
      for (let c = 1; c <= columns; c++) {
        const word = EasyChatText.word(words[index]);
        if (word !== "") line[len(line) + 1] = word;
        index = index + 1;
      }
      out[len(out) + 1] = concat(line, " ");
    }
    return concat(out, "\n");
  },
};

export default EasyChatText;
