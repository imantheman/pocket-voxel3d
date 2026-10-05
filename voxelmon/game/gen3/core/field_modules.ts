// Port of gen1recomp src/core/game3/field_modules.lua (GPLv3 + additional terms; see LICENSE.md).
// Per-game switches for the optional field systems (profile.map.fieldModules).

import { Profile } from "./profile.ts";
import { tostring } from "../../../import/gen3/lua.ts";

export const FieldModules = {
  NAMES: {
    questLog: true,
    mapPreview: true,
    mapNamePopup: true,
    helpSystem: true,
    vsSeeker: true,
    deoxys: true,
    renewableHiddenItems: true,
    leagueLighting: true,
    ssAnne: true,
    unionPlaza: true,
    seafoamSurf: true,
    viridianForestEscape: true,
  } as Record<string, boolean>,

  FAMILY_DEFAULTS: {
    // pokeemerald/src/map_name_popup.c:231
    rse: { mapNamePopup: true },
  } as Record<string, Record<string, boolean>>,

  // Lua: field_modules.lua:25
  list(session?: any): Record<string, unknown> | undefined {
    const row = Profile.forSession(session);
    const map = row && row.map;
    return (map && map.fieldModules) || undefined;
  },

  // Lua: field_modules.lua:31
  enabled(name: string, session?: any): boolean {
    if (!FieldModules.NAMES[name]) {
      throw new Error("field module name '" + tostring(name) + "' is not known");
    }
    const list = FieldModules.list(session);
    if (list == null) return true;
    if (list[name] != null) return list[name] === true;
    const defaults = FieldModules.FAMILY_DEFAULTS[Profile.family(session)];
    return defaults != null && defaults[name] === true;
  },
};

export default FieldModules;
