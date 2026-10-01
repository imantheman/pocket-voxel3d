# The Gold engine

How Pokémon Gold runs in pocket-voxel. Gen 1 and Gen 2 share the host, the
core, the cooker and the importer framework. The Gold *game* is a separate
guest engine: a module-for-module TypeScript port of gen1recomp's Gen 2
engine.

## Source and licence

The only source is **bryanthaboi/gen1recomp at bdfac727**
(`bdfac727aaccfea696be49a23c5f501451be50d5`), its last MIT commit. It is
checked out at `~/gen1recomp-mit-gen2`.

- Never use anything from 661d75ef onward. That code is GPLv3 with extra terms.
- Never pull that checkout.
- Formats may be read from the pret disassembly at `/tmp/pky/pokegold`. No
  code is copied from it.
- Every ported function cites its Lua origin, as `// Lua: World.lua:1234`,
  and the pokegold label where Brian cites one.

## Layout

The Lua tree maps onto the TypeScript tree like this (see
`tools/gen2_stubs.py`):

| gen1recomp | voxelmon/game/gen2 |
|---|---|
| `src/<dir>/gen2/X.lua` | `<dir>/X.ts` (core, world, script, battle, ui) |
| `src/core/Game2.lua` | `core/Game2.ts` |
| any other `src/<path>.lua` that Gen 2 requires | `shared/<path>.ts` |
| (new, ours) | `platform/` — the seam to our host |

`tools/gen2_stubs.py` wrote one stub per module. Each stub's first line is
`// @gen2-stub`, and each of its functions throws `notPorted("World:foo")`.
Porting a module means replacing its stub file wholesale and dropping the
marker. `grep -rl '@gen2-stub' voxelmon/game/gen2` lists what is left to port.

The desktop-only shared modules are **inert**: their functions return
`undefined`. That covers window, scaling, shaders, gamepads, the launcher,
mods, online play, Discord and the printer. A port drops calls into them
rather than depending on them.

## Porting conventions

- **One file per Lua file, same name, same exported name.**
  - A class-like module (`X.__index = X`, `X.new(...)`) becomes
    `export class X`. Keep `static new(...)` as the factory so `X.new()` call
    sites survive. Colon methods become instance methods, and `self` becomes
    `this`.
  - A plain module table becomes `export const X = { ... }`, typed properly.
  - Every file also ends with `export default X`.
  - Import siblings by relative path with the `.ts` suffix. Circular imports
    are fine as long as nothing is used at module top level.
- **Faithful first.** Keep Brian's control flow, names, constants, frame
  counts and quirks, including his deliberate cart-bug emulation. Improve
  nothing unless it cannot run here.
- **Lua semantics to watch:**
  - **Truthiness:** `0` and `""` are true in Lua. Use `truthy()` from
    `platform/lua.ts`, or an explicit `!= null`.
  - **Indexing:** Lua sequences are 1-based.
    - Importer JSON arrays are 0-based JS arrays of what the Lua saw as
      sequences, so Lua `t[i]` (i from 1) becomes `t[i - 1]`.
    - Loops can be rewritten 0-based.
    - Game ids (species, moves, items, map group/number, event flags) keep
      their game values.
    - Tables keyed by name stay keyed by name.
  - **Strings and tables:** `#t` is `t.length`, and `#s` is `s.length`. Use
    `sub()`, `format()`, `insertAt()`, `removeAt()`, `idiv()`, `mod()`,
    `tonumber()` and `tostring()` from `platform/lua.ts`.
  - **Patterns:** translate Lua patterns to JS regexes by hand; `%a %d %s %w`
    become `[A-Za-z] \d \s \w`.
  - **Bits:** `bit.band`/`bor`/`bxor`/`lshift`/`rshift` become
    `& | ^ << >>>`.
  - **Iteration order:** `pairs()` order is undefined. Where the order
    matters, use `sortedKeys()`.
  - **Randomness:** `love.math.random` and `math.random` become `random()`
    from `platform/rng.ts`, with Lua's argument rules. It is seeded, so
    replays are deterministic.
- **Data:** `loadGenerated("pokemon")` from `platform/data.ts` stands in for
  `loadGenerated("data/generated/pokemon.lua")`. The tables are the importer's
  JSON in `dist/voxelmon/gold/gen/*.json`. Their shapes are Brian's; image
  paths are gfx keys, not `assets/generated/...png`. In tests, call
  `useGoldGen()` from `platform/data-node.ts`, and skip when `haveGoldGen()`
  is false.
- **Mods:** `shared/mods/Runtime.ts` is Brian's null bus. `call()` runs the
  vanilla function; `emit`, `wants` and `wantsHook` do nothing. Keep the call
  sites; they cost nothing.
- **Clock:** `os.time`/`os.date` go through `platform/clock.ts` (to be
  written), which reads the host's wall clock the way Brian's `Clock.lua`
  reads the OS clock.
- **Types:** type what you port. Where another directory's module is still a
  stub, its members are `any`. That is fine; do not invent its types.
- **Tests:**
  - Put each area's tests in `tests/voxel-gen2-<area>.test.ts`.
  - Prefer checks against real data (the NEW_BARK_TOWN scripts, BULBASAUR's
    stats, FALKNER's party) over synthetic ones.
  - Run `bun test tests/voxel-gen2-*.test.ts` and `bunx tsc --noEmit -p .`,
    filtering to your own files. Other directories are being ported at the
    same time.

## Rendering: what replaces LÖVE

gen1recomp paints Gold into a 160x144 LÖVE canvas. Here there are three
outputs.

1. **The Gold screen** (`crates/pocketvoxel-core/src/lcd.rs`, and
   `platform/lcd.ts` on the guest side).
   - It is a Game Boy Color's picture model without the hardware budgets:
     - two 32x32 maps (background, window) of 16-bit tile ids plus CGB
       attribute bytes;
     - up to 128 8x8 objects at signed screen coordinates;
     - 16 background and 16 object palettes.
   - A **hole** cell (attribute bit 4) lets the 3D world show through. A
     text box over the overworld is box cells in a sea of holes.
   - It is immediate mode. Each frame the active screen calls `lcd.begin()`,
     draws, and then `lcd.end()` sends only what changed.
   - Tile ids are fixed for the whole run. Every Gold graphic (fonts, frames,
     menus, pics, icons, battle, intro/title) is cooked into tile pages. The
     cook's manifest gives each gfx key a grid of tile ids, and `Assets`
     resolves a key to it.
   - Screens do not touch VRAM.
2. **The voxel world**, through the scene ops (`mapShow`, `cam`, `ent`,
   `pitch`, `tint`, …).
   - `World.lua` and its modules keep their logic and state.
   - Their pixel drawing is replaced by `platform/worldview.ts` (to be
     written), which reads World, Player and Npc state each frame: map,
     positions in pixels, facing, walk frame, sprite, visibility, emotes,
     field effects, fades, time of day. It emits the scene.
   - Porting `World.lua` means keeping that state exact and dropping the
     canvas code.
3. **Sound**, through the chip-synth ops (`music`, `sfx`, `cry`). The core
   gains a Gen 2 sound engine; the guest's `Sound`/`Music` resolve names to
   (bank, address, engine) the way Gen 1 does.

The drawing stack for screens is:

- `shared/render/Font.ts`
- `shared/render/GbcPalette.ts`
- `shared/render/Assets.ts`
- `ui/Chrome.ts`
- `shared/render/TextBox.ts`
- `ui/Typer.ts`

These are ported onto the Gold screen, keeping Brian's API: `Chrome.box`,
`Chrome.print(text, tx, ty)`, `Font.drawCode`, `GbcPalette.with(pal, fn)`,
`Assets.image(key)`. Ported screens keep their draw code in those terms.

Pixel-positioned image draws become objects, and grid-aligned ones become
cells. `Assets`/`Chrome` provide `drawImage(key, x, y, opts)`, which picks
between them.

Battles draw on the Gold screen first: full-screen and opaque, exactly as
pokegold. Moving them onto the 3D arena the way Gen 1 does comes later,
after a hardware test.

## Boot

`gen2/main.ts` (to be written) is the Gold QuickJS entry. It is bundled into
`crates/pocketvoxel-3ds/game-gold.js`, and the `gold` feature embeds that
instead of `game.js`.

1. It seeds `rng`.
2. It hands `platform/data.ts` the gamedata's tables.
3. It builds `Game2`, and `Game2.load()` runs.
4. Each host tick it pumps input into `Game2` and renders the Gold screen,
   the scene and the audio.

## Status

Steps 1 to 4 are done; step 5 is next.

1. **Platform:** the Gold screen (`lcd.rs`, `lcd.ts`), data, lua, rng, Font,
   GbcPalette, Assets, Chrome, TextBox, Input, the cook's tile pages, and the
   dataset container.
2. **Engine:** `script/`, `world/`, `battle/` (including the move-animation
   engine), `core/` and the Gen 2 sound engine.
3. **Screens:** every `ui/` module except the Crystal-only ones (CrystalIntro,
   CrystalSplash, BattleTowerMenu) and the online ArenaState.
4. **Owner and entry:** `Game2`, `main.ts`, `worldview.ts` (with day and night
   through the `daytime` op), the save, the `gold` feature embedding
   `game-gold.js`, and `cc_gold_ship.sh` for test builds.
5. **Hardware:** tune on a New 3DS: render cost, memory, bundle size and
   QuickJS speed. `tools/qjs_gold_harness.c` runs the bundle under the 3DS's
   own QuickJS on the desktop. At the title it measures about 30 MB of JS heap
   and about 1.5 ms a frame (on a PC).

Known simplifications, each marked `NOT FAITHFUL` where it lives:

- Battles are full-screen 2D on the Gold screen; the 3D arena comes later.
- Map fades cover the world at the ramp midpoint instead of remapping it.
- Front-pic animations don't play (the importer has no animation tables for
  Gold).
- Scaled pics draw unscaled.
