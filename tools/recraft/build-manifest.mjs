// Writes tools/recraft/manifest.json: one Recraft prompt per piece of 2D art the game can use
// (unit and hero portraits, spell and item icons, battle backgrounds, menu art), each with
// the file the game looks for (src/play/art.js). Run: node tools/recraft/build-manifest.mjs
// Then generate the images with the Recraft MCP (see tools/recraft/README.md).
import { writeFileSync } from 'node:fs';
import { UNITS } from '../../src/game/data/units.js';
import { HERO_CLASSES } from '../../src/game/data/heroes.js';
import { SPELLS } from '../../src/game/data/spells.js';
import { ITEMS } from '../../src/game/data/items.js';

// One look for everything: painted high-fantasy art in the spirit of 1990s strategy-game
// box art, dark vignette so icons sit on the game's dark-gold frames.
const STYLE = 'Painted high-fantasy illustration, rich oil-paint texture, dramatic rim light, muted earthy palette with gold highlights, in the spirit of 1990s Warlords III box art (Brom), dark vignette background, no text, no border, no watermark';

const DESC = {
  archer: 'a longbow archer in green hood and leather jerkin', archon: 'a radiant winged archon angel in golden armour', assassin: 'a hooded assassin with twin daggers',
  ballista: 'a heavy wooden siege ballista on wheels', barbarians: 'a fur-clad barbarian warrior with a great axe', giantbat: 'a huge leathery giant bat with glowing eyes',
  catapult: 'a wooden siege catapult with a loaded throwing arm', cavewyrm: 'a grey-brown cave wyrm dragon', centaur: 'a centaur archer with a spear', cockatrice: 'a monstrous cockatrice, rooster-serpent hybrid',
  firedemon: 'a towering fire demon wreathed in flame', icedemon: 'an ice demon with frost-blue skin and icicle horns',
  blackdragon: 'a black dragon dripping acid', bluedragon: 'a blue dragon crackling with lightning', golddragon: 'a majestic gold dragon', greendragon: 'a green dragon exhaling poison mist',
  reddragon: 'a red dragon breathing fire', silverdragon: 'a silver dragon with shining scales', undeaddragon: 'a skeletal undead dragon with ghost-green eyes',
  dryad: 'a dryad, a tree spirit woman with bark skin and leaves', dustwyrm: 'a sandy dust wyrm dragon', dwarfcrossbow: 'a dwarf crossbowman in heavy mail', dwarf: 'a stout dwarf infantryman with axe and round shield',
  dwarfmutant: 'a hulking mutated dwarf brute', dwarfrunner: 'a quick dwarf runner scout', eagle: 'a giant war eagle', airelemental: 'an air elemental, a swirling humanoid storm',
  fireelemental: 'a fire elemental of living flame', rockelemental: 'a rock elemental of boulders', elephant: 'an armoured war elephant with a howdah', elf: 'an elven archer with a curved bow',
  elvencavalry: 'an elven knight on a white horse', elveninfantry: 'an elven swordsman in leaf-green armour', elflord: 'an elven lord in golden armour', ghost: 'a pale translucent ghost',
  ghoul: 'a grey rotting ghoul', giantbee: 'a giant bee with a long stinger', giantscorpion: 'a giant black scorpion', giantspider: 'a giant hairy spider', giant: 'a stone-club wielding hill giant',
  gnollcavalry: 'a hyena-headed gnoll riding a giant hyena', gnollcrossbow: 'a hyena-headed gnoll with a crossbow', gnoll: 'a hyena-headed gnoll warrior with a spear', goblin: 'a small green goblin with a rusty blade',
  claygolem: 'a clay golem', irongolem: 'an iron golem', stonegolem: 'a stone golem', griffon: 'a griffon, eagle-lion beast', halfling: 'a halfling slinger', harpy: 'a shrieking harpy with feathered wings',
  heavycavalry: 'a heavy cavalryman in plate on an armoured warhorse', heavyinfantry: 'a heavy infantryman in plate with kite shield and sword', hellhound: 'a fiery hellhound', imp: 'a small winged red imp',
  knight: 'a mounted knight with lance and heraldic shield', knightlord: 'a knight lord in ornate gilded armour on a barded horse', lich: 'a lich sorcerer with a glowing skull staff', lightcavalry: 'a light cavalry rider with a spear',
  lightinfantry: 'a light infantryman with spear and leather armour', medusa: 'a medusa with snake hair', minotaur: 'a minotaur with a double axe', moonguard: 'a silver-armoured moonguard spearman',
  iceguard: 'an ice guard warrior in frosted armour', mummy: 'a bandaged mummy', nightmare: 'a black nightmare horse with flaming mane', ogre: 'a brutish ogre with a club', orc: 'a snarling orc with a crude blade',
  orog: 'a dark-skinned elite orog warrior', peasant: 'a peasant militiaman with a pitchfork', pegasus: 'a white winged pegasus', darkpegasus: 'a black winged dark pegasus', pikeman: 'a pikeman with a long pike',
  plaguecarrier: 'a plague carrier in rags with a censer of green smoke', giantrat: 'a giant diseased rat', reaver: 'a savage reaver raider with a flail', scout: 'a light scout with a short bow',
  siegeengine: 'a wooden siege tower on wheels', skeleton: 'a skeleton warrior with sword and shield', slayerknight: 'a black-armoured slayer knight', spectre: 'a blue spectral spectre',
  treant: 'an ancient treant tree creature', troll: 'a green regenerating troll', undeadbeast: 'a monstrous undead beast of bone and sinew', unicorn: 'a white unicorn', warg: 'a huge snarling warg wolf',
  wight: 'a pale-blue armoured wight', wolfrider: 'a goblin riding a wolf', wraith: 'a hooded black wraith', zombie: 'a shambling zombie', greenslime: 'a bubbling green slime ooze',
};
const HERO_DESC = {
  summoner: 'a summoner in dark robes with a staff crowned by a demon skull', alchemist: 'an alchemist with potion vials and brass goggles', monk: 'a bald martial-arts monk in saffron robes',
  bard: 'a bard with a lute and feathered cap', barbarian: 'a barbarian chieftain with a greatsword', general: 'a general in plate armour and a crimson cloak', necromancer: 'a necromancer in black robes with a skull staff',
  paladin: 'a paladin in shining plate with a tabard and warhammer', priest: 'a priest in white and gold vestments with a holy symbol', ranger: 'a ranger in a green cloak with a longbow',
  shaman: 'a druid-shaman with antlered headdress and a gnarled staff', thief: 'a rogue thief in a dark hood with daggers', vampire: 'a vampire lord in a high-collared cloak',
  warrior: 'a battle-scarred warrior with sword and shield', wizard: 'an old wizard in blue robes with a glowing staff',
};

const out = [];
for (const [key, u] of Object.entries(UNITS)) {
  out.push({ id: `unit-${key}`, file: `src/assets/art/units/${key}.webp`, size: '4:5',
    prompt: `Portrait of ${DESC[key] ?? u.name}, head and shoulders (whole body for beasts and engines), three-quarter view, the ${u.name} of a fantasy army. ${STYLE}` });
}
for (const [cls, c] of Object.entries(HERO_CLASSES)) {
  out.push({ id: `hero-${cls}`, file: `src/assets/art/units/${c.model}.webp`, size: '4:5',
    prompt: `Heroic portrait of ${HERO_DESC[cls]}, a legendary ${c.name} hero, head and shoulders, three-quarter view, noble and determined. ${STYLE}` });
}
for (const [id, s] of Object.entries(SPELLS)) {
  out.push({ id: `spell-${id}`, file: `src/assets/art/spells/${id}.webp`, size: '1:1',
    prompt: `Round magic spell icon for "${s.name}" (${s.desc}), a glowing arcane emblem centred on a dark background, luminous magical energy. ${STYLE}` });
}
for (const [key, it] of Object.entries(ITEMS)) {
  out.push({ id: `item-${key}`, file: `src/assets/art/items/${key}.webp`, size: '1:1',
    prompt: `Inventory icon of a magic item: ${it.name}, a single object centred, softly glowing enchantment. ${STYLE}` });
}
const GROUNDS = {
  plains: 'rolling grassy plains under a stormy sky', forest: 'a dark ancient forest clearing', hills: 'rocky highland hills', swamp: 'a misty fetid swamp',
  snow: 'a frozen snowfield', volcanic: 'a volcanic wasteland with lava rivers', siege: 'the walls and gatehouse of a besieged medieval castle', ruin: 'the haunted interior of an ancient ruin, torchlit',
  sea: 'a stormy sea with warships',
};
for (const [k, d] of Object.entries(GROUNDS)) {
  out.push({ id: `bg-battle-${k}`, file: `src/assets/art/backgrounds/battle-${k}.webp`, size: '16:9',
    prompt: `Wide empty battlefield backdrop: ${d}, no figures, room for two armies to face each other, cinematic depth. ${STYLE}` });
}
out.push({ id: 'bg-menu', file: 'src/assets/art/backgrounds/menu.webp', size: '16:9', prompt: `Epic fantasy vista of rival castles, marching armies and a dragon over a valley, title-screen key art, no text. ${STYLE}` });

writeFileSync(new URL('./manifest.json', import.meta.url), JSON.stringify({ style: STYLE, model: 'recraftv4_1', images: out }, null, 1));
console.log(`${out.length} images in tools/recraft/manifest.json`);
