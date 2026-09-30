// Yellow's Surfing Pikachu minigame (voxelmon/game/minigame/surfing.ts), a
// line-by-line port of pokeyellow's engine/minigame/surfing_pikachu.asm.
// Runs on synthesized tilemaps -- nothing ROM-derived here.
import { describe, expect, test } from "bun:test";
import { renderGb } from "../voxelmon/game/gb/video.ts";
import { PIKACHU_STATE, SurfingMinigame, SurfingPikachu_Sine, type SurfingIo, type SurfingTilemaps } from "../voxelmon/game/minigame/surfing.ts";
import {
  SineWave,
  SurfingMinigame_BGMetatileTable,
  SurfingMinigameBeachPattern,
  SurfingMinigameWavePatterns,
  WaveFunctions,
} from "../voxelmon/game/minigame/surfing-data.ts";

const PAD_A = 1;
const PAD_SELECT = 4;
const PAD_LEFT = 32;

interface TestIo extends SurfingIo {
  sfx: string[];
  music: string[];
  clips: number[];
  tempos: number[];
  hiScores: number[];
}

function makeIo(over: Partial<SurfingIo> = {}): TestIo {
  let seed = 12345;
  const io: TestIo = {
    sfx: [],
    music: [],
    clips: [],
    tempos: [],
    hiScores: [],
    random() {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed >>> 16) & 0xff;
    },
    playMusic(label) {
      io.music.push(label);
    },
    stopMusic() {},
    playSfx(name) {
      io.sfx.push(name);
    },
    pikaClip(n) {
      io.clips.push(n);
    },
    musicTempo(t) {
      io.tempos.push(t);
    },
    surfingPikachuInParty: true,
    selectQuits: false,
    hiScore: 0,
    setHiScore(bcd) {
      io.hiScores.push(bcd);
    },
    ...over,
  };
  return io;
}

function tilemaps(): SurfingTilemaps {
  const fill = (n: number, base: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (base + i) & 0xff);
  return {
    beachIntro: fill(240, 0x80),
    beachOutro: fill(200, 0x40),
    title: fill(72, 0xa0),
    useControlPad: fill(15, 0xe0),
    toSurfRad: fill(13, 0xf0),
  };
}

/** Frames until `cond`, at most `max`; returns the count. */
function runUntil(m: SurfingMinigame, cond: () => boolean, max = 20000, held = 0): number {
  let n = 0;
  while (!cond()) {
    if (n++ >= max) throw new Error("condition never met");
    m.frame(held, 0);
  }
  return n;
}

/** The 18-row column a redraw writes from 36 source bytes. */
function expandColumn(pattern: readonly number[]): number[] {
  const out: number[] = [];
  for (const mt of pattern) out.push(...SurfingMinigame_BGMetatileTable[mt]!);
  return out;
}

function decBcd(lo: number, hi: number): number {
  const d = (b: number): number => (b >> 4) * 10 + (b & 15);
  return d(hi) * 100 + d(lo);
}

describe("surfing pikachu: tables", () => {
  test("the sine table is sine_table 32 under -Q8", () => {
    for (let x = 0; x < 32; x++) expect(SineWave[x]).toBe(Math.round(Math.sin((2 * Math.PI * x) / 64) * 256));
    expect(SurfingPikachu_Sine(16, 0x10)).toBe(0x10);
    expect(SurfingPikachu_Sine(48, 0x10)).toBe(0xf0); // -$10
    expect(SurfingPikachu_Sine(0, 0x80)).toBe(0);
  });

  test("the wave jumptable has its 124 states", () => {
    expect(WaveFunctions.length).toBe(0x7c);
    expect(WaveFunctions[0]!.kind).toBe("choose");
    const f71 = WaveFunctions[0x71]!;
    expect(f71.kind === "load" && f71.then).toBe("stay");
    const f7b = WaveFunctions[0x7b]!;
    expect(f7b.kind === "load" && f7b.pattern).toBe(SurfingMinigameBeachPattern);
  });
});

describe("surfing pikachu: intro", () => {
  test("the intro runs, then hands over to the game", () => {
    const io = makeIo();
    const m = new SurfingMinigame(io, tilemaps());
    // SurfingPikachuMinigame: BlankPals, three DelayFrames
    for (let i = 0; i < 3; i++) expect(m.frame(0, 0)).toBe(true);
    expect(m.video.bgp).toBe(0);
    // the intro: LCD on, three DelayFrames, pals, a DelayFrame, the music
    for (let i = 0; i < 3; i++) m.frame(0, 0);
    expect(m.video.lcdc & 0x80).toBe(0x80);
    expect(m.video.loads.some((l) => l.sheet === "surf_1c" && l.dest === 128 && l.count === 144)).toBe(true);
    // the tilemap reached vBGMap0 a third at a time
    expect(m.video.maps[6 * 32]).toBe(0x80); // beach intro at (0, 6)
    expect(m.video.maps[0 * 32 + 4]).toBe(0xa0); // title at (4, 0)
    expect(m.video.maps[7 * 32 + 3]).toBe(0xe0); // "use control pad" at (3, 7)
    expect(io.music).toEqual([]);
    m.frame(0, 0);
    expect(m.video.bgp).toBe(0xe4); // SGB branch
    expect(m.video.obp1).toBe(0xe0);
    m.frame(0, 0);
    expect(io.music).toEqual(["Music_SurfingPikachu"]);
    const x0 = m.video.oam[1]!;
    for (let i = 0; i < 20; i++) m.frame(0, 0);
    expect(m.video.oam[1]!).toBe((x0 + 10) & 0xff); // one pixel every other frame
    // the intro Pikachu leaves at X $c0: 104 steps, the 105th odd frame ends it
    let n = 8 + 20;
    while (m.wSurfingMinigameRoutineNumber === 0 || m.video.loads.every((l) => l.sheet !== "surf_1b")) {
      m.frame(0, 0);
      n++;
      if (n > 1000) throw new Error("intro never ended");
    }
    // 3 + 3 + 1 DelayFrames, 210 intro loops, LoadGFXAndLayout's DelayFrame,
    // then the loop's first pass runs StartGame
    expect(n).toBe(3 + 3 + 1 + 210 + 1 + 1);
    expect(m.wSurfingMinigameRoutineNumber).toBe(1);
    expect(m.video.colours.obj1).toBe("PIKACHUS_BEACH");
    expect(m.video.lineTarget).toBe("scy");
    expect(m.video.wy).toBe(0x7e);
    // the HP digits: "0000" as laid out, then DrawHP's first 5999
    const digits = (): number[] => Array.from(m.video.oam.slice(0, 16)).filter((_, i) => i % 4 === 2);
    expect(digits()).toEqual([0xd0, 0xd0, 0xd0, 0xd0]);
    m.frame(0, 0);
    expect(digits()).toEqual([0xd5, 0xd9, 0xd9, 0xd9]);
  });
});

describe("surfing pikachu: the course", () => {
  test("generated BG columns follow the wave patterns and metatiles", () => {
    const m = new SurfingMinigame(makeIo(), tilemaps());
    runUntil(m, () => m.wSurfingMinigameRoutineNumber === 1);
    // straight through GenerateBGMap: the Big Kahuna's first slice
    m.wSurfingMinigameWaveFunctionNumber = 0x6a;
    m.hSCX = 0x13;
    m.wSurfingMinigameSCX2 = 0;
    m.wSurfingMinigameSCXHi = 0;
    m.wSurfingMinigameXOffset = 0xa0;
    const before = Array.from(m.wSurfingMinigameWaveHeight);
    m.SurfingMinigame_GenerateBGMap();
    expect(Array.from(m.wRedrawRowOrColumnSrcTiles.slice(0, 32))).toEqual(expandColumn(SurfingMinigameWavePatterns[1]!));
    expect(m.hRedrawRowOrColumnDest).toBe(0x9800 + (((0x13 + 0xa0) & 0xf0) >> 3));
    expect(m.hRedrawRowOrColumnMode).toBe(1);
    expect(m.wSurfingMinigameWaveFunctionNumber).toBe(0x6b);
    expect(Array.from(m.wSurfingMinigameWaveHeight)).toEqual([...before.slice(2), 0x74, 0x74 - 8]);
    // the same SCX again does nothing
    m.hRedrawRowOrColumnMode = 0;
    m.SurfingMinigame_GenerateBGMap();
    expect(m.hRedrawRowOrColumnMode).toBe(0);

    // and in play: the column each VBlank drew is the metatile expansion of a pattern
    const known = [...SurfingMinigameWavePatterns, SurfingMinigameBeachPattern].map((p) => expandColumn(p).join());
    let checked = 0;
    let waves = 0;
    let lastDest = m.hRedrawRowOrColumnDest - 0x9800; // the hand-made request above was never drawn
    for (let f = 0; f < 1500 && m.wSurfingMinigameRoutineNumber === 1; f++) {
      m.frame(0, 0);
      const dest = m.hRedrawRowOrColumnDest - 0x9800;
      if (dest === lastDest) continue;
      lastDest = dest;
      const col: number[] = [];
      for (let r = 0; r < 16; r++) col.push(m.video.maps[r * 32 + dest]!, m.video.maps[r * 32 + dest + 1]!);
      expect(known).toContain(col.join());
      if (col.join() !== expandColumn(SurfingMinigameWavePatterns[0]!).join()) waves++;
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    expect(waves).toBeGreaterThan(0);
  });

  test("a wave crest launches Pikachu into JUMPING and the arc comes back to the water", () => {
    const io = makeIo();
    const m = new SurfingMinigame(io, tilemaps());
    runUntil(m, () => m.wSurfingMinigameRoutineNumber === 1);
    runUntil(m, () => m.wSurfingMinigamePikachuState === PIKACHU_STATE.JUMPING);
    expect(io.sfx).toContain("Surfing_Jump");
    expect(m.wSurfingMinigameJumpArcMagnitude).toBeGreaterThanOrEqual(0xa);
    const pika = m.anim.structs; // Pikachu is the first object spawned: slot 0
    let top = 255;
    // hold LEFT through the jump: flips on the D-pad (hJoy5, sampled every other frame)
    const frames = runUntil(
      m,
      () => {
        top = Math.min(top, pika[5]!);
        return m.wSurfingMinigamePikachuState !== PIKACHU_STATE.JUMPING;
      },
      400,
      PAD_LEFT,
    );
    expect(frames).toBeGreaterThan(20); // a magnitude of 10+ climbs for 20+ frames
    expect(top).toBeLessThan(m.wSurfingMinigamePikachuObjectHeight - 4);
    expect([PIKACHU_STATE.LANDING, PIKACHU_STATE.CRASHED]).toContain(m.wSurfingMinigamePikachuState as 2 | 3);
    expect(pika[5]).toBe(m.wSurfingMinigamePikachuObjectHeight); // .reset: back on the water
    expect(io.sfx).toContain("Surfing_Flip");
    expect(m.wSurfingMinigameRadnessMeter).toBeGreaterThan(0);
    expect(io.sfx).toContain(m.wSurfingMinigamePikachuState === PIKACHU_STATE.CRASHED ? "Surfing_Crash" : "Surfing_Land");
  });

  test("BCD HP deduction, the HP digits and the capped totals", () => {
    const m = new SurfingMinigame(makeIo(), tilemaps());
    const hp = m.wSurfingMinigamePikachuHP;
    hp.set([0x00, 0x60]);
    m.SurfingMinigame_Deduct1HP();
    expect(Array.from(hp)).toEqual([0x99, 0x59]);
    hp.set([0x10, 0x00]);
    m.SurfingMinigame_Deduct1HP();
    expect(Array.from(hp)).toEqual([0x09, 0x00]);
    hp.set([0x01, 0x00]);
    m.SurfingMinigame_Deduct1HP();
    expect(Array.from(hp)).toEqual([0x00, 0x00]);
    hp.set([0x37, 0x12]);
    m.SurfingMinigame_DrawHP();
    expect([m.wShadowOAM[2], m.wShadowOAM[6], m.wShadowOAM[10], m.wShadowOAM[14]]).toEqual([0xd1, 0xd2, 0xd3, 0xd7]);
    const t = m.wSurfingMinigameTotalScore;
    t.set([0x99, 0x12]);
    m.SurfingMinigame_AddPointsToTotal(1);
    expect(Array.from(t)).toEqual([0x00, 0x13]);
    t.set([0x99, 0x99]);
    m.SurfingMinigame_AddPointsToTotal(1);
    expect(Array.from(t)).toEqual([0x99, 0x99]); // capped at 9999
    const r = m.wSurfingMinigameRadnessScore;
    r.set([0x00, 0x00]);
    // .add180RadnessPoints' four adds
    for (const e of [0x50, 0x50, 0x50, 0x30]) m.SurfingMinigame_AddRadness(e);
    expect(Array.from(r)).toEqual([0x80, 0x01]);
    r.set([0x00, 0x01]);
    expect(m.SurfingMinigame_AddRadnessToTotal()).toBe(false); // 99 moved
    expect(Array.from(r)).toEqual([0x01, 0x00]);
  });
});

/** Play to routine 1, end the course by hand, then log the routine each frame to the exit. */
function playToResults(io: TestIo): { m: SurfingMinigame; log: number[]; hp: number } {
  const m = new SurfingMinigame(io, tilemaps());
  runUntil(m, () => m.wSurfingMinigameRoutineNumber === 1);
  for (let i = 0; i < 60; i++) m.frame(0, 0);
  m.wSurfingMinigameDistance[0] = 0x18; // the 24th section done
  const hp = decBcd(m.wSurfingMinigamePikachuHP[0]!, m.wSurfingMinigamePikachuHP[1]!);
  const log: number[] = [];
  for (let f = 0; f < 3000 && m.wSurfingMinigameRoutineNumber !== 0xb; f++) {
    log.push(m.wSurfingMinigameRoutineNumber);
    m.frame(0, 0);
  }
  return { m, log, hp };
}

function runs(log: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of log) {
    const last = out[out.length - 1];
    if (last && last[0] === r) last[1]++;
    else out.push([r, 1]);
  }
  return out;
}

describe("surfing pikachu: results", () => {
  test("the results routines run in the ROM's order with its delays", () => {
    const io = makeIo();
    const { m, log, hp } = playToResults(io);
    expect(hp).toBeGreaterThan(5000);
    const seq = runs(log);
    // the frame RunGame finds the course done, then each routine's frames:
    // RunDelayTimer counts its delay down and carries once it is 0
    expect(seq).toEqual([
      [1, 1],
      [2, 192 + 1],
      [3, 0x90 / 4 + 1],
      [4, 1],
      [5, 32 + 1],
      [6, 64 + 1],
      [7, 64 + 1],
      [8, 64 + Math.floor(hp / 99) + 1],
      [9, 64 + 1],
      [0xa, 128 + 1],
    ]);
    expect(io.sfx.filter((s) => s === "Press_AB").length).toBe(Math.floor(hp / 99));
    expect(decBcd(m.wSurfingMinigameTotalScore[0]!, m.wSurfingMinigameTotalScore[1]!)).toBe(hp);
    expect(m.wSurfingMinigamePikachuState).toBe(PIKACHU_STATE.RESULTS); // hi score 0 was beaten
    // the results text reached vBGMap0: "HP Left" at (2, 2), "Hi-Score!!" at (6, 8)
    expect(m.video.maps[2 * 32 + 2]).toBe(0x20);
    expect(m.video.maps[8 * 32 + 6]).toBe(0x20);
    expect(m.video.maps[1 * 32 + 1]).toBe(0x3b); // the box corner
    expect(m.video.lineTarget).toBe("none");
    expect(m.video.scx).toBe(0);
  });

  test("a high score calls setHiScore only when beaten", () => {
    const io = makeIo({ hiScore: 0x0000 });
    const { m } = playToResults(io);
    const t = m.wSurfingMinigameTotalScore;
    expect(io.hiScores).toEqual([(t[1]! << 8) | t[0]!]);
    expect(io.clips).toEqual([34]);
    expect(io.sfx[io.sfx.length - 1]).toBe("Get_Item2");

    const io2 = makeIo({ hiScore: 0x9999 });
    const r2 = playToResults(io2);
    expect(io2.hiScores).toEqual([]);
    expect(io2.clips).toEqual([28]);
    expect(r2.m.wSurfingMinigamePikachuState).toBe(PIKACHU_STATE.INIT_RESULTS);

    // a tie is not a high score
    const tie = (t[1]! << 8) | t[0]!;
    const io3 = makeIo({ hiScore: tie });
    playToResults(io3);
    expect(io3.hiScores).toEqual([]);

    // no surfing Pikachu in the party: no cry
    const io4 = makeIo({ hiScore: 0x9999, surfingPikachuInParty: false });
    playToResults(io4);
    expect(io4.clips).toEqual([]);
  });

  test("frame() returns false after the exit", () => {
    const io = makeIo();
    const { m } = playToResults(io);
    expect(m.wSurfingMinigameRoutineNumber).toBe(0xb);
    expect(m.frame(0, 0)).toBe(true);
    // A: bit 7 set; the next pass leaves the loop, blanks and DelayFrames once
    expect(m.frame(PAD_A, PAD_A)).toBe(true);
    expect(m.wSurfingMinigameRoutineNumber & 0x80).toBe(0x80);
    expect(m.frame(PAD_A, 0)).toBe(true);
    expect(m.video.bgp).toBe(0);
    expect(m.video.wy).toBe(144);
    expect(m.video.oam.every((b) => b === 0)).toBe(true);
    expect(m.done).toBe(false);
    expect(m.frame(0, 0)).toBe(false);
    expect(m.done).toBe(true);
    expect(m.frame(0, 0)).toBe(false);
  });

  test("with no input the whole run plays out to the results or a game over", () => {
    const io = makeIo();
    const m = new SurfingMinigame(io, tilemaps());
    runUntil(m, () => m.wSurfingMinigameRoutineNumber === 1);
    const seen = new Set<number>();
    for (let f = 0; f < 12000 && m.wSurfingMinigameRoutineNumber !== 0xb && m.wSurfingMinigameRoutineNumber !== 0xc; f++) {
      seen.add(m.wSurfingMinigameRoutineNumber);
      m.frame(0, 0);
    }
    const end = m.wSurfingMinigameRoutineNumber;
    expect([0xb, 0xc]).toContain(end);
    if (end === 0xb) expect([...seen]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0xa]);
    // a frame renders without complaint
    const px = renderGb(m.video, (_s, tile, x, y) => (tile + x + y) & 3);
    expect(px.length).toBe(160 * 144);
  });

  test("HP running out: Oh no, $80 frames, then A exits; SELECT quits when allowed", () => {
    const io = makeIo();
    const m = new SurfingMinigame(io, tilemaps());
    runUntil(m, () => m.wSurfingMinigameRoutineNumber === 1);
    m.wSurfingMinigamePikachuHP.set([0x03, 0x00]);
    const n = runUntil(m, () => m.wSurfingMinigameRoutineNumber === 0xc);
    expect(n).toBe(4); // three frames of HP, the fourth finds 0
    expect(m.wSurfingMinigameGameOver).toBe(1);
    // "Oh no" (frameset $13) is up
    const slots = Array.from({ length: 10 }, (_, i) => m.anim.structs.slice(i * 16, i * 16 + 16));
    expect(slots.some((s) => s[0] !== 0 && s[1] === 0x13)).toBe(true);
    for (let i = 0; i < 0x80; i++) m.frame(PAD_A, PAD_A & (i & 1 ? PAD_A : 0));
    expect(m.wSurfingMinigameRoutineNumber).toBe(0xc); // A ignored during the delay
    m.frame(0, 0);
    m.frame(PAD_A, PAD_A);
    expect(m.wSurfingMinigameRoutineNumber & 0x80).toBe(0x80);
    m.frame(0, 0);
    expect(m.frame(0, 0)).toBe(false);

    const io2 = makeIo({ selectQuits: true });
    const q = new SurfingMinigame(io2, tilemaps());
    runUntil(q, () => q.wSurfingMinigameRoutineNumber === 1);
    q.frame(PAD_SELECT, PAD_SELECT);
    expect(q.frame(0, 0)).toBe(false);
  });
});
