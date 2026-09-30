# Cooking Blue as well as Red — a plan

**Status: built, 2026-09-29, with one change of shape from this plan: Blue
is its own title (its own `.3dsx`, `.cia`, icon and save) rather than a
mode of one binary, and the two share one pak set. docs/3DS.md §4c is how
it works now; this document is kept as the investigation behind it.**

## Bottom line

Blue is overwhelmingly a **data** problem, not a code problem. The port
already reads everything about the game from `gamedata.json` and the pak,
both of which the importer produces from the ROM. Point the importer at a
Blue ROM with the Blue manifest and you get Blue encounters, Blue sprites,
Blue text and Blue palettes without the guest knowing anything happened.

There is **one** gameplay table hardcoded in guest code that genuinely
differs, and a handful of presentation details. That is the whole surface.

## The evidence

Measured, not assumed.

### gen1recomp branches on Blue in seven places, six of them cosmetic

`isYellow` appears 28 times in the reference; `isBlue` appears 7:

| Where | What |
|---|---|
| `ui/TitleState.lua` | title layout flag |
| `render/PaletteFX.ogBg` | Blue's GBC boot-ROM background palette |
| `render/PaletteFX.ogObj` | Blue's GBC object palette |
| `render/PaletteFX` SuperPal | `BLUE_VERSIONED` named palette override |
| `render/PaletteFX.modeLabel` | the string `"OG BLUE"` |
| `core/GameVersion.lua` | the predicate itself |
| **`data/scripts/story3.lua prizeWindow`** | **Game Corner prize windows** |

Only the last is gameplay. The palette ones do not even apply to us: our
colours are baked at cook time from the ROM's own tables, so a Blue import
bakes Blue colours.

### The two ROM manifests are nearly the same file

```
red  sha1 ea9bcae617fdf159b045185467ae58b2e4a48b9a
blue sha1 d7037c83e1ae5b39bde3c30787637ba1d4c48ce2

top-level keys only in red : none
top-level keys only in blue: none
shared keys identical      : 28
shared keys different      : 3   -> romSha1, symbols, field
```

and inside `field`, only **two** subkeys differ: `credits` and
`presetNames`. Everything else that differs between the games — the
encounter tables, the sprites, the text, the trainer parties — is read out
of the ROM at the addresses in `symbols`, so it follows automatically.

### Our importer is Red-gated in exactly two places

`voxelmon/import/env.ts`:

```ts
export const RED_SHA1 = "ea9bcae617fdf159b045185467ae58b2e4a48b9a";
manifestPath: join(g1rDir, "tools/rom_manifest.json"),
```

`voxelmon/import/index.ts`:

```ts
check(digest === RED_SHA1, ...)
check(manifest.romSha1 === RED_SHA1, "... Red-only for now");
```

Both gates are deliberate and both are one-liners to generalise.

### The one real code gap

`voxelmon/game/world/gamecorner.ts` holds `PRIZE_WINDOWS` as a literal, and
its own comment already admits the problem:

> These are Red's; Blue restocks both mon counters, and the TM window is
> shared by every version.

The prize tables are **not** in the extracted dataset — `field` carries
`coinPurchases`, `slotMachines`, `slotSymbols`, `slotWheels`, but no
prizes. So this table is the single thing a Blue build would get wrong
while looking like it worked, which makes it the one to handle first.

## Proposed shape

### One binary, version carried by the pak — not two builds

The 3DS host embeds `game.js` and reads paks from the card. `game.js` is
identical for both versions, so **one build can serve both** if the pak
says which game it is. That is better than two binaries: no duplicated
host, no second CI target, and a player with both ROMs keeps one `.3dsx`.

A compile-time flag stays available if separate title art or a separate
icon per version is wanted later, but it should not be the mechanism for
game data.

### Version as a data axis

1. `voxelmon/import/env.ts` grows a `VERSIONS` table mirroring
   gen1recomp's `GameVersion.VERSIONS` — id, sha1, manifest filename,
   output prefix. Red's entry holds today's values exactly.
2. `VOXELMON_VERSION=red|blue` selects it; **absent means red**, so every
   existing command, script and golden behaves as it does today.
3. Output moves under a per-version prefix (`dist/voxelmon/blue/…`), with
   Red keeping its current paths so `cc_*` scripts and the deploy keep
   working untouched.
4. The importer stamps the version into `gamedata.json` — there is no
   version field today, only `field.source: "canonical Pokemon Red ROM …"`
   as prose. A real `version: "red" | "blue"` key is what the guest reads.

### The guest reads the stamp, in one place

Add a single accessor (`data.version ?? "red"`) and use it only where the
data genuinely differs. Today that is `PRIZE_WINDOWS` and nothing else.
The Red table stays exactly as it is; Blue's is added beside it and picked
by the stamp. **No Red behaviour changes** — with no stamp, or a stamp of
`red`, the current table is chosen.

Better still, if the prize tables can be extracted from the ROM in a later
pass, this switch disappears entirely and Blue becomes pure data.

## Work plan

Ordered so each step is shippable and testable on its own.

| # | Step | Notes |
|---|---|---|
| 1 | `VERSIONS` table + `VOXELMON_VERSION` in `env.ts`; generalise the two SHA-1 gates | Red defaults preserved; no behaviour change |
| 2 | Per-version output prefix; Red keeps today's paths | Both datasets can exist side by side |
| 3 | Stamp `version` into `gamedata.json` | The guest's only source of truth |
| 4 | Import a Blue ROM end to end; run the existing parity check against `$VOXELMON_G1R` Blue generated data | This is the real test of the thesis |
| 5 | Blue prize windows beside Red's, chosen by the stamp | The one gameplay branch |
| 6 | Cook a Blue pak; boot it | Expect Blue sprites and encounters with no further work |
| 7 | Sweep for anything the boot surfaces | The unknowns below |

Steps 1–3 are small and touch only the importer. Step 4 is where the
answer actually arrives.

## Risks and unknowns

- **Extraction stages with Red assumptions.** The stages read addresses
  from `symbols`, which is the right design, but none has ever been run
  against another ROM. Step 4 is deliberately early for this reason.
- **The cook's tile/building templates.** The voxelizer classifies tiles
  and places 42 building templates. If any of that keys off Red-specific
  tile ids rather than the tileset data, a Blue map could cook wrong. Worth
  a targeted look before step 6.
- **Sprite sheet sizes.** Blue uses different front sprites for many
  species; if any are dimensioned differently the atlas packer should cope,
  but it has not been asked to.
- **Shared atlas.** `common.vxat` is built across all maps of one version.
  A Blue cook needs its own, and the two must not be mixed — worth an
  explicit guard so a Blue pak cannot load Red's shared blob.
- **Saves.** gen1recomp suffixes Blue saves (`save_blue.lua`). Ours would
  want the same so one console can hold both without clobbering, and so a
  Red save never loads under a Blue dataset.

## Explicitly not in scope

- Yellow. It is the version that actually needs code (28 branches, the
  Pikachu follower, different scripts), and nothing here is shaped for it.
- Changing any Red behaviour, table, golden or path. Red is the default on
  every switch proposed above, and the absence of a version stamp means
  Red.
