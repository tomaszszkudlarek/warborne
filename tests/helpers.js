// Shared test fixtures: maps from maps/ (decoded once) and fresh games on them.
import { readFileSync } from 'node:fs';
import { decodeMap } from '../src/core/mapfile.js';
import { Game, newGameState } from '../src/game/Game.js';

const cache = new Map();
/** A map from the maps/ folder, decoded once per test run (games copy what they change). */
export async function loadMap(file = 'small-skirmish.wlmap') {
  if (!cache.has(file)) cache.set(file, await decodeMap(readFileSync(new URL(`../maps/${file}`, import.meta.url))));
  const map = cache.get(file);
  return { ...map, cities: map.cities.map((c) => ({ ...c })) };
}

/** The sides that have a capital on `map`, in order. */
export const sidesOf = (map) => [...new Set(map.cities.filter((c) => c.capital).map((c) => c.owner))].sort((a, b) => a - b);

/** A new game: `humans` is how many of the map's sides (first ones) a human plays. */
export async function newGame(file = 'small-skirmish.wlmap', { humans = 1, seed = 7, options = {} } = {}) {
  const map = await loadMap(file);
  const players = sidesOf(map).map((side, i) => ({ side, human: i < humans, ai: 'lord' }));
  const state = newGameState(map, { players, seed, options, mapName: map.meta?.name });
  return new Game(map, state);
}

/** Every army of the game, with the stack holding it. */
export const allUnits = (g) => g.s.stacks.flatMap((k) => k.units.map((u) => ({ u, k })));
