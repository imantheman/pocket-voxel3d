// gen1recomp src/core/StateStack.lua (bdfac727): the screen stack. The top
// state updates; drawing runs bottom-up from the topmost opaque state.
// A process-wide singleton like the Lua's (`StateStack:init()`).
//
// `states` is a 0-based array, so visibleBase() returns a 0-based index:
// `stack.states[stack.visibleBase()]` works as the Lua's does.

import { Runtime } from "../mods/Runtime.ts";

export interface State {
  enter?(...args: unknown[]): void;
  exit?(): void;
  update?(dt: number): void;
  draw?(): void;
  isOpaque?: boolean;
  [k: string]: any;
}

export const StateStack = {
  states: [] as State[],

  init(): typeof StateStack {
    StateStack.states = [];
    return StateStack;
  },

  push(state: State, ...args: unknown[]): void {
    StateStack.states.push(state);
    if (typeof state?.enter === "function") state.enter(...args);
    if (Runtime.wants("screen.pushed")) Runtime.emit("screen.pushed", { state });
  },

  pop(): State | undefined {
    const state = StateStack.states.pop();
    if (typeof state?.exit === "function") state.exit();
    if (state && Runtime.wants("screen.popped")) Runtime.emit("screen.popped", { state });
    return state;
  },

  top(): State | undefined {
    return StateStack.states[StateStack.states.length - 1];
  },

  clear(): void {
    while (StateStack.top()) StateStack.pop();
  },

  update(dt: number): void {
    const top = StateStack.top();
    if (top && typeof top.update === "function") top.update(dt);
  },

  renderVisible(state: State | undefined): boolean {
    if (!state) return false;
    if (!Runtime.wantsHook("screen.render_visible")) return true;
    return Runtime.call("screen.render_visible", () => true, state) !== false;
  },

  /** 0-based index of the topmost visible opaque state (0 when none). */
  visibleBase(): number {
    for (let i = StateStack.states.length - 1; i >= 0; i--) {
      const state = StateStack.states[i]!;
      if (StateStack.renderVisible(state) && state.isOpaque) return i;
    }
    return 0;
  },

  draw(): void {
    for (let i = StateStack.visibleBase(); i < StateStack.states.length; i++) {
      const state = StateStack.states[i]!;
      if (StateStack.renderVisible(state) && typeof state.draw === "function") state.draw();
    }
  },
};

export default StateStack;
