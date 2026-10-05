// Port of gen1recomp src/ui/game3/quest_log.lua (GPLv3 + additional terms; see LICENSE.md).
// Read-only Quest Log movie, drawn from recorded tiles and actor tracks.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Q, type Playback } from "../core/quest_log.ts";
import { FrlgFont as Font } from "./frlg_font.ts";
import { Strings } from "../shared/core/Strings.ts";
import { OwSprites } from "../core/ow_sprites.ts";
import { PokedexChrome as PokedexChromeM } from "./pokedex_chrome.ts";
import { NativeTileset } from "../core/tileset_native.ts";
import { G, type Shader } from "../platform/graphics.ts";
import { luaLoad } from "../platform/luadata.ts";
import { ipairs, sort, type LuaTable } from "../platform/lt.ts";
import { gmatch, gsub, match } from "../platform/lpattern.ts";

let Ow: typeof OwSprites | undefined;
let PokedexChrome: any;
// Lua: quest_log.lua:6
function owSprites(): typeof OwSprites { Ow = Ow || OwSprites; return Ow; }
// Lua: quest_log.lua:7
function pokedexChrome(): any { PokedexChrome = PokedexChrome || PokedexChromeM; return PokedexChrome; }
// Lua: quest_log.lua:8
function actorOrder(a: any, b: any): boolean { return a.y < b.y || (a.y === b.y && a.id < b.id); }

export interface QuestLogUi {
  pack: LuaTable | null;
  shader?: Shader;
  install(cache: any): void;
  text(key: string, args?: any, session?: any): string;
  begin(session: any): Playback | null;
  draw(playback: Playback, session?: any): void;
}

export const UI: QuestLogUi = {
  pack: null,

  // Lua: quest_log.lua:10
  install(cache: any): void {
    UI.pack = null;
    const src = cache && cache.read("data/generated/gba/quest_log/pack.lua");
    if (src) {
      // loadstring + setfenv(f, {}): a data chunk
      const [f] = luaLoad(src, "@quest_log/pack.lua");
      if (f) { UI.pack = f() as LuaTable; }
    }
  },

  // Lua: quest_log.lua:18
  text(key: string, args?: any, session?: any): string {
    const text: string = (UI.pack && UI.pack.text[key]) || "";
    args = args || {}; session = session || {};
    return gsub(text, "{([^}]+)}", (kc) => {
      const k = kc as string;
      if (k === "PLAYER") return session.name || "RED";
      if (k === "RIVAL") return session.rivalName || "BLUE";
      const sn = match(k, "^S(%d+)$") as string | undefined;
      const num = tonumber(sn);
      const v = args[k] ?? (num != null ? args[num] : undefined) ?? (sn != null ? args[sn] : undefined);
      if (v != null && typeof v === "object") return UI.pack.text[v.text] || "";
      return tostring(v ?? "");
    })[0];
  },

  // Lua: quest_log.lua:29
  begin(session: any): Playback | null {
    if (!UI.pack) return null;
    return Q.playback(session.questLog) as Playback;
  },

  // Lua: quest_log.lua:55
  draw(playback: Playback, session?: any): void {
    G.clear(0, 0, 0, 1);
    const scene = playback.current(); const frame = playback.frame();
    if (!scene || !frame) return;
    // The original presents previous scenes in monochrome, then the save in color.
    if (!UI.shader) {
      UI.shader = G.newShader("gray_luma");
    }
    if (!playback.isFinal()) G.setShader(UI.shader);
    G.setColor(1, 1, 1, 1);
    tiles(scene, frame, false);
    const actors = frame.actors;
    sort(actors, actorOrder);
    const Ow = owSprites();
    const cx = Math.floor(frame.x + 8 - 120); const cy = Math.floor(frame.y + 8 - 80);
    for (const [, a] of ipairs<any>(actors)) {
      if (a.graphicsId != null) Ow.draw(a.graphicsId, a.x, a.y, cx, cy, a.facing, a.walkPhase, a.stepFlip, { frame: a.frame, bow: a.bow, fieldMove: a.fieldMove } as any);
    }
    tiles(scene, frame, true);
    G.setShader();
    G.setColor(0.12, 0.16, 0.18, 1);
    G.rectangle("fill", 0, 0, 240, 18);
    G.rectangle("fill", 0, 144, 240, 16);
    let title = UI.text("PreviouslyOnYourQuest", {}, session);
    if (!playback.isFinal()) title = title + " " + tostring(playback.number());
    Font.draw(title, 2, 2, { colors: Font.COLOR.WHITE });
    const e = playback.event();
    if (e) {
      const text = Font.wrap(gsub(UI.text(e.key, e.args, session), "\n", " ")[0], 232, {});
      let lines = 1; for (const _ of gmatch(text, "\n")) lines = lines + 1;
      const y = 144 - Math.max(32, lines * 16);
      G.setColor(0.12, 0.16, 0.18, 0.94);
      G.rectangle("fill", 0, y, 240, 144 - y);
      Font.draw(text, 4, y, { colors: Font.COLOR.WHITE });
    }
    const PokedexChrome = pokedexChrome();
    PokedexChrome.drawControlInfoLeft(Strings("{A_BUTTON}NEXT   {B_BUTTON}SKIP"), 4, 146);
  },
};

// Lua: quest_log.lua:33
function tiles(scene: any, frame: any, over: boolean): void {
  const T = NativeTileset;
  const cx = Math.floor(frame.x + 8 - 120); const cy = Math.floor(frame.y + 8 - 80);
  const textures: Record<string, any> = {};
  for (let y = Math.floor(cy / 16); y <= Math.floor((cy + 159) / 16); y++) {
    for (let x = Math.floor(cx / 16); x <= Math.floor((cx + 239) / 16); x++) {
      const tile = scene.tiles && scene.tiles[tostring(x) + "," + tostring(y)];
      if (tile) {
        const ts: any = textures[tile[2]] || T.get(tile[2]);
        if (tile[2] != null) textures[tile[2]] = ts;
        if (ts) {
          const slot = T.slotFor(ts, tile[1]);
          let quad;
          if (over) quad = T.overQuad(ts, slot); else quad = T.quad(ts, slot);
          let image;
          if (over) image = ts.overImage; else image = ts.image;
          if (image && quad && (!over || ts.layered)) G.draw(image, quad, x * 16 - cx, y * 16 - cy);
        }
      }
    }
  }
}

export default UI;
