// Port of gen1recomp src/core/game3/bridge.lua (GPLv3 + additional terms; see LICENSE.md).
// Host <-> game3 data bridge (enterFromHost / returnToHost).
// Contracts: H1 clock continuity, H2 bag quarantine+99 overflow, H6 opaque party,
// H9 National Dex, move_overlay persistence.
//
// Return shapes: enterFromHost / returnToHost -> the value, or [null, err]
// for Brian's `return nil, "no save"` (callers test the first slot).

import { format, tostring, tonumber } from "../../../import/gen3/lua.ts";
import { len, pairs, remove, insert } from "../platform/lt.ts";
import { osTime } from "../../gen2/platform/clock.ts";
import { Party } from "./party.ts";
import { Bag } from "./bag.ts";
import { Dex } from "./dex.ts";
import { Items } from "./items.ts";
import { Runtime } from "./runtime.ts";
import { Storage } from "./storage.ts";
import { Options } from "./options.ts";
import { HealLocations } from "./heal_locations.ts";
import { Host } from "./host_stub.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: bridge.lua:14
function sidecar(save: any): any {
  save.modData = save.modData ?? {};
  save.modData[Bridge.SAVE_KEY] = save.modData[Bridge.SAVE_KEY] ?? {};
  return save.modData[Bridge.SAVE_KEY];
}

// Lua: bridge.lua:26
function snapshot_money(save: any): number {
  return tonumber(save.money) ?? 0;
}

export const Bridge = {
  // Lua: bridge.lua:12
  SAVE_KEY: "firered_game3",

  // Lua: bridge.lua:20
  storageToSidecar(sc: any, session: any): void {
    if (!(sc && session && session.storage)) return;
    sc.storage = Storage.serialize(session.storage);
    sc.pc = null;
  },

  // Lua: bridge.lua:31
  enterFromHost(mod: any, game: any, opts?: any): any {
    opts = opts ?? {};
    const save = game ? game.save : null;
    if (!save) {
      return [null, "no save"];
    }

    if (Runtime.isActive() && opts.alreadyOnMap) {
      Runtime.log("enterFromHost skipped \xE2\x80\x94 already active (adopt)");
      return Runtime.getSession();
    }

    const sc = sidecar(save);

    const session: any = {
      party: Party.takeOpaque(save.party),
      bag: Bag.new(),
      dex: Dex.new(),
      money: snapshot_money(save),
      coins: tonumber(save.coins) ?? 0,
      name: save.name ?? save.playerName,
      rivalName: save.rivalName,
      gender: save.gender,
      map: opts.map ?? "FR_PLAYERS_HOUSE_2F",
      x: opts.x ?? 6,
      y: opts.y ?? 6,
      facing: opts.facing ?? "down",
      healMap: sc.healMap ?? "FR_PLAYERS_HOUSE_1F",
      healX: sc.healX ?? 8,
      healY: sc.healY ?? 5,
      move_overlay: sc.move_overlay ?? {},
      options: sc.options ?? {},
      storage: Storage.restore(sc.storage, sc.pc, sc.pcItems ?? save.pcItems ?? save.pc_items),
      enteredAt: osTime(),
    };

    Options.ensure(session);

    sc.move_overlay = session.move_overlay;

    Bag.mergeFromHost(session.bag, save.inventory);
    Bag.restoreSidecar(session.bag, sc);
    Dex.mergeFromHost(session.dex, save);
    Dex.restoreNational(session.dex, sc);

    session._partyProof = Party.takeOpaque(session.party);

    HealLocations.normalizeSession(session);

    Runtime.log(format(
      "enterFromHost map=%s alreadyOnMap=%s reason=%s",
      tostring(session.map),
      tostring(opts.alreadyOnMap === true),
      tostring(opts.reason ?? "ferry")));

    Runtime.start(mod, game, session, opts);
    return session;
  },

  // Lua: bridge.lua:96
  persistSessionOnly(_mod: any, game: any): void {
    const save = game ? game.save : null;
    if (!save) return;
    const session = Runtime.getSession();
    const sc = sidecar(save);
    if (!session) return;
    if (session.party) {
      Party.writeBack(save.party, session.party);
    }
    if (session.bag) {
      const [hostWrites, quarantine, overflow] = Bag.splitForHost(session.bag, save.inventory);
      // On internal persist we keep host bag as-is for host-safe stacks still
      // living in game3 bag; only update quarantine/overflow mirrors.
      sc.quarantine = quarantine;
      sc.overflow = overflow;
      sc._hostWriteSnapshot = hostWrites;
    }
    if (session.dex) {
      const [, national] = Dex.splitForHost(session.dex);
      sc.national_dex = national;
    }
    sc.move_overlay = session.move_overlay ?? sc.move_overlay;
    sc.healMap = session.healMap;
    sc.healX = session.healX;
    sc.healY = session.healY;
    sc.options = session.options ?? sc.options;
    Bridge.storageToSidecar(sc, session);
    if (session.money != null) save.money = session.money;
  },

  // Lua: bridge.lua:128
  returnToHost(mod: any, game: any, opts?: any): any {
    opts = opts ?? {};
    const save = game ? game.save : null;
    if (!save) {
      return [null, "no save"];
    }
    const session = Runtime.getSession();
    const sc = sidecar(save);

    if (session && session.party) {
      Party.writeBack(save.party, session.party);
    }

    if (session && session.bag) {
      const [hostWrites, quarantine, overflow] = Bag.splitForHost(session.bag, save.inventory);
      // Replace host-safe stacks we manage: write capped qty.
      for (const [id, qty] of pairs<number>(hostWrites)) {
        const have = save.inventory[id] ?? 0;
        if (have > 0) {
          delete save.inventory[id];
          // keep bagOrder clean
          if (save.bagOrder) {
            for (let i = len(save.bagOrder); i >= 1; i--) {
              if (save.bagOrder[i] === id) remove(save.bagOrder, i);
            }
          }
        }
        if (qty > 0) {
          save.inventory[id] = Math.min(Items.HOST_MAX_QTY, qty);
          if (save.bagOrder) {
            insert(save.bagOrder, id);
          }
        }
      }
      sc.quarantine = quarantine;
      sc.overflow = overflow;
      // Clear live bag mirror; quarantine holds non-host + overflow holds 99+ rem.
    }

    if (session && session.dex) {
      const [hostUpdates, national] = Dex.splitForHost(session.dex);
      Dex.applyHostUpdates(save, hostUpdates);
      sc.national_dex = national;
    }

    if (session) {
      sc.move_overlay = session.move_overlay ?? sc.move_overlay;
      sc.healMap = session.healMap;
      sc.healX = session.healX;
      sc.healY = session.healY;
      sc.options = session.options ?? sc.options;
      Bridge.storageToSidecar(sc, session);
      if (session.money != null) {
        save.money = session.money;
      }
    }

    Runtime.stop(mod, game);

    // Warp host to Vermilion (or opts).
    const world = (game && (game.overworld ?? game.world)) || null;
    let mapId = opts.map;
    let x = opts.x;
    let y = opts.y;
    if (!mapId) {
      if (Host.isGen2()) {
        mapId = "VERMILION_PORT"; x = 7; y = 12;
      } else {
        mapId = "VERMILION_CITY"; x = 18; y = 29;
      }
    }
    x = x ?? 7;
    y = y ?? 12;
    if (mod && mod.world && mod.world.warpTo) {
      mod.world.warpTo(mapId, x, y);
    } else if (world && world.warpToMapId) {
      world.warpToMapId(mapId, x, y, opts.facing ?? "down");
    } else if (world && world.setMap) {
      world.setMap(mapId, x, y, opts.facing ?? "down");
    }

    return true;
  },

  // Lua: bridge.lua:215
  persistFlags(_mod: any, game: any, storeSerialize: any): void {
    const save = game ? game.save : null;
    if (!save) return;
    const sc = sidecar(save);
    if (storeSerialize != null && typeof storeSerialize === "object") {
      for (const [k, v] of pairs(storeSerialize)) {
        if (k !== "quarantine" && k !== "overflow" && k !== "national_dex"
          && k !== "move_overlay") {
          sc[k] = v;
        }
      }
    }
  },

  // Lua: bridge.lua:229
  getSidecar(save: any): any {
    if (!save) return {};
    return sidecar(save);
  },
};

export default Bridge;
