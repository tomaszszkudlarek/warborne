// Army types (Warlords III: Darklords Rising manual, Appendix 8). The key is also the
// model key in render/Heroes.js HERO_TYPES.
//   str   combat strength 1-9        move  movement points per turn
//   hits  hit points                 time  turns to produce
//   upkeep gold per turn             view  viewing range (tiles)
//   cost  gold to buy the capacity to produce it in a city
//   ab    abilities { missile, morale, assassin, siege, chaos, paralysis, acid, lightning,
//         fear, curse, disease, poison, trample, banding, warding, fortify, leadership }
//   bonus movement: 'fly' (any terrain, sea included), 'forest', 'hills', 'marsh', 'snow', 'all'
// Types missing from the manual's scanned table (Reign of Heroes armies) carry values in
// the same spirit (marked RoH).
const U = (name, str, move, hits, time, upkeep, view, cost, ab = {}, extra = {}) =>
  ({ name, str, move, hits, time, upkeep, view, cost, ab, ...extra });

export const UNITS = {
  archer: U('Archers', 3, 19, 1, 1, 1, 2, 90, { missile: 2 }),
  archon: U('Archons', 8, 26, 2, 4, 12, 4, 1300, { morale: 3 }, { bonus: 'fly' }),
  assassin: U('Assassin', 1, 18, 1, 3, 25, 3, 600, { assassin: 5 }),
  ballista: U('Ballistae', 5, 16, 1, 2, 4, 1, 300, { missile: 1 }),
  barbarians: U('Barbarians', 2, 16, 2, 1, 1, 3, 75),
  giantbat: U('Giant Bats', 1, 28, 1, 1, 1, 3, 35, {}, { bonus: 'fly' }),
  catapult: U('Catapults', 2, 16, 1, 2, 4, 2, 250, { siege: 2 }),
  cavewyrm: U('Cave Wyrms', 6, 20, 3, 4, 10, 1, 1000, { siege: 1 }, { bonus: 'hills' }),
  centaur: U('Centaurs', 4, 22, 2, 2, 4, 3, 500, { missile: 2 }, { bonus: 'forest' }),
  cockatrice: U('Cockatrice', 4, 50, 2, 3, 2, 5, 450, { paralysis: 3 }, { bonus: 'fly' }),
  firedemon: U('Fire Demons', 8, 20, 3, 4, 10, 2, 1200, { chaos: 3 }, { bonus: 'all' }),
  icedemon: U('Ice Demons', 5, 22, 3, 3, 10, 2, 800, { chaos: 2 }, { bonus: 'snow' }),
  blackdragon: U('Black Dragons', 9, 26, 3, 5, 14, 4, 1500, { acid: 5 }, { bonus: 'fly' }),
  bluedragon: U('Blue Dragons', 9, 26, 3, 5, 14, 4, 1500, { lightning: 5 }, { bonus: 'fly' }),
  golddragon: U('Gold Dragons', 9, 26, 3, 5, 14, 4, 1500, { morale: 4 }, { bonus: 'fly' }),
  greendragon: U('Green Dragons', 9, 26, 3, 5, 14, 4, 1500, { fear: 5 }, { bonus: 'fly' }),
  reddragon: U('Red Dragons', 9, 26, 3, 5, 14, 4, 1500, { chaos: 5 }, { bonus: 'fly' }),
  silverdragon: U('Silver Dragon', 9, 30, 3, 5, 16, 4, 1200, { morale: 3 }, { bonus: 'fly' }),
  undeaddragon: U('Undead Dragon', 9, 24, 4, 5, 4, 3, 1500, { curse: 5 }, { bonus: 'fly', undead: true }),
  dryad: U('Dryads', 2, 18, 2, 2, 1, 2, 100, { morale: 1 }, { bonus: 'forest' }),
  dustwyrm: U('Dust Wyrms', 5, 18, 3, 4, 8, 1, 1000, { siege: 3 }, { bonus: 'hills' }),
  dwarfcrossbow: U('Dwarf Crossbows', 2, 15, 3, 1, 2, 2, 400, { missile: 2 }, { bonus: 'hills' }),
  dwarf: U('Dwarf Infantry', 3, 14, 3, 1, 2, 2, 100, {}, { bonus: 'hills' }),
  dwarfmutant: U('Dwarf Mutants', 5, 15, 3, 3, 6, 2, 600, { chaos: 2 }, { bonus: 'hills' }),
  dwarfrunner: U('Dwarf Runners', 1, 18, 4, 1, 1, 2, 30, {}, { bonus: 'hills' }),
  eagle: U('Eagles', 6, 36, 2, 3, 6, 4, 750, { morale: 1 }, { bonus: 'fly' }),
  airelemental: U('Air Elementals', 7, 36, 2, 4, 8, 3, 1100, { morale: 2 }, { bonus: 'fly' }),
  fireelemental: U('Fire Elementals', 7, 32, 2, 4, 4, 2, 1100, { chaos: 2 }, { bonus: 'all' }),
  rockelemental: U('Rock Elementals', 6, 16, 4, 4, 4, 1, 1000, {}, { bonus: 'hills' }),
  elephant: U('Elephants', 8, 16, 3, 4, 5, 3, 800, { trample: 1 }),
  elf: U('Elven Archers', 3, 16, 1, 1, 2, 3, 350, { missile: 4 }, { bonus: 'forest' }),
  elvencavalry: U('Elven Cavalry', 5, 30, 1, 2, 4, 3, 250, { morale: 1 }, { bonus: 'forest' }),
  elveninfantry: U('Elven Infantry', 4, 19, 1, 1, 1, 3, 50, {}, { bonus: 'forest' }),
  elflord: U('Elven Lords', 6, 24, 2, 3, 2, 3, 700, { morale: 2 }, { bonus: 'forest' }),
  ghost: U('Ghosts', 5, 18, 2, 2, 2, 2, 450, { curse: 4 }, { bonus: 'fly', undead: true }),
  ghoul: U('Ghouls', 3, 15, 2, 1, 3, 2, 300, { disease: 2 }, { undead: true }),
  giantbee: U('Giant Bees', 2, 38, 1, 2, 2, 3, 300, { poison: 4 }, { bonus: 'fly' }),
  giantscorpion: U('Giant Scorpions', 5, 22, 2, 3, 3, 2, 500, { poison: 6 }),
  giantspider: U('Giant Spiders', 4, 20, 1, 2, 3, 2, 350, { poison: 3 }, { bonus: 'forest' }),
  giant: U('Giants', 6, 16, 3, 3, 8, 2, 1000, { chaos: 2 }, { bonus: 'hills' }),
  gnollcavalry: U('Gnoll Cavalry', 5, 24, 2, 3, 7, 2, 700, { assassin: 4 }),
  gnollcrossbow: U('Gnoll Crossbows', 4, 15, 2, 2, 4, 2, 300, { assassin: 2 }),
  gnoll: U('Gnoll Infantry', 2, 15, 2, 1, 2, 2, 100, { assassin: 1 }),
  goblin: U('Goblins', 1, 20, 2, 1, 1, 3, 10),
  claygolem: U('Clay Golems', 4, 16, 2, 2, 2, 1, 400, { trample: 1 }),
  irongolem: U('Iron Golem', 6, 16, 3, 4, 1, 2, 1000, { trample: 3 }),
  stonegolem: U('Stone Golem', 5, 16, 2, 3, 1, 2, 650, { trample: 2 }),
  griffon: U('Griffons', 6, 26, 2, 3, 6, 3, 700, { morale: 1 }, { bonus: 'fly', roh: true }),
  halfling: U('Halflings', 2, 18, 1, 1, 1, 3, 30, { banding: 2 }, { roh: true }),
  harpy: U('Harpies', 3, 26, 2, 2, 3, 3, 350, { fear: 1 }, { bonus: 'fly', roh: true }),
  heavycavalry: U('Heavy Cavalry', 5, 20, 2, 2, 3, 2, 200, {}, { roh: true }),
  heavyinfantry: U('Heavy Infantry', 3, 14, 2, 1, 2, 2, 60, {}, { roh: true }),
  hellhound: U('Hellhounds', 5, 22, 2, 2, 4, 2, 400, { chaos: 1 }, { roh: true }),
  imp: U('Imps', 3, 22, 1, 1, 2, 2, 150, { chaos: 1 }, { bonus: 'fly', roh: true }),
  knight: U('Knights', 6, 20, 2, 3, 6, 2, 600, { morale: 1 }, { roh: true }),
  knightlord: U('Knight Lords', 8, 22, 3, 4, 10, 2, 1300, { morale: 2 }, { roh: true }),
  lich: U('Liches', 7, 16, 2, 4, 10, 3, 1200, { fear: 3 }, { undead: true, roh: true }),
  lightcavalry: U('Light Cavalry', 3, 24, 1, 1, 2, 3, 100, {}, { roh: true }),
  lightinfantry: U('Light Infantry', 2, 16, 1, 1, 1, 2, 30, {}, { roh: true }),
  medusa: U('Medusae', 4, 16, 2, 3, 5, 2, 600, { paralysis: 2 }, { bonus: 'marsh', roh: true }),
  minotaur: U('Minotaurs', 6, 16, 3, 3, 6, 2, 700, { trample: 1 }, { roh: true }),
  moonguard: U('Moonguard', 5, 18, 2, 2, 4, 3, 450, { warding: 2 }, { roh: true }),
  iceguard: U('Iceguard', 5, 16, 3, 3, 5, 2, 500, { warding: 1 }, { bonus: 'snow', roh: true }),
  mummy: U('Mummies', 4, 12, 3, 2, 3, 1, 350, { disease: 3 }, { undead: true, roh: true }),
  nightmare: U('Nightmares', 7, 26, 2, 3, 8, 3, 900, { fear: 2 }, { roh: true }),
  ogre: U('Ogres', 4, 16, 2, 2, 5, 2, 400, { morale: 1 }),
  orc: U('Orc Mobs', 2, 16, 2, 1, 1, 2, 60),
  orog: U('Orogs', 4, 20, 2, 2, 4, 2, 300, { siege: 1 }),
  peasant: U('Peasants', 1, 18, 2, 1, 1, 3, 10, { banding: 3 }),
  pegasus: U('Pegasi', 5, 24, 2, 2, 10, 3, 500, { morale: 1 }, { bonus: 'fly' }),
  darkpegasus: U('Dark Pegasi', 5, 22, 2, 2, 10, 3, 500, { fear: 2 }, { bonus: 'fly' }),
  pikeman: U('Pikemen', 2, 16, 3, 1, 1, 2, 100),
  plaguecarrier: U('Plague Carriers', 7, 15, 1, 2, 1, 1, 600, { disease: 5 }, { bonus: 'marsh' }),
  giantrat: U('Giant Rats', 1, 18, 1, 1, 1, 2, 100, { banding: 5 }),
  reaver: U('Reavers', 6, 16, 3, 3, 6, 3, 650, { chaos: 1 }),
  scout: U('Scouts', 1, 26, 1, 1, 1, 3, 10),
  siegeengine: U('Siege Engines', 3, 16, 2, 3, 4, 2, 600, { siege: 4 }),
  skeleton: U('Skeletons', 2, 16, 1, 1, 1, 2, 75, { warding: 2 }, { undead: true }),
  slayerknight: U('Slayer Knights', 7, 16, 3, 4, 10, 1, 1300, { chaos: 4 }),
  spectre: U('Spectres', 8, 22, 2, 4, 10, 3, 1000, { curse: 6 }, { bonus: 'fly', undead: true }),
  treant: U('Treants', 5, 14, 4, 4, 10, 2, 1300, { siege: 3 }, { bonus: 'forest' }),
  troll: U('Trolls', 5, 16, 2, 3, 6, 1, 650, { fear: 2 }, { bonus: 'marsh' }),
  undeadbeast: U('Undead Beast', 8, 20, 3, 5, 9, 2, 1400, { chaos: 4 }, { undead: true }),
  unicorn: U('Unicorns', 6, 28, 2, 3, 5, 4, 750, { morale: 3 }, { bonus: 'forest' }),
  warg: U('Wargs', 4, 25, 2, 2, 3, 2, 400, { warding: 4 }),
  wight: U('Wights', 4, 16, 2, 2, 2, 2, 250, { fear: 2 }, { undead: true }),
  wolfrider: U('Wolfriders', 3, 25, 2, 2, 3, 3, 150, { warding: 3 }),
  wraith: U('Wraiths', 5, 24, 2, 3, 5, 2, 700, { fear: 3 }, { bonus: 'fly', undead: true }),
  zombie: U('Zombies', 2, 13, 3, 1, 1, 1, 100, { fear: 1 }, { undead: true }),
  greenslime: U('Green Slime', 3, 10, 4, 2, 2, 1, 250, { acid: 2 }, { bonus: 'marsh', roh: true }),
};

// Ships (one per side). Armies at sea fight at no more than their boat's strength.
export const BOATS = {
  Boat_Barge: { name: 'Barge', str: 1 },
  Boat_Boneship: { name: 'Boneship', str: 4 },
  Boat_Greatship: { name: 'Greatship', str: 5 },
  Boat_Warship: { name: 'Warship', str: 6 },
  Boat_WaterElemental: { name: 'Water Elemental', str: 7 },
  Ship: { name: 'Cog', str: 3 },
};

export const ABILITY_NAMES = {
  missile: 'Missiles', morale: 'Morale', assassin: 'Assassin', siege: 'Siege', chaos: 'Chaos',
  paralysis: 'Paralysis', acid: 'Acid', lightning: 'Lightning', fear: 'Fear', curse: 'Curse',
  disease: 'Disease', poison: 'Poison', trample: 'Trample', banding: 'Banding', warding: 'Warding',
  fortify: 'Fortify', leadership: 'Leadership', firststrike: 'First Strike',
};

export const BONUS_NAMES = { fly: 'Flying', forest: 'Forest move', hills: 'Hill move', marsh: 'Marsh move', snow: 'Snow move', all: 'All-terrain move' };

/** Ruin guardians by danger (1-3): monsters a hero must defeat (or who may join him). */
export const GUARDIANS = {
  1: ['giantspider', 'giantrat', 'ghoul', 'orc', 'wolfrider', 'harpy', 'giantbat', 'zombie', 'goblin', 'mummy'],
  2: ['troll', 'minotaur', 'wraith', 'ogre', 'hellhound', 'medusa', 'giantscorpion', 'wight', 'greenslime', 'nightmare'],
  3: ['reddragon', 'firedemon', 'lich', 'giant', 'spectre', 'undeadbeast', 'blackdragon', 'icedemon', 'greendragon'],
};
