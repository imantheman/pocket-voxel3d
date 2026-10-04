POCKET VOXEL COOKER
===================

This turns YOUR Red, Blue, Yellow, Gold, Silver or Crystal ROM into the files the 3DS game needs. There is
no download of the game anywhere, because the game is built from your
cartridge, on your computer. This folder does that for you.

You need:  a New 3DS (or New 2DS XL) with homebrew, an SD card with 400 MB
free, your own US Red, Blue, Yellow, Gold, Silver or Crystal file, and an internet connection for the
first run. Budget 20 minutes, most of it waiting.


WINDOWS
-------
Drag your .gb file (Yellow's, Gold's, Silver's and Crystal's are .gbc) onto "Cook Pocket Voxel.bat". A window opens and walks
you through it. If Python is not on the PC it offers to fetch the official
portable one into this folder first.

MAC
---
Double-click "Cook Pocket Voxel.command". If the Mac says it is from an
unidentified developer, right-click it and choose Open. When it asks for
the ROM, drag the .gb file into the window and press Return.

LINUX
-----
    ./cook.sh /path/to/red.gb


WHAT IT ASKS
------------
1. Whether it may download its tools (about 45 MB, listed on screen with
   the URL and license of each one -- every download is checked against a
   checksum written in cooker.py).
2. Which colours you want.
     Red and Blue: black and white (the original look), or the community
     colourisation (the default).
     Yellow: its own colours read from your ROM (the
     default), black and white, or the community colours.
     Gold, Silver and Crystal are not asked: they use their own colours,
     read from your ROM.
   (--palette dmg|gbc|community answers it without asking.)
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

That is Red's. Each game has its own .3dsx and map folder:

    Red      pocketvoxel-3ds.3dsx          voxelmon/paks
    Blue     pocketvoxel-3ds-blue.3dsx     voxelmon/paks
    Yellow   pocketvoxel-3ds-yellow.3dsx   voxelmon/paks_yellow
    Gold     pocketvoxel-3ds-gold.3dsx     voxelmon/paks_gold
    Silver   pocketvoxel-3ds-silver.3dsx   voxelmon/paks_gold
    Crystal  pocketvoxel-3ds-crystal.3dsx  voxelmon/paks_crystal

Gold and Silver share one set of map files (voxelmon/paks_gold), the way Red
and Blue share theirs: cook one, copy it, then cook the other and copy it over
the top, and both play as their own cartridge. Crystal's maps are its own
(voxelmon/paks_crystal), so it sits beside the others untouched. Its 1.0 and
1.1 ROMs both work.

Open the SD card, open its `3ds` folder, and put `voxelmon` and
`pocketvoxel-3ds.3dsx` inside it, beside whatever else is there. Do not
drag the whole `3ds` folder onto the card: if the PC asks about merging
or replacing, you are one level too high, and a wrong answer there can
wipe your other homebrew.

Then open the Homebrew Launcher on the 3DS and pick Pocket Voxel. Or
install the game's .cia (PocketVoxel3DRed.cia, PocketVoxel3DBlue.cia,
PocketVoxel3DYellow.cia, PocketVoxel3DGold.cia, PocketVoxel3DSilver.cia or
PocketVoxel3DCrystal.cia,
all in this folder) with FBI for a HOME menu icon; it reads the same maps.

The game files, each game's .3dsx and .cia, are in this folder already.
They are the engine, built from the source in this repository; nothing
from any ROM is in them. The cooker puts the right .3dsx into output/3ds
for you.

The files in a map folder belong together. Whenever you rebuild, copy the
whole folder again, never one file.


UPDATING AND COOKING AGAIN
--------------------------
A new release comes with its own cooker. Unzip it into a new folder (over
the old one works too: it fetches the new source by itself), install each
game's new .cia with FBI (or copy its .3dsx into SD:/3ds/), and cook again
only when the release notes say a game's maps changed or to add a new game.
When you do cook again, delete that game's old map folder on the card
(SD:/3ds/voxelmon/paks, paks_yellow, paks_gold or paks_crystal) before
copying the new voxelmon folder in. Red and Blue share paks, Gold and Silver
share paks_gold: cook again one of a pair, and cook and copy the other too.
Never delete the save files.


YOUR SAVES
----------
Each game's save is one file in SD:/3ds/voxelmon/:

    Red      save.lua            Gold     save_gold.lua
    Blue     save_blue.lua       Silver   save_silver.lua
    Yellow   save_yellow.lua     Crystal  save_crystal.lua

Copy it to your computer to back it up; copy it back to restore.

They are the same format as gen1recomp's saves on a PC, so a game moves
between the two either way. gen1recomp keeps them in its data folder: on
Windows, type %APPDATA% into File Explorer's address bar and open
gen1recomp's folder (the one holding a "saves" folder and options.lua).
Inside "saves" is a folder per game (red, blue, yellow, gold, silver,
crystal) with slot1.lua in it.

    PC to 3DS:  copy saves/<game>/slot1.lua to SD:/3ds/voxelmon/ and rename
                it as in the list above (saves/gold/slot1.lua -> save_gold.lua).
                An older Gold, Silver or Crystal save may be save_<game>.lua
                right in the data folder instead; copy that.
    3DS to PC:  copy the card's file into saves/<game>/ (make the folder if
                needed) and rename it slot1.lua. Close gen1recomp first.

Keep a copy of whatever you replace. A save the game cannot read is never
written over: the title screen says why, and the file is copied to
<name>.unreadable first.


HOW TO READ IT
--------------
cooker.py is the whole program. It is about 500 lines of ordinary Python
with a comment on every step, written to be read before it is run. The
.bat and .sh files only find a Python to run it with.

Everything it fetches lands in _work/. Everything it makes lands in
output/. Delete the folder and your computer is as it was.
