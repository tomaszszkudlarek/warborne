import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Factions, NEUTRAL_COLOR } from '../generator/terrainTypes.js';
import { createShip } from './Structures.js';
import { U } from './uniforms.js';
import { sharpenTextures, gltfLoader } from './Assets.js';

// Hero figures (public/models/heroes/*.glb, tools/blender/build_meshy_hero.py) and army
// units (public/models/units/*.glb: infantry, giant, archon and the other humanoids from build_meshy_hero.py,
// cavalry, wolves, unicorn, pegasus and griffon from build_meshy_cavalry.py; dragon, catapult, ballista,
// siege tower, eagle, bat, bee, spider, scorpion, cockatrice and slime from build_meshy_beasts.py).
// Armies sail in their faction's boat (Factions[].boat in ports.glb).
// The model's `height` is fitted to `size` world units (HERO_HEIGHT by default) unless
// `scale` (world units per model metre) is given: a mounted unit's height includes horse
// and lance, the dragon and catapult are built in world units.
//   unit      plants a war banner (`banner` world units tall) while it stands
//   fly       flies over any ground and water (no ship), hovering `hover` units up and
//             leaning `lean` radians into its flight; Walk is its flight clip
//   vehicle   rolls: its body tilts with the slope under it
//   speed     ground speed factor (an army marches at its slowest member's pace)
//   tint      recolours the Base material (dragon species, demons, golems ... share one model)
//   glow      false keeps a tinted variant's *_Glow parts unlit (air / rock elementals)
//   room      width it takes in an army's formation (default 1.1 * ring)
// dragon species share the model; `tint` recolours the scales
const DRAGON = { file: 'units/dragon.glb', unit: true, fly: true, scale: 1.08, hover: 3.5, lean: 0.06, ring: 2.15, room: 4.2 };
// other kin that share a model and differ by `tint` (fire / ice demons, the golems, ...)
const ORC = { file: 'units/orc.glb', unit: true, size: 1.95, ring: 1.1 };
const ZOMBIE = { file: 'units/zombie.glb', unit: true, size: 1.75, speed: 0.85 };
const DEMON = { file: 'units/demon.glb', unit: true, size: 3.0, ring: 1.3, banner: 3.8 };
const GOLEM = { file: 'units/golem.glb', unit: true, size: 2.8, ring: 1.35, banner: 3.6, speed: 0.85 };
const OGRE = { file: 'units/ogre.glb', unit: true, size: 2.7, ring: 1.3, banner: 3.6, speed: 0.95 };
// wraiths float over land and sea on their robes (Walk is the idle, see build_meshy_hero.py HOVERERS)
const WRAITH = { file: 'units/wraith.glb', unit: true, fly: true, size: 2.0, hover: 0.45, lean: 0.12 };
const WARG = { file: 'units/warg.glb', unit: true, scale: 0.85, ring: 1.2, banner: 2.6, speed: 1.15 };
const ELEMENTAL = { file: 'units/fireelemental.glb', unit: true, size: 2.6, ring: 1.2, banner: 3.4 };
const ELF = { file: 'units/elf.glb', unit: true, size: 1.85, speed: 1.05 };
const KNIGHT = { file: 'units/heavycavalry.glb', unit: true, scale: 0.78, ring: 1.35, banner: 3.1 };
const DWARF = { file: 'units/dwarf.glb', unit: true, size: 1.4, speed: 0.9 };
const GNOLL = { file: 'units/gnoll.glb', unit: true, size: 2.0 };
const UNICORN = { file: 'units/unicorn.glb', unit: true, scale: 0.78, ring: 1.35, banner: 3.1, speed: 1.1 };
// winged horses fly on the horse rig: galloping legs under beating wings
const PEGASUS = { file: 'units/pegasus.glb', unit: true, fly: true, scale: 0.78, hover: 1.0, lean: 0.12, ring: 1.35, room: 2.0 };
export const HERO_TYPES = {
  paladin: { name: 'Paladin', file: 'heroes/paladin.glb' },
  barbarian: { name: 'Barbarian', file: 'heroes/barbarian.glb' },
  vampire: { name: 'Vampire Lord', file: 'heroes/vampire.glb' },
  mage: { name: 'Mage', file: 'heroes/mage.glb' },
  rogue: { name: 'Rogue', file: 'heroes/rogue.glb' },
  druid: { name: 'Druid', file: 'heroes/druid.glb' },
  alchemist: { name: 'Alchemist', file: 'heroes/alchemist.glb' },
  bard: { name: 'Bard', file: 'heroes/bard.glb' },
  general: { name: 'General', file: 'heroes/general.glb' },
  monk: { name: 'Monk', file: 'heroes/monk.glb' },
  necromancer: { name: 'Necromancer', file: 'heroes/necromancer.glb' },
  priest: { name: 'Priest', file: 'heroes/priest.glb' },
  ranger: { name: 'Ranger', file: 'heroes/ranger.glb' },
  summoner: { name: 'Summoner', file: 'heroes/summoner.glb' },
  warrior: { name: 'Warrior', file: 'heroes/warrior.glb' },
  lightinfantry: { name: 'Light Infantry', file: 'units/lightinfantry.glb', unit: true },
  heavyinfantry: { name: 'Heavy Infantry', file: 'units/heavyinfantry.glb', unit: true },
  lightcavalry: { name: 'Light Cavalry', file: 'units/lightcavalry.glb', unit: true, scale: 0.78, ring: 1.35, banner: 3.1 },
  heavycavalry: { ...KNIGHT, name: 'Heavy Cavalry' },
  knight: { ...KNIGHT, name: 'Knights', tint: [0.82, 0.84, 0.9] },
  knightlord: { ...KNIGHT, name: 'Knight Lords', tint: [1.0, 0.86, 0.55] },
  slayerknight: { ...KNIGHT, name: 'Slayer Knights', tint: [0.1, 0.08, 0.1] },
  giant: { name: 'Giant', file: 'units/giant.glb', unit: true, size: 3.0, ring: 1.3, banner: 3.8, speed: 0.95 },
  catapult: { name: 'Catapult', file: 'units/catapult.glb', unit: true, scale: 1, ring: 1.5, vehicle: true, speed: 0.8 },
  archon: { name: 'Archon', file: 'units/archon.glb', unit: true, fly: true, size: 2.3, hover: 1.2, lean: 0.35, ring: 1.1 },
  dragon: { ...DRAGON, name: 'Bronze Dragon' },
  reddragon: { ...DRAGON, name: 'Red Dragon', tint: [1.0, 0.2, 0.1] },
  greendragon: { ...DRAGON, name: 'Green Dragon', tint: [0.3, 0.85, 0.25] },
  blackdragon: { ...DRAGON, name: 'Black Dragon', tint: [0.2, 0.2, 0.24] },
  golddragon: { ...DRAGON, name: 'Gold Dragon', tint: [1.0, 0.72, 0.22] },
  frostdragon: { ...DRAGON, name: 'Frost Dragon', tint: [0.75, 0.9, 1.15] },
  bluedragon: { ...DRAGON, name: 'Blue Dragon', tint: [0.25, 0.45, 1.0] },
  silverdragon: { ...DRAGON, name: 'Silver Dragon', tint: [0.85, 0.88, 0.95] },
  cavewyrm: { ...DRAGON, name: 'Cave Wyrms', tint: [0.42, 0.36, 0.32] },
  dustwyrm: { ...DRAGON, name: 'Dust Wyrms', tint: [0.88, 0.74, 0.5] },
  undeaddragon: { ...DRAGON, name: 'Undead Dragon', tint: [0.72, 0.7, 0.56] },
  barbarians: { name: 'Barbarians', file: 'heroes/barbarian.glb', unit: true },
  archer: { name: 'Archers', file: 'units/archer.glb', unit: true },
  pikeman: { name: 'Pikemen', file: 'units/pikeman.glb', unit: true },
  dwarf: { ...DWARF, name: 'Dwarf Infantry' },
  dwarfcrossbow: { ...DWARF, name: 'Dwarf Crossbows' },
  goblin: { name: 'Goblins', file: 'units/goblin.glb', unit: true, size: 1.25 },
  orc: { ...ORC, name: 'Orc Mob' },
  orog: { ...ORC, name: 'Orogs', size: 2.1, tint: [0.36, 0.34, 0.42] },
  skeleton: { name: 'Skeletons', file: 'units/skeleton.glb', unit: true, size: 1.8 },
  wight: { name: 'Wights', file: 'units/skeleton.glb', unit: true, size: 1.85, tint: [0.62, 0.76, 1.0] },
  zombie: { ...ZOMBIE, name: 'Zombies' },
  ghoul: { ...ZOMBIE, name: 'Ghouls', tint: [0.62, 0.66, 0.52], speed: 1 },
  firedemon: { ...DEMON, name: 'Fire Demons', tint: [1.0, 0.36, 0.12] },
  icedemon: { ...DEMON, name: 'Ice Demons', tint: [0.55, 0.8, 1.15] },
  stonegolem: { ...GOLEM, name: 'Stone Golem' },
  claygolem: { ...GOLEM, name: 'Clay Golems', tint: [0.8, 0.52, 0.32] },
  irongolem: { ...GOLEM, name: 'Iron Golem', tint: [0.3, 0.32, 0.37] },
  minotaur: { name: 'Minotaurs', file: 'units/minotaur.glb', unit: true, size: 2.5, ring: 1.2, banner: 3.4 },
  ogre: { ...OGRE, name: 'Ogres' },
  troll: { ...OGRE, name: 'Trolls', tint: [0.42, 0.62, 0.36] },
  wraith: { ...WRAITH, name: 'Wraiths' },
  spectre: { ...WRAITH, name: 'Spectres', tint: [0.5, 0.66, 1.0] },
  ghost: { ...WRAITH, name: 'Ghosts', tint: [0.92, 0.96, 1.1] },
  wolfrider: { name: 'Wolfriders', file: 'units/wolfrider.glb', unit: true, scale: 0.85, ring: 1.3, banner: 2.9, speed: 1.1 },
  warg: { ...WARG, name: 'Wargs' },
  hellhound: { ...WARG, name: 'Hellhounds', tint: [0.85, 0.22, 0.1] },
  unicorn: { ...UNICORN, name: 'Unicorns' },
  nightmare: { ...UNICORN, name: 'Nightmares', tint: [0.04, 0.035, 0.05] },
  elf: { ...ELF, name: 'Elven Archers' },
  elveninfantry: { ...ELF, name: 'Elven Infantry' },
  elflord: { ...ELF, name: 'Elven Lords', tint: [1.0, 0.85, 0.45] },
  lich: { name: 'Liches', file: 'units/lich.glb', unit: true, size: 1.95 },
  fireelemental: { ...ELEMENTAL, name: 'Fire Elementals' },
  airelemental: { ...ELEMENTAL, name: 'Air Elementals', tint: [0.8, 0.92, 1.1], glow: false, speed: 1.15 },
  rockelemental: { ...ELEMENTAL, name: 'Rock Elementals', tint: [0.36, 0.33, 0.3], glow: false, speed: 0.85 },
  treant: { name: 'Treants', file: 'units/treant.glb', unit: true, size: 3.0, ring: 1.3, banner: 3.8, speed: 0.85 },
  harpy: { name: 'Harpies', file: 'units/harpy.glb', unit: true, fly: true, size: 1.9, hover: 1.1, lean: 0.3 },
  gnoll: { ...GNOLL, name: 'Gnolls' },
  gnollcrossbow: { ...GNOLL, name: 'Gnoll Crossbows' },
  centaur: { name: 'Centaurs', file: 'units/centaur.glb', unit: true, scale: 0.8, ring: 1.35, banner: 3.1, speed: 1.15 },
  elephant: { name: 'Elephants', file: 'units/elephant.glb', unit: true, scale: 0.72, ring: 1.7, room: 2.4, banner: 3.8, speed: 0.85 },
  peasant: { name: 'Peasants', file: 'units/peasant.glb', unit: true, size: 1.75 },
  halfling: { name: 'Halflings', file: 'units/halfling.glb', unit: true, size: 1.15 },
  scout: { name: 'Scouts', file: 'units/scout.glb', unit: true, size: 1.8, speed: 1.2 },
  assassin: { name: 'Assassin', file: 'units/assassin.glb', unit: true, size: 1.8, speed: 1.1 },
  reaver: { name: 'Reavers', file: 'units/reaver.glb', unit: true, size: 1.95 },
  moonguard: { name: 'Moonguard', file: 'units/moonguard.glb', unit: true, size: 1.9 },
  iceguard: { name: 'Iceguard', file: 'units/iceguard.glb', unit: true, size: 1.95, speed: 0.9 },
  dwarfrunner: { name: 'Dwarf Runners', file: 'units/dwarfrunner.glb', unit: true, size: 1.35, speed: 1.15 },
  dwarfmutant: { name: 'Dwarf Mutants', file: 'units/dwarfmutant.glb', unit: true, size: 1.6, ring: 1.1, speed: 0.9 },
  dryad: { name: 'Dryads', file: 'units/dryad.glb', unit: true, size: 1.75, speed: 1.05 },
  medusa: { name: 'Medusae', file: 'units/medusa.glb', unit: true, size: 1.85 },
  mummy: { name: 'Mummies', file: 'units/mummy.glb', unit: true, size: 1.85, speed: 0.85 },
  plaguecarrier: { name: 'Plague Carriers', file: 'units/plaguecarrier.glb', unit: true, size: 1.75, speed: 0.9 },
  imp: { name: 'Imps', file: 'units/imp.glb', unit: true, fly: true, size: 1.4, hover: 0.9, lean: 0.3 },
  elvencavalry: { name: 'Elven Cavalry', file: 'units/elvencavalry.glb', unit: true, scale: 0.78, ring: 1.35, banner: 3.1, speed: 1.15 },
  gnollcavalry: { name: 'Gnoll Cavalry', file: 'units/gnollcavalry.glb', unit: true, scale: 0.85, ring: 1.3, banner: 2.9, speed: 1.1 },
  giantrat: { name: 'Giant Rats', file: 'units/giantrat.glb', unit: true, scale: 0.85, ring: 1.1, banner: 2.4, speed: 1.05 },
  undeadbeast: { name: 'Undead Beast', file: 'units/undeadbeast.glb', unit: true, scale: 0.8, ring: 1.6, room: 2.3, banner: 3.6, speed: 0.9 },
  pegasus: { ...PEGASUS, name: 'Pegasi' },
  darkpegasus: { ...PEGASUS, name: 'Dark Pegasi', tint: [0.1, 0.1, 0.12] },
  griffon: { name: 'Griffons', file: 'units/griffon.glb', unit: true, fly: true, scale: 0.8, hover: 1.0, lean: 0.12, ring: 1.4, room: 2.0 },
  // build_meshy_beasts.py: in world units, flyers centred on their body
  eagle: { name: 'Eagles', file: 'units/eagle.glb', unit: true, fly: true, scale: 0.8, hover: 2.4, lean: 0.06, ring: 1.5, room: 2.6 },
  giantbat: { name: 'Giant Bats', file: 'units/giantbat.glb', unit: true, fly: true, scale: 0.8, hover: 2.0, lean: 0.06, ring: 1.4, room: 2.3 },
  giantbee: { name: 'Giant Bees', file: 'units/giantbee.glb', unit: true, fly: true, scale: 0.8, hover: 1.4, lean: 0.1, ring: 1.1, room: 1.6 },
  giantspider: { name: 'Giant Spiders', file: 'units/giantspider.glb', unit: true, scale: 1, ring: 1.3, room: 2.2, banner: 2.6, speed: 1.1 },
  giantscorpion: { name: 'Giant Scorpions', file: 'units/giantscorpion.glb', unit: true, scale: 1, ring: 1.4, room: 2.4, banner: 2.8, speed: 0.95 },
  cockatrice: { name: 'Cockatrice', file: 'units/cockatrice.glb', unit: true, scale: 1, ring: 1.1, banner: 2.8 },
  greenslime: { name: 'Green Slime', file: 'units/greenslime.glb', unit: true, scale: 1, ring: 1.2, banner: 2.4, speed: 0.7 },
  ballista: { name: 'Ballistae', file: 'units/ballista.glb', unit: true, scale: 1, ring: 1.4, vehicle: true, speed: 0.8 },
  siegeengine: { name: 'Siege Engines', file: 'units/siegeengine.glb', unit: true, scale: 1, ring: 1.3, vehicle: true, speed: 0.6 },
};

/** Largest army a tile holds. */
export const ARMY_MAX = 8;

const BASE = import.meta.env.BASE_URL + 'models/';
const HERO_HEIGHT = 1.75; // world units, crown of the head (a tile is 2 units wide)
const WALK_SPEED = 1.9; // world units per second on 1-MP ground
const SAIL_SPEED = 2.6;
const FLY_SPEED = 2.6; // tools/blender/build_meshy_beasts.py FLY_SPEED
const LEVITATE = 0.95; // how high walkers in magic flight float over water and impassable land

// Scale of every hero and unit on the map (figure, banner, ring and formation spacing;
// ships and march speeds stay as they are). Takes effect live on armies already placed.
let figureScale = 0.5;
export const getFigureScale = () => figureScale;
export function setFigureScale(s) { figureScale = Math.max(0.1, s); }

// War banner a standing army unit plants beside itself (tools/blender/
// build_meshy_structures.py ONLY=banner): pole up +Y from the origin, BANNER_MODEL_H
// tall, cloth toward +Z in Banner_Flag with its flutter weight in `aWave`.
const BANNER_MODEL_H = 3.0;
const BANNER_RAISE = 0.8; // seconds to raise; lowering is quicker
const BANNER_WAIT = 0.35; // seconds a unit stands before it raises the banner
let banner = null;

let pending = null;
const fileCache = {}; // model file -> Promise<gltf | null>
let bannerPending = null;

function loadFile(file) {
  fileCache[file] ??= gltfLoader().loadAsync(BASE + file).then((g) => {
    g.scene.traverse((o) => o.isMesh && sharpenTextures(o.material));
    return g;
  }).catch((err) => {
    console.warn(`Could not load model ${file}`, err);
    return null;
  });
  return fileCache[file];
}

function loadBanner() {
  bannerPending ??= gltfLoader().loadAsync(BASE + 'units/banner.glb').then((g) => {
    g.scene.traverse((o) => {
      const geo = o.geometry;
      if (o.isMesh && geo.attributes.color) {
        geo.setAttribute('aWave', geo.attributes.color);
        geo.deleteAttribute('color');
        o.material.vertexColors = false;
      }
    });
    banner = g;
  }).catch((err) => console.warn('Could not load units/banner.glb', err));
  return bannerPending;
}

/** Loads the models of the given types only (the game loads what its sides use):
 * resolves to { [type]: gltf } for the types that loaded. Cached per file. */
export async function loadModelsFor(types) {
  await loadBanner();
  const list = await Promise.all([...new Set(types)].filter((t) => HERO_TYPES[t]).map(async (t) => [t, await loadFile(HERO_TYPES[t].file)]));
  return Object.fromEntries(list.filter(([, g]) => g));
}

/** Loads every hero and unit model once: { [type]: gltf }. Types sharing a file share
 * the gltf. Missing files are skipped. */
export function loadHeroModels() {
  return (pending ??= loadModelsFor(Object.keys(HERO_TYPES)));
}

/**
 * Banner cloth material: tinted in the owner's colour, fluttering along its normal
 * (local X) in waves running out from the pole, faster and fuller in strong wind;
 * in a calm it droops and folds back toward the pole.
 */
function bannerClothMaterial(src, color, phase) {
  const mat = src.clone();
  mat.color.copy(color);
  mat.side = THREE.DoubleSide;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uPhase = { value: phase };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aWave;
        uniform float uTime; uniform vec2 uWind; uniform float uPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float fw = aWave.x;
        float s = clamp(length(uWind), 0.0, 1.5);
        float calm = 1.0 - min(s, 1.0);
        float wave = sin(uTime * (4.0 + s * 4.0) - fw * 8.0 + uPhase + position.y * 1.5)
                   + 0.35 * sin(uTime * (9.0 + s * 5.0) - fw * 15.0 + uPhase * 1.7 + position.y * 3.0);
        transformed.x += wave * fw * (0.05 + 0.07 * s);
        transformed.z *= mix(1.0, 0.6, calm);
        transformed.y -= fw * fw * 0.55 * calm;`);
  };
  mat.customProgramCacheKey = () => 'unit-banner';
  return mat;
}

/** The war banner, tinted for `color`, `height` world units tall; null until loaded. */
function createBanner(color, height) {
  if (!banner) return null;
  const group = new THREE.Group();
  group.name = 'banner';
  const phase = Math.random() * 6.28;
  banner.scene.traverse((o) => {
    if (!o.isMesh) return;
    const cloth = /Flag/.test(o.material.name);
    const m = new THREE.Mesh(o.geometry, cloth ? bannerClothMaterial(o.material, color, phase) : o.material.clone());
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false; // the flutter moves it outside its bounds
    group.add(m);
  });
  group.scale.setScalar(height / BANNER_MODEL_H);
  return group;
}


const factionColor = (owner) => new THREE.Color(owner >= 0 ? Factions[owner].color : NEUTRAL_COLOR);

/** Species colour on a dragon's scales: the texture's shading, recoloured. */
function tintMaterial(mat, tint) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTint = { value: new THREE.Color(...tint) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTint;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = mix(diffuseColor.rgb, lum * uTint * 2.4, 0.85);`);
  };
  mat.customProgramCacheKey = () => 'species-tint';
}

const _v = new THREE.Vector3();
const _head = { x: 0, z: 0 }, _out = { x: 0, z: 0 };

/**
 * One hero or army unit on the map: the animated figure, the ship it sails in at sea and a
 * selection ring. Its Army steers it: each frame `update` gets the point it should be at,
 * and the figure moves there, turning toward where it goes, its step rate matching
 * its ground speed. Flyers hover above the ground and bank into their turns; vehicles
 * tilt with the slope.
 */
export class HeroFigure {
  constructor(type, gltf, owner) {
    const t = HERO_TYPES[type];
    this.type = type;
    this.owner = owner;
    this.hero = !t.unit;
    this.fly = !!t.fly;
    this.vehicle = !!t.vehicle;
    this.hover = t.hover ?? 0;
    this.lean = t.lean ?? 0;
    this.speedFactor = t.speed ?? 1;
    this.root = new THREE.Group();
    this.root.name = `hero-${type}`;
    const rig = gltf.scene.children.find((o) => o.userData?.stride) ?? gltf.scene;
    const height = rig.userData?.height ?? 2.0;
    this.scale = t.scale ?? (t.size ?? HERO_HEIGHT) / height;
    this.height = height * this.scale;
    this.ringScale = t.ring ?? 1;
    this.room = t.room ?? 1.1 * this.ringScale;
    this.stride = (rig.userData?.stride ?? 1.5) * this.scale; // world units per walk cycle

    this.figure = SkeletonUtils.clone(gltf.scene);
    this.figure.scale.setScalar(this.scale);
    this.figure.position.y = this.hover;
    const color = factionColor(owner);
    this.figure.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      const m = o.material.clone();
      if (/Accent/.test(m.name)) m.color.copy(color);
      else if (t.tint && /Base|Glow/.test(m.name)) tintMaterial(m, t.tint);
      if (/Glow/.test(m.name) && t.glow !== false) {
        m.emissive = new THREE.Color(1, 1, 1);
        m.emissiveMap = m.map;
        m.emissiveIntensity = 2.2;
      }
      o.material = m;
    });
    this.root.add(this.figure);

    this.mixer = new THREE.AnimationMixer(this.figure);
    const clip = (name) => gltf.animations.find((a) => a.name === name);
    this.walk = clip('Walk') && this.mixer.clipAction(clip('Walk'));
    this.idle = clip('Idle') && this.mixer.clipAction(clip('Idle'));
    this.idle?.play();
    this.walk?.play();
    this.walk?.setEffectiveWeight(0);
    this.idle?.setEffectiveWeight(1);
    this.idle && (this.idle.time = Math.random() * this.idle.getClip().duration);
    this.walk && (this.walk.time = Math.random() * this.walk.getClip().duration);
    this.walkWeight = 0;
    // pose it now: until its first update it would show the rig's rest (T-)pose
    this.mixer.update(0);

    // flyers cross the sea on the wing
    this.ship = this.fly ? null : createShip(owner >= 0 ? Factions[owner].boat : undefined);
    if (this.ship) {
      this.ship.visible = false;
      this.ship.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        if (/Accent/.test(o.material.name)) o.material.color.copy(color); // the sail
      });
      this.root.add(this.ship);
    }

    // army units plant a war banner beside them while they stand, flyers on the ground
    // under them (one per army: the Army picks its standard bearer)
    this.banner = t.unit ? createBanner(color, t.banner ?? 2.6) : null;
    if (this.banner) {
      this.bannerHeight = t.banner ?? 2.6;
      // a flyer plants it clear of its wings
      const side = this.fly ? Math.max(0.55 * this.ringScale, 0.5 * this.room) : 0.55 * this.ringScale;
      this.banner.position.set(-side, -this.bannerHeight, -0.3 * this.ringScale);
      this.banner.visible = false;
      this.root.add(this.banner);
    }
    this.carriesBanner = !!this.banner;
    this.bannerUp = 0;
    this.still = 0; // seconds standing still

    // selection ring in the owner's colour
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.66, 0.8, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.6), transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }),
    );
    ring.renderOrder = 5;
    ring.visible = false;
    this.ring = ring;
    this.root.add(ring);

    this.yaw = 0;
    this.speed = 0; // smoothed ground speed, world units per second
    this.pitch = 0;
    this.roll = 0;
    this.altitude = 0; // flyers: smoothed ground height they fly over
    this.phase = Math.random() * 6.28;
    this.atSea = false;
    this.levit = 0; // 0..1: a walker borne aloft by magic flight
    this.avoid = { side: 0, best: Infinity, stall: 0 }; // which way it goes round a structure; progress
  }

  /** Radius it keeps clear of walls and other figures, world units at the current scale. */
  get radius() { return 0.45 * this.room * figureScale; }

  /** v: true (selected), 'hover' (a click would select it: a fainter ring) or false. */
  setSelected(v) {
    this.ring.visible = !!v;
    this.ring.material.opacity = v === 'hover' ? 0.45 : 0.9;
  }

  /** Stands the figure at (x, z) facing `yaw`. */
  place(x, z, yaw, heightAt) {
    const h = heightAt(x, z);
    this.root.scale.setScalar(figureScale);
    this.root.position.set(x, h, z);
    this.altitude = h;
    this.yaw = yaw;
    this.root.rotation.y = yaw;
  }

  /** Point of the figure to click on: feet to the top of the head. */
  pickSegment(a, b) {
    const S = figureScale;
    a.copy(this.root.position);
    a.y += this.fly ? this.hover * 0.8 * S : 0;
    b.copy(a);
    b.y += (this.fly ? Math.max(0.8, this.height * 0.5) : Math.min(this.height, 2.4) * 0.7) * S;
  }

  /**
   * Moves toward `goal` {x, z}: at most `goal.cap` units per second, easing in as it
   * gets close. Standing, it turns to `goal.yaw`. `goal.ship`: this figure carries the
   * army's ship at sea; the others are aboard it (hidden). `goal.obstacles`: structures
   * a walker skirts, sliding along their walls, never stepping inside; a flyer rises over
   * them (the Army still stands it beside them).
   */
  update(dt, goal, heightAt, isSeaAt) {
    const S = figureScale;
    this.root.scale.setScalar(S);
    this.ship?.scale.setScalar(1 / S); // ships keep their size
    const pos = this.root.position;
    const dx = goal.x - pos.x, dz = goal.z - pos.z;
    const d = Math.hypot(dx, dz);
    const step = Math.min(d, d * (1 - Math.exp(-dt * 8)) + 0.2 * dt, goal.cap * dt);
    const obs = !this.atSea && !this.fly && goal.obstacles;
    let hx = 0, hz = 0;
    if (d <= 0.004) { // there: settle on the spot rather than creep around it
      pos.x = goal.x; pos.z = goal.z;
    } else {
      hx = dx / d; hz = dz / d;
      if (obs) {
        // no nearer for a good while skirting a wall (wedged): try the other way round, once
        const a = this.avoid;
        if (!a.side) { a.best = d; a.stall = 0; a.flipped = false; }
        else if (d < a.best - 0.05) { a.best = d; a.stall = 0; }
        else if ((a.stall += dt) > 2.5 && !a.flipped) { a.side = -a.side; a.flipped = true; a.stall = 0; a.best = d; }
        ({ x: hx, z: hz } = obs.steer(pos.x, pos.z, hx, hz, this.radius, a, goal.x, goal.z, _head));
      }
      pos.x += hx * step;
      pos.z += hz * step;
    }
    if (obs) {
      obs.pushOut(pos.x, pos.z, this.radius * 0.9, _out);
      pos.x = _out.x; pos.z = _out.z;
    }
    const v = dt > 0 ? step / dt : 0;
    this.speed += (v - this.speed) * Math.min(1, dt * 10);
    const moving = this.speed > 0.12;
    const targetYaw = moving && d > 0.02 && (hx || hz) ? Math.atan2(hx, hz) : goal.yaw;

    // at sea a walker rides in a ship — unless its group flies by magic (goal.liftAt): then
    // it floats up over water and impassable land, legs still, and lands again beyond
    const liftAt = this.fly ? null : goal.liftAt;
    const aloft = !!liftAt && liftAt(pos.x, pos.z);
    this.levit += ((aloft ? 1 : 0) - this.levit) * Math.min(1, dt * 2.2);
    const sea = !this.fly && !liftAt && isSeaAt(pos.x, pos.z);
    if (sea !== this.atSea) this.atSea = sea;
    if (this.ship) this.ship.visible = sea;
    this.figure.visible = !sea;
    this.root.visible = !sea || !!goal.ship;

    const t = performance.now() / 1000;
    const ground = heightAt(pos.x, pos.z);
    if (this.fly) {
      // glide over the relief rather than hug it; never dip into a hill; rise over the
      // castles and ruins on the way (the figure hangs `hover` below its wings' reach)
      const over = goal.obstacles ? goal.obstacles.topAt(pos.x, pos.z, this.radius * 0.7) : -Infinity;
      const floor = Math.max(ground, over + 0.3 - this.hover * 0.5 * S);
      this.altitude += (floor - this.altitude) * Math.min(1, dt * (floor > this.altitude ? 3 : 1.5));
      this.altitude = Math.max(this.altitude, ground - 0.25 * this.hover * S);
      pos.y = this.altitude;
      this.figure.position.y = this.hover * (1 + 0.06 * Math.sin(t * 1.7 + this.phase));
    } else if (this.levit > 0.001) {
      const base = isSeaAt(pos.x, pos.z) ? Math.max(ground, isSeaAt.level?.(pos.x, pos.z) ?? 0) : ground;
      const k = this.levit * this.levit * (3 - 2 * this.levit);
      pos.y = base + LEVITATE * S * k * (1 + 0.08 * Math.sin(t * 1.6 + this.phase));
    } else {
      // at sea (or on a river voyage: isSeaAt.level gives the water's height)
      pos.y = sea ? (isSeaAt.level?.(pos.x, pos.z) ?? 0) + Math.sin(t * 1.3 + pos.x) * 0.03 - 0.02 : ground;
    }
    if (this.ship && sea) {
      this.ship.rotation.z = Math.sin(t * 1.1 + pos.z) * 0.04;
      this.ship.rotation.x = Math.sin(t * 0.8 + pos.x) * 0.03;
    }
    // turn toward the direction of travel
    let dy = targetYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const turn = dy * Math.min(1, dt * (this.fly ? 4 : 9));
    this.yaw += turn;
    this.root.rotation.y = this.yaw;

    // body attitude: flyers lean into the flight and bank into turns, vehicles
    // follow the slope under their wheels
    let pitch = 0, roll = 0;
    if (this.fly) {
      const rate = dt > 0 ? turn / dt : 0;
      pitch = this.lean * Math.min(1, this.speed / FLY_SPEED);
      roll = THREE.MathUtils.clamp(-rate * 0.3, -0.45, 0.45);
    } else if (this.levit > 0.05) {
      // borne along: a slight lean into the flight, a gentle sway
      pitch = 0.12 * this.levit * Math.min(1, this.speed / FLY_SPEED);
      roll = 0.04 * this.levit * Math.sin(t * 1.1 + this.phase);
    } else if (this.vehicle && !sea) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), L = 0.9, W = 0.5;
      const hf = heightAt(pos.x + fx * L, pos.z + fz * L), hb = heightAt(pos.x - fx * L, pos.z - fz * L);
      const hr = heightAt(pos.x + fz * W, pos.z - fx * W), hl = heightAt(pos.x - fz * W, pos.z + fx * W);
      pitch = -Math.atan2(hf - hb, 2 * L);
      roll = Math.atan2(hr - hl, 2 * W);
    }
    const k = Math.min(1, dt * 5);
    this.pitch += (pitch - this.pitch) * k;
    this.roll += (roll - this.roll) * k;
    this.figure.rotation.set(this.pitch, 0, this.roll);

    // blend idle <-> walk (flight); legs and wheels keep pace with the ground speed
    const want = moving && !sea && this.levit < 0.4 ? 1 : 0;
    this.walkWeight += (want - this.walkWeight) * Math.min(1, dt * 6);
    if (this.walk && this.idle) {
      this.walk.setEffectiveWeight(this.walkWeight);
      this.idle.setEffectiveWeight(1 - this.walkWeight);
      this.walk.timeScale = this.fly ? 1 : Math.max(0.2, this.speed / (this.stride * S));
    }
    this.mixer.update(dt);
    // a flyer plants its banner on the ground below, never at sea
    const bannerSea = this.fly ? this.carriesBanner && isSeaAt(pos.x, pos.z) : sea || this.levit > 0.2;
    this._updateBanner(dt, moving ? this.speed : 0, bannerSea, (ground - pos.y) / S);
    if (this.ring.visible) {
      this.ring.position.y = ((sea ? (isSeaAt.level?.(pos.x, pos.z) ?? 0) + 0.04 : ground + 0.05) - pos.y) / S;
      this.ring.material.opacity = 0.65 + 0.3 * Math.sin(t * 4);
      this.ring.scale.setScalar(sea ? 1.35 / S : this.ringScale);
    }
  }

  /** Raise the banner once standing still on land, lower it on the move; the cloth
   * turns to stream downwind. `floor`: the ground's height in the figure's frame. */
  _updateBanner(dt, speed, sea, floor) {
    if (!this.banner) return;
    if (!this.carriesBanner) { this.banner.visible = false; return; }
    this.still = speed > 0 || sea ? 0 : this.still + dt;
    const up = this.still > BANNER_WAIT;
    this.bannerUp = up ? Math.min(1, this.bannerUp + dt / BANNER_RAISE) : Math.max(0, this.bannerUp - dt * 4);
    const k = this.bannerUp;
    this.banner.visible = k > 0;
    if (!k) return;
    const e = up ? 1 - (1 - k) ** 3 : k * k; // ease out while raising
    this.banner.position.y = floor + (e - 1) * this.bannerHeight;
    const w = U.uWind.value;
    // local +Z (the cloth) points downwind; the banner rides on the unit's yaw
    if (w.lengthSq() > 1e-6) this.banner.rotation.y = Math.atan2(w.x, w.y) - this.yaw;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.material.dispose();
        if (o === this.ring) o.geometry.dispose();
      }
    });
    this.root.removeFromParent();
  }
}

/**
 * Formation slots {x: to the right, f: forward} for an army's members, in world units
 * around its centre: heroes lead in the front row, units follow in rows of three.
 * Each member takes its `room`.
 */
function formation(members) {
  if (members.length === 1) return [{ x: 0, f: 0 }];
  const heroes = members.filter((m) => m.hero), units = members.filter((m) => !m.hero);
  const rows = [];
  for (let i = 0; i < heroes.length; i += 3) rows.push(heroes.slice(i, i + 3));
  for (let i = 0; i < units.length; i += 3) rows.push(units.slice(i, i + 3));
  const slots = new Map();
  let depth = 0;
  for (const row of rows) {
    const w = row.map((m) => m.room);
    const rowDepth = Math.max(...w);
    let x = -w.reduce((a, b) => a + b, 0) / 2;
    row.forEach((m, i) => {
      slots.set(m, { x: x + w[i] / 2, f: -(depth + rowDepth / 2) });
      x += w[i];
    });
    depth += rowDepth + 0.1;
  }
  const mid = (depth - 0.1) / 2;
  return members.map((m) => {
    const s = slots.get(m);
    return { x: s.x, f: s.f + mid };
  });
}

/**
 * Single-file slots for crossing a bridge: walkers one behind the other in formation
 * order from the front of the formation back; flyers keep their formation slots.
 */
function column(members, slots) {
  let f = Math.max(...slots.map((s) => s.f)), prev = null;
  return members.map((m, i) => {
    if (m.fly) return slots[i];
    if (prev) f -= 0.45 * (prev.room + m.room) + 0.15;
    prev = m;
    return { x: 0, f };
  });
}

/**
 * A stack of up to ARMY_MAX heroes and units on one tile, moving as one: `follow(points)`
 * walks its centre along the route (centripetal Catmull-Rom) at the pace of its slowest
 * member, and each member keeps its formation slot along the same curve, the hero out
 * in front. Over a bridge (route points flagged `bridge`) the walkers file across one
 * after another. An army of flyers flies; a mixed army marches (its flyers flying
 * along) and sails in one ship, carried by its first walker.
 */
export class Army {
  constructor(members, owner) {
    this.owner = owner;
    this.members = [...members.filter((m) => m.hero), ...members.filter((m) => !m.hero)];
    this.group = new THREE.Group();
    this.group.name = 'army';
    for (const m of this.members) this.group.add(m.root);
    this.fly = this.members.every((m) => m.fly);
    this.speedFactor = Math.min(...this.members.map((m) => m.speedFactor));
    this.shipBearer = this.members.find((m) => !m.fly) ?? null;
    const bearer = this.members.find((m) => m.carriesBanner);
    for (const m of this.members) m.carriesBanner = m === bearer;
    // stacked flyers take turns in altitude so wings don't cross
    let k = 0;
    for (const m of this.members) if (m.fly) m.figure.position.y = m.hover += 0.7 * (k++ % 2);
    this._layout();
    this.file = 0; // 0 = formation, 1 = single file
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.route = null; // { curve, length, s, points, marks, bridges, done } of the last march
    this.onArrive = null;
    this.speed = 0;
  }

  get moving() { return !!this.route && !this.route.done; }

  /** Formation and single-file slots at the current figure scale. */
  _layout() {
    this.scale = figureScale;
    const room = this.members.map((m) => ({ hero: m.hero, fly: m.fly, room: m.room * figureScale }));
    this.slots = formation(room);
    this.column = column(room, this.slots);
  }

  setSelected(v) { for (const m of this.members) m.setSelected(v); }

  /** Stands the army on (x, z) facing `yaw`, each member on its slot (beside any
   * structure there, see `obstacles` of update). */
  place(x, z, yaw, heightAt, obstacles = null) {
    if (this.scale !== figureScale) this._layout();
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.route = null;
    this.file = 0;
    const goals = this.members.map((m, i) => this._standing(this.slots[i]));
    this._clear(goals, obstacles, this.members.map(() => true));
    this.members.forEach((m, i) => {
      m.place(goals[i].x, goals[i].z, yaw, heightAt);
      m.levit = !m.fly && this.liftAt?.(goals[i].x, goals[i].z) ? 1 : 0; // already aloft
    });
  }

  /**
   * Where the members stand while the army stands still: worked out once per spot,
   * facing and figure scale (not every frame), so a figure that has reached its stand
   * stays put.
   */
  _standGoals(obstacles, land) {
    const key = `${this.x},${this.z},${this.yaw},${this.scale},${land.join()}`;
    const c = this._stand;
    if (c?.key !== key || c.obstacles !== obstacles) {
      const goals = this.members.map((m, i) => (land[i] ? this._standing(this.slots[i]) : { x: this.x, z: this.z }));
      this._clear(goals, obstacles, land);
      this._stand = { key, obstacles, goals };
    }
    return this._stand.goals;
  }

  /**
   * Moves the points {x, z} of the members flagged in `land` out of the structures and
   * apart from each other, so no one stands in a wall or in another's boots: a few
   * rounds of pairwise separation, each followed by a push back out of the walls.
   */
  _clear(goals, obstacles, land) {
    const obs = obstacles && !obstacles.empty ? obstacles : null;
    const ms = this.members;
    for (let it = 0; it < 12; it++) {
      if (obs) goals.forEach((g, i) => land[i] && obs.pushOut(g.x, g.z, ms[i].radius, g));
      if (ms.length < 2 || (!obs && it)) break;
      let moved = false;
      for (let i = 0; i < ms.length; i++) {
        if (!land[i]) continue;
        for (let j = i + 1; j < ms.length; j++) {
          if (!land[j] || ms[i].fly !== ms[j].fly) continue; // flyers pass over walkers
          const a = goals[i], b = goals[j];
          const min = ms[i].radius + ms[j].radius;
          let dx = b.x - a.x, dz = b.z - a.z;
          const d = Math.hypot(dx, dz);
          if (d >= min) continue;
          if (d < 1e-4) { dx = Math.cos(i + j); dz = Math.sin(i + j); } else { dx /= d; dz /= d; }
          const k = (min - d) / 2;
          a.x -= dx * k; a.z -= dz * k;
          b.x += dx * k; b.z += dz * k;
          moved = true;
        }
      }
      if (!moved) break;
    }
    if (obs) goals.forEach((g, i) => land[i] && obs.pushOut(g.x, g.z, ms[i].radius, g));
  }

  _standing(slot) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return { x: this.x + slot.f * s + slot.x * c, z: this.z + slot.f * c - slot.x * s };
  }

  /**
   * Marches through world points [{x, z, sea, cost}], smoothly. `cost` of each point is
   * the MP of the tile it enters; dearer ground is slower.
   */
  follow(points, onArrive) {
    const pts = points.map((p) => new THREE.Vector3(p.x, 0, p.z));
    if (pts.length < 2) { onArrive?.(); return; }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const length = curve.getLength();
    // arc-length position of each waypoint, to look up the terrain being crossed
    const marks = [0];
    for (let i = 1; i < pts.length; i++) marks.push(marks[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const scale = length / (marks[marks.length - 1] || 1);
    const at = marks.map((m) => m * scale);
    this.route = {
      curve, length, s: 0, points, marks: at, done: false,
      bridges: at.filter((_, i) => points[i].bridge),
      t0: curve.getTangentAt(0).clone(), t1: curve.getTangentAt(1).clone(),
    };
    this.onArrive = onArrive;
  }

  stop() { if (this.route) this.route.done = true; }

  /** Slot of member i, between formation and single file. */
  _slot(i) {
    const a = this.slots[i], b = this.column[i], k = this.file;
    return { x: a.x + (b.x - a.x) * k, f: a.f + (b.f - a.f) * k };
  }

  /** Should the army go single file: is a bridge under or just ahead of its walkers? */
  _atBridge() {
    const r = this.route;
    if (!r?.bridges.length) return false;
    let front = -Infinity, back = Infinity;
    this.members.forEach((m, i) => {
      if (m.fly) return;
      const f = this._slot(i).f;
      front = Math.max(front, f);
      back = Math.min(back, f);
    });
    const HALF = 1.4; // half a bridge tile and a little
    return r.bridges.some((b) => b + HALF > r.s + back - 0.3 && b - HALF < r.s + front + (r.done ? 0 : 2.5));
  }

  /** Route point at arc length s, carried on straight past either end. */
  _along(s, out, tan) {
    const r = this.route;
    if (s <= 0 || s >= r.length) {
      const end = s <= 0 ? 0 : 1, t = s <= 0 ? r.t0 : r.t1;
      r.curve.getPointAt(end, out).addScaledVector(t, s <= 0 ? s : s - r.length);
      tan.copy(t);
    } else {
      r.curve.getPointAt(s / r.length, out);
      r.curve.getTangentAt(s / r.length, tan);
    }
  }

  _segment(s) {
    const { marks, points } = this.route;
    let i = 1;
    while (i < marks.length - 1 && marks[i] < s) i++;
    return points[i];
  }

  /**
   * `obstacles` (game/obstacles.js): structures the members skirt on the march and stand
   * beside, never in.
   */
  update(dt, heightAt, isSeaAt, obstacles = null) {
    if (this.scale !== figureScale) this._layout();
    let speed = 0;
    if (this.moving) {
      const r = this.route;
      const seg = this._segment(r.s);
      const sea = !this.fly && !this.liftAt && seg.sea && isSeaAt(this.x, this.z);
      speed = this.fly || this.liftAt?.(this.x, this.z) ? FLY_SPEED : sea ? SAIL_SPEED : (WALK_SPEED * this.speedFactor) / Math.sqrt(Math.max(0.5, seg.cost || 1));
      r.s = Math.min(r.length, r.s + speed * dt);
      const p = new THREE.Vector3(), tan = new THREE.Vector3();
      this._along(r.s, p, tan);
      this.x = p.x;
      this.z = p.z;
      if (tan.lengthSq() > 1e-6) this.yaw = Math.atan2(tan.x, tan.z);
    }
    this.speed = speed;
    this.file += ((this._atBridge() ? 1 : 0) - this.file) * Math.min(1, dt * 2.5);
    const onCurve = this.moving || this.file > 0.01; // standing in file stays on the road
    const centreSea = !this.fly && !this.liftAt && isSeaAt(this.x, this.z);
    // members may sprint to catch up with their slot, e.g. when the army turns about
    const cap = Math.max(3, speed * 1.6);
    const p = _v, tan = new THREE.Vector3();
    const land = this.members.map((m) => !(centreSea && !m.fly));
    let goals;
    if (this.route && onCurve) {
      goals = this.members.map((m, i) => {
        if (!land[i]) return { x: this.x, z: this.z };
        const slot = this._slot(i);
        this._along(this.route.s + slot.f, p, tan);
        return { x: p.x + slot.x * tan.z, z: p.z - slot.x * tan.x };
      });
      this._clear(goals, obstacles, land);
    } else {
      goals = this._standGoals(obstacles, land);
    }
    this.members.forEach((m, i) => {
      const { x, z } = goals[i];
      m.update(dt, { x, z, yaw: this.yaw, cap, ship: m === this.shipBearer, obstacles: land[i] ? obstacles : null, liftAt: this.liftAt }, heightAt, isSeaAt);
    });
    this._separate(land, obstacles, goals);
    if (this.moving && this.route.s >= this.route.length - 1e-4) {
      this.route.done = true;
      const cb = this.onArrive;
      this.onArrive = null;
      cb?.();
    }
  }

  /** Figures that crowd each other on the march (along a wall, turning about) step apart.
   * One that has reached its stand is never shoved: a late comer slips past it (their
   * stands never overlap), so no one is jostled off its spot and has to walk back. */
  _separate(land, obstacles, goals) {
    const ms = this.members;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        if (!land[i] || !land[j] || ms[i].fly !== ms[j].fly || ms[i].atSea || ms[j].atSea) continue;
        const a = ms[i].root.position, b = ms[j].root.position;
        const settled = (p, g) => Math.abs(p.x - g.x) + Math.abs(p.z - g.z) < 0.05;
        if (settled(a, goals[i]) || settled(b, goals[j])) continue;
        // never apart further than their stands are (packed tight against a wall)
        const gi = goals[i], gj = goals[j];
        const min = Math.min(0.8 * (ms[i].radius + ms[j].radius), 0.95 * Math.hypot(gj.x - gi.x, gj.z - gi.z));
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        if (d >= min || d < 1e-4) continue;
        const k = (min - d) / d * 0.25; // soft: a quarter of the overlap per frame
        a.x -= dx * k; a.z -= dz * k;
        b.x += dx * k; b.z += dz * k;
        if (obstacles && !ms[i].fly) { // flyers pass over the structures
          obstacles.pushOut(a.x, a.z, ms[i].radius * 0.9, _out); a.x = _out.x; a.z = _out.z;
          obstacles.pushOut(b.x, b.z, ms[j].radius * 0.9, _out); b.x = _out.x; b.z = _out.z;
        }
      }
    }
  }

  dispose() {
    for (const m of this.members) m.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Draws a planned route: dots along the way coloured by the turn they're reached
 * in (this turn green, later turns amber, at sea blue), with the turn number
 * where each turn ends and a marker on the goal.
 */
export class PathView {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'path-view';
    parent.add(this.group);
    const MAX = 1200;
    this.dots = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.15, 12).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false }),
      MAX,
    );
    this.dots.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 6;
    this.group.add(this.dots);
    this.goal = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.48, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, depthWrite: false }),
    );
    this.goal.renderOrder = 6;
    this.group.add(this.goal);
    this.labels = [];
    this.clear();
  }

  clear() {
    this.dots.count = 0;
    this.goal.visible = false;
    for (const l of this.labels) { l.element.remove(); l.removeFromParent(); }
    this.labels = [];
  }

  /**
   * points: [{x, z, sea}] tile centres from the unit to the goal; turns: turn per
   * point (see turnsAlong); heightAt(x, z) for the ground. dim: an old plan.
   */
  show(points, turns, heightAt, { dim = false } = {}) {
    this.clear();
    if (points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal', 0.5);
    const len = curve.getLength();
    const step = 0.5;
    const n = Math.min(this.dots.instanceMatrix.count, Math.floor(len / step));
    const m4 = new THREE.Matrix4(), c = new THREE.Color();
    const seg = [0];
    for (let i = 1; i < points.length; i++) seg.push(seg[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    const total = seg[seg.length - 1] || 1;
    let k = 0;
    for (let i = 1; i <= n; i++) {
      const u = (i * step) / len;
      if (u > 0.985) break;
      const p = curve.getPointAt(u);
      // which waypoint this dot heads toward
      const s = u * total;
      let j = 1;
      while (j < seg.length - 1 && seg[j] < s) j++;
      const sea = points[j].sea && points[j - 1].sea;
      const turn = turns[j];
      if (sea) c.setRGB(0.35, 0.75, 1.3);
      else if (turn === 0) c.setRGB(0.45, 1.25, 0.4);
      else c.setRGB(1.3, 0.85 - Math.min(0.5, turn * 0.12), 0.2);
      if (dim) c.multiplyScalar(0.55);
      const y = sea ? 0.06 : heightAt(p.x, p.z) + 0.07;
      m4.makeTranslation(p.x, y, p.z);
      this.dots.setMatrixAt(k, m4);
      this.dots.setColorAt(k, c);
      k++;
    }
    this.dots.count = k;
    this.dots.instanceMatrix.needsUpdate = true;
    this.dots.instanceColor.needsUpdate = true;
    const last = points[points.length - 1];
    this.goal.position.set(last.x, (last.sea ? 0 : heightAt(last.x, last.z)) + 0.08, last.z);
    this.goal.material.color.setRGB(...(turns[turns.length - 1] === 0 ? [0.45, 1.3, 0.4] : [1.35, 0.8, 0.2])).multiplyScalar(dim ? 0.55 : 1);
    this.goal.visible = true;
    // turn numbers where each turn's march ends
    for (let i = 1; i < points.length; i++) {
      const end = i === points.length - 1 || turns[i + 1] !== turns[i];
      if (!end || (turns[i] === 0 && i !== points.length - 1)) continue;
      const div = document.createElement('div');
      div.className = 'turn-label' + (turns[i] === 0 ? ' now' : '');
      div.textContent = String(turns[i] + 1);
      const obj = new CSS2DObject(div);
      const p = points[i];
      obj.position.set(p.x, (p.sea ? 0 : heightAt(p.x, p.z)) + 0.45, p.z);
      this.group.add(obj);
      this.labels.push(obj);
    }
  }
}
