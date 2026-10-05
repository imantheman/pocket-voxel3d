// Port of gen1recomp src/core/game3/quest_log_recorder.lua (GPLv3 + additional terms; see LICENSE.md).
// Engine-facing capture. Recorded actors/tiles are rendered without a field VM.
// package.loaded["src.core.game3.runtime" / ".scripting.space"]: every module
// is in the bundle, so both are imported directly.
//
// R.location keeps the Lua's multiple return: its fallback is
// `s:gsub(...):gsub(...)`, which returns the string AND gsub's count, so the
// `{R.location(...)}` argument tables in R.event / R.save get both values, as
// in the Lua. It returns a 0-based tuple; callers that want one value take [0].

import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { gsub, find } from "../platform/lpattern.ts";
import { ipairs, len, seq } from "../platform/lt.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import Q, { type QuestFrame } from "./quest_log.ts";
import PlayerMod from "./player.ts";
import ObjectsMod from "./objects.ts";
import OwSpritesMod from "./ow_sprites.ts";
import SpaceMod from "./scripting/space.ts";
import MapMod from "./map.ts";
import FieldModulesMod from "./field_modules.ts";
import RuntimeMod from "./runtime.ts";
import AudioMod from "./audio.ts";
import BattleMod from "./battle.ts";
import PokemonMod from "./pokemon.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Loose views of sibling modules (stubbed or being ported); read at call time.
const P = (): any => PlayerMod;
const O = (): any => ObjectsMod;
const Ow = (): any => OwSpritesMod;
const SpaceOf = (): any => SpaceMod;
const MapOf = (): any => MapMod;
const RuntimeOf = (): any => RuntimeMod;

// ---- fillTiles' memo (not in the Lua)

/** tostring(x) .. "," .. tostring(y), kept. */
const keys = new Map<number, string>();
function cellKey(x: number, y: number): string {
  const k = (y + 4096) * 8192 + (x + 4096);
  let s = keys.get(k);
  if (s === undefined) {
    if (keys.size >= 65536) keys.clear();
    s = tostring(x) + "," + tostring(y);
    keys.set(k, s);
  }
  return s;
}

/**
 * What fillTiles' cells came from last time: the table written, the map,
 * the world and neighbour lists, and each layout they reach with its
 * override count (LayoutNative._revision). Any change and every cell is
 * read again.
 */
const fill = { out: null as any, def: null as any, world: null as any, nl: null as any, refs: [] as any[], revs: [] as number[], cx: 0, cy: 0 };

function fillSame(out: any, def: any, Map: any): boolean {
  const world = Map.world, nl = Map.neighborList;
  let same = fill.out === out && fill.def === def && fill.world === world && fill.nl === nl;
  const refs = fill.refs, revs = fill.revs;
  let i = 0;
  const note = (L: any): void => {
    const r = L ? (L._revision ?? 0) : 0;
    if (same && (refs[i] !== L || revs[i] !== r)) same = false;
    refs[i] = L; revs[i] = r; i++;
  };
  note(def.midLayout);
  if (world) for (let k = 1; world[k] != null; k++) note(world[k].def ? world[k].def.midLayout : null);
  if (nl) for (let k = 1; nl[k] != null; k++) note(nl[k].def ? nl[k].def.midLayout : null);
  if (refs.length !== i) { same = false; refs.length = i; revs.length = i; }
  fill.out = out; fill.def = def; fill.world = world; fill.nl = nl;
  return same;
}

export const R = {
  // Lua: quest_log_recorder.lua:4 -- [name] or [name, gsubCount]
  location(game: any, session: any): [string] | [string, number] {
    const def = game && game.data && game.data.maps && game.data.maps[session.map];
    let ok: boolean, info: any;
    try {
      info = MapSectionsExtract.getInfo(def ? def.regionMapSectionId : undefined, session.map, 0);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) info = undefined;
    if (info && info.name && info.name !== "???") return [info.name];
    const [s1] = gsub(tostring(session.map ?? ""), "^FR_", "");
    const [s2, n2] = gsub(s1, "_", " ");
    return [s2, n2];
  },

  // Lua: quest_log_recorder.lua:11
  capture(game: any, session: any): QuestFrame {
    const Pl = P();
    const Ob = O();
    const Space = SpaceOf();
    const f: QuestFrame = { x: Pl.px ?? (session.x ?? 0) * 16, y: Pl.py ?? (session.y ?? 0) * 16, actors: seq() };
    if (!Pl.isVisible || Pl.isVisible()) {
      f.actors[len(f.actors) + 1] = {
        id: 255, x: f.x + (Pl.spriteXOffset ?? 0),
        y: f.y + (Pl.spriteYOffset ?? ((Pl.jumpSpriteY && Pl.jumpSpriteY()) || 0)),
        graphicsId: Ow().playerGraphicsId(game), facing: Pl.facing ?? "down",
        walkPhase: Pl.walkPhase(), stepFlip: Pl.drawFlip(), fieldMove: (Pl.fieldMoveAnim ?? 0) > 0,
      };
    }
    for (const [, o] of ipairs<any>(Ob.forDraw())) {
      const gid = Space && Space.resolveObjectGraphicsId && o.def && Space.resolveObjectGraphicsId(o.def);
      f.actors[len(f.actors) + 1] = {
        id: o.localId ?? 1000 + (tonumber(o.virtualId) ?? 0), x: o.px ?? o.cellX * 16, y: o.py ?? o.cellY * 16,
        graphicsId: truthy(gid) ? gid : (o.graphicsId ?? (o.def && (o.def.graphicsId ?? o.def.graphics))),
        facing: o.facing, walkPhase: Ob.walkPhase(o), stepFlip: o.stepFlip, frame: o.customFrame,
        bow: (o.bowFrames ?? 0) > 8 && (o.bowFrames ?? 0) <= 40,
      };
    }
    return Q.trimActors(f);
  },

  // Lua: quest_log_recorder.lua:31
  fillTiles(game: any, session: any, frame: QuestFrame, out: any): any {
    const Map = MapOf();
    const def = game && game.data && game.data.maps && game.data.maps[session.map];
    if (!def || !def.midLayout) return out;
    const cx = Math.floor(frame.x / 16); const cy = Math.floor(frame.y / 16);
    // NOT FAITHFUL (performance, same tiles): this runs every sixth tick over
    // 13x17 cells, most of them unchanged since the last call. While the
    // table and everything a cell's tile comes from are as they were (fill
    // memo), the cells the last call already wrote are skipped -- all of
    // them standing still, all but the new edge after a step -- and a cell
    // inside the map reads its layout directly, as worldMidAt does there.
    const same = fillSame(out, def, Map);
    const px = same ? fill.cx : NaN, py = same ? fill.cy : NaN;
    const layout = def.midLayout;
    const lw = layout.width ?? 0, lh = layout.height ?? 0;
    const lpair = layout.pair ?? def.pair;
    for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 8; x <= cx + 8; x++) {
      if (x >= px - 8 && x <= px + 8 && y >= py - 6 && y <= py + 6) continue;
      let mid: any, pair: any;
      if (x >= 0 && y >= 0 && x < lw && y < lh) {
        mid = layout.midAt(x, y); pair = lpair;
      } else {
        const sm = Map.worldMidAt(x, y, def);
        mid = sm[0]; pair = sm[1];
      }
      const key = cellKey(x, y);
      const t = out[key];
      if (t === null || typeof t !== "object" || t[1] !== mid || t[2] !== pair) {
        out[key] = seq(mid, pair);
      }
    }
    fill.cx = cx; fill.cy = cy;
    return out;
  },

  // Lua: quest_log_recorder.lua:46
  tiles(game: any, session: any, frame: QuestFrame): any {
    return R.fillTiles(game, session, frame, {});
  },

  // Lua: quest_log_recorder.lua:49
  event(session: any, key: string, args: any): void {
    if (!FieldModulesMod.enabled("questLog", session)) return;
    const Runtime = RuntimeOf();
    // Ignore simulations/tests and sessions that aren't the active game.
    if (!session || !Runtime || typeof Runtime.isActive !== "function" || !Runtime.isActive() || (Runtime.getSession && Runtime.getSession() !== session)) return;
    const game = Runtime._game;
    const [map] = gsub(tostring(session.map).toUpperCase(), "_", "");
    if (find(map, "TRAINERTOWER", 1, true) || find(map, "ELEVATOR", 1, true)
        || find(map, "POKEMONTRAINERFANCLUB", 1, true) || find(map, "SEVENISLANDHOUSEROOM", 1, true)) return;
    const f = R.capture(game, session);
    Q.record(session, key, args, f); Q.addTiles(session, R.tiles(game, session, f));
    const scene = session.questLog.scenes[len(session.questLog.scenes)];
    if (scene) scene.song = (AudioMod as any)._mapSong;
  },

  // Lua: quest_log_recorder.lua:63
  save(game: any): void {
    const session = game.session;
    if (!session || !session.questLog) return;
    const frame = R.capture(game, session);
    session.questLog.final = {
      map: session.map, frames: seq(frame), tiles: R.tiles(game, session, frame),
      song: (AudioMod as any)._mapSong,
      events: seq({ key: "SavedGameAtLocation", args: seq(...R.location(game, session)), frame: 1 }),
    };
  },

  // Lua: quest_log_recorder.lua:71
  update(game: any): void {
    const session = game.session; if (!session) return;
    const Battle: any = BattleMod;
    if (Battle.isActive()) return;
    const map = session.map;
    if (session._questMap !== map) {
      session._questMap = map;
      R.event(session, "ArrivedInLocation", seq(...R.location(game, session)));
    }
    const Runtime = RuntimeOf();
    if (Runtime && Runtime.uiBusy()) return;
    session._questTick = (session._questTick ?? 0) + 1;
    if (session._questTick % 6 !== 0) return;
    const f = R.capture(game, session);
    Q.sample(session, f, 6);
    const scene = Q.tileScene(session);
    if (scene) R.fillTiles(game, session, f, scene.tiles);
  },

  // Lua: quest_log_recorder.lua:89
  battle(session: any, st: any): void {
    if (!st || (st.result !== "win" && st.result !== "catch")) return;
    const Runtime = RuntimeOf();
    const loc = R.location(Runtime ? Runtime._game : Runtime, session)[0];
    const Pokemon: any = PokemonMod;
    // Lua: quest_log_recorder.lua:94
    const name = (b: any): any => Pokemon.displayMonName(b ? (b.mon ?? b) : b);
    const enemy = name(st.enemy); const player = name(st.player);
    if (st.wild) {
      const args = { D0: loc, D1: enemy, D3: enemy, D5: session.name };
      R.event(session, st.result === "catch" ? "CaughtWildMon" : "DefeatedWildMon", args);
    } else {
      const mon = (st.player && st.player.mon) || {};
      const hp = mon.hp ?? 0, max = mon.maxHp ?? (mon.stats && mon.stats.hp) ?? 1;
      const outcome = hp >= Math.floor(max / 3) * 2 ? "Handily" : (hp >= Math.floor(max / 3) ? "Tenaciously" : "Somehow");
      let args: any = { D0: loc, D1: st.trainerName ?? "TRAINER", D2: enemy, D3: player, D4: { text: outcome } };
      let key = "TookOnTrainersMonWithMonAndWon";
      // pokefirered/src/quest_log_battle.c:25 switches on the class id, which a
      // mod renaming the class leaves alone (include/constants/trainers.h:267-273)
      const cls = tonumber(st.trainerClass);
      if (cls === 84) key = "TookOnGymLeadersMonWithMonAndWon";
      else if (cls === 87) {
        key = "TookOnEliteFoursMonWithMonAndWon";
        args = { D0: st.trainerName, D1: enemy, D2: player, D3: { text: outcome } };
      } else if (cls === 90) {
        key = "PlayerBattledChampionRival"; args = { D0: session.name, D1: st.trainerName };
      }
      R.event(session, key, args);
    }
  },
};

export default R;
