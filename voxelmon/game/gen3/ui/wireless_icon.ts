// Port of gen1recomp src/ui/game3/wireless_icon.lua (GPLv3 + additional terms; see LICENSE.md).
// The wireless adapter's signal icon in the screen's top-right corner, drawn
// over the field on the link maps (pokefirered link_rfu_3.c). The UI pass
// calls drawField every frame (ui_pass.ts); off the link maps it draws
// nothing, and while the link is deferred (no src.online modules) the
// connection state is always "offline", which has no animation.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { ipairs } from "../platform/lt.ts";
import { Timer } from "../platform/timer.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { Dataset } from "../core/dataset.ts";
import MapMod from "../core/map.ts";
import Space from "../core/scripting/space.ts";
import Stack from "./stack.ts";

type Cmd = [null, number, number];
const cmds = (...c: [number, number][]): (Cmd | null)[] => [null, ...c.map(([a, b]): Cmd => [null, a, b])];

export const WirelessIcon = {
  CACHE: "data/generated/gba/union_room/",
  SIZE: 16,
  // pokefirered/src/link_rfu_3.c:955
  X: 231,
  Y: 8,

  // pokefirered/src/link_rfu_3.c:448
  ANIMS: {
    "3bars": cmds([1, 5], [2, 5], [3, 5], [4, 10], [3, 5], [2, 5]),
    searching: cmds([1, 10], [5, 10]),
    error: cmds([6, 10], [1, 10]),
  } as Record<string, (Cmd | null)[]>,

  STATE_ANIM: {
    online: "3bars",
    ticket: "searching",
    connecting: "searching",
    reconnecting: "searching",
    error: "error",
  } as Record<string, string>,

  LINK_MAPS: {
    FR_UNION_ROOM: true,
    FR_TRADE_CENTER: true,
    FR_BATTLE_COLOSSEUM_2P: true,
    FR_BATTLE_COLOSSEUM_4P: true,
    FR_RECORD_CORNER: true,
    FR_TWO_ISLAND_JOYFUL_GAME_CORNER: true,
  } as Record<string, boolean>,

  _visible: true,
  _frames: 0,
  _acc: 0,
  _anim: undefined as string | undefined,
  _forced: undefined as string | false | undefined,
  _image: undefined as Image | undefined,
  _quads: undefined as Record<number, Quad> | undefined,
  _lastTime: undefined as number | undefined,
  _frameCount: 0,

  connectState,

  // Lua: wireless_icon.lua:59
  setVisible(visible: unknown): void {
    WirelessIcon._visible = !!visible;
  },

  // Lua: wireless_icon.lua:63
  isVisible(): boolean {
    return WirelessIcon._visible;
  },

  // Lua: wireless_icon.lua:67
  force(anim: string | false | undefined): void {
    WirelessIcon._forced = anim;
  },

  // Lua: wireless_icon.lua:71
  anim(): string | undefined {
    if (WirelessIcon._forced != null) return WirelessIcon._forced || undefined;
    return WirelessIcon.STATE_ANIM[connectState()];
  },

  // Lua: wireless_icon.lua:76
  update(dt: unknown): void {
    WirelessIcon._acc = WirelessIcon._acc + (tonumber(dt) ?? 0) * 60;
    const whole = Math.floor(WirelessIcon._acc);
    if (whole > 0) {
      WirelessIcon._acc = WirelessIcon._acc - whole;
      WirelessIcon._frames = WirelessIcon._frames + whole;
    }
  },

  // Lua: wireless_icon.lua:85
  frameFor(anim: string, frames: unknown): number | undefined {
    const list = WirelessIcon.ANIMS[anim];
    if (!list) return undefined;
    let total = 0;
    for (const [, c] of ipairs<Cmd>(list)) total = total + c[2];
    let t = Math.floor(tonumber(frames) ?? 0) % total;
    for (const [, c] of ipairs<Cmd>(list)) {
      if (t < c[2]) return c[1];
      t = t - c[2];
    }
    return list[1]![1];
  },

  // Lua: wireless_icon.lua:98
  frame(): number | undefined {
    const anim = WirelessIcon.anim();
    if (anim !== WirelessIcon._anim) {
      WirelessIcon._anim = anim;
      WirelessIcon._frames = 0;
    }
    if (!anim) return undefined;
    return WirelessIcon.frameFor(anim, WirelessIcon._frames);
  },

  // pokefirered/src/link_rfu_3.c:492
  // Lua: wireless_icon.lua:109
  load(): Image {
    if (WirelessIcon._image) return WirelessIcon._image;
    const cache = Dataset.cache();
    const manifestSrc = cache.read(WirelessIcon.CACHE + "manifest.lua");
    if (typeof manifestSrc !== "string") throw new Error("union_room/manifest.lua missing from the cache");
    const [chunk, err] = luaLoad(manifestSrc, "@union_room/manifest.lua");
    if (!chunk) throw new Error(String(err));
    const manifest: any = chunk();
    const entry = manifest.wireless_icon;
    if (!entry) throw new Error("union_room manifest has no wireless_icon");
    const w = tonumber(entry.width)!, h = tonumber(entry.height)!;
    const fh = tonumber(entry.frame_h) ?? WirelessIcon.SIZE;
    const rgba = cache.read(WirelessIcon.CACHE + "wireless_icon.rgba");
    if (!(typeof rgba === "string" && rgba.length === w * h * 4)) throw new Error("union_room/wireless_icon.rgba missing");
    const data = newImageData(w, h, "rgba8", rgba);
    const image = G.newImage(data);
    image.setFilter("nearest", "nearest");
    const quads: Record<number, Quad> = {};
    const frames = tonumber(entry.frames) ?? Math.floor(h / fh);
    for (let i = 0; i <= frames - 1; i++) {
      quads[i] = G.newQuad(0, i * fh, w, fh, w, h);
    }
    WirelessIcon._image = image;
    WirelessIcon._quads = quads;
    WirelessIcon._frameCount = frames;
    return image;
  },

  // Lua: wireless_icon.lua:135
  draw(cxIn?: unknown, cyIn?: unknown): boolean {
    if (!WirelessIcon._visible) return false;
    // (love.graphics and love.image are always here)
    const index = WirelessIcon.frame();
    if (index == null) return false;
    const image = WirelessIcon.load();
    const quad = WirelessIcon._quads![index];
    if (!quad) return false;
    const cx = tonumber(cxIn) ?? WirelessIcon.X;
    const cy = tonumber(cyIn) ?? WirelessIcon.Y;
    G.setColor(1, 1, 1, 1);
    G.draw(image, quad, cx - WirelessIcon.SIZE / 2, cy - WirelessIcon.SIZE / 2);
    return true;
  },

  // Lua: wireless_icon.lua:150
  onLinkMap(mapId: unknown): boolean {
    if (typeof mapId !== "string") return false;
    if (WirelessIcon.LINK_MAPS[mapId]) return true;
    // NOT FAITHFUL: link deferred. Brian also asks the link family's maps
    // (src.core.game3.link.family) and the union room (link.union_room),
    // both stubs here; their maps are the link maps above and the union
    // room's, which this runtime never reaches.
    return /_POKEMON_CENTER_2F$/.test(mapId);
  },

  // pokefirered/src/overworld.c:1829
  // Lua: wireless_icon.lua:170
  drawField(): boolean {
    if (!WirelessIcon.onLinkMap(currentMap())) {
      WirelessIcon._lastTime = undefined;
      return false;
    }
    const top = Stack && Stack.top && Stack.top();
    if (top && top.hideBelow) return false;
    const now = Timer.getTime();
    if (now != null && WirelessIcon._lastTime != null) {
      WirelessIcon.update(Math.min(now - WirelessIcon._lastTime, 0.25));
    }
    WirelessIcon._lastTime = now;
    return WirelessIcon.draw(WirelessIcon.X, WirelessIcon.Y);
  },

  // Lua: wireless_icon.lua:186
  reset(): void {
    WirelessIcon._visible = true;
    WirelessIcon._frames = 0;
    WirelessIcon._acc = 0;
    WirelessIcon._anim = undefined;
    WirelessIcon._forced = undefined;
    WirelessIcon._lastTime = undefined;
  },
};

// Lua: wireless_icon.lua:43
function connectState(): string {
  // package.loaded["src.online.Connect"] / ["src.online.Client"]: online is
  // deferred, so neither is loaded unless a later port registers it
  const Connect: any = G3Lazy["src.online.Connect"];
  if (Connect && Connect.state) {
    try {
      const s = Connect.state();
      if (s && s !== "offline") return s;
    } catch { /* pcall */ }
  }
  const Client: any = G3Lazy["src.online.Client"];
  if (Client && Client.state) {
    try {
      return Client.state();
    } catch { /* pcall */ }
  }
  return "offline";
}

// Lua: wireless_icon.lua:162
function currentMap(): string | undefined {
  // package.loaded["src.core.game3.scripting.space"] / ["src.core.game3.map"]
  const S: any = Space;
  if (S && typeof S.mapId === "string") return S.mapId;
  const M: any = MapMod;
  return M ? M.current : undefined;
}

export default WirelessIcon;
