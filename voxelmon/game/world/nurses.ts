// Pokémon Center nurse, ported from src/world/OverworldController.lua:2874
// nurseHeal — a clerk whose text entry carries `.nurse` heals the party. The
// reference is imperative (a greeting TextBox with a yes/no choice, then
// NeedYourPokemon -> stop music -> Pokemon.heal each -> machine -> farewell);
// expressed here as the same script rows the port's Mom-heal already uses
// (mapscripts.ts REDS_HOUSE_1F: fade to white, heal_party, Music_PkmnHealed,
// fade back), with the nurse's yes/no and text. Yellow's Pikachu-follower
// beats (hopToCounter / setVisible) are dropped — the port has no follower.
//
// Composed as a script so it runs through the same runner and shows up in the
// showMapText fallback chain after talkScript/itemBall/mart. Every Pokémon
// Center and Silph nurse the manifest marks `.nurse:true` is named
// TEXT_*_NURSE, so that suffix is the detector.
import type { ScriptRow } from "./script.ts";

export function isNurseClerk(textConst: string): boolean {
  return textConst.endsWith("_NURSE");
}

export function nurseGreetScript(textConst: string): ScriptRow[] | null {
  if (!isNurseClerk(textConst)) return null;
  // romText fallbacks kept verbatim from nurseHeal: _PokemonCenterWelcomeText
  // (+ _ShallWeHealYourPokemonText, the yes/no rides on the greeting box),
  // _NeedYourPokemonText, _PokemonCenterFarewellText.
  return [
    ["face_player"],
    ["ask", "Welcome to our\nPOKéMON CENTER!\nShall we heal your\nPOKéMON?"],
    ["jump_if_false", "bye"],
    ["show_text", "OK. We'll need\nyour POKéMON."],
    ["fade", "out", "white"], // GBFadeOutToWhite
    ["heal_party"], // Pokemon.heal each — before the machine runs
    ["set_heal_point"], // last Pokémon Center becomes the blackout warp target
    ["play_once", "Music_PkmnHealed"],
    ["fade", "in", "white"], // GBFadeInFromWhite
    ["show_text", "Your POKéMON are\nfighting fit!"],
    ["label", "bye"],
    ["show_text", "We hope to see\nyou again!"],
  ];
}
