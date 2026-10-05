// Port of gen1recomp src/core/game3/field_semantics.lua (GPLv3 + additional terms; see LICENSE.md).
// Field step counters and flags by role (repelSteps, flashActive, ...): FRLG's
// ids by default, or a profile's map.semantics names resolved through Flags.

import { Profile } from "./profile.ts";
import { Flags } from "./scripting/flags.ts";

type Kind = "vars" | "flags";

let resolved: Record<string, number | false> = {};

// Lua: field_semantics.lua:22 -- [row, semantics]
function block(session: any): [any, any] {
  const row = Profile.forSession(session);
  const map = row && row.map;
  return [row, (map && map.semantics) || undefined];
}

// Lua: field_semantics.lua:28
function resolve(session: any, kind: Kind, name: string): number | undefined {
  const [row, sem] = block(session);
  if (!sem) {
    return (kind === "vars" ? Sem.FRLG_VARS : Sem.FRLG_FLAGS)[name];
  }
  const key = row.id + ":" + kind + ":" + name;
  const hit = resolved[key];
  if (hit != null) return hit === false ? undefined : hit;
  const pret = sem[kind] && sem[kind][name];
  let id: number | false = false;
  if (pret) {
    const t = Flags.forVersion(row.id);
    id = (kind === "vars" ? t.VAR_IDS : t.IDS)[pret] as number | false;
    if (id == null) throw new Error("field semantics: " + row.id + " has no " + pret);
  }
  resolved[key] = id;
  return id === false ? undefined : id;
}

export const Sem = {
  FRLG_VARS: {
    // pokefirered/include/constants/vars.h:52
    happinessSteps: 0x4021,
    // pokefirered/include/constants/vars.h:75
    massageSteps: 0x4025,
    poisonSteps: 0x4040,
    // pokefirered/include/constants/vars.h:47
    repelSteps: 0x4020,
  } as Record<string, number>,

  FRLG_FLAGS: {
    // pokefirered/include/constants/flags.h:1333
    flashActive: 0x806,
  } as Record<string, number>,

  // Lua: field_semantics.lua:48
  var(session: any, name: string): number | undefined {
    return resolve(session, "vars", name);
  },

  // Lua: field_semantics.lua:52
  flag(session: any, name: string): number | undefined {
    return resolve(session, "flags", name);
  },

  // Lua: field_semantics.lua:56
  reset(): void {
    resolved = {};
  },
};

export default Sem;
