// Port of gen1recomp src/import/gba/battle_ai_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/battle_ai_script_commands.c:147, data/battle_ai_scripts.s:17
// Lua differences: the table / body / list sequences are 0-based arrays.

import { format } from "./lua.ts";
import { Versions } from "./versions.ts";
import { serialize_lua } from "./extract_scripts.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Tbl = Record<string, any>;

const B = "b", S = "s", H = "h", W = "w", P = "p", L = "l", LH = "lh";

type OpSpec = [string, ...[string, string][]];

// asm/macros/battle_ai_script.inc:1
const OPS: Record<number, OpSpec> = {
  [0x00]: ["if_random_less_than", ["value", B], ["target", P]],
  [0x01]: ["if_random_greater_than", ["value", B], ["target", P]],
  // src/battle_ai_script_commands.c:509
  [0x02]: ["if_random_equal", ["value", B], ["target", P]],
  [0x03]: ["if_random_not_equal", ["value", B], ["target", P]],
  [0x04]: ["score", ["delta", S]],
  [0x05]: ["if_hp_less_than", ["battler", B], ["percent", B], ["target", P]],
  [0x06]: ["if_hp_more_than", ["battler", B], ["percent", B], ["target", P]],
  [0x07]: ["if_hp_equal", ["battler", B], ["percent", B], ["target", P]],
  [0x08]: ["if_hp_not_equal", ["battler", B], ["percent", B], ["target", P]],
  [0x09]: ["if_status", ["battler", B], ["status", W], ["target", P]],
  [0x0A]: ["if_not_status", ["battler", B], ["status", W], ["target", P]],
  [0x0B]: ["if_status2", ["battler", B], ["status", W], ["target", P]],
  [0x0C]: ["if_not_status2", ["battler", B], ["status", W], ["target", P]],
  [0x0D]: ["if_status3", ["battler", B], ["status", W], ["target", P]],
  [0x0E]: ["if_not_status3", ["battler", B], ["status", W], ["target", P]],
  [0x0F]: ["if_side_affecting", ["battler", B], ["status", W], ["target", P]],
  [0x10]: ["if_not_side_affecting", ["battler", B], ["status", W], ["target", P]],
  [0x11]: ["if_less_than", ["value", B], ["target", P]],
  [0x12]: ["if_more_than", ["value", B], ["target", P]],
  [0x13]: ["if_equal", ["value", B], ["target", P]],
  [0x14]: ["if_not_equal", ["value", B], ["target", P]],
  [0x15]: ["if_less_than_ptr", ["ptr", W], ["target", P]],
  [0x16]: ["if_more_than_ptr", ["ptr", W], ["target", P]],
  [0x17]: ["if_equal_ptr", ["ptr", W], ["target", P]],
  [0x18]: ["if_not_equal_ptr", ["ptr", W], ["target", P]],
  [0x19]: ["if_move", ["move", H], ["target", P]],
  [0x1A]: ["if_not_move", ["move", H], ["target", P]],
  [0x1B]: ["if_in_bytes", ["list", L], ["target", P]],
  [0x1C]: ["if_not_in_bytes", ["list", L], ["target", P]],
  [0x1D]: ["if_in_hwords", ["list", LH], ["target", P]],
  [0x1E]: ["if_not_in_hwords", ["list", LH], ["target", P]],
  [0x1F]: ["if_user_has_attacking_move", ["target", P]],
  [0x20]: ["if_user_has_no_attacking_moves", ["target", P]],
  [0x21]: ["get_turn_count"],
  [0x22]: ["get_type", ["which", B]],
  [0x23]: ["get_considered_move_power"],
  [0x24]: ["get_how_powerful_move_is"],
  [0x25]: ["get_last_used_move", ["battler", B]],
  [0x26]: ["if_equal_", ["value", B], ["target", P]],
  [0x27]: ["if_not_equal_", ["value", B], ["target", P]],
  [0x28]: ["if_would_go_first", ["battler", B], ["target", P]],
  [0x29]: ["if_would_not_go_first", ["battler", B], ["target", P]],
  [0x2A]: ["ai_2a"],
  [0x2B]: ["ai_2b"],
  [0x2C]: ["count_alive_pokemon", ["battler", B]],
  [0x2D]: ["get_considered_move"],
  [0x2E]: ["get_considered_move_effect"],
  [0x2F]: ["get_ability", ["battler", B]],
  [0x30]: ["get_highest_type_effectiveness"],
  [0x31]: ["if_type_effectiveness", ["effectiveness", B], ["target", P]],
  [0x32]: ["ai_32"],
  [0x33]: ["ai_33"],
  [0x34]: ["if_status_in_party", ["battler", B], ["status", W], ["target", P]],
  [0x35]: ["if_status_not_in_party", ["battler", B], ["status", W], ["target", P]],
  [0x36]: ["get_weather"],
  [0x37]: ["if_effect", ["effect", B], ["target", P]],
  [0x38]: ["if_not_effect", ["effect", B], ["target", P]],
  [0x39]: ["if_stat_level_less_than", ["battler", B], ["stat", B], ["level", B], ["target", P]],
  [0x3A]: ["if_stat_level_more_than", ["battler", B], ["stat", B], ["level", B], ["target", P]],
  [0x3B]: ["if_stat_level_equal", ["battler", B], ["stat", B], ["level", B], ["target", P]],
  [0x3C]: ["if_stat_level_not_equal", ["battler", B], ["stat", B], ["level", B], ["target", P]],
  [0x3D]: ["if_can_faint", ["target", P]],
  [0x3E]: ["if_cant_faint", ["target", P]],
  [0x3F]: ["if_has_move", ["battler", B], ["move", H], ["target", P]],
  [0x40]: ["if_doesnt_have_move", ["battler", B], ["move", H], ["target", P]],
  [0x41]: ["if_has_move_with_effect", ["battler", B], ["effect", B], ["target", P]],
  [0x42]: ["if_doesnt_have_move_with_effect", ["battler", B], ["effect", B], ["target", P]],
  [0x43]: ["if_any_move_disabled_or_encored", ["battler", B], ["which", B], ["target", P]],
  [0x44]: ["if_curr_move_disabled_or_encored", ["battler", B], ["target", P]],
  [0x45]: ["flee"],
  [0x46]: ["if_random_safari_flee", ["target", P]],
  [0x47]: ["watch"],
  [0x48]: ["get_hold_effect", ["battler", B]],
  [0x49]: ["get_gender", ["battler", B]],
  [0x4A]: ["is_first_turn_for", ["battler", B]],
  [0x4B]: ["get_stockpile_count", ["battler", B]],
  [0x4C]: ["is_double_battle"],
  [0x4D]: ["get_used_held_item", ["battler", B]],
  [0x4E]: ["get_move_type_from_result"],
  [0x4F]: ["get_move_power_from_result"],
  [0x50]: ["get_move_effect_from_result"],
  [0x51]: ["get_protect_count", ["battler", B]],
  [0x52]: ["ai_52"],
  [0x53]: ["ai_53"],
  [0x54]: ["ai_54"],
  [0x55]: ["ai_55"],
  [0x56]: ["ai_56"],
  [0x57]: ["ai_57"],
  [0x58]: ["call", ["target", P]],
  [0x59]: ["goto", ["target", P]],
  [0x5A]: ["end"],
  [0x5B]: ["if_level_cond", ["cond", B], ["target", P]],
  [0x5C]: ["if_target_taunted", ["target", P]],
  [0x5D]: ["if_target_not_taunted", ["target", P]],
  // pokeemerald/asm/macros/battle_ai_script.inc:524
  [0x5E]: ["if_target_is_ally", ["target", P]],
  [0x5F]: ["is_of_type", ["battler", B], ["type", B]],
  [0x60]: ["check_ability", ["battler", B], ["ability", B]],
  [0x61]: ["if_flash_fired", ["battler", B], ["target", P]],
  [0x62]: ["if_holds_item", ["battler", B], ["item", H], ["target", P]],
};

const TERMINAL: Record<string, boolean> = { end: true, goto: true, flee: true, watch: true };

// Lua: battle_ai_extract.lua:122
function label(off: number): string {
  return format("0x%06X", off);
}

// Lua: battle_ai_extract.lua:126
function target_offset(rom: Rom, ptr: number, at: number): number {
  const off = rom.ptrOffset(ptr);
  if (off === undefined) {
    throw new Error(format("battle_ai: bad pointer 0x%08X at 0x%06X", ptr, at));
  }
  return off;
}

// Lua: battle_ai_extract.lua:134
function read_list(rom: Rom, off: number, hword: boolean): number[] {
  const out: number[] = [];
  let i = 0;
  for (;;) {
    const v = hword ? rom.u16(off + i * 2) : rom.get(off + i);
    out.push(v);
    i = i + 1;
    if (v === (hword ? 0xFFFF : 0xFF)) return out;
    if (i > 512) throw new Error(format("battle_ai: unterminated list at 0x%06X", off));
  }
}

// Lua: battle_ai_extract.lua:145
function decode_body(rom: Rom, start: number, queue: number[], data: Record<string, number[]>): Tbl[] {
  const body: Tbl[] = [];
  let off = start;
  for (;;) {
    const opcode = rom.get(off);
    const spec = OPS[opcode];
    if (!spec) {
      throw new Error(format("battle_ai: unknown command 0x%02X at 0x%06X", opcode, off));
    }
    const ir: Tbl = { op: spec[0] };
    let at = off + 1;
    for (let i = 1; i < spec.length; i++) {
      const [field, kind] = spec[i] as [string, string];
      if (kind === B) {
        ir[field] = rom.get(at);
        at = at + 1;
      } else if (kind === S) {
        const v = rom.get(at);
        ir[field] = v >= 128 ? v - 256 : v;
        at = at + 1;
      } else if (kind === H) {
        ir[field] = rom.u16(at);
        at = at + 2;
      } else if (kind === W) {
        ir[field] = rom.u32(at);
        at = at + 4;
      } else if (kind === P) {
        const dest = target_offset(rom, rom.u32(at), at);
        ir[field] = label(dest);
        queue.push(dest);
        at = at + 4;
      } else {
        const dest = target_offset(rom, rom.u32(at), at);
        const name = label(dest);
        data[name] = data[name] ?? read_list(rom, dest, kind === LH);
        ir[field] = name;
        at = at + 4;
      }
    }
    body.push(ir);
    off = at;
    if (TERMINAL[ir.op]) return body;
  }
}

export const BattleAiExtract = {
  FORMAT_VERSION: 2,
  CACHE_SUB: "battle_ai",
  FILE: "pack.lua",
  REQUIRED: ["battle_ai/pack.lua"],
  OPS,

  // Lua: battle_ai_extract.lua:189
  extract(rom: Rom): Tbl {
    const scripts: Record<string, Tbl[]> = {}, data: Record<string, number[]> = {};
    const tableNames: string[] = [], queue: number[] = [];
    for (let i = 0; i <= Versions.BATTLE_AI_SCRIPT_COUNT - 1; i++) {
      const at = Versions.BATTLE_AI_SCRIPTS_TABLE + i * 4;
      const entry = target_offset(rom, rom.u32(at), at);
      tableNames[i] = label(entry);
      queue.push(entry);
    }
    let head = 0;
    while (head < queue.length) {
      const off = queue[head]!;
      head = head + 1;
      const name = label(off);
      if (!scripts[name]) {
        scripts[name] = decode_body(rom, off, queue, data);
      }
    }
    return {
      version: BattleAiExtract.FORMAT_VERSION,
      table: tableNames,
      scripts,
      data,
    };
  },

  // Lua: battle_ai_extract.lua:214
  ready(cache: Cache | undefined, root?: string): boolean {
    const rel = (root ?? "data/generated/gba") + "/" + BattleAiExtract.CACHE_SUB + "/" + BattleAiExtract.FILE;
    return (cache && cache.exists && cache.exists(rel)) ? true : false;
  },

  // Lua: battle_ai_extract.lua:219
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): Tbl {
    const rel = (opts.cacheRoot ?? "data/generated/gba") + "/" + BattleAiExtract.CACHE_SUB
      + "/" + BattleAiExtract.FILE;
    const pack = BattleAiExtract.extract(rom);
    cache.write(rel, "return " + serialize_lua(pack) + "\n");
    const count = Object.keys(pack.scripts).length;
    console.log(format("[battle_ai_extract] %d entry scripts, %d bodies -> %s",
      pack.table.length, count, rel));
    return { path: rel, scriptCount: count, tableCount: pack.table.length, pack };
  },
};

export default BattleAiExtract;
