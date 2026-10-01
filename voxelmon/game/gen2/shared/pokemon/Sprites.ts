// gen1recomp src/pokemon/Sprites.lua (bdfac727): runtime Pokémon art
// resolution. Every battle pic and party icon load goes through these, the
// mod seam for alternate skins; here the mod bus is null, so each returns the
// vanilla path (a gfx key or Brian's asset path -- Assets takes either).
//
// Returns are Lua multi-returns, so each function returns [path, trueColor].

import { Runtime } from "../mods/Runtime.ts";
import { Assets } from "../render/Assets.ts";

export interface PicCtx {
  species?: string;
  side?: string;
  kind?: string;
  mon?: any;
  trueColor?: boolean;
  data?: any;
  demo?: boolean;
  oakDemo?: boolean;
  battle?: any;
  name?: string;
}

const samePath = (path: unknown): unknown => path;

// FieldDefaults.lua:96 PLAYER_PICS -- the Gen 1 defaults fieldValue falls back
// to (FieldDefaults is a Gen 1 world module and is not part of the Gold port)
const PLAYER_PICS: Record<string, string> = {
  back: "assets/generated/battle/redb.png",
  demoBack: "assets/generated/battle/oldmanb.png",
  oakBack: "assets/generated/battle/profoakb.png",
  front: "assets/generated/trainer_card/red.png",
};

// FieldDefaults.lua:247 fieldValue(data, "playerPics", key)
function playerPicField(data: any, key: string): string | undefined {
  const v = data?.field?.playerPics?.[key];
  return v != null ? v : PLAYER_PICS[key];
}

export const Sprites = {
  /** Sprites.lua:24 -- a battle / menu front or back pic path for `species`. */
  path(data: any, species: string, side?: string, opts: { kind?: string; mon?: any } = {}): [string | undefined, boolean] {
    const def = data?.pokemon?.[species];
    if (!def) return [undefined, false];
    const path = side === "back" ? def.spriteBack : def.spriteFront;
    return Sprites.pic(path, {
      species,
      side,
      kind: opts.kind,
      mon: opts.mon,
      trueColor: !!def.trueColor,
      data,
    });
  },

  /** Sprites.lua:39 */
  pic(path: string | undefined, ctx: PicCtx = {}): [string | undefined, boolean] {
    ctx.side = ctx.side === "back" ? "back" : "front";
    ctx.kind = ctx.kind ?? "battle";
    if (ctx.trueColor == null) {
      const def = ctx.data?.pokemon && ctx.species ? ctx.data.pokemon[ctx.species] : undefined;
      ctx.trueColor = !!def?.trueColor;
    }
    if (path && Runtime.wantsHook("pokemon.sprite")) {
      const hooked = Runtime.call("pokemon.sprite", samePath, path, ctx);
      if (typeof hooked === "string" && hooked !== "") path = hooked;
    }
    return [path, !!ctx.trueColor];
  },

  /** Sprites.lua:64 -- the player's own trainer pic path. */
  playerPath(data: any, side?: string, opts: { kind?: string; demo?: boolean; oakDemo?: boolean; battle?: any } = {}): [string | undefined, boolean] {
    side = side === "back" ? "back" : "front";
    const key = side === "front" ? "front" : opts.oakDemo ? "oakBack" : opts.demo ? "demoBack" : "back";
    let path = playerPicField(data, key);
    if (key === "oakBack" && path && !Assets.exists(path)) path = playerPicField(data, "demoBack");
    const ctx: PicCtx = {
      side,
      kind: opts.kind ?? "battle",
      demo: !!opts.demo,
      oakDemo: !!opts.oakDemo,
      battle: opts.battle,
      trueColor: false,
      data,
    };
    return Sprites.playerPic(path, ctx);
  },

  /** Sprites.lua:100 -- raise player.sprite over an already-resolved path. */
  playerPic(path: string | undefined, ctx: PicCtx = {}): [string | undefined, boolean] {
    ctx.side = ctx.side === "back" ? "back" : "front";
    ctx.kind = ctx.kind ?? "battle";
    ctx.demo = !!ctx.demo;
    ctx.oakDemo = !!ctx.oakDemo;
    if (path && Runtime.wantsHook("player.sprite")) {
      const hooked = Runtime.call("player.sprite", samePath, path, ctx);
      if (typeof hooked === "string" && hooked !== "") path = hooked;
    }
    return [path, !!ctx.trueColor];
  },

  /** Sprites.lua:122 -- a party-menu icon path for `mon`. */
  iconPath(data: any, mon: any, vanillaPath: string | undefined, opts: { trueColor?: boolean; name?: string } = {}): [string | undefined, boolean] {
    let trueColor = !!opts.trueColor;
    if (!vanillaPath && !Runtime.wantsHook("pokemon.icon")) return [vanillaPath, trueColor];
    const ctx: PicCtx = { species: mon?.species, mon, name: opts.name, data, kind: "icon", trueColor };
    if (!Runtime.wantsHook("pokemon.icon")) return [vanillaPath, trueColor];
    const hooked = Runtime.call("pokemon.icon", samePath, vanillaPath, ctx);
    trueColor = !!ctx.trueColor;
    if (typeof hooked === "string" && hooked !== "") return [hooked, trueColor];
    if (hooked == null || hooked === false) return [undefined, false];
    return [vanillaPath, trueColor];
  },
};

export default Sprites;
