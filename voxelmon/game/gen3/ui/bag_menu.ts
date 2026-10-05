// Port of gen1recomp src/ui/game3/bag_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Bag menu (item_menu.c field) — pockets, cursor, USE/TOSS/GIVE/REGISTER.
// Layout matching pret GBA layout: left pocket & bag art + bottom icon/desc, right item list.
//
// Port notes:
// - package.loaded["X"] probes (map, battle, battle.ui, player, start_menu)
//   read the imported module; "src.core.game3.link" is looked up in G3Lazy.
// - The weak-keyed sessionState table is a WeakMap.

import { format, mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { gsub } from "../platform/lpattern.ts";
import { ipairs, len, pairs, seq, sort, type LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Chrome } from "./chrome.ts";
import { Fade } from "./fade.ts";
import { Screens } from "./screens.ts";
import { BagChrome } from "./bag_chrome.ts";
import { PartyMenu } from "./party_menu.ts";
import { TmCase } from "./tm_case.ts";
import { BerryPouch } from "./berry_pouch.ts";
import { SellFlow } from "./sell_flow.ts";
import { StartMenu } from "./start_menu.ts";
import { ItemsData } from "../core/items_data.ts";
import { Bag, type BagRow } from "../core/bag.ts";
import { ItemUse } from "../core/item_use.ts";
import { Options } from "../core/options.ts";
import { Trig } from "../core/trig.ts";
import { PartyView } from "../core/battle/party_view.ts";
import { BattleItems } from "../core/battle/items.ts";
import { Battle } from "../core/battle.ts";
import { Ui as BattleUi } from "../core/battle/ui.ts";
import { RomText } from "../core/rom_text.ts";
import { TextIR } from "../core/scripting/text_ir.ts";
import { Audio } from "../core/audio.ts";
import { Profile } from "../core/profile.ts";
import { Storage } from "../core/storage.ts";
import { VsSeeker } from "../core/vs_seeker.ts";
import { Field } from "../core/field.ts";
import { Map as G3Map } from "../core/map.ts";
import { Player } from "../core/player.ts";
import { Union } from "../core/link/union_room.ts";
import { R as QuestLogRecorder } from "../core/quest_log_recorder.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

// include/constants/songs.h:251
import { SE } from "../core/se_ids.ts";

export interface BagInput { wasPressed(k: string): boolean; isDown?(k: string): boolean }
export interface BagShowOpts {
  session?: any; bag?: any; battle?: boolean; location?: string; onChoose?: (id: any) => void;
  onBattleUse?: (itemId: any, partySlot?: any, moveSlot?: any, usedInMenu?: boolean) => void;
  pocketIdx?: number; pocket?: number | string; onClose?: () => void;
}
interface PocketPos { cursor: number; scroll: number }
interface BagState { pocket: number; pos: Record<number, PocketPos> }
interface Transition { k: number; curtain: boolean; cb?: () => void }
interface PlanEntry { at: number; key?: string; item?: number; exit?: boolean }

export interface BagMenuModule {
  isMenu: boolean;
  open: boolean;
  cursor: number;
  pocketIdx: number;
  scroll: number;
  mode: string; // list | action | party | toss
  actionCursor: number;
  partyCursor: number;
  partyPurpose: string; // use | give
  tossQty: number;
  yesNoCursor: number;
  ACTIONS: (string | null)[];
  messageText: string | undefined;
  showMessage: (text: string, onDone?: () => void) => void;
  POKEDUDE_PLANS: Record<string, (PlanEntry | null)[]>;

  _bag: any;
  _session: any;
  _battle: boolean;
  _location: string | undefined;
  _onChoose: ((id: any) => void) | undefined;
  _sell: SellFlow | undefined;
  _onBattleUse: ((itemId: any, partySlot?: any, moveSlot?: any, usedInMenu?: boolean) => void) | undefined;
  _battleUsed: boolean | undefined;
  _msgPages: string[] | undefined;
  _msgPage: number;
  _msgDone: (() => void) | undefined;
  _onClose: (() => void) | undefined;
  _switch: { dir: number; k: number } | undefined;
  _statBoost: { frames: number; st: any; itemId: any; battlerId: any } | undefined;
  _shake: { phase: string; j: number; cb: boolean } | undefined;
  _arrowK: number | undefined;
  _heldKey: string | undefined;
  _heldFrames: number | undefined;
  _bagAnim: { n: number } | undefined;
  _open: Transition | undefined;
  _exit: Transition | undefined;
  _fluteWait: { frames: number; text: any } | undefined;
  _depositK: number | undefined;
  _depositPending: { id: any; qty: number } | undefined;
  _depositText: string | undefined;
  _pokedude: any;

  isOpen(): boolean;
  currentPocket(): string;
  list(pocket?: string): (BagRow | null)[];
  battleUse(itemId: any, partySlot?: any, moveSlot?: any, usedInMenu?: boolean): void;
  commitBattlePartyUse(st: any, itemId: any, realSlot: any, mon: any, beforeUse?: () => void): void;
  show(sessionBag: any, opts?: BagShowOpts): void;
  close(): void;
  isPokedude(): boolean;
  showPokedude(sessionBag: any, opts?: any): void;
  handleInput(input: BagInput): any;
  settle(): void;
  draw(): void;
}

export const BagMenu = {
  isMenu: true,
  open: false,
  cursor: 1,
  pocketIdx: 1,
  scroll: 0,
  mode: "list", // list | action | party | toss
  actionCursor: 1,
  partyCursor: 1,
  partyPurpose: "use", // use | give
  tossQty: 1,
  yesNoCursor: 1,
  ACTIONS: seq("USE", "TOSS", "GIVE", "CANCEL"),
  messageText: undefined,
  _battle: false,
  _msgPage: 1,
} as unknown as BagMenuModule;

const VISIBLE = 6;
const LIST_TOP = 1;
const LIST_LEFT = 11;
const LIST_W = 18;
const LIST_H = 13;

// src/item_menu_icons.c:81
const SHAKE_ROT = seq(-2, -4, -2, 0, 2, 4, 2, 0, -2, -4, -2, 0) as (number | null)[];

// src/item_use.c:159
const FIELD_EXIT_FADE: Record<string, boolean> = { bike: true, rod: true };

// Built on first use: FrlgFont is in the import cycle.
let bagColors: { WIN_WHITE: Colors; CURSOR_SELECTED: Colors; ITEM_BLUE: Colors } | undefined;
function BC(): { WIN_WHITE: Colors; CURSOR_SELECTED: Colors; ITEM_BLUE: Colors } {
  return (bagColors ??= {
    // src/bag.c:13
    WIN_WHITE: { fg: FrlgFont.STDPAL[1], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] },
    CURSOR_SELECTED: { fg: FrlgFont.STDPAL[3], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] },
    // src/item_menu.c:285
    ITEM_BLUE: { fg: FrlgFont.STDPAL[8], shadow: FrlgFont.STDPAL[9], bg: FrlgFont.STDPAL[0] },
  });
}

const sessionState = new WeakMap<object, BagState>();

const SEL_MARK = "\xE2\x96\xBA"; // ►
const TIMES = "\xC3\x97"; // ×

// Lua: bag_menu.lua:52
function se(id: unknown): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: bag_menu.lua:56
function bag_se(name: string, role: string): any {
  const S = SE as unknown as Record<string, unknown>;
  if (truthy(S[name])) return S[name];
  let ok = true, P: any;
  try { P = Profile.forSession(undefined); } catch { ok = false; }
  const sounds = ok && P && P.ui && P.ui.sounds;
  return sounds && sounds[role] && S[sounds[role]];
}

// src/menu_helpers.c:114 MenuHelpers_IsLinkActive
// src/union_room.c:4558 InUnionRoom
// Lua: bag_menu.lua:65
function link_menus_active(): boolean {
  // package.loaded["src.core.game3.map"]
  if (G3Map) {
    let inUnion = false;
    try {
      inUnion = truthy(Union.isUnionMap(G3Map.current));
    } catch (e) {
      // NOT FAITHFUL: link deferred -- union_room is still a stub; the
      // offline path (not in the Union Room) until it is ported.
      if (!(e instanceof NotPortedError)) throw e;
    }
    if (inUnion) return true;
  }
  // package.loaded["src.core.game3.link"]: a lazily-required module (G3Lazy)
  const Link = G3Lazy["src.core.game3.link"];
  return Link != null && typeof Link === "object" && Link.link != null && Link.inLinkRoom() === true;
}

// Lua: bag_menu.lua:72
function actions_for_pocket(pocket: string | undefined, row: BagRow | null | undefined): (string | null)[] {
  if (BagMenu._battle) {
    // src/item_menu.c:1344
    const num = row && ItemsData.toNumericId(row.id);
    if (num === ItemsData.ITEM_BERRY_POUCH) {
      return seq("OPEN", "CANCEL");
    }
    if (row && BattleItems.isBattleUsable(row.id)) {
      return seq("USE", "CANCEL");
    }
    return seq("CANCEL");
  }
  pocket = pocket || "ITEMS";
  if (BagMenu._location === "blender") {
    // pokeemerald/src/item_menu.c:324
    return seq("CONFIRM", "CHECK_TAG", "CANCEL");
  }
  // src/item_menu.c:1370
  if (link_menus_active()) {
    const num = row && ItemsData.toNumericId(row.id);
    if (num === ItemsData.ITEM_TM_CASE || num === ItemsData.ITEM_BERRY_POUCH) {
      return seq("USE", "CANCEL");
    }
    if (pocket === "KEY_ITEMS") return seq("CANCEL");
    return seq("GIVE", "CANCEL");
  }
  const info = row && (row.info || ItemsData.info(row.id));
  const registrable = info && (tonumber(info.registrability) ?? 0) > 0;
  if (pocket === "KEY_ITEMS") {
    if (registrable) {
      return seq("USE", "SET", "CANCEL");
    }
    return seq("USE", "CANCEL");
  } else if (pocket === "POKE_BALLS") {
    return seq("GIVE", "TOSS", "CANCEL");
  } else if (pocket === "TM_CASE") {
    return seq("USE", "CANCEL");
  } else if (pocket === "BERRY_POUCH") {
    if (Profile.family(BagMenu._session) === "rse") {
      // pokeemerald/src/item_menu.c:306
      return seq("CHECK_TAG", "USE", "GIVE", "TOSS", "CANCEL");
    }
    return seq("USE", "GIVE", "TOSS", "CANCEL");
  }
  return seq("USE", "GIVE", "TOSS", "CANCEL");
}

// Lua: bag_menu.lua:121
BagMenu.isOpen = function (): boolean {
  return BagMenu.open;
};

// Lua: bag_menu.lua:125
BagMenu.currentPocket = function (): string {
  return ItemsData.BAG_POCKET_ORDER[BagMenu.pocketIdx] || "ITEMS";
};

// Lua: bag_menu.lua:129
BagMenu.list = function (pocket?: string): (BagRow | null)[] {
  pocket = pocket || BagMenu.currentPocket();
  const bag = BagMenu._bag;
  if (!bag) return seq();
  let rows: (BagRow | null)[];
  if (bag.pockets) {
    rows = Bag.listPocket(bag, pocket);
  } else {
    if (!bag.stacks) return seq();
    rows = seq();
    for (const [id, qty] of pairs<number>(bag.stacks)) {
      if (ItemsData.pocketOf(id) === pocket && qty && qty > 0) {
        rows[len(rows) + 1] = {
          id,
          qty,
          name: ItemsData.displayName(id),
          info: ItemsData.info(id),
          description: ItemsData.description(id),
        };
      }
    }
    sort<BagRow>(rows, (a, b) => tostring(a.name) < tostring(b.name));
  }
  return rows;
};

// Lua: bag_menu.lua:157
function max_showed(total: number): number {
  // src/item_menu.c:1005
  return Math.min(VISIBLE, total);
}

// Lua: bag_menu.lua:162
function clamp_cursor(): (BagRow | null)[] {
  const rows = BagMenu.list();
  const total = len(rows) + 1;
  const shown = max_showed(total);
  if (BagMenu.cursor > total) BagMenu.cursor = total;
  if (BagMenu.cursor < 1) BagMenu.cursor = 1;
  if (BagMenu.scroll > total - shown) BagMenu.scroll = total - shown;
  if (BagMenu.cursor <= BagMenu.scroll) {
    BagMenu.scroll = BagMenu.cursor - 1;
  }
  if (BagMenu.cursor > BagMenu.scroll + shown) {
    BagMenu.scroll = BagMenu.cursor - shown;
  }
  if (BagMenu.scroll < 0) BagMenu.scroll = 0;
  return rows;
}

// pokeemerald/src/item_menu.c:1967
// Lua: bag_menu.lua:180
function check_tag(rows: (BagRow | null)[]): boolean {
  const Tag = Screens.get("berry_tag", BagMenu._session);
  if (!(Tag && Tag.show)) return false;
  const list: LuaTable = seq();
  for (const [i, r] of ipairs<BagRow>(rows)) list[i] = r.id;
  BagMenu.mode = "list";
  Tag.show({
    session: BagMenu._session,
    list,
    pos: BagMenu.cursor - 1,
    onMove: (_: unknown, newPos: number) => {
      BagMenu.cursor = newPos + 1;
      clamp_cursor();
    },
    onClose: () => { /* nothing */ },
  });
  return true;
}

// Lua: bag_menu.lua:200
function bag_state(): BagState {
  const key: object = BagMenu._session || BagMenu._bag || BagMenu;
  let st = sessionState.get(key);
  if (!st) {
    st = { pocket: 1, pos: {} };
    sessionState.set(key, st);
  }
  return st;
}

// Lua: bag_menu.lua:210
function save_pos(): void {
  const st = bag_state();
  st.pocket = BagMenu.pocketIdx;
  st.pos[BagMenu.pocketIdx] = { cursor: BagMenu.cursor, scroll: BagMenu.scroll };
}

// Lua: bag_menu.lua:216
function load_pos(pocketIdx: number): void {
  const p = bag_state().pos[pocketIdx];
  BagMenu.cursor = p ? p.cursor : 1;
  BagMenu.scroll = p ? p.scroll : 0;
}

// src/item_menu.c:866
// Lua: bag_menu.lua:223
function settle_scroll(): void {
  const st = bag_state();
  for (const [p, pos] of pairs<PocketPos>(st.pos)) {
    const total = len(BagMenu.list(ItemsData.BAG_POCKET_ORDER[p])) + 1;
    const shown = max_showed(total);
    if (pos.cursor > total) pos.cursor = total;
    if (pos.scroll > total - shown) pos.scroll = total - shown;
    if (pos.scroll < 0) pos.scroll = 0;
    let row = pos.cursor - pos.scroll - 1;
    if (row > 3) {
      let j = 0;
      while (j <= row - 3) {
        if (pos.scroll + shown === total) break;
        row = row - 1;
        pos.scroll = pos.scroll + 1;
        j = j + 1;
      }
    }
  }
}

// Lua: bag_menu.lua:244
function field_fade_in(): void {
  // pcall(require, "src.ui.game3.fade")
  if (Fade && Fade.begin) {
    Fade.begin(Fade.MODE.FROM_BLACK, 1);
  }
}

// src/item_menu.c:915
// Lua: bag_menu.lua:252
function begin_open(curtain: boolean): void {
  BagMenu._exit = undefined;
  BagMenu._open = { k: 0, curtain };
}

// src/item_menu.c:893, 941
// Lua: bag_menu.lua:258
function begin_exit(curtain: boolean, cb?: () => void): void {
  BagMenu._open = undefined;
  BagMenu._switch = undefined;
  BagMenu._exit = { k: 0, curtain, cb };
}

// Lua: bag_menu.lua:264
function reshow(): void {
  if (BagMenu.open) begin_open(false);
}

// Close the bag and report the chosen item to the battle system.  partySlot is
// the real party index for party-targeted items, or nil otherwise.  Shared with
// the Berry Pouch so a berry picked there takes the same route as a potion.
// Lua: bag_menu.lua:271
BagMenu.battleUse = function (itemId: any, partySlot?: any, moveSlot?: any, usedInMenu?: boolean): void {
  begin_exit(true, () => {
    save_pos();
    const cb = BagMenu._onBattleUse;
    BagMenu._battleUsed = true;
    BagMenu.open = false;
    BagMenu._battle = false;
    BagMenu._onBattleUse = undefined;
    Stack.pop("bag");
    if (cb) cb(itemId, partySlot, moveSlot, usedInMenu);
  });
};

const QUIET_ADAPTER = { say: (): void => { /* quiet */ } };

// pokefirered/src/party_menu.c:4464 ItemUseCB_MedicineStep
// Lua: bag_menu.lua:287
BagMenu.commitBattlePartyUse = function (st: any, itemId: any, realSlot: any, mon: any, beforeUse?: () => void): void {
  const isPp = ItemsData.fieldUseKind(itemId) === "pp";
  const wont_have_effect = (err?: string): void => {
    se(SE.SE_SELECT); // pokefirered/src/party_menu.c:4490
    PartyMenu.showMessage(err || RomText.box("gText_WontHaveEffect"), () => {
      PartyMenu.mode = "use";
    });
  };
  const commit = (moveSlot?: any): void => {
    const [canUse, err] = BattleItems.canUseOn(st, itemId, realSlot, mon, moveSlot);
    if (!canUse) return wont_have_effect(err);
    const displaySlot = PartyMenu.cursor;
    const startHp = tonumber(mon ? mon.hp : undefined) ?? 0;
    const r = BattleItems.use(st, QUIET_ADAPTER, BagMenu._bag, BagMenu._session,
      itemId, realSlot, undefined, moveSlot);
    const result = r[0], text = r[4];
    if (result !== "heal") return wont_have_effect();
    const go = (): void => {
      PartyMenu.close();
      if (beforeUse) beforeUse();
      BagMenu.battleUse(itemId, realSlot, moveSlot, true);
    };
    // pokefirered/src/party_menu.c:4498
    se(BattleItems.isFlute(itemId) ? SE.SE_GLASS_FLUTE : SE.SE_USE_ITEM);
    const endHp = tonumber(mon ? mon.hp : undefined) ?? startHp;
    if (endHp > startHp) {
      // pokefirered/src/party_menu.c:4514 PartyMenuModifyHP
      PartyMenu.startHpAnim(displaySlot, startHp, endHp, tonumber(mon.maxHp || mon.maxhp) ?? endHp, () => {
        PartyMenu.showMessage(text, go);
      });
      return;
    }
    PartyMenu.showMessage(text, go);
  };
  if (isPp && mon && !mon.isEgg && ItemUse.ppItemNeedsMove(itemId)) {
    se(SE.SE_SELECT);
    PartyMenu.pickPpMove(mon, itemId, commit);
    return;
  }
  commit(undefined);
};

// Lua: bag_menu.lua:330
BagMenu.show = function (sessionBag: any, opts?: BagShowOpts): void {
  opts = opts || {};
  BagMenu.open = true;
  if (sessionBag && sessionBag.pockets) {
    BagMenu._bag = sessionBag;
    BagMenu._session = opts.session || (sessionBag.party && sessionBag);
  } else if (sessionBag && (sessionBag.bag || sessionBag.party)) {
    BagMenu._bag = sessionBag.bag || opts.bag;
    BagMenu._session = opts.session || sessionBag;
  } else {
    BagMenu._bag = opts.bag || sessionBag;
    BagMenu._session = opts.session || (sessionBag !== null && typeof sessionBag === "object" && sessionBag.party && sessionBag);
  }
  BagMenu._battle = opts.battle ? true : false;
  BagMenu._location = opts.location;
  BagMenu._onChoose = opts.onChoose;
  BagMenu._sell = undefined;
  BagMenu._onBattleUse = opts.onBattleUse;
  const profVer = Profile.sessionVersion(BagMenu._session);
  ItemsData.applyProfile(profVer);
  const st = bag_state();
  BagMenu.pocketIdx = opts.pocketIdx || st.pocket || 1;
  BagMenu.mode = "list";
  BagMenu.messageText = undefined;
  BagMenu._msgPages = undefined;
  BagMenu._msgPage = 1;
  BagMenu._msgDone = undefined;
  BagMenu.partyPurpose = "use";
  BagMenu.tossQty = 1;
  BagMenu._onClose = opts.onClose;
  if (opts.pocket) {
    if (typeof opts.pocket === "number") {
      BagMenu.pocketIdx = opts.pocket;
    } else {
      for (const [i, p] of ipairs<string>(ItemsData.BAG_POCKET_ORDER)) {
        if (p === opts.pocket || (opts.pocket === "BERRIES" && (p === "BERRIES" || p === "BERRY_POUCH"))
          || (opts.pocket === "TM_HM" && (p === "TM_HM" || p === "TM_CASE"))) {
          BagMenu.pocketIdx = i;
          break;
        }
      }
    }
  }
  if (!ItemsData.BAG_POCKET_ORDER[BagMenu.pocketIdx]) BagMenu.pocketIdx = 1;
  settle_scroll();
  load_pos(BagMenu.pocketIdx);
  clamp_cursor();
  BagMenu._switch = undefined;
  BagMenu._statBoost = undefined;
  BagMenu._shake = undefined;
  BagMenu._arrowK = 0;
  BagMenu._heldKey = undefined;
  BagMenu._bagAnim = { n: 0 };
  begin_open(true);
  Stack.push("bag", BagMenu as unknown as LuaTable, { hideBelow: !BagMenu._battle, fullscreen: !BagMenu._battle });
};

// Lua: bag_menu.lua:387
BagMenu.close = function (): void {
  if (BagMenu.open) save_pos();
  BagMenu._open = undefined;
  BagMenu._exit = undefined;
  BagMenu._switch = undefined;
  BagMenu._msgDone = undefined;
  BagMenu.open = false;
  const battleCb = BagMenu._onBattleUse;
  const wasBattle = BagMenu._battle;
  BagMenu._battle = false;
  BagMenu._onBattleUse = undefined;
  Stack.pop("bag");
  const cb = BagMenu._onClose;
  BagMenu._onClose = undefined;
  if (cb) cb();
  if (wasBattle && battleCb && !BagMenu._battleUsed) {
    battleCb(undefined);
  }
  BagMenu._battleUsed = undefined;
};

// Lua: bag_menu.lua:408
function close_to_field(): void {
  const battle = BagMenu._battle;
  BagMenu.close();
  if (!battle) field_fade_in();
}

// pokeemerald/src/item_menu.c:277
// Lua: bag_menu.lua:415
function choose_done(itemId: any): void {
  const cb = BagMenu._onChoose;
  BagMenu._onChoose = undefined;
  BagMenu.close();
  if (cb) cb(itemId || 0);
}

// src/item_menu.c:194 sItemMenuContextActions
const ACTION_TEXT: Record<string, number> = { USE: 0, TOSS: 1, SET: 2, GIVE: 3, CANCEL: 4, OPEN: 7 };
// include/constants/items.h:432
const ITEM_BICYCLE = 360;

// src/item_menu.c:1401
// Lua: bag_menu.lua:428
function action_label(act: string, row: BagRow | null | undefined): string {
  let i = ACTION_TEXT[act]!;
  const num = row && ItemsData.toNumericId(row.id);
  if (act === "SET" && num != null && BagMenu._session
    && ItemsData.toNumericId(BagMenu._session.registeredItem) === num) {
    i = 10;
  } else if (act === "USE" && !BagMenu._battle && BagMenu.currentPocket() === "KEY_ITEMS") {
    // package.loaded["src.core.game3.player"]
    if (num === ItemsData.ITEM_TM_CASE || num === ItemsData.ITEM_BERRY_POUCH) {
      i = 7;
    } else if (num === ITEM_BICYCLE && Player && Player.biking) {
      i = 9;
    }
  }
  return RomText.at("sItemMenuContextActions", i);
}

// Lua: bag_menu.lua:445
function refresh_actions(): void {
  const rows = BagMenu.list();
  const row = rows[BagMenu.cursor];
  BagMenu.ACTIONS = actions_for_pocket(BagMenu.currentPocket(), row);
  if (BagMenu.actionCursor > len(BagMenu.ACTIONS)) {
    BagMenu.actionCursor = 1;
  }
}

// Lua: bag_menu.lua:454
function pocket_switch_dir(input: BagInput, pocketIdx: number): number {
  // src/item_menu.c:1124
  if (BagMenu._location === "itempc") return 0;
  // pokeemerald/src/item_menu.c:630
  if (BagMenu._location === "berry_tree" || BagMenu._location === "blender") return 0;
  const lr = Options.lrMode(BagMenu._session);
  if (input.wasPressed("left") || (lr && input.wasPressed("l"))) {
    if (pocketIdx <= 1) return 0;
    se(bag_se("SE_BAG_POCKET", "bagPocket"));
    return -1;
  }
  if (input.wasPressed("right") || (lr && input.wasPressed("r"))) {
    if (pocketIdx >= len(ItemsData.BAG_POCKET_ORDER)) return 0;
    se(bag_se("SE_BAG_POCKET", "bagPocket"));
    return 1;
  }
  return 0;
}

// src/item_menu.c:1147
// Lua: bag_menu.lua:474
function start_switch(dir: number): void {
  save_pos();
  BagMenu.pocketIdx = BagMenu.pocketIdx + dir;
  load_pos(BagMenu.pocketIdx);
  clamp_cursor();
  BagMenu._switch = { dir, k: 0 };
  BagMenu._bagAnim = { n: 0 };
  if (BagMenu._shake) BagMenu._shake.cb = false;
}

// Lua: bag_menu.lua:484
function shake_ended(): boolean {
  const s = BagMenu._shake;
  return s == null || (s.phase === "shake" && s.j >= 13);
}

// src/item_menu.c:677
// Lua: bag_menu.lua:490
function cursor_moved(): void {
  se(bag_se("SE_BAG_CURSOR", "bagCursor"));
  if (shake_ended()) {
    BagMenu._shake = { phase: "shake", j: 0, cb: true };
  }
}

// src/list_menu.c:438
// Lua: bag_menu.lua:498
function move_cursor(down: boolean): boolean {
  const total = len(BagMenu.list()) + 1;
  const shown = max_showed(total);
  let scroll = BagMenu.scroll;
  let row = BagMenu.cursor - scroll - 1;
  let newRow: number;
  if (!down) {
    newRow = (shown === 1) ? 0 : (shown - (Math.floor(shown / 2) + mod(shown, 2)) - 1);
    if (scroll === 0) {
      if (row === 0) return false;
      row = row - 1;
    } else if (row > newRow) {
      row = row - 1;
    } else {
      row = newRow;
      scroll = scroll - 1;
    }
  } else {
    newRow = (shown === 1) ? 0 : (Math.floor(shown / 2) + mod(shown, 2));
    if (scroll === total - shown) {
      if (row >= shown - 1) return false;
      row = row + 1;
    } else if (row < newRow) {
      row = row + 1;
    } else {
      row = newRow;
      scroll = scroll + 1;
    }
  }
  BagMenu.scroll = scroll;
  BagMenu.cursor = scroll + row + 1;
  return true;
}

// Lua: bag_menu.lua:532
function held_repeat(input: BagInput, key: string): boolean {
  if (input.wasPressed(key)) return true;
  // src/main.c:309
  return BagMenu._heldKey === key && BagMenu._heldFrames! >= 40
    && mod(BagMenu._heldFrames! - 40, 5) === 0;
}

// Lua: bag_menu.lua:539
function track_held(input: BagInput): void {
  let key: string | undefined;
  if (input.isDown) {
    if (input.isDown("up")) key = "up"; else if (input.isDown("down")) key = "down";
  }
  if (key !== BagMenu._heldKey || input.wasPressed(key || "")) {
    BagMenu._heldKey = key;
    BagMenu._heldFrames = 0;
  } else if (key) {
    BagMenu._heldFrames = (BagMenu._heldFrames ?? 0) + 1;
  }
}

// Lua: bag_menu.lua:552
function open_submenu(fn: () => void): void {
  begin_exit(false, fn);
}

// src/text.c:796
// Lua: bag_menu.lua:557
function show_bag_message(text: string, onDone?: () => void): void {
  // TextIR.splitPages returns a 0-based array (TextIR's convention).
  const pages = TextIR.splitPages(TextIR.restoreExt(gsub(TextIR.protectExt(text), "\\p", "\f")[0]));
  BagMenu.mode = "message";
  BagMenu._msgPages = pages.length > 1 ? pages : undefined;
  BagMenu._msgPage = 1;
  BagMenu.messageText = pages[0] ?? text;
  BagMenu._msgDone = onDone;
}

// src/item_menu.c:1018 DisplayItemMessageInBag
BagMenu.showMessage = show_bag_message;

// src/item_use.c:182
// Lua: bag_menu.lua:570
function use_field_from_bag(session: any, bag: any, id: any): [boolean, any, any] {
  return ItemUse.useField(session, bag, id, undefined);
}

// src/item_menu.c:1787 Task_ItemContext_Sell
// Lua: bag_menu.lua:575
function begin_sell(row: BagRow): void {
  const num = ItemsData.toNumericId(row.id);
  const savedState = { pocketIdx: BagMenu.pocketIdx, cursor: BagMenu.cursor, scroll: BagMenu.scroll };
  const back = (): void => {
    BagMenu.pocketIdx = savedState.pocketIdx;
    BagMenu.cursor = savedState.cursor;
    BagMenu.scroll = savedState.scroll;
    BagMenu.mode = "list";
    clamp_cursor();
    reshow();
  };
  const frlgCases = Profile.family(BagMenu._session) !== "rse";
  if (frlgCases && num === ItemsData.ITEM_TM_CASE) {
    // src/item_menu.c:1825 GoToTMCase_Sell
    open_submenu(() => {
      TmCase.show(BagMenu._session, BagMenu._bag, {
        session: BagMenu._session, bag: BagMenu._bag, sell: true, onClose: back,
      });
    });
    return;
  } else if (frlgCases && num === ItemsData.ITEM_BERRY_POUCH) {
    // src/item_menu.c:1830 GoToBerryPouch_Sell
    open_submenu(() => {
      BerryPouch.show(BagMenu._session, BagMenu._bag, {
        session: BagMenu._session, bag: BagMenu._bag, sell: true, onClose: back,
      });
    });
    return;
  }
  BagMenu.mode = "sell";
  BagMenu._sell = SellFlow.start({
    itemId: row.id,
    owned: row.qty,
    session: BagMenu._session,
    bag: BagMenu._bag,
    onDone: () => {
      BagMenu._sell = undefined;
      BagMenu.mode = "list";
      clamp_cursor();
    },
  });
}

// src/item_menu.c:2004 Task_TryDoItemDeposit
// Lua: bag_menu.lua:619
function try_deposit(): void {
  const row = BagMenu.list()[BagMenu.cursor]!;
  if (Storage.addPcItem(BagMenu._session, row.id, BagMenu.tossQty)[0]) {
    QuestLogRecorder.event(BagMenu._session, "StoredItemInPC",
      seq(ItemsData.displayName(row.id)));
    BagMenu._depositPending = { id: row.id, qty: BagMenu.tossQty };
    BagMenu.mode = "deposit_done";
    BagMenu._depositText = RomText.box("gText_DepositedStrVar2StrVar1s",
      { stringVars: seq(row.name, tostring(BagMenu.tossQty)) });
  } else {
    show_bag_message(RomText.plain("gText_NoRoomToStoreItems"));
  }
}

// src/item_menu.c:1959 Task_ItemContext_Deposit
// Lua: bag_menu.lua:635
function begin_deposit(row: BagRow): void {
  BagMenu.tossQty = 1;
  if ((tonumber(row.qty) ?? 1) === 1) {
    try_deposit();
  } else {
    BagMenu.mode = "deposit";
  }
}

/** Close the start menu under the bag (the field-use exits share this). */
function close_start_menu(): void {
  // package.loaded["src.ui.game3.start_menu"]
  if (StartMenu && StartMenu.isOpen && StartMenu.isOpen()) {
    StartMenu.open = false;
    StartMenu._onClose = undefined;
    Stack.pop("start");
  }
}

// Lua: bag_menu.lua:644
function handle_menu_input(input: BagInput): void {
  if (BagMenu.mode === "sell" && BagMenu._sell) {
    BagMenu._sell.handleInput(input);
    return;
  }
  if (BagMenu.mode === "flute_wait") {
    // pokefirered/src/item_use.c:607
    const w = BagMenu._fluteWait!;
    w.frames = w.frames + 1;
    if (w.frames >= ItemUse.BLACK_WHITE_FLUTE_DELAY) {
      BagMenu._fluteWait = undefined;
      ItemUse.playBlackWhiteFlute();
      show_bag_message(w.text);
    }
    return;
  }
  // src/item_menu.c:1974 Task_SelectQuantityToDeposit
  if (BagMenu.mode === "deposit") {
    BagMenu._depositK = (BagMenu._depositK ?? 0) + 1;
    const row = BagMenu.list()[BagMenu.cursor]!;
    const qmax = Math.min(999, tonumber(row.qty) ?? 1);
    let q = BagMenu.tossQty;
    if (input.wasPressed("up")) {
      q = q + 1;
      if (q > qmax) q = 1;
    } else if (input.wasPressed("down")) {
      q = q - 1;
      if (q <= 0) q = qmax;
    } else if (input.wasPressed("right")) {
      q = Math.min(qmax, q + 10);
    } else if (input.wasPressed("left")) {
      q = Math.max(1, q - 10);
    }
    if (q !== BagMenu.tossQty) {
      BagMenu.tossQty = q;
      se(SE.SE_SELECT);
    } else if (input.wasPressed("a")) {
      se(SE.SE_SELECT);
      try_deposit();
    } else if (input.wasPressed("b")) {
      se(SE.SE_SELECT);
      BagMenu.mode = "list";
    }
    return;
  }
  // src/item_menu.c:1563 Task_WaitAB_RedrawAndReturnToBag
  if (BagMenu.mode === "deposit_done") {
    if (input.wasPressed("a") || input.wasPressed("b")) {
      se(SE.SE_SELECT);
      const p = BagMenu._depositPending;
      BagMenu._depositPending = undefined;
      if (p) Bag.remove(BagMenu._bag, p.id, p.qty);
      BagMenu.mode = "list";
      clamp_cursor();
    }
    return;
  }
  if (BagMenu.mode === "toss") {
    const rows = BagMenu.list();
    const row = rows[BagMenu.cursor];
    const maxQ = row ? (tonumber(row.qty) ?? 1) : 1;
    if (input.wasPressed("up") || input.wasPressed("right")) {
      BagMenu.tossQty = Math.min(maxQ, BagMenu.tossQty + 1);
      se(SE.SE_SELECT);
    } else if (input.wasPressed("down") || input.wasPressed("left")) {
      BagMenu.tossQty = Math.max(1, BagMenu.tossQty - 1);
      se(SE.SE_SELECT);
    } else if (input.wasPressed("a")) {
      se(SE.SE_SELECT); // src/item_menu.c:1528
      BagMenu.mode = "toss_confirm";
      BagMenu.yesNoCursor = 1;
    } else if (input.wasPressed("b")) {
      se(SE.SE_SELECT); // pokefirered/src/item_menu.c:1540
      BagMenu.mode = "list";
    }
    return;
  }
  // src/item_menu.c:1502 Task_ConfirmTossItems
  if (BagMenu.mode === "toss_confirm") {
    if (input.wasPressed("up") || input.wasPressed("down")) {
      BagMenu.yesNoCursor = (BagMenu.yesNoCursor === 1) ? 2 : 1;
      se(SE.SE_SELECT);
    } else if (input.wasPressed("a") && BagMenu.yesNoCursor === 1) {
      se(SE.SE_SELECT);
      BagMenu.mode = "toss_done";
    } else if (input.wasPressed("a") || input.wasPressed("b")) {
      se(SE.SE_SELECT); // src/item_menu.c:1511
      BagMenu.mode = "list";
    }
    return;
  }
  // src/item_menu.c:1563 Task_WaitAB_RedrawAndReturnToBag
  if (BagMenu.mode === "toss_done") {
    if (input.wasPressed("a") || input.wasPressed("b")) {
      se(SE.SE_SELECT);
      const row = BagMenu.list()[BagMenu.cursor];
      if (row) {
        Bag.remove(BagMenu._bag, row.id, BagMenu.tossQty);
      }
      BagMenu.mode = "list";
      clamp_cursor();
    }
    return;
  }

  if (BagMenu.mode === "message") {
    if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
      se(SE.SE_SELECT);
      const pages = BagMenu._msgPages;
      // pokefirered/src/text.c:796 (pages is 0-based; _msgPage keeps Lua's 1-based count)
      if (pages && BagMenu._msgPage < pages.length) {
        BagMenu._msgPage = BagMenu._msgPage + 1;
        BagMenu.messageText = pages[BagMenu._msgPage - 1];
        return;
      }
      BagMenu.mode = "list";
      BagMenu.messageText = undefined;
      BagMenu._msgPages = undefined;
      BagMenu._msgPage = 1;
      clamp_cursor();
      // pokefirered/src/item_menu.c:1018 DisplayItemMessageInBag followUpFunc
      const onDone = BagMenu._msgDone;
      BagMenu._msgDone = undefined;
      if (onDone) onDone();
    }
    return;
  }

  if (BagMenu.mode === "action") {
    refresh_actions();
    if (input.wasPressed("up")) {
      BagMenu.actionCursor = mod(BagMenu.actionCursor - 2, len(BagMenu.ACTIONS)) + 1;
      se(SE.SE_SELECT);
    } else if (input.wasPressed("down")) {
      BagMenu.actionCursor = mod(BagMenu.actionCursor, len(BagMenu.ACTIONS)) + 1;
      se(SE.SE_SELECT);
    } else if (input.wasPressed("a")) {
      se(SE.SE_SELECT);
      const act = BagMenu.ACTIONS[BagMenu.actionCursor];
      const rows = clamp_cursor();
      const row = rows[BagMenu.cursor];
      const party: LuaTable = (BagMenu._session && BagMenu._session.party) || seq();
      if (act === "CANCEL" || !row) {
        BagMenu.mode = "list";
      } else if (act === "CHECK_TAG") {
        if (!check_tag(rows)) BagMenu.mode = "list";
      } else if (act === "CONFIRM") {
        // pokeemerald/src/item_menu.c:277
        const id = row.id;
        begin_exit(true, () => { choose_done(id); });
      } else if (act === "USE") {
        if (BagMenu._battle && BagMenu._onBattleUse) {
          if (BattleItems.needsPartySelect(row.id)) {
            // package.loaded["src.core.game3.battle"]
            const st = Battle ? (Battle as any)._st : undefined;
            // Mid-battle the party list has to come from the live battle copy:
            // session.party is only written back once the battle ends, so
            // reading it here shows pre-battle HP and refuses heals that would
            // in fact work.
            const liveParty = PartyView.live(BagMenu._session);
            // pokefirered/src/party_menu.c:5878
            PartyMenu.show(liveParty, BagMenu._session && BagMenu._session.moveOverlay, {
              session: BagMenu._session,
              bag: BagMenu._bag,
              item: row.id,
              mode: "use",
              battle: true,
              battleOrder: st && st.playerParty ? PartyMenu.battleOrder(st) : undefined,
              layout: (st && st.double) ? "double" : undefined,
              onSelect: (slot: any) => {
                if (!truthy(slot) || slot === 7) {
                  PartyMenu.close();
                  return;
                }
                // PartyMenu.show's battleOrder wrapper (party_menu.lua
                // apply_battle_order) already turned the tapped row into a real
                // party slot, so translating again would heal the wrong mon.
                const realSlot = slot;
                const mon = liveParty && liveParty[realSlot];
                BagMenu.commitBattlePartyUse(st, row.id, realSlot, mon);
              },
              onClose: () => {
                BagMenu.mode = "list";
                clamp_cursor();
              },
            });
            return;
          } else if (BattleItems.isStatBooster(row.id)) {
            // package.loaded["src.core.game3.battle"] / ["...battle.ui"]
            const st = Battle ? (Battle as any)._st : undefined;
            const Ui = BattleUi;
            const battlerId = (st && st.double && Ui && Ui._active) || 0;
            // pokefirered/src/item_use.c:755 BattleUseFunc_StatBooster
            if (!(st && BattleItems.statBoosterHasEffect(st, row.id, battlerId))) {
              show_bag_message(RomText.box("gText_WontHaveEffect"));
              return;
            }
            BagMenu._statBoost = { frames: 0, st, itemId: row.id, battlerId };
            return;
          } else {
            // src/item_use.c:742
            BagMenu.battleUse(row.id, undefined);
            return;
          }
        } else {
          const numId = ItemsData.toNumericId(row.id);
          const frlgCases = Profile.family(BagMenu._session) !== "rse";
          if (frlgCases && (numId === ItemsData.ITEM_TM_CASE || row.id === "TM_CASE")) {
            const savedState = { pocketIdx: BagMenu.pocketIdx, cursor: BagMenu.cursor, scroll: BagMenu.scroll };
            open_submenu(() => {
              TmCase.show(BagMenu._session, BagMenu._bag, {
                session: BagMenu._session,
                bag: BagMenu._bag,
                onClose: () => {
                  BagMenu.pocketIdx = savedState.pocketIdx;
                  BagMenu.cursor = savedState.cursor;
                  BagMenu.scroll = savedState.scroll;
                  BagMenu.mode = "list";
                  clamp_cursor();
                  reshow();
                },
              });
            });
            return;
          } else if (frlgCases && (numId === ItemsData.ITEM_BERRY_POUCH || row.id === "BERRY_POUCH")) {
            const savedState = { pocketIdx: BagMenu.pocketIdx, cursor: BagMenu.cursor, scroll: BagMenu.scroll };
            open_submenu(() => {
              BerryPouch.show(BagMenu._session, BagMenu._bag, {
                session: BagMenu._session,
                bag: BagMenu._bag,
                onClose: () => {
                  BagMenu.pocketIdx = savedState.pocketIdx;
                  BagMenu.cursor = savedState.cursor;
                  BagMenu.scroll = savedState.scroll;
                  BagMenu.mode = "list";
                  clamp_cursor();
                  reshow();
                },
              });
            });
            return;
          } else if (ItemUse.needsPartyTarget(row.id)) {
            if (len(party) === 0) {
              BagMenu.mode = "message";
              BagMenu.messageText = RomText.plain("gText_ThereIsNoPokemon");
            } else {
              open_submenu(() => {
                PartyMenu.show(party, BagMenu._session && BagMenu._session.moveOverlay, {
                  session: BagMenu._session,
                  bag: BagMenu._bag,
                  item: row.id,
                  mode: "use",
                  onClose: () => {
                    BagMenu.mode = "list";
                    clamp_cursor();
                    reshow();
                  },
                });
              });
            }
          } else {
            const [ok, kind, text] = use_field_from_bag(BagMenu._session, BagMenu._bag, row.id);
            if (kind === "vs_seeker" && !ok) {
              BagMenu.mode = "message";
              BagMenu.messageText = text;
            } else if (kind === "vs_seeker") {
              // pokefirered/src/item_use.c:727
              const session = BagMenu._session;
              begin_exit(true, () => {
                BagMenu.close();
                close_start_menu();
                field_fade_in();
                VsSeeker.use(session, undefined);
              });
              return;
            } else if (kind === "itemfinder") {
              const session = BagMenu._session;
              begin_exit(true, () => {
                BagMenu.close();
                close_start_menu();
                field_fade_in();
                Field.useItemfinder(session, true);
              });
              return;
            } else if (ok && kind === "escape") {
              // pokefirered/src/item_use.c:159 SetUpItemUseOnFieldCallback
              begin_exit(true, () => {
                BagMenu.close();
                close_start_menu();
                field_fade_in();
                ItemUse.runOnFieldCallback();
              });
              return;
            } else if (ok && FIELD_EXIT_FADE[kind] != null) {
              // pokefirered/src/item_use.c:159
              const fade = FIELD_EXIT_FADE[kind];
              begin_exit(true, () => {
                BagMenu.close();
                close_start_menu();
                if (fade) field_fade_in();
              });
              return;
            } else if (ok && kind === "black_white_flute") {
              // pokefirered/src/item_use.c:582
              BagMenu.mode = "flute_wait";
              BagMenu._fluteWait = { frames: 0, text };
            } else if (ok && kind === "map") {
              // pokefirered/src/item_use.c:649
              BagMenu.mode = "list";
              clamp_cursor();
            } else if (truthy(text)) {
              // pokefirered/src/item_use.c:186
              show_bag_message(text);
            } else {
              BagMenu.mode = "list";
              clamp_cursor();
            }
          }
        }
      } else if (act === "GIVE") {
        const pocket = BagMenu.currentPocket();
        if (pocket === "KEY_ITEMS" || pocket === "TM_CASE") {
          BagMenu.mode = "message";
          // src/item_menu.c:1635
          BagMenu.messageText = RomText.box("gText_ItemCantBeHeld",
            { stringVars: seq(ItemsData.displayName(row.id)) });
        } else if (len(party) === 0) {
          BagMenu.mode = "message";
          BagMenu.messageText = RomText.plain("gText_ThereIsNoPokemon");
        } else {
          const giveSource = BagMenu._location === "party" ? ItemUse.partyGiveSource(BagMenu._bag) : undefined;
          // src/item_menu.c:1620
          open_submenu(() => {
            PartyMenu.show(party, BagMenu._session && BagMenu._session.moveOverlay, {
              session: BagMenu._session,
              bag: BagMenu._bag,
              item: row.id,
              mode: "give",
              giveSource,
              onClose: () => {
                BagMenu.mode = "list";
                clamp_cursor();
                reshow();
              },
            });
          });
        }
      } else if (act === "OPEN") {
        open_submenu(() => {
          BerryPouch.show(BagMenu._session, BagMenu._bag, {
            session: BagMenu._session,
            bag: BagMenu._bag,
            onClose: () => {
              BagMenu.mode = "list";
              clamp_cursor();
              reshow();
            },
          });
        });
        return;
      } else if (act === "TOSS") {
        // src/item_menu.c:1491
        BagMenu.tossQty = 1;
        BagMenu.yesNoCursor = 1;
        BagMenu.mode = ((tonumber(row.qty) ?? 1) === 1) ? "toss_confirm" : "toss";
      } else if (act === "SET" || act === "REGISTER") {
        if (BagMenu._session && row) {
          if (BagMenu._session.registeredItem === row.id) {
            BagMenu._session.registeredItem = null;
          } else {
            BagMenu._session.registeredItem = row.id;
          }
        }
        BagMenu.mode = "list";
      }
    } else if (input.wasPressed("b")) {
      se(SE.SE_SELECT); // pokefirered/src/item_menu.c:1453
      BagMenu.mode = "list";
    }
    return;
  }

  // src/item_menu.c:1050
  const dir = pocket_switch_dir(input, BagMenu.pocketIdx);
  if (dir !== 0) {
    start_switch(dir);
    return;
  }
  if (input.wasPressed("select") && !BagMenu._battle) {
    const rows = clamp_cursor();
    const row = rows[BagMenu.cursor];
    if (row && BagMenu.currentPocket() === "KEY_ITEMS") {
      const info = row.info || ItemsData.info(row.id);
      const registrable = info && (tonumber(info.registrability) ?? 0) > 0;
      if (registrable && BagMenu._session) {
        if (BagMenu._session.registeredItem === row.id) {
          BagMenu._session.registeredItem = null;
        } else {
          BagMenu._session.registeredItem = row.id;
        }
        se(SE.SE_SELECT);
      }
    }
    return;
  }
  const rows = clamp_cursor();
  const choosing = BagMenu._location === "berry_tree" || BagMenu._location === "blender";
  if (choosing && (input.wasPressed("b") || (input.wasPressed("a") && BagMenu.cursor > len(rows)))) {
    // pokeemerald/src/item_menu.c:1251
    if (BagMenu._location === "blender") {
      se(SE.SE_FAILURE);
    } else {
      se(SE.SE_SELECT);
      begin_exit(true, () => { choose_done(0); });
    }
    return;
  }
  if (input.wasPressed("a")) {
    se(SE.SE_SELECT);
    if (BagMenu.cursor > len(rows)) {
      // src/item_menu.c:1085
      begin_exit(true, close_to_field);
    } else if (BagMenu._location === "berry_tree") {
      // pokeemerald/src/item_menu.c:346
      const id = rows[BagMenu.cursor]!.id;
      begin_exit(true, () => { choose_done(id); });
    } else if (BagMenu._location === "shop") {
      begin_sell(rows[BagMenu.cursor]!);
    } else if (BagMenu._location === "itempc") {
      begin_deposit(rows[BagMenu.cursor]!);
    } else {
      BagMenu.mode = "action";
      BagMenu.actionCursor = 1;
      refresh_actions();
    }
  } else if (input.wasPressed("b")) {
    se(SE.SE_SELECT);
    begin_exit(true, close_to_field);
  } else if (held_repeat(input, "up")) {
    if (move_cursor(false)) cursor_moved();
  } else if (held_repeat(input, "down")) {
    if (move_cursor(true)) cursor_moved();
  }
}

// src/item_menu.c:1169
// Lua: bag_menu.lua:1118
function run_transitions(input: BagInput): boolean {
  const ex = BagMenu._exit;
  if (ex) {
    ex.k = ex.k + 1;
    if (ex.k >= 15) {
      BagMenu._exit = undefined;
      if (ex.cb) ex.cb();
    }
    return true;
  }
  const op = BagMenu._open;
  if (op) {
    op.k = op.k + 1;
    if (op.k < 23) return true;
    BagMenu._open = undefined;
  }
  const sw = BagMenu._switch;
  if (sw) {
    const dir = pocket_switch_dir(input, BagMenu.pocketIdx);
    if (dir !== 0) {
      start_switch(dir);
      return true;
    }
    sw.k = sw.k + 1;
    if (sw.k >= 13) {
      BagMenu._switch = undefined;
      clamp_cursor();
    }
    return true;
  }
  return false;
}

// Lua: bag_menu.lua:1151
function arrows_live(): boolean {
  return BagMenu.mode === "list" && !BagMenu._switch;
}

// src/sprite.c:304
// Lua: bag_menu.lua:1156
function animate_sprites(): void {
  if (BagMenu._bagAnim) {
    BagMenu._bagAnim.n = BagMenu._bagAnim.n + 1;
    if (BagMenu._bagAnim.n > 6) BagMenu._bagAnim = undefined;
  }
  const s = BagMenu._shake;
  if (s) {
    if (s.phase === "shake") {
      if (s.j < 13) {
        s.j = s.j + 1;
      } else if (s.cb) {
        s.phase = "idle";
      } else {
        BagMenu._shake = undefined;
      }
    } else {
      BagMenu._shake = undefined;
    }
  }
  if (arrows_live()) {
    BagMenu._arrowK = (BagMenu._arrowK ?? -1) + 1;
  } else {
    BagMenu._arrowK = undefined;
  }
}

const NO_INPUT: BagInput = { wasPressed: () => false };

// Lua: bag_menu.lua:1184
function press_input(key: string | undefined): BagInput {
  return { wasPressed: (k: string) => k === key, isDown: () => false };
}

// pokefirered/include/constants/items.h:7
const ITEM_POKE_BALL = 4;
const ITEM_ANTIDOTE = 14;

BagMenu.POKEDUDE_PLANS = {
  // pokefirered/src/item_menu.c:2262 Task_Bag_TeachyTvCatching
  catching: seq<PlanEntry>(
    { at: 102, key: "right" }, { at: 204, key: "right" },
    { at: 306, key: "down" }, { at: 408, key: "down" },
    { at: 510, key: "up" }, { at: 612, key: "up" },
    { at: 714, key: "a", item: ITEM_POKE_BALL },
    { at: 816, exit: true },
  ),
  // pokefirered/src/item_menu.c:2316 Task_Bag_TeachyTvStatus
  status: seq<PlanEntry>(
    { at: 102, key: "down" },
    { at: 204, key: "a", item: ITEM_ANTIDOTE },
    { at: 306, exit: true },
  ),
};

// Lua: bag_menu.lua:1209
function finish_pokedude(itemId: any): void {
  const pd = BagMenu._pokedude;
  if (!pd) return;
  BagMenu._pokedude = undefined;
  BagMenu.close();
  // pokefirered/src/item_menu.c:2089 RestorePlayerBag
  if (pd.savedState != null) sessionState.set(pd.key, pd.savedState); else sessionState.delete(pd.key);
  for (const [k, v] of pairs(pd.view || {})) (BagMenu as any)[k] = v;
  if (truthy(itemId)) {
    if (pd.onItem) pd.onItem(itemId);
  } else if (pd.onCancel) {
    pd.onCancel();
  }
}

// Lua: bag_menu.lua:1224
function pokedude_tick(input: BagInput | undefined): void {
  const pd = BagMenu._pokedude;
  let inp = NO_INPUT;
  if (!(pd.done || BagMenu._open || BagMenu._exit)) {
    if (input && input.wasPressed && input.wasPressed("b")) {
      // pokefirered/src/item_menu.c:2192 Task_BButtonInterruptTeachyTv
      pd.done = true;
      begin_exit(true, () => { finish_pokedude(undefined); });
    } else {
      const entry: PlanEntry | null | undefined = pd.plan[pd.index];
      if (entry && pd.frames === entry.at) {
        pd.index = pd.index + 1;
        if (entry.item) pd.item = entry.item;
        if (entry.exit) {
          se(SE.SE_SELECT);
          BagMenu.mode = "list";
          pd.done = true;
          // pokefirered/src/item_menu.c:2309 Task_Pokedude_FadeFromBag
          begin_exit(true, () => { finish_pokedude(pd.item); });
        } else {
          inp = press_input(entry.key);
        }
      }
      pd.frames = pd.frames + 1;
    }
  }
  track_held(inp);
  if (!run_transitions(inp)) {
    handle_menu_input(inp);
  }
  animate_sprites();
}

// Lua: bag_menu.lua:1257
BagMenu.isPokedude = function (): boolean {
  return BagMenu._pokedude != null;
};

// pokefirered/src/item_menu.c:2162 InitPokedudeBag
// Lua: bag_menu.lua:1262
BagMenu.showPokedude = function (sessionBag: any, opts?: any): void {
  opts = opts || {};
  const plan = BagMenu.POKEDUDE_PLANS[opts.plan];
  if (!plan) throw new Error("no pokedude bag plan " + tostring(opts.plan));
  const key = opts.session || sessionBag;
  const saved = sessionState.get(key);
  // pokefirered/src/item_menu.c:2069 sBackupPlayerBag->pocket = gBagMenuState.pocket
  const view: Record<string, unknown> = {};
  for (const k of ["pocketIdx", "cursor", "scroll", "mode", "actionCursor", "ACTIONS",
    "_bag", "_session", "_battle", "_location", "_onClose", "_onBattleUse"]) {
    const v = (BagMenu as any)[k];
    if (v != null) view[k] = v; // a Lua table holds no nil values
  }
  // pokefirered/src/item_menu.c:2079 ResetBagCursorPositions
  sessionState.set(key, { pocket: 1, pos: {} });
  BagMenu.show(sessionBag, { session: opts.session, battle: true, pocket: "ITEMS" });
  BagMenu._pokedude = {
    plan, index: 1, frames: 0, key, savedState: saved, view,
    onItem: opts.onItem, onCancel: opts.onCancel,
  };
};

// pokefirered/src/item_use.c:766 Task_BattleUse_StatBooster_DelayAndPrint
// Lua: bag_menu.lua:1284
function stat_boost_tick(): void {
  const sb = BagMenu._statBoost!;
  sb.frames = sb.frames + 1;
  if (sb.frames <= 7) return;
  BagMenu._statBoost = undefined;
  se(SE.SE_USE_ITEM);
  const text = BattleItems.use(sb.st, QUIET_ADAPTER, BagMenu._bag, BagMenu._session,
    sb.itemId, undefined, sb.battlerId)[4];
  // pokefirered/src/item_use.c:779 Task_BattleUse_StatBooster_WaitButton_ReturnToBattle
  show_bag_message(text || "", () => {
    BagMenu.battleUse(sb.itemId, undefined, undefined, true);
  });
}

// Lua: bag_menu.lua:1299
BagMenu.handleInput = function (input: BagInput): any {
  if (BagMenu._battle) {
    const top = Stack.top();
    if (top && top.mod !== (BagMenu as unknown) && top.mod && top.mod.handleInput) {
      return top.mod.handleInput(input);
    }
  }
  if (BagMenu._pokedude) return pokedude_tick(input);
  if (BagMenu._statBoost) return stat_boost_tick();
  track_held(input);
  if (!run_transitions(input)) {
    handle_menu_input(input);
  }
  animate_sprites();
};

// Lua: bag_menu.lua:1315
BagMenu.settle = function (): void {
  for (let n = 1; n <= 64; n++) {
    if (!(BagMenu._open || BagMenu._exit || BagMenu._switch)) return;
    BagMenu.handleInput(NO_INPUT);
  }
};

// Lua: bag_menu.lua:1322
function bob(k: number | undefined, freq: number): number {
  if (k == null || k < 1) return 0;
  const v = Trig.sin(mod((k - 1) * freq, 256)) * 2 / 256;
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}

// Lua: bag_menu.lua:1328
BagMenu.draw = function (): void {
  if (!BagMenu.open) return;
  const pocket = BagMenu.currentPocket();
  const rows = clamp_cursor();
  const total = len(rows) + 1;
  const switching = BagMenu._switch != null;
  const selected = BagMenu.mode !== "list";

  let female = false;
  const session = BagMenu._session;
  if (session && (session.gender === 1 || session.gender === "female"
    || session.playerGender === 1)) {
    female = true;
  }

  // pcall(require, "src.ui.game3.bag_chrome")
  const chrome = !!(BagChrome && BagChrome.ready && BagChrome.ready());
  if (chrome) {
    BagChrome.drawBg(0, 0, { female, itemPc: BagMenu._location === "itempc" });
    if (switching) {
      BagChrome.drawListFrame(Math.min(12, BagMenu._switch!.k), female);
    }
    if (selected) {
      BagChrome.drawDescSelected();
    }
    const anim = BagMenu._bagAnim;
    let frame: number | undefined = undefined, y2 = 0;
    if (anim) {
      y2 = Math.min(0, anim.n - 5);
      if (anim.n <= 5) frame = 0;
    }
    let rot = 0;
    const s = BagMenu._shake;
    if (s && s.phase === "shake" && s.j >= 1 && s.j <= 12) rot = SHAKE_ROT[s.j]!;
    BagChrome.drawBag(8, 36 + y2, {
      female, pocketIdx: BagMenu.pocketIdx, frame, rotation: rot,
    });
  }

  if (BagMenu._location === "itempc") {
    // src/bag.c:232 BagDrawDepositItemTextBox
    Window.fixedStdFrame(Window.template(1, 1, 8, 2));
    const dLabel = RomText.plain("gText_DepositItem");
    FrlgFont.draw(dLabel, 8 + Math.floor((64 - FrlgFont.measure(dLabel, { small: true })) / 2), 8 + 1,
      { small: true, colors: FrlgFont.COLOR.NORMAL });
  } else if (!switching) {
    // src/bag.c:226
    const pLabel = ItemsData.POCKET_LABEL[pocket];
    const tw = FrlgFont.measure(pLabel);
    FrlgFont.draw(pLabel, 8 + Math.floor((72 - tw) / 2), 9, { colors: BC().WIN_WHITE });
  }

  if (!chrome) {
    Window.stdFrame(Window.template(LIST_LEFT, LIST_TOP, LIST_W, LIST_H));
  }
  if (!switching) {
    const shown = max_showed(total);
    for (let i = 1; i <= shown; i++) {
      const idx = BagMenu.scroll + i;
      if (idx > total) break;
      const y = 10 + (i - 1) * 16;
      if (idx === BagMenu.cursor) {
        if (selected) {
          FrlgFont.drawGlyph(FrlgFont.CHAR_SELECTOR_ARROW, 89, y, { colors: BC().CURSOR_SELECTED });
        } else {
          Window.cursorPx(89, y);
        }
      }
      const r = rows[idx];
      if (!r) {
        // src/item_menu.c:645
        FrlgFont.draw(RomText.plain("gFameCheckerText_Cancel"), 97, y, { colors: FrlgFont.COLOR.NORMAL });
      } else {
        let label = r.name;
        if (session && truthy(session.registeredItem)
          && ItemsData.toNumericId(session.registeredItem) === ItemsData.toNumericId(r.id)) {
          label = SEL_MARK + label;
        }
        const num = ItemsData.toNumericId(r.id);
        const colors = (num === ItemsData.ITEM_TM_CASE || num === ItemsData.ITEM_BERRY_POUCH)
          ? BC().ITEM_BLUE : FrlgFont.COLOR.NORMAL;
        FrlgFont.draw(label, 97, y, { maxWidth: 96, colors });
        const info = r.info || ItemsData.info(r.id);
        const important = info && (tonumber(info.importance) ?? 0) !== 0;
        if (pocket !== "KEY_ITEMS" && pocket !== "TM_CASE" && !important) {
          // src/item_menu.c:716
          FrlgFont.draw(format(TIMES + "%3d", r.qty || 1), 198, y,
            { small: true, colors: FrlgFont.COLOR.NORMAL });
        }
      }
    }
  }

  if (chrome && BagMenu._arrowK != null && BagMenu._arrowK >= 1) {
    // src/item_menu.c:287, 759
    const k = BagMenu._arrowK;
    const switchArrows = BagMenu._location !== "itempc";
    if (switchArrows && BagMenu.pocketIdx > 1) {
      BagChrome.drawArrow("left", 0 + bob(k, 8), 64);
    }
    if (switchArrows && BagMenu.pocketIdx < len(ItemsData.BAG_POCKET_ORDER)) {
      BagChrome.drawArrow("right", 64 + bob(k, -8), 64);
    }
    const shown = max_showed(total);
    if (BagMenu.scroll > 0) {
      BagChrome.drawArrow("up", 152, 0 + bob(k, 8));
    }
    if (BagMenu.scroll < total - shown) {
      BagChrome.drawArrow("down", 152, 96 + bob(k, -8));
    }
  }

  const sel = rows[BagMenu.cursor];
  if (chrome && !switching) {
    if (sel) {
      BagChrome.drawItemIcon(sel.id, 8, 124);
    } else {
      // src/data/item_icon_table.h:402
      BagChrome.drawItemIcon((ItemsData as any).ITEMS_COUNT || 375, 8, 124);
    }
  }

  if (BagMenu.mode !== "action" && BagMenu.mode !== "deposit" && BagMenu.mode !== "deposit_done" && !switching) {
    if (!chrome) {
      Window.stdFrame(Window.template(5, 14, 25, 6));
    }
    let desc: string | undefined = sel ? sel.description : undefined;
    // src/item_menu.c:754
    if (!sel) desc = RomText.plain("gText_CloseBag");
    if (truthy(desc)) {
      // src/item_menu.c:756 (window 1 at (5, 14), x=0, y=3, maxWidth=200, linePitch=14)
      FrlgFont.draw(desc, 40, 115, { colors: BC().WIN_WHITE, maxWidth: 200, linePitch: 14 });
    }
  }

  // Action Pop-up Menu (pret bag.c: tilemapLeft = 22, tilemapTop = 19 - actCount * 2, width = 7, height = actCount * 2)
  if (BagMenu.mode === "action") {
    // Bottom left prompt window (pret bag.c: sWindowTemplates[6] = (6, 15, 14, 4))
    if (sel) {
      Window.stdFrame(Window.template(6, 15, 14, 4));
      // src/item_menu.c:1434
      FrlgFont.draw(RomText.box("gText_Var1IsSelected", { stringVars: seq(sel.name) }), 6 * 8 + 4, 15 * 8 + 2, { maxWidth: 14 * 8, linePitch: 15, colors: FrlgFont.COLOR.NORMAL });
    }

    refresh_actions();
    const actCount = len(BagMenu.ACTIONS);
    const popW = 7;
    const popH = actCount * 2;
    const popX = 22;
    const popY = 19 - popH;
    Window.stdFrame(Window.template(popX, popY, popW, popH));
    for (const [i, act] of ipairs<string>(BagMenu.ACTIONS)) {
      const rowY = (popY * 8) + (i - 1) * 16 + 2;
      if (i === BagMenu.actionCursor) {
        Window.cursorPx(popX * 8 + 1, rowY);
      }
      FrlgFont.draw(action_label(act, sel), popX * 8 + 9, rowY, { colors: FrlgFont.COLOR.NORMAL });
    }
  }

  const text_opts = { linePitch: 15, colors: FrlgFont.COLOR.NORMAL };
  // src/item_menu.c:1308 InitQuantityToTossOrDeposit
  if (BagMenu.mode === "toss" && sel) {
    Window.stdFrame(Window.template(6, 15, 16, 4));
    FrlgFont.draw(RomText.box("gText_TossOutHowManyStrVar1s", { stringVars: seq(sel.name) }), 6 * 8, 15 * 8 + 2, text_opts);
    Window.stdFrame(Window.template(24, 15, 5, 4));
    // src/item_menu.c:1326
    const times = RomText.plain("gText_TimesStrVar1", { stringVars: seq(format("%03d", BagMenu.tossQty)) });
    FrlgFont.draw(times, 24 * 8 + 4, 15 * 8 + 10, { small: true, colors: FrlgFont.COLOR.NORMAL });
  }
  // src/item_menu.c:1502 Task_ConfirmTossItems
  if (BagMenu.mode === "toss_confirm" && sel) {
    Window.stdFrame(Window.template(6, 15, 15, 4));
    FrlgFont.draw(RomText.box("gText_ThrowAwayStrVar2OfThisItemQM",
      { stringVars: { 2: tostring(BagMenu.tossQty) } }), 6 * 8, 15 * 8 + 2, text_opts);
    // src/bag.c:296 BagCreateYesNoMenuBottomRight
    Window.stdFrame(Window.template(23, 15, 6, 4));
    FrlgFont.draw(RomText.plain("gText_Yes"), 23 * 8 + 8, 15 * 8 + 2, text_opts);
    FrlgFont.draw(RomText.plain("gText_No"), 23 * 8 + 8, 15 * 8 + 18, text_opts);
    Window.cursorPx(23 * 8, 15 * 8 + 2 + (BagMenu.yesNoCursor === 2 ? 16 : 0));
  }
  // src/item_menu.c:1308 InitQuantityToTossOrDeposit
  if (BagMenu.mode === "deposit" && sel) {
    Window.fixedStdFrame(Window.template(6, 15, 16, 4));
    FrlgFont.draw(RomText.box("gText_DepositHowManyStrVars1", { stringVars: seq(sel.name) }), 6 * 8, 15 * 8 + 2, text_opts);
    Window.stdFrame(Window.template(24, 15, 5, 4));
    FrlgFont.draw(RomText.plain("gText_TimesStrVar1", { stringVars: seq(format("%03d", BagMenu.tossQty)) }),
      24 * 8 + 4, 15 * 8 + 10, { small: true, letterSpacing: 1, colors: FrlgFont.COLOR.NORMAL });
    // src/item_menu.c:796 CreateArrowPair_QuantitySelect
    // pcall(require, "src.ui.game3.bag_chrome")
    const BagChromeQ = BagChrome;
    if (BagChromeQ) {
      const k = BagMenu._depositK ?? 0;
      BagChromeQ.drawArrow("up", 212 - 8, 120 - 8 + bob(k + 1, 8));
      BagChromeQ.drawArrow("down", 212 - 8, 152 - 8 + bob(k + 1, -8));
    }
  }
  // src/item_menu.c:2012
  if (BagMenu.mode === "deposit_done" && BagMenu._depositText) {
    Window.fixedStdFrame(Window.template(6, 15, 23, 4));
    FrlgFont.draw(BagMenu._depositText, 6 * 8, 15 * 8 + 2, text_opts);
  }
  // src/item_menu.c:1552 Task_TossItem_Yes
  if (BagMenu.mode === "toss_done" && sel) {
    Window.stdFrame(Window.template(6, 15, 23, 4));
    FrlgFont.draw(RomText.box("gText_ThrewAwayStrVar2StrVar1s",
      { stringVars: seq(sel.name, tostring(BagMenu.tossQty)) }), 6 * 8, 15 * 8 + 2, text_opts);
  }

  // In-bag message modal
  // src/item_menu.c:1021 OpenBagWindow(5), src/menu_helpers.c:24
  if (BagMenu.mode === "message" && BagMenu.messageText) {
    Window.dialogueFrame();
    const w = Chrome.DLG_W * 8;
    FrlgFont.draw(FrlgFont.wrap(BagMenu.messageText, w), Chrome.DLG_LEFT * 8, Chrome.DLG_TOP * 8 + 1,
      { maxWidth: w, colors: FrlgFont.COLOR.NORMAL });
  }

  if (BagMenu.mode === "sell" && BagMenu._sell) {
    BagMenu._sell.draw();
  }

  let level = 0, curtain = 0;
  const op = BagMenu._open, ex = BagMenu._exit;
  if (op) {
    // src/item_menu.c:915, src/palette.c:393
    level = Math.max(0, 16 - 2 * Math.floor(op.k / 2));
    if (op.curtain) curtain = Math.max(0, Math.min(160, 192 - 16 * op.k));
  } else if (ex) {
    level = Math.min(16, 4 * Math.floor(ex.k / 2));
    if (ex.curtain) curtain = Math.min(160, 16 * ex.k);
  }
  if (level > 0) {
    G.setColor(0, 0, 0, level / 16);
    G.rectangle("fill", 0, 0, 240, 160);
  }
  if (curtain > 0) {
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, 240, curtain);
  }
  G.setColor(1, 1, 1, 1);
};

export default BagMenu;
