// Port of gen1recomp src/core/game3/profile.lua (GPLv3 + additional terms; see LICENSE.md).
// The per-game profile rows (capabilities, extractor lists). FireRed's row is
// converted data; LeafGreen's is FireRed's with its own id and label
// (profiles/leafgreen.lua).

import { GameVersion } from "../../../import/gen3/game_version.ts";
import fireredRow from "./profiles/firered.ts";

type Row = Record<string, any> & { id: string };

const ROWS: Record<string, Row> = {
  firered: fireredRow as unknown as Row,
  // Lua: profiles/leafgreen.lua:1-5
  leafgreen: { ...(fireredRow as unknown as Row), id: "leafgreen", label: "LeafGreen" },
};

const cache: Record<string, Row> = {};
const warned = new Set<string>();

function loadGame3(id: string): Row {
  const row = ROWS[id];
  if (!row || row.id !== id) throw new Error(`game3 profile '${id}' is missing or mislabeled`);
  cache[id] = row;
  return row;
}

export const Profile = {
  FALLBACK_ID: "firered",
  // Lua: profile.lua:23
  isGame3Version(id: string | undefined): boolean {
    const info = GameVersion.info(id);
    return info !== undefined && info.generation === 3;
  },
  // Lua: profile.lua:42
  of(id?: string): Row {
    if (typeof id !== "string" || id === "") return Profile.active();
    const hit = cache[id];
    if (hit) return hit;
    if (Profile.isGame3Version(id)) return loadGame3(id);
    if (!warned.has(id)) {
      warned.add(id);
      console.log(`[game3/profile] no profile for '${id}'; using ${Profile.active().id}`);
    }
    return Profile.active();
  },
  // Lua: profile.lua:65
  resolveId(id?: string): string {
    if (typeof id !== "string" || id === "") id = GameVersion.get();
    if (Profile.isGame3Version(id)) return id;
    return Profile.FALLBACK_ID;
  },
  // Lua: profile.lua:71
  active(): Row {
    const id = Profile.resolveId(GameVersion.get());
    return cache[id] ?? loadGame3(id);
  },
  // Lua: profile.lua:78
  sessionVersion(session: any): string | undefined {
    if (session && typeof session.version === "string" && session.version !== "") return session.version;
    return undefined;
  },
  forSession(session?: any): Row {
    const id = Profile.sessionVersion(session);
    return id ? Profile.of(id) : Profile.active();
  },
  family(session?: any): string {
    return Profile.forSession(session).family ?? "frlg";
  },
  capabilitiesFor(session?: any): Record<string, unknown> {
    const id = session && typeof session === "object" ? session.version : undefined;
    return Profile.of(id).capabilities ?? {};
  },
  has(session: any, capability: string): boolean {
    return Profile.capabilitiesFor(session)[capability] === true;
  },
  reset(): void {
    for (const k of Object.keys(cache)) delete cache[k];
    warned.clear();
  },
};

export default Profile;
