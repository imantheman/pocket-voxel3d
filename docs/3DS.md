# Pocket Voxel on the Nintendo 3DS

Build the game from your own ROM and put it on your 3DS.

There is no download. **Nothing playable is distributed** — not by this
repository and not by anyone. The game's every byte of content is built on
your machine from a cartridge you already own, and what comes out stays on
your machine. That is the whole arrangement, and the rest of this page is
how to do your half of it.

Budget about **twenty minutes**, most of it unattended, and **3 GB of free
disk** while it runs.

---

## 0. The short way

If you are not here to work on the code, you do not need anything below
this section. The release zip contains a `cooker` folder:

1. **Drag your Pokémon Red `.gb` file onto `Cook Pocket Voxel.bat`**
   (Windows), or double-click `Cook Pocket Voxel.command` (Mac) and drag
   the `.gb` file into the window it opens.
2. It tells you what it wants to download -- Bun, the game's source, and
   the three data files in [§1](#the-two-reference-checkouts), each with its
   URL and licence -- and asks. Then it asks whether you want colour
   ([§6](#6-about-the-colour)). Then it cooks.
3. **Copy the `3ds` folder it leaves in `cooker/output/` onto the root of
   your SD card** and merge. It offers to do that itself if it can see the
   card.

`cooker/cooker.py` is the whole program, ordinary Python written to be
read before it is run; `cooker/README.txt` covers the rest. Nothing is
installed, everything it fetches is checked against a checksum pinned in
the file, and `output/SOURCES.txt` lists what went into your build.

The rest of this page is the same thing done by hand.

---

## 1. What you need

| | What | Why |
|---|---|---|
| **The ROM** | A canonical US **Pokémon Red** `.gb` | The only source of game content. Its SHA-1 is checked before a single byte is decoded. |
| **Bun** | [bun.sh](https://bun.sh) | Runs the importer and the cooker. |
| **Rust** | [rustup.rs](https://rustup.rs) | Builds the console binary. |
| **python3** | usually already there | One step needs it: hoisting the shared atlas. |
| **devkitPro** | [devkitpro.org](https://devkitpro.org/wiki/Getting_Started), with `3ds-dev` | The 3DS toolchain. |
| **cargo-3ds** | `cargo install cargo-3ds` | Drives devkitARM from Rust. |
| **Two reference checkouts** | see below | Tables this project reads but does not contain. |

A **New 3DS** (or New 2DS XL) running homebrew, and an SD card with **700 MB
free**. The New model is not optional: the port keeps a 92 MB heap for the
map paks -- the Viridian Forest pak alone is 58 MB -- and only the New
3DS's 124 MB application mode can grant it. An original 3DS/2DS cannot
start it, as a title or from the Homebrew Launcher.

### The two reference checkouts

Pocket Voxel is a *reimplementation*, not a copy, so a handful of tables it
needs live in the projects it reimplements. Clone both anywhere:

```sh
git clone https://github.com/bryanthaboi/gen1recomp
git clone https://github.com/ShaneMcGovernIE/potato_voxel
```

(`potato_voxel` is PotatoVoxel, the maintained fork of the DramaticShape
Voxel Mod; the original's repository is no longer on GitHub. The cooker
pins both checkouts to a known commit -- the two hashes are at the top of
`cooker/cooker.py` if you want to match it exactly.)

It reads exactly three files out of them:

- `gen1recomp/tools/rom_manifest.json` — the symbol table (3274 name → bank
  and address entries) that drives the importer. We consume it rather than
  transcribing a megabyte of addresses.
- `gen1recomp/data/palettes_gbc.lua` — **the colour**. See
  [§6](#6-about-the-colour) — worth reading before you build.
- `potato_voxel/data/voxel_heights.lua` — which tile is a wall, a roof, a
  ledge; the building templates. Hand-authored by that mod, nothing in it
  comes from a ROM. The mod's code carries no licence file; its author has
  given this project permission to use the table (asked and answered,
  September 2026). The renderer itself is reimplemented, not copied, and
  the table is read off your checkout at cook time the way the ROM is.
  Without it every building cooks flat.

---

## 2. Get the code

```sh
git clone --recursive https://github.com/imantheman/pocket-voxel3d
cd pocket-voxel3d
bun install
```

`--recursive` matters — it pulls the `vendor/pocketjs` submodule. If you
forgot it: `git submodule update --init`.

---

## 3. Point it at your three inputs

```sh
export VOXELMON_ROM=/path/to/PokemonRed.gb
export VOXELMON_G1R=/path/to/gen1recomp
export VOXELMON_VOXELMOD=/path/to/potato_voxel
```

Put those three lines in your shell profile and you never think about them
again. Every command below reads them; anything missing prints which one
and stops rather than half-building.

---

## 4. Build it

Two commands.

```sh
bun tools/voxel.ts import    # your ROM -> dist/voxelmon/gen/   (~10 seconds)
bun tools/voxel.ts 3ds       # everything else                  (~15 minutes)
```

The second one does four things you would otherwise do by hand:

1. **Cooks 222 paks, one per map.** The 3DS streams one map's pak off the
   card at a time instead of holding a single 31 MB pak in RAM the way the
   PSP does, so its content build is the cooker run once per map.
2. **Hoists the shared atlas.** 654 of the ~2460 pages are byte-identical in
   every pak — the sprites, the font, the UI, the battle furniture. They go
   into one `common.vxat` the console reads once, instead of a megabyte
   re-read on every map change. 937 MB becomes 617 MB + 7 MB.
3. **Merges the dataset and writes the map index.** A single-map cook writes
   a `gamedata.json` pinned to that one map, so the one the game boots from
   has to be assembled out of all 222.
4. **Lays out the card image** under `dist/voxelmon/sdcard/`, and builds the
   `.3dsx` into it.

When it finishes you have:

```
dist/voxelmon/sdcard/
└── 3ds/
    ├── pocketvoxel-3ds.3dsx
    └── voxelmon/
        └── paks/
            ├── AGATHAS_ROOM.vxpak      (222 of these)
            ├── common.vxat
            ├── gamedata.json
            └── index.txt
```

Once it is done you can delete `dist/voxelmon/paks_orig/` — it is the
937 MB of pre-sharing intermediates and nothing reads it again.

---

## 4b. Optional: an installable title (.cia)

`.3dsx` runs from the Homebrew Launcher. A `.cia` **installs**, so the game
gets its own icon on the HOME menu with a proper banner. Same game either
way — the CIA carries only the executable, and it still reads its paks from
`/3ds/voxelmon/paks` on the card, so §5 applies regardless.

```sh
bash tools/make_cia.sh          # -> dist/voxelmon/PocketVoxel3DRed.cia
```

Needs two tools `cargo-3ds` does not bring:

- **makerom** — [Project_CTR](https://github.com/3DSGuy/Project_CTR)
  releases. Nothing else produces the format.
- **bannertool** — makes the `.smdh` icon and the `.bnr` banner.

Install it with FBI. It is **test-signed**, which is how all homebrew CIAs
are built, so it needs a console with signature patches (Luma3DS's default);
without them the install fails on the signature check and the `.3dsx` route
is the one to use.

The icon and banner are ours: `tools/3ds_art.py` draws them from authored
letterforms, and `tools/3ds_banner3d.py` rebuilds the banner's 3D scene so
the cube under the title is real geometry, not a picture of one. The boot
logo is makerom's own Homebrew splash, not one of Nintendo's.

---

## 5. Put it on the card

**Copy the `3ds` folder from `dist/voxelmon/sdcard/` onto the root of your
SD card, and say yes when it asks to merge.**

That is the whole install. Your card already has a `/3ds` folder if you run
homebrew, and merging adds ours beside whatever is in it.

If you would rather place the files yourself, this is where they go:

```
(SD card root)
└── 3ds/
    ├── pocketvoxel-3ds.3dsx       ← the app
    └── voxelmon/
        └── paks/                  ← all 225 files, together
```

Then launch the **Homebrew Launcher** and pick Pocket Voxel from the list.

The game creates two more files itself on first run, in
`/3ds/voxelmon/`: `save.lua` (your save — back this up, nothing else will)
and `pvlog.txt` (a log worth having if you report a problem).

### The one rule about copying

**`gamedata.json`, `common.vxat` and all 222 paks are ONE artifact.** Atlas
page indices are positional, so a `gamedata.json` from one build against
paks from another renders the wrong art everywhere — wrong sprites, wrong
tiles, and no error message. Whenever you rebuild, copy the whole `paks`
folder across. Never a single pak, and never just the `.3dsx`.

Your `save.lua` is not part of that artifact and is safe to keep.

---

## 5b. Two players: the Cable Club

The Cable Club works, without a cable. Both consoles need to be on the
**same wifi network** (a New 3DS on the house wifi, an emulator on a PC
on the same wifi -- any mix). With no network at all, two consoles find
each other over 3DS local wireless instead; that path is untested.

1. Both players walk up to the **receptionist on the right** of any
   Pokémon Center and apply. She saves the game and waits up to a minute
   for the other console to do the same.
2. Both pick the same room -- **TRADE CENTER** or **COLOSSEUM** -- and are
   walked in, one to each end of the table in the middle.
3. Either player steps onto the stool at their end of the table and
   presses **A** into the machine. The other console is brought to the
   table wherever its player is standing.
   A trade: pick one of yours, then one of theirs; the other player says
   yes or no, and nothing changes hands until both have agreed. A battle:
   it runs on both consoles at once, each picking its own moves and
   switches, with no items, no running, no experience gained and the
   party put back the way it was afterwards, as in the original.
4. **Walk out along the bottom row** of the room to leave. The link
   closes on both consoles and you are back at the desk. The other player
   sees you vanish and can walk out too.

Talking to the other player's body says "!", which is what the ROM has
them say -- the machine is the thing to press.

It is UDP on ports **51325-51328** between the two machines; a firewall
that blocks those on a PC blocks the emulator from linking. Every frame
is acknowledged and resent, so a dropped packet costs a moment, not the
trade. A console that goes quiet for eight seconds is treated as gone.
Two emulator instances on one PC can link with each other (they take
consecutive ports), which is how this is tested without two consoles.

---

## 6. About the colour

Worth understanding before you build, because it is the one part of this
that is not simply your ROM.

**Pokémon Red has no colour in it.** It ships no Game Boy Color code at
all — there is no palette table in your cartridge to read. So the greens and
reds you see on the maps cannot have come from your ROM, and they are not
something this project's code invents either.

They come from the third file in §1: `gen1recomp/data/palettes_gbc.lua`,
which that project generates from
[pokered-gbc](https://github.com/Stewmath/pokered-gbc), a community
colourisation of the Red disassembly. By its own header it carries the
overworld tile and roof colouring, and **the per-species palettes from Gen
2's `MonsterPalettes` table**.

So: the world's colours are that community project's authoring, and the
creature colours trace back to Gold and Silver.

What this repository does about it is **contain none of it**. Not a byte is
committed here. It is read at cook time out of a checkout you cloned
yourself, and the converted form lands in git-ignored `dist/`. Every colour
in your build is assembled on your machine out of inputs you supplied — the
same arrangement as the ROM itself.

**If you would rather not have it**, leave `VOXELMON_G1R/data/palettes_gbc.lua`
out of the picture and the cook degrades on purpose: no palette tail, every
binding reads NONE, and the maps render in Game Boy grayscale — which is what
the original actually looked like. You still need the rest of that checkout
for the symbol table.

---

## 7. When it goes wrong

**`ROM not found` / `SHA-1 mismatch`**
`VOXELMON_ROM` is unset, or the file is not the canonical US Red. The
importer refuses rather than decoding something it does not recognise.

**`gen1recomp manifest not found` / `profile not found`**
`VOXELMON_G1R` or `VOXELMON_VOXELMOD` is unset or points somewhere without
the file named in §1. (The cooker sets both itself.)

**`the atlas hoist failed`**
That step is the one thing here that needs `python3` on your PATH.

**`cargo 3ds` not found, or devkitARM errors**
`cargo install cargo-3ds`, and make sure devkitPro's `3ds-dev` package is
installed and `DEVKITPRO` / `DEVKITARM` are exported.

**The game boots to a black screen, or the art is visibly wrong**
Almost always a half-copied card: paks from one build, `gamedata.json` from
another. Re-copy the whole `paks` folder.

**The CIA launches straight to "An error occurred (ErrDisp): The SD card
was removed"**
The title has no logo. A title launched from the HOME menu is handed its
logo for the launch transition, and one without any fails there -- with an
error that says nothing about logos, and that a `.3dsx` never hits because
the Homebrew Launcher never asks. Every CIA that runs carries a `logo`
entry in its ExeFS. `tools/make_cia.sh` passes `-exefslogo` and the RSF
sets `Logo: Homebrew` (makerom's own splash, not one of Nintendo's); if
you have written your own build, do both. It also runs fine in Citra,
which does not go through the HOME menu's launch path.

While there, keep the exheader honest: an SD-installed title should grant
exactly `DirectSdmc` and `DirectSdmcWrite` under `FileSystemAccess` and
nothing under `IoAccessControl`.

**Luma's exception screen at launch: `prefetch abort (svcBreak)`, with
`R4`/`R5` pointing at `__ctru_heap_size` / `__ctru_linear_heap_size`**
libctru could not allocate the heap the host asks for (92 + 24 MB). Either
the console is an original 3DS -- see §1 -- or the CIA was built with
`SystemModeExt` set to anything but `124MB`. `tools/pocketvoxel.rsf` sets it.

**It boots but cannot save**
The game tests the card on startup. A write-protected or full SD card is the
usual cause; `/3ds/voxelmon/pvlog.txt` says which.

---

## 8. What this is

The gameplay is a TypeScript port of the
[gen1recomp](https://github.com/bryanthaboi/gen1recomp) Lua engine, running
in an embedded QuickJS guest. The presentation is a Rust reimplementation of
the DramaticShape Voxel Mod diorama renderer, as carried on by
[PotatoVoxel](https://github.com/ShaneMcGovernIE/potato_voxel).
gen1recomp is MIT; the voxel mod's code carries no licence file (its author
has okayed this project's use of its shape table), and its renderer is
reimplemented here rather than copied. Both serve as executable
specifications, not vendored code — see [docs/VOXEL.md §1](VOXEL.md) for
the content boundary in full.

The same repository also builds for PSP and PS Vita; the
[README](../README.md) covers those.
