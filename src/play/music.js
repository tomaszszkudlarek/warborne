// Music and sound effects. Music: one mood plays at a time and moods cross-fade. Tracks are the files in
// public/music/<mood>/ (listed by the `virtual:music` Vite plugin); a mood with several
// tracks picks one at random, and the background plays them one after another.
//
//   background  always, quietly (title screen too)
//   battle      from the first blow; lingers a few seconds after the battle, then fades back
//   hero        while a hero searches a ruin
//   lost        a hero of the player is slain (20 s), or the game is lost (until the player leaves)
//   win         the player has won (until the player leaves)
// Sound effects are the files in public/sounds/<group>/ named in SFX (battle, castle, movement,
// ambience, magic, events); marching and sailing loop while armies move (loop(name, on)), rain
// and snow follow the weather (ambience(name, gain)), the others play once (sfx(name)).
import TRACKS from 'virtual:music';

const LEVEL = { background: 0.2, hero: 0.5, battle: 0.6, lost: 0.6, win: 0.7 };
const IN_GAME_BACKGROUND = 0.5; // the background a bit quieter while playing than on the title screen
const sound = (f) => `${import.meta.env.BASE_URL}sounds/${f.split('/').map(encodeURIComponent).join('/')}`;
const SFX = {
  battle: { url: sound('battle/battle-start.wav'), level: 0.8 }, // a battle begins
  fight: { url: sound('battle/units-fighting.mp3'), level: 0.45 }, // two units duel in a battle
  lost: { url: sound('battle/unit-lost.mp3'), level: 0.6 }, // a unit falls in a battle
  captured: { url: sound('castle/castle-captured.mp3'), level: 0.7 }, // the player takes a castle
  castleLost: { url: sound('castle/castle-lost.mp3'), level: 0.7 }, // a foe takes a castle of the player's
  march: { url: sound('movement/marching.mp3'), level: 0.105 }, // loops while armies march (user: 25% quieter)
  snowmarch: { url: sound('movement/footsteps-snow.mp3'), level: 0.28 }, // instead of march over snow
  sail: { url: sound('movement/sailing.mp3'), level: 0.3 }, // loops while ships sail
  rain: { url: sound('ambience/rain.mp3'), level: 0.5 }, // ambience while it rains (user: kept low)
  snow: { url: sound('ambience/snow.mp3'), level: 0.2 }, // ambience while it snows
  thunder1: { url: sound('ambience/thunder1.mp3'), level: 0.6 }, // a lightning strike (thunder() picks one)
  thunder2: { url: sound('ambience/thunder2.mp3'), level: 0.6 },
  bless: { url: sound('magic/blessing.mp3'), level: 0.6 }, // the player's armies are blessed
  cast: { url: sound('magic/cast-spell.mp3'), level: 0.6 },
  turn: { url: sound('events/new-turn.mp3'), level: 0.5 },
  ruin: { url: sound('events/ruin-open.mp3'), level: 0.8 }, // a hero enters a ruin
};
const BATTLE_LINGER = 4; // seconds the battle music stays after a battle
const SLAIN_SECONDS = 20; // user: 10 s more than it was

const pick = (list, not) => {
  const pool = list.length > 1 ? list.filter((u) => u !== not) : list;
  return pool[Math.floor(Math.random() * pool.length)];
};

class Music {
  constructor() {
    this.volume = 1; // the player's settings, 0..1
    this.sfxVolume = 1;
    this.inGame = false;
    this.tracks = []; // { el, mood, gain, target, speed }
    this.cur = null;
    this.final = false; // win / lost of the whole game: stays until reset()
    this._back = 0;
    this._last = {};
    this._sfx = {};
    this._loops = {}; // name -> { el, users }
    this._amb = {}; // name -> { el, gain }
    this._timer = setInterval(() => this._tick(0.05), 50);
    // browsers start sound only after the player has touched the page
    const unlock = () => { if (this.blocked) { this.blocked = false; for (const t of this.tracks) if (t.target > 0) this._start(t.el); } };
    addEventListener('pointerdown', unlock, true);
    addEventListener('keydown', unlock, true);
  }

  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this._tick(0); }

  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    for (const [k, l] of Object.entries(this._loops)) l.el.volume = SFX[k].level * this.sfxVolume;
    for (const [k, a] of Object.entries(this._amb)) a.el.volume = SFX[k].level * a.gain * this.sfxVolume;
  }

  /** Cross-fades to `mood` over `fade` seconds (a mood without tracks falls back to the background). */
  play(mood, fade = 2, next = false) {
    if (this.final) return;
    clearTimeout(this._back);
    if (!next && this.cur?.mood === mood) { this.cur.target = 1; this.cur.speed = 1 / fade; return; }
    const list = TRACKS[mood] ?? [];
    if (!list.length) { if (mood !== 'background') this.play('background', fade); return; }
    if (this.cur) { this.cur.target = 0; this.cur.speed = 1 / fade; }
    const url = pick(list, this._last[mood]);
    this._last[mood] = url;
    const el = new Audio(url);
    el.loop = mood !== 'background' || list.length === 1;
    el.volume = 0;
    const t = { el, mood, gain: 0, target: 1, speed: 1 / fade };
    // the background moves on to another of its tracks as one ends
    if (!el.loop) el.addEventListener('ended', () => { if (this.cur === t) this.play('background', 1.5, true); });
    this.tracks.push(t);
    this.cur = t;
    this._start(el);
  }

  /** Back to the background after `delay` seconds, fading over `fade`. */
  back(delay = 0, fade = 4) {
    clearTimeout(this._back);
    this._back = setTimeout(() => this.play('background', fade), delay * 1000);
  }

  background() { this.play('background', 3); }

  battle() {
    this.play('battle', 1.2);
    this.sfx('battle');
  }

  battleOver() { if (this.cur?.mood === 'battle') this.back(BATTLE_LINGER, 5); }

  hero() { this.play('hero', 2); }

  heroDone() { if (this.cur?.mood === 'hero') this.back(1.5, 4); }

  heroSlain() {
    this.play('lost', 1.5);
    if (!this.final) this.back(SLAIN_SECONDS, 4);
  }

  /** The game is decided: 'win' or 'lost' plays until the player leaves the game (reset). */
  gameOver(won) {
    this.play(won ? 'win' : 'lost', 2);
    this.final = true;
  }

  /** A game starts (or a saved one is resumed): a fresh background song, a little quieter. */
  newGame() {
    this.final = false;
    this.inGame = true;
    this.play('background', 2, true);
  }

  /** Leaving a game: back to the title screen's background. */
  reset() {
    this.final = false;
    this.inGame = false;
    this.background();
  }

  /** Plays a sound effect once (restarting it if it is still playing). */
  sfx(name) {
    const s = SFX[name];
    if (!s) return;
    const el = (this._sfx[name] ??= new Audio(s.url));
    el.volume = s.level * this.sfxVolume;
    el.currentTime = 0;
    el.play().catch(() => {});
  }

  /** Thunder after a lightning strike: a random clap, a moment later; claps may overlap but the
   * same one never restarts while it still rolls. */
  thunder() {
    const free = ['thunder1', 'thunder2'].filter((n) => !this._sfx[n] || this._sfx[n].paused || this._sfx[n].ended);
    if (!free.length) return;
    const name = free[Math.floor(Math.random() * free.length)];
    setTimeout(() => this.sfx(name), 250 + Math.random() * 1200);
  }

  stopSfx(name) { this._sfx[name]?.pause(); }

  /** Starts (on) or releases (off) a looping effect; it plays while anyone holds it. */
  loop(name, on) {
    const s = SFX[name];
    if (!s) return;
    const l = (this._loops[name] ??= { el: Object.assign(new Audio(s.url), { loop: true }), users: 0 });
    l.users = Math.max(0, l.users + (on ? 1 : -1));
    if (l.users && l.el.paused) {
      l.el.volume = s.level * this.sfxVolume;
      l.el.currentTime = 0;
      l.el.play().catch(() => {});
    } else if (!l.users) l.el.pause();
  }

  /** A looping ambience at `gain` (0..1, e.g. how hard it rains); silent and paused at 0. */
  ambience(name, gain) {
    const s = SFX[name];
    if (!s) return;
    gain = Math.max(0, Math.min(1, gain));
    const a = this._amb[name];
    if (!a && gain < 0.01) return;
    const amb = (this._amb[name] ??= { el: Object.assign(new Audio(s.url), { loop: true }), gain: 0 });
    if (Math.abs(amb.gain - gain) < 0.005 && (gain < 0.01) === amb.el.paused) return;
    amb.gain = gain;
    amb.el.volume = s.level * gain * this.sfxVolume;
    if (gain < 0.01) amb.el.pause();
    else if (amb.el.paused) amb.el.play().catch(() => {});
  }

  _start(el) {
    el.play().catch(() => { this.blocked = true; });
  }

  _tick(dt) {
    for (const t of this.tracks) {
      const d = t.target - t.gain;
      t.gain += Math.sign(d) * Math.min(Math.abs(d), t.speed * dt);
      const level = LEVEL[t.mood] * (t.mood === 'background' && this.inGame ? IN_GAME_BACKGROUND : 1);
      t.el.volume = Math.max(0, Math.min(1, t.gain * level * this.volume));
      if (t.target === 0 && t.gain === 0) { t.el.pause(); t.el.removeAttribute('src'); t.el.load(); t.dead = true; }
    }
    if (this.tracks.some((t) => t.dead)) this.tracks = this.tracks.filter((t) => !t.dead);
  }
}

export const music = new Music();
