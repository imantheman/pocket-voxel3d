// Port of gen1recomp src/ui/game3/start_menu_frlg.lua (GPLv3 + additional terms; see LICENSE.md).
// The FRLG start menu's entries (pokefirered/src/start_menu.c).

import { format } from "../../../import/gen3/lua.ts";
import { len, seq } from "../platform/lt.ts";
import { RomText } from "../core/rom_text.ts";
import { Safari } from "../core/safari.ts";

export interface MenuEntry { id: string; label: string }
export interface MenuCtx {
  playerLabel(): string;
  linkActive(): boolean;
  inUnionRoom(): boolean;
  safariActive(): boolean;
  flag(name: string, id: number): boolean;
  session?: unknown;
  [k: string]: unknown;
}

export const Data = {
  layout: "frlg",
  textKey: "sStartMenuActionTable",

  // pokefirered/src/start_menu.c:116
  ACTION: { pokedex: 0, pokemon: 1, bag: 2, trainer: 3, save: 4, option: 5, exit: 6, retire: 7, trainer_link: 8 } as Record<string, number>,

  // Lua: start_menu_frlg.lua:11
  entry(id: string, ctx: MenuCtx): MenuEntry {
    return { id, label: RomText.at(Data.textKey, Data.ACTION[id], undefined, { playerName: ctx.playerLabel() }) };
  },

  /** -> [entries (a sequence), kind] */
  // Lua: start_menu_frlg.lua:15
  build(ctx: MenuCtx): [(MenuEntry | null)[], string] {
    const entry = (id: string): MenuEntry => Data.entry(id, ctx);
    if (ctx.linkActive()) {
      // pokefirered/src/start_menu.c:236 SetUpStartMenu_Link
      return [seq(entry("pokemon"), entry("bag"), entry("trainer_link"), entry("option"), entry("exit")), "link"];
    }
    if (ctx.inUnionRoom()) {
      // pokefirered/src/start_menu.c:245 SetUpStartMenu_UnionRoom
      return [seq(entry("pokemon"), entry("bag"), entry("trainer"), entry("option"), entry("exit")), "union"];
    }
    if (ctx.safariActive()) {
      // pokefirered/src/start_menu.c:226 SetUpStartMenu_SafariZone
      return [seq(
        entry("retire"), entry("pokedex"), entry("pokemon"), entry("bag"),
        entry("trainer"), entry("option"), entry("exit"),
      ), "safari"];
    }
    const entries: (MenuEntry | null)[] = seq();
    // pokefirered/src/start_menu.c:215
    if (ctx.flag("SYS_POKEDEX_GET", 0x829)) entries[len(entries) + 1] = entry("pokedex");
    // pokefirered/src/start_menu.c:217
    if (ctx.flag("SYS_POKEMON_GET", 0x828)) entries[len(entries) + 1] = entry("pokemon");
    entries[len(entries) + 1] = entry("bag");
    entries[len(entries) + 1] = entry("trainer");
    entries[len(entries) + 1] = entry("save");
    entries[len(entries) + 1] = entry("option");
    entries[len(entries) + 1] = entry("exit");
    return [entries, "normal"];
  },

  // pokefirered/src/start_menu.c:255 DrawSafariZoneStatsWindow
  // Lua: start_menu_frlg.lua:46
  extraWindow(kind: string, ctx: MenuCtx): Record<string, unknown> | undefined {
    if (kind !== "safari") return undefined;
    return {
      left: 1, top: 1, width: 10, height: 4, key: "gText_MenuSafariStats", textX: 4, textY: 3,
      vars: seq(
        format("%3d", Safari.steps(ctx.session)),
        format("%3d", Safari.STEPS),
        format("%2d", Safari.balls(ctx.session)),
      ),
    };
  },

  exitConfirms: true,
};

export default Data;
