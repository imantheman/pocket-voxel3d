POCKET VOXEL COOKER
===================

This turns YOUR Pokemon Red, Blue or Yellow ROM into the files the 3DS game needs. There is
no download of the game anywhere, because the game is built from your
cartridge, on your computer. This folder does that for you.

You need:  a New 3DS (or New 2DS XL) with homebrew, an SD card with 400 MB
free, your own US Pokemon Red, Blue or Yellow file, and an internet connection for the
first run. Budget 20 minutes, most of it waiting.


WINDOWS
-------
Drag your .gb file (Yellow's is .gbc) onto "Cook Pocket Voxel.bat". A window opens and walks
you through it. If Python is not on the PC it offers to fetch the official
portable one into this folder first.

MAC
---
Double-click "Cook Pocket Voxel.command". If the Mac says it is from an
unidentified developer, right-click it and choose Open. When it asks for
the ROM, drag the .gb file into the window and press Return.

LINUX
-----
    ./cook.sh /path/to/PokemonRed.gb


WHAT IT ASKS
------------
1. Whether it may download its tools (about 45 MB, listed on screen with
   the URL and license of each one -- every download is checked against a
   checksum written in cooker.py).
2. Whether you want colour. Red and Blue are black and white; the colour is
   a community colourisation (pokered-gbc). Say no for the original look.
   Yellow is not asked: it is a Game Boy Color game and uses its own
   colours, read from your ROM.
3. At the end, whether to copy the result straight onto your SD card if
   it can see one.


WHAT YOU GET
------------
    output/
      3ds/
        pocketvoxel-3ds.3dsx      <- copy THIS FILE and the voxelmon FOLDER
        voxelmon/paks/               INTO the 3ds folder that is already on
                                     your SD card (about 330 MB)
      SOURCES.txt                 <- everything that went into the build

Open the SD card, open its `3ds` folder, and put `voxelmon` and
`pocketvoxel-3ds.3dsx` inside it, beside whatever else is there. Do not
drag the whole `3ds` folder onto the card: if the PC asks about merging
or replacing, you are one level too high, and a wrong answer there can
wipe your other homebrew.

Then open the Homebrew Launcher on the 3DS and pick Pocket Voxel. Or
install PocketVoxel3DRed.cia (it is in this folder) with FBI for a HOME
menu icon; it reads the same paks.

The two game files, pocketvoxel-3ds.3dsx and PocketVoxel3DRed.cia, are in
this folder already. They are the engine, built from the source in this
repository; nothing from any ROM is in them. The cooker puts the .3dsx
into output/3ds for you.

The 225 files in paks/ belong together. Whenever you rebuild, copy the
whole folder again, never one file.


HOW TO READ IT
--------------
cooker.py is the whole program. It is about 500 lines of ordinary Python
with a comment on every step, written to be read before it is run. The
.bat and .sh files only find a Python to run it with.

Everything it fetches lands in _work/. Everything it makes lands in
output/. Delete the folder and your computer is as it was.
