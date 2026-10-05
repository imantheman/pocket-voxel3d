// Port of gen1recomp src/ui/game3/museum_fossil_pic.lua (GPLv3 + additional terms; see LICENSE.md).
// The Pewter Museum's fossil picture window (pokefirered/src/script_menu.c:1151).
//
// Reached through G3Lazy (ui_pass, Game3's reset list), so it registers
// itself there. `package.loaded[...]` reads of runtime / space are the static
// imports (always loaded here).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { Window } from "./window.ts";
import { Display } from "../core/display.ts";
import { Dataset } from "../core/dataset.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { SaveSerializer as Serializer } from "../shared/core/SaveSerializer.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { Space } from "../core/scripting/space.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image } from "../platform/image.ts";

interface Binding { version: unknown; root: unknown; override: unknown; directory: unknown; cache: any }
interface PicState { species: number; x: number; y: number }
interface Owner { ctx: any; state: PicState; vm: any; map: unknown; session: any; binding: Binding; image: Image }

const names: Record<number, string> = { 141: "kabutops", 142: "aerodactyl" };
let owner: Owner | null = null;

// Lua: museum_fossil_pic.lua:13
function session(): any {
  const R = Runtime;
  return (R && R.getSession && R.getSession()) || null;
}

// Lua: museum_fossil_pic.lua:18
function binding(): Binding {
  return {
    version: (GameVersion as any).get(), root: Extract.CACHE_ROOT,
    override: (Dataset as any).cacheRootOverride, directory: (CacheFs as any).root(), cache: Dataset.cache(),
  };
}

// Lua: museum_fossil_pic.lua:23
function sameBinding(a: Binding, b: Binding): boolean {
  return a.version === b.version && a.root === b.root && a.override === b.override
    && a.directory === b.directory && a.cache === b.cache;
}

// Lua: museum_fossil_pic.lua:28
function clear(): void {
  if (!owner) return;
  if (owner.ctx.museumFossilPic === owner.state) owner.ctx.museumFossilPic = null;
  const img: any = owner.image;
  if (img && img.release) img.release();
  owner = null;
}

// Lua: museum_fossil_pic.lua:53
function imageFor(species: number, current: Binding): Image {
  const root = ((current.root as string) || "data/generated/gba") + "/museum/";
  const source = current.cache.read(root + "manifest.lua");
  const manifest = source ? Serializer.decode(source)[0] : null;
  if (manifest == null || typeof manifest !== "object" || manifest.format_version !== 1
      || manifest.width !== 64 || manifest.height !== 64 || manifest.species == null || typeof manifest.species !== "object"
      || manifest.species.kabutops !== 141 || manifest.species.aerodactyl !== 142) {
    throw new Error("[game3/museum] required fossil manifest is invalid");
  }
  const bytes = current.cache.read(root + names[species] + ".rgba");
  if (typeof bytes !== "string" || bytes.length !== 64 * 64 * 4) {
    throw new Error("[game3/museum] required fossil art is invalid: " + names[species]);
  }
  const data = newImageData(64, 64, "rgba8", bytes);
  const image = G.newImage(data);
  image.setFilter("nearest", "nearest");
  return image;
}

export const MuseumPic = {
  // Lua: museum_fossil_pic.lua:35
  reset(): void {
    clear();
  },

  // Lua: museum_fossil_pic.lua:39
  isActive(): boolean {
    if (!owner) return false;
    const S: any = Space;
    if (!S || S.vm !== owner.vm || S.mapId !== owner.map
        || owner.vm.ctx !== owner.ctx || owner.ctx.museumFossilPic !== owner.state
        || session() !== owner.session
        || (owner.vm.isRunning && !owner.vm.isRunning())
        || !sameBinding(owner.binding, binding())) {
      clear();
      return false;
    }
    return true;
  },

  // pokefirered/src/script_menu.c:1151
  // Lua: museum_fossil_pic.lua:73
  show(ctx: any, species: number, x?: unknown, y?: unknown): boolean {
    if (!ctx || !names[species]) return false;
    if (MuseumPic.isActive() || ctx.museumFossilPic) return false;
    const state: PicState = { species, x: tonumber(x) ?? 0, y: tonumber(y) ?? 0 };
    const S: any = Space;
    if (S && S.vm && S.vm.ctx === ctx) {
      const current = binding();
      owner = {
        ctx, state, vm: S.vm, map: S.mapId, session: session(),
        binding: current, image: imageFor(species, current),
      };
    }
    ctx.museumFossilPic = state;
    return true;
  },

  // pokefirered/src/script_menu.c:1184
  // Lua: museum_fossil_pic.lua:88
  hide(ctx: any): void {
    if (owner && owner.ctx === ctx) clear();
    if (ctx) ctx.museumFossilPic = null;
  },

  // pokefirered/src/script_menu.c:1173
  // Lua: museum_fossil_pic.lua:94
  draw(): void {
    if (!MuseumPic.isActive()) return;
    const state = owner!.state;
    Window.stdFrame(Window.template(state.x + 1, state.y + 1, 8, 8));
    G.setColor(1, 1, 1, 1);
    G.draw(owner!.image, state.x * Display.TILE + 8, state.y * Display.TILE + 8);
  },
};

G3Lazy["src.ui.game3.museum_fossil_pic"] = MuseumPic;

export default MuseumPic;
