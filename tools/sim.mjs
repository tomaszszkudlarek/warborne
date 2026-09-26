// Headless all-AI game on a map from maps/: node tools/sim.mjs [map file] [rounds] [seed]
// Prints a line per round; any exception fails loudly. For testing rules and AI.
import { readFileSync } from 'node:fs';
import { decodeMap } from '../src/core/mapfile.js';
import { Game, newGameState } from '../src/game/Game.js';
import { Commander } from '../src/game/commands.js';
import { AIPlayer } from '../src/game/ai.js';

const file = process.argv[2] ?? 'maps/small-skirmish.wlmap';
const rounds = Number(process.argv[3] ?? 60);
const seed = Number(process.argv[4] ?? 1);
const map = await decodeMap(readFileSync(file));
const sides = [...new Set(map.cities.filter((c) => c.capital).map((c) => c.owner))];
const state = newGameState(map, { players: sides.map((side) => ({ side, human: false, ai: 'lord' })), seed, mapName: map.meta?.name });
const game = new Game(map, state);
const counts = {};
for (const ev of ['battle', 'captured', 'search', 'cast', 'levelUp', 'joined', 'questDone', 'eliminated']) game.on(ev, () => (counts[ev] = (counts[ev] ?? 0) + 1));
const cmd = new Commander(game);
const t0 = performance.now();
while (!state.over && state.round <= rounds) {
  const pid = game.currentId;
  await new AIPlayer(cmd, pid).play();
  const r = state.round;
  game.endTurn();
  if (state.round !== r && (r % 5 === 0 || state.over)) {
    console.log(`round ${r}: ` + state.players.map((p) => `${p.name.split(' ')[0]} c${game.citiesOf(p.id).length} a${game.stacksOf(p.id).reduce((n, k) => n + k.units.length, 0)} g${p.gold} m${p.mana}${p.alive ? '' : ' X'}`).join(' | ') + ` | neutral c${game.citiesOf(-1).length} | ${state.weather.name}`);
  }
}
console.log('events', counts, 'winner', state.winner, 'over', state.over, `${((performance.now() - t0) / 1000).toFixed(1)} s`, 'save KB', (JSON.stringify(state).length / 1024).toFixed(0));
console.log(state.log.slice(-12).map((e) => e.text).join('\n'));
