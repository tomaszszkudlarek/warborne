// Game dialogs: city, hero, spells, capture, ruin results, offers, reports, vectoring.
import { h, dialog, ask, kv } from './dom.js';
import { unitCard } from './hud.js';
import { ICON, SPELL_GLYPH } from './icons.js';
import { SIDES } from '../game/data/sides.js';
import { UNITS, ABILITY_NAMES, BONUS_NAMES } from '../game/data/units.js';
import { HERO_CLASSES } from '../game/data/heroes.js';
import { SPELLS } from '../game/data/spells.js';
import { ITEMS } from '../game/data/items.js';
import { CastleLevels } from '../generator/terrainTypes.js';
import { unitStats, stackEffects, unitName } from '../game/rules.js';
import { describeReward, HERO_NAME_MAX, VICTORY, HILL_DAYS } from '../game/Game.js';
import { standing, BRIBE_GOLD, STATUS } from '../game/diplomacy.js';
import { SPECIAL_TYPES, REBUILD_SITE } from '../game/specials.js';
import { SPELL_FX } from '../render/SpellFX.js';
import { art } from './art.js';
import { vectorMap, vectorHelp } from './vectormap.js';

/** A spell's or item's icon: its painting when there is one, else the glyph. */
const icon = (url, glyph) => (url ? h('img', { src: url, style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' } }) : glyph);

const abText = (ab) => Object.entries(ab ?? {}).filter(([, n]) => n).map(([k, n]) => `${ABILITY_NAMES[k] ?? k} +${n}`).join(', ');
const portrait = (P, type, owner, size = 64) => h('div.card', { vars: { '--c': owner >= 0 ? SIDES[owner].color : '#888' }, style: { width: `${size}px`, flex: 'none', cursor: 'default' } },
  h('img', { src: P.url(type, owner), 'data-type': type, 'data-owner': owner, draggable: 'false' }));
/** What a magic item does: "Strength +1, Flying". */
export function itemDesc(it) {
  const fx = it.fx;
  return [fx.str && `Strength +${fx.str}`, fx.hits && `Hits +${fx.hits}`, fx.move && `Move +${fx.move}`, fx.view && `View +${fx.view}`, fx.grpHits && `Group hits +${fx.grpHits}`, abText(fx.ab), fx.fly && 'Flying', fx.income && `Gold +${fx.income}/turn`, fx.mana && `Mana +${fx.mana}/turn`, fx.engineer && `Engineer +${fx.engineer}`].filter(Boolean).join(', ');
}
const spellColor = (id) => SPELL_FX?.[id]?.color ?? '#a88cff';

/** Unit type summary line: "Str 5 · Hits 2 · Move 20 · 2 turns · upkeep 3 · Morale +1". */
export function typeLine(type) {
  const u = UNITS[type];
  const extra = [abText(u.ab), u.bonus ? BONUS_NAMES[u.bonus] : ''].filter(Boolean).join(' · ');
  return `Str ${u.str} · Hits ${u.hits} · Move ${u.move} · ${u.time} turn${u.time > 1 ? 's' : ''} · upkeep ${u.upkeep}${extra ? ' · ' + extra : ''}`;
}

// --- city ------------------------------------------------------------------------------------------------
export function cityDialog(ctl, city) {
  const g = ctl.game, P = ctl.portraits;
  const mine = city.owner === ctl.viewer && ctl.human;
  return dialog((close, box) => {
    const render = () => {
      box.querySelectorAll(':scope > :not(.close)').forEach((e) => e.remove());
      const p = g.player(city.owner);
      const own = city.owner >= 0 ? SIDES[city.owner].name : 'Neutral';
      const garrison = g.unitsIn(city);
      box.append(
        h('h2', `${city.capital ? '♛ ' : ''}${city.name}`),
        h('div.sub', `${own} · ${city.razed ? 'Razed' : `${CastleLevels[city.level].name} (defence +${CastleLevels[city.level].defense})`}`),
        kv('Income', h('span', { html: `${ICON.gold} ${g.cityIncome(city)} gold per turn${city.port ? ` (${city.port} port${city.port > 1 ? 's' : ''})` : ''}` }),
          'Mana', h('span', { html: `${ICON.mana} ${city.mana} per turn` }),
          'Garrison', `${garrison.length} / 32 armies`),
      );
      // the special sites serving the city
      const sites = g.specials.filter((x) => x.city === city.id);
      if (sites.length) {
        box.append(h('h3', 'Sites'), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, sites.map((x) => {
          const T = SPECIAL_TYPES[x.type], razed = g.s.specials[x.i].razed;
          return h('div.row', { style: { fontSize: '13px' } },
            h('span', { style: { width: '22px' } }, T.icon), h('b', { style: { opacity: razed ? 0.5 : 1 } }, T.name),
            h('span.dim', razed ? '— razed, gives nothing' : `— ${T.text} ${city.name}`),
            razed && mine ? h('button.btn', { style: { padding: '2px 8px', fontSize: '12px', marginLeft: 'auto' }, disabled: p.gold < REBUILD_SITE, onclick: () => { if (g.rebuildSite(x.i, ctl.viewer)) { ctl.view.refreshSpecials?.(); render(); ctl.refresh(); } } }, `Rebuild — ${REBUILD_SITE} gp`) : null,
            h('button.btn', { style: { padding: '2px 8px', fontSize: '12px', marginLeft: razed && mine ? '0' : 'auto' }, title: 'Show on the map', onclick: () => { close(); ctl.lookAtTile(x.t); } }, '🔎'));
        })));
      }
      if (!mine) {
        // a razed city can be rebuilt by any army standing in its ruins
        const canRebuild = city.razed && ctl.human && g.garrison(city).some((k) => k.owner === ctl.viewer);
        const cost = g.buildCost(city);
        box.append(h('div.buttons',
          canRebuild ? h('button.btn.primary', { disabled: g.player(ctl.viewer).gold < cost, onclick: () => { if (g.buildUp(city, ctl.viewer)) { ctl.view.refreshCastles(); ctl.view.sync(); ctl.refresh(); close(); } } }, `Rebuild ${city.name} — ${cost} gp`) : null,
          h('button.btn', { onclick: () => close() }, 'Close')));
        return;
      }
      // production
      box.append(h('h3', 'Production'));
      const prodRow = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
      for (const type of city.prod) {
        const u = UNITS[type];
        const on = city.producing === type;
        prodRow.append(h('div.unitrow' + (on ? '.sel' : ''), { onclick: () => { g.setProduction(city, on ? null : type); render(); ctl.refresh(); } },
          portrait(P, type, city.owner, 52),
          h('div', { style: { flex: 1 } }, h('div.name', u.name, on ? h('span.good', { style: { marginLeft: '8px', fontSize: '12px' } }, `● training — ${city.progress}/${g.prodTime(city, type)} turn${g.prodTime(city, type) > 1 ? 's' : ''}`) : null),
            h('div.meta', typeLine(type))),
        ));
      }
      if (!city.prod.length) prodRow.append(h('div.dim', 'This city cannot train any of your armies. Buy the capacity below.'));
      box.append(prodRow);
      box.append(h('div.row', { style: { marginTop: '6px' } },
        h('button.btn', { onclick: () => { g.setProduction(city, null); render(); ctl.refresh(); } }, 'Stop production'),
        h('span.dim', { style: { fontSize: '12px' } }, city.producing ? `Next ${UNITS[city.producing].name} in ${g.prodTime(city, city.producing) - city.progress} turn(s).` : 'Idle.')));
      // buy production
      const buyable = g.buyableProduction(city);
      if (buyable.length) {
        box.append(h('h3', 'Buy production capacity'), h('div.dim', { style: { fontSize: '12px', marginBottom: '4px' } }, city.prod.length >= 4 ? 'The city trains four kinds already: buying replaces the first.' : 'A city can train up to four kinds of army.'));
        const grid = h('div.grid2');
        for (const type of buyable) {
          const u = UNITS[type];
          grid.append(h('div.unitrow', { onclick: () => { if (g.buyProduction(city, type)) { render(); ctl.refresh(); } } },
            portrait(P, type, city.owner, 44),
            h('div', { style: { flex: 1 } }, h('div.name', u.name, h('span.gold-t', { style: { float: 'right', fontSize: '12px' } }, `${u.cost} gp`)), h('div.meta', typeLine(type))),
          ));
          if (p.gold < u.cost) grid.lastChild.style.opacity = 0.45;
        }
        box.append(grid);
      }
      // walls
      box.append(h('h3', 'Fortifications'));
      const cost = g.buildCost(city);
      box.append(h('div.row',
        city.level < 3 ? h('button.btn.primary', { disabled: p.gold < cost, onclick: () => { if (g.buildUp(city)) { ctl.view.refreshCastles(); render(); ctl.refresh(); } } }, `Raise to ${CastleLevels[city.level + 1].name} — ${cost} gp`)
          : h('span.dim', 'The walls are as strong as they can be.'),
        h('span.dim', { style: { fontSize: '12px' } }, 'Walls add to the defence of every army in the city.')));
      // vectoring: the arrows are dragged on the vectoring map, in its own window
      box.append(h('h3', 'Vectoring'));
      const to = city.vector != null ? g.s.cities[city.vector] : null;
      box.append(h('div.row', { style: { fontSize: '12.5px' } },
        h('span', to ? `New armies go to ${to.name} — they arrive ${g.vectorTurns(city, to)} turns later.` : 'New armies stay here.'),
        h('button.btn', { style: { marginLeft: 'auto' }, title: 'Drag arrows between your cities (V)', onclick: () => vectoringDialog(ctl, city).then(() => { render(); ctl.refresh(); }) }, '➶ Vectoring map'),
        to ? h('button.btn', { onclick: () => { g.setVector(city, null); render(); ctl.refresh(); } }, 'Keep them here') : null));
      const inc = g.incoming(city);
      if (inc.length) box.append(h('div.dim', { style: { fontSize: '12px', marginTop: '6px' } }, `On the way here: ${inc.map((v) => `${v.n} from ${v.from != null ? g.s.cities[v.from].name : 'afar'} (day ${v.round})`).join(', ')}.`));
      box.append(h('div.buttons',
        g.canRaze(city, ctl.viewer) ? h('button.btn.danger', { title: 'Burn the city to the ground', onclick: async () => { close(); await ctl.razeCity(city); } }, '🔥 Raze') : null,
        h('button.btn.primary', { onclick: () => close() }, 'Done')));
    };
    render();
    return [];
  }, { dismiss: undefined, width: '640px' });
}

// --- hero --------------------------------------------------------------------------------------------------
export function heroDialog(ctl, u) {
  const g = ctl.game, P = ctl.portraits;
  const stack = g.stackOfUnit(u.id);
  const owner = stack.owner;
  const mine = owner === ctl.viewer && ctl.human;
  return dialog((close, box) => {
    const render = () => {
      box.querySelectorAll(':scope > :not(.close)').forEach((e) => e.remove());
      const hr = u.hero, cls = HERO_CLASSES[hr.cls];
      const s = unitStats(u);
      const lv = cls.levels;
      const next = lv[hr.level];
      const cur = lv[hr.level - 1];
      const xpPct = next ? ((hr.xp - cur.xp) / (next.xp - cur.xp)) * 100 : 100;
      box.append(
        h('div.row', { style: { alignItems: 'flex-start', gap: '16px' } },
          portrait(P, u.type, owner, 120),
          h('div', { style: { flex: 1 } },
            h('h2', hr.name),
            h('div.sub', `${cls.name} · Level ${hr.level}: ${cur.title}`),
            h('div.bar', h('i', { style: { width: `${Math.max(3, xpPct)}%` } })),
            h('div.dim', { style: { fontSize: '12px', marginTop: '3px' } }, next ? `${hr.xp} / ${next.xp} experience to ${next.title}` : `${hr.xp} experience — the highest level`),
            h('div', { style: { marginTop: '10px' } }, kv(
              'Strength', s.str, 'Hits', s.hits, 'Move', `${Math.floor(u.mp)} / ${s.move}`, 'View', s.view,
              'Abilities', abText(s.ab) || '—', 'Movement', [...s.bonus].map((b) => BONUS_NAMES[b]).join(', ') || (s.fly ? 'Flying' : '—'))),
          ),
        ),
      );
      // ability points
      box.append(h('h3', `Abilities — ${hr.ap} ability point${hr.ap === 1 ? '' : 's'} to spend`));
      const list = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' } });
      lv.forEach((l, i) => {
        const bought = hr.bought.includes(i);
        const open = g.abilityOpen(u, i);
        const can = mine && !bought && open && hr.ap >= l.cost;
        list.append(h('div.row', { style: { fontSize: '12.5px', opacity: open || bought ? 1 : 0.45, justifyContent: 'space-between' }, title: open ? '' : `A spell learned from level ${i + 1}` },
          h('span', h('b', { style: { color: bought ? 'var(--good)' : 'var(--ink)' } }, l.ability.text), l.ability.spell ? h('span.faint', ` · spell, L${i + 1}`) : null),
          bought ? h('span.good', '✓') : h('button.btn', { style: { padding: '2px 8px', fontSize: '11.5px' }, disabled: !can, onclick: () => { g.buyAbility(u, i); render(); ctl.refresh(); } }, `${l.cost} AP`)));
      });
      box.append(list);
      // items
      box.append(h('h3', 'Items'));
      if (!hr.items.length) box.append(h('div.dim', 'None. Search ruins and complete quests to find magic items.'));
      for (const k of hr.items) {
        const it = ITEMS[k];
        const desc = itemDesc(it);
        box.append(h('div.item', h('div.ig', icon(art.item(k), it.icon)), h('div', { style: { flex: 1 } }, h('b', it.name), h('div.dim', { style: { fontSize: '12px' } }, desc)),
          mine ? h('button.btn', { style: { padding: '3px 8px', fontSize: '11.5px' }, title: 'Sell to the merchants for half its worth', onclick: () => { hr.items.splice(hr.items.indexOf(k), 1); g.player(owner).gold += Math.round(it.value / 2); render(); ctl.refresh(); } }, `Sell ${Math.round(it.value / 2)} gp`) : null));
      }
      // spells
      box.append(h('h3', 'Spells'));
      if (!hr.spells.length) box.append(h('div.dim', `${cls.name}s learn spells as they rise in level.`));
      else box.append(h('div.row', hr.spells.map((id) => h('span.pill', { style: { borderColor: spellColor(id) } }, `${SPELL_GLYPH[id] ?? '✦'} ${SPELLS[id].name}${hr.active.includes(id) ? ' (in play)' : ''}`))));
      const qp = hr.quest && g.s.quests[owner]?.hero === u.id ? g.questProgress(owner) : null;
      if (qp) {
        box.append(h('h3', `Quest — ${qp.difficulty}`),
          h('div.row', { style: { justifyContent: 'space-between' } }, h('b', `❗ ${qp.text}`),
            qp.t != null ? h('button.btn', { style: { padding: '2px 8px', fontSize: '11.5px' }, onclick: () => { close(); ctl.lookAtTile(qp.t); } }, 'Show on map') : null),
          qp.n ? h('div.bar', { style: { marginTop: '5px' } }, h('i', { style: { width: `${Math.max(3, Math.min(100, (qp.done / qp.n) * 100))}%` } })) : null,
          h('div.dim', { style: { fontSize: '12px', marginTop: '3px' } }, `${qp.status} · ${qp.days ? `${qp.days} day${qp.days > 1 ? 's' : ''} on the quest` : 'accepted today'}`));
      } else if (hr.quest) box.append(h('h3', 'Quest'), h('div', `❗ ${hr.quest}`));
      box.append(h('div.buttons',
        mine && hr.spells.length ? h('button.btn', { onclick: () => { close(); ctl.openCast(u); } }, '✦ Cast a spell') : null,
        h('button.btn.primary', { onclick: () => close() }, 'Close')));
    };
    render();
    return [];
  }, { dismiss: undefined, width: '700px' });
}

// --- spells ------------------------------------------------------------------------------------------------
export function castDialog(ctl, u) {
  const g = ctl.game;
  const p = g.player(g.stackOfUnit(u.id).owner);
  return dialog((close) => {
    const rows = g.castable(u).map(({ id, spell, ok, active, why }) => h('div.spell', { vars: { '--sc': spellColor(id) } },
      h('div.glyph', icon(art.spell(id), SPELL_GLYPH[id] ?? '✦')),
      h('div.d', h('b', spell.name), h('span.dim', ` · ${spell.cost} mana${spell.upkeep ? `, then ${spell.upkeep} a turn` : ''}`), h('div', spell.desc)),
      active ? h('button.btn', { onclick: () => { g.cancelSpell(u, id); close(null); ctl.refresh(); } }, 'Cancel')
        : h('button.btn.primary', { disabled: !ok, title: why, onclick: () => close(id) }, 'Cast'),
    ));
    return [h('h2', `${u.hero.name} — spells`), h('div.sub', { html: `${ICON.mana} ${p.mana} mana available` }), ...rows];
  }, { dismiss: null, width: '560px' });
}

export function teleportDialog(ctl, u) {
  const g = ctl.game;
  const owner = g.stackOfUnit(u.id).owner;
  return dialog((close) => [
    h('h2', 'Teleport'), h('div.sub', 'Choose a city of yours to appear in.'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      g.citiesOf(owner).map((c) => h('button.btn', { onclick: () => close(c.id), disabled: g.unitsIn(c).length + g.stackOfUnit(u.id).units.length > 32 }, `${c.capital ? '♛ ' : ''}${c.name} — ${g.unitsIn(c).length} in garrison`))),
  ], { dismiss: null });
}

// --- capture -------------------------------------------------------------------------------------------------
export function captureDialog(ctl, stack, city) {
  const g = ctl.game;
  const own = SIDES[stack.owner].units;
  const foreign = city.prod.filter((t) => !own.includes(t));
  const pillage = Math.round(foreign.reduce((n, k) => n + UNITS[k].cost, 0) * 0.5);
  const sack = Math.round(city.prod.reduce((n, k) => n + UNITS[k].cost, 0) * 0.6 + city.income * 4);
  const opt = (label, value, desc, extra = {}) => ({ label, value, desc, ...extra });
  const opts = [
    opt('Occupy', 'occupy', 'Take the city as it stands. It loses production of armies you cannot build.'),
    opt('Pillage', 'pillage', `Strip what you cannot use: +${pillage} gold, walls drop a level.`, { disabled: !foreign.length }),
    opt('Sack', 'sack', `Plunder everything: +${sack} gold, all production lost, walls drop a level.`),
    opt('Raze', 'raze', 'Burn it to the ground. Nobody holds it; it can be rebuilt for 800 gold. Every other side will think the worse of you.', { danger: true, disabled: g.s.hill?.city === city.id }),
  ];
  return dialog((close) => [
    h('h2', `${city.name} has fallen!`),
    h('div.sub', `Your troops stand in the streets of ${city.name}. What are your orders?`),
    ...opts.map((o) => h('div.unitrow', { style: { opacity: o.disabled ? 0.4 : 1 }, onclick: () => !o.disabled && close(o.value) },
      h('div', { style: { flex: 1 } }, h('div.name', { style: { color: o.danger ? '#ff9a88' : 'var(--gold-hi)' } }, o.label), h('div.meta', o.desc)))),
  ], { width: '520px' }).then((v) => v ?? 'occupy');
}

// --- ruins ------------------------------------------------------------------------------------------------------
export function searchDialog(ctl, out) {
  const P = ctl.portraits;
  const owner = ctl.game.stackOfUnit(out.hero.id)?.owner ?? ctl.viewer;
  const g = out.guardians[0];
  return dialog((close) => [
    h('h2', out.site.name),
    h('div.row', { style: { gap: '14px', alignItems: 'flex-start' } },
      portrait(P, g.type, -1, 96),
      h('div', { style: { flex: 1 } },
        h('div', out.joined ? `The ${UNITS[g.type].name} guarding the ruin are won over by ${out.hero.hero.name} and join the party!`
          : out.won ? `${out.hero.hero.name} goes in alone and defeats ${out.guardians.length > 1 ? `${out.guardians.length} ` : 'the '}${UNITS[g.type].name} guarding the ruin.`
            : `${out.hero.hero.name} goes in alone and falls to the ${UNITS[g.type].name} of ${out.site.name}.${ctl.game.stackOfUnit(out.hero.id) ? '' : ' The rest of the group waited outside.'}`),
        out.won ? h('div.good', { style: { marginTop: '8px', fontSize: '15px' } }, `Found: ${describeReward(out.reward)}.`) : null,
        out.reward?.kind === 'item' ? h('div.item', h('div.ig', icon(art.item(out.reward.item), ITEMS[out.reward.item].icon)), h('b', ITEMS[out.reward.item].name)) : null,
        out.reward?.kind === 'allies' ? h('div.row', { style: { marginTop: '8px' } }, portrait(P, out.reward.type, owner, 56)) : null,
      )),
    h('div.buttons', h('button.btn.primary', { onclick: () => close() }, 'Continue')),
  ], { width: '520px' });
}

// --- offers --------------------------------------------------------------------------------------------------------
export async function offersDialog(ctl, offers) {
  const g = ctl.game, P = ctl.portraits;
  for (const o of [...offers]) {
    const p = g.current;
    let body, heroSel = null;
    if (o.kind === 'hero') {
      const cls = HERO_CLASSES[o.cls];
      body = h('div.row', { style: { gap: '14px', alignItems: 'flex-start' } }, portrait(P, cls.model, p.id, 110),
        h('div', { style: { flex: 1 } },
          h('div', `A ${o.level > 1 ? `level ${o.level} ` : ''}${cls.name} in ${o.city != null ? g.s.cities[o.city].name : 'your lands'} offers to join ${p.name} for ${o.cost} gold.`),
          h('div.dim', { style: { fontSize: '12.5px', marginTop: '6px' } }, `Strength ${cls.str} · Hits ${cls.hits} · Move ${cls.move} — ${cls.levels.slice(0, 4).map((l) => l.ability.text).join(', ')}…`),
          o.allies.length ? h('div.good', { style: { marginTop: '6px' } }, `Brings ${o.allies.length} ${UNITS[o.allies[0]].name}.`) : null));
    } else if (o.kind === 'item') {
      const it = ITEMS[o.item];
      const heroes = g.heroes(p.id).sort((a, b) => b.hero.xp - a.hero.xp);
      heroSel = h('select', heroes.map((u) => h('option', { value: u.id }, `${u.hero.name} (${HERO_CLASSES[u.hero.cls].name} L${u.hero.level})`)));
      body = h('div.row', { style: { gap: '14px', alignItems: 'flex-start' } }, h('div.ig', { style: { width: '72px', height: '72px', fontSize: '34px', display: 'grid', placeItems: 'center', borderRadius: '8px', background: 'radial-gradient(circle, #5a4520, #1a130a)', border: '1px solid var(--edge)' } }, icon(art.item(o.item), it.icon)),
        h('div', { style: { flex: 1 } },
          h('div', `A merchant${o.city != null ? ` in ${g.s.cities[o.city].name}` : ''} offers the ${it.name} for ${o.cost} gold.`),
          h('div.dim', { style: { fontSize: '12.5px', margin: '6px 0' } }, itemDesc(it), ` · worth ${it.value} gp to a fair buyer`),
          h('div.row', h('span', 'For'), heroSel)));
    } else {
      body = h('div.row', { style: { gap: '14px' } }, portrait(P, o.type, p.id, 90),
        h('div', `${o.n} ${UNITS[o.type].name} offer their swords for ${o.cost} gold.`, h('div.dim', { style: { fontSize: '12px' } }, typeLine(o.type))));
    }
    const yes = await ask(o.kind === 'hero' ? 'A hero seeks service' : o.kind === 'item' ? 'A merchant' : 'Mercenaries', body, [
      { label: `${o.kind === 'item' ? 'Buy' : 'Hire'} (${o.cost} gp)`, value: true, primary: true, disabled: p.gold < o.cost },
      { label: 'Decline', value: false },
    ]);
    if (yes) {
      const r = g.acceptOffer(o.id, heroSel ? +heroSel.value : null);
      if (r) {
        await ctl.view.ensureModels(r.units.map((u) => u.type)); ctl.view.sync(); ctl.refresh();
        for (const u of r.units) if (u.hero?.fresh) await heroEmergesDialog(ctl, u, r.city, { hired: true });
      }
    } else g.declineOffer(o.id);
  }
}

// --- a new hero: the announcement and the naming ----------------------------------------------------------------
/**
 * "A hero emerges in <city>!" — the player names the new hero (Warlords: the first hero of
 * every side arrives free at the start; hired ones are named too). Resolves with the name.
 */
export function heroEmergesDialog(ctl, u, city, { hired = false } = {}) {
  const g = ctl.game, P = ctl.portraits;
  const owner = g.stackOfUnit(u.id)?.owner ?? g.currentId;
  const cls = HERO_CLASSES[u.hero.cls];
  const side = SIDES[owner];
  const sideName = (side.title ?? side.name).replace(/^The /, 'the ');
  if (city) ctl.lookAtTile(city.tiles[3]);
  return dialog((close) => {
    const input = h('input', { type: 'text', value: u.hero.name, maxlength: HERO_NAME_MAX, spellcheck: 'false', style: { flex: 1, fontSize: '16px', padding: '7px 10px' } });
    const accept = () => { g.renameHero(u, input.value); ctl.refresh(); close(u.hero.name); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); accept(); } e.stopPropagation(); });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    const s = unitStats(u);
    return [
      h('h2', hired ? 'A hero joins your cause' : 'A hero emerges!'),
      h('div.row', { style: { gap: '16px', alignItems: 'flex-start' } }, portrait(P, u.type, owner, 120),
        h('div', { style: { flex: 1, minWidth: '300px' } },
          h('div', { style: { fontSize: '14.5px', lineHeight: 1.55 } }, hired
            ? `A ${cls.name} has arrived in ${city?.name ?? 'your lands'}, sworn to the banner of ${sideName}.`
            : `In the city of ${city?.name ?? 'your capital'}, a ${cls.name} has emerged to lead the armies of ${sideName}.`),
          h('div.dim', { style: { fontSize: '12.5px', margin: '6px 0 12px' } }, `Strength ${s.str} · Hits ${s.hits} · Move ${s.move} · ${cls.levels[0].title}`),
          h('div', { style: { fontSize: '13px', marginBottom: '6px', color: 'var(--gold)' } }, 'What name shall this hero bear?'),
          h('div', { style: { display: 'flex', gap: '6px' } }, input,
            h('button.btn', { title: 'Another name', onclick: () => { input.value = g.randomHeroName(); input.focus(); input.select(); } }, '🎲')))),
      h('div.buttons', h('button.btn.primary', { onclick: accept }, 'So be it')),
    ];
  }, { width: '560px' });
}

// --- the game opens on another side's move ----------------------------------------------------------------------
/** A computer side moves first: the player sets out before anything stirs on the map. */
export function beginDialog(ctl, first) {
  const g = ctl.game;
  const me = g.player(ctl.viewer);
  const side = me ? SIDES[me.id] : null;
  const cap = me && (g.s.cities.find((c) => c.owner === me.id && c.capital) ?? g.citiesOf(me.id)[0]);
  if (cap) ctl.lookAtTile(cap.tiles[3], true);
  return dialog((close) => [
    h('h2', { style: { textAlign: 'center' } }, g.s.map?.name ?? 'The adventure begins'),
    me ? h('div.crest', { vars: { '--c': me.color }, style: { width: '60px', height: '70px', margin: '4px auto 10px' } }) : null,
    h('div', { style: { fontSize: '14.5px', lineHeight: 1.55, textAlign: 'center', maxWidth: '440px', margin: '0 auto' } },
      me ? `You lead ${(side.title ?? side.name).replace(/^The /, 'the ')}${cap ? ` from ${cap.name}` : ''}. ` : '',
      `${first.name} march first. The war begins the moment you set out.`),
    h('div.buttons', { style: { justifyContent: 'center' } }, h('button.btn.primary.big', { onclick: () => close() }, 'Begin the adventure')),
  ], { width: '520px' });
}

// --- a hero falls -------------------------------------------------------------------------------------------------
const EPITAPHS = [
  'Songs will be sung of this courage in every hall of the realm.',
  'The banners are lowered. A braver heart never rode to war.',
  'Rest now; the watch is kept by others.',
  'Fallen, but not forgotten — the name is carved in stone at the capital.',
  'The war goes on, poorer for the loss.',
];

/** A hero of the player's is slain (in battle or in a ruin): a moment of respect.
 * `where`: the ruin's name, or where the battle was ("before the walls of X"), `slayer`: who
 * struck the blow, `items`: what lies where the hero fell. */
export function heroFallenDialog(ctl, u, owner, { where, ruin = false, slayer = null, items = [] } = {}) {
  const P = ctl.portraits;
  const cls = HERO_CLASSES[u.hero.cls];
  const title = cls.levels[u.hero.level - 1]?.title;
  const epitaph = EPITAPHS[(u.id * 7 + u.hero.level) % EPITAPHS.length];
  return dialog((close) => [
    h('h2', { style: { textAlign: 'center' } }, `${u.hero.name} has fallen`),
    h('div.row', { style: { gap: '16px', alignItems: 'flex-start' } },
      h('div', { style: { filter: 'grayscale(0.75) brightness(0.85)' } }, portrait(P, u.type, owner, 110)),
      h('div', { style: { flex: 1 } },
        h('div.dim', { style: { fontSize: '12.5px', marginBottom: '6px' } }, `${title ? `${title} · ` : ''}level ${u.hero.level} ${cls.name}`),
        h('div', { style: { fontSize: '14.5px', lineHeight: 1.55 } }, ruin
          ? `${u.hero.name} went alone into ${where}${slayer ? ` and fell to the ${slayer} guarding it` : ' and did not come back'}.`
          : `${u.hero.name} fell ${where}${slayer ? `, fighting ${slayer}` : ''}, standing fast to the last.`),
        h('div', { style: { fontSize: '14px', fontStyle: 'italic', color: 'var(--gold)', margin: '10px 0 4px' } }, epitaph),
        items.length ? h('div.dim', { style: { fontSize: '12.5px', marginTop: '8px' } },
          `The ${items.map((k) => ITEMS[k].name).join(', ')} ${items.length === 1 ? 'lies' : 'lie'} where the hero fell — another hero may take ${items.length === 1 ? 'it' : 'them'} up.`) : null)),
    h('div.buttons', { style: { justifyContent: 'center' } }, h('button.btn.primary', { onclick: () => close() }, 'Honour the fallen')),
  ], { width: '540px' });
}

// --- vectoring a group --------------------------------------------------------------------------------------------
export function vectorDialog(ctl, from) {
  const g = ctl.game;
  const timed = g.s.options.timedVectoring;
  return dialog((close) => [
    h('h2', 'Vector group'), h('div.sub', timed ? 'The group leaves now; the farther the city, the longer the road (2–5 turns).' : 'The group leaves now and arrives at the chosen city in two turns.'),
    vectorMap(ctl, { focus: from, mode: 'group', maxW: 780, maxH: 520, onPick: (c) => close(c) }),
    h('div.dim', { style: { fontSize: '11.5px', marginTop: '4px' } }, vectorHelp('group')),
  ], { dismiss: null, width: '820px' });
}

/** The vectoring network of the viewer's whole empire; `focus` (a city) is ringed and named. */
export function vectoringDialog(ctl, focus = null) {
  return dialog((close, box) => {
    const render = () => {
      box.querySelectorAll(':scope > :not(.close)').forEach((e) => e.remove());
      const g = ctl.game, n = g.citiesOf(ctl.viewer).filter((c) => c.vector != null).length;
      const to = focus?.vector != null ? g.s.cities[focus.vector] : null;
      const sub = focus ? (to ? `${focus.name} sends its new armies to ${to.name} — ${g.vectorTurns(focus, to)} turns on the road.` : `${focus.name} keeps its new armies.`)
        : n ? `${n} cit${n === 1 ? 'y sends' : 'ies send'} new armies elsewhere.` : 'Every city keeps its new armies.';
      box.append(h('h2', focus ? `Vectoring — ${focus.name}` : 'Vectoring'), h('div.sub', sub),
        vectorMap(ctl, { focus, maxW: 900, maxH: 620, onChange: () => { render(); ctl.refresh(); } }),
        h('div.dim', { style: { fontSize: '11.5px', marginTop: '4px' } }, vectorHelp('production')),
        h('div.buttons', h('button.btn.primary', { onclick: () => close() }, 'Done')));
    };
    render();
    return [];
  }, { dismiss: undefined, width: '940px' });
}

// --- reports ------------------------------------------------------------------------------------------------------------
export function reportsDialog(ctl, first = 'overview') {
  const g = ctl.game;
  return dialog((close, box) => {
    let tab = first;
    const body = h('div');
    const tabs = h('div.tabs');
    const setTab = (t) => { tab = t; draw(); };
    const draw = () => {
      tabs.innerHTML = '';
      const tabList = [['overview', 'Overview'], g.diplo.on ? ['diplomacy', 'Diplomacy'] : null, ['cities', 'Cities'], ['heroes', 'Heroes'], ['ruins', 'Ruins & sites'], ['events', 'Events']].filter(Boolean);
      for (const [k, l] of tabList) {
        tabs.append(h('button' + (k === tab ? '.on' : ''), { onclick: () => setTab(k) }, l, k === 'diplomacy' && g.diplo.hasNews(ctl.viewer) ? h('span', { style: { color: '#ff8a6a', marginLeft: '4px' } }, '●') : null));
      }
      if (tab === 'diplomacy') g.diplo.seen(ctl.viewer);
      body.innerHTML = '';
      const players = g.s.players;
      const vis = ctl.viewer;
      if (tab === 'overview') {
        const rows = players.map((p) => {
          const cities = g.citiesOf(p.id).length, armies = g.stacksOf(p.id).reduce((n, k) => n + k.units.length, 0);
          const heroes = g.heroes(p.id).length;
          return { p, cities, armies, heroes, vp: g.victoryPoints(p.id), score: p.alive ? Math.max(0, g.score(p)) : 0 };
        });
        const max = Math.max(1, ...rows.map((r) => r.score));
        const crest = (p) => h('span.crest', { vars: { '--c': p.color }, style: { width: '12px', height: '14px', display: 'inline-block', marginRight: '6px', verticalAlign: '-2px' } });
        body.append(h('table.rep', h('tr', h('th', 'Side'), h('th', 'Cities'), h('th', 'Armies'), h('th', 'Heroes'), h('th', 'Gold'), h('th', 'Kills'), h('th', { title: 'Victory points: a point per city and hero, plus gold' }, 'VP'), h('th', { style: { width: '26%' } }, 'Winning')),
          rows.map((r) => h('tr', { style: { opacity: r.p.alive ? 1 : 0.4 } },
            h('td', crest(r.p), r.p.name, r.p.human ? ' (human)' : '', r.p.alive ? '' : ' — destroyed'),
            h('td', r.cities), h('td', r.armies), h('td', r.heroes), h('td', r.p.id === vis || !r.p.human ? r.p.gold : '?'), h('td', r.p.kills), h('td', r.vp),
            h('td', h('div.hbar', { vars: { '--c': r.p.color }, style: { width: `${(r.score / max) * 100}%` } }))))));
        // the victory condition and how the race stands
        const o = g.s.options, V = VICTORY[o.victory] ?? VICTORY.last;
        let race = '';
        if (o.victory === 'hill' && g.s.hill) {
          const c = g.s.cities[g.s.hill.city], hd = g.s.hill.holder;
          race = hd >= 0 ? `${g.player(hd).name} hold ${c.name}: ${g.hillDaysLeft()} of ${HILL_DAYS} days to go.` : `${c.name} is held by ${c.owner >= 0 ? g.player(c.owner).name : 'neutral armies'}.`;
        } else if (o.victory === 'fortress') {
          const caps = g.s.cities.filter((c) => c.capital);
          race = `Capitals: ${caps.map((c) => `${c.name} (${c.razed ? 'razed' : c.owner >= 0 ? g.player(c.owner).name : 'neutral'})`).join(', ')}.`;
        }
        body.append(h('div', { style: { marginTop: '10px', fontSize: '13px' } }, h('b', { style: { color: 'var(--gold)' } }, `Victory: ${V.name}. `), V.desc,
          o.turnLimit ? ` Turn limit: day ${o.turnLimit} (${Math.max(0, o.turnLimit - g.s.round + 1)} to go).` : '', race ? h('div', { style: { marginTop: '4px' } }, race) : null));
        body.append(h('div.dim', { style: { fontSize: '12px', marginTop: '8px' } }, `Neutral cities: ${g.citiesOf(-1).length} · razed: ${g.s.cities.filter((c) => c.razed).length} · Day ${g.s.round}`));
      } else if (tab === 'diplomacy') {
        diplomacyTab(ctl, body, draw);
      } else if (tab === 'cities') {
        body.append(h('table.rep', h('tr', h('th', 'City'), h('th', 'Walls'), h('th', 'Income'), h('th', 'Garrison'), h('th', 'Training')),
          g.citiesOf(vis).map((c) => h('tr', { style: { cursor: 'pointer' }, onclick: () => { close(); ctl.lookAtTile(c.tiles[3]); ctl.openCity(c); } },
            h('td', `${c.capital ? '♛ ' : ''}${c.name}`), h('td', CastleLevels[c.level].name), h('td', g.cityIncome(c)), h('td', g.unitsIn(c).length),
            h('td', c.producing ? `${UNITS[c.producing].name} (${c.progress}/${g.prodTime(c, c.producing)})` : '—')))));
      } else if (tab === 'heroes') {
        const hs = g.heroes(vis);
        if (!hs.length) body.append(h('div.dim', 'You have no heroes.'));
        for (const u of hs) {
          const k = g.stackOfUnit(u.id);
          body.append(h('div.unitrow', { onclick: () => { close(); ctl.selectStack(k.id); ctl.centerOnSelection(); ctl.openHero(u); } },
            unitCard(u, vis, ctl.portraits), h('div', h('div.name', `${u.hero.name} — ${HERO_CLASSES[u.hero.cls].name} L${u.hero.level}`),
              h('div.meta', `${u.hero.xp} XP · ${u.hero.items.length} items · ${u.hero.spells.length} spells${u.hero.quest ? ` · quest: ${u.hero.quest}` : ''}`))));
        }
      } else if (tab === 'ruins') {
        const ex = g.s.options.hiddenMap ? g.explored(vis) : null;
        body.append(h('table.rep', h('tr', h('th', 'Site'), h('th', 'Kind'), h('th', 'State')),
          g.map.sites.map((s, i) => ({ s, i })).filter(({ s }) => !ex || ex[s.ty * g.W + s.tx]).map(({ s, i }) => h('tr', { style: { cursor: 'pointer' }, onclick: () => { close(); ctl.lookAtTile(s.ty * g.W + s.tx); } },
            h('td', s.name), h('td', s.kind === 'ruin' ? `Ruin ${'★'.repeat(s.danger)}` : 'Shrine'), h('td', s.kind === 'ruin' ? (g.s.sites[i].explored ? 'explored' : 'unexplored') : 'blesses visitors'))),
          g.specials.filter((x) => !ex || ex[x.t]).map((x) => h('tr', { style: { cursor: 'pointer' }, onclick: () => { close(); ctl.lookAtTile(x.t); } },
            h('td', `${SPECIAL_TYPES[x.type].icon} ${SPECIAL_TYPES[x.type].name} of ${g.s.cities[x.city].name}`), h('td', 'Site'),
            h('td', g.s.specials[x.i].razed ? 'razed' : `${SPECIAL_TYPES[x.type].text} ${g.s.cities[x.city].name}`)))));
      } else {
        body.append(h('div', { style: { maxHeight: '50vh', overflow: 'auto', fontSize: '12.5px' } },
          [...g.s.log].reverse().slice(0, 200).map((e) => h('div', { style: { padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,.05)' } }, h('span.faint', `Day ${e.round} · `), e.text))));
      }
    };
    draw();
    return [h('h2', 'Reports'), tabs, body];
  }, { dismiss: undefined, width: '820px' });
}

// --- diplomacy --------------------------------------------------------------------------------------------------------
const STATUS_LOOK = { war: ['⚔️', 'War', '#ff8a6a'], peace: ['☮️', 'Peace', '#cfe3a0'], allied: ['🤝', 'Allied', '#8fd0ff'] };
const statusPill = (st) => h('span.pill', { style: { borderColor: STATUS_LOOK[st][2], color: STATUS_LOOK[st][2] } }, `${STATUS_LOOK[st][0]} ${STATUS_LOOK[st][1]}`);
const hateColor = (x) => `hsl(${Math.round(120 - x * 1.2)}, 70%, 55%)`;

function diplomacyTab(ctl, body, redraw) {
  const g = ctl.game, me = ctl.viewer, D = g.diplo;
  const human = ctl.human && g.currentId === me;
  const others = g.s.players.filter((p) => p.id !== me);
  const crest = (p) => h('span.crest', { vars: { '--c': p.color }, style: { width: '12px', height: '14px', display: 'inline-block', marginRight: '6px', verticalAlign: '-2px' } });
  const say = (text, cls = '') => { msg.className = cls; msg.innerHTML = text; };
  const msg = h('div', { style: { minHeight: '20px', marginTop: '8px', fontSize: '13px' } });
  // feelings toward me and actions
  const rows = others.map((p) => {
    const st = D.status(me, p.id);
    const hate = D.hate(p.id, me);
    const pend = D.d.proposals.find((x) => x.from === me && x.to === p.id);
    const act = (label, fn, extra = {}) => h('button.btn', { style: { padding: '3px 8px', fontSize: '12px' }, disabled: !human || !p.alive || extra.disabled, title: extra.title, onclick: fn, class: extra.cls }, label);
    const propose = (kind) => () => {
      const r = D.propose(me, p.id, kind);
      say(r.answer === 'accepted' ? `<b>${p.name}</b> accept${kind === 'peace' ? ' peace' : ' the alliance'}. ${r.reason}` : r.answer === 'pending' ? r.reason : `<b>${p.name}</b> refuse. ${r.reason}`, r.answer === 'accepted' ? 'good' : r.answer === 'refused' ? 'bad' : 'dim');
      ctl.refresh(); redraw();
    };
    const war = async () => { if (await ctl._breakTreaty(p.id, st)) redraw(); };
    const bribe = async () => {
      const mine = g.player(me).gold;
      const r = await ask(`Gold for ${p.name}`, h('div', h('div.sub', `Every ${BRIBE_GOLD} gold lowers their hate of you by a point. They feel ${standing(hate)} (${hate}/100). You have ${mine} gold.`)),
        [50, 250, 500, 1000].filter((x) => x <= mine).map((x) => ({ label: `${x} gp (−${x / BRIBE_GOLD})`, value: x })).concat([{ label: 'Cancel', value: null }]));
      if (!r) return;
      const pts = D.bribe(me, p.id, r);
      say(`<b>${p.name}</b> take your ${r} gold. Their hate falls by ${pts}.`, 'good');
      ctl.refresh(); redraw();
    };
    return h('tr', { style: { opacity: p.alive ? 1 : 0.4 } },
      h('td', crest(p), p.name, p.human ? ' (human)' : ''),
      h('td', statusPill(st)),
      h('td', p.human ? h('span.dim', '—') : h('div', { title: `${hate} / 100` }, h('div', { style: { fontSize: '12px', color: hateColor(hate), textTransform: 'capitalize' } }, standing(hate)),
        h('div.bar', { style: { height: '5px', width: '110px' } }, h('i', { style: { width: `${hate}%`, background: hateColor(hate) } })))),
      h('td', { style: { whiteSpace: 'nowrap' } }, !p.alive ? h('span.dim', 'destroyed') : [
        st === STATUS.war ? act('☮️ Peace', propose('peace'), { disabled: !!pend, title: 'Propose peace' }) : null,
        st === STATUS.peace ? act('🤝 Alliance', propose('alliance'), { disabled: !!pend, title: 'Propose an alliance' }) : null,
        st !== STATUS.war ? act('⚔️ War', war, { title: 'Declare war' }) : null,
        act('💰 Bribe', bribe, { disabled: p.human || g.player(me).gold < BRIBE_GOLD, title: 'Send gold to soften their hate' }),
        pend ? h('span.dim', { style: { fontSize: '11.5px', marginLeft: '4px' } }, `${pend.kind} proposed`) : null,
      ]));
  });
  body.append(h('div.sub', 'How the other sides feel about you, and what you can do about it. Sides at peace may not fight; allies pass through each other\'s armies, and allies left alone share the victory.'),
    h('table.rep', h('tr', h('th', 'Side'), h('th', 'With you'), h('th', 'Their feeling'), h('th', 'Actions')), rows), msg);
  // everyone with everyone
  const alive = g.s.players.filter((p) => p.alive);
  if (alive.length > 2) {
    body.append(h('h3', 'Between the sides'));
    body.append(h('table.rep', { style: { fontSize: '12px' } }, h('tr', h('th', ''), alive.map((p) => h('th', { title: p.name }, crest(p)))),
      alive.map((a) => h('tr', h('td', crest(a), a.name), alive.map((b) => h('td', a === b ? '' : h('span', { title: `${a.name} — ${b.name}: ${D.status(a.id, b.id)}${a.human ? '' : `; ${a.name} feel ${standing(D.hate(a.id, b.id))}`}`, style: { color: STATUS_LOOK[D.status(a.id, b.id)][2] } }, STATUS_LOOK[D.status(a.id, b.id)][0])))))));
  }
}

/** A proposal from another side: resolves true to accept. */
export function proposalDialog(ctl, pr) {
  const g = ctl.game, from = g.player(pr.from);
  const hate = g.diplo.hate(pr.from, ctl.viewer);
  return ask(pr.kind === 'peace' ? 'An offer of peace' : 'An offer of alliance', h('div.row', { style: { gap: '14px', alignItems: 'flex-start' } },
    h('div.crest', { vars: { '--c': from.color }, style: { width: '48px', height: '56px', flex: 'none' } }),
    h('div', { style: { flex: 1, maxWidth: '420px' } },
      h('div', { style: { fontSize: '14.5px', lineHeight: 1.5 } }, pr.kind === 'peace'
        ? `Envoys of ${from.name} come under a white flag: they offer to end the war between you.`
        : `Envoys of ${from.name} propose an alliance: your armies may pass through each other's, and should you two stand alone at the end, you share the victory.`),
      h('div.dim', { style: { fontSize: '12.5px', marginTop: '6px' } }, from.human ? 'Another human player makes this offer.' : `They feel ${standing(hate)} toward you.`))),
  [{ label: pr.kind === 'peace' ? 'Make peace' : 'Swear the alliance', value: true, primary: true }, { label: 'Refuse', value: false }]);
}

/** Beaten computer sides offer to surrender: resolves true to accept. */
export function surrenderDialog(ctl, offer) {
  const g = ctl.game;
  const names = offer.sides.map((id) => g.player(id).name);
  const cities = offer.sides.reduce((n, id) => n + g.citiesOf(id).length, 0);
  const armies = offer.sides.reduce((n, id) => n + g.stacksOf(id).reduce((m, k) => m + k.units.length, 0), 0);
  return ask(offer.all ? 'Your foes surrender!' : `${names[0]} offer to surrender`, h('div', { style: { maxWidth: '480px', fontSize: '14px', lineHeight: 1.55 } },
    offer.all ? `The remaining warlords — ${names.join(', ')} — have no stomach left for war. They lay down their arms and offer you the crown of Etheria.`
      : `${names[0]} are beaten. They offer to surrender: their ${cities} ${cities === 1 ? 'city' : 'cities'} and ${armies} ${armies === 1 ? 'army' : 'armies'} would pass to you.`,
    offer.all ? h('div.good', { style: { marginTop: '8px' } }, 'Accepting wins the game.') : null),
  [{ label: offer.all ? 'Accept — claim victory' : 'Accept the surrender', value: true, primary: true }, { label: 'Fight on', value: false }]);
}

// --- stack info (other sides) --------------------------------------------------------------------------------------
export function stackInfoDialog(ctl, units, owner, title) {
  return dialog(() => [
    h('h2', title), h('div.sub', owner >= 0 ? SIDES[owner].name : 'Neutral'),
    h('div.palette', { style: { gridTemplateColumns: 'repeat(8, 64px)' } }, units.map((u) => unitCard(u, owner, ctl.portraits))),
    h('div.dim', { style: { fontSize: '12px', marginTop: '8px' } }, units.map((u) => `${unitName(u)} (${unitStats(u).str}/${unitStats(u).hits})`).join(' · ')),
  ], { dismiss: undefined });
}

export function gameOverDialog(ctl, ev) {
  const g = ctl.game;
  const w = ev.winner;
  const winners = ev.winners?.length ? ev.winners : w ? [w] : [];
  const human = winners.some((p) => g.player(p.id)?.human);
  const names = winners.map((p) => p.name).join(' and ');
  const why = {
    conquest: 'rule Etheria', allied: 'rule Etheria together, as allies', hill: `held ${g.s.hill ? g.s.cities[g.s.hill.city].name : 'Utopia'} for ${HILL_DAYS} days`,
    fortress: 'hold every capital city', surrender: 'accepted the surrender of their foes', time: `lead when time runs out — ${VICTORY[g.s.options.victory]?.name ?? ''}`,
  }[ev.reason ?? (ev.timeUp ? 'time' : 'conquest')] ?? 'rule Etheria';
  return dialog((close) => [
    h('h2', { style: { fontSize: '34px', textAlign: 'center' } }, ev.humansLost ? 'Defeat' : human ? 'Victory!' : 'The War Is Over'),
    h('div.sub', { style: { textAlign: 'center', fontSize: '15px' } }, winners.length ? `${names} ${why} on day ${g.s.round}.` : 'No side remains.'),
    h('div.buttons', { style: { justifyContent: 'center' } },
      h('button.btn', { onclick: () => close('stay') }, 'Look at the map'),
      h('button.btn.primary', { onclick: () => close('menu') }, 'Main menu')),
  ]);
}

export { stackEffects };
