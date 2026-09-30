// The Gen 2 sound seam: gen1recomp's Sound.lua / Music.lua (bdfac727) as
// voxelmon/game/gen2/shared/core/{Sound,Music}.ts, resolving real Gold names
// to the core's audio ops (voxel-spec.ts §audio, engine AUDIO_ENGINE_GEN2),
// against the imported Gold tables with the cook's measured lengths
// (voxelmon/cook/gen2audio.ts). Skips when Gold has not been imported.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIO_ENGINE_GEN2,
  AUDIO_MUSIC_FLAG,
  AUDIO_SFX_FLAG,
  AUDIO_SFX_TEMPO,
  VOX_OP,
} from "../contracts/spec/voxel-spec.ts";
import { gen2AudioManifest, gen2ProgramFrames } from "../voxelmon/cook/gen2audio.ts";
import { GOLD_GEN_DIR, haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Music } from "../voxelmon/game/gen2/shared/core/Music.ts";
import { type AudioHost, type AudioTable, Sound } from "../voxelmon/game/gen2/shared/core/Sound.ts";

const PROGRAMS = join(GOLD_GEN_DIR, "programs.bin");
const have = haveGoldGen() && existsSync(PROGRAMS) && existsSync(join(GOLD_GEN_DIR, "audio.json"));

/** Records every audio op as [code, ...args]. */
class OpLog implements AudioHost {
  ops: number[][] = [];
  music(bank: number, addr: number, engine: number, flags: number): void {
    this.ops.push([VOX_OP.music, bank, addr, engine, flags]);
  }
  musicStop(): void {
    this.ops.push([VOX_OP.musicStop]);
  }
  musicFade(ticks: number): void {
    this.ops.push([VOX_OP.musicFade, ticks]);
  }
  sfx(bank: number, addr: number, engine: number, pitch: number, tempo: number, flags: number): void {
    this.ops.push([VOX_OP.sfx, bank, addr, engine, pitch, tempo, flags]);
  }
  cry(bank: number, addr: number, engine: number, pitch: number, length: number): void {
    this.ops.push([VOX_OP.cry, bank, addr, engine, pitch, length]);
  }
  audioWaves(engine: number, bank: number, addr: number): void {
    this.ops.push([VOX_OP.audioWaves, engine, bank, addr]);
  }
  audioDrum(engine: number, drum: number, bank: number, addr: number): void {
    this.ops.push([VOX_OP.audioDrum, engine, drum, bank, addr]);
  }
  take(): number[][] {
    const out = this.ops;
    this.ops = [];
    return out;
  }
}

describe.skipIf(!have)("Gen 2 Sound / Music on the Gold tables", () => {
  let audio: AudioTable & Record<string, any>;
  let data: { audio: AudioTable };
  let host: OpLog;
  const slot = (bank: number) => audio.bankOrder!.indexOf(bank);
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) Music.update(data);
  };

  beforeEach(() => {
    useGoldGen();
    const raw = JSON.parse(readFileSync(join(GOLD_GEN_DIR, "audio.json"), "utf8"));
    audio ??= gen2AudioManifest(raw, new Uint8Array(readFileSync(PROGRAMS)));
    data = { audio };
    Sound._resetForTest();
    Music._resetForTest();
    host = new OpLog();
    Sound.setHost(host);
  });

  test("NEW_BARK_TOWN's music resolves to a Gen 2 music op, with the tables pinned first", () => {
    Music.playMap(data, "NEW_BARK_TOWN");
    expect(Music.current()).toBe("Music_NewBarkTown");
    expect(Music.mapSong()).toBe("Music_NewBarkTown");
    const def = audio.songs!.Music_NewBarkTown!;
    const ops = host.take();
    const wave = audio.waveBanks!["1"]!;
    const kits = audio.drumkits!;
    expect(ops).toEqual([
      [VOX_OP.audioWaves, AUDIO_ENGINE_GEN2, slot(wave.bank), wave.address],
      [VOX_OP.audioDrum, AUDIO_ENGINE_GEN2, 0, slot(kits.bank), kits.address],
      [VOX_OP.music, slot(def.bank), def.address, AUDIO_ENGINE_GEN2, AUDIO_MUSIC_FLAG.loop],
    ]);
    // the same map song again does not restart (Music.lua:242)
    Music.playMap(data, "NEW_BARK_TOWN");
    expect(host.take()).toEqual([]);
  });

  test("SFX_READ_TEXT resolves to an sfx op and plays for its measured length", () => {
    const src = Sound.play(data, "Sfx_ReadText");
    const def = audio.sfx!.Sfx_ReadText!;
    expect(host.take().at(-1)).toEqual([
      VOX_OP.sfx, slot(def.bank), def.address, AUDIO_ENGINE_GEN2, 0, AUDIO_SFX_TEMPO, 0,
    ]);
    expect(src).not.toBeNull();
    // measured by the cook with the synth's own clock; audio.rs agrees
    expect(def.frames).toBe(16);
    expect(Sound.isPlaying("Sfx_ReadText")).toBe(true);
    expect(Sound.sfxBusy()).toBe(true);
    // WaitForSoundToFinish: ceil(duration * 60) + 2 (Sound.lua:196)
    expect(Sound.waitFramesFor("Sfx_ReadText")).toBe(16 + 3);
    frames(16);
    expect(Sound.isPlaying("Sfx_ReadText")).toBe(true);
    frames(1);
    expect(Sound.isPlaying("Sfx_ReadText")).toBe(false);
    expect(Sound.sfxBusy()).toBe(false);
  });

  test("the shared Press_AB alias plays SFX_READ_TEXT_2 (Sound.lua:299)", () => {
    expect(Sound.resolve(data, "Press_AB")).toBe("Sfx_ReadText2");
    Sound.playPress(data);
    const def = audio.sfx!.Sfx_ReadText2!;
    expect(host.take().at(-1)?.slice(0, 3)).toEqual([VOX_OP.sfx, slot(def.bank), def.address]);
    expect(Sound.isPlaying("Press_AB")).toBe(true);
    Sound.dropPressSfx();
    expect(host.take()).toEqual([[VOX_OP.sfx, 0, 0, 0, 0, 0, AUDIO_SFX_FLAG.stop]]);
  });

  test("PlaySFX's priority gate drops a lower-priority sound and cuts for a higher one", () => {
    // SproutTower3FRivalScene: SFX_TACKLE ($41) then SFX_ELEVATOR ($6e)
    Sound.play(data, "Sfx_Tackle");
    host.take();
    expect(Sound.play(data, "Sfx_Elevator")).toBeNull();
    expect(host.take()).toEqual([]);
    // a smaller id (higher priority) stops ch5-ch8 first, then plays
    expect(Sound.play(data, "Sfx_Menu")).not.toBeNull();
    const ops = host.take();
    expect(ops[0]).toEqual([VOX_OP.sfx, 0, 0, 0, 0, 0, AUDIO_SFX_FLAG.stop]);
    expect(ops[1]![2]).toBe(audio.sfx!.Sfx_Menu!.address);
    // PlayStereoSFX has no gate
    expect(Sound.playStereo(data, "Sfx_Elevator")).not.toBeNull();
  });

  test("CHIKORITA's cry resolves to a cry op with its pitch and length", () => {
    const src = Sound.playCry(data, "CHIKORITA");
    const cry = audio.cries!.CHIKORITA!;
    expect(cry.pitch).toBe(0x10000 - 16); // pret's -16, read unsigned
    expect(host.take().at(-1)).toEqual([
      VOX_OP.cry, slot(cry.header!.bank), cry.header!.address, AUDIO_ENGINE_GEN2, cry.pitch!, cry.length!,
    ]);
    expect(src?.frames).toBe(15);
    expect(Sound.isPlaying("cry:CHIKORITA")).toBe(true);
    // the length is the tempo word: a longer one runs longer
    const h = cry.header as { bank: number; address: number };
    const order = audio.bankOrder!;
    const programs = new Uint8Array(readFileSync(PROGRAMS));
    expect(gen2ProgramFrames(programs, order, h, { cryLength: cry.length! * 2 })).toBeGreaterThan(15);
  });

  test("a fanfare ducks the song and ends on its own clock", () => {
    Music.playMap(data, "NEW_BARK_TOWN");
    host.take();
    expect(Sound.ducksMusic(data, "Sfx_Item")).toBe(true);
    expect(Sound.ducksMusic(data, "Sfx_ReadText")).toBe(false);
    Sound.play(data, "Sfx_Item");
    const op = host.take().at(-1)!;
    expect(op[0]).toBe(VOX_OP.sfx);
    expect(op[6]).toBe(AUDIO_SFX_FLAG.duck);
    frames(audio.sfx!.Sfx_Item!.frames! + 1);
    expect(Sound.isPlaying("Sfx_Item")).toBe(false);
    expect(Music.current()).toBe("Music_NewBarkTown");
    expect(host.take()).toEqual([]);
  });

  test("a map change fades out, then starts the next song; coming back cancels the fade", () => {
    Music.playMap(data, "NEW_BARK_TOWN");
    host.take();
    Music.playMap(data, "ROUTE_29", false, false, Music.MAP_FADE);
    expect(host.take()).toEqual([[VOX_OP.musicFade, Music.MAP_FADE]]);
    // back into New Bark before the fade ends: same song, fade called off
    Music.playMap(data, "NEW_BARK_TOWN");
    const nbt = audio.songs!.Music_NewBarkTown!;
    expect(host.take()).toEqual([
      [VOX_OP.music, slot(nbt.bank), nbt.address, AUDIO_ENGINE_GEN2, AUDIO_MUSIC_FLAG.loop | AUDIO_MUSIC_FLAG.resume],
    ]);
    // a full fade: seven levels of MAP_FADE frames, then Route 29
    Music.playMap(data, "ROUTE_29", false, false, Music.MAP_FADE);
    host.take();
    frames(7 * Music.MAP_FADE - 1);
    expect(Music.current()).toBe("Music_NewBarkTown");
    frames(1);
    const r29 = audio.songs!.Music_Route29!;
    expect(host.take()).toEqual([
      [VOX_OP.musicStop],
      [VOX_OP.music, slot(r29.bank), r29.address, AUDIO_ENGINE_GEN2, AUDIO_MUSIC_FLAG.loop],
    ]);
    expect(Music.current()).toBe("Music_Route29");
  });

  test("playOnce plays a jingle once and restores the map theme when it ends", () => {
    Music.playMap(data, "NEW_BARK_TOWN");
    expect(Music.playOnce(data, "Music_HealPokemon")).toBe(true);
    const heal = audio.songs!.Music_HealPokemon!;
    expect(host.take().at(-1)).toEqual([VOX_OP.music, slot(heal.bank), heal.address, AUDIO_ENGINE_GEN2, 0]);
    expect(heal.frames).toBe(135);
    frames(135);
    expect(Music.oneShotPlaying()).toBe(true);
    frames(1);
    expect(Music.oneShotPlaying()).toBe(false);
    expect(Music.current()).toBe("Music_NewBarkTown");
  });

  test("the SOUND option reaches the playing song live, and stop / setMapSong behave", () => {
    Music.playMap(data, "NEW_BARK_TOWN");
    host.take();
    Music.applyOptions({ sound: "STEREO" });
    const nbt = audio.songs!.Music_NewBarkTown!;
    const flags = AUDIO_MUSIC_FLAG.loop | AUDIO_MUSIC_FLAG.stereo;
    expect(host.take()).toEqual([
      [VOX_OP.music, slot(nbt.bank), nbt.address, AUDIO_ENGINE_GEN2, flags | AUDIO_MUSIC_FLAG.resume],
    ]);
    Music.setMapSong("Music_Route29");
    expect(Music.mapSong()).toBe("Music_Route29");
    Music.stop();
    expect(host.take()).toEqual([[VOX_OP.musicStop]]);
    expect(Music.current()).toBeNull();
    Music.restoreMap(data);
    expect(Music.current()).toBe("Music_Route29");
  });

  test("the low-health alarm loops on the core's siren until stopped", () => {
    Sound.startLoop(data, "Low_Health_Alarm");
    Sound.startLoop(data, "Low_Health_Alarm");
    expect(Sound.isLooping("Low_Health_Alarm")).toBe(true);
    Sound.stopLoop("Low_Health_Alarm");
    const ops = host.take().filter((o) => o[0] === VOX_OP.sfx);
    expect(ops).toEqual([
      [VOX_OP.sfx, 0, 0, 0, 0, 0, AUDIO_SFX_FLAG.alarm],
      [VOX_OP.sfx, 0, 0, 0, 0, 0, AUDIO_SFX_FLAG.alarm | AUDIO_SFX_FLAG.stop],
    ]);
  });

  test("headless (no host) every play is a quiet no-op, as under the Lua's stub", () => {
    Sound.setHost(null);
    expect(Sound.play(data, "Sfx_ReadText")).toBeNull();
    expect(Sound.playCry(data, "CHIKORITA")).toBeNull();
    Music.playMap(data, "NEW_BARK_TOWN");
    expect(Music.current()).toBeNull();
    expect(Sound.isPlaying("Sfx_ReadText")).toBe(false);
    expect(Sound.waitFramesFor("Sfx_ReadText")).toBe(0);
  });

  test("with no data argument the generated table is read (loadGenerated)", () => {
    Sound.play({}, "Sfx_ReadText");
    expect(host.take().at(-1)?.[0]).toBe(VOX_OP.sfx);
  });
});
