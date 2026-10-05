// Port of gen1recomp src/core/game3/scripting/adapters.lua (GPLv3 + additional terms; see LICENSE.md).
// Host adapters for game3 yields (message, lock, movement, freeze).
//
// Port notes:
// - require / pcall(require) / package.loaded: static imports, used exactly
//   as Brian guards them. Modules with no file in the port
//   (rse.decoration_inventory, town_map_stub, ui elevator_window) read as a
//   failed pcall(require), so their branches are skipped as in Lua when the
//   require fails.
// - Multiple returns are 0-based tuples: giveMon -> [ok, code, ...] ([false]
//   with no session); giveMonToPlayer / giveEggToPlayer -> Party's tuple, or
//   [] for Lua's bare `return nil`. Every other adapter returns one value.
// - Movement streams reaching applyMovement are Movement's 0-based byte
//   arrays (scripting/movement.ts); the host-track path converts the decoded
//   actions to a 1-based sequence (seam) so `tr.actions[tr.i]` reads as Lua.
// - Host fallbacks (Gen 1 / Gen 2 world, TextBox, OverworldController) are
//   kept; on the 3DS the game3 Runtime is active whenever scripts run, so the
//   game3 branches are the ones taken.
// - mod.log:info / print -> Logger.info.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, pairs, len, seq, fromArray, type LuaTable } from "../../platform/lt.ts";
import { format, tonumber, tostring, truthy, mod as lmod } from "../../../../import/gen3/lua.ts";
import { match } from "../../platform/lpattern.ts";
import { luaLen } from "../../../../import/gen3/luatable.ts";
import { notPorted } from "../../notported.ts";
import { Logger } from "../../shared/core/Logger.ts";
import { MapIds } from "../map_ids.ts";
import { Movement } from "./movement.ts";
import { Flags } from "./flags.ts";
import { Opcodes } from "./opcodes.ts";
import { Strings } from "../../shared/core/Strings.ts";
import { RomText } from "../rom_text.ts";
import { MapCatalog } from "../../../../import/gen3/map_catalog.ts";
import { Versions } from "../../../../import/gen3/versions.ts";
import { HallOfFame } from "../../ui/hall_of_fame.ts";
import { Pokemon } from "../pokemon.ts";
import { ItemsData } from "../items_data.ts";
import { Ctx } from "./ctx.ts";
import Objects from "../objects.ts";
import Space from "./space.ts";
import { FrlgFont } from "../../ui/frlg_font.ts";
import { HouseNpcs as HouseNpcsMod } from "../house_npcs_stub.ts";
// house_npcs_stub has no pushText (Brian guards it: `if HouseNpcs and HouseNpcs.pushText`).
const HouseNpcs: any = HouseNpcsMod;
import Runtime from "../runtime.ts";
import { Hud } from "../../ui/hud.ts";
import { Message } from "../../ui/message.ts";
import { Choice } from "../../ui/choice.ts";
import { TextBox } from "../../shared/render/TextBox.ts";
import { Theme } from "../../shared/ui/Theme.ts";
import { MonPic } from "../../ui/mon_pic.ts";
import { Party } from "../party.ts";
import Player from "../player.ts";
import { FieldEffects } from "../field_effects.ts";
import { PcMenu } from "../../ui/pc_menu.ts";
import OC from "../../shared/world/OverworldController.ts";
import { MoneyBox } from "../../ui/money_box.ts";
import { Marts } from "../marts.ts";
import { ShopMenu } from "../../ui/shop_menu.ts";
import { Items } from "../items.ts";
import { Bag as Game3Bag } from "../bag.ts";
import { FieldModules } from "../field_modules.ts";
import QuestLogRecorder from "../quest_log_recorder.ts";
import { Bag as HostBag } from "../../shared/inventory/Bag.ts";
import { Doors } from "../doors.ts";
import { Fade } from "../../ui/fade.ts";
import { Naming } from "../../ui/naming.ts";
import { PartyMenu } from "../../ui/party_menu.ts";
import { Plaza } from "../link/union_plaza_map.ts";
import { Map as G3Map } from "../map.ts";
import { Warp } from "../warp.ts";
import { Audio } from "../audio.ts";
import Multichoice from "./multichoice.ts";
import Field from "../field.ts";
import { Weather } from "../weather.ts";
import { RegionMap } from "../../ui/region_map.ts";
import { HofPc } from "../../ui/hall_of_fame_pc.ts";
import { BattleBridge } from "../battle_bridge.ts";
import { EasyChat } from "../../ui/easy_chat.ts";

type Fn = (...a: any[]) => any;

// pcall(require, name) for a module with no file in the port: [false, err].
function pcallMissing(name: string): [false, string] {
  try {
    notPorted(`require("${name}") (no such module in the port yet)`);
  } catch (e) {
    return [false, String((e as Error).message ?? e)];
  }
}

// pokefirered/src/scrcmd.c:807
const WARP_SLOT_FIELD: Record<string, string> = {
  setwarp: "warpDestination",
  setdynamicwarp: "dynamicWarp",
  setescapewarp: "escapeWarp",
  setdivewarp: "diveWarp",
  setholewarp: "holeWarp",
};

// pokefirered/src/script_menu.c:574
const STD_STRING_COUNT = 29;

// Lua: adapters.lua:23
function stdString(idIn: any): string | null {
  const id = tonumber(idIn);
  if (id == null || id < 0 || id >= STD_STRING_COUNT) return null;
  return RomText.plain("stdstring:" + tostring(id));
}

// pokeemerald/src/scrcmd.c:1599 StringCopy(..., gDecorations[decorId].name)
// Lua: adapters.lua:31
function decorationName(_src: any): string | null {
  // pcall(require, "src.core.game3.rse.decoration_inventory")
  const [ok] = pcallMissing("src.core.game3.rse.decoration_inventory");
  if (!ok) return null;
  return null;
}

// pokefirered/src/event_object_movement.c:5208 GetOppositeDirection
const OPPOSITE_DIR: Record<string, string> = { down: "up", up: "down", left: "right", right: "left" };

// pokefirered/src/event_object_movement.c:4789 GetDirectionToFace
// Lua: adapters.lua:45
function directionToFace(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 > x2) return "left";
  if (x1 < x2) return "right";
  if (y1 > y2) return "up";
  return "down";
}

// pokefirered/src/overworld.c:516
// Lua: adapters.lua:53
function warp_s8(vIn: any): number {
  const v = lmod(tonumber(vIn) ?? 0, 256);
  if (v >= 128) return v - 256;
  return v;
}

// Lua: adapters.lua:59
function warp_map_id(group: any, num: any): string | null {
  let id: any = MapCatalog && MapCatalog.mapIdFor && MapCatalog.mapIdFor(group, num);
  if (typeof id === "string" && id !== "") return id;
  if (Versions) {
    id = (Versions.frMapFor && Versions.frMapFor(group, num))
      || (Versions.mapIdFor && Versions.mapIdFor(group, num));
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

// Lua: adapters.lua:238
function current_npc_color(): number | null {
  // package.loaded["src.core.game3.scripting.space"]
  const ctx = Space && Space.vm && Space.vm.ctx;
  if (!ctx) return null;
  return Adapters.resolveNpcColor(ctx, Space.store);
}

// Lua: adapters.lua:245
function tick_vm(): void {
  if (Space && Space.vm) Space.vm.tick();
}

function runtimeActive(): boolean {
  // package.loaded["src.core.game3.runtime"]
  return !!(Runtime && Runtime.isActive && Runtime.isActive());
}

function runtimeSession(): any {
  return Runtime && Runtime.getSession && Runtime.getSession();
}

export const Adapters = {
  stdString,

  /** Build a test/stub adapter set. opts may override any method. */
  // Lua: adapters.lua:73
  stub(opts?: any): any {
    opts = opts ?? {};
    let boxOpen = false;
    const frozen: Record<any, any> = {};
    const facing: Record<any, any> = {};
    const logs: LuaTable = seq();
    const a: any = {};
    a.boxOpen = () => boxOpen;
    a.logs = logs;
    a.frozen = frozen;
    a.facing = facing;
    a.playerName = opts.playerName ?? "RED";
    a.rivalName = opts.rivalName ?? "BLUE";
    a.lookupText = opts.lookupText;
    a.lookupMovement = opts.lookupMovement;
    a.lookupScript = opts.lookupScript;
    a.log = (msg: any) => {
      logs[len(logs) + 1] = msg;
      if (truthy(opts.verbose)) Logger.info(tostring(msg));
    };
    // Sync open for unit tests that don't yield.
    a.openMessage = (text: any) => {
      boxOpen = true;
      a.lastMessage = text;
      if (opts.onMessage) opts.onMessage(text);
    };
    // Async open: call done when "player" finishes reading (instant in stub).
    a.openMessageAsync = (text: any, done?: Fn) => {
      boxOpen = true;
      a.lastMessage = text;
      if (opts.onMessage) opts.onMessage(text);
      if (done) done();
    };
    a.closeMessage = () => {
      boxOpen = false;
      if (opts.onClose) opts.onClose();
    };
    a.waitButton = (cb?: Fn) => {
      if (cb) cb();
      return true;
    };
    a.freezeLocal = (localId: any, snap?: any) => {
      frozen[localId] = snap ?? true;
    };
    a.unfreezeLocal = (localId: any, snap?: any) => {
      delete frozen[localId];
      if (snap && snap.facing) facing[localId] = snap.facing;
    };
    a.facePlayer = (localId: any) => {
      facing[localId] = "toward_player";
    };
    a.listActiveLocalIds = () => {
      return opts.activeLocalIds ?? seq();
    };
    a.nurseHeal = opts.nurseHeal ?? ((done?: Fn) => { if (done) done(); });
    a.openPc = opts.openPc ?? ((done?: Fn) => { if (done) done(); });
    a.hallOfFamePc = opts.hallOfFamePc ?? ((done?: Fn) => { if (done) done(); });
    a.openShop = opts.openShop ?? ((_items: any, done?: Fn) => { if (done) done(); });
    a.askYesNo = opts.askYesNo ?? ((cb?: Fn) => { if (cb) cb(true); });
    a.fadeScreen = opts.fadeScreen ?? ((_mode: any, _speed: any, done?: Fn) => { if (done) done(); });
    a.openNaming = opts.openNaming ?? ((_opts: any, done?: Fn) => { if (done) done("RED"); });
    // pokefirered/src/party_menu_specials.c:14
    a.chooseParty = opts.chooseParty ?? ((_opts: any, done?: Fn) => { if (done) done(null); });
    // pokefirered/src/field_specials.c:1094
    a.elevatorWindow = opts.elevatorWindow ?? ((floorLabel: any) => {
      a.elevatorFloorLabel = floorLabel;
    });
    // pokefirered/src/field_specials.c:1113
    a.elevatorWindowClose = opts.elevatorWindowClose ?? (() => {
      a.elevatorFloorLabel = null;
    });
    a.openEasyChat = opts.openEasyChat ?? ((o: any, done?: Fn) => {
      const def = seq(2601, 4128, 526, 2611);
      if (done) done(true, (o && o.words) || def);
    });
    a.hallOfFame = opts.hallOfFame ?? ((done?: Fn) => {
      HallOfFame.start({
        session: opts.session ?? (opts.game && opts.game.session),
        onDone: () => {
          if (done) done();
        },
      });
    });
    a.bufferName = opts.bufferName ?? ((op: any, src: any) => {
      if (op === "bufferspeciesname") {
        if (Pokemon) {
          if (!Pokemon._names) Pokemon.install(null);
          return Pokemon.name(tonumber(src) ?? src);
        }
      }
      if (op === "bufferitemname" || op === "bufferitemnameplural") {
        if (ItemsData) {
          return ItemsData.displayName(src);
        }
      }
      if (op === "bufferstdstring") {
        return stdString(src);
      }
      if (op === "bufferdecorationname") {
        return decorationName(src);
      }
      return null;
    });
    a.leadMonName = opts.leadMonName ?? (() => "POK\xC3\xA9MON");
    a.openMessageStay = opts.openMessageStay ?? ((text: any, done?: Fn) => {
      a.openMessageAsync(text, done);
    });
    a.applyMovement = opts.applyMovement;
    a.pollMovement = opts.pollMovement;
    a.resolveGraphics = opts.resolveGraphics;
    a.getPlayerFacing = opts.getPlayerFacing ?? (() => "down");
    for (const [k, v] of pairs(opts)) {
      if (typeof v === "function" || a[k] == null) {
        a[k] = v;
      }
    }
    if (opts.openMessage) {
      const user = opts.openMessage;
      a.openMessage = (text: any) => {
        boxOpen = true;
        a.lastMessage = text;
        return user(text);
      };
    }
    if (opts.closeMessage) {
      const user = opts.closeMessage;
      a.closeMessage = () => {
        boxOpen = false;
        return user();
      };
    }
    return a;
  },

  // Lua: adapters.lua:211
  resolveNpcColor(ctx: any, store?: any): number {
    const sv = (ctx && ctx.specialVars) || {};
    const layout = (ctx && ctx.specialLayout) || Ctx.specialLayout();
    let tc = layout.textColor != null ? sv[layout.textColor] : null;
    if (tc == null) tc = Ctx.TEXT_COLOR_DEFAULT;
    // src/field_specials.c:1548
    if (tc !== Ctx.TEXT_COLOR_DEFAULT) return tc;
    const sel = (ctx && tonumber(ctx.selectedLocalId)) ?? 0;
    if (sel === 0) return 3;
    let gfx: any = null;
    // package.loaded["src.core.game3.objects"]
    const obj = Objects && Objects.find && !(Objects.isPlayer && Objects.isPlayer(sel)) && Objects.find(sel);
    if (obj) {
      gfx = obj.graphicsId ?? (obj.def && (obj.def.graphicsId ?? obj.def.graphics));
    }
    gfx = tonumber(gfx) ?? tonumber(ctx.selectedGfx);
    if (gfx != null && gfx >= 240 && gfx <= 255) {
      // package.loaded["src.core.game3.scripting.space"]
      const v = Flags.getVar(store || (Space && Space.store), ctx, Ctx.GFX_VAR_LO + (gfx - 240));
      gfx = (typeof v === "number" && v > 0) ? v : gfx;
    }
    return FrlgFont.getNpcTextColor(gfx);
  },

  /** Live Love2D / Gen2 host adapter. */
  // Lua: adapters.lua:251
  host(mod: any, game?: any, world?: any): any {
    let boxOpen = false;
    // Parallel FRLG applymovement tracks (Gen2 World.moveState is single-slot).
    let moveTracks: Record<any, any> = {};

    // Lua: adapters.lua:257
    const resolveGame = (): any => {
      return game || (world && world.game) || (mod && mod.game);
    };

    // Lua: adapters.lua:261
    const resolveWorld = (): any => {
      if (world && (world.showText || world.openPc || world.startHealMachineAnim
          || world.player || world.setMap)) {
        return world;
      }
      const g = resolveGame();
      if (g && g.overworld && (g.overworld.showText || g.overworld.player)) {
        return g.overworld;
      }
      return world;
    };

    // Lua: adapters.lua:273
    const npcLocalId = (npc: any): any => {
      if (!npc) return null;
      const d = npc.def;
      return (d && (d.localId ?? d.index)) ?? npc.localId ?? npc.index;
    };

    // Lua: adapters.lua:279
    const findNpc = (localId: any): any => {
      const want = tonumber(localId) ?? localId;
      // Prefer game3 EventObjects while they own the map.
      if (Objects && Objects.hasMap && Objects.hasMap()) {
        const eo = Objects.find(want);
        if (eo) return eo;
      }
      const w = resolveWorld();
      if (!w) return null;
      if (want === Opcodes.LOCALID_PLAYER || want === 0) {
        return w.player;
      }
      if (w.talkNpc && npcLocalId(w.talkNpc) === want) {
        return w.talkNpc;
      }
      for (const [, npc] of ipairs<any>(w.npcs ?? {})) {
        if (npcLocalId(npc) === want) return npc;
      }
      for (const [, npc] of pairs<any>(w.npcPool ?? {})) {
        if (npcLocalId(npc) === want) return npc;
      }
      return null;
    };

    // Lua: adapters.lua:304
    const useGame3Objects = (): any => {
      return (Objects && Objects.hasMap && Objects.hasMap() && Objects) || false;
    };

    // Lua: adapters.lua:309
    const useGame3Tracks = (): any => {
      const G3 = useGame3Objects();
      if (G3 && G3.hasActiveTracks && G3.hasActiveTracks()) return G3;
      return null;
    };
    void useGame3Tracks;

    // Lua: adapters.lua:315
    const spaceStore = (): any => {
      return Space && Space.store;
    };

    // Lua: adapters.lua:320
    const advanceMoveTracks = (): void => {
      for (const [lid, tr] of pairs<any>(moveTracks)) {
        if (!tr.done) {
          let ent = tr.entity;
          if (!ent) {
            ent = findNpc(lid);
            tr.entity = ent;
          }
          if (tr.sleep && tr.sleep > 0) {
            tr.sleep = tr.sleep - 1;
          } else if (!(ent && ent.moving)) {
            const act = tr.actions[tr.i];
            if (!act) {
              tr.done = true;
              if (tr.onDone) {
                const cb = tr.onDone;
                tr.onDone = null;
                cb();
              }
            } else {
              tr.i = tr.i + 1;
              if (act.kind === "step") {
                if (ent && ent.scriptStep) ent.scriptStep(act.dir, act.run, act.slow);
              } else if (act.kind === "jump") {
                if (ent && ent.scriptJump) {
                  ent.scriptJump(act.dir, act.distance ?? 1);
                } else if (ent && ent.scriptStep) {
                  for (let i = 1; i <= (act.distance ?? 1); i++) {
                    ent.scriptStep(act.dir);
                  }
                }
              } else if (act.kind === "turn") {
                if (ent && ent.scriptFace) {
                  ent.scriptFace(act.dir);
                } else if (ent) {
                  ent.facing = act.dir;
                }
              } else if (act.kind === "face_player") {
                // pokefirered/src/event_object_movement.c:6772 MovementAction_FacePlayer_Step0
                // package.loaded["src.core.game3.player"]
                let P: any = Player;
                if (!(P && P.cellX != null)) {
                  const w = resolveWorld();
                  P = w && w.player;
                }
                if (ent && P && P.cellX != null && ent.cellX != null) {
                  let dir = directionToFace(ent.cellX, ent.cellY, P.cellX, P.cellY);
                  if (act.away) dir = OPPOSITE_DIR[dir];
                  if (ent.scriptFace) ent.scriptFace(dir); else ent.facing = dir;
                }
              } else if (act.kind === "lock_facing") {
                // pokefirered/src/event_object_movement.c:6796 MovementAction_LockFacingDirection_Step0
                if (ent) ent.facingLocked = truthy(act.locked) ? true : false;
              } else if (act.kind === "animate") {
                // pokefirered/src/event_object_movement.c:7040 MovementAction_DisableAnimation_Step0
                if (ent) ent.inanimate = truthy(act.inanimate) ? true : false;
              } else if (act.kind === "remove_obstacle") {
                // pokefirered/src/event_object_movement.c:7135 MovementAction_RockSmashBreak_Step0
                tr.sleep = act.frames ?? 32;
              } else if (act.kind === "sleep") {
                tr.sleep = act.frames ?? 1;
              } else if (act.kind === "hide") {
                if (ent) {
                  ent.hidden = true;
                  ent.visible = false;
                }
              } else if (act.kind === "show") {
                if (ent) {
                  ent.hidden = false;
                  ent.visible = true;
                }
              }
            }
          }
        }
      }
    };

    const a: any = {
      // Lua: adapters.lua:399
      log: (msg: any) => {
        if (mod && mod.log) mod.log.info(msg); else Logger.info(tostring(msg));
      },
      // Lua: adapters.lua:402
      playerName: () => {
        const g = resolveGame();
        const session = runtimeSession();
        if (session && session.name) return session.name;
        if (g && g.session && g.session.name) return g.session.name;
        const p = g && g.save && g.save.player;
        return (p && (p.name || p.playerName)) || (g && g.save && g.save.name) || "PLAYER";
      },
      // Lua: adapters.lua:411
      rivalName: () => {
        const g = resolveGame();
        const session = runtimeSession();
        if (session && session.rivalName && session.rivalName !== "") {
          return session.rivalName;
        }
        if (g && g.session && g.session.rivalName && g.session.rivalName !== "") {
          return g.session.rivalName;
        }
        const save = g && g.save;
        if (save && save.rivalName && save.rivalName !== "") return save.rivalName;
        const p = save && save.player;
        return (p && p.rivalName) || "RIVAL";
      },
      // Lua: adapters.lua:426
      openMessage: (_text: any) => {
        boxOpen = true;
      },
      // Lua: adapters.lua:429
      openMessageAsync: (text: any, done?: Fn) => {
        boxOpen = true;
        if (runtimeActive()) {
          const g = resolveGame();
          a.log("[game3] dialog via game3 HUD (not Gen2 showText)");
          const npcColor = current_npc_color();
          Hud.openMessage(g, text, {
            npcColor,
            done: () => {
              boxOpen = false;
              if (done) done();
              tick_vm();
            },
          });
          return;
        }
        const g = resolveGame();
        const w = resolveWorld();
        const finish = () => {
          if (done) done();
          tick_vm();
        };
        if (w && w.showText) {
          w.showText(text, finish);
          return;
        }
        if (HouseNpcs && HouseNpcs.pushText) {
          HouseNpcs.pushText(g, text, finish);
        } else {
          finish();
        }
      },
      // Hold the box open for yesnobox / MSGBOX_YESNO.
      // Lua: adapters.lua:464
      openMessageStay: (text: any, done?: Fn) => {
        boxOpen = true;
        if (runtimeActive()) {
          const g = resolveGame();
          a.log("[game3] stay-dialog via game3 HUD");
          const npcColor = current_npc_color();
          Hud.openMessageStay(g, text, {
            npcColor,
            done: () => {
              if (done) done();
              tick_vm();
            },
          });
          return;
        }
        const g = resolveGame();
        const w = resolveWorld();
        const finish = () => {
          if (done) done();
          tick_vm();
        };
        if (w && w.showText) {
          w.showText(text, finish, true);
          return;
        }
        if (w) w.lastText = text;
        if (HouseNpcs && HouseNpcs.pushText) {
          HouseNpcs.pushText(g, text, finish);
        } else {
          finish();
        }
      },
      // Lua: adapters.lua:498
      closeMessage: () => {
        boxOpen = false;
        if (runtimeActive()) {
          Message.close();
          return;
        }
        const g = resolveGame();
        const w = resolveWorld();
        if (w && w.stayedTextBox && g && g.stack) {
          if (g.stack.top() === w.stayedTextBox) {
            g.stack.pop();
          }
          w.stayedTextBox = null;
        }
      },
      // Lua: adapters.lua:515
      waitButton: (cb?: Fn) => {
        if (cb) cb();
        return true;
      },
      // Lua: adapters.lua:519
      armWaitButton: (cb?: Fn) => {
        if (runtimeActive()) {
          Hud.armWaitButton(() => {
            // Close the message box after button press (pret WaitForFieldInput).
            // Stay-mode messages (field item pickups, signs) remain open until
            // explicitly dismissed; without this they persist after the script ends.
            // package.loaded["src.ui.game3.message"]
            if (Message && Message.isOpen && Message.isOpen()) {
              Message.close();
            }
            if (cb) cb();
            tick_vm();
          });
          return;
        }
        if (cb) cb();
        tick_vm();
      },
      // Gen1 pokecenter uses HEAL/CANCEL; Gen2 askYesNo is YES/NO over stayed text.
      // Lua: adapters.lua:540
      askYesNo: (cb?: Fn, layout?: any) => {
        const finish = (yes: any) => {
          if (cb) cb(truthy(yes) ? true : false);
          tick_vm();
        };
        if (runtimeActive()) {
          Hud.ensure(resolveGame(), "message");
          a.log("[game3] yes/no via game3 Choice (not Gen2 askYesNo)");
          Choice.yesNo(finish, layout);
          // Do NOT autoPick -- player must answer on HUD.
          return;
        }
        const w = resolveWorld();
        if (w && typeof w.askYesNo === "function") {
          w.askYesNo(finish);
          return;
        }
        const g = resolveGame();
        if (g && g.stack) {
          const question = (w && w.lastText) || "";
          g.stack.push(TextBox.new(g, question, null, {
            instant: true,
            choice: finish,
            choiceLabels: seq(Strings("HEAL"), Strings("CANCEL")),
            choiceBox: Theme.healCancelBox,
          }));
          return;
        }
        finish(true);
      },
      // Lua: adapters.lua:576
      showMonPic: (species: any, x?: any, y?: any) => {
        MonPic.show(species, x, y);
      },
      // Lua: adapters.lua:580
      hideMonPic: () => {
        MonPic.hide();
      },
      // Lua: adapters.lua:584 -- [ok, code, ...] (Party.giveMon's values) | [false]
      giveMon: (species: any, level: any, _a3?: any, _a4?: any, _a5?: any, nickname?: any): any[] => {
        const session = runtimeSession();
        if (!session) return [false];
        return Party.giveMon(session, species, level, nickname);
      },
      // pokefirered/src/script_pokemon_util.c:48
      // Lua: adapters.lua:592 -- Party.giveMonToPlayer's values | []
      giveMonToPlayer: (species: any, level: any, _a3?: any, nickname?: any): any[] => {
        const session = runtimeSession();
        if (!session) return [];
        return Party.giveMonToPlayer(session, species, level, nickname);
      },
      // pokefirered/src/script_pokemon_util.c:75
      // Lua: adapters.lua:600 -- Party.giveEggToPlayer's values | []
      giveEggToPlayer: (species: any): any[] => {
        const session = runtimeSession();
        if (!session) return [];
        return Party.giveEggToPlayer(session, species);
      },
      // Lua: adapters.lua:607
      freezeLocal: (localId: any, snap?: any) => {
        const G3 = useGame3Objects();
        if (G3) {
          const eo = G3.find(localId);
          if (eo && snap && eo.facing) snap.facing = eo.facing;
          G3.freeze(localId);
          return;
        }
        const npc = findNpc(localId);
        if (!npc) return;
        if (snap) snap.facing = npc.facing;
        npc.frozen = true;
        const w = resolveWorld();
        if (w && w.freezeNpc) {
          w.freezeNpc(npc);
        } else if (w) {
          w.frozeNpcs = true;
        }
      },
      // Lua: adapters.lua:626
      unfreezeLocal: (localId: any, _snap?: any) => {
        const G3 = useGame3Objects();
        if (G3) {
          G3.unfreeze(localId);
          return;
        }
        const w = resolveWorld();
        // Gen2: World:step clears frozeNpcs when !busy (includes game3 VM).
        if (w && w.frozeNpcs && typeof w.freezeNpc === "function") {
          return;
        }
        const npc = findNpc(localId);
        if (npc) npc.frozen = false;
      },
      // Lua: adapters.lua:640
      facePlayer: (localId: any) => {
        const G3 = useGame3Objects();
        if (G3) {
          G3.facePlayer(localId, resolveGame());
          return;
        }
        const w = resolveWorld();
        const npc = findNpc(localId) || (w && w.talkNpc);
        const player = w && w.player;
        if (npc && player && npc.facePlayer) {
          npc.facePlayer(player);
        }
      },
      // Lua: adapters.lua:653
      listActiveLocalIds: () => {
        const G3 = useGame3Objects();
        if (G3) return G3.listActive();
        const ids: LuaTable = seq();
        const w = resolveWorld();
        for (const [, npc] of ipairs<any>((w && w.npcs) || {})) {
          const lid = npcLocalId(npc);
          if (lid != null) ids[len(ids) + 1] = lid;
        }
        return ids;
      },
      // Lua: adapters.lua:664
      messageOpen: () => boxOpen,
      // Lua: adapters.lua:665
      nurseHeal: (done?: Fn) => {
        const finish = () => {
          if (done) done();
          tick_vm();
        };
        // pret special HealPlayerParty is silent (no nurse dialogue). Dialogue
        // lives in the surrounding script; never call Gen1 OC.nurseHeal here --
        // that method needs an OverworldState self + Game upvalue.
        if (runtimeActive()) {
          const session = Runtime.getSession && Runtime.getSession();
          if (session && session.party) {
            Party.healAll(session.party);
          }
          Player.syncToHost(resolveGame());
          const w = resolveWorld();
          if (w && w.healParty) {
            try { w.healParty(); } catch { /* pcall */ }
          }
          finish();
          return;
        }
        const w = resolveWorld();
        if (w && w.startHealMachineAnim) {
          w.startHealMachineAnim(null, () => {
            if (w.healParty) w.healParty();
            finish();
          });
          if (w.healAnim) {
            w.healAnim.px = (w.healAnim.px ?? 0) + 16;
          }
          return;
        }
        if (w && typeof w.nurseHeal === "function") {
          w.nurseHeal(finish);
          return;
        }
        finish();
      },
      // Lua: adapters.lua:707
      doFieldEffect: (id: any) => {
        if (FieldEffects.doFieldEffect) {
          FieldEffects.doFieldEffect(id);
        }
      },
      // Lua: adapters.lua:713
      waitFieldEffect: (id: any, done?: Fn) => {
        const finish = () => {
          if (done) done();
          tick_vm();
        };
        if (FieldEffects.waitFieldEffect) {
          FieldEffects.waitFieldEffect(id, finish);
          return;
        }
        finish();
      },
      // Lua: adapters.lua:725
      setFieldEffectArgument: (argNum: any, value: any) => {
        if (FieldEffects.setFieldEffectArgument) {
          FieldEffects.setFieldEffectArgument(argNum, value);
        }
      },
      // Lua: adapters.lua:731
      openPc: (done?: Fn, pcOpts?: any) => {
        const finish = (result?: any) => {
          if (Message && Message.close) Message.close();
          if (done) done(result);
          tick_vm();
        };
        if (runtimeActive()) {
          const prompt = (Message && Message.isOpen && Message.isOpen()
            && Message.currentPage()) || null;
          if (a.closeMessage) a.closeMessage();
          if (Message && Message.close) Message.close();
          if (Hud && Hud.clearWaitButton) Hud.clearWaitButton();
          a.log("[game3] openPc via game3 PcMenu");
          const isTbl = pcOpts != null && typeof pcOpts === "object";
          const bedroom = isTbl && pcOpts.bedroom === true;
          const mode = (isTbl && pcOpts.mode) || null;
          let startMode: string | null = bedroom ? "player_pc" : null;
          if (mode === "select") startMode = "select";
          if (mode === "storage") startMode = "storage";
          if (mode === "player") startMode = "player_pc";
          PcMenu.show({
            session: Runtime.getSession(),
            onClose: finish,
            startMode,
            bedroom,
            closeOnExit: bedroom || mode === "storage" || mode === "player",
            silentClose: mode != null,
            prompt,
          });
          return;
        }
        const w = resolveWorld();
        if (w && w.openPc) {
          w.openPc({ onDone: finish });
          return;
        }
        if (typeof OC.openPC === "function") {
          OC.openPC(finish);
          return;
        }
        finish();
      },
      // Lua: adapters.lua:778
      openShop: (martKey: any, done?: Fn) => {
        const finish = () => {
          if (MoneyBox && MoneyBox.hide) MoneyBox.hide();
          if (done) done();
          tick_vm();
        };
        const session = runtimeSession();
        Marts.ensure();
        const items: any = Marts.itemsFor(martKey)[0];
        if (!items || luaLen(items) < 1) {
          a.log("[game3] openShop: no mart list for " + tostring(martKey));
          finish();
          return;
        }
        a.log("[game3] openShop items=" + tostring(luaLen(items)));
        if (a.closeMessage) a.closeMessage();
        if (Message && Message.close) Message.close();
        ShopMenu.show({
          items,
          session,
          onClose: finish,
        });
      },
      // Lua: adapters.lua:806
      removeObject: (localId: any) => {
        const G3 = useGame3Objects();
        if (G3) {
          const eo = G3.find(localId);
          const flag = eo && eo.def && (eo.def.flag ?? eo.def.flagId);
          if (truthy(flag) && flag !== 0 && flag !== 0xFFFF && flag !== 65535) {
            const store = spaceStore();
            if (store) {
              Flags.setFlag(store, null, flag, true);
            }
          }
          G3.removeObject(localId);
          return;
        }
        // pret RemoveObjectEventByLocalIdAndMap: FlagSet(object's event flag)
        // then despawn. Without the flag, Bill respawns on the next outdoor load.
        const npc = findNpc(localId);
        const flag = npc && npc.def && (npc.def.flag ?? npc.def.flagId);
        if (truthy(flag) && flag !== 0 && flag !== 0xFFFF && flag !== 65535) {
          const store = spaceStore();
          if (store) {
            Flags.setFlag(store, null, flag, true);
          }
        }
        if (npc) {
          npc.hidden = true;
          npc.visible = false;
          if (npc.def) npc.def.hidden = true;
        }
        delete moveTracks[tonumber(localId) ?? localId];
      },
      // Lua: adapters.lua:837
      addObject: (localId: any) => {
        const G3 = useGame3Objects();
        if (G3) {
          G3.addObject(localId);
          return true;
        }
        return false;
      },
      // Hide-flag <-> EventObject visibility (removeobject + clearflag lab Oak).
      // Lua: adapters.lua:846
      onFlagChanged: (flagId: any, hidden: any) => {
        const G3 = useGame3Objects();
        if (G3 && G3.syncFlagVisibility) {
          G3.syncFlagVisibility(flagId, truthy(hidden) ? true : false,
            (Space && Space._inTransition) ? true : null);
        }
      },
      // Lua: adapters.lua:854
      hideObject: (localId: any) => {
        const G3 = useGame3Objects();
        if (G3) {
          G3.hideObject(localId);
          return;
        }
        const npc = findNpc(localId);
        if (npc) {
          npc.hidden = true;
          npc.visible = false;
        }
      },
      // Lua: adapters.lua:866
      showObject: (localId: any) => {
        const G3 = useGame3Objects();
        if (G3) {
          G3.showObject(localId);
          return;
        }
        const npc = findNpc(localId);
        if (npc) {
          npc.hidden = false;
          npc.visible = true;
        }
      },
      // Lua: adapters.lua:878
      turnObject: (localId: any, dir: any) => {
        const G3 = useGame3Objects();
        if (G3) {
          G3.turnObject(localId, dir);
          return;
        }
        const npc = findNpc(localId);
        const dirs: Record<number, string> = { 1: "down", 2: "up", 3: "left", 4: "right" };
        // FRLG DIR_*: 1=down 2=up 3=left 4=right (also 0 sometimes)
        const facing = dirs[tonumber(dir) ?? 0] ?? dirs[lmod(tonumber(dir) ?? 1, 4) + 1];
        if (npc && facing) {
          if (npc.scriptFace) {
            npc.scriptFace(facing);
          } else {
            npc.facing = facing;
            if (npc.dir != null) npc.dir = facing;
          }
        }
      },
      // Lua: adapters.lua:897
      setObjectState: (op: any, row: any) => {
        const lid = row && (row.localId ?? row[1]);
        const G3 = useGame3Objects();
        if (G3) {
          if (op === "setobjectxyperm" || op === "setobjectxy") {
            G3.setObjectXY(lid, row[2], row[3]);
          } else if (op === "setobjectmovementtype") {
            G3.setMovementType(lid, row[2]);
          } else if (op === "copyobjectxytoperm") {
            if (G3.copyObjectXYToPerm) {
              G3.copyObjectXYToPerm(lid);
            }
          }
          return;
        }
        const npc = findNpc(lid);
        if (!npc) return;
        if (op === "setobjectxyperm" || op === "setobjectxy") {
          const x = tonumber(row[2]), y = tonumber(row[3]);
          if (x != null && y != null) {
            npc.cellX = x; npc.cellY = y;
            if (npc.x) npc.x = x * 16;
            if (npc.y) npc.y = y * 16;
          }
        } else if (op === "copyobjectxytoperm") {
          // Instance template copy on live NPC; do not poison global mapDef.objects.
        } else if (op === "setobjectmovementtype") {
          // Cosmetic on host; facing types 7-10 are FACE_*.
          const mt = tonumber(row[2]) ?? 0;
          const face = ({ 7: "up", 8: "down", 9: "left", 10: "right" } as Record<number, string>)[mt];
          if (face) {
            if (npc.scriptFace) npc.scriptFace(face); else npc.facing = face;
          }
        }
      },
      // Lua: adapters.lua:932
      applyMovement: (localId: any, stream: any, done?: Fn) => {
        // On Sevii, always drive game3 EventObjects / Player -- never host scriptStep.
        if (runtimeActive()) {
          const w = resolveWorld();
          if (w && w.frozeNpcs != null) w.frozeNpcs = true;
          Objects.applyMovement(localId, stream, done);
          return;
        }
        const G3 = useGame3Objects();
        if (G3) {
          const w = resolveWorld();
          if (w && w.frozeNpcs != null) w.frozeNpcs = true;
          G3.applyMovement(localId, stream, done);
          return;
        }
        const lid = tonumber(localId) ?? localId;
        // seam: Movement decodes a 0-based stream into 0-based actions; the
        // tracks index them 1-based as Brian's do.
        const actions = fromArray(Movement.actionsFromBytes(stream));
        const ent = findNpc(lid);
        const w = resolveWorld();
        if (w && w.frozeNpcs != null) w.frozeNpcs = true;
        if (ent) ent.frozen = true;
        moveTracks[lid] = {
          entity: ent,
          actions,
          i: 1,
          sleep: 0,
          done: false,
          onDone: done,
        };
        advanceMoveTracks();
      },
      // Lua: adapters.lua:965
      pollMovement: (localId: any, _entry?: any) => {
        // Prefer EventObjects whenever they own the map -- not only when a track
        // is already active (hasActiveTracks false -> moveTracks treated missing
        // as done and skipped Bill / Oak waits).
        if (Objects && Objects.hasMap && Objects.hasMap()) {
          return Objects.pollMovement(localId);
        }
        if (runtimeActive()) {
          if (Objects) return Objects.pollMovement(localId);
        }
        advanceMoveTracks();
        const lid = tonumber(localId) ?? localId;
        if (lid === 0) {
          for (const [, tr] of pairs<any>(moveTracks)) {
            if (!tr.done) return false;
          }
          return true;
        }
        const tr = moveTracks[lid];
        return !tr || tr.done === true;
      },
      // Lua: adapters.lua:988
      clearMovements: () => {
        const G3 = useGame3Objects();
        if (G3) G3.clearMovements();
        moveTracks = {};
      },
      // FRLG item index -> host / game3 bag (H2 quarantine when Game3 active).
      // Lua: adapters.lua:994
      modifyItem: (op: any, itemId: any, qtyIn: any): boolean => {
        const session = runtimeSession()
          || (Field && Field._session);
        const qty = Math.max(1, tonumber(qtyIn) ?? 1);

        const num = ItemsData.toNumericId(itemId) ?? tonumber(itemId);
        let id: any = Items.resolveHostId(itemId);
        if (id == null && num != null) {
          id = (Items.FRLG_TO_HOST as any)[num];
        }
        if (id == null) {
          id = (typeof itemId === "string" && itemId) || (num != null && ("FRLG_" + tostring(num))) || tostring(itemId);
        }

        // Native FR session bag: store numeric FRLG ids (pret ItemSlot shape).
        if (session && session.bag) {
          const storeId = num ?? id;
          if (op === "removeitem") {
            return Game3Bag.remove(session.bag, storeId, qty);
          }
          const ok = Game3Bag.add(session.bag, storeId, qty)[0];
          if (ok && (id === "TOWN_MAP" || num === 361)) {
            // pcall(require, "src.core.game3.town_map_stub"): no such module
            const [tmOk] = pcallMissing("src.core.game3.town_map_stub");
            void tmOk;
          }
          if (ok && ItemsData.pocketOf(storeId) === "KEY_ITEMS"
            && FieldModules.enabled("questLog", session)) {
            const Q: any = QuestLogRecorder;
            Q.event(session, "ObtainedItemInLocation", seq(...Q.location(resolveGame(), session), ItemsData.displayName(storeId)));
          }
          return ok;
        }

        if (id == null || (typeof itemId === "string" && match(itemId, "^%d+$") != null && !(Items.FRLG_TO_HOST as any)[tonumber(itemId)!])) {
          a.log("[game3] unmapped FRLG item " + tostring(itemId));
          return false;
        }
        if ((Items.FORCE_QUARANTINE as any)[id] || !(Items.HOST_SAFE as any)[id]) {
          a.log("[game3] quarantine item " + tostring(id) + " with no session bag");
          return false;
        }

        const g = resolveGame();
        if (!g || !g.save) return false;
        if (op === "removeitem") {
          if (HostBag.remove) return truthy(HostBag.remove(g.save, id, qty)) ? true : false;
          const inv = g.save.inventory ?? {};
          const have = inv[id] ?? 0;
          if (have < qty) return false;
          inv[id] = have - qty;
          return true;
        }
        const ok = HostBag.add(g.save, id, qty);
        if (ok && id === "TOWN_MAP") {
          // pcall(require, "src.core.game3.town_map_stub"): no such module
          const [tmOk] = pcallMissing("src.core.game3.town_map_stub");
          void tmOk;
        }
        return ok ? true : false;
      },
      // Lua: adapters.lua:1060
      checkItemSpace: (itemId: any, qtyIn: any): boolean => {
        const session = runtimeSession();
        const qty = Math.max(1, tonumber(qtyIn) ?? 1);
        const id = ItemsData.toNumericId(itemId) ?? itemId;
        if (session && session.bag) {
          return Game3Bag.canAdd(session.bag, id, qty);
        }
        return true;
      },
      // Lua: adapters.lua:1072
      checkItem: (itemId: any, qtyIn: any): boolean => {
        const session = runtimeSession();
        const qty = Math.max(1, tonumber(qtyIn) ?? 1);
        const id = ItemsData.toNumericId(itemId) ?? itemId;
        if (session && session.bag) {
          return Game3Bag.has(session.bag, id, qty);
        }
        return false;
      },
      // Lua: adapters.lua:1084
      checkItemType: (itemId: any): number => {
        return ItemsData.pocketResult(itemId);
      },
      // Intentionally no `delay` adapter: ops_a uses a soft per-frame countdown.
      // A sync delay+tick_vm re-entered resume and skipped waitmovement (Oak lead).
      // Lua: adapters.lua:1090
      waitDoorAnim: (done?: Fn) => {
        if (!Doors.isBusy()) {
          if (done) done();
        }
      },
      // Lua: adapters.lua:1096
      doorAnim: (op: any, x: any, y: any) => {
        // package.loaded["src.core.game3.scripting.space"]
        const mapId = Space && Space.currentMapId;
        if (op === "opendoor") {
          Doors.open(mapId, x, y);
        } else if (op === "closedoor") {
          Doors.close(mapId, x, y);
        }
      },
      // Lua: adapters.lua:1106
      fadeScreen: (mode: any, speed: any, done?: Fn) => {
        Fade.begin(tonumber(mode) ?? 0, tonumber(speed) ?? 1, () => {
          if (done) done();
          tick_vm();
        });
      },
      // Lua: adapters.lua:1113
      openNaming: (opts: any, done?: Fn) => {
        opts = opts ?? {};
        opts.onDone = (name: any) => {
          if (done) done(name);
          tick_vm();
        };
        // Field scripts leave the yes/no box open; naming replaces the CB2 on cart.
        if (Message.isOpen && Message.isOpen() && Message.close) {
          Message.close();
        }
        Fade.clear();
        Naming.open(opts);
      },
      // pokefirered/src/party_menu_specials.c:14
      // Lua: adapters.lua:1130
      chooseParty: (chooseOpts: any, done?: Fn) => {
        chooseOpts = chooseOpts ?? {};
        const g = resolveGame();
        const session = (Runtime.getSession && Runtime.getSession())
          || (g && g.session);
        const party = session && session.party;
        if (!(party && party[1])) {
          if (done) done(null);
          return;
        }
        if (Message.isOpen && Message.isOpen() && Message.close) {
          Message.close();
        }
        let picked: any = null;
        const resume = () => {
          if (done) done(picked);
          tick_vm();
        };
        PartyMenu.show(party, null, {
          // pokefirered/src/party_menu.c:5651 InitChooseMonsForBattle
          mode: chooseOpts.mode ?? "choose",
          count: chooseOpts.count,
          menuType: chooseOpts.menuType,
          chooseMonsBattleType: chooseOpts.chooseMonsBattleType,
          session,
          onSelect: (slot: any) => {
            if (slot != null && typeof slot === "object") {
              picked = slot;
              return;
            }
            const s = tonumber(slot);
            if (s != null && s >= 1) picked = s - 1;
          },
          onClose: () => {
            // pokefirered/src/party_menu.c:5746 Task_ValidateChosenMonsForBattle
            if (picked == null && PartyMenu.chosenOrder) {
              const order = PartyMenu.chosenOrder();
              if (order && order[1] != null) picked = order;
            }
            if (!Runtime.defer(resume)) resume();
          },
        });
      },
      // pokefirered/src/field_specials.c:1094
      // Lua: adapters.lua:1177
      elevatorWindow: (_floorLabel: any) => {
        // pcall(require, "src.ui.game3.elevator_window"): no such module
        const [ok] = pcallMissing("src.ui.game3.elevator_window");
        void ok;
      },
      // pokefirered/src/field_specials.c:1113
      // Lua: adapters.lua:1182
      elevatorWindowClose: () => {
        const [ok] = pcallMissing("src.ui.game3.elevator_window");
        void ok;
      },
      // pokefirered/src/overworld.c:605
      // Lua: adapters.lua:1187
      setWarp: (op: any, group: any, num: any, warpId: any, x: any, y: any): any => {
        const session = runtimeSession()
          || (resolveGame() && resolveGame().session);
        if (!session) return null;
        const slot = WARP_SLOT_FIELD[op];
        if (!slot) return null;
        const warp = {
          map: warp_map_id(group, num),
          mapGroup: tonumber(group) ?? 0,
          mapNum: tonumber(num) ?? 0,
          warpId: warp_s8(warpId),
          x: warp_s8(x),
          y: warp_s8(y),
        };
        session[slot] = warp;
        return warp;
      },
      // Lua: adapters.lua:1205
      openEasyChat: (opts: any, done?: Fn) => {
        opts = opts ?? {};
        opts.onDone = (confirmed: any, words: any) => {
          if (done) done(confirmed, words);
          tick_vm();
        };
        if (Message.isOpen && Message.isOpen() && Message.close) {
          Message.close();
        }
        Fade.clear();
        EasyChat.open(opts);
      },
      // Lua: adapters.lua:1220
      warp: (group: any, num: any, warpId: any, x: any, y: any, done?: Fn, kind?: any) => {
        // Prefer FR standalone ids; fall back to Sevii ferry maps.
        let mapId: any;
        if (Versions.frMapFor) {
          mapId = Versions.frMapFor(group, num) || Versions.seviiMapFor(group, num);
        } else {
          mapId = warp_map_id(group, num);
        }
        const w = resolveWorld();
        const finish = () => {
          moveTracks = {};
          // Do not Objects.clearMovements here. Map.load already activated the
          // destination Space VM; ON_FRAME is pending and must keep any tracks
          // it creates. Clearing here soft-locked Network Center MeetCelio.
          if (done) done();
          tick_vm();
        };
        if (!mapId) {
          a.log(format("[game3] warp unknown FRLG map %s.%s", tostring(group), tostring(num)));
          finish();
          return;
        }
        // Gen2 World:setMap(mapId, cx, cy, facing) -- coords required (nil cx crashes).
        const as_coord = (vIn: any): number | null => {
          const v = tonumber(vIn);
          if (v == null) return null;
          // FRLG dummy coords are -1 / 0xFFFF when only warpId is used.
          if (v < 0 || v >= 0x8000) return null;
          return v;
        };
        let cx: any = as_coord(x), cy: any = as_coord(y);
        if (mapId === Plaza.SOURCE_ID) {
          Plaza.ensure(resolveGame());
          mapId = Plaza.MAP_ID;
          [cx, cy] = Plaza.entry();
        }
        const wid = tonumber(warpId);
        if ((cx == null || cy == null) && wid != null && wid !== 0xFF && wid >= 0) {
          let def = w && w.data && w.data.maps && w.data.maps[mapId];
          if (!def && w && w.game && w.game.data && w.game.data.maps) {
            def = w.game.data.maps[mapId];
          }
          const warps = def && def.warps;
          // Host warps are 1-based; FRLG warpId is often 0-based.
          const entry = warps && (warps[wid] ?? warps[wid + 1]);
          if (entry) {
            cx = entry.x; cy = entry.y;
          }
        }
        if (cx == null || cy == null) {
          const def = w && w.game && w.game.data && w.game.data.maps && w.game.data.maps[mapId];
          const warps = def && def.warps;
          if (warps && warps[1]) {
            cx = warps[1].x; cy = warps[1].y;
          }
        }
        if (!(cx != null && cy != null)) {
          a.log(format("[game3] warp %s missing coords (id=%s x=%s y=%s)",
            mapId, tostring(warpId), tostring(x), tostring(y)));
          finish();
          return;
        }
        let facing = "down";
        {
          if (runtimeActive()) {
            facing = Player.facing || facing;
          } else if (w && w.player && w.player.facing) {
            facing = w.player.facing;
          }
        }
        // Sevii destinations: game3 Map.load rebinds collision + EventObjects
        // (localIds are per-map; town Bill lid1 != PC Nurse lid1).
        const settle = () => {
          if (w && w.mapSetup) {
            a._warpPoll = () => {
              if (w.mapSetup) return false;
              a._warpPoll = null;
              finish();
              return true;
            };
            return;
          }
          finish();
        };
        if (typeof mapId === "string" && MapIds.isGame3Map(mapId)) {
          void G3Map;
          const rmod = Runtime && Runtime._mod;
          const g = resolveGame();
          // src/scrcmd.c:719
          Warp.scripted(rmod, g, kind, mapId, cx, cy, facing, settle);
          return;
        } else if (w && w.warpToMapId) {
          w.warpToMapId(mapId, cx, cy, facing);
        } else if (w && w.setMap) {
          w.setMap(mapId, cx, cy, facing);
        } else {
          if (typeof OC.loadMap === "function") {
            OC.loadMap(w, mapId);
          }
        }
        settle();
      },
      // Lua: adapters.lua:1328
      playSe: (id: any, fanfare?: any) => {
        if (truthy(fanfare)) {
          Audio.playFanfare(id);
        } else {
          Audio.playSe(id);
        }
      },
      // Lua: adapters.lua:1336
      waitFanfare: (cb?: () => void) => {
        Audio.waitFanfare(cb);
      },
      // Lua: adapters.lua:1340
      playBgm: (id: any) => {
        Audio.playSong(id);
      },
      // Lua: adapters.lua:1343
      fadeBgm: (op: any, arg?: any) => {
        if (op === "savebgm") {
          // pokefirered/src/scrcmd.c:935
          Audio.setSavedSong(arg);
        } else if (op === "fadeoutbgm") {
          Audio.fadeOutBgm(4);
        } else if (op === "fadeinbgm") {
          Audio.fadeInBgm(Audio._mapSong ?? Audio._savedSong, 4);
        } else {
          Audio.fadeDefaultBgm(4);
        }
      },
      // Lua: adapters.lua:1356
      multichoice: (row: any, cb?: Fn) => {
        let listId = 0;
        let n = 3;
        if (row) {
          // pret:
          // multichoice left, top, listId, ignoreBPress
          // multichoicedefault left, top, listId, default, ignoreBPress
          // multichoicegrid left, top, listId, numColumns, ignoreBPress
          listId = tonumber(row.listId ?? row[3] ?? row[1]) ?? 0;
          n = tonumber(row.count) ?? n;
        }
        const resolved = Multichoice.resolve(listId, n);
        const opts = resolved[0];
        const layout: any = resolved[1] ?? {};
        let def = 0;
        if (row && row.op === "multichoicedefault") {
          def = tonumber(row.default ?? row[4] ?? row[5]) ?? 0;
        }
        if (row) {
          // pokefirered/src/script_menu.c:1195
          const x = tonumber(row.x ?? row.left ?? row[1]), y = tonumber(row.y ?? row.top ?? row[2]);
          if (x != null) layout.left = x + 1;
          if (y != null) layout.top = y + 1;
          if (row.op === "multichoicegrid") {
            layout.cols = tonumber(row.cols ?? row.numColumns ?? row[4]) ?? 1;
            layout.ignoreBPress = row.ignoreBPress || (row[5] != null && tonumber(row[5]) !== 0) || false;
          } else {
            // pokefirered/src/script_menu.c:737
            layout.maxRight = 29;
            if (row.op === "multichoicedefault") {
              layout.ignoreBPress = row.ignoreBPress || (row[5] != null && tonumber(row[5]) !== 0) || false;
            } else {
              layout.ignoreBPress = row.ignoreBPress || (row[4] != null && tonumber(row[4]) !== 0) || false;
            }
          }
        }
        if (runtimeActive()) {
          Hud.ensure(resolveGame(), "message");
          a.log("[game3] multichoice via game3 Choice list=" + tostring(listId));
          Choice.multi(opts, def, (sel: any) => {
            if (cb) cb(sel);
            tick_vm();
          }, layout);
          return;
        }
        Choice.multi(opts, def, (sel: any) => {
          if (cb) cb(sel);
          tick_vm();
        }, layout);
        Choice.autoPick(def);
      },
      // Lua: adapters.lua:1410
      setMetatile: (x: any, y: any, metatile: any, impassable?: any) => {
        Field.setMetatile(x, y, metatile, impassable);
      },
      // Lua: adapters.lua:1414
      setWeather: (id: any) => {
        Weather.set(id);
      },
      // Lua: adapters.lua:1418
      doWeather: () => {
        Weather.doWeather();
      },
      // Lua: adapters.lua:1422
      resetWeather: () => {
        Weather.reset();
      },
      // Lua: adapters.lua:1426
      getPlayerFacing: () => {
        if (runtimeActive()) {
          return Player.facing || "down";
        }
        const w = resolveWorld();
        if (w && w.player) {
          return w.player.facing || "down";
        }
        return "down";
      },
      // Lua: adapters.lua:1438
      showTownMap: (done?: Fn) => {
        const session = runtimeSession() || (resolveGame() && resolveGame().session);
        if (Message.isOpen && Message.isOpen() && Message.close) {
          Message.close();
        }
        Fade.clear();
        a.log("[game3] showTownMap via RegionMap");
        RegionMap.show({
          session,
          // pokefirered/src/field_specials.c:185 ShowTownMap
          mode: "wall",
          onClose: () => {
            Fade.clear();
            if (done) done();
            tick_vm();
          },
        });
      },
      // Lua: adapters.lua:1460
      hallOfFame: (done?: Fn) => {
        const session = runtimeSession() || (resolveGame() && resolveGame().session);
        a.log("[game3] hallOfFame induction started");
        HallOfFame.start({
          session,
          onDone: () => {
            if (done) done();
            tick_vm();
          },
        });
      },
      // pokefirered/src/hof_pc.c:23
      // Lua: adapters.lua:1474
      hallOfFamePc: (done?: Fn) => {
        const session = runtimeSession() || (resolveGame() && resolveGame().session);
        if (Message && Message.close) Message.close();
        HofPc.show({
          session,
          onDone: () => {
            if (done) done();
            tick_vm();
          },
        });
      },
      // Lua: adapters.lua:1487
      startTrainerBattle: (foe: any, done?: Fn, battleOpts?: any) => {
        battleOpts = battleOpts ?? {};
        BattleBridge.start(mod, resolveGame(), foe, {
          wild: false,
          trainerId: battleOpts.trainerId ?? (foe && foe.trainerId),
          defeatText: battleOpts.defeatText ?? (foe && foe.defeatText),
          victoryText: battleOpts.victoryText ?? (foe && foe.victoryText),
          earlyRival: battleOpts.earlyRival,
          rivalFlags: battleOpts.rivalFlags,
          firstBattle: battleOpts.firstBattle || (foe && foe.firstBattle),
          noWhiteout: battleOpts.noWhiteout,
          double: battleOpts.double,
          // pokefirered/src/trainer_tower.c:735 BATTLE_TYPE_TRAINER_TOWER
          trainerTower: battleOpts.trainerTower,
          // pokefirered/src/battle_tower.c:933 BATTLE_TYPE_EREADER_TRAINER
          eReader: battleOpts.eReader,
          // pokefirered/src/battle_message.c:2066 GetTrainerTowerOpponentName
          trainerName: battleOpts.trainerName ?? (foe && foe.trainerName),
          trainerPicId: battleOpts.trainerPicId ?? (foe && foe.trainerPicId),
          done: (result: any) => {
            if (done) done(result ?? "win");
            tick_vm();
          },
        });
      },
      // Lua: adapters.lua:1513
      startWildBattle: (foe: any, done?: Fn, battleOpts?: any) => {
        battleOpts = battleOpts ?? {};
        BattleBridge.startWild(mod, resolveGame(), foe, {
          wildScripted: (foe && foe.wildScripted) || battleOpts.wildScripted,
          legendary: (foe && foe.legendary) || battleOpts.legendary,
          oldManTutorial: (foe && foe.oldManTutorial) || battleOpts.oldManTutorial,
          safari: (foe && foe.safari) || battleOpts.safari,
          roamer: (foe && foe.roamer) || battleOpts.roamer,
          firstBattle: (foe && foe.firstBattle) || battleOpts.firstBattle,
          aiFlags: (foe && foe.aiFlags) || battleOpts.aiFlags,
          done: (result: any) => {
            if (done) done(result ?? "win");
            tick_vm();
          },
        });
      },
      // Lua: adapters.lua:1530
      bufferName: (op: any, srcIn: any) => {
        const src = tonumber(srcIn) ?? srcIn;
        if (op === "bufferspeciesname") {
          if (!Pokemon._names) Pokemon.install(null);
          return Pokemon.name(src);
        }
        if (op === "bufferitemname" || op === "bufferitemnameplural") {
          return ItemsData.displayName(src);
        }
        if (op === "bufferstdstring") {
          return stdString(src) ?? tostring(src);
        }
        if (op === "bufferdecorationname") {
          return decorationName(src);
        }
        if (op === "bufferpartymonnick") {
          const party = Runtime && Runtime.session && Runtime.session.party;
          const slot = (tonumber(src) ?? 0) + 1;
          let mon = party && party[slot];
          if (mon) {
            return Pokemon.displayName(mon);
          }
          const g = resolveGame();
          const hostParty = g && g.save && g.save.party;
          mon = hostParty && hostParty[slot];
          if (mon) {
            return Pokemon.displayName(mon);
          }
        }
        return null;
      },
      // Lua: adapters.lua:1566
      leadMonName: () => {
        const party = Runtime && Runtime.session && Runtime.session.party;
        let mon = party && party[1];
        if (!mon) {
          const g = resolveGame();
          mon = g && g.save && g.save.party && g.save.party[1];
        }
        if (mon) {
          return Pokemon.displayName(mon);
        }
        return "POK\xC3\xA9MON";
      },
    };
    // waitstate / nativePoll can drain warp fade without a dedicated op field.
    // Lua: adapters.lua:1582
    const prevTickHook = a.pollWarp;
    a.pollWarp = () => {
      if (a._warpPoll) return a._warpPoll();
      if (prevTickHook) return prevTickHook();
      return true;
    };
    return a;
  },
};

export default Adapters;
