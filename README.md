# Pocket Voxel 3D Red and Blue

The first Game Boy creature-RPG, rebuilt as a 3D voxel diorama that runs on a
**New Nintendo 3DS / New 2DS XL** with the stereoscopic slider doing real 3D.
Trade and battle between two consoles on the same wifi. Colour, or the original
black and white: your choice.

**You bring the game.** Nothing from any cartridge is in this repository or
in the download. A small program on your computer reads *your own* Pokémon
Red or Blue (US) `.gb` file and turns it into the files the 3DS needs. The ROM
never leaves your machine.

---

## Get it on your 3DS (no computer skills needed)

**You need**

- A **New** 3DS, New 3DS XL or New 2DS XL, with homebrew already on it
  (the Homebrew Launcher, or FBI). An original 3DS / 2DS is too slow.
- An SD card with **700 MB free**.
- A Windows PC or a Mac, with internet for the first run.
- Your own US Pokémon Red or Blue `.gb` file. The program checks it is the
  real one and refuses anything else. Red and Blue are separate games on
  the 3DS, each with its own save; cook whichever you have, or both.

**Step by step (Windows)**

1. Go to the **[Releases page](https://github.com/imantheman/pocket-voxel3d/releases/latest)**
   and download `PocketVoxel-Cooker.zip`.
2. Right-click the zip and choose **Extract All**. Open the folder it made.
3. **Drag your `.gb` file onto `Cook Pocket Voxel.bat`.** A black window opens.
4. Answer its questions. `Y` to let it download its tools (about 45 MB, each
   one listed with a link). Then pick colour or black and white. It runs for
   about 20 minutes; most of that is waiting.
5. When it says **Done**, there is a new folder next to the bat called
   `output`. Open it, then open the `3ds` folder inside it. You will see two
   things: a folder called `voxelmon` and a file ending in `.3dsx`
   (`pocketvoxel-3ds.3dsx` for Red, `pocketvoxel-3ds-blue.3dsx` for Blue).
6. Put your SD card in the PC and open it. It already has a folder called
   `3ds` (that is where homebrew lives). **Open that `3ds` folder**, then
   **copy the `voxelmon` folder and the `.3dsx` file into it**, next to
   whatever is already there. If the other game is already on the card, say
   yes to replacing files: Red and Blue share the map files, and both keep
   working.
7. Put the card back in the 3DS. Open the **Homebrew Launcher** and pick
   **Pocket Voxel**.

**Want it on the HOME menu instead?** The files `PocketVoxel3DRed.cia` and
`PocketVoxel3DBlue.cia` are in the same folder as the bat; use the one for
your game. Copy it anywhere on the SD card, open **FBI** on
the 3DS, find the file, and choose **Install**. It reads the same `voxelmon`
folder from step 6, so do step 6 either way.

**Mac:** double-click `Cook Pocket Voxel.command` instead of step 3. If the
Mac says it is from an unidentified developer, right-click it and choose
**Open**. When it asks for the ROM, drag the `.gb` file into the window and
press Return. Everything else is the same.

**Linux:** `./cook.sh /path/to/your-rom.gb`

### If something goes wrong

- **"That is not the US Pokemon Red or Blue ROM."** The file is a different
  version, a colour hack, another region, or a bad dump. Only the original
  US Red and Blue work.
- **The window closes at once.** Python is missing. Run the bat again; it
  offers to fetch a portable Python into its own folder. Say `Y`.
- **The 3DS shows a black screen, or the game is missing maps.** The
  `voxelmon` folder was copied partly, or landed in the wrong place. It must
  be at `SD:/3ds/voxelmon`, and the 225 files in `SD:/3ds/voxelmon/paks`
  belong together. Copy the whole `voxelmon` folder again; never one file.
- **It says the SD card is full.** It needs 700 MB. Free some space and copy
  again.
- **Homebrew Launcher does not list it.** The `.3dsx` must be directly in
  `SD:/3ds/`, not inside another folder.
- Anything else: open an issue on this page and paste what the black window
  said. Everything it does is written to the screen.

### Playing with a friend

Both consoles need the game, and both need to be on the **same wifi
network**. Walk into any Pokémon Center, talk to the receptionist at the
right-hand counter, and pick **TRADE CENTER** or **COLOSSEUM**. The two
consoles find each other on the wifi by themselves; there is nothing to set
up. Then step onto the stool at your end of the table and press **A**.

Red and Blue link with each other, just like the cartridges did.

---

## What this is, for the curious

The gameplay is a port of the
[gen1recomp](https://github.com/bryanthaboi/gen1recomp) engine, with some of
its code carried over, running in an embedded JavaScript guest. The 3D presentation comes from the
[PotatoVoxel](https://github.com/ShaneMcGovernIE/potato_voxel) diorama
renderer, reimplemented in Rust for the 3DS's GPU. Colour comes from the
community colourisation [pokered-gbc](https://github.com/Stewmath/pokered-gbc);
the original cartridge has none.

This repository, gen1recomp and pokered-gbc are MIT-licensed. PotatoVoxel's
shape table is used with its author's permission, and its renderer is
reimplemented here, not copied. The one thing that is not free is the game content, which is why you supply it
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
