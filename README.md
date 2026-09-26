# Warlords

A turn-based fantasy strategy game after SSG's **Warlords III: Darklords Rising** (1998), rebuilt in
3D with Three.js, together with **Map Forge**, the procedural map generator that makes its worlds.

```bash
npm install
npm run dev        # the game at http://localhost:5173/ ; the generator at /forge.html
npm run build      # production build in dist/ (index.html = game, forge.html = generator)
npm run map -- 1234 "Archipelago" out.png          # headless generator check → top-down PNG
node tools/make-map.mjs 777 "Twin Realms" "Twin Realms" factions=4   # a map for the game, straight into maps/
node tools/sim.mjs maps/classic-continent.wlmap 150    # headless all-computer game (rules and AI test)
npm test           # rules tests (tests/*.test.js: combat, turns, heroes, offers, 8-side games, every map)
```

## The game (`index.html`, `src/play/`, `src/game/`)

**Maps.** The game plays the maps in the project's **`maps/`** folder. Make one in the Map Forge
(`forge.html`: tune it, then **💾 Save map for the game**) and drop the `.wlmap` file into `maps/`,
or run `tools/make-map.mjs`. A `.wlmap` holds the whole generated map (gzip, typed arrays in a
binary blob, `src/core/mapfile.js`), so a map plays the same even after the generator changes.
Every capital on a map is a side; in **New Game** each side is Human, Computer (Knight, Lord or
Warlord) or Off (its cities stay neutral). Several humans play hot-seat.

**Rules** (`src/game/`, pure JS, no three.js — the same code runs the browser game and `tools/sim.mjs`):
- **Sides and armies**: the eight standard sides (Sirians, Storm Giants, Elvallie, Horse Lords, Orcs of Kor,
  Grey Dwarves, Lord Bane, Selentines), each with eight regular army types, allies, mercenaries, four hero
  classes and its own boat (`data/sides.js`). All 95 army types of the manual's Appendix 8 with their
  strength, move, hits, production time, upkeep, view, cost and powers (`data/units.js`); the few
  Reign of Heroes types missing from the scanned table carry values in the same spirit.
- **Movement**: plains 2 MP, roads 1, forest / hills / ice 4, swamp and volcanic ground 6, fording a river +4;
  a group moves at its slowest army's pace and pays its best member's terrain bonus (elves in forests,
  dwarves in hills…); flyers cross anything; armies board ships at ports and sail. Paths are the cheapest,
  split into turns, and kept from turn to turn (`movement.js`).
- **Combat** exactly as Appendix 1 (`combat.js`): poison, disease, paralysis and curse; stack bonus
  (leadership − chaos, morale − fear, fortify − siege, each −1…5, total −3…5; city walls fortify +1…+3);
  armies fight one pair at a time, weakest first, heroes last; acid, lightning, assassination and missiles
  when an army first steps up (offset by the same skill, reduced by warding; 4-hit armies ignore missiles);
  dice rounds with medals, trample and banding. Combat dice 18–26 (default 20) is a game option.
- **Cities**: income and mana, production (up to four kinds per city, capacity bought with gold), walls
  raised Palisade → Timber Burgh → Stone Castle, vectoring new armies to another city (two turns, or
  2–5 by distance with the timed vectoring option), up to 32 defenders. Won cities are occupied,
  pillaged, sacked or razed, and a side may raze its own cities at any time; razed cities can be
  rebuilt (800 gold).
- **Economy**: gold from cities and ports, upkeep every turn; unpaid armies desert.
- **Heroes**: the 15 classes of Appendix 2 with their level tables; experience from battles, captures,
  ruins, blessings and quests; ability points buy the listed abilities (and the spells). Magic items
  (`data/items.js`), hero and mercenary offers, merchants selling items (an option).
- **Magic**: 35 spells (Appendix 3 and the Reign of Heroes spells), a mana pool per side; buffs last until
  cancelled and cost half their price in mana each turn; summons raise armies into the caster's stack.
- **Ruins and shrines**: guardians by danger (they may join the hero); gold, items, allies, mana crystals
  or a sage. Shrines bless visiting armies (+1 strength, immune to poison and disease).
- **Quests** (easy / average / hard by city size), set aside with a two-turn wait.
- **Fog of war and hidden map**, both game options: unexplored land lies under drifting cloud; explored
  land out of sight is dimmed, and enemy armies there are hidden.
- **Special sites** (`specials.js`, models from Meshy in `public/models/specials.glb`): gold mines,
  stables, smithies, weaponmasters, barracks and ranger's towers beside about two cities in three. Each
  serves its nearest city (+15 gold; +2 move for mounted armies, +1 strength, +1 hit, a turn off
  training, +2 view for the armies it trains). Any army may burn a foe's site; the city's owner
  rebuilds it for 300 gold.
- **Movement extras**: ships board at ports and at bridges (a river voyage down to the sea and back,
  `movement.js` riverVoyages); signposts at road forks name the nearest city down each road
  (`signposts.js`).
- **Diplomacy** (`diplomacy.js`, an option): war, peace and alliances between every pair of sides; each
  side's hate index (trust … frenzy) moves with attacks, conquests, razing, broken treaties, armies near
  its cities and being too powerful, and falls with bribes (50 gold a point) and common enemies. Sides at
  peace may not fight (attacking breaks the treaty); allies pass through each other's armies. Computer
  sides answer proposals, make peace when losing and pick a new war when idle.
- **Victory** (an option): Last Warlord Standing (allies left alone share it), Most Cities / Victory
  Points / Money at the turn limit, King of the Hill (hold Utopia ten days) or Fortress (every capital).
  Beaten computer sides offer to surrender to a dominant human player.
- **AI** (`ai.js`): production and walls, garrisons, target choice by value and mock battles (the combat
  advisor), heroes to ruins and quests, spells before battle; Knight / Lord / Warlord adjust its gold and
  aggression.

**Presentation** (`src/play/`):
- Armies are the 3D figures: a stack shows its leader and up to three more with a count badge; an army
  that enters a **city goes inside the castle** and only its hero (or strongest army) stands there; select
  it to see the whole garrison and march any part of it out.
- Marches follow the route (single file over bridges, ships at sea); the camera keeps them in view.
- The battle screen plays each duel, with strikes, hits, special attacks and the fallen struck off.
- Spells play 3D effects (`src/render/SpellFX.js`, bench at `spellfx.html`); spells in play leave an aura.
- Day and night run at 0.01 game hours per second; the weather changes every three days at random
  (never blizzard or mist). No sound yet.
- Portraits are rendered from the 3D models; painted art in `src/assets/art/` replaces them
  (see `tools/recraft/README.md`).
- Saves: autosave at the start of every human turn, named saves in the browser (IndexedDB), and
  `.wlsave` files to download and open. A save names its map; the map must still be in `maps/`.

**Controls**: left-click an army or a castle to select it (anything else: information); hover a tile for
the route (green: this turn, amber: later, blue: by sea) and the combat advisor's odds; right-click to
march or attack. Left-drag moves the map, right-drag turns it, wheel zooms. Keys: N next group, M continue the route,
L done, D sentry, S search, C cast, H hero, G whole stack, R reports, Enter end turn, arrows pan,
Q / E turn, Esc deselect / menu.

## Map Forge (`forge.html`, `src/main.js`, `src/generator/`)

### What it generates

- **Terrain**: domain-warped continents, ridged mountain ranges, plateaus, hydraulic + thermal erosion.
- **Seven world shapes**: continent, islands, archipelago, pangaea, coast, twoContinents, inlandSea. Eight presets. `islands` seeds one island per cell of a jittered grid and cuts a sea channel along the boundary between neighbours, so the islands are always separate.
- **Biomes**: plains, forest, hills, mountains, swamp, ice, volcanic, shore. They come from temperature (latitude + altitude), moisture (noise + distance to water) and slope.
- **Hydrology**: depression filling (priority flood), flow accumulation, river networks with tributaries, and lakes that rivers flow through. River channels are carved into the terrain with floodplains around them.
- **Volcanoes**: cones with craters, lava pools and lava flows traced downhill.
- **Realm**: 2×2-tile cities with faction capitals spread apart. Each city has a fortification level: **Palisade Fort** (level 1, defense +1), **Timber Burgh** (level 2, +2) or **Stone Castle** (level 3, +3). Every faction starts with a stone-castle capital; neutral cities roll a level (odds in `CASTLE_LEVEL_ODDS`). Castles sit square to the tile grid and fill exactly their 2×2 tiles. Each has a gate on one side (`gate`: N/E/S/W), facing the shortest walk to the nearest city. Roads link cities gate to gate and never pass through a city (spanning tree plus extra links, A* over tiles). Cities on separate landmasses (`region`) aren't linked by road. Every city can be reached: it shares its landmass with another city or sits on the coast. No castle is placed where its walls would cut a strip of land in two. Where a road crosses a river it gets a bridge set perpendicular to the flow: a **timber trestle** over streams, a **single stone arch** over rivers, a **three-arch bridge** over wide rivers.
- **Ruins & shrines** (`ruins`, `shrines` = how many to place): five ruin types — **Ruined Tower, Cave, Dungeon, Fallen Temple, Haunted Crypt** — and three shrines — **Stone Circle, Temple of Light, Rune Obelisk**. Each type prefers certain terrain (caves by mountains, crypts in swamps and forests, obelisks on ice). Sites are spread apart, kept off roads and rivers and away from cities, and sit on a levelled clearing. Every site is on a landmass that has a city, so it can be reached on foot. No site sits on a volcano's slopes, and shrines stay off volcanic ground. Ruins carry a `danger` rating (1–3); shrines grant a boon (see `SiteTypes`).

- **Ports** (`ports` = how many to place): harbours on sea coasts where armies board and leave ships. Every landmass that has a city, or is at least 8 tiles big, gets at least one, preferring the largest connected sea, so every city island can reach the others. The remaining ports up to the count go to spread-out coast near cities. The land behind each quay is levelled to the quay top.

Every step is seeded, so the same seed and parameters always give the same map.

### Rendering

- Splat-blended PBR terrain shader: slope rock, altitude/latitude snow, wet soil near rivers, road paint, animated lava, fine detail bump, optional tile grid.
- Water: the sea, lakes and rivers share one shading model. It covers depth colour from the heightfield, shoreline foam, Fresnel sky reflection and sun glitter. Rivers also get flow-aligned ripples and rapids on steep stretches. Cold water freezes.
- Sky: an atmosphere dome with sun, moon, stars and clouds. A full day/night cycle drives a shadow-casting sun or moon light and a PMREM environment map for image-based lighting.
- Weather presets (Clear → Thunderstorm, Snowfall, Blizzard, Mist) blend into each other smoothly:
  - GPU rain and snow
  - lightning bolts with sky flashes
  - cloud shadows cast across the terrain
  - a low cloud layer that stays clear around the camera focus
  - fog
  - wet ground and rain ripples
  - snow that settles on the ground and trees, and lakes that freeze
- Castles, bridges, ruins, shrines and trees are Blender models (`public/models/*.glb`). Glowing parts of the sites (runes, crystals, witch-fire, the crypt's ghost light) are emissive and pulse slowly. Bridge models stretch along their span to fit each crossing. Castles have baked stone/timber/thatch textures with ambient occlusion; roofs, banners and flags take the owner's faction colour, flags flutter, and the gatehouse faces the city's road. Trees (firs, oaks, lindens, bushes, dead trees, two variants each) are instanced with soft canopy normals and baked vertex AO, and they sway in the wind.
- Rivers are one continuous water surface over the carved channels, shaded with a world-space flow map, so bends and confluences have no seams. Each river flows at its own speed: slope measured over a few units of its course, plus its width (Manning-style), plus a per-river factor. The current is fastest mid-channel and slows toward the banks. Ripples stretch along the flow. Fast water turns choppy and white. Wide lowland rivers are calm and carry silt. Scum lines form where slack bank water meets the current, and the flow-map phase varies by place so rivers don't pulse in sync.
- Heroes (Paladin, Barbarian, Vampire Lord, Mage, Rogue, Druid) are rigged Blender figures (`public/models/heroes/*.glb`) with looping **Walk** and **Idle** clips. Cloaks, robes, plumes and shields in each hero's faction colour are tinted at runtime. Staff orbs, crystals and eyes glow. A hero's step rate follows its ground speed (the armature stores `stride` in metres per cycle). At sea a hero or unit rides in the cog from `ports.glb`, whose sail takes the owner's colour.
- Army units (`public/models/units/*.glb`) are Meshy AI models: Light Infantry, Heavy Infantry, Light Cavalry and Heavy Cavalry. Infantry are rigged by Meshy (`build_meshy_hero.py`) with **Walk**, **Run** and **Idle** clips. Their arms hang at their sides and swing forward and back, and the shields, spear and sword are rigid. Meshy can't rig a horse, so each cavalry mesh is skinned by `build_meshy_cavalry.py` onto the `horse_lib.py` skeleton, fitted to the mesh. The rider, saddle, lance and shield ride rigidly on the `saddle` bone. The clips are **Walk**, **Gallop** and **Idle**, with the horse legs solved per frame by IK, so planted hooves don't slide. Extras: `stride` (per Walk cycle), `run_stride` (per Run/Gallop cycle), `height`. `*_Accent` materials take the faction colour. A unit that stands still raises a war banner beside it (`units/banner.glb`) in its owner's colour. The cloth streams downwind with the weather's wind, flutters faster in strong wind and droops in a calm. The banner is lowered when the unit moves or embarks. So far only the test bench places units.
- Post-processing: MSAA, bloom, a lens flare that terrain can hide, ACES tone mapping, a colour grade with vignette, and optional tilt-shift.

## Project layout

```
src/generator/   pure data, no three.js — runs in a Web Worker
  generate.js      pipeline: height → erosion → climate → hydrology → biomes → tiles → cities/roads → splats → vegetation
  heightmap.js, erosion.js, hydrology.js, settlements.js, grid.js, params.js, terrainTypes.js, worker.js
src/render/      three.js: Terrain, Water, Sky, Weather, Vegetation, Structures, Volcanoes, PostFX, World
src/game/        game logic shared with the renderer: pathfinding.js (move costs, A*, reach, turns)
src/ui/          Minimap, HeroTest (hero movement test bench)
src/main.js      Map Forge bootstrap, controls, GUI, hover info, export
src/core/        rng, noise, heap, mapfile (.wlmap read/write)
src/game/        the game's rules: Game (state, turns, economy, heroes, ruins, quests), combat, movement, rules, ai, commands, data/
src/play/        the game client: main, menu, Controller (turn loop, input), GameView (3D armies), hud, dialogs, battle, fog, portraits, storage, art
maps/            maps the game offers (.wlmap)
tools/recraft/   prompt manifest for painted 2D art
tools/preview.mjs  Node-only generator preview (PNG) + stats
tools/blender/     Blender 5.x scripts that build public/models (castles, bridges, sites, trees, ports, heroes); materials.py holds the shared bake materials, hero_lib.py the hero skeleton, skinned-mesh builder and walk/idle cycles
```

## Rebuilding the models

```bash
BL=/Applications/Blender.app/Contents/MacOS/Blender
$BL -b --factory-startup --python tools/blender/build_castles.py   # ~1 min (Cycles bake on CPU)
$BL -b --factory-startup --python tools/blender/build_trees.py     # seconds
$BL -b --factory-startup --python tools/blender/build_bridges.py   # ~20 s
$BL -b --factory-startup --python tools/blender/build_sites.py     # ~1 min
$BL -b --factory-startup --python tools/blender/build_ports.py     # ~15 s (Port + Ship)
$BL -b --factory-startup --python tools/blender/build_heroes.py    # ~1 min (six heroes, one GLB each)
$BL -b --factory-startup --python tools/blender/build_meshy_hero.py  # ~10 s per hero/infantry (HERO=paladin|…|lightinfantry|heavyinfantry)
$BL -b --factory-startup --python tools/blender/build_meshy_cavalry.py  # ~40 s (both cavalry units)
$BL -b --factory-startup --python tools/blender/build_meshy_structures.py  # castles.glb + ports.glb (Port + Ship); ONLY=banner builds units/banner.glb
```

`build_heroes.py` also accepts `ONLY=Paladin,Mage`, `POSE=<walk frame>` and `CAM_ANGLE=<degrees>` for the preview. Each hero is one skinned mesh on a shared humanoid skeleton. Its rest pose can differ (a raised sword arm, a staff held forward), and the walk cycle keeps the stance foot on the ground by lowering the hips to match. `build_bridges.py`, `build_sites.py` and `build_ports.py` accept `BAKE=0` (skip the bake for a quick shape check) and `PREVIEW=/path/out.png` (EEVEE render of the set). Materials named `glow_*` end up in the `*_Glow` material, which the game renders emissive.

The Paladin is a Meshy AI model instead: `tools/meshy/paladin/` holds the concept image and the rigged Meshy exports (`walk.glb`, `idle_11.glb`, PBR maps). `build_meshy_hero.py` turns them into `paladin.glb` with the same contract as the procedural heroes: **Walk** and **Idle** clips, `stride`/`height` extras, and the blue tabard and cloak split into `Paladin_Accent` for the faction tint. Textures are downsized to 1024px, the standard for hero models (`TEX=0` keeps Meshy's 2048px). It also lowers Meshy's wide-held arms and re-skins the sword and shield rigidly (`RIGID` regions), so they no longer bend with the legs. `build_heroes.py` skips any hero that has a Meshy folder unless `PROCEDURAL=1`. Preview with `PREVIEW=/path.png CLIP=Walk|Idle FRAMES=0,8,16 CAM_ANGLE=<deg>`.

The army units follow the same Meshy standard: `tools/meshy/<unit>/` holds each concept and Meshy's exports. Infantry go through `build_meshy_hero.py` (`HERO=lightinfantry`). It also imports `run.glb`, the rig's free running clip. It hangs the arms `UNIT_ARMS` degrees from the side, keeps each arm's forward/back swing, twists the upper arm so the elbow bends forward, and keeps half of Meshy's elbow flex. Cavalry go through `build_meshy_cavalry.py`. Its preview options are `PREVIEW=/path.png CLIP=Walk|Gallop|Idle FRAMES=… BONES=1`, and `BONES=1` adds a skeleton-only row. The ship (`tools/meshy/ship/`) and the banner (`tools/meshy/banner/`) are static Meshy models built by `build_meshy_structures.py`. The old procedural `build_units.py` and `build_ports.py` would overwrite these GLBs, so run them only on purpose.

Castle materials named `*_Accent` / `*_Flag` are tinted per faction at runtime. The `Wave` colour attribute (0 at the pole, 1 at the tip) drives the flag flutter. If the GLB files are missing, castles and bridges fall back to procedural models; ruins and shrines are not drawn.

### Map data

`generateMap(params)` in `src/generator/generate.js` is a pure function, so game logic or a server can call it directly. The game-facing data is:

- `tiles` (`Uint8Array`, one of `Tile.*`) and `flags` (`Uint16Array` bit set of `Flag.RIVER | ROAD | BRIDGE | CITY | COAST | LAVA | LAKE | FROZEN | RUIN | SHRINE`), indexed `ty * tilesW + tx`
- `cities` (tile coordinates of the 2×2 footprint's top-left tile, owner faction, capital flag, castle `level` 1–3, `defense` bonus, `gate` side N/E/S/W and land `region`), `roads` (tile paths), `bridges`
- `sites` (`kind` ruin/shrine, `type`, `name`, tile `tx`/`ty`, `danger` for ruins)
- `ports` (`name`, land tile `tx`/`ty`, pier direction `dir`, the sea tile `seaTx`/`seaTy` ships leave from, sea body `sea`, landmass `region`)
- `TileInfo[type].moveCost` for pathfinding

### Movement (generator test bench)

`src/game/pathfinding.js` is pure data and reusable by the game, AI or a server:

- `new MoveGrid(map, rules?)` precomputes the MP (movement points) to enter each tile. Terrain costs come from `TileInfo` (plains 1, forest/hills/ice 2, swamp/volcanic 3; mountains and water are impassable). Roads, bridges and cities cost `road` (0.5), wading an unbridged river adds `ford` (2) and lava is impassable. At sea every tile costs `sea` (1). Units board and land **only at ports**, in straight steps, paying `embark` (1) extra. Diagonal steps cost the same as straight ones (Warlords rules; see `diagonal`) and never cut past impassable corners.
- `findPath(grid, start, goal, { blocked })` is an A* search for the cheapest route by total MP; among equal-cost routes it takes the geometrically shortest. It returns `{ tiles, costs, total }`.
- `reachable(grid, start, budget)` returns every tile reachable with a movement budget. `turnsAlong(path, mpLeft, mpMax)` splits a route into turns.

The generator's **Heroes & units (test only, not saved)** panel is a test bench:
- **Place** drops the chosen hero or army unit for the chosen faction on a land tile (Shift keeps placing).
- Click a hero to select it. Hovering a tile previews the cheapest route: green = this turn, amber = later turns (numbered where each turn ends), blue = at sea. Clicking a tile marches there.
- Heroes stop when their MP run out; **End turn** refills MP and they carry on.
- Test heroes are never part of the map, its seed or the JSON export, and a new map clears them.

The **Export map (JSON)** button saves the same data to a file.

In the browser console, `window.forge` exposes the scene, camera, sky, weather, world and params for experimenting.
