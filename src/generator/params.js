// Generator parameters. Every knob is normalized (0..1) unless noted, so presets
// and UI sliders stay simple.
export const defaultParams = {
  seed: 20240,
  shape: 'continent', // continent | islands | archipelago | pangaea | coast | twoContinents | inlandSea
  tilesW: 72,
  tilesH: 54,
  detail: 5, // heightfield cells per tile edge (3..8)

  water: 0.42, // fraction of the map below sea level
  landScale: 1.0, // size of landmasses (bigger = larger, smoother features)
  mountains: 0.55,
  hills: 0.5, // relief of the land: 0 flat lowlands (mostly plains), 0.5 normal, 1 rugged
  roughness: 0.5,
  erosion: 0.6,
  volcanoes: 2, // count

  temperature: 0.0, // -0.5 (arctic) .. +0.5 (tropical)
  moisture: 0.0, // -0.5 (arid) .. +0.5 (wet)
  forests: 0.5,
  swamps: 0.45,
  ice: 0.35, // how far the polar ice reaches south

  rivers: 0.55, // density
  maxRivers: 16,
  riverWidth: 1.0,
  lakes: 0.5,

  cities: 14,
  roads: true,
  factions: 8, // sides with a capital (Warlords has eight)
  ruins: 8, // count
  shrines: 4, // count
  ports: 6, // count; every landmass gets at least one regardless
};

export const shapes = ['continent', 'islands', 'archipelago', 'pangaea', 'coast', 'twoContinents', 'inlandSea'];

export const presets = {
  'Classic Continent': {},
  'Island Kingdoms': { shape: 'islands', water: 0.55, landScale: 0.9, rivers: 0.45, cities: 12 },
  'Archipelago': { shape: 'archipelago', water: 0.62, mountains: 0.45, rivers: 0.35, cities: 16, volcanoes: 3, ruins: 6, shrines: 3 },
  'Frozen North': { shape: 'pangaea', water: 0.22, temperature: -0.12, ice: 0.62, forests: 0.6, swamps: 0.1, volcanoes: 1, lakes: 0.8 },
  'Volcanic Wastes': { shape: 'coast', water: 0.35, temperature: 0.2, volcanoes: 6, mountains: 0.7, forests: 0.25, swamps: 0.2, ice: 0.05 },
  'Swamplands': { shape: 'inlandSea', water: 0.3, moisture: 0.15, swamps: 0.62, forests: 0.6, mountains: 0.3, temperature: 0.15, ice: 0.1, rivers: 0.8 },
  'Twin Realms': { shape: 'twoContinents', water: 0.45, mountains: 0.65, rivers: 0.6 },
  'Great Highlands': { shape: 'pangaea', water: 0.18, mountains: 0.9, roughness: 0.75, erosion: 0.9, rivers: 0.75, lakes: 0.8, maxRivers: 24, ruins: 11 },
};
