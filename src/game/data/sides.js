// The eight sides of Warborne (modelled on Warlords III: Darklords Rising's eight). Colour and boat come from
// generator/terrainTypes.js Factions (same order: side i owns the map's faction-i capital).
//   units    the eight regular army types the side produces (cheapest first)
//   allies   creatures that may join its heroes (ruins, quests), strongest last
//   mercs    mercenaries that offer their services now and then
//   heroes   hero classes the side recruits
import { Factions } from '../../generator/terrainTypes.js';

const S = (units, allies, mercs, heroes, title) => ({ units, allies, mercs, heroes, title });

const DEFS = [
  S(['lightinfantry', 'pikeman', 'archer', 'heavyinfantry', 'lightcavalry', 'heavycavalry', 'knight', 'knightlord'],
    ['pegasus', 'unicorn', 'archon', 'silverdragon'], ['dwarf', 'scout', 'siegeengine'],
    ['paladin', 'priest', 'warrior', 'wizard'], 'The Knights of Sirath'),
  S(['lightinfantry', 'archer', 'heavyinfantry', 'lightcavalry', 'catapult', 'giant', 'eagle', 'rockelemental'],
    ['griffon', 'airelemental', 'bluedragon', 'golddragon'], ['barbarians', 'halfling', 'ballista'],
    ['warrior', 'general', 'wizard', 'barbarian'], 'The Thunderborn Titans'),
  S(['elveninfantry', 'elf', 'dryad', 'elvencavalry', 'centaur', 'unicorn', 'elflord', 'treant'],
    ['pegasus', 'eagle', 'griffon', 'greendragon'], ['halfling', 'scout', 'ballista'],
    ['ranger', 'wizard', 'bard', 'shaman'], 'The Elves of Elvanor'),
  S(['scout', 'lightinfantry', 'archer', 'lightcavalry', 'heavycavalry', 'knight', 'pegasus', 'catapult'],
    ['unicorn', 'griffon', 'nightmare', 'golddragon'], ['barbarians', 'pikeman', 'heavyinfantry'],
    ['general', 'paladin', 'warrior', 'ranger'], 'The Riders of the Horsemarch'),
  S(['goblin', 'orc', 'wolfrider', 'orog', 'warg', 'ogre', 'troll', 'catapult'],
    ['giantbat', 'minotaur', 'firedemon', 'reddragon'], ['gnoll', 'gnollcrossbow', 'gnollcavalry'],
    ['barbarian', 'warrior', 'shaman', 'thief'], 'The Hordes of Kragg'),
  S(['dwarfrunner', 'dwarf', 'dwarfcrossbow', 'dwarfmutant', 'stonegolem', 'ballista', 'siegeengine', 'irongolem'],
    ['rockelemental', 'cavewyrm', 'giant', 'dustwyrm'], ['pikeman', 'catapult', 'claygolem'],
    ['warrior', 'alchemist', 'general', 'priest'], 'The Ashen Dwarves of Duraz'),
  S(['skeleton', 'zombie', 'ghoul', 'wight', 'mummy', 'wraith', 'lich', 'undeadbeast'],
    ['giantbat', 'spectre', 'nightmare', 'undeaddragon'], ['orc', 'plaguecarrier', 'reaver'],
    ['necromancer', 'vampire', 'priest', 'warrior'], 'The Legions of Lord Vhane'),
  S(['lightinfantry', 'pikeman', 'moonguard', 'harpy', 'iceguard', 'medusa', 'cockatrice', 'darkpegasus'],
    ['imp', 'icedemon', 'airelemental', 'blackdragon'], ['assassin', 'giantspider', 'giantscorpion'],
    ['wizard', 'summoner', 'monk', 'thief'], 'The Selenari Empire'),
];

export const SIDES = Factions.map((f, i) => ({ ...f, ...DEFS[i], id: i }));

/** Neutral cities produce from this pool (a mix of every side's cheaper troops). */
export const NEUTRAL_POOL = [
  'lightinfantry', 'pikeman', 'archer', 'heavyinfantry', 'lightcavalry', 'orc', 'goblin', 'dwarf', 'elveninfantry',
  'skeleton', 'zombie', 'wolfrider', 'scout', 'barbarians', 'peasant', 'gnoll', 'halfling', 'moonguard',
];

// Per-side city names are the map's own; these are the AI difficulty levels.
export const AI_LEVELS = {
  knight: { name: 'Knight', gold: 0.8, aggression: 0.6, think: 1 },
  lord: { name: 'Lord', gold: 1.0, aggression: 0.8, think: 2 },
  warlord: { name: 'Warlord', gold: 1.35, aggression: 1.0, think: 3 },
};
