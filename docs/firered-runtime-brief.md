# FireRed runtime port — brief for a porting worker

You are porting part of gen1recomp's FireRed/LeafGreen **runtime** (the game:
`src/core/game3`, `src/ui/game3`, `src/core/Game3.lua` and the shared modules
they use) from Lua to TypeScript, module for module, to run under QuickJS on
the 3DS. Read first:
- `docs/firered-port-brief.md`: the **Environment** section (Git Bash
  traps, WSL, scripts via the Write tool, `python3` is Windows, NO git
  commands, ownership rules), the licence header and the existing importer
  APIs. Those rules all apply here too.
- `docs/gold-engine.md` §"Porting conventions": the Gen 2 runtime port's
  rules, which apply EXCEPT where this brief overrides them (tables!).
- `docs/firered-engine.md`: the plan and the display design.

## Layout

| Lua (`~/gen1recomp-latest/src/...`) | TypeScript (`voxelmon/game/gen3/...`) |
|---|---|
| `core/game3/<p>.lua` | `core/<p>.ts` |
| `ui/game3/<p>.lua` | `ui/<p>.ts` |
| `world/game3/<p>.lua`, `battle/game3/<p>.lua` | `world/<p>.ts`, `battle/<p>.ts` |
| `core/Game3.lua` | `core/Game3.ts` |
| any other `src/<p>.lua` (shared) | `shared/<p>.ts` |
| `import/gba/<p>.lua` | `voxelmon/import/gen3/<p>.ts` (the importer port; import it, never edit it) |

**Every module already has a file.** `tools/gen3/stubs.py` wrote a stub for
each module of the runtime's require closure: the first line is
`// @gen3-stub`, every export is `any`, and every function throws
`notPorted`. Porting a module means **replacing its stub file wholesale**,
keeping the exported name (and `export default`). Import siblings by
relative path with `.ts`, whether they are ported yet or not. Never edit a
file you do not own. If something you own needs a module nobody owns and that
isn't stubbed, say so in your report.

Every file you write starts with:
`// Port of gen1recomp src/<path>.lua (GPLv3 + additional terms; see LICENSE.md).`

## THE table rule (this overrides gold-engine.md)

**Lua tables keep their Lua keys** (`voxelmon/game/gen3/platform/lt.ts`):
- A sequence is a JS array whose slot 0 is unused: `{a, b}` becomes
  `seq(a, b)` (that is, `[null, a, b]`). `t[i]` stays `t[i]`, and so does
  every index Brian computes.
- `#t` becomes `len(t)`, and `t[#t + 1] = v` becomes `t[len(t) + 1] = v` or
  `insert(t, v)`.
- `ipairs` becomes `for (const [i, v] of ipairs(t))`, and `pairs` becomes
  `for (const [k, v] of pairs(t))`. Integer keys come back as numbers.
- `table.insert`, `remove`, `sort`, `concat` and `unpack` become `insert`,
  `remove`, `sort`, `concat` and `unpack`, all from lt.ts.
- A table with string keys is a plain object, typed if you like. Objects
  with integer keys are fine too: `byId[25]`.
- Empty or absent is `== null`: **never** `=== undefined`. Cache data uses
  `null` for nil holes.
- `next(t) == nil` becomes `isEmpty(t)`.
- Lua **multiple returns are not tables.** They are 0-based JS tuples:
  `return a, b` becomes `return [a, b]`, and `local a, b = f()` becomes
  `const [a, b] = f()`. Where a call site uses only the first value, keep the
  function returning the tuple and take `[0]`.
- **Seams with 0-based code** (the importer modules: `Rom.readBytes`,
  `BgBake`, `Lz77`, `Uint8Array`s) convert with `fromArray`/`toArray` at the
  call site, with a comment.
- Data the importer modules return keeps the importer's own shape. Read the
  module before you index it: data modules built with `--objects` keep Lua
  integer keys as object keys, so `t[1]` works.

## Strings, numbers, Lua library

- **Strings are byte strings**, as in the importer: one char per byte. Lua
  source text with UTF-8 (e.g. "é" in a literal) is written as its bytes
  (`"\xC3\xA9"`).
- Use `voxelmon/import/gen3/lua.ts`, which matches LuaJIT exactly: `format`
  (string.format), `tostring`, `tonumber`, `sub`, `byte`, `char`, `rep`, `mod`
  (Lua `%`), `idiv`, `truthy`. Never use JS template literals or `String(n)`
  for numbers that reach text the player sees. `s:upper()`/`lower()`/`len()`
  become JS `toUpperCase` etc. (ASCII only, as Lua's C locale).
- **Lua patterns:** use `platform/lpattern.ts` (`find`, `match`, `matchAll`,
  `gmatch`, `gsub`), a port of Lua 5.1's matcher checked against luajit. Do
  not translate patterns to regexes.
- Bits: `bit.band`/`bor`/`bxor`/`lshift`/`rshift`/`arshift` become
  `& | ^ << >>> >>`. Add `>>> 0` where the Lua value is an unsigned 32-bit
  number, and use `Math.imul` for 32-bit multiplies.
- `math.floor`/`ceil`/`abs`/`min`/`max`/`sqrt`/`sin`/`cos` become `Math.*`.
  `math.huge` becomes `Infinity`. `math.random`/`love.math.random` become
  `random()` from `platform/rng.ts`. Gameplay RNG is Brian's own
  (`core/rng.ts`).
- `pcall(f, ...)` becomes try/catch returning `[true, ...]` or
  `[false, err]`. `error(x)` becomes `throw`. `assert(v, m)` becomes
  `if (!truthy(v)) throw new Error(m)`.
- `os.time`/`os.date`/`os.clock` go through `voxelmon/game/gen2/platform/clock.ts`
  (`osTime`, `osDate`, `now`; an MIT library module, fine to import).
- `print` becomes `Logger` (`shared/core/Logger.ts`, once it is ported;
  until then `console.log`).

## LÖVE → platform (`voxelmon/game/gen3/platform/`)

| LÖVE | Platform |
|---|---|
| `love.graphics.*` | `G` from `graphics.ts`, with the same names and arguments (`G.draw`, `G.rectangle`, `G.setColor`, `G.push("all")`, `G.newCanvas`, `G.setCanvas`, `G.newQuad`, `G.newImage`, `G.newSpriteBatch`, `G.setScissor`, `G.setBlendMode`, `G.getWidth`, ...). Screen 240x160. |
| `love.graphics.newShader(GLSL)` | `G.newShader("<effect>")`: the effect named for that shader (table below); `shader:send` unchanged. |
| `love.graphics.print/printf/newFont` | Not used by FRLG (it draws text with `ui/frlg_font`). A debug-only call can be dropped with a `NOT FAITHFUL` note. |
| `love.image.newImageData` | `newImageData` from `image.ts` (ImageData: getPixel/setPixel 0..1, mapPixel, paste, getWidth/Height, encode). |
| `love.filesystem.read/getInfo/write/load/newFileData/getDirectoryItems` | `Fs` from `fs.ts`, same names. `Fs.load(path)` returns `[chunk, err]`. |
| `load(src, name, "t", {})` on cache data | `luaLoad(src, name)` from `luadata.ts`, returning `[chunk, err]`. Calling the chunk gives the table in the lt.ts shape. It evaluates cache data chunks only, and throws on code. |
| `love.timer.getTime/getDelta` | `Timer` from `timer.ts`. |
| `love.audio` / Brian's M4A worker | Only `core/audio.ts` touches sound; it calls `getAudio()` from `audio.ts`, whose methods follow the host's Rust M4A engine. Do **not** port `m4a_mix/seq/player/sample`: the host has that engine. |
| `love.keyboard/joystick/touch` | `shared/core/Input.ts` (the owner cluster ports Input with a host seam). Screens read Input exactly as Brian's do. |
| `love.thread`, `love.system`, `love.window`, `love.event` | Not on the 3DS. Drop with a `NOT FAITHFUL` note, or take the single-threaded path Brian already has. |

Two platform behaviours to rely on:
- `G.setColor` / `G.clear` take numbers, a LÖVE-style JS array
  `[r, g, b, a]`, or a runtime sequence `[null, r, g, b, a]`.
- Graphics state persists between frames, as in LÖVE's run loop.
  `beginFrame` only does `origin()` and a screen clear, so canvas draws a
  screen makes during update reach the host with the next frame.

A `pcall(require, X)` of a module that is still a stub is a failed require
(catch `NotPortedError`); a module with no stub at all also takes Brian's
failed-require path.

**NO TOP-LEVEL READS OF IMPORTS (import cycles).** The gen3 modules form one
big import cycle, so at module load an imported binding may not be
initialised yet. At module top level, NEVER:
- read an imported value: `const Collision = CollisionMod`, `FrlgFont.STDPAL`,
  `Flags.IDS`, `RomText.lazy(...)`;
- call into another module;
- build a table from another module's fields.

Instead:
- use the import directly inside functions;
- build such tables lazily (a getter, or `let t; function tbl() { return t ??= ...; }`).

Brian's Lua does these at require time; ES module order cannot guarantee
that. `bun tools/gen3/loadorder_check.ts` imports every gen3 module first in a
fresh process and lists the ones that fail; your files must not be in it.

**Lazily-required modules.** Some modules gen1recomp loads only through
`pcall(require, "src....")` have no stub file. Callers look them up in
`G3Lazy` (core/runtime.ts) and treat a missing entry as Brian's
failed-require path. To port one:
1. Create its file at the normal path.
2. End it with `G3Lazy["src.ui.game3.credits"] = Credits;`, using its Lua
   module name. Import G3Lazy from `core/lazy_registry.ts` (a leaf module with
   no imports), NEVER from runtime.ts: the registration runs at load time.
3. Add `import "./<path>.ts";` (relative to core/) to `core/lazy_modules.ts`.

Script natives are listed in the VM's static `NATIVE_FILES` table in
`core/scripting/natives.ts`; add yours there.

**Shader → effect names** (`platform/effects/`). Use the name for the shader
your module creates:

| Shader | Effect |
|---|---|
| evolution_scene silhouette | `silhouette` |
| mon_anim colour + texture alpha | `tint_alpha` |
| hall_of_fame / hall_of_fame_pc mix | `mix_target` |
| pokedex_chrome solid mask | `solid_mask` |
| quest_log grey | `gray_luma` |
| region_map_gpu | `region_map` |
| anim_vm / g2 BLEND | `blend5` |
| ball_open | `blend5_pre` |
| g2 ROT | `palrot` |
| g2 GRAY | `gray5` |
| battle ui GRAY | `gray5_pre` |
| g2 MAP | `remap_nearest` |
| g1_sprite | `g1_remap` |
| g3_pret MASK | `mask_write` |
| g3_pret OVERLAY | `mask_overlay` |
| anim_pal | `anim_pal` |
| healthbox LEVEL_UP | `level_flash` |
| battle ui STAT_MASK | `stat_mask` |
| battle ui MOSAIC | `mosaic` |
| battle ui AFFINE | `affine_color` |
| battle anim SCREEN | `screen_fx` |
| gba_fx | `gba_fx` |

Keep Brian's `send` calls unchanged. If a shader is missing from the table,
report it; do not invent one.

## Cache data

The runtime reads the importer's cache (paths like
`data/generated/gba/...`) through `Dataset.cache()` / `CacheFs` /
`love.filesystem`, as Brian's does. Keep his paths. Tests run on
`~/gen3ref/frfull` through `platform/desktop.ts`:

```ts
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
setHost(new DesktopHost(join(homedir(), "gen3ref/frfull")));
```

`host.read("data/generated/gba/...")` then returns the file. Gate such tests
with `describe.skipIf(!existsSync(<root>))`.

## Desktop-only, mods, link

- **Mods:** keep `ModRuntime.call/emit/wants` call sites. `shared/mods/Runtime.ts`
  is a null bus: `call` runs the vanilla function, and `emit`/`wants` do
  nothing. `Gen3Compat` returns vanilla values. The owner cluster ports both.
- **Inert stubs:** DiscordPresence, TouchControls, VSync, FrameCap, Zoom and
  the other desktop plumbing return undefined (stub header "Inert"). Keep
  Brian's calls to them, guarded the way he guards them. Option rows for
  desktop-only settings can stay; they just do nothing.
- **Link, online, mystery gift, union room and the mod manager UI are
  deferred**; their stubs throw. Where your module calls them, keep the call
  behind Brian's own guard (`if session.link then ...`). If there is no
  guard, add one that takes the offline path, marked `NOT FAITHFUL: link
  deferred`.
- RSE / Emerald branches (`if Profile.isRse(...)`, `rse/` modules) are not
  ported. Keep the branch with a throwing `NOT FAITHFUL: Emerald only` (or
  take the FRLG path when the condition is a constant for FRLG).

## Faithfulness and quality

- Port **every** function in your modules, in order, with `// Lua: file.lua:123`
  before each. Keep his names, frame counts, constants and quirks.
- Type what you port. `any` at the boundaries of stubbed or not-yet-ported
  modules is fine.
- Do not "improve" logic. Do not leave TODOs in place of logic: port it, or
  mark it `NOT FAITHFUL: <why>` when it truly cannot run here.
- Performance matters: on a New 3DS the game runs at 60 fps when a frame
  fits in ~15 ms (crates/pocketvoxel-3ds/src/gen3/pace.rs), else 30. Avoid
  allocating in hot per-frame paths where Brian didn't, but keep the
  structure. Three things cost far more under QuickJS on the console than
  they look:
  - **a throw every frame**: a QuickJS exception builds a backtrace through
    the whole stack (a stub's NotPortedError caught each frame was 9.5 ms);
  - **console.log in play**: each line is a file write on the card;
  - **per-pixel closures and arrays** (mapPixel callbacks, effect pixel
    functions parsing uniforms per pixel): loop over the bytes instead,
    with the same arithmetic.
  Drawing that repeats every frame unchanged can be replayed:
  `G.memoBegin/memoEnd/memoReplay` (platform/graphics.ts DrawMemo) or a
  `MemoSet` keyed by the drawing's inputs, as FrlgFont.draw and Chrome's
  frames do; mark it `NOT FAITHFUL (performance, same picture)`.
  `bash cc_g3_qjsperf.sh` (local; tools/gen3/qjs_perf.ts + qjs_prof.c) profiles
  the screens under the 3DS's QuickJS; `bun tools/gen3/perf_check.ts`
  hashes every frame of the same run, to show a speed-up changed no
  picture.

## Testing (definition of done)

- `bash .cc_tsc.sh 'game/gen3/(core|ui|shared)/(<your files regex>)'` shows
  **no errors in your files**. The repo baseline is 204 lines of other
  errors; leave those alone.
- Write `tests/voxel-gen3-rt-<cluster>.test.ts` exercising your modules on
  real cache data where they can run without unported neighbours. Examples:
  load and query data, run a pure function on FireRed values, draw a
  screen's chrome into the DesktopHost and check a few pixels or that it
  runs. Unported neighbours throw `NotPortedError`; test around them, and
  never mock their behaviour into your own modules.
- Run `~/.bun/bin/bun test tests/voxel-gen3-rt-<cluster>.test.ts`.

## Final report

Keep it short:
- the modules ported (file and line count)
- the test result
- every `NOT FAITHFUL`
- the stubs you relied on most (the coordinator uses this to order the next work)
- anything outside your files that needs a change
