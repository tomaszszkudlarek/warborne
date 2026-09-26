// Inline SVG icons (no external art needed; painted icons can replace them later).
const svg = (body, vb = '0 0 24 24') => `<svg class="ico" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

export const ICON = {
  gold: svg('<defs><radialGradient id="gg" cx=".35" cy=".3"><stop offset="0" stop-color="#fff3b0"/><stop offset=".5" stop-color="#e8b64a"/><stop offset="1" stop-color="#8a5f18"/></radialGradient></defs><circle cx="12" cy="12" r="9" fill="url(#gg)" stroke="#5a3d0c" stroke-width="1.2"/><circle cx="12" cy="12" r="5.6" fill="none" stroke="#8a5f18" stroke-width="1"/><path d="M12 8.5v7M10 10h3.2a1.2 1.2 0 010 2.4h-2.4a1.2 1.2 0 000 2.4H14" fill="none" stroke="#6b470f" stroke-width="1.1"/>'),
  mana: svg('<defs><radialGradient id="mg" cx=".4" cy=".35"><stop offset="0" stop-color="#f4eaff"/><stop offset=".45" stop-color="#a98cff"/><stop offset="1" stop-color="#3b1f8a"/></radialGradient></defs><path d="M12 2l3.2 6.3L22 12l-6.8 3.7L12 22l-3.2-6.3L2 12l6.8-3.7z" fill="url(#mg)" stroke="#2a1560" stroke-width=".8"/>'),
  sword: svg('<path d="M14.5 3H21v6.5L10 20.5 7.5 18 5 20.5 3.5 19 6 16.5 3.5 14z" fill="#cfd6e0" stroke="#3a4250" stroke-width="1"/><path d="M5 13l6 6" stroke="#8a5f18" stroke-width="2"/>'),
  shield: svg('<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z" fill="#6a7fa8" stroke="#1c2436" stroke-width="1.2"/><path d="M12 5v14M7 9h10" stroke="#e0b95e" stroke-width="1.6"/>'),
  castle: svg('<path d="M3 21V9h3V6h2v3h2V6h4v3h2V6h2v3h3v12h-7v-5a2 2 0 00-4 0v5z" fill="#b8a888" stroke="#3a3020" stroke-width="1"/>'),
  sun: svg('<circle cx="12" cy="12" r="5" fill="#ffd66a"/><g stroke="#ffd66a" stroke-width="2" stroke-linecap="round"><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></g>'),
  cloud: svg('<path d="M7 18h10a4 4 0 00.5-8A6 6 0 006 9.5 4.3 4.3 0 007 18z" fill="#c9d3e0" stroke="#5a6678"/>'),
  rain: svg('<path d="M7 14h10a4 4 0 00.5-8A6 6 0 006 5.5 4.3 4.3 0 007 14z" fill="#9aa8bc" stroke="#4a5668"/><g stroke="#7ab8ff" stroke-width="1.6" stroke-linecap="round"><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/></g>'),
  storm: svg('<path d="M7 13h10a4 4 0 00.5-8A6 6 0 006 4.5 4.3 4.3 0 007 13z" fill="#6c7688" stroke="#3a4250"/><path d="M13 13l-3 5h3l-2 5 5-7h-3l2-3z" fill="#ffe26a"/>'),
  snow: svg('<path d="M7 13h10a4 4 0 00.5-8A6 6 0 006 4.5 4.3 4.3 0 007 13z" fill="#dfe8f2" stroke="#6a7a90"/><g fill="#fff"><circle cx="8" cy="18" r="1.3"/><circle cx="12" cy="20" r="1.3"/><circle cx="16" cy="17.5" r="1.3"/></g>'),
};

export const WEATHER_ICON = { Clear: ICON.sun, 'Fair clouds': ICON.cloud, Overcast: ICON.cloud, Rain: ICON.rain, Thunderstorm: ICON.storm, Snowfall: ICON.snow };

// spell glyphs for the cast dialog
export const SPELL_GLYPH = {
  strength: '💪', haste: '💨', flight: '🪽', wallofforce: '🔷', heroism: '☀', invisibility: '👁', phantomsteed: '🐎',
  terror: '💀', chaosseed: '🌀', reanimate: '🦴', wraithcall: '👻', lifesbane: '☠', fortify: '🛡', bravery: '🦁',
  mightyfeast: '🍖', dig: '⛏', augury: '🔮', jihad: '🔥', evileye: '🧿', berserker: '😡', summonimp: '😈',
  summonhound: '🐺', minordemon: '❄', greaterdemon: '👹', teleport: '✨', creategolem: '🗿', summonitem: '💎',
  mightyblow: '👊', bodycontrol: '🧘', mindcontrol: '🌀', stormsong: '⚡', songofbattle: '🎺', songoflife: '🌿',
  songofstone: '🪨', songoffortune: '🍀',
};
