"""Builds the harbour and the ship and exports public/models/ports.glb.

    Port   stone quay with a timber pier, warehouse, treadwheel crane, cargo and a moored cog
    Ship   the cog a hero sails in while at sea

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_ports.py
    (env BAKE=0 skips the bake, PREVIEW=/path.png renders a check image,
     ONLY=Ship builds a subset, PORTS_OUT=<path> writes elsewhere)

The game's harbour is now the Meshy model (tools/blender/build_meshy_structures.py);
that script takes the ship from tools/meshy/port/ship.glb, made here with
    ONLY=Ship PORTS_OUT=tools/meshy/port/ship.glb

Port: the origin sits at sea level on the centre of the coastal tile. The land half
(+Y) is a quay whose top is at QUAY_TOP; the generator levels the ground there to
match. The pier runs out over the water toward -Y (+Z in three.js), so the game
turns the model to face the sea. Ship: bow toward -Y, waterline at z = 0.
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/Users/tomaszszkudlarek/Projects/Warlords/tools/blender'
sys.path.insert(0, HERE)
import bmesh  # noqa: E402

import lib  # noqa: E402
import materials  # noqa: E402

importlib.reload(lib)
importlib.reload(materials)

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.environ.get('PORTS_OUT') or os.path.join(ROOT, 'public', 'models', 'ports.glb')
TAU = math.tau
QUAY_TOP = 0.32
DECK = 0.22
BOTTOM = -0.7

MATS = {
    **materials.SITES,
    'plaster': materials.CASTLE['plaster'],
    'tile': materials.CASTLE['tile'],
    'hay': materials.CASTLE['hay'],
    'sail': materials._flat((0.62, 0.56, 0.44), 0.1, 6.0),
    'sail_stripe': materials._flat((0.35, 0.05, 0.04), 0.1, 6.0),
    'hull': materials._planks((0.2, 0.12, 0.06), (0.14, 0.085, 0.045), (0.04, 0.025, 0.012)),
    'rope': materials._flat((0.3, 0.23, 0.13), 0.2, 60.0),
}


def hull_mesh(b, mat, L, W, H, x=0, y=0, z=0, sheer=0.12):
    """Round-bellied hull along local Y (bow at -Y), keel at z - H, gunwale at z."""
    bm = bmesh.new()
    n, m = 14, 8
    rings = []
    for i in range(n + 1):
        t = i / n * 2 - 1  # -1 bow .. 1 stern
        half = W / 2 * (1 - abs(t) ** 2.6) ** 0.5
        top = z + sheer * t * t
        ring = []
        for k in range(m + 1):
            a = math.pi * k / m  # 0 = port gunwale, pi = starboard gunwale
            sx = math.cos(a) * max(half, 0.004)
            sz = top - H * math.sin(a) ** 0.8 * (1 - abs(t) ** 3 * 0.45)
            ring.append(bm.verts.new((x + sx, y + t * L / 2, sz)))
        rings.append(ring)
    for i in range(n):
        for k in range(m):
            bm.faces.new((rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]))
    # deck
    bm.faces.new([rings[i][0] for i in range(n + 1)] + [rings[i][m] for i in range(n, -1, -1)])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    lib._place(bm, 0, 0, 0, 0, 0, 0)
    return b.emit(bm, mat)


def cog(b, rng, x=0, y=0, rz=0.0, s=1.0, sail_set=True):
    """Small medieval cog: hull, stern castle, single mast with a striped sail."""
    with b.frame(x, y, 0, rz=rz, s=s):
        L, W = 1.5, 0.52
        hull_mesh(b, 'hull', L, W, 0.3, z=0.16)
        # wales and rails
        for side in (-1, 1):
            b.beam('beam', (side * 0.255, -0.62, 0.2), (side * 0.255, 0.62, 0.2), 0.022)
        b.box('planks', 0.42, 1.1, 0.02, 0, 0.02, 0.14)
        # stern castle
        b.box('planks', 0.46, 0.34, 0.2, 0, 0.5, 0.14)
        b.box('beam', 0.5, 0.38, 0.03, 0, 0.5, 0.34)
        for side in (-1, 1):
            for k in range(4):
                b.box('beam', 0.02, 0.02, 0.07, side * 0.23, 0.36 + k * 0.09, 0.37)
        b.box('dark', 0.1, 0.01, 0.08, 0, 0.329, 0.18)
        # bowsprit and fore platform
        b.beam('wood', (0, -0.68, 0.3), (0, -0.98, 0.42), 0.03)
        b.box('planks', 0.3, 0.2, 0.08, 0, -0.56, 0.22)
        # mast, yard and sail
        b.cyl('wood', 0.03, 0.022, 1.25, 10, 0, -0.05, 0.14)
        b.cyl('wood', 0.045, 0.045, 0.06, 10, 0, -0.05, 1.18)
        b.beam('wood', (-0.42, -0.07, 1.12), (0.42, -0.07, 1.12), 0.024)
        if sail_set:
            def sail_pt(xx, u):
                return (xx, -0.09 - 0.1 * math.sin(u * math.pi * 0.9 + 0.2) * (1 - (xx / 0.42) ** 2), 1.1 - u * 0.62)
            # five vertical cloths, alternating plain and striped
            for j in range(6):
                bm = bmesh.new()
                x0, x1 = -0.42 + j * 0.14, -0.28 + j * 0.14
                rows = [[bm.verts.new(sail_pt(xx, i / 6)) for xx in (x0, x1)] for i in range(7)]
                for i in range(6):
                    bm.faces.new((rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0]))
                bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=0.012)
                b.emit(bm, 'sail_stripe' if j in (1, 4) else 'sail')
        else:
            b.cyl('sail', 0.05, 0.05, 0.84, 8, -0.42, -0.07, 1.08, ry=math.pi / 2)
        # shrouds and stays
        for side in (-1, 1):
            for k in range(3):
                b.beam('rope', (side * 0.25, -0.2 + k * 0.18, 0.2), (0, -0.05, 1.1), 0.006)
        b.beam('rope', (0, -0.05, 1.3), (0, -0.96, 0.43), 0.006)
        b.beam('rope', (0, -0.05, 1.3), (0, 0.66, 0.35), 0.006)
        # masthead pennant, lantern at the stern
        b.flag('sail_stripe', 0.3, 0.07, 0.0, -0.05, 1.33, rz=math.pi / 2 + 0.2, pennant=True)
        b.cyl('iron', 0.02, 0.02, 0.1, 6, 0, 0.7, 0.34)
        b.cyl('glow_fire', 0.03, 0.025, 0.07, 6, 0, 0.7, 0.37)
        # cargo on deck
        b.box('wood', 0.12, 0.12, 0.1, 0.1, -0.35, 0.15, rz=0.3)
        b.cyl('wood', 0.05, 0.05, 0.12, 10, -0.1, -0.3, 0.15)


def barrel(b, x, y, z, s=1.0, lying=False):
    if lying:
        b.cyl('wood', 0.05 * s, 0.05 * s, 0.14 * s, 10, x, y, z + 0.05 * s, ry=math.pi / 2, rz=0.4)
        return
    b.cyl('wood', 0.045 * s, 0.055 * s, 0.07 * s, 10, x, y, z)
    b.cyl('wood', 0.055 * s, 0.045 * s, 0.07 * s, 10, x, y, z + 0.07 * s)
    for zz in (0.02, 0.12):
        b.cyl('iron', 0.054 * s, 0.054 * s, 0.012 * s, 10, x, y, z + zz * s)


def crate(b, x, y, z, s=0.12, rz=0.0):
    b.box('planks', s, s, s, x, y, z, rz=rz)
    for dz in (0.0, s - 0.012):
        b.box('beam', s + 0.006, s + 0.006, 0.012, x, y, z + dz, rz=rz)


def port(b, rng):
    # stone quay filling the land half of the tile, stepping down into the water
    b.box('stone_dark', 1.9, 0.12, QUAY_TOP - BOTTOM + 0.02, 0, -0.08, BOTTOM)
    b.box('bridge_stone', 1.86, 1.0, QUAY_TOP - BOTTOM, 0, 0.44, BOTTOM)
    b.box('cobble', 1.8, 0.95, 0.02, 0, 0.45, QUAY_TOP - 0.01)
    b.box('stone', 1.92, 0.1, 0.05, 0, -0.08, QUAY_TOP)
    for sx in (-1, 1):
        b.box('bridge_stone', 0.1, 1.05, QUAY_TOP - BOTTOM, sx * 0.94, 0.42, BOTTOM)
        # steps down to the water
        for k in range(4):
            b.box('stone', 0.24, 0.1, QUAY_TOP - 0.08 * k - BOTTOM, sx * 0.75, -0.18 - k * 0.1, BOTTOM)
    # bollards along the edge
    for x in (-0.55, -0.1, 0.4):
        b.cyl('stone_dark', 0.035, 0.03, 0.09, 8, x, -0.06, QUAY_TOP)
        b.cyl('stone_dark', 0.045, 0.045, 0.02, 8, x, -0.06, QUAY_TOP + 0.09)
    # timber pier out over the water
    y0, y1 = -0.13, -1.95
    for k in range(6):
        yy = y0 + (y1 - y0) * k / 5
        for sx in (-1, 1):
            b.cyl('wood', 0.035, 0.035, DECK - BOTTOM + 0.08, 8, sx * 0.22, yy, BOTTOM)
        b.beam('beam', (-0.26, yy, DECK - 0.04), (0.26, yy, DECK - 0.04), 0.04)
    for sx in (-1, 1):
        b.beam('beam', (sx * 0.22, y0, DECK - 0.02), (sx * 0.22, y1, DECK - 0.02), 0.035)
    n = 26
    for k in range(n):
        yy = y0 + (y1 - y0) * (k + 0.5) / n
        b.box('planks', 0.52 + rng.uniform(-0.02, 0.02), abs(y1 - y0) / n * 0.9, 0.022, rng.uniform(-0.01, 0.01), yy - 0.03, DECK, rz=rng.uniform(-0.03, 0.03))
    # ramp from quay down to the pier
    b.box('planks', 0.5, 0.2, 0.02, 0, -0.14, (QUAY_TOP + DECK) / 2, rx=-0.45)
    # mooring posts, rope coils, lantern at the pier head
    for yy in (-0.9, -1.9):
        for sx in (-1, 1):
            b.cyl('wood', 0.03, 0.03, 0.14, 8, sx * 0.26, yy, DECK)
    b.cyl('rope', 0.05, 0.05, 0.03, 12, 0.12, -1.6, DECK + 0.02)
    b.cyl('wood', 0.02, 0.02, 0.5, 6, -0.22, -1.9, DECK)
    b.beam('wood', (-0.22, -1.9, DECK + 0.48), (-0.12, -1.9, DECK + 0.48), 0.02)
    b.cyl('iron', 0.028, 0.028, 0.08, 6, -0.12, -1.9, DECK + 0.38)
    b.cyl('glow_fire', 0.024, 0.02, 0.06, 6, -0.12, -1.9, DECK + 0.39)
    # warehouse with a tiled roof and a loading door
    hx, hy = -0.45, 0.5
    b.box('stone', 0.84, 0.6, 0.08, hx, hy, QUAY_TOP)
    b.box('plaster', 0.8, 0.56, 0.42, hx, hy, QUAY_TOP + 0.08)
    for sx in (-1, 1):
        b.box('beam', 0.04, 0.58, 0.42, hx + sx * 0.4, hy, QUAY_TOP + 0.08)
    b.beam('beam', (hx - 0.4, hy - 0.285, QUAY_TOP + 0.3), (hx + 0.4, hy - 0.285, QUAY_TOP + 0.3), 0.03)
    for k in range(3):
        xx = hx - 0.28 + k * 0.28
        b.beam('beam', (xx, hy - 0.285, QUAY_TOP + 0.08), (xx + 0.12, hy - 0.285, QUAY_TOP + 0.3), 0.02)
    b.gable('tile', 0.96, 0.72, 0.32, hx, hy, QUAY_TOP + 0.5)
    for sx in (-1, 1):
        b.gable_wall('plaster', 0.56, 0.3, hx + sx * 0.4, hy, QUAY_TOP + 0.5, rz=math.pi / 2, depth=0.02)
    b.box('planks', 0.2, 0.02, 0.26, hx + 0.05, hy - 0.285, QUAY_TOP + 0.08)
    b.box('dark', 0.1, 0.02, 0.08, hx - 0.25, hy - 0.285, QUAY_TOP + 0.3)
    b.box('dark', 0.1, 0.02, 0.1, hx + 0.1, hy - 0.285, QUAY_TOP + 0.66 - 0.28)
    b.beam('beam', (hx + 0.1, hy - 0.29, QUAY_TOP + 0.62), (hx + 0.1, hy - 0.45, QUAY_TOP + 0.62), 0.025)
    b.cyl('stone_dark', 0.05, 0.04, 0.26, 8, hx + 0.25, hy + 0.12, QUAY_TOP + 0.62)
    # treadwheel crane at the quay edge
    cx, cy = 0.55, 0.08
    b.box('beam', 0.3, 0.3, 0.05, cx, cy, QUAY_TOP)
    b.cyl('wood', 0.04, 0.035, 0.9, 8, cx, cy, QUAY_TOP)
    b.beam('wood', (cx, cy, QUAY_TOP + 0.8), (cx, cy - 0.55, QUAY_TOP + 0.95), 0.035)
    b.beam('wood', (cx, cy, QUAY_TOP + 0.35), (cx, cy - 0.45, QUAY_TOP + 0.9), 0.025)
    b.beam('rope', (cx, cy - 0.55, QUAY_TOP + 0.95), (cx, cy - 0.55, QUAY_TOP + 0.35), 0.006)
    b.box('iron', 0.03, 0.03, 0.05, cx, cy - 0.55, QUAY_TOP + 0.32)
    for sx in (-1, 1):
        with b.frame(cx + sx * 0.12, cy + 0.2, QUAY_TOP + 0.28, rz=math.pi / 2, rx=math.pi / 2):
            b.cyl('planks', 0.25, 0.25, 0.04, 16, 0, 0, -0.02)
    b.cyl('wood', 0.03, 0.03, 0.34, 8, cx - 0.17, cy + 0.2, QUAY_TOP + 0.28, ry=math.pi / 2)
    for sx in (-1, 1):
        b.beam('beam', (cx + sx * 0.17, cy + 0.2, QUAY_TOP), (cx + sx * 0.17, cy + 0.2, QUAY_TOP + 0.3), 0.03)
    # cargo: crates, barrels, sacks
    crate(b, 0.15, 0.3, QUAY_TOP, 0.13, 0.2)
    crate(b, 0.17, 0.32, QUAY_TOP + 0.13, 0.1, 0.5)
    crate(b, 0.33, 0.45, QUAY_TOP, 0.12, -0.3)
    barrel(b, 0.05, 0.55, QUAY_TOP)
    barrel(b, -0.03, 0.66, QUAY_TOP, 0.9)
    barrel(b, 0.2, 0.7, QUAY_TOP, lying=True)
    barrel(b, 0.08, -1.3, DECK, 0.85)
    for k in range(3):
        b.rock('hay', 0.06, 0.045, 0.04, 0.72 + k * 0.08, 0.6 + (k % 2) * 0.05, QUAY_TOP + 0.03, rz=k, seed=k + 3, rough=0.1, subdiv=1)
    crate(b, 0.0, -0.8, DECK, 0.1, 0.4)
    # moored cog alongside the pier, and a rowing boat
    cog(b, rng, 0.62, -1.2, rz=0.0, s=0.95, sail_set=False)
    b.beam('rope', (0.26, -0.9, DECK + 0.12), (0.62, -0.72, 0.3), 0.006)
    with b.frame(-0.52, -1.1, 0, rz=0.15):
        hull_mesh(b, 'hull', 0.6, 0.24, 0.1, z=0.06, sheer=0.05)
        for k in range(2):
            b.box('planks', 0.22, 0.05, 0.015, 0, -0.1 + k * 0.2, 0.03)
        b.beam('wood', (-0.05, -0.15, 0.07), (-0.28, 0.1, 0.02), 0.012)


def ship(b, rng):
    cog(b, rng, 0, 0, 0.0, 1.0, sail_set=True)


SPECS = [
    ('Port', port, 81),
    ('Ship', ship, 82),
]

if __name__ == '__main__' or True:
    _bake = os.environ.get('BAKE', '1') != '0'
    _mats = materials.make(MATS)
    _only = os.environ.get('ONLY')
    _specs = [s for s in SPECS if not _only or s[0] in _only.split(',')]
    _objs = lib.build_baked(_specs, _mats, 'Ports', atlas=1024, bake=_bake, spacing=6.0)
    if os.environ.get('PREVIEW'):
        lib.preview(_objs, os.environ['PREVIEW'], cols=2, cell=3.2)
    if _bake and os.environ.get('EXPORT', '1') != '0':
        lib.export_set(_objs, OUT)
