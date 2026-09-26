// Spells (Warlords III: Darklords Rising manual, Appendix 3, plus the Reign of Heroes spells
// the class tables teach). Ids match render/SpellFX.js.
//   cost   mana to cast
//   kind   'buff' / 'curse': lasts on the caster's stack until cancelled; costs `upkeep`
//          (half the cost, rounded up) mana every turn, ends when mana runs out
//          'summon': one-off, summons armies into the caster's stack (or beside it)
//          'utility': one-off effect
//   fx     effect while it lasts:
//          str / hits on the caster; grpStr / grpHits / move on every army of the stack;
//          ab: stack abilities (leadership, morale, fortify, fear, chaos, siege, poison, disease,
//          paralysis, curse, lightning, trample); fly, invisible; income (gold per turn);
//          engineer (city building discount, x10 %)
export const SPELLS = {
  // Wizard
  strength: { name: 'Strength', cost: 3, kind: 'buff', fx: { str: 2 }, desc: 'Strength +2 (caster)' },
  haste: { name: 'Haste', cost: 4, kind: 'buff', fx: { move: 8 }, desc: 'Move +8 (group)' },
  flight: { name: 'Flight', cost: 8, kind: 'buff', fx: { fly: true }, desc: 'The whole group flies' },
  wallofforce: { name: 'Wall of Force', cost: 5, kind: 'buff', fx: { ab: { fortify: 2 } }, desc: 'Fortify +2' },
  heroism: { name: 'Heroism', cost: 6, kind: 'buff', fx: { ab: { leadership: 2 }, str: 1 }, desc: 'Leadership +2, Strength +1 (caster)' },
  invisibility: { name: 'Invisibility', cost: 6, kind: 'buff', fx: { invisible: true }, desc: 'The group cannot be seen unless it attacks' },
  phantomsteed: { name: 'Phantom Steed', cost: 5, kind: 'buff', fx: { move: 10 }, desc: 'Move +10 (group)' },
  // Necromancer / Vampire
  terror: { name: 'Terror', cost: 3, kind: 'curse', fx: { ab: { fear: 1 } }, desc: 'Fear +1' },
  chaosseed: { name: 'Chaos Seed', cost: 4, kind: 'curse', fx: { ab: { chaos: 2 } }, desc: 'Chaos +2' },
  reanimate: { name: 'Reanimate', cost: 6, kind: 'summon', summon: [['skeleton', 4, 8]], desc: 'Summons 4-8 Skeletons' },
  wraithcall: { name: 'Wraithcall', cost: 12, kind: 'summon', summon: [['wraith', 1, 2]], desc: 'Summons 1-2 Wraiths' },
  lifesbane: { name: 'Lifesbane', cost: 20, kind: 'summon', summon: [['skeleton', 6, 10], ['wight', 1, 4], ['wraith', 1, 2], ['undeadbeast', 0, 1]], desc: 'Summons 6-10 Skeletons, 1-4 Wights, 1-2 Wraiths, 0-1 Undead Beasts' },
  // Paladin / Priest / Ranger / Shaman
  fortify: { name: 'Fortify', cost: 3, kind: 'buff', fx: { ab: { fortify: 1 } }, desc: 'Fortify +1' },
  bravery: { name: 'Bravery', cost: 3, kind: 'buff', fx: { ab: { morale: 1 } }, desc: 'Morale +1' },
  mightyfeast: { name: 'Mighty Feast', cost: 8, kind: 'buff', fx: { grpHits: 1, str: 1 }, desc: 'Hits +1 (group), Strength +1 (caster)' },
  dig: { name: 'Dig', cost: 4, kind: 'buff', fx: { engineer: 2 }, desc: 'Engineering +2 (cheaper city building)' },
  augury: { name: 'Augury', cost: 5, kind: 'utility', desc: 'Reveals the map and every army for miles around' },
  jihad: { name: 'Jihad', cost: 4, kind: 'buff', fx: { ab: { siege: 1 }, move: 4 }, desc: 'Siege +1, Move +4 (group)' },
  evileye: { name: 'Evil Eye', cost: 5, kind: 'curse', fx: { ab: { poison: 5, disease: 5, paralysis: 5, curse: 5 } }, desc: 'Poison +5, Disease +5, Paralysis +5, Curse +5' },
  berserker: { name: 'Berserker', cost: 6, kind: 'buff', fx: { grpStr: 1, ab: { fear: 1 } }, desc: 'Strength +1 (group), Fear +1' },
  // Summoner
  summonimp: { name: 'Summon Imp', cost: 5, kind: 'summon', summon: [['imp', 1, 3]], desc: 'Summons 1-3 Imps' },
  summonhound: { name: 'Summon Hound', cost: 7, kind: 'summon', summon: [['hellhound', 1, 5]], desc: 'Summons 1-5 Hellhounds' },
  minordemon: { name: 'Minor Demon', cost: 10, kind: 'summon', summon: [['icedemon', 1, 3]], desc: 'Summons 1-3 Ice Demons' },
  greaterdemon: { name: 'Greater Demon', cost: 13, kind: 'summon', summon: [['firedemon', 1, 3]], desc: 'Summons 1-3 Fire Demons' },
  teleport: { name: 'Teleport', cost: 10, kind: 'utility', desc: 'Teleports the group to any friendly city' },
  // Alchemist
  creategolem: { name: 'Create Golem', cost: 6, kind: 'summon', summon: [['claygolem', 1, 1]], desc: 'Summons 1 Clay Golem' },
  summonitem: { name: 'Summon Item', cost: 10, kind: 'utility', desc: 'Summons a nearby magic item' },
  // Monk
  mightyblow: { name: 'Mighty Blow', cost: 2, kind: 'buff', fx: { ab: { trample: 1 } }, desc: 'Trample +1' },
  bodycontrol: { name: 'Body Control', cost: 4, kind: 'buff', fx: { str: 1, hits: 1, move: 4 }, desc: 'Strength +1, Hits +1, Move +4' },
  mindcontrol: { name: 'Mind Control', cost: 5, kind: 'buff', fx: { ab: { fear: 1, morale: 1 } }, desc: 'Fear +1, Morale +1' },
  // Bard
  stormsong: { name: 'Storm Song', cost: 3, kind: 'buff', fx: { ab: { lightning: 2, chaos: 1 } }, desc: 'Lightning +2, Chaos +1' },
  songofbattle: { name: 'Song of Battle', cost: 5, kind: 'buff', fx: { ab: { morale: 1 }, move: 5 }, desc: 'Morale +1, Move +5 (group)' },
  songoflife: { name: 'Song of Life', cost: 9, kind: 'buff', fx: { grpHits: 1, move: 4 }, desc: 'Hits +1 (group), Move +4 (group)' },
  songofstone: { name: 'Song of Stone', cost: 4, kind: 'buff', fx: { ab: { fortify: 1 }, engineer: 2 }, desc: 'Fortify +1, Engineer +2' },
  songoffortune: { name: 'Song of Fortune', cost: 4, kind: 'buff', fx: { ab: { leadership: 1 }, income: 3 }, desc: 'Leadership +1, Income +3' },
};

for (const s of Object.values(SPELLS)) s.upkeep = s.kind === 'buff' || s.kind === 'curse' ? Math.ceil(s.cost / 2) : 0;
