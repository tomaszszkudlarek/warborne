// High-level orders on a Game, shared by the human interface and the AI. Every step can be
// shown by async hooks (the 3D view animates the march, the battle screen plays the fight);
// without hooks the orders run instantly (headless games, tests).
//
// hooks: {
//   march(result, unitIds)   animate a move (result of Game.moveUnits) of those armies
//   battle(out)              show a battle (result of Game.attack / a ruin fight)
//   capture(stack, city)     -> 'occupy' | 'pillage' | 'sack' | 'raze' (human: a dialog)
//   captured(out)            after the city changes hands
//   searching(out)           the search is decided, before its battle is shown
//   search(out)              after a ruin search
//   cast(out)                spell effects
// }
export class Commander {
  constructor(game, hooks = {}) {
    this.game = game;
    this.hooks = hooks;
  }

  async _hook(name, ...args) { return this.hooks[name] ? this.hooks[name](...args) : undefined; }

  /**
   * Marches `unitIds` toward `goal`, fighting whatever stands on the goal if it is an enemy
   * reached this turn. Returns { move, battle, capture, stack } (stack = where the group is now).
   */
  async march(unitIds, goal, { capture = null } = {}) {
    const g = this.game;
    const move = g.moveUnits(unitIds, goal);
    if (!move) return { move: null };
    if (move.steps.length > 1) await this._hook('march', move, unitIds);
    let stack = move.stack, battle = null, cap = null;
    if (move.attack) {
      battle = g.attack(stack, move.attack.t);
      if (battle) {
        if (battle.result) await this._hook('battle', battle);
        stack = g.stack(stack.id);
        if (battle.won && battle.city && stack) {
          const choice = capture ?? (await this._hook('capture', stack, battle.city)) ?? 'occupy';
          cap = g.captureCity(stack, battle.city, choice);
          await this._hook('captured', { ...cap, stack, choice });
        } else if (battle.won && stack && stack.t === move.attack.t) {
          await this._hook('march', { stack, steps: [move.steps[move.steps.length - 1], move.attack.t], advance: true }, stack.units.map((u) => u.id));
        }
      }
      stack = stack ? g.stack(stack.id) : null;
    }
    return { move, battle, capture: cap, stack };
  }

  async search(stack) {
    const out = this.game.search(stack);
    if (!out) return null;
    await this._hook('searching', out);
    if (out.battle) await this._hook('battle', { ...out.battle, ruin: out.site, won: out.won });
    await this._hook('search', out);
    return out;
  }

  async cast(hero, spell, target = null) {
    const out = this.game.cast(hero, spell, target);
    if (out) await this._hook('cast', out);
    return out;
  }
}
