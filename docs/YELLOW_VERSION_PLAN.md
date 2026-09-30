# Yellow — what it takes

**Status: investigation only, 2026-09-30. No Yellow code exists yet.** Red and
Blue are done (docs/3DS.md §4c); this is what Yellow adds on top, measured
against gen1recomp's Yellow port and its Yellow ROM manifest.

## The short version

Yellow is not a data swap the way Blue was. Blue shared every map and every
graphic but one with Red; Yellow is a different ROM layout with redrawn
Pokémon, changed maps, a different opening, and a companion Pikachu that
touches the overworld, battles, items and the PC. gen1recomp carries about
**3,700 lines of Yellow-only Lua** plus 31 `isYellow()` branches in 15
engine files. Most of it ports the same way the rest of this game was
ported; the Pikachu follower and the Pikachu voice are the two genuinely new
systems.

The ROM we need is on hand: `Desktop/mGBA/Pokemon-Yellow.gbc` is the
canonical US Yellow (SHA-1 `cc7d03262ebfaf2f06772c1a480c7d9d5f4a38e1`, the
hash gen1recomp's `rom_manifest_yellow.json` expects).

## What the data says (Red manifest vs Yellow manifest)

| | |
|---|---|
| Symbols | 4,507 in Yellow vs 3,274 in Red; only **58** sit at the same address. 1,319 are new, 86 of Red's are gone. The whole ROM moved. |
| Our importer | Names 64 ROM symbols. **60 exist in Yellow.** The 4 missing are the intro's fight-scene frames (`FightIntroBackMon`, `FightIntroFrontMon1-3`) -- Yellow has its own intro (`YellowIntroGraphics1/2`, `YellowIntroCloudGFX`). |
| Maps | 223 vs 222: `CERULEAN_MELANIES_HOUSE` replaces `CERULEAN_TRADE_HOUSE`, `SUMMER_BEACH_HOUSE` is new. **30 more maps differ** (every Pokémon Center -- Chansey beside the nurse -- plus Cerulean, Vermilion, Saffron, Route 6/9/24, Oak's Lab, Blue's House, Mt Moon B2F, Rocket Hideout B4F, Pokémon Tower 7F, Silph 11F, Game Corner, Fan Club, Indigo lobby, Cerulean Cave, ...). |
| Field data | Differs in credits, emotion bubbles, Oak's speech, the old man's battle, preset names, title, town map, trades. |
| Sprites | New `surfPikachu`; the sprite order differs. The walking Pikachu is its own sheet (`PikachuSprite`). |
| Audio | New program banks; cries, map songs and music headers differ; a `PikachuCriesPointerTable` (the digitised Pikachu voice). |
| Text | Labels differ. Of the **466** ROM text labels our game code names, **38 are missing** in Yellow -- 18 in the Game Corner clerks (renamed), 19 in map scripts (mostly the Cerulean trade house that became Melanie's), 1 in the link code. |
| Colour | Yellow is a Game Boy Color game with its own palettes in ROM (SuperPalettes + CGBBasePalettes + MonsterPalettes; gen1recomp writes them to `data/palettes_yellow.lua`). |

**Consequence for the SD card:** Red and Blue share one pak set because their
pages line up one for one. Yellow's Pokémon are redrawn, its sprite order is
different and 32 maps changed, so its atlas pages will not line up. Plan on
Yellow having **its own pak set** (~300 MB, in its own folder beside
`voxelmon`), not an overlay. This is worth measuring on the first import
before it is final.

## What gen1recomp does for Yellow (the port list)

| Feature | gen1recomp | Size |
|---|---|---|
| **Pikachu follower** -- trails the player, warps and ledges with them, does not block; happiness (starts 90) and mood (128) with the ROM's change table; A on it shows an emotion bubble; Bill's house scene | `src/world/PikachuFollower.lua` | 973 lines |
| **Opening and Oak's lab** -- Oak catches Pikachu on Route 1; one Eevee ball, the rival snatches it; Oak gives you Pikachu (no nickname prompt); the lab has different objects | `data/scripts/oaks_lab_yellow.lua` | 310 |
| **Rival's party** -- keyed off `rivalStarter` (Jolteon / Flareon / Vaporeon) set by the lab and Route 22 outcomes | `src/script/Commands.lua:871-906` | table + hook |
| **Yellow intro movie** (18 scenes) and **title screen** (Pikachu, no cycling mons, no ribbon) | `src/ui/YellowIntro.lua`, `TitleState.lua` yellowLayout | 831 + branches |
| **Starter gifts** -- Bulbasaur from Melanie (needs Pikachu happiness ≥ 147), Charmander on Route 24, Squirtle from Officer Jenny | `data/scripts/yellow_gifts.lua` | 113 |
| **Jessie & James** at Mt Moon B2F, Rocket Hideout B4F, Pokémon Tower 7F, Silph 11F | `data/scripts/yellow_jessie_james.lua` | 308 |
| **Viridian old man** Yellow variant (catch demo is a Rattata) | `yellow_viridian_old_man.lua`, `Data.lua:78` | 151 |
| **Summer Beach House + Surfing Pikachu minigame** (needs a Pikachu with SURF) | `yellow_beach_house.lua`, `src/ui/SurfingMinigame.lua` | 131 + 547 |
| **Pikachu refuses the Thunder Stone** (your own Pikachu only) | `src/inventory/ItemEffects.lua:396` | small |
| **Pikachu's voice** -- digitised cries played as samples, own volume option | `Sound.lua:33`, `OptionsMenu.lua:499` | new audio path |
| **Trades, Game Corner prizes** -- Yellow tables | `Data.lua:78` (YELLOW_TRADES), `story3.lua` YELLOW_PRIZE_WINDOWS | tables |
| **Printer** -- PRNT in the Pokédex, PRINT BOX in the PC (gen1recomp saves a PNG) | `PokedexMenu.lua:83`, `BoxMenu.lua:279` | skip |
| Small things -- item-found-with-full-bag text, ledge shadow offset | `OverworldController.lua:2601`, `Player.lua:321` | tiny |

## Proposed order

Each phase ends playable and is tested and committed on its own, like Blue.

**Phase 1 -- Yellow boots and plays start to Champion (without the
follower).**
1. Importer: `yellow` in `VERSIONS` (SHA-1, manifest, `dist/voxelmon/yellow/gen`);
   an intro stage for Yellow's graphics instead of the fight frames; Yellow's
   title art; the Pikachu and surfing-Pikachu sheets.
2. Cook: Yellow's own pak set; measure first whether any of Red's pages can
   be shared.
3. Console build: a `yellow` feature beside `blue` (dataset, save
   `save_yellow.lua`, paks folder), yellow art (Red's with every red made
   yellow), its own title ID.
4. Guest: `gameVersion()` learns `yellow`; the Yellow lab and opening; the
   rival's Eevee parties; the 38 renamed text labels; trades, prizes, old
   man; Jessie & James; the starter gifts; the Thunder Stone refusal; the
   title screen.

**Phase 2 -- the Pikachu follower.** The most visible Yellow feature and the
biggest single port: following, warps, ledges, happiness and mood, emotion
bubbles, talking to it, Bill's house. It also gates Melanie's Bulbasaur, so
Phase 1 would read happiness as a plain counter until then.

**Phase 3 -- the extras.** Pikachu's voice (needs sample playback beside the
chip synth), the full Yellow intro movie, the Summer Beach House and the
Surfing Pikachu minigame, Yellow's own GBC colours.

Printer support is left out: there is no printer, and gen1recomp's PNG
stand-in has no 3DS equivalent worth building.

## Decisions to make before Phase 1

- **Colour.** Yellow's authentic GBC palettes (per-screen, from the ROM), or
  the per-tile RED++ colouring Red and Blue use (pokered-gbc), with Yellow's
  own Pokémon palettes? The first is faithful to the cartridge; the second
  matches how Red and Blue look in this port.
- **SD space.** A separate ~300 MB pak set for Yellow, unless measuring
  shows real sharing is possible.
- **Link.** The real games trade Yellow with Red and Blue; ours will too
  (same game code), but the follower's Pikachu has to be handled when it is
  traded away.
