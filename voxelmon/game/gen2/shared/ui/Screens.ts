// gen1recomp src/ui/Screens.lua (bdfac727): screens by id. A Gen 2 id is
// "Gen2<Name>" -> ui/<Name>.ts, exactly the Lua's BUILTIN table. There is no
// mod registry and no dynamic require on the device, so every Gen 2 screen
// module is imported here and resolved on first use.
//
// Generated list: cc_gen_screens.py reads ui/*.ts for each module's export.

import * as M_BankOfMom from "../../ui/BankOfMom.ts";
import * as M_BattleState from "../../ui/BattleState.ts";
import * as M_BattleTowerMenu from "../../ui/BattleTowerMenu.ts";
import * as M_BattleTransition from "../../ui/BattleTransition.ts";
import * as M_BlankScreen from "../../ui/BlankScreen.ts";
import * as M_BoxMenu from "../../ui/BoxMenu.ts";
import * as M_BuenaPassword from "../../ui/BuenaPassword.ts";
import * as M_CardFlip from "../../ui/CardFlip.ts";
import * as M_CenterPcMenu from "../../ui/CenterPcMenu.ts";
import * as M_ContestMenu from "../../ui/ContestMenu.ts";
import * as M_CopyrightSplash from "../../ui/CopyrightSplash.ts";
import * as M_Credits from "../../ui/Credits.ts";
import * as M_CrystalIntro from "../../ui/CrystalIntro.ts";
import * as M_DevMenu from "../../ui/DevMenu.ts";
import * as M_CrystalSplash from "../../ui/CrystalSplash.ts";
import * as M_DayCareMenu from "../../ui/DayCareMenu.ts";
import * as M_DecorationMenu from "../../ui/DecorationMenu.ts";
import * as M_Diploma from "../../ui/Diploma.ts";
import * as M_EggHatchAnim from "../../ui/EggHatchAnim.ts";
import * as M_ElevatorMenu from "../../ui/ElevatorMenu.ts";
import * as M_EvolutionAnim from "../../ui/EvolutionAnim.ts";
import * as M_GameFreakPresents from "../../ui/GameFreakPresents.ts";
import * as M_GenderSelect from "../../ui/GenderSelect.ts";
import * as M_GoldSilverIntro from "../../ui/GoldSilverIntro.ts";
import * as M_HallOfFame from "../../ui/HallOfFame.ts";
import * as M_HeldItemMenu from "../../ui/HeldItemMenu.ts";
import * as M_InitClock from "../../ui/InitClock.ts";
import * as M_ItemPcMenu from "../../ui/ItemPcMenu.ts";
import * as M_MagnetTrainRide from "../../ui/MagnetTrainRide.ts";
import * as M_MailCompose from "../../ui/MailCompose.ts";
import * as M_MailMenu from "../../ui/MailMenu.ts";
import * as M_MailRead from "../../ui/MailRead.ts";
import * as M_MailboxMenu from "../../ui/MailboxMenu.ts";
import * as M_MapRadio from "../../ui/MapRadio.ts";
import * as M_MainMenu from "../../ui/MainMenu.ts";
import * as M_MartMenu from "../../ui/MartMenu.ts";
import * as M_MenuFade from "../../ui/MenuFade.ts";
import * as M_MoveDeleter from "../../ui/MoveDeleter.ts";
import * as M_MoveTutor from "../../ui/MoveTutor.ts";
import * as M_NamePick from "../../ui/NamePick.ts";
import * as M_NamingScreen from "../../ui/NamingScreen.ts";
import * as M_OakSpeech from "../../ui/OakSpeech.ts";
import * as M_OptionsMenu from "../../ui/OptionsMenu.ts";
import * as M_PackMenu from "../../ui/PackMenu.ts";
import * as M_PartyMenu from "../../ui/PartyMenu.ts";
import * as M_PcMenu from "../../ui/PcMenu.ts";
import * as M_PhotoStudio from "../../ui/PhotoStudio.ts";
import * as M_PokedexMenu from "../../ui/PokedexMenu.ts";
import * as M_Pokegear from "../../ui/Pokegear.ts";
import * as M_SaveMenu from "../../ui/SaveMenu.ts";
import * as M_ScriptMenu from "../../ui/ScriptMenu.ts";
import * as M_SlotMachine from "../../ui/SlotMachine.ts";
import * as M_StartMenu from "../../ui/StartMenu.ts";
import * as M_SummaryMenu from "../../ui/SummaryMenu.ts";
import * as M_TitleState from "../../ui/TitleState.ts";
import * as M_TradeAnim from "../../ui/TradeAnim.ts";
import * as M_TradeMenu from "../../ui/TradeMenu.ts";
import * as M_TrainerCard from "../../ui/TrainerCard.ts";
import * as M_UnownPrinter from "../../ui/UnownPrinter.ts";
import * as M_UnownPuzzle from "../../ui/UnownPuzzle.ts";

type Factory = { new: (game: any, ...args: any[]) => any; isModOptions?: boolean };

function pick(mod: Record<string, any>, name: string): Factory {
  const f = mod[name] ?? mod.default;
  if (!f) throw new Error(`Screens: ui module has no export ${name}`);
  return f as Factory;
}

const BUILTIN: Record<string, () => Factory> = {
  Gen2BankOfMom: () => pick(M_BankOfMom, "BankOfMom"),
  Gen2BattleState: () => pick(M_BattleState, "BattleState"),
  Gen2BattleTowerMenu: () => pick(M_BattleTowerMenu, "BattleTowerMenu"),
  Gen2BattleTransition: () => pick(M_BattleTransition, "BattleTransition"),
  Gen2BlankScreen: () => pick(M_BlankScreen, "BlankScreen"),
  Gen2BoxMenu: () => pick(M_BoxMenu, "BoxMenu"),
  Gen2BuenaPassword: () => pick(M_BuenaPassword, "BuenaPassword"),
  Gen2CardFlip: () => pick(M_CardFlip, "CardFlip"),
  Gen2CenterPcMenu: () => pick(M_CenterPcMenu, "CenterPcMenu"),
  Gen2ContestMenu: () => pick(M_ContestMenu, "ContestMenu"),
  Gen2CopyrightSplash: () => pick(M_CopyrightSplash, "CopyrightSplash"),
  Gen2Credits: () => pick(M_Credits, "Credits"),
  Gen2CrystalIntro: () => pick(M_CrystalIntro, "CrystalIntro"),
  Gen2CrystalSplash: () => pick(M_CrystalSplash, "CrystalSplash"),
  Gen2DayCareMenu: () => pick(M_DayCareMenu, "DayCareMenu"),
  Gen2DecorationMenu: () => pick(M_DecorationMenu, "DecorationMenu"),
  Gen2Diploma: () => pick(M_Diploma, "Diploma"),
  Gen2EggHatchAnim: () => pick(M_EggHatchAnim, "EggHatchAnim"),
  Gen2ElevatorMenu: () => pick(M_ElevatorMenu, "ElevatorMenu"),
  Gen2EvolutionAnim: () => pick(M_EvolutionAnim, "EvolutionAnim"),
  Gen2GameFreakPresents: () => pick(M_GameFreakPresents, "GameFreakPresents"),
  Gen2GenderSelect: () => pick(M_GenderSelect, "GenderSelect"),
  Gen2GoldSilverIntro: () => pick(M_GoldSilverIntro, "GoldSilverIntro"),
  Gen2HallOfFame: () => pick(M_HallOfFame, "HallOfFame"),
  Gen2HeldItemMenu: () => pick(M_HeldItemMenu, "HeldItemMenu"),
  Gen2InitClock: () => pick(M_InitClock, "InitClock"),
  Gen2ItemPcMenu: () => pick(M_ItemPcMenu, "ItemPcMenu"),
  Gen2MagnetTrainRide: () => pick(M_MagnetTrainRide, "MagnetTrainRide"),
  Gen2MailCompose: () => pick(M_MailCompose, "MailCompose"),
  Gen2MailMenu: () => pick(M_MailMenu, "MailMenu"),
  Gen2MailRead: () => pick(M_MailRead, "MailRead"),
  Gen2MailboxMenu: () => pick(M_MailboxMenu, "MailboxMenu"),
  Gen2MapRadio: () => pick(M_MapRadio, "MapRadio"),
  Gen2MainMenu: () => pick(M_MainMenu, "MainMenu"),
  Gen2MartMenu: () => pick(M_MartMenu, "MartMenu"),
  Gen2MenuFade: () => pick(M_MenuFade, "MenuFade"),
  Gen2MoveDeleter: () => pick(M_MoveDeleter, "MoveDeleter"),
  Gen2MoveTutor: () => pick(M_MoveTutor, "MoveTutor"),
  Gen2NamePick: () => pick(M_NamePick, "NamePick"),
  Gen2NamingScreen: () => pick(M_NamingScreen, "NamingScreen"),
  Gen2OakSpeech: () => pick(M_OakSpeech, "OakSpeech"),
  Gen2OptionsMenu: () => pick(M_OptionsMenu, "OptionsMenu"),
  Gen2PackMenu: () => pick(M_PackMenu, "PackMenu"),
  Gen2PartyMenu: () => pick(M_PartyMenu, "PartyMenu"),
  Gen2PcMenu: () => pick(M_PcMenu, "PcMenu"),
  Gen2PhotoStudio: () => pick(M_PhotoStudio, "PhotoStudio"),
  Gen2PokedexMenu: () => pick(M_PokedexMenu, "PokedexMenu"),
  Gen2Pokegear: () => pick(M_Pokegear, "Pokegear"),
  Gen2SaveMenu: () => pick(M_SaveMenu, "SaveMenu"),
  Gen2ScriptMenu: () => pick(M_ScriptMenu, "ScriptMenu"),
  Gen2SlotMachine: () => pick(M_SlotMachine, "SlotMachine"),
  Gen2StartMenu: () => pick(M_StartMenu, "StartMenu"),
  Gen2DevMenu: () => pick(M_DevMenu, "DevMenu"),
  Gen2SummaryMenu: () => pick(M_SummaryMenu, "SummaryMenu"),
  Gen2TitleState: () => pick(M_TitleState, "TitleState"),
  Gen2TradeAnim: () => pick(M_TradeAnim, "TradeAnimView"),
  Gen2TradeMenu: () => pick(M_TradeMenu, "TradeMenu"),
  Gen2TrainerCard: () => pick(M_TrainerCard, "TrainerCard"),
  Gen2UnownPrinter: () => pick(M_UnownPrinter, "UnownPrinter"),
  Gen2UnownPuzzle: () => pick(M_UnownPuzzle, "UnownPuzzle"),
};

const cache = new Map<string, Factory>();

function resolve(_game: unknown, id: string): Factory {
  let hit = cache.get(id);
  if (hit) return hit;
  const make = BUILTIN[id];
  if (!make) throw new Error(`Screens: no screen "${id}"`);
  hit = make();
  cache.set(id, hit);
  return hit;
}

export const Screens = {
  GEN2_IDS: Object.keys(BUILTIN),

  get(game: unknown, id: string): Factory {
    return resolve(game, id);
  },

  build(game: any, id: string, ...args: any[]): any {
    const inst = resolve(game, id).new(game, ...args);
    inst.screenId = inst.screenId ?? id;
    return inst;
  },

  push(game: any, id: string, ...args: any[]): any {
    const inst = Screens.build(game, id, ...args);
    game.stack.push(inst);
    return inst;
  },

  invalidate(): void {
    cache.clear();
  },
};

export default Screens;
