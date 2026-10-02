# Pokémon Gold: what a port needs

Survey of 2026-09-30. Nothing here is built yet.

## Source and licence

- **Port from:** bryanthaboi/gen1recomp's Gen 2 support, and only that.
  - It landed in `ae6cac89` (2026-08-11).
  - Its last MIT commit is **`bdfac727`** (2026-09-18 15:42).
  - Commit `661d75ef`, an hour later, relicensed the project to GPLv3 plus extra terms, and changed code in the same commit.
  - Nothing from `661d75ef` onward may come into this repo.
  - A checkout of `bdfac727` is at `~/gen1recomp-mit-gen2`. `~/gen1recomp` stays on the Gen 1 pin, `943ba5dc`.
- **Other Gen 2 projects are unusable:**
  - UNDERdecoded/Gen2Recomped is "source-available, all rights reserved".
  - abdillahinur/Gen2Recomp and the rest have no licence.
- **ROM:** Pokémon Gold (USA, Europe), SHA-1 `d8b8a3600a465308c9953dfa04f0081c05bdcb94`, 2 MiB.
- **Scale:** 368 maps in 52 groups, and 251 species plus the Unown forms and the egg.
- **Delivery:** same codebase and same cook. Gold gets its own 3dsx and CIA, its own `paks_gold` set and its own save, as Yellow did.

## What Brian's Gen 2 is

It is a second engine, not branches inside Gen 1. A Gold boot never loads his Gen 1 `Game`, `OverworldController` or `BattleState`.

| Area | Where | Size | State |
|---|---|---|---|
| Owner | `src/core/Game2.lua` | 2.6k lines | |
| Import | `src/import/RomExtractorGen2.lua` | 7.5k lines, 27 stages | complete except the `field` stub (Magnet Train only) |
| Manifest | `tools/rom_manifest_gold.json` | 421 KB | 2062 symbols, 368 maps, 28 tilesets |
| Script VM | `src/script/gen2/` | Vm 2.8k, Specials 2.8k, CallAsm 0.8k lines | runs the cart's own bytecode |
| World | `src/world/gen2/` | World 11.8k lines + 22 modules | |
| Systems | `src/core/gen2/` | 30 files | clock and day/night, phone, breeding, Bug Contest, roamers, Pokérus, apricorns and berries, Unown, mail, decorations, Magnet Train |
| Battle | `src/battle/gen2/` | 14.4k lines, plus the 4.7k-line battle UI | a handful of move effects appear unhandled (Swagger, Pain Split, Present, Conversion2, Mimic); unverified |
| UI | `src/ui/gen2/` | 76 screens | pack with pockets, Pokégear, Pokédex, PC, Summary, intro/title, and so on |
| Audio | shared `ChipSynth.lua` | | Gen 2 branches: new opcodes, pitch table, drumkits, stereo |
| Save / RTC | `core/gen2/Save.lua`, `save_convert/Gen2*`, `core/gen2/Clock.lua` | | |
| Tests | | ~121k lines | headless suites, ROM drivers, a route bot from New Bark Town to Olivine |

- **In total:** about 109k lines. His Gen 1 was about 80k lines, which became our 42k lines of TypeScript. On that basis Gold is roughly two to two and a half times the Gen 1 port.
- **The big saving:** the script VM runs the ROM's own map scripts. Nothing like `mapscripts.ts` (3.6k hand-ported lines for Gen 1) needs writing for Johto.
- **Deliberately stubbed upstream:** link cable, Time Capsule, Mystery Gift. All
  three are now ported over the 3DS wireless link (2026-10-02): CABLE CLUB
  trades and COLOSSEUM battles Gold to Gold, the TIME CAPSULE to Red/Blue/Yellow,
  the link record, and MYSTERY GIFT between two Gold consoles (which also
  gives the Viridian TRAINER HOUSE its CAL2).

## What we keep unchanged

- The voxel cook: mesh, rect merge, ground bake, trees, buildings, volumes, standees, the pak format and atlas packing. Gold's blocks are still 4×4 tiles and cells are 16 px.
- The core renderer, streaming and prefetch, and the QuickJS host.
- The save serializer and Lua reader, `Rom`, 2bpp decoding and `GfxBin`.
- The GB screen, for any hardware-drawn screens.
- The audio mixer, envelopes, noise and PCM. Only the interpreter is new.
- Kanto Gear's bottom-screen framework. Its apps need Johto content.
- CIA and banner tooling.

## What must be built

### Version plumbing
- Add `gold` to:
  - `voxelmon/import/env.ts`, with a `generation` field;
  - `gameVersion` in `voxelmon/game/data.ts`;
  - `tools/cook3ds.ts`: `paksLayout`, `VERSION_FILES`, `BOOT_MAPS`;
  - a `gold` Cargo feature in the 3DS host, with paths, the boot map and the save path;
  - `make_cia.sh`: UNIQUE `0xff3d3` and a new product code;
  - `3ds_art.py`: a **G** glyph and a gold tint;
  - `cooker.py`: a GAMES entry, with the manifest fetched at `bdfac727`.
- Map ids become `(group<<8)|map` in `index.txt` and the paks.

### Importer
Port `RomExtractorGen2.lua` as TypeScript stages. Almost every Gen 1 stage's format changes:
- LZ-compressed pics and tile graphics;
- map groups with two-part headers, (group, map) ids, coordinate/bg/object events with time windows;
- tilesets with per-quadrant collision and a per-tile palette map;
- 32-byte base stats (SpA/SpD, held items, gender, egg data), 7-byte moves, `ItemAttributes` with pockets, four trainer party types;
- encounters for morning/day/night;
- 6-byte cry rows and GBC palettes (BG per time of day, per-species normal and shiny).

### Cook
- **Tileset classification (the biggest art risk):** PotatoVoxel's height pins are keyed to Gen 1 tile ids. Johto's 28 tilesets need their own shape rules.
- **Colour:** the RED++ colour model (a palette group per tile, roof swaps) matches Gold's native per-tile palette map. Reuse it with ROM data.
- **Time of day:** three palette variants per map, plus a way to pick one (a new op).
- **Pages:** about 250 more pic pages in the shared atlas. `common.vxat` is 7.7 MB today and loads whole at boot, so watch memory.
- **Pak set:** an estimated ~500 MB for 368 maps (Red's is 306 MB).
- **Gen 1 special cases to drop:** Game Corner, card keys, OVERWORLD border tree ring, Kanto palette-by-map tables.

### Core
- **Gen 2 sound engine:** a second interpreter in `audio.rs`, selected by engine. It needs the renumbered opcodes (octave `D0-D7`, notetype `D8`, tempo `DA`, vibrato `E1`, drumkit `E3`, jump/loop/call/return `FC-FF`, and more), plus the new pitch table, wave samples, drumkits and stereo panning.
- **Time of day:** palette selection in draw (or `tint`).
- **GB screen CGB attributes:** only if a hardware-drawn Gold screen needs them.

### Guest
A parallel engine under `voxelmon/game2/` (or `gen2/`), sharing the scene/host layer:
- the script VM (Vm, Opcodes, Specials, CallAsm);
- the world (movement, events, warps, connections, field moves);
- battle (the special split, held items, weather, gender, shininess, happiness) and its UI;
- about 76 UI screens;
- the clock, phone, radio and Pokégear, breeding, Bug Contest and the other systems;
- the Gen 2 save.

### Kanto Gear
Johto and Kanto maps, 16 badges, a Gen 2 Pokédex, and Johto apps.

## Suggested order, each ending in something to test on the 3DS

1. **Walk New Bark Town.** Plumbing, the Gold manifest, importer stages for maps, tilesets, palettes and sprites, the cook with a first Johto shape profile, and the host boot. Proves the cook and memory for 368 maps.
2. **Talk and travel.** Script VM, world, warps, NPCs, text, events and flags; the Elm's Lab opening.
3. **Battle and menus.** Battle engine and UI, party, pack, Pokédex, PC, save. Gold becomes playable.
4. **Sound and time.** Gen 2 audio interpreter, clock and day/night palettes, phone, radio, Pokégear.
5. **The rest.** Breeding, Bug Contest, roamers, the remaining systems, Kanto Gear apps, polish.

**Silver** is cheap afterwards: its manifest is derived from Gold's. **Crystal** is its own step: its own manifest, two-bank tilesets and Battle Tower.

## Needed from Isaac

- A Gold ROM matching the SHA-1 above, in `Desktop/mGBA` like the others.
- Nothing can be imported or cooked without it. Plumbing and code ports can start before it arrives.
