// Port of gen1recomp RomExtractorGen2.lua (bdfac727): extractStdScripts
// (:5353), readEventTables (:3106), NAMED_TEXT (:3389),
// extractScriptsAndText (:3448), extractInitialEvents (:4089) and
// extractText (:4247). The disassembler walks every script pointer the maps,
// std-script table and side tables name, and emits the command lists the
// Gen 2 script VM (src/script/gen2/Vm.lua) runs, plus the text pool keyed
// by "bb:aaaa" (ctx.scriptKey).
//
// Lua truthiness is kept where it changes output: a script pointer of 0 is
// TRUTHY in Lua, so an object/bg/coord event whose pointer is 0 still gets a
// scriptKey ("bb:0000") though nothing is queued for it.

import { type Gen2Ctx, orderName, scriptKey } from "./ctx.ts";
import { mapNameByIds } from "./maps.ts";
import { lua, speciesName } from "./helpers.ts";
import { opcodesFor, TERMINATORS } from "./opcodes.ts";
import { attempt, decodeGen2Text } from "./text.ts";

/** :83 OBJECTTYPE_* / :89 BGEVENT_ITEM (constants/script_constants.asm). */
const OBJECTTYPE_ITEMBALL = 1;
const OBJECTTYPE_TRAINER = 2;
const BGEVENT_ITEM = 7;
/** :96-98 cmdqueue entry / stonetable row sizes. */
const CMDQUEUE_ENTRY_SIZE = 6;
const CMDQUEUE_STONETABLE = 2;
const STONETABLE_LENGTH = 4;
/** :102 wMenuHeader. */
const MENU_HEADER_LENGTH = 8;
/** :108-113 npc trades (Crystal's 7th dropped). */
const NPCTRADE_STRUCT_LENGTH = 32;
const MON_NAME_LENGTH = 11;
const NAME_LENGTH = 11;
const NUM_NPC_TRADES = 6;
/** :114 — pokecrystal constants/npc_trade_constants.asm:23 adds NPC_TRADE_FOREST. */
const NUM_NPC_TRADES_CRYSTAL = 7;
/** :120-121 — pokecrystal constants/script_constants.asm:323-324. */
const NUM_UNOWN_WALLS = 4;
const UNOWN_WALL_HEADER_SIZE = 5;
/** :117 */
const NUM_BUG_CONTESTANTS = 10;
/** :132-133 */
const PHONE_CONTACT_SIZE = 12;
const SPECIALCALL_SIZE = 6;

/** :3078 */
function wordFromArgs(args: number[]): number {
  return (args[0] ?? 0) + (args[1] ?? 0) * 0x100;
}

/** :3087 — `dba` is bank first, then the address little-endian. */
function dbaFromArgs(args: number[]): [number, number] {
  return [args[0] ?? 0, (args[1] ?? 0) + (args[2] ?? 0) * 0x100];
}

/** :3091 */
export function romAddrOk(bank: unknown, address: unknown): boolean {
  if (typeof bank !== "number" || typeof address !== "number") return false;
  if (bank < 0 || bank > 0x7f) return false;
  if (bank === 0) return address >= 0 && address < 0x4000;
  return address >= 0x4000 && address < 0x8000;
}

export interface StdScriptEntry {
  id: string;
  /** 0-based std id (the callstd operand). */
  index: number;
  bank: number;
  address: number;
  key: string;
}

export interface StdScripts {
  generation: 2;
  source: string;
  order: string[];
  scripts: Record<string, StdScriptEntry>;
  /** 0-based std id -> label (an object: its keys start at "0"). */
  byId: Record<string, string>;
}

/** RomExtractorGen2.lua:5353 extractStdScripts — StdScripts is `dba` rows
 * in stdScriptOrder. std_scripts.json. */
export function extractStdScripts(ctx: Gen2Ctx): StdScripts {
  const { rom } = ctx;
  const order = (ctx.manifest.constants.stdScriptOrder as string[] | undefined) ?? [];
  const table = ctx.symbol("StdScripts");
  const out: StdScripts = {
    generation: 2,
    source: "ROM:StdScripts + engine/events/std_scripts.asm order",
    order,
    scripts: {},
    byId: {},
  };
  order.forEach((label, i) => {
    const base = table.address + i * 3;
    const bank = rom.byte(table.bank, base);
    const address = rom.word(table.bank, base + 1);
    out.scripts[label] = { id: label, index: i, bank, address, key: scriptKey(bank, address) };
    out.byId[String(i)] = label;
  });
  return out;
}

interface ScriptRef {
  script: string;
  scriptBank: number;
  scriptAddress: number;
  decoration?: number;
  posters?: ScriptRef[];
}

/**
 * RomExtractorGen2.lua:3106 readEventTables — events.json:
 * - phone: {"0".."36": {id, contact, trainerClass, number, map?, calleeTime,
 *   callee, calleeBank, calleeAddress, callerTime, caller, callerBank,
 *   callerAddress}} (0-keyed by PHONE_* row, so an object);
 * - specialCalls: [{id (1-based SPECIALCALL_*), call?, condition, contact,
 *   script, scriptBank, scriptAddress}] (Brian reads #specialCallOrder rows
 *   from row 0, i.e. one row past the last real call -- kept);
 * - phoneScripts: {WrongNumberScript, PhoneOutOfAreaScript,
 *   PhoneScript_JustTalkToThem: {script, scriptBank, scriptAddress}};
 * - trades: [{id (0-based), dialog, give, giveIndex, get, getIndex,
 *   nickname?, dvs [2 bytes], item?, otId, otName?, gender}];
 * - tradeTexts: {TRADE_DIALOG_*: {TRADE_DIALOGSET_*: text}, <label>: text},
 *   tradeBuffers: same keys, lists of the TX_RAM buffers in order;
 * - bugContestFlags: [10 EVENT_* numbers]; floorNames: [FLOOR_* strings];
 * - decorations {DECODESC_*: ScriptRef (POSTER also has posters [...])},
 *   decorationOrder.
 * unownWalls is Crystal-only (UnownWalls is not a Gold symbol).
 */
export function readEventTables(ctx: Gen2Ctx): Record<string, any> {
  const { rom } = ctx;
  const consts = ctx.manifest.constants as Record<string, any>;
  const charmap = ctx.manifest.charmap ?? {};
  const out: Record<string, any> = {};

  // :3111 name(list, index) = Lua list[index + 1] = element `index`.
  const name = (list: unknown, index: number, fallback?: string): string | undefined =>
    Array.isArray(list) ? ((list[index] as string | undefined) ?? fallback) : fallback;
  const readName = (bank: number, address: number, length: number): string | undefined =>
    attempt(() => rom.readString(bank, address, charmap, 0x50, length)[0]);

  // :3126 data/phone/phone_contacts.asm
  const contacts = ctx.symbol("PhoneContacts");
  const phone: Record<string, unknown> = {};
  const phoneOrder: string[] = consts.phoneContactOrder ?? [];
  for (let row = 0; row < phoneOrder.length; row++) {
    const raw = rom.bytes(contacts.bank, contacts.address + row * PHONE_CONTACT_SIZE, PHONE_CONTACT_SIZE);
    const group = raw[2]!;
    const mapNum = raw[3]!;
    const calleeAddress = raw[6]! + raw[7]! * 0x100;
    const callerAddress = raw[10]! + raw[11]! * 0x100;
    phone[String(row)] = {
      id: row,
      contact: name(phoneOrder, row),
      trainerClass: raw[0],
      number: raw[1],
      // N_A is group $ff / map $ff
      map: group !== 0xff ? mapNameByIds(ctx, group, mapNum) : undefined,
      calleeTime: raw[4],
      callee: scriptKey(raw[5]!, calleeAddress),
      calleeBank: raw[5],
      calleeAddress,
      callerTime: raw[8],
      caller: scriptKey(raw[9]!, callerAddress),
      callerBank: raw[9],
      callerAddress,
    };
  }
  out.phone = phone;

  // :3153 data/phone/special_calls.asm: dw condition; db contact; dba script
  const special = ctx.symbol("SpecialPhoneCallList");
  const specialOrder: string[] = consts.specialCallOrder ?? [];
  const specialCalls: unknown[] = [];
  for (let row = 0; row < specialOrder.length; row++) {
    const raw = rom.bytes(special.bank, special.address + row * SPECIALCALL_SIZE, SPECIALCALL_SIZE);
    const scriptAddress = raw[4]! + raw[5]! * 0x100;
    specialCalls.push({
      id: row + 1, // SPECIALCALL_NONE is 0, so row 0 is SPECIALCALL_POKERUS
      call: name(specialOrder, row + 1),
      condition: raw[0]! + raw[1]! * 0x100,
      contact: raw[2],
      script: scriptKey(raw[3]!, scriptAddress),
      scriptBank: raw[3],
      scriptAddress,
    });
  }
  out.specialCalls = specialCalls;

  // :3173 engine/phone/phone.asm's own three scripts.
  const phoneScripts: Record<string, ScriptRef> = {};
  const phoneLabels: [string, string][] = [
    ["WrongNumberScript", "WrongNumber.script"],
    ["PhoneOutOfAreaScript", "PhoneOutOfAreaScript"],
    ["PhoneScript_JustTalkToThem", "PhoneScript_JustTalkToThem"],
  ];
  for (const [label, symbol] of phoneLabels) {
    const sym = ctx.location(symbol);
    if (sym) phoneScripts[label] = { script: scriptKey(sym[0], sym[1]), scriptBank: sym[0], scriptAddress: sym[1] };
  }
  out.phoneScripts = phoneScripts;

  // :3189 data/events/npc_trades.asm
  const trades = ctx.symbol("NPCTrades");
  const itemOrder: string[] = consts.itemOrder ?? [];
  const tradeRows: unknown[] = [];
  const tradeCount = ctx.crystal ? NUM_NPC_TRADES_CRYSTAL : NUM_NPC_TRADES;
  for (let row = 0; row < tradeCount; row++) {
    const base = trades.address + row * NPCTRADE_STRUCT_LENGTH;
    const raw = rom.bytes(trades.bank, base, 3);
    const dvBase = base + 3 + MON_NAME_LENGTH;
    const tail = rom.bytes(trades.bank, dvBase, 5);
    tradeRows.push({
      id: row,
      dialog: name(consts.tradeDialogOrder, raw[0]!),
      give: speciesName(ctx, raw[1]!),
      giveIndex: raw[1],
      get: speciesName(ctx, raw[2]!),
      getIndex: raw[2],
      nickname: readName(trades.bank, base + 3, MON_NAME_LENGTH),
      dvs: [tail[0], tail[1]],
      item: tail[2] !== 0 ? (lua(itemOrder, tail[2]!) ?? tail[2]) : undefined,
      otId: tail[3]! + tail[4]! * 0x100,
      otName: readName(trades.bank, dvBase + 5, NAME_LENGTH),
      gender: name(consts.tradeGenderOrder, rom.byte(trades.bank, dvBase + 5 + NAME_LENGTH)),
    });
  }
  out.trades = tradeRows;

  // :3232 TradeTexts: dialog-major, `TradeTexts + 6 * dialog + 2 * set`.
  const tradeTexts = ctx.symbol("TradeTexts");
  // Crystal's fourth dialogset makes the row stride 8
  // (pokecrystal engine/events/npc_trade.asm:389-399 `ld bc, 2 * 4`)
  const tradeStride = ctx.crystal ? 8 : 6;
  const dialogs = [
    "TRADE_DIALOG_INTRO", "TRADE_DIALOG_CANCEL", "TRADE_DIALOG_WRONG",
    "TRADE_DIALOG_COMPLETE", "TRADE_DIALOG_AFTER",
  ];
  const sets: string[] = consts.tradeDialogOrder ?? [];
  out.tradeTexts = {};
  out.tradeBuffers = {};
  dialogs.forEach((dialog, d) => {
    const row: Record<string, string> = {};
    const bufRow: Record<string, (string | number)[]> = {};
    sets.forEach((set, s) => {
      const addr = rom.word(tradeTexts.bank, tradeTexts.address + d * tradeStride + s * 2);
      const buffers: (string | number)[] = [];
      row[set] = decodeGen2Text(ctx, tradeTexts.bank, addr, charmap, buffers);
      bufRow[set] = buffers;
    });
    out.tradeTexts[dialog] = row;
    out.tradeBuffers[dialog] = bufRow;
  });
  for (const label of [
    "NPCTradeCableText", "TradedForText", "_MonWasSentToText", "_ForYourMonSendsText",
    "_OTSendsText", "_BidsFarewellToMonText", "_MonNameBidsFarewellText", "_TakeGoodCareOfMonText",
  ]) {
    const sym = ctx.location(label);
    if (sym) {
      const buffers: (string | number)[] = [];
      out.tradeTexts[label] = decodeGen2Text(ctx, sym[0], sym[1], charmap, buffers);
      out.tradeBuffers[label] = buffers;
    }
  }

  // :3281 data/events/bug_contest_flags.asm — wEventFlags numbers.
  const contestFlags = ctx.location("BugCatchingContestantEventFlagTable");
  if (contestFlags) {
    const flags: number[] = [];
    for (let row = 0; row < NUM_BUG_CONTESTANTS; row++) flags.push(rom.word(contestFlags[0], contestFlags[1] + row * 2));
    out.bugContestFlags = flags;
  }

  // :3293 data/events/elevator_floors.asm
  const floors = ctx.symbol("ElevatorFloorNames");
  const floorNames: (string | undefined)[] = [];
  const floorOrder: string[] = consts.floorOrder ?? [];
  for (let row = 0; row < floorOrder.length; row++) {
    const addr = rom.word(floors.bank, floors.address + row * 2);
    floorNames.push(readName(floors.bank, addr, 8));
  }
  out.floorNames = floorNames;

  // :3305 describedecoration's five arms.
  const ref = (bank: number, address: number): ScriptRef => ({
    script: scriptKey(bank, address),
    scriptBank: bank,
    scriptAddress: address,
  });
  const posterTable = ctx.symbol("DecorationDesc_PosterPointers");
  const posters: ScriptRef[] = [];
  for (let i = 0; i <= 15; i++) {
    const row = posterTable.address + i * 3;
    const deco = rom.byte(posterTable.bank, row);
    if (deco === 0xff) break;
    const r = ref(posterTable.bank, rom.word(posterTable.bank, row + 1));
    r.decoration = deco;
    posters.push(r);
  }
  const nullPoster = ctx.symbol("DecorationDesc_NullPoster");
  const ornament = ctx.symbol("DecorationDesc_OrnamentOrConsole.OrnamentConsoleScript");
  const bigDoll = ctx.symbol("DecorationDesc_GiantOrnament.BigDollScript");
  const poster = ref(nullPoster.bank, nullPoster.address);
  poster.posters = posters;
  out.decorations = {
    DECODESC_POSTER: poster,
    DECODESC_LEFT_DOLL: ref(ornament.bank, ornament.address),
    DECODESC_RIGHT_DOLL: ref(ornament.bank, ornament.address),
    DECODESC_BIG_DOLL: ref(bigDoll.bank, bigDoll.address),
    DECODESC_CONSOLE: ref(ornament.bank, ornament.address),
  };
  out.decorationOrder = consts.decoDescOrder;
  // :3335-3362 — pokecrystal data/events/unown_walls.asm:7 UnownWalls and
  // :15 MenuHeaders_UnownWalls; macros/coords.asm:71 `menu_coords` is y first.
  const unownWalls = ctx.location("UnownWalls");
  const unownHeaders = ctx.location("MenuHeaders_UnownWalls");
  const unownMap = (ctx.manifest as { unownCharmap?: Record<string, string> }).unownCharmap;
  if (unownWalls && unownHeaders && unownMap) {
    const walls: Record<string, unknown>[] = [];
    let address = unownWalls[1];
    for (let wall = 0; wall < NUM_UNOWN_WALLS; wall++) {
      const chars: number[] = [];
      const word: string[] = [];
      for (;;) {
        const byte = rom.byte(unownWalls[0], address);
        address += 1;
        if (byte === 0xff) break;
        chars.push(byte);
        word.push(unownMap[String(byte)] ?? "?");
      }
      const head = rom.bytes(unownHeaders[0], unownHeaders[1] + wall * UNOWN_WALL_HEADER_SIZE, UNOWN_WALL_HEADER_SIZE);
      walls.push({
        id: wall, word: word.join(""), chars,
        flags: head[0], y1: head[1], x1: head[2], y2: head[3], x2: head[4],
      });
    }
    out.unownWalls = walls;
  }
  return out;
}

/** RomExtractorGen2.lua:3389 NAMED_TEXT — engine-printed strings no script
 * pointer reaches, seeded by label (text.labels[label] -> key). */
export const NAMED_TEXT = [
  "_DaycareDummyText",
  "_DayCareManIntroText", "_DayCareManIntroEggText",
  "_DayCareLadyIntroText", "_DayCareLadyIntroEggText",
  "_WhatShouldIRaiseText", "_OnlyOneMonText", "_CantAcceptEggText",
  "_RemoveMailText", "_LastHealthyMonText", "_IllRaiseYourMonText",
  "_ComeBackLaterText", "_AreWeGeniusesText", "_YourMonHasGrownText",
  "_PerfectHeresYourMonText", "_GotBackMonText", "_BackAlreadyText",
  "_HaveNoRoomText", "_NotEnoughMoneyText", "_OhFineThenText",
  "_ComeAgainText", "_NotYetText", "_FoundAnEggText", "_ReceivedEggText",
  "_TakeGoodCareOfEggText", "_IllKeepItThanksText", "_NoRoomForEggText",
  "Text_BreedHuh", "_BreedClearboxText", "_BreedEggHatchText",
  "_BreedAskNicknameText",
  "_LeftWithDayCareManText", "_LeftWithDayCareLadyText",
  "_BreedBrimmingWithEnergyText", "_BreedNoInterestText",
  "_BreedAppearsToCareForText", "_BreedFriendlyText",
  "_BreedShowsInterestText",
  "_MartWelcomeText", "_MartAskMoreText", "_MartComeAgainText",
  "_MartHowManyText", "_MartFinalPriceText", "_MartThanksText",
  "_MartNoMoneyText", "_MartPackFullText",
  "_HerbShopLadyIntroText", "_HerbalLadyHowManyText",
  "_HerbalLadyFinalPriceText", "_HerbalLadyThanksText",
  "_HerbalLadyPackFullText", "_HerbalLadyNoMoneyText",
  "_HerbalLadyComeAgainText",
  "_BargainShopIntroText", "_BargainShopFinalPriceText",
  "_BargainShopThanksText", "_BargainShopPackFullText",
  "_BargainShopSoldOutText", "_BargainShopNoFundsText",
  "_BargainShopComeAgainText",
  "_PharmacyIntroText", "_PharmacyHowManyText", "_PharmacyFinalPriceText",
  "_PharmacyThanksText", "_PharmacyPackFullText", "_PharmacyNoMoneyText",
  "_PharmacyComeAgainText",
  "_NothingToSellText", "_MartSellHowManyText", "_MartSellPriceText",
  "_MartCantBuyText", "_MartBoughtText",
  "AnimateHallOfFame.String_NewHallOfFamer",
  "_HallOfFamePC.TimeFamer", "_HallOfFamePC.HOFMaster",
  "_EmptyMailboxText", "_MailClearedPutAwayText", "_MailPackFullText",
  "_MailMessageLostText", "_MailAlreadyHoldingItemText", "_MailEggText",
  "_MailMovedFromBoxText", "_MailLoseMessageText", "_MailDetachedText",
  "_MailNoSpaceText", "_MailAskSendToPCText", "_MailboxFullText",
  "_MailSentToPCText", "_PCMonHoldingMailText", "_PokemonRemoveMailText",
];

export type ScriptCommand = Record<string, unknown> & { op: string };

export interface ScriptsResult {
  /** scripts.json: {generation 2, "<bb:aaaa>": ScriptCommand[], movements:
   * {"<bb:aaaa>": raw movement bytes through step_end/step_wait_end}} */
  scripts: Record<string, unknown>;
  /** text.json: {generation 2, "<bb:aaaa>": string, labels: {label: key}} */
  text: Record<string, unknown>;
  events: Record<string, any>;
  initialEvents: Record<string, unknown>;
  mapCount: number;
  scriptCount: number;
}

/**
 * RomExtractorGen2.lua:3448 extractScriptsAndText. MUTATES `maps` (the
 * extractMaps result) the way Brian's does -- objects gain scriptKey /
 * trainer {event?, class, member, seenText?, winText?, lossText?,
 * scriptKey?} / itemball {item, quantity}; bgEvents gain scriptKey or
 * hiddenItem {event, item}; coordEvents gain scriptKey -- and Brian then
 * rewrites maps.lua, so the caller rewrites maps.json. Also produces
 * events.json (readEventTables) and initial_events.json.
 */
export function extractScriptsAndText(
  ctx: Gen2Ctx,
  maps: Record<string, any>,
  stdScripts: StdScripts | undefined,
): ScriptsResult {
  const { rom } = ctx;
  const consts = ctx.manifest.constants as Record<string, any>;
  const charmap = ctx.manifest.charmap ?? {};
  const scripts: Record<string, unknown> = { generation: 2 };
  const text: Record<string, unknown> = { generation: 2 };
  const movements: Record<string, number[]> = {};
  const queue: { bank: number; address: number; key: string }[] = [];
  const queued = new Set<string>();

  // :3456
  const enqueue = (bank: number, address: number): void => {
    if (!romAddrOk(bank, address) || address === 0) return;
    if (bank === 0) return; // scripts live in banked ROM
    const key = scriptKey(bank, address);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ bank, address, key });
  };

  // :3477 — the shared ROM0 ObjectEvent line, walked once at bank 0.
  const enqueueHome = (address: number): string | undefined => {
    if (!romAddrOk(0, address) || address === 0) return undefined;
    const key = scriptKey(0, address);
    if (!queued.has(key)) {
      queued.add(key);
      queue.push({ bank: 0, address, key });
    }
    return key;
  };

  // :3487
  const ensureText = (bank: number, address: number): string | undefined => {
    if (!romAddrOk(bank, address)) return undefined;
    const key = scriptKey(bank, address);
    if (text[key] === undefined) text[key] = attempt(() => decodeGen2Text(ctx, bank, address, charmap)) ?? "";
    return key;
  };

  // :3497 — up to 65 bytes, through step_end ($47) / step_wait_end ($48).
  const ensureMovement = (bank: number, address: number): string | undefined => {
    if (!romAddrOk(bank, address) || address === 0) return undefined;
    const key = scriptKey(bank, address);
    if (movements[key]) return key;
    const bytes: number[] = [];
    for (let i = 0; i <= 64; i++) {
      const b = attempt(() => rom.byte(bank, address + i));
      if (b === undefined) break;
      bytes.push(b);
      if (b === 0x47 || b === 0x48) break;
    }
    movements[key] = bytes;
    return key;
  };

  // :3523 — a MAIL message: raw charmap bytes to '@', `next` = "\n".
  const readMailMessage = (bank: number, address: number, limit = 0x20): string | undefined => {
    if (!romAddrOk(bank, address)) return undefined;
    const out: string[] = [];
    for (let i = 0; i < limit; i++) {
      const b = attempt(() => rom.byte(bank, address + i));
      if (b === undefined || b === 0x50) break;
      if (b === 0x4e || b === 0x4f) {
        out.push("\n");
      } else {
        const ch = charmap[String(b)];
        if (ch !== undefined && !ch.startsWith("<")) out.push(ch);
        else if (ch === undefined) out.push(`{BYTE:${b.toString(16).toUpperCase().padStart(2, "0")}}`);
      }
    }
    return out.join("");
  };

  // :3557
  const readMenuStrings = (bank: number, address: number, count: number, limit = 24): string[] => {
    const items: string[] = [];
    let cursor = address;
    for (let n = 0; n < count; n++) {
      if (!romAddrOk(bank, cursor)) break;
      const str = attempt(() => rom.readString(bank, cursor, charmap, 0x50, limit)[0]);
      if (str === undefined) break;
      items.push(str);
      let len = 0;
      while (len < limit) {
        const b = attempt(() => rom.byte(bank, cursor + len));
        if (b === undefined || b === 0x50) break;
        len += 1;
      }
      cursor += len + 1;
    }
    return items;
  };

  // :3578 — db flags; menu_coords (y first); dw data; db cursor. Both the
  // vertical (items) and 2D (grid/gridItems) readings are emitted.
  const readMenuHeader = (bank: number, address: number): Record<string, unknown> | undefined => {
    if (!romAddrOk(bank, address)) return undefined;
    const raw = attempt(() => rom.bytes(bank, address, MENU_HEADER_LENGTH));
    if (!raw) return undefined;
    const dataAddr = raw[5]! + raw[6]! * 0x100;
    const header: Record<string, unknown> = {
      flags: raw[0],
      top: raw[1],
      left: raw[2],
      bottom: raw[3],
      right: raw[4],
      cursor: raw[7],
      key: scriptKey(bank, address),
    };
    if (!romAddrOk(bank, dataAddr)) return header;
    const data = attempt(() => rom.bytes(bank, dataAddr, 8));
    if (!data) return header;
    header.dataFlags = data[0];
    const count = data[1]!;
    if (count > 0 && count <= 16) header.items = readMenuStrings(bank, dataAddr + 2, count);
    const rows = Math.floor(count / 16);
    const cols = count % 16;
    if (rows > 0 && cols > 0 && rows * cols <= 32) {
      const strBank = data[3]!;
      const strAddr = data[4]! + data[5]! * 0x100;
      if (romAddrOk(strBank, strAddr)) {
        header.grid = { rows, cols, spacing: data[2] };
        header.gridItems = readMenuStrings(strBank, strAddr, rows * cols);
      }
    }
    return header;
  };

  // :3619 — writecmdqueue: dbw type, addr; a STONETABLE's rows are
  // `db warp, object; dw script` ending on db -1.
  const readCmdQueueEntry = (bank: number, address: number): Record<string, unknown> | undefined => {
    if (!romAddrOk(bank, address)) return undefined;
    const raw = attempt(() => rom.bytes(bank, address, CMDQUEUE_ENTRY_SIZE));
    if (!raw) return undefined;
    const kind = raw[0]!;
    const target = raw[1]! + raw[2]! * 0x100;
    const entry: Record<string, unknown> = {
      type: kind,
      queue: orderName(consts.cmdQueueOrder, kind + 1),
      address: target,
    };
    if (kind !== CMDQUEUE_STONETABLE || !romAddrOk(bank, target)) return entry;
    const rows: unknown[] = [];
    for (let i = 0; i <= 15; i++) {
      const row = target + i * STONETABLE_LENGTH;
      const warp = attempt(() => rom.byte(bank, row));
      if (warp === undefined || warp === 0xff) break;
      const script = attempt(() => rom.word(bank, row + 2));
      if (script === undefined) break;
      rows.push({ warp, object: rom.byte(bank, row + 1), scriptKey: scriptKey(bank, script) });
      enqueue(bank, script);
    }
    entry.rows = rows;
    return entry;
  };

  // :3655 — elevator: db count, then `elevfloor floor, warp, map` rows.
  const readElevator = (bank: number, address: number): unknown[] | undefined => {
    if (!romAddrOk(bank, address)) return undefined;
    const count = attempt(() => rom.byte(bank, address));
    if (count === undefined || count === 0 || count > 16) return undefined;
    const floors: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const raw = attempt(() => rom.bytes(bank, address + 1 + i * 4, 4));
      if (!raw) break;
      floors.push({
        floor: orderName(consts.floorOrder, raw[0]! + 1),
        floorId: raw[0],
        destWarp: raw[1],
        destGroup: raw[2],
        destMapNum: raw[3],
        destMap: mapNameByIds(ctx, raw[2]!, raw[3]!),
      });
    }
    return floors;
  };

  // :3679 — `trainer`: dw flag; db class, member; dw seen, win, loss, after.
  const readTrainerHeader = (bank: number, address: number): Record<string, unknown> | undefined => {
    if (!romAddrOk(bank, address)) return undefined;
    const raw = attempt(() => rom.bytes(bank, address, 12));
    if (!raw) return undefined;
    const word = (i: number): number => raw[i]! + raw[i + 1]! * 0x100;
    const afterAddr = word(10);
    const entry: Record<string, unknown> = {
      event: word(0),
      class: raw[2],
      member: raw[3],
      seenText: ensureText(bank, word(4)),
      winText: ensureText(bank, word(6)),
      lossText: ensureText(bank, word(8)),
    };
    if (entry.event === 0xffff) entry.event = undefined;
    if (afterAddr !== 0 && romAddrOk(bank, afterAddr)) {
      entry.scriptKey = scriptKey(bank, afterAddr);
      enqueue(bank, afterAddr);
    }
    return entry;
  };

  // :3702 `itemball item, quantity`
  const readItemBall = (bank: number, address: number): Record<string, number> | undefined => {
    if (!romAddrOk(bank, address)) return undefined;
    const raw = attempt(() => rom.bytes(bank, address, 2));
    return raw ? { item: raw[0]!, quantity: raw[1]! } : undefined;
  };

  // :3718 `hiddenitem item, flag` is `dwb flag, item`.
  const readHiddenItem = (bank: number, address: number): Record<string, number> | undefined => {
    if (!romAddrOk(bank, address)) return undefined;
    const raw = attempt(() => rom.bytes(bank, address, 3));
    return raw ? { event: raw[0]! + raw[1]! * 0x100, item: raw[2]! } : undefined;
  };

  // :3728 seed the std scripts, then the side tables (:3737).
  for (const entry of Object.values(stdScripts?.scripts ?? {})) enqueue(entry.bank, entry.address);
  const events = readEventTables(ctx);
  for (const row of Object.values(events.phone ?? {}) as any[]) {
    enqueue(row.calleeBank, row.calleeAddress);
    enqueue(row.callerBank, row.callerAddress);
  }
  for (const row of events.specialCalls ?? []) enqueue(row.scriptBank, row.scriptAddress);
  for (const row of Object.values(events.phoneScripts ?? {}) as any[]) enqueue(row.scriptBank, row.scriptAddress);
  for (const arm of Object.values(events.decorations ?? {}) as any[]) {
    enqueue(arm.scriptBank, arm.scriptAddress);
    for (const p of arm.posters ?? []) enqueue(p.scriptBank, p.scriptAddress);
  }

  // :3760 home/map.asm ObjectEvent (Gold's manifest has no such symbol, so
  // this only fires on a manifest that lists it).
  const objectEvent = ctx.location("ObjectEvent");
  if (objectEvent && objectEvent[0] === 0) enqueueHome(objectEvent[1]);

  // :3769 NAMED_TEXT
  const labels: Record<string, string> = {};
  for (const label of NAMED_TEXT) {
    const sym = ctx.location(label);
    if (sym) {
      const key = ensureText(sym[0], sym[1]);
      if (key) labels[label] = key;
    }
  }
  text.labels = labels;

  // :3780 seed from every map event with a script pointer.
  let mapCount = 0;
  for (const def of Object.values(maps)) {
    if (!def || typeof def !== "object" || def.scripts?.bank === undefined) continue;
    mapCount += 1;
    const bank: number = def.scripts.bank;
    for (const obj of def.objects ?? []) {
      if (obj.script === undefined) continue; // Lua: 0 is truthy
      if (obj.type === OBJECTTYPE_TRAINER) {
        obj.trainer = readTrainerHeader(bank, obj.script);
        if (obj.trainer?.scriptKey) obj.scriptKey = obj.trainer.scriptKey;
      } else if (obj.type === OBJECTTYPE_ITEMBALL) {
        obj.itemball = readItemBall(bank, obj.script);
      } else {
        // a ROM0 pointer is the shared ObjectEvent line (bank 0)
        obj.scriptKey = enqueueHome(obj.script);
        if (!obj.scriptKey) {
          obj.scriptKey = scriptKey(bank, obj.script);
          enqueue(bank, obj.script);
        }
      }
    }
    for (const ev of def.bgEvents ?? []) {
      if (ev.script === undefined) continue;
      if (ev.kind === BGEVENT_ITEM) {
        ev.hiddenItem = readHiddenItem(bank, ev.script);
      } else {
        ev.scriptKey = scriptKey(bank, ev.script);
        enqueue(bank, ev.script);
      }
    }
    for (const ev of def.coordEvents ?? []) {
      if (ev.script === undefined) continue;
      ev.scriptKey = scriptKey(bank, ev.script);
      enqueue(bank, ev.script);
    }
    for (const sc of Object.values(def.sceneScripts ?? {}) as any[]) {
      if (sc && typeof sc === "object" && sc.script !== undefined) enqueue(bank, sc.script);
    }
    for (const cb of def.callbacks ?? []) enqueue(bank, cb.script);
  }

  // :3842 the disassembly walk.
  let qi = 0;
  let disassembled = 0;
  const itemOrder: string[] = consts.itemOrder ?? [];
  while (qi < queue.length) {
    const item = queue[qi++]!;
    const bank = item.bank;
    let pc = item.address;
    const commands: ScriptCommand[] = [];
    for (let n = 0; n < 256; n++) {
      if (!romAddrOk(bank, pc)) {
        commands.push({ op: "truncated", reason: "pc" });
        break;
      }
      const opcode = attempt(() => rom.byte(bank, pc));
      if (opcode === undefined) {
        commands.push({ op: "truncated", reason: "read" });
        break;
      }
      const info = opcodesFor(ctx.edition).get(opcode);
      if (!info) {
        commands.push({ op: "unknown", code: opcode, source: `ROM:${item.key}` });
        break;
      }
      // givepoke: 4 bytes, or 8 when the trainer flag is set.
      let size = info.size;
      if (info.name === "givepoke") {
        const trainer = attempt(() => rom.byte(bank, pc + 4));
        size = trainer !== undefined && trainer !== 0 ? 8 : 4;
      }
      if (!romAddrOk(bank, pc + size)) {
        commands.push({ op: "truncated", reason: "args" });
        break;
      }
      const args = attempt(() => rom.bytes(bank, pc + 1, size));
      if (!args) {
        commands.push({ op: "truncated", reason: "args" });
        break;
      }
      const cmd: ScriptCommand = { op: info.name };
      const nextPc = pc + 1 + size;
      const a = (i: number): number => args[i]!; // Lua args[i + 1]

      switch (info.name) {
        case "writetext":
        case "jumptext":
        case "jumptextfaceplayer":
          cmd.text = ensureText(bank, wordFromArgs(args));
          break;
        // farjumptext is Crystal's new $52 and carries a dba, not a dw
        // (pokecrystal engine/overworld/scripting.asm:318-327)
        case "farjumptext":
        case "farwritetext": {
          const [tBank, tAddr] = dbaFromArgs(args);
          cmd.text = ensureText(tBank, tAddr);
          break;
        }
        case "checkevent":
        case "setevent":
        case "clearevent":
          cmd.event = wordFromArgs(args);
          break;
        case "checkflag":
        case "setflag":
        case "clearflag":
          cmd.flag = wordFromArgs(args);
          break;
        case "iftrue":
        case "iffalse":
        case "sjump":
        case "scall":
        case "stopandsjump":
        case "sdefer": {
          const target = wordFromArgs(args);
          cmd.script = scriptKey(bank, target);
          enqueue(bank, target);
          break;
        }
        case "ifequal":
        case "ifnotequal":
        case "ifgreater":
        case "ifless": {
          cmd.value = a(0);
          const target = a(1) + a(2) * 0x100;
          cmd.script = scriptKey(bank, target);
          enqueue(bank, target);
          break;
        }
        case "farscall":
        case "farsjump": {
          const [tBank, tAddr] = dbaFromArgs(args);
          cmd.script = scriptKey(tBank, tAddr);
          enqueue(tBank, tAddr);
          break;
        }
        case "jumpstd":
        case "callstd": {
          const id = wordFromArgs(args);
          cmd.id = id;
          const label = stdScripts?.byId[String(id)];
          const entry = label !== undefined ? stdScripts?.scripts[label] : undefined;
          if (entry) {
            cmd.std = label;
            cmd.script = entry.key;
          }
          break;
        }
        case "special":
        case "playmusic":
        case "playsound":
        case "cry":
          cmd.id = wordFromArgs(args);
          break;
        case "pause":
          cmd.frames = a(0);
          break;
        case "setscene":
          cmd.scene = a(0);
          break;
        case "setmapscene":
          cmd.group = a(0);
          cmd.map = a(1);
          cmd.scene = a(2);
          break;
        case "turnobject":
          cmd.object = a(0);
          cmd.facing = a(1);
          break;
        case "applymovement":
          cmd.object = a(0);
          cmd.movement = ensureMovement(bank, wordFromArgs([a(1), a(2)]));
          break;
        case "applymovementlasttalked":
          cmd.movement = ensureMovement(bank, wordFromArgs(args));
          break;
        case "givepoke": {
          cmd.species = a(0);
          cmd.level = a(1);
          cmd.item = a(2);
          cmd.trainer = a(3);
          // Script_givepoke (engine/overworld/scripting.asm:1806)
          if (size === 8) {
            const readAt = (lo: number, hi: number): string | undefined => {
              const addr = (args[lo] ?? 0) + (args[hi] ?? 0) * 0x100;
              if (!romAddrOk(bank, addr)) return undefined;
              return attempt(() => rom.readString(bank, addr, charmap, 0x50, 16)[0]);
            };
            cmd.name = readAt(4, 5);
            cmd.otName = readAt(6, 7);
          }
          break;
        }
        case "pokepic":
        case "disappear":
          cmd.species = a(0); // pokepic
          cmd.object = a(0); // disappear (same byte)
          cmd.args = args;
          break;
        case "getmonname":
          cmd.species = a(0);
          cmd.buffer = a(1);
          break;
        case "getitemname":
          cmd.item = a(0);
          cmd.buffer = a(1);
          break;
        case "getstring": {
          // `getstring buffer, pointer` lays the pointer down first.
          cmd.buffer = a(2);
          const sAddr = wordFromArgs(args);
          if (romAddrOk(bank, sAddr)) cmd.string = attempt(() => rom.readString(bank, sAddr, charmap, 0x50, 32)[0]);
          break;
        }
        case "givepokemail": {
          // :3980 target is `db item` + MAIL_MSG_LENGTH bytes, script's bank.
          cmd.args = args;
          const mAddr = wordFromArgs(args);
          if (romAddrOk(bank, mAddr)) {
            const itemByte = attempt(() => rom.byte(bank, mAddr));
            const message = readMailMessage(bank, mAddr + 1, 0x20);
            if (itemByte !== undefined && message !== undefined) {
              cmd.mail = { item: lua(itemOrder, itemByte), message };
            }
          }
          break;
        }
        case "checkpokemail": {
          cmd.args = args;
          const message = readMailMessage(bank, wordFromArgs(args), 0x20);
          if (message !== undefined) cmd.mail = { message };
          break;
        }
        case "gettrainername":
          cmd.group = a(0);
          cmd.trainer = a(1);
          cmd.buffer = a(2);
          break;
        case "loadtrainer":
          cmd.class = a(0);
          cmd.member = a(1);
          break;
        case "loadwildmon":
          cmd.species = a(0);
          cmd.level = a(1);
          break;
        case "winlosstext":
          cmd.winText = ensureText(bank, wordFromArgs(args));
          cmd.lossText = ensureText(bank, a(2) + a(3) * 0x100);
          break;
        case "trainertext":
          cmd.index = a(0);
          break;
        case "trainerflagaction":
          cmd.action = a(0);
          break;
        case "setlasttalked":
          cmd.object = a(0);
          break;
        case "showemote":
          cmd.emote = a(0);
          cmd.object = a(1);
          cmd.frames = a(2);
          break;
        case "giveitem":
        case "verbosegiveitem":
          cmd.item = a(0);
          cmd.quantity = a(1);
          break;
        case "addcellnum":
        case "delcellnum":
        case "checkcellnum":
          cmd.phone = a(0);
          break;
        case "readvar":
        case "writevar":
          cmd.var = a(0);
          break;
        case "follow":
        case "faceobject":
        case "follownotexact":
          cmd.a = a(0);
          cmd.b = a(1);
          break;
        case "loadmenu":
          // the header sits in the script's own bank
          cmd.menu = readMenuHeader(bank, wordFromArgs(args));
          break;
        case "writecmdqueue":
          cmd.queue = readCmdQueueEntry(bank, wordFromArgs(args));
          break;
        case "elevator":
          cmd.floors = readElevator(bank, wordFromArgs(args));
          break;
        case "trade":
          cmd.trade = a(0);
          break;
        case "describedecoration":
          cmd.decoration = a(0);
          cmd.decorationName = orderName(consts.decoDescOrder, a(0) + 1);
          break;
        default:
          if (size > 0) cmd.args = args;
      }

      commands.push(cmd);
      if (TERMINATORS.has(info.name)) break;
      pc = nextPc;
    }
    scripts[item.key] = commands;
    disassembled += 1;
  }
  scripts.movements = movements;

  return {
    scripts,
    text,
    events,
    initialEvents: extractInitialEvents(ctx),
    mapCount,
    scriptCount: disassembled,
  };
}

/**
 * RomExtractorGen2.lua:4089 extractInitialEvents — walk
 * InitializeEventsScript collecting setevent ids (flags), setflag ids
 * (engineFlags) and variablesprite {slot, sprite} rows, in first-seen order.
 * initial_events.json: {generation 2, source, flags, engineFlags, sprites}.
 */
export function extractInitialEvents(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const sym = ctx.location("InitializeEventsScript");
  if (!sym) {
    return { generation: 2, source: "missing symbol InitializeEventsScript", flags: [], engineFlags: [], sprites: [] };
  }
  const bank = sym[0];
  let pc = sym[1];
  const flags: number[] = [];
  const seen = new Set<number>();
  const engineFlags: number[] = [];
  const engineSeen = new Set<number>();
  const sprites: { slot: number; sprite: number }[] = [];
  for (let n = 0; n < 512; n++) {
    if (!romAddrOk(bank, pc)) break;
    const opcode = attempt(() => rom.byte(bank, pc));
    if (opcode === undefined) break;
    const info = opcodesFor(ctx.edition).get(opcode);
    if (!info) break;
    const size = info.size;
    let args: number[] = [];
    if (size > 0) {
      const read = attempt(() => rom.bytes(bank, pc + 1, size));
      if (!read) break;
      args = read;
    }
    if (info.name === "setevent") {
      const id = wordFromArgs(args);
      if (!seen.has(id)) {
        seen.add(id);
        flags.push(id);
      }
    } else if (info.name === "setflag") {
      const id = wordFromArgs(args);
      if (!engineSeen.has(id)) {
        engineSeen.add(id);
        engineFlags.push(id);
      }
    } else if (info.name === "variablesprite") {
      if (args[0] !== undefined && args[1] !== undefined) sprites.push({ slot: args[0], sprite: args[1] });
    }
    pc = pc + 1 + size;
    if (TERMINATORS.has(info.name)) break;
  }
  return { generation: 2, source: "ROM:InitializeEventsScript", flags, engineFlags, sprites };
}

/** RomExtractorGen2.lua:4247 extractText — the manifest's text.labels
 * (all of data/text/), decoded by label. rom_text.json: {label: string}. */
export function extractText(ctx: Gen2Ctx): Record<string, string> {
  const charmap = ctx.manifest.charmap ?? {};
  const labels = ((ctx.manifest.text ?? {}) as { labels?: string[] }).labels ?? [];
  const texts: Record<string, string> = {};
  for (const label of labels) {
    const location = ctx.location(label);
    if (location) texts[label] = decodeGen2Text(ctx, location[0], location[1], charmap);
  }
  return texts;
}
