# Pocket Voxel 3D

Five Game Boy creature-RPGs -- Red, Blue, Yellow, Gold and Silver -- rebuilt as 3D voxel dioramas that
run on a **New Nintendo 3DS / New 2DS XL** with the stereoscopic slider doing
real 3D. Trade and battle between two consoles on the same wifi. Each game can
also be played on the original flat Game Boy screen, in its OPTION menu.

**You bring the game.** Nothing from any cartridge is in this repository or
in the download. A small program on your computer reads *your own* US
Red, Blue, Yellow, Gold or Silver cartridge file and turns it into the files the 3DS
needs. The ROM never leaves your machine.

---

## Get it on your 3DS (no computer skills needed)

**You need**

- A **New** 3DS, New 3DS XL or New 2DS XL, with homebrew already on it
  (the Homebrew Launcher, or FBI). An original 3DS / 2DS is too slow.
- An SD card with room: about **350 MB** for Red and Blue (they share their
  maps), **350 MB** for Yellow, **500 MB** for Gold and Silver (they share
  theirs).
- A Windows PC or a Mac, with internet for the first run.
- Your own US Red, Blue or Yellow cartridge file (`.gb`, Yellow's may be `.gbc`) or
  Gold or Silver (`.gbc`) file. The program checks it is the real one and
  refuses anything else. Each game is its own game on the 3DS, with its own
  save; cook whichever you have, one after another.

**Step by step (Windows)**

1. Go to the **[Releases page](https://github.com/imantheman/pocket-voxel3d/releases/latest)**
   and download `PocketVoxel-Cooker.zip`.
2. Right-click the zip and choose **Extract All**. Open the folder it made.
3. **Drag your ROM file onto `Cook Pocket Voxel.bat`.** A black window opens.
4. Answer its questions. `Y` to let it download its tools (about 45 MB, each
   one listed with a link). Red, Blue and Yellow then ask about colours
   (Gold and Silver just use their own). It runs for about 20 minutes; most
   of that is waiting.
5. When it says **Done**, there is a new folder next to the bat called
   `output`. Open it, then open the `3ds` folder inside it. You will see two
   things: a folder called `voxelmon` and a file ending in `.3dsx`
   (`pocketvoxel-3ds.3dsx` for Red, `-blue`, `-yellow`, `-gold` or `-silver`
   for the others).
6. Put your SD card in the PC and open it. It already has a folder called
   `3ds` (that is where homebrew lives). **Open that `3ds` folder**, then
   **copy the `voxelmon` folder and the `.3dsx` file into it**, next to
   whatever is already there. If another game is already on the card, say
   yes to replacing files: every game keeps working (Red and Blue share map
   files, as do Gold and Silver; Yellow has its own).
7. Put the card back in the 3DS. Open the **Homebrew Launcher** and pick
   **Pocket Voxel**.

**Want it on the HOME menu instead?** Each game has a `.cia`
(`PocketVoxel3DRed.cia`, `PocketVoxel3DBlue.cia`, `PocketVoxel3DYellow.cia`,
`PocketVoxel3DGold.cia`, `PocketVoxel3DSilver.cia`) in the same folder as the
bat; use the one for your game. Copy it anywhere on the SD card, open **FBI** on
the 3DS, find the file, and choose **Install**. It reads the same `voxelmon`
folder from step 6, so do step 6 either way.

**Mac:** double-click `Cook Pocket Voxel.command` instead of step 3. If the
Mac says it is from an unidentified developer, right-click it and choose
**Open**. When it asks for the ROM, drag the ROM file into the window and
press Return. Everything else is the same.

**Linux:** `./cook.sh /path/to/your-rom.gb`

### If something goes wrong

- **"That is not the US Red, Blue, Yellow, Gold or Silver ROM."**
  The file is a different version (Crystal is not supported), a hack,
  another region, or a bad dump. Only the original US games work.
- **The window closes at once.** Python is missing. Run the bat again; it
  offers to fetch a portable Python into its own folder. Say `Y`.
- **The 3DS shows a black screen, or the game is missing maps.** The
  `voxelmon` folder was copied partly, or landed in the wrong place. It must
  be at `SD:/3ds/voxelmon`, and the files in each map folder inside it
  (`paks`, `paks_yellow`, `paks_gold`) belong together. Copy the whole
  `voxelmon` folder again; never one file.
- **It says the SD card is full.** See the sizes under **You need**. Free some
  space and copy again.
- **Homebrew Launcher does not list it.** The `.3dsx` must be directly in
  `SD:/3ds/`, not inside another folder.
- Anything else: open an issue on this page and paste what the black window
  said. Everything it does is written to the screen.

### Playing with a friend

Both consoles need the game, and both need to be on the **same wifi
network**. Walk into any healing center, talk to the receptionist at the
right-hand counter, and pick **TRADE CENTER** or **COLOSSEUM**. The two
consoles find each other on the wifi by themselves; there is nothing to set
up. Then step onto the stool at your end of the table and press **A**.

Red, Blue and Yellow link with each other, and so do Gold and Silver, just
like the cartridges did. Gold and Silver also trade with Red, Blue and Yellow
through the **TIME CAPSULE**, and have **MYSTERY GIFT** once it opens up.

---

## What this is, for the curious

The gameplay is a port of the
[gen1recomp](https://github.com/bryanthaboi/gen1recomp) engine, with some of
its code carried over, running in an embedded JavaScript guest. The 3D presentation comes from the
[PotatoVoxel](https://github.com/ShaneMcGovernIE/potato_voxel) diorama
renderer, reimplemented in Rust for the 3DS's GPU; Gold and Silver's shapes
come from UNDERdecoded's
[Gen2Recomped-DramaticShapes](https://github.com/UNDERdecoded/Gen2Recomped-DramaticShapes)
(MIT). Red and Blue's colour comes from the community colourisation
[pokered-gbc](https://github.com/Stewmath/pokered-gbc) (the original
cartridge has none); Yellow, Gold and Silver use their own Game Boy Color
colours, read from your ROM.

The bottom screen is modelled on the
[Kanto Gear](https://github.com/AverageConsumer/kanto-gear) mod.

This repository is MIT-licensed, and so are the gen1recomp version it builds
on and Kanto Gear; their notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). PotatoVoxel's shape table is
used with its author's permission, and its renderer is reimplemented here, not
copied. The pokered-gbc colours are downloaded by the converter on your
machine and never shipped here. The one thing that is not free is the game content, which is why you supply it
yourself: the converter reads your cartridge dump on your machine, and **no
ROM-derived byte is ever committed here**. The rendering tests are frame
hashes, never pixels.

## For developers

**[docs/3DS.md](docs/3DS.md)** is the full walkthrough: toolchains, the build,
the SD card layout, the Cable Club, and how the paks are cooked and shared.
**[docs/VOXEL.md](docs/VOXEL.md)** is the design record: the content boundary,
the guest/core split, the pak format, the quality ladder, and the
determinism rules.

The short version:

```sh
git clone --recursive https://github.com/imantheman/pocket-voxel3d
cd pocket-voxel3d && bun install

export VOXELMON_ROM=/path/to/your/rom.gb      # SHA-1 verified before any decode
export VOXELMON_G1R=~/code/gen1recomp         # reference checkout: the manifest
export VOXELMON_VOXELMOD=~/code/potato_voxel  # reference checkout: tile profiles

bun tools/voxel.ts import   # your ROM -> dist/voxelmon/gen/
bun tools/voxel.ts 3ds      # -> dist/voxelmon/sdcard/   (about 15 minutes)
bun test                    # the suite; ROM-gated tests skip with a reason
```

For Blue, point `VOXELMON_ROM` at a Blue ROM instead: the same commands cook
it, and [docs/3DS.md §4c](docs/3DS.md) builds its own `.3dsx` and `.cia`.

Needs [Bun](https://bun.sh), a Rust toolchain, devkitPro with `3ds-dev`,
`cargo install cargo-3ds`, and `python3`. The `cooker/` folder is the same
build, wrapped for people who will never open a terminal; `cooker/cooker.py`
is one readable file and is what the release zip contains.

This project began as a 3DS port inside Evan Wang's
[Pocket Voxel](https://github.com/pocket-nexus/pocket-voxel), which targets
the PSP and PS Vita, and is now developed on its own. The PSP and Vita crates
are still in the tree but are not built or tested here.

## License

MIT, see [LICENSE](LICENSE). Copyright Yifeng "Evan" Wang and Isaac Dishongh.
