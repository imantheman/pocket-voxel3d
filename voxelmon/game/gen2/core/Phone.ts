// gen1recomp src/core/gen2/Phone.lua at bdfac727 (MIT): the POKeGEAR's phone
// (engine/phone/phone.asm, data/phone/*.asm and the receive-call timer in
// engine/overworld/time.asm). Model only: the Pokegear card drives the
// outgoing half, the script VM the incoming half and the phone opcodes.
//
// Three machines share one contact table:
//   OUTGOING  MakePhoneCallFromPokegear -> the contact's SCRIPT1 ("callee").
//   INCOMING  CheckPhoneCall, once per step: a five-test gate, then SCRIPT2
//             ("caller"). This half hands out the trainer rematch flags.
//   SPECIAL   CheckSpecialPhoneCall, before the step is counted: a queued
//             `specialphonecall N` jumps the queue when its condition holds
//             (Elm's stolen-mon / egg beats, Mom's lecture, the bike shop).
//
// Notes Brian kept (Phone.lua:30-46): PhoneContacts rows carry two masks --
// SCRIPT1_TIME gates you calling them, SCRIPT2_TIME them calling you (Mom,
// Elm, Bill and the bike shop have 0, so they only ring via special calls);
// the delay timer restarts at twenty minutes on EVERY map load; the special
// queue is cleared by the called script itself (Phone.endCall is the
// fallback). A call's presentation is PhoneRing.ts.
//
// Indexing: CONTACTS is indexed by contact id (0..36, row 0 real), as in the
// Lua. wPhoneList is `save.phone.list`, a 0-based JS array of 10; the slot
// numbers this API takes and returns stay 1-based as the Lua passes them.
// save.phoneContacts is an object keyed by contact id. Multiple returns:
// only contactName returns a tuple ([name, className]).

import { Runtime } from "../shared/mods/Runtime.ts";
import { mod, sortedKeys, tonumber, truthy } from "../platform/lua.ts";
import { random } from "../platform/rng.ts";
import { osDate } from "../platform/clock.ts";

type SaveLike = Record<string, any> | null | undefined;

/** One PhoneContacts row (data/phone/phone_contacts.asm), plus the port's fields. */
export interface PhoneContact {
  index: number;
  number?: number;
  name?: string;
  /** the map id; undefined for N_A */
  map?: string;
  calleeTime: number;
  callee: string;
  callerTime: number;
  caller: string;
  class?: string;
  member?: string;
  /** extracted "bank:addr" keys (Phone.useExtracted) */
  calleeKey?: string;
  callerKey?: string;
  [k: string]: unknown;
}

/** One data/phone/special_calls.asm row. */
export interface SpecialCallRow {
  name: string;
  condition: "outside" | "anywhere" | string;
  contact: number;
  script: string;
  scriptKey?: string;
}

/** save.phone: wPhoneList plus the call timer's WRAM. */
export interface PhoneState {
  /** wPhoneList, 10 slots (0-based storage), 0 = empty */
  list: number[];
  /** wSpecialPhoneCallID */
  specialCall: number;
  /** wTimeCyclesSinceLastCall */
  timeCycles: number;
  /** wReceiveCallDelay_MinsRemaining */
  delayMins: number;
  /** wReceiveCallDelay_StartTime */
  delayStart?: PhoneClock;
}

export interface PhoneClock {
  day: number;
  hour: number;
  minute: number;
}

/** A call descriptor (LoadCallerScript / MakePhoneCallFromPokegear). */
export interface PhoneCall {
  kind: "call" | "justtalk" | "outofarea";
  contact: number | undefined;
  direction: "outgoing" | "incoming";
  script: string | undefined;
  scriptKey: string | undefined;
  wrongNumber?: boolean;
  class?: string;
  member?: string;
  number?: number;
  map?: string;
  special?: number;
  specialName?: string;
  delay?: number;
  /** set by the caller when the VM actually ran the script (Phone.endCall) */
  ranScript?: boolean;
}

/**
 * The context the phone reads: `clock` {day,hour,minute}, `timeOfDay`/`daytime`
 * (bit or MORN/DAY/NITE name), `map` (record or id), `mapId`, `maps`,
 * `phoneService`, `environment`, `rng` (() => 0..255), `linkMode`,
 * `standingOnEntrance`.
 */
export type PhoneCtx = Record<string, any> | null | undefined;

// ------------------------------------------------------- constants

// Lua: Phone.lua:64-68 -- constants/phone_constants.asm
const CONTACT_LIST_SIZE = 10;
const NUM_PHONE_CONTACTS = 36;
const SPECIALCALL_NONE = 0;
const NUM_SPECIALCALLS = 8;

// Lua: Phone.lua:70-74 -- wTimeOfDay bits. DARKNESS has none, so a dark map
// resolves to 0 and nobody is available.
const MORN = 1;
const DAY = 2;
const NITE = 4;
const ANYTIME = 7; // MORN | DAY | NITE

// Lua: Phone.lua:76-80 -- time of day boundaries; wCurDay wraps at 20 * 7.
const MORN_HOUR = 4;
const DAY_HOUR = 10;
const NITE_HOUR = 18;
const MAX_HOUR = 24;
const MAX_DAY = 140;

// Lua: Phone.lua:91-93 -- SpecialCallOnlyWhenOutside takes TOWN and ROUTE.
const OUTSIDE_ENVIRONMENTS: Record<string, boolean> = { TOWN: true, ROUTE: true };

// Lua: Phone.lua:95-102 -- constants/trainer_constants.asm opens `const_def 1`,
// so PHONECONTACT_MOM is 1; they double as PhoneContacts row indexes.
const PHONECONTACT_MOM = 1;
const PHONECONTACT_BIKESHOP = 2;
const PHONECONTACT_BILL = 3;
const PHONECONTACT_ELM = 4;

// Lua: Phone.lua:104-112 -- data/phone/non_trainer_names.asm, index = number.
const NON_TRAINER_NAMES: string[] = ["----------", "MOM", "BIKE SHOP", "BILL", "PROF.ELM"];

// Lua: Phone.lua:114-117 -- data/phone/permanent_numbers.asm.
const PERMANENT_NUMBERS: number[] = [PHONECONTACT_MOM, PHONECONTACT_ELM];

// ------------------------------------------------------- the contact table

// Lua: Phone.lua:119-238 -- data/phone/phone_contacts.asm, indexed from ZERO
// (PHONE_00 is the wrong-number filler; const_skip holes are `false`).
// Non-trainer rows carry their own `name` so the phone_contacts registry can
// override it in place.
type RawRow = Omit<PhoneContact, "index" | "calleeTime" | "callerTime"> & { calleeTime?: number; callerTime?: number };
const RAW_CONTACTS: (RawRow | false)[] = [
  { number: 0, name: "----------", map: undefined,
    calleeTime: 0, callee: "UnusedPhoneScript",
    callerTime: 0, caller: "UnusedPhoneScript" },
  { number: PHONECONTACT_MOM, name: "MOM", map: "PLAYERS_HOUSE_1F",
    calleeTime: ANYTIME, callee: "MomPhoneCalleeScript",
    callerTime: 0, caller: "UnusedPhoneScript" },
  { number: PHONECONTACT_BIKESHOP, name: "BIKE SHOP", map: "OAKS_LAB",
    calleeTime: 0, callee: "UnusedPhoneScript",
    callerTime: 0, caller: "UnusedPhoneScript" },
  { number: PHONECONTACT_BILL, name: "BILL", map: undefined,
    calleeTime: ANYTIME, callee: "BillPhoneCalleeScript",
    callerTime: 0, caller: "BillPhoneCallerScript" },
  { number: PHONECONTACT_ELM, name: "PROF.ELM", map: "ELMS_LAB",
    calleeTime: ANYTIME, callee: "ElmPhoneCalleeScript",
    callerTime: 0, caller: "ElmPhoneCallerScript" },
  { class: "SCHOOLBOY", member: "JACK1", map: "NATIONAL_PARK",
    callee: "JackPhoneCalleeScript", caller: "JackPhoneCallerScript" },
  { class: "POKEFANF", member: "BEVERLY1", map: "NATIONAL_PARK",
    callee: "BeverlyPhoneCalleeScript", caller: "BeverlyPhoneCallerScript" },
  { class: "SAILOR", member: "HUEY1", map: "OLIVINE_LIGHTHOUSE_2F",
    callee: "HueyPhoneCalleeScript", caller: "HueyPhoneCallerScript" },
  // const_skip x3
  false, false, false,
  { class: "COOLTRAINERM", member: "GAVEN3", map: "ROUTE_26",
    callee: "GavenPhoneCalleeScript", caller: "GavenPhoneCallerScript" },
  { class: "COOLTRAINERF", member: "BETH1", map: "ROUTE_26",
    callee: "BethPhoneCalleeScript", caller: "BethPhoneCallerScript" },
  { class: "BIRD_KEEPER", member: "JOSE2", map: "ROUTE_27",
    callee: "JosePhoneCalleeScript", caller: "JosePhoneCallerScript" },
  { class: "COOLTRAINERF", member: "REENA1", map: "ROUTE_27",
    callee: "ReenaPhoneCalleeScript", caller: "ReenaPhoneCallerScript" },
  { class: "YOUNGSTER", member: "JOEY1", map: "ROUTE_30",
    callee: "JoeyPhoneCalleeScript", caller: "JoeyPhoneCallerScript" },
  { class: "BUG_CATCHER", member: "WADE1", map: "ROUTE_31",
    callee: "WadePhoneCalleeScript", caller: "WadePhoneCallerScript" },
  { class: "FISHER", member: "RALPH1", map: "ROUTE_32",
    callee: "RalphPhoneCalleeScript", caller: "RalphPhoneCallerScript" },
  { class: "PICNICKER", member: "LIZ1", map: "ROUTE_32",
    callee: "LizPhoneCalleeScript", caller: "LizPhoneCallerScript" },
  { class: "HIKER", member: "ANTHONY2", map: "ROUTE_33",
    callee: "AnthonyPhoneCalleeScript", caller: "AnthonyPhoneCallerScript" },
  { class: "CAMPER", member: "TODD1", map: "ROUTE_34",
    callee: "ToddPhoneCalleeScript", caller: "ToddPhoneCallerScript" },
  { class: "PICNICKER", member: "GINA1", map: "ROUTE_34",
    callee: "GinaPhoneCalleeScript", caller: "GinaPhoneCallerScript" },
  { class: "JUGGLER", member: "IRWIN1", map: "ROUTE_35",
    callee: "IrwinPhoneCalleeScript", caller: "IrwinPhoneCallerScript" },
  { class: "BUG_CATCHER", member: "ARNIE1", map: "ROUTE_35",
    callee: "ArniePhoneCalleeScript", caller: "ArniePhoneCallerScript" },
  { class: "SCHOOLBOY", member: "ALAN1", map: "ROUTE_36",
    callee: "AlanPhoneCalleeScript", caller: "AlanPhoneCallerScript" },
  // const_skip
  false,
  { class: "LASS", member: "DANA1", map: "ROUTE_38",
    callee: "DanaPhoneCalleeScript", caller: "DanaPhoneCallerScript" },
  { class: "SCHOOLBOY", member: "CHAD1", map: "ROUTE_38",
    callee: "ChadPhoneCalleeScript", caller: "ChadPhoneCallerScript" },
  { class: "POKEFANM", member: "DEREK1", map: "ROUTE_39",
    callee: "DerekPhoneCalleeScript", caller: "DerekPhoneCallerScript" },
  { class: "FISHER", member: "CHRIS1", map: "ROUTE_42",
    callee: "ChrisPhoneCalleeScript", caller: "ChrisPhoneCallerScript" },
  { class: "POKEMANIAC", member: "BRENT1", map: "ROUTE_43",
    callee: "BrentPhoneCalleeScript", caller: "BrentPhoneCallerScript" },
  { class: "PICNICKER", member: "TIFFANY3", map: "ROUTE_43",
    callee: "TiffanyPhoneCalleeScript", caller: "TiffanyPhoneCallerScript" },
  { class: "BIRD_KEEPER", member: "VANCE1", map: "ROUTE_44",
    callee: "VancePhoneCalleeScript", caller: "VancePhoneCallerScript" },
  { class: "FISHER", member: "WILTON1", map: "ROUTE_44",
    callee: "WiltonPhoneCalleeScript", caller: "WiltonPhoneCallerScript" },
  { class: "BLACKBELT_T", member: "KENJI3", map: "ROUTE_45",
    callee: "KenjiPhoneCalleeScript", caller: "KenjiPhoneCallerScript" },
  { class: "HIKER", member: "PARRY1", map: "ROUTE_45",
    callee: "ParryPhoneCalleeScript", caller: "ParryPhoneCallerScript" },
  { class: "PICNICKER", member: "ERIN1", map: "ROUTE_46",
    callee: "ErinPhoneCalleeScript", caller: "ErinPhoneCallerScript" },
];

// Lua: Phone.lua:240-257 -- trainer rows are all ANYTIME/ANYTIME; holes
// become copies of row 0 so an in-range id never indexes nil.
const CONTACTS: PhoneContact[] = [];
for (let index = 0; index <= NUM_PHONE_CONTACTS; index++) {
  let raw = RAW_CONTACTS[index];
  if (raw === false || raw === undefined) {
    raw = { number: 0, name: "----------", map: undefined,
      calleeTime: 0, callee: "UnusedPhoneScript",
      callerTime: 0, caller: "UnusedPhoneScript" };
  }
  const row = raw as PhoneContact;
  row.index = index;
  if (truthy(row.class)) {
    row.calleeTime = row.calleeTime ?? ANYTIME;
    row.callerTime = row.callerTime ?? ANYTIME;
  }
  CONTACTS[index] = row;
}

// ------------------------------------------------------- the registry

// Lua: Phone.lua:259-281 -- the `phone_contacts` registry's merged rows,
// applied ONTO CONTACTS (literal -> cache -> registry).
let registryRows: Record<string, any> | undefined;

// Lua: Phone.lua:283-295
function applyRegistryRows(): number {
  if (!truthy(registryRows)) return 0;
  const rows = registryRows as Record<string, any>;
  let applied = 0;
  for (const k of sortedKeys(rows)) {
    const record = rows[k];
    const index = record !== null && typeof record === "object" ? record.index : undefined;
    const dest = index != null && index !== false ? CONTACTS[index] : undefined;
    if (dest) {
      for (const key of Object.keys(record)) dest[key] = record[key];
      applied++;
    }
  }
  return applied;
}

// ------------------------------------------------------- special calls

// Lua: Phone.lua:460-488 -- data/phone/special_calls.asm, keyed by SPECIALCALL_*
// (1-based; SPECIALCALL_NONE is 0). The row's script REPLACES the contact's
// SCRIPT2 for that one call.
const SPECIAL_CALLS: Record<number, SpecialCallRow> = {
  1: { name: "SPECIALCALL_POKERUS", condition: "outside",
    contact: PHONECONTACT_ELM, script: "ElmPhoneCallerScript" },
  2: { name: "SPECIALCALL_ROBBED", condition: "outside",
    contact: PHONECONTACT_ELM, script: "ElmPhoneCallerScript" },
  3: { name: "SPECIALCALL_ASSISTANT", condition: "outside",
    contact: PHONECONTACT_ELM, script: "ElmPhoneCallerScript" },
  4: { name: "SPECIALCALL_WEIRDBROADCAST", condition: "outside",
    contact: PHONECONTACT_ELM, script: "ElmPhoneCallerScript" },
  5: { name: "SPECIALCALL_SSTICKET", condition: "anywhere",
    contact: PHONECONTACT_ELM, script: "ElmPhoneCallerScript" },
  6: { name: "SPECIALCALL_BIKESHOP", condition: "anywhere",
    contact: PHONECONTACT_BIKESHOP, script: "BikeShopPhoneCallerScript" },
  7: { name: "SPECIALCALL_WORRIED", condition: "anywhere",
    contact: PHONECONTACT_MOM, script: "MomPhoneLectureScript" },
  8: { name: "SPECIALCALL_MASTERBALL", condition: "outside",
    contact: PHONECONTACT_ELM, script: "ElmPhoneCallerScript" },
};

// Lua: Phone.lua:490-494 -- name -> id.
const SPECIALCALL: Record<string, number> = { SPECIALCALL_NONE: 0 };
for (const k of sortedKeys(SPECIAL_CALLS)) SPECIALCALL[SPECIAL_CALLS[Number(k)]!.name] = Number(k);

// ------------------------------------------------------- save state

// Lua: Phone.lua:552-560
function newState(): PhoneState {
  return {
    list: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    specialCall: 0,
    timeCycles: 0,
    delayMins: 20,
    delayStart: undefined,
  };
}

// Lua: Phone.lua:562-567 -- the 1-based slot holding `id`, or undefined.
function inList(state: PhoneState, id: unknown): number | undefined {
  for (let slot = 1; slot <= CONTACT_LIST_SIZE; slot++) {
    if (state.list[slot - 1] === id) return slot;
  }
  return undefined;
}

// ------------------------------------------------------- context helpers

// Lua: Phone.lua:796-800 -- a Random byte, 0..255.
function rngOf(ctx: PhoneCtx): () => number {
  const rng = ctx ? ctx.rng : undefined;
  if (truthy(rng)) return rng;
  return () => random(0, 255);
}

// Lua: Phone.lua:802-816 -- the game clock as {day, hour, minute}.
function clockOf(ctx: PhoneCtx): PhoneClock {
  const clock = ctx ? ctx.clock : undefined;
  if (clock !== null && typeof clock === "object") {
    return {
      day: tonumber(clock.day) ?? 0,
      hour: tonumber(clock.hour) ?? 0,
      minute: tonumber(clock.minute ?? clock.min) ?? 0,
    };
  }
  // os.date's %j, %H and %M, read off one breakdown rather than three
  // formatted strings (this runs every overworld step)
  const t = osDate("*t");
  return {
    day: mod(t.yday ?? 1, MAX_DAY),
    hour: t.hour ?? 0,
    minute: t.min ?? 0,
  };
}

// Lua: Phone.lua:818-824 -- CheckTime's table; DARKNESS comes back as 0.
const TIME_BITS: Record<string, number> = {
  MORN, DAY, NITE,
  MORN_F: MORN, DAY_F: DAY, NITE_F: NITE,
  DARK: 0, DARKNESS: 0,
};

// Lua: Phone.lua:837-848 -- AND the three time bits.
function timeMatches(mask: number | undefined, checked: number | undefined): boolean {
  const m = mask ?? 0;
  const c = checked ?? 0;
  for (const bit of [MORN, DAY, NITE]) {
    if (mod(Math.floor(m / bit), 2) === 1 && mod(Math.floor(c / bit), 2) === 1) {
      return true;
    }
  }
  return false;
}

// Lua: Phone.lua:855-859
function mapRecord(ctx: PhoneCtx): Record<string, any> | undefined {
  const map = ctx ? ctx.map : undefined;
  if (map !== null && typeof map === "object") return map;
  return undefined;
}

// Lua: Phone.lua:873-879
function currentMapId(ctx: PhoneCtx): string | undefined {
  const record = mapRecord(ctx);
  if (record) return record.id;
  const map = ctx ? ctx.map : undefined;
  if (typeof map === "string") return map;
  return ctx ? ctx.mapId ?? undefined : undefined;
}

// Lua: Phone.lua:914 -- .ReceiveCallDelays, by wTimeCyclesSinceLastCall.
const RECEIVE_CALL_DELAYS: number[] = [20, 10, 5, 3];

// Lua: Phone.lua:916-926 -- CalcMinsHoursDaysSince, borrow chain and all.
function since(now: PhoneClock, start: PhoneClock): [number, number, number] {
  let borrow = 0;
  let minutes = now.minute - start.minute - borrow;
  if (minutes < 0) { minutes += 60; borrow = 1; } else borrow = 0;
  let hours = now.hour - start.hour - borrow;
  if (hours < 0) { hours += MAX_HOUR; borrow = 1; } else borrow = 0;
  let days = now.day - start.day - borrow;
  if (days < 0) days += MAX_DAY;
  return [minutes, hours, days];
}

// Lua: Phone.lua:1000-1028 -- LoadCallerScript. Contact 0 is the WrongNumber
// record.
function descriptor(idIn: unknown, direction: "outgoing" | "incoming", scriptField: "callee" | "caller"): PhoneCall {
  const id = tonumber(idIn) ?? 0;
  const contact = CONTACTS[id];
  if (id === 0 || !contact) {
    return {
      kind: "call", contact: 0, direction,
      script: "WrongNumberScript",
      scriptKey: Phone.SCRIPT_KEYS.WrongNumberScript,
      wrongNumber: true,
    };
  }
  const label = contact[scriptField];
  return {
    kind: "call",
    contact: id,
    direction,
    class: contact.class,
    member: contact.member,
    number: contact.number,
    map: contact.map,
    script: label,
    // the extracted key wins over the transcribed symbol-file label
    scriptKey: (contact[`${scriptField}Key`] as string | undefined) ?? Phone.scriptKey(label),
  };
}

function sameList(_save: SaveLike, list: number[]): number[] {
  return list;
}

export const Phone = {
  CONTACT_LIST_SIZE,
  NUM_PHONE_CONTACTS,
  SPECIALCALL_NONE,
  NUM_SPECIALCALLS,
  MORN,
  DAY,
  NITE,
  ANYTIME,
  CONTACT_GOT: 0,
  CONTACTS_FULL: 1,
  CONTACT_REFUSED: 2,
  // Lua: Phone.lua:87-89 -- `dwb wSpecialPhoneCallID, RETVAR_STRBUF2`
  VAR_SPECIALPHONECALL: 0x14,
  PHONECONTACT_MOM,
  PHONECONTACT_BIKESHOP,
  PHONECONTACT_BILL,
  PHONECONTACT_ELM,
  NON_TRAINER_NAMES,
  PERMANENT_NUMBERS,
  CONTACTS,
  SPECIAL_CALLS,
  SPECIALCALL,
  RECEIVE_CALL_DELAYS,
  /** true once useExtracted overlaid at least one cache row */
  extracted: false as boolean,

  // Lua: Phone.lua:322-397 -- pokegold.sym "bank:addr" keys for the scripts.
  SCRIPT_KEYS: {
    UnusedPhoneScript: "41:4000",
    MomPhoneCalleeScript: "41:4004",
    MomPhoneLectureScript: "41:4124",
    BillPhoneCalleeScript: "41:4137",
    BillPhoneCallerScript: "41:4172",
    ElmPhoneCalleeScript: "41:4177",
    ElmPhoneCallerScript: "41:41e1",
    JackPhoneCalleeScript: "41:422a",
    JackPhoneCallerScript: "41:4234",
    BeverlyPhoneCalleeScript: "41:4256",
    BeverlyPhoneCallerScript: "41:4260",
    HueyPhoneCalleeScript: "41:4282",
    HueyPhoneCallerScript: "41:428c",
    GavenPhoneCalleeScript: "41:42a7",
    GavenPhoneCallerScript: "41:42b1",
    BethPhoneCalleeScript: "41:42d3",
    BethPhoneCallerScript: "41:42dd",
    JosePhoneCalleeScript: "41:42ff",
    JosePhoneCallerScript: "41:4309",
    ReenaPhoneCalleeScript: "41:4332",
    ReenaPhoneCallerScript: "41:433c",
    JoeyPhoneCalleeScript: "41:435e",
    JoeyPhoneCallerScript: "41:4368",
    WadePhoneCalleeScript: "41:4390",
    WadePhoneCallerScript: "41:43b5",
    RalphPhoneCalleeScript: "41:43f8",
    RalphPhoneCallerScript: "41:4402",
    LizPhoneCalleeScript: "41:4446",
    LizPhoneCallerScript: "41:4450",
    AnthonyPhoneCalleeScript: "41:4478",
    AnthonyPhoneCallerScript: "41:4482",
    ToddPhoneCalleeScript: "41:44c4",
    ToddPhoneCallerScript: "41:44ce",
    GinaPhoneCalleeScript: "41:44f6",
    GinaPhoneCallerScript: "41:4506",
    IrwinPhoneCalleeScript: "41:4534",
    IrwinPhoneCallerScript: "41:4544",
    ArniePhoneCalleeScript: "41:456c",
    ArniePhoneCallerScript: "41:4576",
    AlanPhoneCalleeScript: "41:45b2",
    AlanPhoneCallerScript: "41:45bc",
    DanaPhoneCalleeScript: "41:45de",
    DanaPhoneCallerScript: "41:45e8",
    ChadPhoneCalleeScript: "41:460a",
    ChadPhoneCallerScript: "41:4614",
    DerekPhoneCalleeScript: "41:4650",
    DerekPhoneCallerScript: "41:4675",
    ChrisPhoneCalleeScript: "41:46b2",
    ChrisPhoneCallerScript: "41:46bc",
    BrentPhoneCalleeScript: "41:46de",
    BrentPhoneCallerScript: "41:46e8",
    TiffanyPhoneCalleeScript: "41:4711",
    TiffanyPhoneCallerScript: "41:471b",
    VancePhoneCalleeScript: "41:4744",
    VancePhoneCallerScript: "41:474e",
    WiltonPhoneCalleeScript: "41:4770",
    WiltonPhoneCallerScript: "41:477a",
    KenjiPhoneCalleeScript: "41:47b8",
    KenjiPhoneCallerScript: "41:47c2",
    ParryPhoneCalleeScript: "41:47e4",
    ParryPhoneCallerScript: "41:47ee",
    ErinPhoneCalleeScript: "41:482a",
    ErinPhoneCallerScript: "41:4834",
    BikeShopPhoneCallerScript: "41:4a80",
    // bank $24: the engine's own scripts, reached without a contact row.
    WrongNumberScript: "24:4240",
    PhoneOutOfAreaScript: "24:4626",
    PhoneScript_JustTalkToThem: "24:462f",
  } as Record<string, string>,

  // Lua: Phone.lua:496-540 -- contact id -> EVENT_<NAME>_READY_FOR_REMATCH
  // (wEventFlags bit index).
  REMATCH_EVENTS: {
    5: 608, 6: 610, 7: 612, 11: 620, 12: 622, 13: 624, 14: 626, 15: 628,
    16: 630, 17: 632, 18: 634, 19: 636, 20: 638, 21: 640, 22: 642, 23: 644,
    24: 646, 26: 650, 27: 652, 28: 654, 29: 656, 30: 658, 31: 660, 32: 662,
    33: 664, 34: 666, 35: 668, 36: 670,
  } as Record<number, number>,

  timeMatches,
  loadCallerScript: descriptor,

  // Lua: Phone.lua:297-313 -- vanilla registrations, engine-owned; the ids
  // come from data.gen2Constants.phoneContactOrder (0-based JSON array).
  registerInto(registry: any, data: any, owner?: unknown): number {
    const order = data && data.gen2Constants ? data.gen2Constants.phoneContactOrder : undefined;
    if (order === null || typeof order !== "object") return 0;
    let count = 0;
    for (let index = 0; index <= NUM_PHONE_CONTACTS; index++) {
      const id = order[index];
      const row = CONTACTS[index];
      if (typeof id === "string" && id !== "PHONE_UNUSED" && row) {
        registry.register(id, row, owner);
        count++;
      }
    }
    return count;
  },

  // Lua: Phone.lua:315-320 -- hold the merged table and fold it onto the rows.
  useRegistry(data: any): number {
    registryRows = (data && truthy(data.gen2PhoneContacts)) ? data.gen2PhoneContacts : undefined;
    return applyRegistryRows();
  },

  // Lua: Phone.lua:399-401
  scriptKey(label: string | undefined | null): string | undefined {
    return truthy(label) ? Phone.SCRIPT_KEYS[label as string] : undefined;
  },

  // Lua: Phone.lua:403-458 -- overlay the cache's own contact / special-call
  // rows (events.json phone / specialCalls / phoneScripts). class, member and
  // the labels stay; the registry is re-applied last.
  useExtracted(events: any): boolean {
    const rows = events !== null && typeof events === "object" ? events.phone : undefined;
    if (rows === null || typeof rows !== "object") return false;
    let applied = 0;
    for (let index = 0; index <= NUM_PHONE_CONTACTS; index++) {
      const row = rows[index];
      const dest = CONTACTS[index];
      if (row !== null && typeof row === "object" && dest) {
        dest.map = row.map;
        dest.calleeTime = row.calleeTime;
        dest.callerTime = row.callerTime;
        dest.calleeKey = row.callee;
        dest.callerKey = row.caller;
        // an UnusedPhoneScript row has number 0: keep the hand-ported one
        if (truthy(row.number) && row.number !== 0) dest.number = row.number;
        applied++;
      }
    }
    for (const row of (events.specialCalls ?? []) as any[]) {
      if (row == null) break;
      const dest = SPECIAL_CALLS[row.id];
      if (dest) {
        dest.contact = row.contact;
        dest.scriptKey = row.script;
      }
    }
    // the three scripts the engine runs without a contact row
    const scripts = (events.phoneScripts ?? {}) as Record<string, any>;
    for (const label of sortedKeys(scripts)) {
      const row = scripts[label];
      if (truthy(row.script)) Phone.SCRIPT_KEYS[label] = row.script;
    }
    applyRegistryRows();
    Phone.extracted = applied > 0;
    return Phone.extracted;
  },

  // Lua: Phone.lua:569-602 -- save.phone, normalised; adopts ids the VM's
  // addcellnum hook put in save.phoneContacts, then mirrors back.
  state(save: SaveLike): PhoneState {
    if (save === null || typeof save !== "object") return newState();
    let state = save.phone as PhoneState;
    if (state === null || typeof state !== "object") {
      state = newState();
      save.phone = state;
    }
    state.list = Array.isArray(state.list) ? state.list : [];
    for (let slot = 1; slot <= CONTACT_LIST_SIZE; slot++) {
      state.list[slot - 1] = tonumber(state.list[slot - 1]) ?? 0;
    }
    state.specialCall = tonumber(state.specialCall) ?? 0;
    state.timeCycles = tonumber(state.timeCycles) ?? 0;
    state.delayMins = tonumber(state.delayMins) ?? 20;
    const legacy = save.phoneContacts;
    if (legacy !== null && typeof legacy === "object") {
      for (const key of sortedKeys(legacy)) {
        const id = tonumber(key);
        if (id !== undefined && id > 0 && inList(state, id) === undefined) {
          for (let slot = 1; slot <= CONTACT_LIST_SIZE; slot++) {
            if (state.list[slot - 1] === 0) {
              state.list[slot - 1] = id;
              break;
            }
          }
        }
      }
    }
    Phone.mirror(save, state);
    return state;
  },

  // Lua: Phone.lua:604-617 -- rebuild save.phoneContacts from wPhoneList
  // (without adopting, so a removed id stays removed).
  mirror(save: Record<string, any>, stateIn?: PhoneState): Record<number, boolean> {
    const state = (stateIn ?? (save ? save.phone : undefined) ?? {}) as Partial<PhoneState>;
    const legacy: Record<number, boolean> = {};
    for (let slot = 1; slot <= CONTACT_LIST_SIZE; slot++) {
      const id = state.list ? state.list[slot - 1] : undefined;
      if (id != null && id !== 0) legacy[id] = true;
    }
    save.phoneContacts = legacy;
    return legacy;
  },

  // Lua: Phone.lua:619-628 -- _CheckCellNum, literally: hasContact(save, 0)
  // is true whenever a slot is empty.
  hasContact(save: SaveLike, id: unknown): boolean {
    const state = Phone.state(save);
    return inList(state, id) !== undefined;
  },

  // Lua: Phone.lua:630-644 -- GetRemainingSpaceInPhoneList: each permanent
  // number not yet registered (other than `id`) reserves a slot.
  remainingSlots(save: SaveLike, id?: unknown): number {
    const state = Phone.state(save);
    let reserved = 0;
    for (const permanent of PERMANENT_NUMBERS) {
      if (permanent !== id && inList(state, permanent) === undefined) reserved++;
    }
    return CONTACT_LIST_SIZE - reserved;
  },

  // Lua: Phone.lua:646-654 -- Phone_FindOpenSlot; returns the 1-based slot.
  openSlot(save: SaveLike, id?: unknown): number | undefined {
    const state = Phone.state(save);
    const usable = Phone.remainingSlots(save, id);
    for (let slot = 1; slot <= usable; slot++) {
      if (state.list[slot - 1] === 0) return slot;
    }
    return undefined;
  },

  // Lua: Phone.lua:656-670 -- AddPhoneNumber. The Lua's second return (the
  // reason: "unknown" / "already" / "full") is unused by its callers and
  // dropped here.
  addContact(save: SaveLike, idIn: unknown): boolean {
    const id = tonumber(idIn);
    if (id === undefined || !CONTACTS[id]) return false;
    const state = Phone.state(save);
    if (inList(state, id) !== undefined) return false;
    const slot = Phone.openSlot(save, id);
    if (slot === undefined) return false;
    state.list[slot - 1] = id;
    const s = save as Record<string, any>;
    s.phoneContacts = s.phoneContacts ?? {};
    s.phoneContacts[id] = true;
    return true;
  },

  // Lua: Phone.lua:672-680 -- DelCellNum: blank the slot in place.
  removeContact(save: SaveLike, id: unknown): boolean {
    const state = Phone.state(save);
    const slot = inList(state, id);
    if (slot === undefined) return false;
    state.list[slot - 1] = 0;
    Phone.mirror(save as Record<string, any>, state);
    return true;
  },

  // Lua: Phone.lua:682-700 -- PokegearPhone_DeletePhoneNumber: blank the
  // (1-based) slot, then compact CONTACT_LIST_SIZE times.
  deleteContactAt(save: SaveLike, slot: number): boolean {
    const state = Phone.state(save);
    if (slot == null || state.list[slot - 1] === undefined) return false;
    state.list[slot - 1] = 0;
    for (let n = 1; n <= CONTACT_LIST_SIZE; n++) {
      for (let index = 1; index <= CONTACT_LIST_SIZE - 1; index++) {
        if (state.list[index - 1] === 0) {
          state.list[index - 1] = state.list[index]!;
          state.list[index] = 0;
        }
      }
    }
    Phone.mirror(save as Record<string, any>, state);
    return true;
  },

  // Lua: Phone.lua:702-712 -- CheckCanDeletePhoneNumber.
  canDelete(id: number | undefined | null): boolean {
    const contact = CONTACTS[id ?? -1];
    if (!contact) return false;
    if (truthy(contact.class)) return true;
    if (contact.number === PHONECONTACT_MOM) return false;
    if (contact.number === PHONECONTACT_ELM) return false;
    return contact.number !== 0;
  },

  // Lua: Phone.lua:714-745 -- wPhoneList as ten slot values (0 = empty),
  // through the phone.contact_list hook.
  contacts(save: SaveLike): number[] {
    const state = Phone.state(save);
    const out: number[] = [];
    for (let slot = 1; slot <= CONTACT_LIST_SIZE; slot++) out[slot - 1] = state.list[slot - 1]!;
    if (!Runtime.wantsHook("phone.contact_list")) return out;
    const hooked: any = Runtime.call("phone.contact_list", sameList, save, out);
    if (!Array.isArray(hooked) || hooked.length !== CONTACT_LIST_SIZE) return out;
    for (let slot = 1; slot <= CONTACT_LIST_SIZE; slot++) {
      const id = tonumber(hooked[slot - 1]) ?? 0;
      hooked[slot - 1] = CONTACTS[id] ? id : 0;
    }
    return hooked;
  },

  // Lua: Phone.lua:747-754 -- Script_askforphonenumber; `accepted` is the
  // YesNoBox result.
  askForNumber(save: SaveLike, id: unknown, accepted: unknown): number {
    if (!truthy(accepted)) return Phone.CONTACT_REFUSED;
    if (Phone.addContact(save, id)) return Phone.CONTACT_GOT;
    return Phone.CONTACTS_FULL;
  },

  // Lua: Phone.lua:758-792 -- GetCallerName: [name, className]. className is
  // undefined for a non-trainer. `trainerData` is trainers.json.
  contactName(id: number | undefined | null, trainerData?: any): [string | undefined, string | undefined] {
    const contact = CONTACTS[id ?? -1];
    if (!contact) return [NON_TRAINER_NAMES[0], undefined];
    if (truthy(contact.name)) {
      let className: string | undefined;
      if (truthy(contact.class)) {
        const cls = trainerData && trainerData.classes ? trainerData.classes[contact.class!] : undefined;
        className = (cls && truthy(cls.name) ? cls.name : undefined) ?? contact.class;
      }
      return [contact.name, className];
    }
    if (!truthy(contact.class)) {
      return [NON_TRAINER_NAMES[contact.number ?? 0] ?? NON_TRAINER_NAMES[0], undefined];
    }
    const cls = trainerData && trainerData.classes ? trainerData.classes[contact.class!] : undefined;
    if (cls && truthy(cls.trainers)) {
      for (const row of cls.trainers as any[]) {
        if (row == null) break;
        if (row.id === contact.member) {
          return [row.name, truthy(cls.name) ? cls.name : contact.class];
        }
      }
    }
    return [contact.member, contact.class];
  },

  // Lua: Phone.lua:826-835 -- CheckTime -> the MORN / DAY / NITE bit.
  timeOfDay(ctx: PhoneCtx): number {
    const given = ctx ? (ctx.timeOfDay ?? ctx.daytime) : undefined;
    if (typeof given === "number") return given;
    if (typeof given === "string") return TIME_BITS[given] ?? 0;
    const hour = clockOf(ctx).hour;
    if (hour < MORN_HOUR) return NITE;
    if (hour < DAY_HOUR) return MORN;
    if (hour < NITE_HOUR) return DAY;
    return NITE;
  },

  // Lua: Phone.lua:852-871 -- GetMapPhoneService; no header -> service.
  mapHasService(ctx: PhoneCtx): boolean {
    const record = mapRecord(ctx);
    if (record !== undefined && record.phoneService != null) return truthy(record.phoneService);
    if (ctx && ctx.phoneService != null) return truthy(ctx.phoneService);
    return true;
  },

  // Lua: Phone.lua:881-894 -- a contact on your own map is skipped.
  onSameMap(contact: PhoneContact | undefined, ctx: PhoneCtx): boolean {
    if (!(contact && truthy(contact.map))) return false;
    const here = currentMapId(ctx);
    if (truthy(here)) return here === contact.map;
    const record = mapRecord(ctx);
    const maps = ctx ? ctx.maps : undefined;
    const theirs = maps ? maps[contact.map!] : undefined;
    if (record && theirs) {
      return record.group === theirs.group && record.map === theirs.map;
    }
    return false;
  },

  // Lua: Phone.lua:896-902 -- SpecialCallOnlyWhenOutside.
  isOutside(ctx: PhoneCtx): boolean {
    const record = mapRecord(ctx);
    const environment = (record && truthy(record.environment) ? record.environment : undefined)
      ?? (ctx ? ctx.environment : undefined);
    return OUTSIDE_ENVIRONMENTS[environment] === true;
  },

  // Lua: Phone.lua:928-934 -- RestartReceiveCallDelay.
  restartReceiveDelay(save: SaveLike, minutes: number, ctx?: PhoneCtx): PhoneState {
    const state = Phone.state(save);
    state.delayMins = minutes;
    state.delayStart = clockOf(ctx);
    return state;
  },

  // Lua: Phone.lua:936-943 -- NextCallReceiveDelay.
  nextReceiveDelay(save: SaveLike, ctx?: PhoneCtx): PhoneState {
    const state = Phone.state(save);
    let cycles = state.timeCycles ?? 0;
    if (cycles > 3) cycles = 3;
    return Phone.restartReceiveDelay(save, RECEIVE_CALL_DELAYS[cycles]!, ctx);
  },

  // Lua: Phone.lua:945-951 -- InitCallReceiveDelay (every map load, and the
  // tail of Script_ReceivePhoneCall).
  initReceiveDelay(save: SaveLike, ctx?: PhoneCtx): PhoneState {
    const state = Phone.state(save);
    state.timeCycles = 0;
    return Phone.nextReceiveDelay(save, ctx);
  },

  // Lua: Phone.lua:953-957 -- StartMap's `farcall InitCallReceiveDelay`.
  onMapLoad(save: SaveLike, ctx?: PhoneCtx): PhoneState {
    return Phone.initReceiveDelay(save, ctx);
  },

  // Lua: Phone.lua:959-984 -- CheckReceiveCallDelay -> UpdateTimeRemaining;
  // true when the countdown has reached zero. The stamp rebases every check.
  checkReceiveCallDelay(save: SaveLike, ctx?: PhoneCtx): boolean {
    const state = Phone.state(save);
    const now = clockOf(ctx);
    if (!truthy(state.delayStart)) {
      state.delayStart = now;
      return false;
    }
    const [minutes, hours, days] = since(now, state.delayStart!);
    state.delayStart = now;
    let elapsed = minutes;
    if (days !== 0 || hours !== 0) elapsed = -1;
    if (elapsed === -1) {
      state.delayMins = 0;
      return true;
    }
    let left = (state.delayMins ?? 0) - elapsed;
    if (left < 0) left = 0;
    state.delayMins = left;
    return left === 0;
  },

  // Lua: Phone.lua:986-996 -- CheckReceiveCallTimer: consume the expiry, wind
  // the cycle counter (capped at 3), restart at the next, shorter delay.
  checkReceiveCallTimer(save: SaveLike, ctx?: PhoneCtx): boolean {
    if (!Phone.checkReceiveCallDelay(save, ctx)) return false;
    const state = Phone.state(save);
    if ((state.timeCycles ?? 0) < 3) state.timeCycles = (state.timeCycles ?? 0) + 1;
    Phone.nextReceiveDelay(save, ctx);
    return true;
  },

  // Lua: Phone.lua:1032-1070 -- MakePhoneCallFromPokegear. Whether the
  // contact is in your book is NOT checked (the Pokegear only offers listed
  // ones).
  call(_save: SaveLike, id: unknown, ctxIn?: PhoneCtx): PhoneCall {
    const ctx = ctxIn ?? {};
    const outOfArea: PhoneCall = {
      kind: "outofarea",
      contact: tonumber(id) ?? 0,
      direction: "outgoing",
      script: "PhoneOutOfAreaScript",
      scriptKey: Phone.SCRIPT_KEYS.PhoneOutOfAreaScript,
    };
    if (truthy(ctx.linkMode)) return outOfArea;
    if (!Phone.mapHasService(ctx)) return outOfArea;
    const contact = CONTACTS[tonumber(id) ?? -1];
    if (!contact) return outOfArea;
    // CheckPhoneContactTimeOfDay: SCRIPT1_TIME & ANYTIME & the time bit
    if (!timeMatches(contact.calleeTime, Phone.timeOfDay(ctx))) return outOfArea;
    if (Phone.onSameMap(contact, ctx)) {
      return {
        kind: "justtalk",
        contact: tonumber(id),
        direction: "outgoing",
        script: "PhoneScript_JustTalkToThem",
        scriptKey: Phone.SCRIPT_KEYS.PhoneScript_JustTalkToThem,
      };
    }
    return descriptor(id, "outgoing", "callee");
  },

  // Lua: Phone.lua:1074-1092 -- GetAvailableCallers: listed contacts whose
  // SCRIPT2_TIME covers now and who are not on this map.
  availableCallers(save: SaveLike, ctx?: PhoneCtx): number[] {
    const state = Phone.state(save);
    const checked = Phone.timeOfDay(ctx);
    const out: number[] = [];
    for (let slot = 1; slot <= CONTACT_LIST_SIZE; slot++) {
      const id = state.list[slot - 1]!;
      if (id !== 0) {
        const contact = CONTACTS[id];
        if (contact && timeMatches(contact.callerTime, checked) && !Phone.onSameMap(contact, ctx)) {
          out.push(id);
        }
      }
    }
    return out;
  },

  // Lua: Phone.lua:1094-1105 -- ChooseRandomCaller: one byte, nibble-swapped,
  // masked to 0..31, mod the caller count.
  chooseRandomCaller(callers: number[] | undefined, rngIn?: () => number): number | undefined {
    if (!callers || callers.length === 0) return undefined;
    const rng = rngIn ?? rngOf(undefined);
    const roll = mod(rng(), 256);
    const swapped = mod(roll, 16) * 16 + Math.floor(roll / 16);
    const index = mod(mod(swapped, 32), callers.length);
    return callers[index];
  },

  // Lua: Phone.lua:1107-1128 -- CheckPhoneCall, the gate in the cart's order:
  // entrance tile, receive timer (side effects), 50% coin, service, callers.
  tryRandomCall(save: SaveLike, ctxIn?: PhoneCtx): PhoneCall | undefined {
    const ctx = ctxIn ?? {};
    if (truthy(ctx.standingOnEntrance)) return undefined;
    if (!Phone.checkReceiveCallTimer(save, ctx)) return undefined;
    const rng = rngOf(ctx);
    // `and %01111111 / cp b`: passes only when the top bit was clear
    if (mod(rng(), 256) >= 0x80) return undefined;
    if (!Phone.mapHasService(ctx)) return undefined;
    const who = Phone.chooseRandomCaller(Phone.availableCallers(save, ctx), rng);
    if (who === undefined) return undefined;
    return descriptor(who, "incoming", "caller");
  },

  // Lua: Phone.lua:1130-1131 -- the cart's own name (see below the object).
  checkPhoneCall: undefined as unknown as (save: SaveLike, ctx?: PhoneCtx) => PhoneCall | undefined,

  // Lua: Phone.lua:1135-1141 -- Script_specialphonecall.
  queueSpecialCall(save: SaveLike, id: unknown): number {
    const state = Phone.state(save);
    state.specialCall = tonumber(id) ?? 0;
    return state.specialCall;
  },

  // Lua: Phone.lua:1143-1145
  clearSpecialCall(save: SaveLike): number {
    return Phone.queueSpecialCall(save, SPECIALCALL_NONE);
  },

  // Lua: Phone.lua:1147-1150 -- Script_checkphonecall.
  hasSpecialCall(save: SaveLike): boolean {
    return Phone.state(save).specialCall !== 0;
  },

  // Lua: Phone.lua:1152-1156 -- readvar VAR_SPECIALPHONECALL.
  specialCallVar(save: SaveLike): number {
    return Phone.state(save).specialCall ?? 0;
  },

  // Lua: Phone.lua:1158-1180 -- CheckSpecialPhoneCall. `delay` is the
  // wrapper script's `pause 30`.
  checkSpecialCall(save: SaveLike, ctx?: PhoneCtx): PhoneCall | undefined {
    const state = Phone.state(save);
    const queued = state.specialCall ?? 0;
    if (queued === 0) return undefined;
    const entry = SPECIAL_CALLS[queued];
    if (!entry) return undefined;
    if (entry.condition === "outside" && !Phone.isOutside(ctx)) return undefined;
    const call = descriptor(entry.contact, "incoming", "caller");
    call.special = queued;
    call.specialName = entry.name;
    call.script = entry.script;
    call.scriptKey = entry.scriptKey ?? Phone.scriptKey(entry.script);
    call.delay = 30;
    return call;
  },

  // Lua: Phone.lua:1184-1186
  rematchEvent(id: number | undefined | null): number | undefined {
    return Phone.REMATCH_EVENTS[id ?? -1];
  },

  // Lua: Phone.lua:1188-1197 -- the caller script's own setevent, as a seam.
  setRematchReady(events: any, id: number, value?: unknown): boolean {
    const flag = Phone.rematchEvent(id);
    if (!(flag !== undefined && truthy(events))) return false;
    events.set(flag, value !== false);
    return true;
  },

  // Lua: Phone.lua:1199-1203
  isReadyForRematch(events: any, id: number): boolean {
    const flag = Phone.rematchEvent(id);
    if (!(flag !== undefined && truthy(events))) return false;
    return truthy(events.get(flag));
  },

  // Lua: Phone.lua:1205-1222 -- Script_ReceivePhoneCall's tail. A special
  // call whose script did not run (`ranScript` unset) is cleared here so it
  // cannot ring forever.
  endCall(save: SaveLike, call: PhoneCall | undefined, ctx?: PhoneCtx): boolean {
    if (call && truthy(call.special) && call.special !== 0 && !truthy(call.ranScript)) {
      Phone.clearSpecialCall(save);
    }
    Phone.initReceiveDelay(save, ctx);
    return true;
  },
};

// Lua: Phone.lua:1131
Phone.checkPhoneCall = Phone.tryRandomCall;

export default Phone;
