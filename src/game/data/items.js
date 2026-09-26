// Magic items heroes find in ruins, win on quests or buy from merchants. `tier`: 1 minor,
// 2 major, 3 artifact (quest rewards / deep ruins). `fx` uses the same vocabulary as spells:
// str / hits / move / view on the hero, grpStr / grpHits / move on the stack, ab stack abilities,
// fly, income (gold per turn), mana (per turn), engineer.
const I = (name, tier, value, fx, icon) => ({ name, tier, value, fx, icon });

export const ITEMS = {
  swordmight: I('Sword of Might', 1, 120, { str: 1 }, '🗡'),
  axeslaughter: I('Axe of Slaughter', 2, 300, { str: 2 }, '🪓'),
  firebrand: I('Firebrand', 3, 700, { str: 3, ab: { chaos: 1 } }, '🔥'),
  shieldwarding: I('Shield of Warding', 1, 110, { hits: 1 }, '🛡'),
  plateknights: I('Enchanted Plate', 2, 320, { hits: 2 }, '🛡'),
  bootsspeed: I('Boots of Speed', 1, 150, { move: 6 }, '👢'),
  sevenleague: I('Seven League Boots', 2, 380, { move: 12 }, '👢'),
  wingsflight: I('Wings of Flight', 3, 900, { fly: true }, '🪽'),
  bannerlead: I('Banner of Command', 1, 160, { ab: { leadership: 1 } }, '🚩'),
  crowncommand: I('Crown of Command', 2, 450, { ab: { leadership: 2 } }, '👑'),
  crownkings: I('Crown of Kings', 3, 1100, { ab: { leadership: 3, morale: 1 } }, '👑'),
  hornvalor: I('Horn of Valour', 1, 140, { ab: { morale: 1 } }, '📯'),
  drumwar: I('War Drums', 2, 380, { ab: { morale: 2 } }, '🥁'),
  skullfear: I('Skull of Dread', 1, 150, { ab: { fear: 1 } }, '💀'),
  masknight: I('Mask of Nightmares', 2, 420, { ab: { fear: 2 } }, '🎭'),
  orbchaos: I('Orb of Chaos', 2, 400, { ab: { chaos: 2 } }, '🔮'),
  stonewall: I('Stone of the Wall', 1, 150, { ab: { fortify: 1 } }, '🪨'),
  ramiron: I('Iron Ram', 1, 150, { ab: { siege: 1 } }, '🔨'),
  hammerwalls: I('Hammer of Walls', 2, 420, { ab: { siege: 2 } }, '🔨'),
  ringwealth: I('Ring of Wealth', 1, 200, { income: 10 }, '💍'),
  purseplenty: I('Purse of Plenty', 2, 450, { income: 25 }, '💰'),
  staffmana: I('Staff of Mana', 1, 180, { mana: 2 }, '🪄'),
  staffarchmage: I('Staff of the Archmage', 3, 900, { mana: 5, str: 1 }, '🪄'),
  amuletlife: I('Amulet of Life', 2, 350, { grpHits: 1 }, '📿'),
  eyefar: I('Eye of Far Seeing', 1, 100, { view: 3 }, '👁'),
  daggerassassin: I('Assassin\'s Dagger', 2, 500, { ab: { assassin: 3 } }, '🗡'),
  wardstone: I('Ward Stone', 1, 160, { ab: { warding: 2 } }, '💠'),
  pickengineer: I('Engineer\'s Pick', 1, 130, { engineer: 3 }, '⛏'),
  gauntletsogre: I('Gauntlets of Ogre Power', 2, 360, { str: 2, hits: 1 }, '🧤'),
  hornkor: I('Horn of Kor', 3, 1200, { ab: { fear: 2, chaos: 2 }, str: 2 }, '📯'),
};
export const ITEMS_BY_TIER = [1, 2, 3].map((t) => Object.keys(ITEMS).filter((k) => ITEMS[k].tier === t));
