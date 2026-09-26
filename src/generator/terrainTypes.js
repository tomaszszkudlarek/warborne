// Game-facing terrain classification (Warlords-style tile types).
export const Tile = Object.freeze({
  WATER: 0,
  PLAINS: 1,
  FOREST: 2,
  HILLS: 3,
  MOUNTAINS: 4,
  SWAMP: 5,
  ICE: 6,
  VOLCANIC: 7,
  SHORE: 8,
});

export const TileInfo = [
  { name: 'Water', color: '#2c6a9e', moveCost: Infinity },
  { name: 'Plains', color: '#8fb35a', moveCost: 1 },
  { name: 'Forest', color: '#3f6b2c', moveCost: 2 },
  { name: 'Hills', color: '#a39a62', moveCost: 2 },
  { name: 'Mountains', color: '#8a8580', moveCost: Infinity },
  { name: 'Swamp', color: '#56613d', moveCost: 3 },
  { name: 'Ice', color: '#dbe8f0', moveCost: 2 },
  { name: 'Volcanic', color: '#4a3530', moveCost: 3 },
  { name: 'Shore', color: '#d8c48e', moveCost: 1 },
];

// Tile flag bits
export const Flag = Object.freeze({
  RIVER: 1,
  ROAD: 2,
  BRIDGE: 4,
  CITY: 8,
  COAST: 16,
  LAVA: 32,
  LAKE: 64,
  FROZEN: 128,
  RUIN: 256,
  SHRINE: 512,
  PORT: 1024,
});

// Per-cell (heightfield vertex) biome used for texturing and vegetation.
export const Biome = Object.freeze({
  OCEAN: 0,
  LAKE: 1,
  BEACH: 2,
  PLAINS: 3,
  FOREST: 4,
  HILLS: 5,
  MOUNTAIN: 6,
  SWAMP: 7,
  ICE: 8,
  VOLCANIC: 9,
});

export const BiomeToTile = [
  Tile.WATER, Tile.WATER, Tile.SHORE, Tile.PLAINS, Tile.FOREST,
  Tile.HILLS, Tile.MOUNTAINS, Tile.SWAMP, Tile.ICE, Tile.VOLCANIC,
];

// Eight sides (after Warlords III's eight, renamed for Warborne); neutral cities are grey.
// `boat`: what the side's armies sail in (an object in ports.glb, Structures.js createShip)
export const Factions = [
  { name: 'Sirathi', color: '#e8e8f0', boat: 'Boat_Greatship' },
  { name: 'Thunder Titans', color: '#e0c030', boat: 'Boat_Warship' },
  { name: 'Elvanor', color: '#30a040', boat: 'Ship' },
  { name: 'Horsemarch', color: '#3060d0', boat: 'Boat_Barge' },
  { name: 'Orcs of Kragg', color: '#c02020', boat: 'Boat_Warship' },
  { name: 'Ashen Dwarves', color: '#8a6a40', boat: 'Boat_Barge' },
  { name: 'Lord Vhane', color: '#202020', boat: 'Boat_Boneship' },
  { name: 'Selenari', color: '#8040b0', boat: 'Boat_WaterElemental' },
];
export const NEUTRAL_COLOR = '#7a7a7a';

// City fortifications. `defense` is the bonus granted to defenders of the city.
// Capitals always start as stone castles; other cities roll a level at generation.
export const CastleLevels = [
  null,
  { level: 1, name: 'Palisade Fort', defense: 1 },
  { level: 2, name: 'Timber Burgh', defense: 2 },
  { level: 3, name: 'Stone Castle', defense: 3 },
];
// Chance of each level for a non-capital city (levels 1..3).
export const CASTLE_LEVEL_ODDS = [0.5, 0.35, 0.15];

// Map sites. Ruins are explored by heroes (guarded, `danger` 1-3, hold treasure);
// shrines grant a boon to armies that visit. `model` is the object name in sites.glb.
export const SiteTypes = {
  tower: { kind: 'ruin', name: 'Ruined Tower', model: 'Ruin_Tower', title: 'Tower of' },
  cave: { kind: 'ruin', name: 'Cave', model: 'Ruin_Cave', title: 'Caves of' },
  dungeon: { kind: 'ruin', name: 'Dungeon', model: 'Ruin_Dungeon', title: 'Halls of' },
  temple: { kind: 'ruin', name: 'Fallen Temple', model: 'Ruin_Temple', title: 'Temple of' },
  crypt: { kind: 'ruin', name: 'Haunted Crypt', model: 'Ruin_Crypt', title: 'Tomb of' },
  circle: { kind: 'shrine', name: 'Stone Circle', model: 'Shrine_Circle', title: 'Stones of', boon: 'Blessing: +1 strength to visiting armies' },
  sanctum: { kind: 'shrine', name: 'Temple of Light', model: 'Shrine_Temple', title: 'Sanctum of', boon: 'Sanctuary: heals armies, heroes receive quests' },
  obelisk: { kind: 'shrine', name: 'Rune Obelisk', model: 'Shrine_Obelisk', title: 'Obelisk of', boon: 'Sight: reveals the land for miles around' },
};
export const RUIN_TYPES = Object.keys(SiteTypes).filter((k) => SiteTypes[k].kind === 'ruin');
export const SHRINE_TYPES = Object.keys(SiteTypes).filter((k) => SiteTypes[k].kind === 'shrine');
