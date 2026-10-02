// A COLOSSEUM battle, Gold to Gold (engine/link/link.asm's battle; the Kanto
// games' voxelmon/game/battle/linkbattle.ts is the same idea): both consoles
// run the whole fight, each its own player against the other as the enemy,
// from one shared seed, and nothing crosses but each side's choice for a turn
// and its pick after a faint -- so both arrive at the same answers rather than
// one telling the other what happened.
//
// The engine already carries the link arms (Battle.linkBattle: no AI, no
// experience; Battle.mirrored: speed ties and simultaneous effects read from
// the other side for seat 1; pendingEnemySwitch; takeLinkTurn; forced-
// Replacement), and BattleState its hooks (opts.link: submit, menuChoice,
// forcedPrompt, forcedSwitch). This drives them over the CABLE CLUB's session:
//
//   submit       my turn goes out; the screen waits for theirs, then
//                takeLinkTurn(mine, theirs) runs it on both consoles
//   forcedSwitch my pick after a faint goes out and is played here
//   service      (once a frame, from CableClub) their turn, their pick after
//                a faint (the enemy's replacement), the link dropping
//
// What the cart leaves out of a link battle is left out: the PACK, RUN,
// experience, prize money, the badges' stat and obedience effects (the battle
// is built without the save, so neither console applies its own), and the
// party is the battle's own copy -- nothing changes in the save.

import { Battle } from "../battle/Battle.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Screens } from "../shared/ui/Screens.ts";
import type { LinkSession } from "../../world/link.ts";
import type { CableClub } from "./CableClub.ts";

const TEXT_WAIT = Strings.source("Waiting…");
const TEXT_NO_ITEMS = Strings.source("Items can't be\nused here.");
const TEXT_NO_RUN = Strings.source("No! There's no\nrunning away!");
const TEXT_CLOSED = Strings.source("The link has been\nclosed.");

/** One battle's own random stream (mulberry32), off the shared seed. */
function seededRandom(seed: number): (n: number) => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return (n: number): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const f = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(f * Math.max(1, Math.floor(n)));
  };
}

interface Wire {
  t: "turn" | "replace";
  a?: any;
  i?: number;
}

export class LinkBattle2 {
  battle: any;
  st: any = null;
  /** My turn, sent, waiting on theirs. */
  private mine: any = null;
  private turn = 0;

  constructor(
    private readonly club: CableClub,
    private readonly s: LinkSession,
    data: any,
    myParty: any[],
    peerName: string,
    theirParty: any[],
    seed: number,
  ) {
    // Without the save: no badge boosts, no obedience rolls, no prize -- the
    // two consoles must compute the same numbers for the same mons
    this.battle = Battle.new({
      data,
      party: myParty,
      trainer: { name: peerName, party: theirParty },
      random: seededRandom(seed),
    });
    this.battle.linkBattle = true;
    this.battle.mirrored = s.seat() === 1;
  }

  private log(m: string): void {
    this.club.log(`battle ${m}`);
  }

  private hp(): string {
    const b = this.battle;
    return `${b.player?.species} ${b.player?.hp}/${b.player?.maxHp} vs ${b.enemy?.species} ${b.enemy?.hp}/${b.enemy?.maxHp}`;
  }

  private wait(st: any): void {
    st.phase = "link-wait";
    st.message = Strings.get(TEXT_WAIT);
    st.typedText = undefined;
    st.messageTimer = 0;
  }

  private play(st: any, events: any[]): void {
    st.pushAll(events);
    st.phase = "resolving";
    st.message = undefined;
    st.messageTimer = 0;
    st.advanceQueue();
  }

  // ---- BattleState's hooks (opts.link) -------------------------------------

  submit(st: any, action: any): void {
    this.st = st;
    const a = action?.kind === "switch" ? { kind: "switch", index: action.index }
      : { kind: "move", move: action?.move };
    this.mine = a;
    this.s.sendAction({ t: "turn", a } satisfies Wire);
    this.log(`turn ${this.turn + 1}: mine ${JSON.stringify(a)}`);
    this.wait(st);
  }

  menuChoice(st: any, choice: string): boolean {
    this.st = st;
    if (choice === "item") {
      st.refuseMenu(TEXT_NO_ITEMS);
      return true;
    }
    if (choice === "run") {
      st.refuseMenu(TEXT_NO_RUN);
      return true;
    }
    return false;
  }

  forcedPrompt(_st: any): boolean {
    return false;
  }

  forcedSwitch(st: any, index: number): boolean {
    this.st = st;
    this.s.sendAction({ t: "replace", i: index } satisfies Wire);
    this.log(`replace: mine ${index}`);
    this.battle.forcedReplacement("player", index);
    this.play(st, this.battle.takeEvents());
    return true;
  }

  // ---- once a frame -------------------------------------------------------

  service(): void {
    const st = this.st;
    const b = this.battle;
    if (!st || b.over) return;
    if (this.s.state === "closed") {
      this.log("the link closed");
      b.emit({ kind: "message", text: Strings.get(TEXT_CLOSED) });
      b.endBattle("run");
      this.mine = null;
      this.play(st, b.takeEvents());
      return;
    }
    // their turn, once mine is out
    if (this.mine) {
      const w = this.s.peekAction() as Wire | null;
      if (!w) return;
      if (w.t !== "turn") {
        // a replacement still to play first (it came before their turn)
        if (w.t === "replace" && b.pendingEnemySwitch) this.takeReplacement(st);
        else this.s.takeAction();
        return;
      }
      this.s.takeAction();
      const mine = this.mine;
      this.mine = null;
      this.turn++;
      this.log(`turn ${this.turn}: theirs ${JSON.stringify(w.a)}`);
      this.play(st, b.takeLinkTurn(mine, w.a));
      this.log(`turn ${this.turn} after: ${this.hp()}`);
      return;
    }
    // their pick after a faint: once the screen has shown the round
    if (b.pendingEnemySwitch && (st.phase === "menu" || st.phase === "link-wait")) {
      const w = this.s.peekAction() as Wire | null;
      if (w && w.t === "replace") this.takeReplacement(st);
      else if (st.phase === "menu") this.wait(st);
    }
  }

  private takeReplacement(st: any): void {
    const w = this.s.takeAction() as Wire;
    const b = this.battle;
    this.log(`replace: theirs ${w.i}`);
    b.forcedReplacement("enemy", w.i);
    // a faint of mine in the same round is asked for now (resolveFaints'
    // link arm left it to the caller)
    b.resolveFaints();
    this.play(st, b.takeEvents());
  }
}

/** The COLOSSEUM machine: both parties and half a seed each cross, then the
 *  battle; `done` when it is over (the party untouched). */
export function startLinkBattle(game: any, club: CableClub, done: () => void): void {
  const s = club.session;
  const finish = (): void => done();
  if (!s || s.state === "closed") return finish();
  if (!s.takeBegin()) s.begin();
  const myHalf = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
  const player = game.save?.player ?? {};
  s.sendParty({ mons: JSON.parse(JSON.stringify(game.save?.party ?? [])), otName: String(player.name ?? "GOLD"), otId: Number(player.id ?? 0) });
  s.sendSeed(myHalf);
  club.log("battle: party and seed sent");
  club.waitFor((x) => x.peerParty !== null && x.peerSeed !== null, 60 * 60, (ok) => {
    const p = s.peerParty;
    const seed = s.battleSeed(myHalf);
    const data = game.data;
    const valid = (m: any): boolean => !!m && typeof m.species === "string" && !!data?.pokemon?.[m.species] &&
      typeof m.level === "number" && m.level >= 1 && m.level <= 100 && typeof m.hp === "number" && Array.isArray(m.moves) && !m.isEgg;
    if (!ok || !p || seed === null) return finish();
    const theirs = p.mons.filter(valid);
    const mine = JSON.parse(JSON.stringify(game.save?.party ?? [])).filter((m: any) => !m.isEgg);
    if (theirs.length === 0 || mine.length === 0) return finish();
    const driver = new LinkBattle2(club, s, data, mine, s.peerName, theirs, seed);
    club.battle = driver;
    club.log(`battle: seed ${seed}, seat ${s.seat()}, ${mine.length} vs ${theirs.length}`);
    Screens.push(game, "Gen2BattleState", {
      battle: driver.battle,
      save: game.save,
      link: driver,
      onDone: () => {
        club.battle = null;
        if (game.stack.top()?.screenId === "Gen2BattleState") game.stack.pop();
        finish();
      },
    });
    driver.st = game.stack.top();
  });
}
