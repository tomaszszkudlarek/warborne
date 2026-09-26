# Painted 2D art (Recraft)

The game renders unit portraits from the 3D models and uses glyphs for spells and items.
Painted art replaces them automatically: `src/play/art.js` picks up any file in

- `src/assets/art/units/<unit key or hero model key>.webp` — portraits (4:5)
- `src/assets/art/spells/<spell id>.webp`, `src/assets/art/items/<item key>.webp` — icons (1:1)
- `src/assets/art/backgrounds/battle-<plains|forest|hills|swamp|snow|volcanic|siege|ruin|sea>.webp` — battle screen

`manifest.json` (built by `node tools/recraft/build-manifest.mjs` from the game data) holds one
prompt per image, the target file and the aspect ratio, all in one shared style.

To generate: ask Claude Code (with the Recraft MCP connected and billing active) to
"generate the Recraft art from tools/recraft/manifest.json": for each entry it calls
`generate_image` (model `recraftv4_1`, `input_style: digital_illustration`, `image_size` from the
entry), downloads the result, converts it to .webp at 512 px (portraits 400×500) and saves it at
`file`. Entries whose file exists are skipped, so it can be resumed.

On 2026-09-24 every Recraft call failed with `400 invalid_billing`, so no images were generated yet.
