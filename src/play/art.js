// Painted artwork (Recraft, see tools/recraft/) that replaces the generated stand-ins when
// present: src/assets/art/units/<unit or hero model key>.webp, spells/<spell id>.webp,
// items/<item key>.webp, backgrounds/<name>.webp. Missing files fall back to portraits
// rendered from the 3D models, emoji glyphs and screenshots of the map.
const pick = (glob) => Object.fromEntries(Object.entries(glob).map(([path, url]) => [path.split('/').pop().replace(/\.(webp|png|jpe?g)$/, ''), url]));

const UNITS = pick(import.meta.glob('/src/assets/art/units/*.{webp,png,jpg}', { query: '?url', import: 'default', eager: true }));
const SPELLS = pick(import.meta.glob('/src/assets/art/spells/*.{webp,png,jpg}', { query: '?url', import: 'default', eager: true }));
const ITEMS = pick(import.meta.glob('/src/assets/art/items/*.{webp,png,jpg}', { query: '?url', import: 'default', eager: true }));
const BACKGROUNDS = pick(import.meta.glob('/src/assets/art/backgrounds/*.{webp,png,jpg}', { query: '?url', import: 'default', eager: true }));

export const art = {
  unit: (type) => UNITS[type] ?? null,
  spell: (id) => SPELLS[id] ?? null,
  item: (key) => ITEMS[key] ?? null,
  background: (name) => BACKGROUNDS[name] ?? null,
};
