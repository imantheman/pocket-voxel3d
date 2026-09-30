// Ports gen1recomp src/core/gen2/TradeAnim.lua at bdfac727 (MIT).
//
// The in-game trade animation's script and clock (engine/movie/
// trade_animation.asm TradeAnimation), run between DoNPCTrade and
// TradedForText. Love-free in the Lua too: the drawing half is
// ui/TradeAnim.ts (ported with the screens). Nothing about the trade's
// outcome depends on this, so the screen can be skipped.
//
// The cart's byte script runs one command per frame; setup commands cost no
// frames, so the script flattens to the WAITS below with each setup folded
// into the `cue` of the beat that follows it (e.g. Poof's 16 frames overlap
// `tube_in`; RockingBall's 64 are spent by `ball_rock`). Frame counts are the
// cart's. Only the player-1 script (TradeAnimationPlayer2 is cable club).
//
// Multiple returns become tuples: beatAt -> [beat, offset, index] (index is
// the Lua's 1-based beat index), tubeIcon -> [x, y], records -> [give, get].

import { tonumber } from "../platform/lua.ts";

export interface TradeBeat {
  id: string;
  frames: number;
  cue?: string;
}

export interface TradeRecord {
  species: any;
  name: any;
  dex: number;
  senderName?: any;
  otName?: any;
  id?: any;
  shiny?: any;
  dvs?: any;
  unownLetter?: any;
}

// Scroll steps, in pixels per frame: DoGivemonScroll / EnterLinkTube2 /
// ExitLinkTube move 4 a frame; the two Game Boy pans move hSCX 2 a frame.
const SCROLL_STEP = 4;
const PAN_STEP = 2;

// Lua: TradeAnim.lua:64 -- `frames` is how long the beat holds, `cue` fires
// on its first frame. The pans are one beat per hSCX target ($50, $a0) because
// the cart stops there to swap the tilemap.
const SCRIPT: TradeBeat[] = [
  // ShowGivemonData, then TradeAnim_DoGivemonScroll's $88 at 4 a frame.
  { id: "givemon_scroll", frames: 34, cue: "show_give" },
  { id: "givemon_hold", frames: 80 },
  // Poof, RockingBall, EnterLinkTube1: the mon becomes a ball, the cable slides in.
  { id: "tube_in", frames: 40, cue: "poof" },
  // EnterLinkTube2's `ld c, 80 / call DelayFrames` once hSCX is home.
  { id: "tube_hold", frames: 80 },
  // The WaitAnim spending RockingBall's 64.
  { id: "ball_rock", frames: 64 },
  { id: "bulge", frames: 128, cue: "bulge" },
  // GiveTrademonSFX, then TubeToOT2/3/4.
  { id: "send_pan_a", frames: 40, cue: "give_sfx" },
  { id: "send_pan_b", frames: 40 },
  { id: "send_pan_c", frames: 48 },
  // TubeToOT5 spends the 92 TubeToOT1 set, TubeToOT6/7 the 128 after it.
  { id: "send_wait", frames: 92 },
  { id: "send_hold", frames: 128 },
  // SentToOTText: the empty _MonNameSentToText holds an open box for 189
  // frames before the line itself, which then gets 80 + 128.
  { id: "sent_blank", frames: 189, cue: "clear" },
  { id: "sent_text", frames: 208 },
  // OTSendsText1's two pages, the second carrying its trailing `ld c, 14`.
  { id: "ot_sends_a", frames: 80 },
  { id: "ot_sends_b", frames: 94 },
  // OTBidsFarewell's two.
  { id: "farewell_a", frames: 80 },
  { id: "farewell_b", frames: 80 },
  // GetTrademonSFX, then TubeToPlayer2 waits its 92 BEFORE the pan.
  { id: "get_wait", frames: 92, cue: "get_sfx" },
  { id: "get_pan_a", frames: 40 },
  { id: "get_pan_b", frames: 40 },
  { id: "get_pan_c", frames: 48 },
  { id: "get_hold", frames: 128 },
  // EnterLinkTube again, then DropBall / ExitLinkTube.
  { id: "tube_in2", frames: 40, cue: "tube" },
  { id: "tube_hold2", frames: 80 },
  { id: "tube_out", frames: 40, cue: "drop" },
  { id: "ball_wait", frames: 56 },
  // ShowGetmonData, then Poof's 16.
  { id: "getmon_poof", frames: 16, cue: "show_get" },
  // FrontpicScrollStart brings the stats window back up for Wait80.
  { id: "getmon_hold", frames: 80 },
  { id: "take_care", frames: 80 },
];

// Lua: TradeAnim.lua:115 -- the unrolled pan position a beat starts at, and
// its direction: the send pans forward, the get pans back (TubeToPlayer3/4/5
// SUBTRACT 2 a frame from the wrap).
const PAN: Record<string, { base: number; step: number }> = {
  send_pan_a: { base: 0x00, step: PAN_STEP },
  send_pan_b: { base: 0x50, step: PAN_STEP },
  send_pan_c: { base: 0xa0, step: PAN_STEP },
  send_wait: { base: 0x100, step: 0 },
  send_hold: { base: 0x100, step: 0 },
  get_wait: { base: 0x100, step: 0 },
  get_pan_a: { base: 0x100, step: -PAN_STEP },
  get_pan_b: { base: 0xb0, step: -PAN_STEP },
  get_pan_c: { base: 0x60, step: -PAN_STEP },
  get_hold: { base: 0x00, step: 0 },
};

// Lua: TradeAnim.lua:204 -- the trademon object's two ends in screen pixels:
// TubeToOT1's `depixel 5, 11, 4, 0` and TubeToPlayer1's `depixel 9, 18, 4, 4`.
const ICON_NEAR_X = 80;
const ICON_NEAR_Y = 28;
const ICON_FAR_X = 140;
const ICON_FAR_Y = 60;
// .MoveRight's `cp $94` / .MoveLeft's `cp $58`, .MoveDown's `cp $4c` /
// .MoveUp's `cp $2c`, one pixel a frame.
const ICON_RUN = ICON_FAR_X - ICON_NEAR_X;
const ICON_DROP = ICON_FAR_Y - ICON_NEAR_Y;

// .WaitTimer1 and .WaitTimer2 hold it still for their $80 apiece.
const ICON_PARKED: Record<string, boolean> = {
  send_pan_a: true, send_pan_b: true, send_pan_c: true,
  get_pan_a: true, get_pan_b: true, get_pan_c: true,
};

// Lua: TradeAnim.lua:140
let TOTAL = 0;
for (const beat of SCRIPT) TOTAL = TOTAL + beat.frames;

export const TradeAnim = {
  SCROLL_STEP,
  PAN_STEP,
  // hSCX starts at $88 for the frontpic scroll and hWX at $8f: both $88 from home.
  GIVEMON_SCROLL: 0x88,
  // The link tube enters and leaves across $a0.
  TUBE_SCROLL: 0xa0,
  // The Game Boy pan is a full wrap of the 256-pixel BG map (0 -> $50 -> $a0 -> $100).
  PAN_TOTAL: 0x100,
  SCRIPT,
  // Lua: TradeAnim.lua:131 -- beats that print a line and the label each prints
  // (`sent_blank` is the empty _MonNameSentToText: an open box and nothing else).
  TEXT: {
    sent_text: "_MonWasSentToText",
    ot_sends_a: "_ForYourMonSendsText",
    ot_sends_b: "_OTSendsText",
    farewell_a: "_BidsFarewellToMonText",
    farewell_b: "_MonNameBidsFarewellText",
    take_care: "_TakeGoodCareOfMonText",
  } as Record<string, string>,
  TOTAL,

  // Lua: TradeAnim.lua:148 -- the beat a 0-based frame lands in, the offset
  // into it, and its 1-based index. Past the end answers the last beat.
  beatAt(frame: any): [TradeBeat, number, number] {
    const f = Math.max(0, Math.floor(tonumber(frame) ?? 0));
    let start = 0;
    for (let i = 0; i < SCRIPT.length; i++) {
      const beat = SCRIPT[i]!;
      if (f < start + beat.frames) {
        return [beat, f - start, i + 1];
      }
      start = start + beat.frames;
    }
    const last = SCRIPT[SCRIPT.length - 1]!;
    return [last, last.frames, SCRIPT.length];
  },

  // Lua: TradeAnim.lua:163 -- the frame a beat starts on.
  startOf(id: string): number | undefined {
    let start = 0;
    for (const beat of SCRIPT) {
      if (beat.id === id) return start;
      start = start + beat.frames;
    }
    return undefined;
  },

  // Lua: TradeAnim.lua:174 -- hSCX during the give-mon panel's scroll home.
  givemonOffset(t: number): number {
    return Math.max(0, TradeAnim.GIVEMON_SCROLL - TradeAnim.SCROLL_STEP * t);
  },

  // Lua: TradeAnim.lua:182 -- hSCX for the link tube: closes from $a0 entering,
  // opens back to $a0 on `tube_out`. The tube's tilemap is at hlcoord 8, 2 and
  // the drawing side subtracts this (positive SCX moves the picture LEFT).
  tubeOffset(id: string, t: number): number {
    const step = TradeAnim.SCROLL_STEP * t;
    if (id === "tube_out") {
      return Math.min(TradeAnim.TUBE_SCROLL, step);
    }
    return Math.max(0, TradeAnim.TUBE_SCROLL - step);
  },

  // Lua: TradeAnim.lua:193 -- how far along the 256-pixel scene the window is,
  // unrolled (0 = player's Game Boy); undefined for a beat that is not a pan.
  pan(id: string, t: any): number | undefined {
    const row = PAN[id];
    if (!row) return undefined;
    const value = row.base + row.step * (tonumber(t) ?? 0);
    if (value < 0) return 0;
    if (value > TradeAnim.PAN_TOTAL) return TradeAnim.PAN_TOTAL;
    return value;
  },

  // Lua: TradeAnim.lua:219 -- TradeAnim_AnimateTrademonInTube's icon position
  // on a pan beat, or undefined once SPRITEANIMSTRUCT_INDEX is zeroed.
  tubeIcon(id: string, t: any): [number, number] | undefined {
    const tt = Math.max(0, Math.floor(tonumber(t) ?? 0));
    if (ICON_PARKED[id]) return [ICON_NEAR_X, ICON_NEAR_Y];
    if (id === "send_wait") {
      const run = Math.min(ICON_RUN, tt);
      const drop = Math.min(ICON_DROP, Math.max(0, tt - ICON_RUN));
      return [ICON_NEAR_X + run, ICON_NEAR_Y + drop];
    }
    if (id === "get_wait") {
      const drop = Math.min(ICON_DROP, tt);
      const run = Math.min(ICON_RUN, Math.max(0, tt - ICON_DROP));
      return [ICON_FAR_X - run, ICON_FAR_Y - drop];
    }
    return undefined;
  },

  // Lua: TradeAnim.lua:241 -- the two trademon records TradeAnimation reads,
  // built the way DoNPCTrade fills them, from NpcTrade.perform's [given, received].
  records(data: any, save: any, row: any, given: any, received: any): [TradeRecord, TradeRecord] {
    // Lua `or` falls through only on nil/false, so `??` (not `||`) below.
    const pokemon = (data && data.pokemon) ?? {};
    const player = (save && save.player) ?? {};
    const speciesOf = (id: any): TradeRecord => {
      const def = id != null ? pokemon[id] : undefined;
      return {
        species: id,
        name: def?.name ?? id ?? "?",
        dex: def?.dex ?? 0,
      };
    };
    const give = speciesOf(given?.species);
    const get = speciesOf(received?.species ?? row?.get);
    give.senderName = player.name ?? "GOLD";
    give.otName = (given ? given.otName ?? given.ot : undefined) ?? give.senderName;
    give.id = given?.otId ?? player.id ?? 0;
    give.shiny = given?.shiny ?? false;
    // The DVs ride along because TradeAnim_GetFrontpic runs GetUnownLetter
    // first (trade_animation.asm:795-804); unownLetter too (Unown.monLetter
    // prefers the stored form).
    give.dvs = given?.dvs;
    give.unownLetter = given?.unownLetter;
    get.senderName = row?.otName ?? received?.otName ?? "?";
    get.otName = get.senderName;
    get.id = received?.otId ?? row?.otId ?? 0;
    get.shiny = received?.shiny ?? false;
    get.dvs = received?.dvs;
    get.unownLetter = received?.unownLetter;
    return [give, get];
  },
};

export default TradeAnim;
