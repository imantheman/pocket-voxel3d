// Port of gen1recomp src/core/game3/scripting/interaction_scripts.lua (GPLv3 + additional terms; see LICENSE.md).
// pret field_control_avatar.c:GetInteractedMetatileScript. Original MB values,
// not translated COLL bytes: different pieces of furniture share collision.
// NOT FAITHFUL: install() with an RSE pack's tileBits needs collision_rse
// (Emerald, out of scope) and throws.

type FlavorRow = [number, string, boolean?];

interface InteractionRow { facing?: string; sameElevation?: boolean; script?: string }

interface Pack {
  behaviors?: Record<string, unknown>;
  interactions?: Record<number, InteractionRow>;
  tileBits?: unknown;
}

const FLAVOR: FlavorRow[] = [
  [0x81, "Bookshelf"], [0x82, "PokeMartShelf"], [0x90, "Food"],
  [0xA1, "VideoGame"], [0x97, "Computer"], [0xA0, "ImpressiveMachine"],
  [0x93, "Blueprints"], [0xA2, "Burglary"], [0x86, "PlayerFacingTVScreen", true],
  [0x89, "Cabinet"], [0x8A, "Kitchen"], [0x8B, "Dresser"], [0x8C, "Snacks"],
  [0x94, "Painting"], [0x95, "PowerPlantMachine"], [0x96, "Telephone"],
  [0x98, "AdvertisingPoster"], [0x99, "TastyFood"], [0x9A, "TrashBin"],
  [0x9B, "Cup"], [0x9C, "PolishedWindow"], [0x9D, "BeautifulSkyWindow"],
  [0x9E, "BlinkingLights"], [0x9F, "NeatlyLinedUpTools"],
  [0x88, "PokemartSign", true], [0x87, "PokecenterSign", true],
  [0x91, "Indigo_UltimateGoal"], [0x92, "Indigo_HighestAuthority"],
];
// src/field_control_avatar.c:538,:572-577
const CODE: FlavorRow[] = [
  [0xA3, "TrainerTower_EventScript_ShowTime"],
  [0x8D, "CableClub_EventScript_ShowWirelessCommunicationScreen", true],
  [0x8F, "EventScript_Questionnaire"],
  [0x8E, "CableClub_EventScript_ShowBattleRecords", true],
];
const byBehavior: Record<number, [string, boolean | undefined]> = {};
for (const row of FLAVOR) byBehavior[row[0]] = ["EventScript_" + row[1], row[2]];
for (const row of CODE) byBehavior[row[0]] = [row[1], row[2]];

// pokeemerald/src/field_control_avatar.c:367
function rseScriptFor(behavior: number | undefined, facing: unknown, sameElevation: unknown): string | undefined {
  const row = behavior !== undefined && behavior !== null ? I.interactions![behavior] : undefined;
  if (!row) return undefined;
  if (row.facing === "up" && facing !== "up" && facing !== 2) return undefined;
  if (row.sameElevation && sameElevation === false) return undefined;
  return row.script;
}

// BG_EVENT_PLAYER_FACING_* uses a different order from DIR_*.
const directions: Record<number, number> = { 1: 2, 2: 1, 3: 4, 4: 3 };

export const I = {
  behaviors: {} as Record<string, unknown>,
  interactions: undefined as Record<number, InteractionRow> | undefined,
  FLAVOR,
  CODE,

  // Lua: interaction_scripts.lua:34
  scriptFor(behavior: number | undefined, facing: unknown, sameElevation?: unknown): string | undefined {
    if (I.interactions) return rseScriptFor(behavior, facing, sameElevation);
    if (behavior === 0x83) return "EventScript_PC";
    if (behavior === 0x85) return "EventScript_WallTownMap";
    const row = behavior !== undefined && behavior !== null ? byBehavior[behavior] : undefined;
    if (!row || (row[1] && facing !== "up" && facing !== 2)) return undefined;
    return row[0];
  },

  // Lua: interaction_scripts.lua:44
  backgroundMatches(event: { x: number; y: number; elevation?: number; kind: number }, x: number, y: number,
    elevation: number, direction: number): boolean {
    if (event.x !== x || event.y !== y) return false;
    if (event.elevation !== undefined && event.elevation !== null && event.elevation !== 0
      && event.elevation !== elevation) return false;
    const wanted = directions[event.kind];
    return wanted === undefined || wanted === direction;
  },

  // Lua: interaction_scripts.lua:50
  install(pack?: Pack | null): void {
    I.behaviors = (pack && pack.behaviors) || {};
    I.interactions = (pack && pack.interactions) || undefined;
    if (pack && pack.tileBits) {
      throw new Error("interaction_scripts: collision_rse (Emerald) is not ported");
    }
  },
};

export const InteractionScripts = I;
export default I;
