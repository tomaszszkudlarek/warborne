// Hero classes (Warlords III: Darklords Rising manual, Appendix 2). `model` is the key in
// render/Heroes.js HERO_TYPES (the Wizard is drawn by the mage model, the Thief by the rogue,
// the Shaman by the druid). Each level row: [title, XP needed, ability points gained,
// ability, AP cost]. Abilities are parsed by parseAbility below.
const L = (rows) => rows.map(([title, xp, ap, ability, cost]) => ({ title, xp, ap, ability: parseAbility(ability), cost }));

export const HERO_CLASSES = {
  summoner: {
    name: 'Summoner', model: 'summoner', str: 3, hits: 1, move: 18, view: 2,
    levels: L([
      ['Apprentice', 0, 0, 'Move +3', 1], ['Invoker', 4, 1, 'View +2', 1], ['Convoker', 8, 2, "'Summon Imp'", 1],
      ['Conjuror', 15, 2, "'Terror'", 1], ['Master Conjuror', 30, 3, "'Teleport'", 1], ['Lesser Summoner', 60, 3, 'Leadership +1', 2],
      ['Summoner', 120, 4, 'Chaos +1', 2], ['Master Summoner', 180, 4, "'Summon Hound'", 2], ['Lord Summoner', 250, 5, "'Minor Demon'", 3],
      ['Summoner King', 350, 6, "'Greater Demon'", 4],
    ]),
  },
  alchemist: {
    name: 'Alchemist', model: 'alchemist', str: 3, hits: 1, move: 18, view: 3,
    levels: L([
      ['Apprentice', 0, 0, 'Move +3', 1], ['Tinker', 6, 1, 'Fortify +1', 1], ['Master Tinker', 13, 1, 'Engineer +2', 1],
      ['Artificer', 25, 2, "'Create Golem'", 1], ['Master Artificer', 40, 2, 'Siege +1', 2], ['Lesser Alchemist', 70, 3, 'Leadership +1', 2],
      ['Alchemist', 120, 3, 'Hits +1', 2], ['Master Alchemist', 180, 4, "'Teleport'", 2], ['Lord Alchemist', 250, 5, "'Wall of Force'", 2],
      ['High Lord Alchemist', 350, 6, "'Summon Item'", 3],
    ]),
  },
  monk: {
    name: 'Monk', model: 'monk', str: 4, hits: 2, move: 20, view: 3,
    levels: L([
      ['Neophyte', 0, 0, 'Strength +1', 1], ['Novice', 3, 1, 'Move +4', 1], ['Initiate', 6, 2, "'Mighty Blow'", 1],
      ['Adept', 12, 2, "'Body Control'", 1], ['Master', 25, 2, "'Mind Control'", 1], ['Lesser Monk', 50, 3, 'Siege +1', 2],
      ['Monk', 100, 3, 'Hits +1', 2], ['Greater Monk', 180, 4, 'Leadership +1', 2], ['Master Monk', 240, 5, 'Move Bonus', 2],
      ['Grandmaster Monk', 300, 6, 'Fear +1', 3],
    ]),
  },
  bard: {
    name: 'Bard', model: 'bard', str: 3, hits: 2, move: 18, view: 2,
    levels: L([
      ['Apprentice', 0, 0, 'Move +3', 1], ['Journeyman', 6, 1, 'Strength +1', 1], ['Singer', 12, 1, 'Morale +1', 1],
      ['Songmaster', 25, 2, 'Leadership +1', 1], ['Minstrel', 50, 2, "'Storm Song'", 1], ['Troubadour', 100, 3, "'Song of Battle'", 1],
      ['Bard', 150, 3, 'Fortify +1', 2], ['Lord of Bards', 200, 4, "'Song of Life'", 2], ['Prince of Bards', 300, 5, "'Song of Stone'", 2],
      ['King of Bards', 400, 6, "'Song of Fortune'", 2],
    ]),
  },
  barbarian: {
    name: 'Barbarian', model: 'barbarian', str: 5, hits: 2, move: 20, view: 3,
    levels: L([
      ['Plainsman', 0, 0, 'Strength +2', 1], ['Tribesman', 4, 1, 'Move +5', 1], ['Hunter', 8, 1, 'Hits +1', 1],
      ['Huntmaster', 16, 2, 'View +2', 1], ['Lord of the Hunt', 35, 3, 'Leadership +1', 2], ['Chieftain', 70, 3, 'Morale +1', 2],
      ['Barbarian', 120, 4, 'Chaos +1', 2], ['Barbarian Chief', 180, 4, 'Move Bonus', 2], ['Barbarian Lord', 250, 5, 'Fear +1', 3],
      ['Barbarian King', 350, 6, 'Speed', 4],
    ]),
  },
  general: {
    name: 'General', model: 'general', str: 4, hits: 2, move: 17, view: 3,
    levels: L([
      ['Leader', 0, 0, 'Leadership +1', 1], ['Marshall', 5, 1, 'Strength +1', 1], ['Lieutenant', 10, 1, 'View +1', 1],
      ['Captain', 15, 2, 'Engineer +1', 1], ['Commander', 30, 2, 'Move +4', 1], ['Major', 60, 3, 'Morale +1', 2],
      ['Colonel', 120, 3, 'Move Bonus', 2], ['Major-General', 200, 4, 'Fear +1', 2], ['General', 300, 5, 'Hits +1', 2],
      ['Field-Marshall', 400, 6, 'Fortify +1', 2],
    ]),
  },
  necromancer: {
    name: 'Necromancer', model: 'necromancer', str: 3, hits: 1, move: 18, view: 3,
    levels: L([
      ['Neophyte', 0, 0, 'Move +3', 1], ['Apprentice', 5, 1, "'Terror'", 1], ['Novice', 10, 1, "'Flight'", 1],
      ['Lesser Warlock', 18, 2, "'Chaos Seed'", 1], ['Warlock', 35, 2, "'Phantom Steed'", 2], ['Greater Warlock', 65, 3, "'Invisibility'", 2],
      ['Necromancer', 100, 4, "'Reanimate'", 2], ['Ghostmaster', 150, 4, "'Wraithcall'", 2], ['Lichemaster', 250, 5, 'Chaos +1', 2],
      ['Deathmaster', 350, 6, "'Lifesbane'", 3],
    ]),
  },
  paladin: {
    name: 'Paladin', model: 'paladin', str: 4, hits: 2, move: 16, view: 2,
    levels: L([
      ['Squire', 0, 0, 'Strength +1', 1], ['Cavalier', 5, 1, 'Move +3', 1], ['Lesser Knight', 10, 1, 'Morale +1', 1],
      ['Knight', 18, 2, 'Fear +1', 2], ['Greater Knight', 32, 2, 'Hits +1', 2], ['True Knight', 64, 3, "'Fortify'", 2],
      ['Paladin', 120, 4, "'Bravery'", 2], ['Great Paladin', 200, 4, "'Phantom Steed'", 2], ['Grand Paladin', 300, 5, 'View +2', 2],
      ['Paladin King', 400, 6, 'Leadership +1', 2],
    ]),
  },
  priest: {
    name: 'Priest', model: 'priest', str: 3, hits: 2, move: 18, view: 3,
    levels: L([
      ['Novice', 0, 0, 'Move +3', 1], ['Initiate', 4, 1, 'View +2', 1], ['Cleric', 8, 1, "'Fortify'", 1],
      ['Bishop', 15, 2, "'Bravery'", 1], ['Archbishop', 30, 2, "'Haste'", 1], ['Cardinal', 50, 3, "'Mighty Feast'", 2],
      ['Priest', 80, 3, "'Dig'", 2], ['Arch Priest', 120, 4, 'Morale +1', 2], ['High Priest', 200, 5, 'Leadership +1', 2],
      ['Priest King', 300, 6, "'Augury'", 3],
    ]),
  },
  ranger: {
    name: 'Ranger', model: 'ranger', str: 4, hits: 2, move: 20, view: 3,
    levels: L([
      ['Trainee', 0, 0, 'Move +4', 1], ['Tracker', 4, 1, 'Strength +1', 1], ['Hunter', 8, 1, 'Move Bonus', 1],
      ['Huntsmaster', 16, 2, 'View +2', 1], ['Trailmaster', 32, 2, "'Fortify'", 2], ['Forestmaster', 64, 3, "'Invisibility'", 2],
      ['Ranger', 120, 4, "'Haste'", 2], ['Master Ranger', 200, 4, 'Leadership +1', 2], ['Ranger Lord', 300, 5, 'Hits +1', 3],
      ['Ranger King', 400, 6, 'Speed', 4],
    ]),
  },
  shaman: {
    name: 'Shaman', model: 'druid', str: 3, hits: 2, move: 19, view: 3,
    levels: L([
      ['Helper', 0, 0, 'Hits +1', 1], ['Apprentice', 4, 1, 'Move +3', 1], ['Witchdoctor', 8, 1, "'Fortify'", 1],
      ['Spiritcaller', 15, 2, 'Chaos +1', 2], ['Spiritmaster', 30, 2, "'Augury'", 2], ['Lesser Shaman', 50, 3, "'Jihad'", 2],
      ['Shaman', 80, 3, 'Fear +1', 2], ['Master Shaman', 120, 4, "'Evil Eye'", 2], ['Shaman Lord', 200, 5, "'Berserker'", 3],
      ['Shaman King', 300, 6, 'Flying', 3],
    ]),
  },
  thief: {
    name: 'Thief', model: 'rogue', str: 4, hits: 1, move: 22, view: 4,
    levels: L([
      ['Rogue', 0, 0, 'Move +5', 1], ['Cutpurse', 5, 1, 'Assassin +1', 1], ['Robber', 10, 1, 'Move Bonus', 1],
      ['Burglar', 18, 2, 'Siege +1', 1], ['Master Burglar', 35, 2, 'Chaos +1', 2], ['Villain', 60, 3, 'Income +5', 2],
      ['Thief', 100, 3, 'Invisibility', 2], ['Master Thief', 160, 4, 'Strength +1', 2], ['Lord of Thieves', 250, 5, 'Speed', 3],
      ['King of Thieves', 350, 6, 'Leadership +1', 3],
    ]),
  },
  vampire: {
    name: 'Vampire', model: 'vampire', str: 3, hits: 2, move: 18, view: 3,
    levels: L([
      ['Drone', 0, 0, 'Hits +1', 1], ['Bloodleech', 5, 1, 'Fear +1', 1], ['Bloodmaster', 10, 1, 'Strength +1', 1],
      ['Lesser Incubus', 20, 2, "'Invisibility'", 1], ['Incubus', 40, 2, 'Move +3', 1], ['Lesser Vampire', 80, 3, 'Chaos +1', 2],
      ['Vampire', 150, 4, 'Leadership +1', 2], ['Vampire Count', 300, 5, "'Reanimate'", 2], ['Vampire Prince', 400, 6, 'Assassin +2', 3],
      ['Vampire King', 500, 7, 'Flying', 3],
    ]),
  },
  warrior: {
    name: 'Warrior', model: 'warrior', str: 4, hits: 3, move: 18, view: 2,
    levels: L([
      ['Trainee', 0, 0, 'Strength +1', 1], ['Apprentice', 4, 1, 'Move +3', 1], ['Veteran', 8, 1, 'Leadership +1', 2],
      ['Swordsman', 15, 2, 'Hits +1', 2], ['Swordmaster', 30, 2, 'View +2', 2], ['Weaponmaster', 60, 3, 'Morale +1', 2],
      ['Warrior', 100, 3, 'Move Bonus', 2], ['Great Warrior', 160, 4, 'Fear +1', 3], ['Warrior Lord', 250, 5, 'Chaos +1', 3],
      ['Warrior King', 400, 6, 'Engineer +5', 4],
    ]),
  },
  wizard: {
    name: 'Wizard', model: 'mage', str: 3, hits: 1, move: 18, view: 3,
    levels: L([
      ['Neophyte', 0, 0, 'Move +3', 1], ['Apprentice', 5, 1, "'Strength'", 1], ['Novice', 10, 1, "'Haste'", 1],
      ['Conjuror', 16, 2, "'Flight'", 1], ['Spellmaster', 32, 3, "'Wall of Force'", 1], ['Lesser Wizard', 50, 3, "'Heroism'", 2],
      ['Wizard', 80, 4, "'Invisibility'", 2], ['Great Wizard', 120, 5, "'Phantom Steed'", 2], ['Wizard Lord', 200, 5, 'Leadership +1', 2],
      ['Wizard King', 300, 6, 'Hits +1', 3],
    ]),
  },
};

/**
 * Ability text of the level tables -> effect:
 *   { spell: id } | { stat: 'str'|'hits'|'move'|'view', n } | { ab: combat ability, n }
 *   | { bonus: 'all' } (Move Bonus) | { fly: true } | { speed: true } | { invisible: true }
 *   | { income: n } | { engineer: n }
 */
export function parseAbility(text) {
  const spell = /^'(.+)'$/.exec(text);
  if (spell) return { spell: spell[1].toLowerCase().replace(/[^a-z]/g, ''), text: spell[1] };
  const m = /^(.+?) \+(\d+)$/.exec(text);
  if (m) {
    const n = +m[2], k = m[1].toLowerCase();
    const stat = { strength: 'str', hits: 'hits', move: 'move', movement: 'move', view: 'view', 'view range': 'view' }[k];
    if (stat) return { stat, n, text };
    if (k === 'income') return { income: n, text };
    if (k === 'engineer') return { engineer: n, text };
    return { ab: k === 'assassin' ? 'assassin' : k, n, text };
  }
  if (text === 'Move Bonus') return { bonus: 'all', text };
  if (text === 'Flying') return { fly: true, text };
  if (text === 'Speed') return { speed: true, text };
  if (text === 'Invisibility') return { invisible: true, text };
  return { text };
}

/** Class of a hero model key, for heroes placed by model name. */
export const CLASS_BY_MODEL = Object.fromEntries(Object.entries(HERO_CLASSES).map(([k, c]) => [c.model, k]));

/** Hero and heroine names drawn at random when a hero joins (the player may rename them). */
export const HERO_NAMES = [
  'Aldric', 'Brannoc', 'Cedrin', 'Dorian', 'Elric', 'Fenwick', 'Garrick', 'Halvard', 'Ingram', 'Jorund', 'Kael', 'Leofric',
  'Merek', 'Norrin', 'Osric', 'Perrin', 'Quillon', 'Roderic', 'Soren', 'Tarquin', 'Ulric', 'Varian', 'Wystan', 'Yorick',
  'Zoltan', 'Alaric', 'Bertrand', 'Caspian', 'Draven', 'Eamon', 'Faelan', 'Gideon', 'Hadrian', 'Idris', 'Jareth', 'Korvin',
  'Lucan', 'Magnus', 'Nestor', 'Orrin', 'Pelleas', 'Ragnar', 'Sigurd', 'Thorne', 'Valen', 'Wulfric', 'Aurelio', 'Balin',
  'Aelwyn', 'Brynja', 'Cordelia', 'Deirdre', 'Elowen', 'Freya', 'Gwendolyn', 'Hildegard', 'Isolde', 'Jessamy', 'Kestrel', 'Lyra',
  'Morgana', 'Nimue', 'Ondine', 'Rowena', 'Sabine', 'Tamsin', 'Una', 'Vivienne', 'Ysolde', 'Zephyra', 'Astrid', 'Seraphine',
];
