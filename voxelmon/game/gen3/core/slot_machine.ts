// Port of gen1recomp src/core/game3/slot_machine.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/slot_machine.c:1
// The Game Corner slot machine's rules: reels, bias, stopping, payouts, coins.
//
// Port notes:
// - Brian builds most tables 0-based (zeroBased / rows: keys from 0), so they
//   are plain JS arrays whose slot 0 is used; linesForBet and PRE_STRIP are
//   Lua sequences (slot 0 unused).
// - Lazily required by the slot machine screen's callers: registers
//   G3Lazy["src.core.game3.slot_machine"] at the end.
// - pcall(require, "src.core.game3.bag"): Bag is in the bundle.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, len, type LuaTable } from "../platform/lt.ts";
import { tonumber, mod } from "../../../import/gen3/lua.ts";
import { G3Lazy } from "./lazy_registry.ts";
import Rng from "./rng.ts";
import Bag from "./bag.ts";

const NUM_REELS = 3;
const REEL_LENGTH = 21;
const NUM_MATCH_LINES = 5;

// pokefirered/src/slot_machine.c:51
const ICON = {
  SEVEN: 0,
  ROCKET: 1,
  PIKACHU: 2,
  PSYDUCK: 3,
  CHERRIES: 4,
  MAGNEMITE: 5,
  SHELLDER: 6,
};

// pokefirered/src/slot_machine.c:61
const PAYOUT = {
  NONE: 0,
  CHERRIES2: 1,
  CHERRIES3: 2,
  MAGSHELL: 3,
  PIKAPSY: 4,
  ROCKET: 5,
  SEVEN: 6,
};
const NUM_PAYOUT_TYPES = 7;
const NUM_MACHINE_CLASSES = 6;

// Lua: slot_machine.lua:40
function zeroBased<T>(list: T[]): T[] {
  // (the JS literal is already 0-based)
  return list.slice();
}

// Lua: slot_machine.lua:46
function rows(list: number[][]): number[][] {
  return list.map((r) => zeroBased(r));
}

// pokefirered/src/slot_machine.c:223
const SECOND_REEL_BIAS_CHECK = rows([
  [0x00, 0x03], [0x00, 0x06], [0x03, 0x06],
  [0x01, 0x04], [0x01, 0x07], [0x04, 0x07],
  [0x02, 0x05], [0x02, 0x08], [0x05, 0x08],
  [0x00, 0x04], [0x00, 0x08], [0x04, 0x08],
  [0x02, 0x04], [0x02, 0x06], [0x04, 0x06],
]);

// pokefirered/src/slot_machine.c:245
const THIRD_REEL_BIAS_CHECK = rows([
  [0x00, 0x03, 0x06],
  [0x01, 0x04, 0x07],
  [0x02, 0x05, 0x08],
  [0x00, 0x04, 0x08],
  [0x02, 0x04, 0x06],
]);

// pokefirered/src/slot_machine.c:72
const ROWATTR = { COL1POS: 0, COL2POS: 1, COL3POS: 2, MINBET: 3 };

// pokefirered/src/slot_machine.c:253
const ROW_ATTRIBUTES = rows([
  [0x00, 0x04, 0x08, 0x03],
  [0x00, 0x03, 0x06, 0x02],
  [0x01, 0x04, 0x07, 0x01],
  [0x02, 0x05, 0x08, 0x02],
  [0x02, 0x04, 0x06, 0x03],
]);

// pokefirered/src/slot_machine.c:261
const BIAS_CHANCES = rows([
  [0x1fa1, 0x2eab, 0x3630, 0x39f3, 0x3bd4, 0x3bfc, 0x0049],
  [0x1f97, 0x2ea2, 0x3627, 0x39e9, 0x3bca, 0x3bf8, 0x0049],
  [0x1f91, 0x2e9b, 0x3620, 0x39e3, 0x3bc4, 0x3bf4, 0x0049],
  [0x1f87, 0x2e92, 0x3617, 0x39d9, 0x3bba, 0x3bef, 0x0050],
  [0x1f7f, 0x2e89, 0x360e, 0x39d1, 0x3bb2, 0x3bea, 0x0050],
  [0x1fc9, 0x2efc, 0x3696, 0x3a63, 0x3c49, 0x3c8b, 0x0073],
]);

// pokefirered/src/slot_machine.c:318
const REELS = rows([
  [
    ICON.SEVEN, ICON.PSYDUCK, ICON.CHERRIES, ICON.ROCKET, ICON.PIKACHU,
    ICON.SHELLDER, ICON.PIKACHU, ICON.MAGNEMITE, ICON.SEVEN, ICON.SHELLDER,
    ICON.PSYDUCK, ICON.ROCKET, ICON.CHERRIES, ICON.PIKACHU, ICON.SHELLDER,
    ICON.SEVEN, ICON.MAGNEMITE, ICON.PIKACHU, ICON.ROCKET, ICON.SHELLDER,
    ICON.PIKACHU,
  ],
  [
    ICON.SEVEN, ICON.MAGNEMITE, ICON.CHERRIES, ICON.PSYDUCK, ICON.ROCKET,
    ICON.MAGNEMITE, ICON.CHERRIES, ICON.PSYDUCK, ICON.PIKACHU, ICON.MAGNEMITE,
    ICON.CHERRIES, ICON.PSYDUCK, ICON.SEVEN, ICON.MAGNEMITE, ICON.CHERRIES,
    ICON.ROCKET, ICON.PSYDUCK, ICON.SHELLDER, ICON.MAGNEMITE, ICON.PSYDUCK,
    ICON.CHERRIES,
  ],
  [
    ICON.SEVEN, ICON.PSYDUCK, ICON.SHELLDER, ICON.MAGNEMITE, ICON.PIKACHU,
    ICON.PSYDUCK, ICON.SHELLDER, ICON.MAGNEMITE, ICON.PIKACHU, ICON.PSYDUCK,
    ICON.MAGNEMITE, ICON.SHELLDER, ICON.PIKACHU, ICON.PSYDUCK, ICON.MAGNEMITE,
    ICON.SHELLDER, ICON.PIKACHU, ICON.PSYDUCK, ICON.MAGNEMITE, ICON.SHELLDER,
    ICON.ROCKET,
  ],
]);

// pokefirered/src/slot_machine.c:388
const PAYOUT_TABLE = zeroBased([0, 2, 6, 8, 15, 100, 300]);

// Lua: slot_machine.lua:133
// pokefirered/src/slot_machine.c:1361 (a Lua sequence, slot 0 unused)
const PRE_STRIP: (number | null)[] = seq<number>();
{
  // pokefirered/src/slot_machine.c:261
  const tail = BIAS_CHANCES[NUM_MACHINE_CLASSES - 1]!;
  let at = 1;
  for (let i = NUM_PAYOUT_TYPES - 1; i >= NUM_PAYOUT_TYPES - 2; i--) {
    PRE_STRIP[at] = Math.floor(tail[i]! / 256);
    PRE_STRIP[at + 1] = mod(tail[i]!, 256);
    at = at + 2;
  }
}

const NO_ICON = 7;

/** The slot machine's state (Brian's `st`); per-reel tables are 0-based. */
export interface SlotState {
  machineIdx: number;
  currentReel: number;
  bet: number;
  payout: number;
  machineBias: number;
  slotRewardClass: number;
  biasCooldown: number;
  reel2BiasInPlay: number;
  reelIsSpinning: boolean[];
  reelPositions: number[];
  reelSubpixel: number[];
  destReelPos: number[];
  reelStopOrder: number[];
  winFlags: boolean[];
  [k: string]: any;
}

// Lua: slot_machine.lua:208
function rng(): typeof Rng {
  return Rng;
}

// Lua: slot_machine.lua:285
// pokefirered/src/slot_machine.c:1333
function nextReelPosition(st: SlotState, reel: number): number {
  let pos = st.reelPositions[reel]!;
  if (st.reelSubpixel[reel] !== 0) {
    pos = pos - 1;
    if (pos < 0) pos = REEL_LENGTH - 1;
  }
  return pos;
}

// Lua: slot_machine.lua:296
// pokefirered/src/slot_machine.c:1495
function twoReelBiasCheck(reel0id: number, reel0posIn: number, reel1id: number, reel1posIn: number, icon: number): boolean {
  let reel0pos = reel0posIn, reel1pos = reel1posIn;
  const icons: number[] = [];
  for (let i = 0; i <= 8; i++) icons[i] = NO_ICON;
  for (let i = 0; i <= 2; i++) {
    icons[3 * reel0id + i] = SlotMachine.iconAt(reel0id, reel0pos);
    icons[3 * reel1id + i] = SlotMachine.iconAt(reel1id, reel1pos);
    reel0pos = reel0pos + 1;
    if (reel0pos >= REEL_LENGTH) reel0pos = 0;
    reel1pos = reel1pos + 1;
    if (reel1pos >= REEL_LENGTH) reel1pos = 0;
  }
  if (icon === 0) {
    for (let i = 0; i <= 2; i++) {
      if (SlotMachine.testIconAttribute(1, icons[i])) return false;
    }
    for (let i = 0; i <= 14; i++) {
      if (icons[SECOND_REEL_BIAS_CHECK[i]![0]!] === icons[SECOND_REEL_BIAS_CHECK[i]![1]!]) {
        return true;
      }
    }
    return false;
  } else if (icon === 1) {
    if (reel0id === 0 || reel1id === 0) {
      if (reel0id === 1 || reel1id === 1) {
        for (let i = 0; i <= 14; i += 3) {
          if (icons[SECOND_REEL_BIAS_CHECK[i]![0]!] === icons[SECOND_REEL_BIAS_CHECK[i]![1]!]) {
            return false;
          }
        }
      }
      for (let i = 0; i <= 2; i++) {
        if (SlotMachine.testIconAttribute(icon, icons[i])) return true;
      }
      return false;
    }
    return true;
  } else if (icon === 2) {
    if (reel0id === 2 || reel1id === 2) {
      for (let i = 0; i <= 8; i++) {
        if (SlotMachine.testIconAttribute(icon, icons[i])) return true;
      }
      return false;
    }
  }
  for (let i = 0; i <= 14; i++) {
    if (icons[SECOND_REEL_BIAS_CHECK[i]![0]!] === icons[SECOND_REEL_BIAS_CHECK[i]![1]!]
        && SlotMachine.testIconAttribute(icon, icons[SECOND_REEL_BIAS_CHECK[i]![0]!])) {
      return true;
    }
  }
  return false;
}

// Lua: slot_machine.lua:351
// pokefirered/src/slot_machine.c:1568
function oneReelBiasCheck(st: SlotState, reelId: number, reelPosIn: number, biasIcon: number): boolean {
  const icons: (number | undefined)[] = [];
  const firstId = st.reelStopOrder[0]!;
  const secondId = st.reelStopOrder[1]!;
  let firstPos = st.reelPositions[firstId]! + 1;
  let secondPos = st.reelPositions[secondId]! + 1;
  let reelPos = reelPosIn + 1;
  if (firstPos >= REEL_LENGTH) firstPos = 0;
  if (secondPos >= REEL_LENGTH) secondPos = 0;
  if (reelPos >= REEL_LENGTH) reelPos = 0;
  for (let i = 0; i <= 2; i++) {
    icons[firstId * 3 + i] = SlotMachine.iconAt(firstId, firstPos);
    icons[secondId * 3 + i] = SlotMachine.iconAt(secondId, secondPos);
    icons[reelId * 3 + i] = SlotMachine.iconAt(reelId, reelPos);
    firstPos = firstPos + 1;
    if (firstPos >= REEL_LENGTH) firstPos = 0;
    secondPos = secondPos + 1;
    if (secondPos >= REEL_LENGTH) secondPos = 0;
    reelPos = reelPos + 1;
    if (reelPos >= REEL_LENGTH) reelPos = 0;
  }
  if (biasIcon === PAYOUT.NONE) {
    for (let i = 0; i <= 2; i++) {
      if (SlotMachine.testIconAttribute(1, icons[i])) return false;
    }
    for (let i = 0; i <= NUM_MATCH_LINES - 1; i++) {
      const l = THIRD_REEL_BIAS_CHECK[i]!;
      if (icons[l[0]!] === icons[l[1]!] && icons[l[0]!] === icons[l[2]!]) return false;
    }
    return true;
  } else if (biasIcon === PAYOUT.CHERRIES2) {
    for (let i = 0; i <= NUM_MATCH_LINES - 1; i++) {
      const l = THIRD_REEL_BIAS_CHECK[i]!;
      if (icons[l[0]!] === icons[l[1]!] && SlotMachine.testIconAttribute(biasIcon, icons[l[0]!])) {
        return false;
      }
    }
    for (let i = 0; i <= 2; i++) {
      if (SlotMachine.testIconAttribute(biasIcon, icons[i])) return true;
    }
    return false;
  } else if (biasIcon === PAYOUT.CHERRIES3) {
    for (let i = 0; i <= NUM_MATCH_LINES - 1; i++) {
      const l = THIRD_REEL_BIAS_CHECK[i]!;
      if (icons[l[0]!] === icons[l[1]!] && SlotMachine.testIconAttribute(biasIcon, icons[l[0]!])) {
        return true;
      }
    }
    return false;
  }
  for (let i = 0; i <= NUM_MATCH_LINES - 1; i++) {
    const l = THIRD_REEL_BIAS_CHECK[i]!;
    if (icons[l[0]!] === icons[l[1]!] && icons[l[0]!] === icons[l[2]!]
        && SlotMachine.testIconAttribute(biasIcon, icons[l[0]!])) {
      return true;
    }
  }
  return false;
}

// Lua: slot_machine.lua:639
function coinsApi(): any {
  // pcall(require, "src.core.game3.bag")
  const B: any = Bag;
  const api = (B != null && typeof B === "object") ? B.Coins : undefined;
  if (api == null || typeof api !== "object") return undefined;
  return api;
}

/** pcall(f, ...) with the result dropped. */
function pcallDrop(f: (...a: any[]) => any, ...args: any[]): void {
  try { f(...args); } catch { /* pcall */ }
}

export const SlotMachine = {
  NUM_REELS,
  REEL_LENGTH,
  REEL_LOAD_LENGTH: 5,
  NUM_MATCH_LINES,
  MAX_BET: 3,
  ICON,
  PAYOUT,
  NUM_PAYOUT_TYPES,
  SECOND_REEL_BIAS_CHECK,
  NUM_SECOND_REEL_BIAS_CHECK: 15,
  THIRD_REEL_BIAS_CHECK,
  ROWATTR,
  ROW_ATTRIBUTES,
  BIAS_CHANCES,
  NUM_MACHINE_CLASSES,
  REELS,
  PAYOUT_TABLE,
  // pokefirered/src/field_specials.c:362
  MACHINE_CLASS_BY_ID: zeroBased([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5,
  ]),
  NUM_MACHINE_IDS: 22,
  // pokefirered/include/constants/game_stat.h:32
  GAME_STAT_SLOT_JACKPOTS: 28,

  // Lua: slot_machine.lua:155
  // pokefirered/src/slot_machine.c:318
  iconAt(reel: number, pos: number): number {
    const flat = reel * REEL_LENGTH + pos;
    if (flat < 0) {
      return PRE_STRIP[-flat] ?? NO_ICON;
    }
    const strip = REELS[Math.floor(flat / REEL_LENGTH)];
    if (!strip) return NO_ICON;
    return strip[mod(flat, REEL_LENGTH)]!;
  },

  // Lua: slot_machine.lua:166
  // pokefirered/src/slot_machine.c:1638
  testIconAttribute(attr: number, icon: number | undefined): boolean {
    if (attr === PAYOUT.NONE) {
      return icon !== ICON.CHERRIES;
    } else if (attr === PAYOUT.CHERRIES2 || attr === PAYOUT.CHERRIES3) {
      return icon === ICON.CHERRIES;
    } else if (attr === PAYOUT.MAGSHELL) {
      return icon === ICON.MAGNEMITE || icon === ICON.SHELLDER;
    } else if (attr === PAYOUT.PIKAPSY) {
      return icon === ICON.PIKACHU || icon === ICON.PSYDUCK;
    } else if (attr === PAYOUT.ROCKET) {
      return icon === ICON.ROCKET;
    } else if (attr === PAYOUT.SEVEN) {
      return icon === ICON.SEVEN;
    }
    return false;
  },

  // Lua: slot_machine.lua:184
  // pokefirered/src/slot_machine.c:1660
  iconToPayoutRank(icon: number | undefined): number {
    if (icon === ICON.MAGNEMITE || icon === ICON.SHELLDER) return PAYOUT.MAGSHELL;
    if (icon === ICON.PIKACHU || icon === ICON.PSYDUCK) return PAYOUT.PIKAPSY;
    if (icon === ICON.ROCKET) return PAYOUT.ROCKET;
    if (icon === ICON.SEVEN) return PAYOUT.SEVEN;
    return PAYOUT.CHERRIES2;
  },

  // Lua: slot_machine.lua:193
  // pokefirered/src/slot_machine.c:253
  linesForBet(betIn: any): LuaTable {
    const bet = Math.floor(tonumber(betIn) ?? 0);
    const out: LuaTable = seq<number>();
    for (let line = 0; line <= NUM_MATCH_LINES - 1; line++) {
      if (bet >= ROW_ATTRIBUTES[line]![ROWATTR.MINBET]!) {
        out[len(out) + 1] = line;
      }
    }
    return out;
  },

  // Lua: slot_machine.lua:204
  payoutFor(rank: number): number {
    return PAYOUT_TABLE[rank] ?? 0;
  },

  // Lua: slot_machine.lua:213
  // pokefirered/src/slot_machine.c:880
  newState(machineIdxIn?: any): SlotState {
    let machineIdx = Math.floor(tonumber(machineIdxIn) ?? 0);
    // pokefirered/src/slot_machine.c:871
    if (machineIdx < 0 || machineIdx >= NUM_MACHINE_CLASSES) machineIdx = 0;
    const st: SlotState = {
      machineIdx,
      currentReel: 0,
      bet: 0,
      payout: 0,
      machineBias: 0,
      slotRewardClass: 0,
      biasCooldown: 0,
      reel2BiasInPlay: 0,
      reelIsSpinning: [],
      reelPositions: [],
      reelSubpixel: [],
      destReelPos: [],
      reelStopOrder: [],
      winFlags: [],
    };
    for (let i = 0; i <= NUM_REELS - 1; i++) {
      st.reelIsSpinning[i] = false;
      st.reelPositions[i] = 0;
      st.reelSubpixel[i] = 0;
      st.destReelPos[i] = REEL_LENGTH;
      st.reelStopOrder[i] = 0;
    }
    for (let i = 0; i <= NUM_MATCH_LINES - 1; i++) {
      st.winFlags[i] = false;
    }
    return st;
  },

  // Lua: slot_machine.lua:247
  // pokefirered/src/slot_machine.c:1304
  startReels(st: SlotState): void {
    for (let i = 0; i <= NUM_REELS - 1; i++) {
      st.reelIsSpinning[i] = true;
    }
  },

  // Lua: slot_machine.lua:254
  // pokefirered/src/slot_machine.c:1328
  isReelSpinning(st: SlotState, reel: number): boolean {
    return st.reelIsSpinning[reel] ? true : false;
  },

  // Lua: slot_machine.lua:259
  // pokefirered/src/slot_machine.c:1274
  spinStep(st: SlotState): void {
    for (let i = 0; i <= NUM_REELS - 1; i++) {
      if (st.reelIsSpinning[i] || st.reelSubpixel[i] !== 0) {
        let settled = true;
        if (st.reelSubpixel[i] !== 0 || st.reelPositions[i] !== st.destReelPos[i]) {
          st.reelSubpixel[i] = st.reelSubpixel[i]! + 1;
          if (st.reelSubpixel[i]! > 2) {
            st.reelSubpixel[i] = 0;
            st.reelPositions[i] = st.reelPositions[i]! - 1;
            if (st.reelPositions[i]! < 0) {
              st.reelPositions[i] = REEL_LENGTH - 1;
            }
          }
          if (st.reelPositions[i] !== st.destReelPos[i]) {
            settled = false;
          }
        }
        if (settled) {
          st.destReelPos[i] = REEL_LENGTH;
          st.reelIsSpinning[i] = false;
        }
      }
    }
  },

  // Lua: slot_machine.lua:293
  nextReelPosition,
  // Lua: slot_machine.lua:348
  twoReelBiasCheck,
  // Lua: slot_machine.lua:410
  oneReelBiasCheck,

  // Lua: slot_machine.lua:413
  // pokefirered/src/slot_machine.c:1345
  stopReel1(st: SlotState, whichReel: number): void {
    const nextPos = nextReelPosition(st, whichReel);
    const posToSample: number[] = [];
    let numPosToSample = 0;
    let destPos: number;
    if (st.machineBias === 0 && whichReel === 0) {
      for (let i = 0; i <= 4; i++) {
        let j = 0;
        destPos = nextPos - i + 1;
        while (j < 3) {
          if (destPos >= REEL_LENGTH) destPos = 0;
          if (SlotMachine.testIconAttribute(1, SlotMachine.iconAt(whichReel, destPos))) break;
          j = j + 1;
          destPos = destPos + 1;
        }
        if (j === 3) {
          posToSample[numPosToSample] = i;
          numPosToSample = numPosToSample + 1;
        }
      }
    } else if (st.machineBias !== 1 || whichReel === 0) {
      destPos = nextPos + 1;
      for (let k = 0; k <= 2; k++) {
        if (destPos >= REEL_LENGTH) destPos = 0;
        if (SlotMachine.testIconAttribute(st.machineBias, SlotMachine.iconAt(whichReel, destPos))) {
          posToSample[0] = 0;
          numPosToSample = 1;
          break;
        }
        destPos = destPos + 1;
      }
      destPos = nextPos;
      for (let i = 0; i <= 3; i++) {
        if (destPos < 0) destPos = REEL_LENGTH - 1;
        if (SlotMachine.testIconAttribute(st.machineBias, SlotMachine.iconAt(whichReel, destPos))) {
          posToSample[numPosToSample] = i + 1;
          numPosToSample = numPosToSample + 1;
        }
        destPos = destPos - 1;
      }
    }
    if (numPosToSample === 0) {
      destPos = mod(rng().Random(), 5);
    } else {
      destPos = posToSample[mod(rng().Random(), numPosToSample)]!;
    }
    destPos = nextPos - destPos;
    if (destPos < 0) destPos = destPos + REEL_LENGTH;
    st.reelStopOrder[0] = whichReel;
    st.destReelPos[whichReel] = destPos;
  },

  // Lua: slot_machine.lua:466
  // pokefirered/src/slot_machine.c:1410
  stopReel2(st: SlotState, whichReel: number): void {
    const firstId = st.reelStopOrder[0]!;
    let firstPos = st.reelPositions[firstId]! + 1;
    if (firstPos >= REEL_LENGTH) firstPos = 0;
    const nextPos = nextReelPosition(st, whichReel);
    let pos = nextPos + 1;
    if (pos >= REEL_LENGTH) pos = 0;
    const possible: number[] = [];
    let num = 0;
    for (let i = 0; i <= 4; i++) {
      if (twoReelBiasCheck(firstId, firstPos, whichReel, pos, st.machineBias)) {
        possible[num] = i;
        num = num + 1;
      }
      pos = pos - 1;
      if (pos < 0) pos = REEL_LENGTH - 1;
    }
    if (num === 0) {
      st.reel2BiasInPlay = 0;
      if (st.machineBias === PAYOUT.ROCKET || st.machineBias === PAYOUT.SEVEN) {
        pos = 4;
      } else {
        pos = 0;
      }
    } else {
      st.reel2BiasInPlay = 1;
      pos = possible[0]!;
    }
    pos = nextPos - pos;
    if (pos < 0) pos = pos + REEL_LENGTH;
    st.reelStopOrder[1] = whichReel;
    st.destReelPos[whichReel] = pos;
  },

  // Lua: slot_machine.lua:501
  // pokefirered/src/slot_machine.c:1457
  stopReel3(st: SlotState, whichReel: number): void {
    const nextPos = nextReelPosition(st, whichReel);
    let testPos = nextPos;
    const possible: number[] = [];
    let num = 0;
    for (let i = 0; i <= 4; i++) {
      if (oneReelBiasCheck(st, whichReel, testPos, st.machineBias)) {
        possible[num] = i;
        num = num + 1;
      }
      testPos = testPos - 1;
      if (testPos < 0) testPos = 20;
    }
    let pos: number;
    if (num === 0) {
      if (st.machineBias === PAYOUT.ROCKET || st.machineBias === PAYOUT.SEVEN) {
        pos = 4;
      } else {
        pos = 0;
      }
    } else {
      pos = possible[0]!;
    }
    pos = nextPos - pos;
    if (pos < 0) pos = pos + REEL_LENGTH;
    st.destReelPos[whichReel] = pos;
  },

  // Lua: slot_machine.lua:530
  // pokefirered/src/slot_machine.c:1312
  stopCurrentReel(st: SlotState, whichReel: number, whichReel2: number): void {
    if (whichReel2 === 0) {
      SlotMachine.stopReel1(st, whichReel);
    } else if (whichReel2 === 1) {
      SlotMachine.stopReel2(st, whichReel);
    } else if (whichReel2 === 2) {
      SlotMachine.stopReel3(st, whichReel);
    }
  },

  // Lua: slot_machine.lua:541
  // pokefirered/src/slot_machine.c:1680
  calcBias(st: SlotState): number {
    const R = rng();
    const rval = Math.floor(R.Random() / 4);
    const chances = BIAS_CHANCES[st.machineIdx] ?? BIAS_CHANCES[0]!;
    let i = 0;
    while (i < NUM_PAYOUT_TYPES - 1) {
      if (rval < chances[i]!) break;
      i = i + 1;
    }
    if (st.machineBias < PAYOUT.ROCKET) {
      if (st.biasCooldown === 0) {
        if (mod(R.Random(), 0x4000) < chances[PAYOUT.SEVEN]!) {
          st.biasCooldown = (mod(R.Random(), 2) === 1) ? 5 : 60;
        }
      }
      if (st.biasCooldown !== 0) {
        if (i === 0 && mod(R.Random(), 0x4000) < Math.floor(0.7 * 0x3FFF)) {
          st.biasCooldown = (mod(R.Random(), 2) === 1) ? 5 : 60;
        }
        st.biasCooldown = st.biasCooldown - 1;
      }
      st.machineBias = i;
    }
    return st.machineBias;
  },

  // Lua: slot_machine.lua:568
  // pokefirered/src/slot_machine.c:1707
  resetBias(st: SlotState): void {
    st.machineBias = 0;
  },

  // Lua: slot_machine.lua:573
  // pokefirered/src/slot_machine.c:1712
  visibleIcons(st: SlotState): number[] {
    const icons: number[] = [];
    const pos: number[] = [st.reelPositions[0]!, st.reelPositions[1]!, st.reelPositions[2]!];
    for (let i = 0; i <= 2; i++) {
      for (let reel = 0; reel <= NUM_REELS - 1; reel++) {
        pos[reel] = pos[reel]! + 1;
        if (pos[reel]! >= REEL_LENGTH) pos[reel] = 0;
        icons[reel * 3 + i] = SlotMachine.iconAt(reel, pos[reel]!);
      }
    }
    return icons;
  },

  // Lua: slot_machine.lua:587
  // pokefirered/src/slot_machine.c:1712
  calcPayout(st: SlotState): number {
    for (let i = 0; i <= NUM_MATCH_LINES - 1; i++) {
      st.winFlags[i] = false;
    }
    const icons = SlotMachine.visibleIcons(st);
    let bestMatch = 0;
    st.payout = 0;
    for (let i = 0; i <= NUM_MATCH_LINES - 1; i++) {
      const attr = ROW_ATTRIBUTES[i]!;
      if (st.bet >= attr[ROWATTR.MINBET]!) {
        const c1 = icons[attr[ROWATTR.COL1POS]!];
        const c2 = icons[attr[ROWATTR.COL2POS]!];
        const c3 = icons[attr[ROWATTR.COL3POS]!];
        let curMatch: number;
        if (SlotMachine.testIconAttribute(1, c1)) {
          curMatch = SlotMachine.testIconAttribute(2, c2) ? 2 : 1;
        } else if (c1 === c2 && c1 === c3) {
          curMatch = SlotMachine.iconToPayoutRank(c1);
        } else {
          curMatch = 0;
        }
        if (curMatch !== 0) {
          st.winFlags[i] = true;
          st.payout = st.payout + (PAYOUT_TABLE[curMatch] ?? 0);
        }
        if (curMatch > bestMatch) bestMatch = curMatch;
      }
    }
    st.slotRewardClass = bestMatch;
    return bestMatch;
  },

  // Lua: slot_machine.lua:620
  // pokefirered/src/overworld.c:379
  gameStat(session: any, statIdIn: any): number {
    const statId = tonumber(statIdIn);
    if (session == null || typeof session !== "object" || statId == null) return 0;
    const stats = session.gameStats;
    if (stats == null || typeof stats !== "object") return 0;
    return Math.floor(tonumber(stats[statId]) ?? 0);
  },

  // Lua: slot_machine.lua:629
  // pokefirered/src/overworld.c:366
  incrementGameStat(session: any, statIdIn: any): number {
    const statId = tonumber(statIdIn);
    if (session == null || typeof session !== "object" || statId == null) return 0;
    if (session.gameStats == null || typeof session.gameStats !== "object") session.gameStats = {};
    let value = SlotMachine.gameStat(session, statId);
    if (value < 0xFFFFFF) value = value + 1; else value = 0xFFFFFF;
    session.gameStats[statId] = value;
    return value;
  },

  // Lua: slot_machine.lua:646
  coins(session: any): number {
    const api = coinsApi();
    if (api && api.get) {
      let ok = true, n: any;
      try { n = api.get(session); } catch { ok = false; }
      if (ok && tonumber(n) != null) return tonumber(n)!;
    }
    const raw = Math.floor(tonumber(session ? session.coins : undefined) ?? 0);
    return raw < 0 ? 0 : raw;
  },

  // Lua: slot_machine.lua:657
  // pokefirered/src/slot_machine.c:960
  betOne(st: SlotState, session: any): boolean {
    if (SlotMachine.coins(session) === 0) return false;
    const api = coinsApi();
    st.bet = st.bet + 1;
    if (api && api.remove) pcallDrop(api.remove, session, 1);
    return true;
  },

  // Lua: slot_machine.lua:666
  // pokefirered/src/slot_machine.c:969
  betMax(st: SlotState, session: any): boolean {
    const api = coinsApi();
    const coins = SlotMachine.coins(session);
    if (coins === 0) return false;
    const toAdd = SlotMachine.MAX_BET - st.bet;
    if (coins >= toAdd) {
      st.bet = SlotMachine.MAX_BET;
      if (api && api.remove) pcallDrop(api.remove, session, toAdd);
    } else {
      st.bet = st.bet + coins;
      if (api && api.set) pcallDrop(api.set, session, 0);
    }
    return true;
  },

  // Lua: slot_machine.lua:682
  // pokefirered/src/slot_machine.c:1120
  refundBet(st: SlotState, session: any): void {
    const api = coinsApi();
    if (st.bet > 0 && api && api.add) {
      pcallDrop(api.add, session, st.bet);
    }
    st.bet = 0;
  },

  // Lua: slot_machine.lua:691
  // pokefirered/src/slot_machine.c:1213
  payCoin(st: SlotState, session: any): boolean {
    if (st.payout <= 0) return false;
    const api = coinsApi();
    if (api && api.add) pcallDrop(api.add, session, 1);
    st.payout = st.payout - 1;
    return true;
  },

  // Lua: slot_machine.lua:700
  // pokefirered/src/slot_machine.c:1201
  payAll(st: SlotState, session: any): boolean {
    if (st.payout <= 0) return false;
    const api = coinsApi();
    if (api && api.add) pcallDrop(api.add, session, st.payout);
    st.payout = 0;
    return true;
  },
};

export default SlotMachine;

G3Lazy["src.core.game3.slot_machine"] = SlotMachine;
