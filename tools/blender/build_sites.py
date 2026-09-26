"""Builds the map sites (ruins and shrines) and exports public/models/sites.glb.

Ruins (explored by heroes, guarded, hold treasure):
    Ruin_Tower    Ruined Tower   – broken round keep with a breached wall
    Ruin_Cave     Cave           – rock outcrop with a timbered mouth and a torch
    Ruin_Dungeon  Dungeon        – barrow mound with a stone portal and green braziers
    Ruin_Temple   Fallen Temple  – marble stylobate with toppled columns
    Ruin_Crypt    Haunted Crypt  – mausoleum in an overgrown graveyard
Shrines (bless armies that visit):
    Shrine_Circle   Stone Circle     – standing stones around a rune altar and floating crystal
    Shrine_Temple   Temple of Light  – domed marble rotunda with a golden idol
    Shrine_Obelisk  Rune Obelisk     – black obelisk with violet runes and crystal pylons

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_sites.py
    (env BAKE=0 skips the bake, PREVIEW=/path.png renders a check image)

One site fills one map tile (2 x 2 units); models stay inside a ~0.95 radius.
The entrance faces -Y (+Z in three.js). Materials named glow_* become the
`*_Glow` material, which the game renders emissive with a slow pulse.
"""
import importlib
import math
import os
import sys

import bmesh

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/Users/tomaszszkudlarek/Projects/Warlords/tools/blender'
sys.path.insert(0, HERE)
import lib  # noqa: E402
import materials  # noqa: E402

importlib.reload(lib)
importlib.reload(materials)

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'public', 'models', 'sites.glb')
TAU = math.tau

# --- shared pieces ------------------------------------------------------------------------------


def dome(b, mat, r, x=0, y=0, z=0, h=None, seg=16, rings=6):
    """Hemispherical dome (optionally squashed to height h) sitting on z."""
    h = h or r
    bm = bmesh.new()
    ring_v = []
    for i in range(rings):
        t = i / rings * math.pi / 2
        rr, zz = math.cos(t) * r, math.sin(t) * h
        ring_v.append([bm.verts.new((math.cos(a) * rr, math.sin(a) * rr, zz)) for a in (k / seg * TAU for k in range(seg))])
    top = bm.verts.new((0, 0, h))
    for i in range(rings - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            bm.faces.new((ring_v[i][k], ring_v[i][k2], ring_v[i + 1][k2], ring_v[i + 1][k]))
    for k in range(seg):
        bm.faces.new((ring_v[-1][k], ring_v[-1][(k + 1) % seg], top))
    bm.faces.new(ring_v[0][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    lib._place(bm, x, y, z, 0, 0, 0)
    return b.emit(bm, mat)


def crystal(b, mat, r, h, x=0, y=0, z=0, rz=0.0, rx=0.0):
    """Six-sided bipyramid crystal standing on z."""
    with b.frame(x, y, z, rz=rz, rx=rx):
        b.cyl(mat, 0.0 + 1e-4, r, h * 0.3, 6)
        b.cyl(mat, r, 0.0, h * 0.7, 6, z=h * 0.3)


def column(b, mat, r, h, x, y, z=0.0, capital=True, broken=0.0, rng=None):
    """Column with base and capital. broken > 0 shortens it and leaves a slanted break."""
    b.box(mat, r * 2.5, r * 2.5, 0.04, x, y, z)
    b.cyl(mat, r * 1.15, r * 1.05, 0.035, 12, x, y, z + 0.04)
    if broken > 0:
        hh = h * broken
        b.cyl(mat, r, r * 0.92, hh, 12, x, y, z + 0.07)
        # jagged cap: a tilted short drum
        tilt = rng.uniform(0.25, 0.5) if rng else 0.35
        b.cyl(mat, r * 0.9, r * 0.85, 0.05, 12, x, y, z + 0.06 + hh, rx=tilt, rz=rng.uniform(0, TAU) if rng else 0)
        return z + 0.07 + hh
    b.cyl(mat, r, r * 0.85, h, 12, x, y, z + 0.07)
    if capital:
        b.cyl(mat, r * 0.9, r * 1.3, 0.04, 12, x, y, z + 0.07 + h)
        b.box(mat, r * 2.7, r * 2.7, 0.04, x, y, z + 0.11 + h)
    return z + 0.15 + h


def brazier(b, glow, x, y, z=0.0, h=0.28, flame=0.12):
    b.cyl('iron', 0.012, 0.012, h, 6, x, y, z)
    for k in range(3):
        a = k / 3 * TAU
        b.beam('iron', (x + math.cos(a) * 0.06, y + math.sin(a) * 0.06, z), (x, y, z + h * 0.45), 0.012)
    b.cyl('iron', 0.025, 0.06, 0.05, 10, x, y, z + h)
    b.cyl(glow, 0.05, 0.0, flame, 7, x, y, z + h + 0.035)
    b.cyl(glow, 0.03, 0.0, flame * 0.7, 5, x + 0.015, y - 0.01, z + h + 0.05, rz=0.5)


def skull(b, x, y, z, s=0.035, rz=0.0):
    with b.frame(x, y, z, rz=rz):
        b.rock('bone', s, s * 1.15, s * 0.95, 0, 0, s * 0.8, rough=0.05, subdiv=2, flat_bottom=True)
        for sx in (-1, 1):
            b.box('dark', s * 0.45, s * 0.3, s * 0.4, sx * s * 0.42, -s * 0.95, s * 0.75)


def dead_tree(b, rng, x, y, h=0.7):
    b.cyl('wood', 0.035, 0.02, h, 6, x, y, -0.05)
    for k in range(4):
        z0 = h * rng.uniform(0.4, 0.85)
        a = rng.uniform(0, TAU)
        L = rng.uniform(0.15, 0.3)
        b.beam('wood', (x, y, z0), (x + math.cos(a) * L, y + math.sin(a) * L, z0 + L * 0.7), 0.018)


def ground_rocks(b, rng, count, rmin=0.55, rmax=0.95, size=(0.05, 0.12), mat='rock'):
    for i in range(count):
        a = rng.uniform(0, TAU)
        d = rng.uniform(rmin, rmax)
        s = rng.uniform(*size)
        b.rock(mat, s * rng.uniform(1, 1.5), s, s * 0.7, math.cos(a) * d, math.sin(a) * d, 0.0, rz=rng.uniform(0, TAU), seed=rng.random() * 50)


# --- ruins ----------------------------------------------------------------------------------------


def ruin_tower(b, rng):
    b.cyl('ruin_dark', 0.56, 0.5, 0.42, 18, z=-0.32)
    b.cyl('dark', 0.38, 0.38, 0.02, 14, z=0.1)
    heights = [1.78, 1.62, 1.7, 1.48, 1.22, 0.92, 0.55, 0.28, 0.0, 0.0, 0.2, 0.62, 1.05, 1.42, 1.64, 1.8]
    heights = [h + rng.uniform(-0.07, 0.07) if h > 0 else 0 for h in heights]
    a0 = -math.pi / 2 - 8.5 / 16 * TAU + 0.25  # breach faces the front-right
    with b.frame(0, 0, 0.1):
        b.ring_wall('ruin', 0.47, 0.11, heights, a0=a0)
        # string course and a ring of corbels near the top of the tall side
        b.ring_wall('ruin_dark', 0.49, 0.14, [0.05 if h > 0.8 else 0 for h in heights], z=0.72, a0=a0)
        b.ring_wall('ruin_dark', 0.5, 0.15, [0.06 if h > 1.45 else 0 for h in heights], z=1.38, a0=a0)
        for i, h in enumerate(heights):
            a = a0 + (i + 0.5) / 16 * TAU
            if h > 1.1 and i % 3 == 0:
                b.box('dark', 0.04, 0.03, 0.14, math.cos(a) * 0.47, math.sin(a) * 0.47, 0.95, rz=a + math.pi / 2)
            if h > 0.6 and i % 4 == 1:
                b.box('dark', 0.035, 0.03, 0.1, math.cos(a) * 0.47, math.sin(a) * 0.47, 0.38, rz=a + math.pi / 2)
        # doorway on the left flank
        a = math.pi + 0.35
        b.box('dark', 0.16, 0.05, 0.3, math.cos(a) * 0.46, math.sin(a) * 0.46, 0.0, rz=a + math.pi / 2)
        b.box('ruin_dark', 0.24, 0.07, 0.05, math.cos(a) * 0.47, math.sin(a) * 0.47, 0.3, rz=a + math.pi / 2)
        # charred floor joists still spanning the tall half
        for k, (v, zz, drop) in enumerate([(0.24, 0.92, 0.0), (0.08, 0.9, 0.0), (-0.08, 0.88, 0.32)]):
            b.beam('beam', (-0.34, v, zz), (0.3 - drop, v - drop * 0.3, zz - drop * 0.9), 0.035)
    # stub of the curtain wall running off to the back-left
    b.ragged_wall('ruin', 0.75, 0.15, [0.95, 0.88, 0.7, 0.72, 0.45, 0.4, 0.18, 0.05], x=-0.52, y=0.52, z=0.0, rz=math.radians(135))
    b.box('ruin_dark', 0.8, 0.2, 0.12, -0.52, 0.52, -0.05, rz=math.radians(135))
    # collapse spilling out of the breach
    b.rubble('ruin', rng, 0.32, -0.42, 0.35, 26, 0.07, z=0.02)
    b.rubble('ruin', rng, 0.1, -0.05, 0.2, 10, 0.06, z=0.12)
    for (x, y, rz, rx) in [(0.6, -0.35, 0.4, 0.1), (0.45, -0.72, 1.3, -0.15), (0.1, -0.7, 2.2, 0.2)]:
        b.box('ruin', 0.2, 0.12, 0.1, x, y, -0.02, rz=rz, rx=rx)
    b.box('ruin', 0.4, 0.14, 0.14, 0.72, -0.05, -0.03, rz=1.2, ry=0.12)  # fallen wall slab
    ground_rocks(b, rng, 6)


def ruin_cave(b, rng):
    # the hill: layered boulders around a dark mouth facing -Y
    b.rock('rock', 0.9, 0.62, 0.8, 0.0, 0.28, 0.08, seed=1, rough=0.2)
    b.rock('rock', 0.55, 0.45, 0.62, -0.52, 0.02, 0.05, rz=0.4, seed=2, rough=0.24)
    b.rock('rock', 0.5, 0.42, 0.55, 0.55, 0.0, 0.03, rz=-0.5, seed=3, rough=0.24)
    b.rock('rock', 0.42, 0.3, 0.3, 0.1, 0.35, 0.72, rz=0.2, seed=4, rough=0.25)
    b.rock('rock', 0.3, 0.26, 0.26, -0.3, 0.45, 0.72, rz=1.1, seed=5)
    b.rock('rock', 0.36, 0.3, 0.22, 0.45, 0.4, 0.55, rz=0.7, seed=6)
    # mouth: dark void recessed under an overhang
    b.rock('dark', 0.3, 0.2, 0.36, 0.0, -0.3, 0.12, seed=7, rough=0.08)
    b.rock('rock', 0.42, 0.22, 0.13, 0.0, -0.36, 0.52, rz=0.1, seed=8, rough=0.2)
    b.rock('rock', 0.2, 0.2, 0.34, -0.32, -0.38, 0.1, seed=9)
    b.rock('rock', 0.2, 0.18, 0.3, 0.33, -0.4, 0.08, seed=10)
    # mine timbering
    for sx in (-1, 1):
        b.cyl('wood', 0.03, 0.028, 0.46, 6, sx * 0.21, -0.48, -0.02, ry=sx * -0.06)
    b.beam('beam', (-0.28, -0.48, 0.45), (0.28, -0.48, 0.45), 0.05)
    b.beam('wood', (-0.18, -0.5, 0.44), (-0.26, -0.5, 0.3), 0.025)
    # torch on a post and a scatter of bones
    b.cyl('wood', 0.018, 0.015, 0.36, 6, 0.42, -0.62, -0.02)
    b.cyl('iron', 0.03, 0.04, 0.04, 8, 0.42, -0.62, 0.33)
    b.cyl('glow_fire', 0.035, 0.0, 0.11, 6, 0.42, -0.62, 0.36)
    skull(b, -0.25, -0.66, -0.01, rz=0.5)
    for k in range(6):
        a = rng.uniform(0, TAU)
        b.cyl('bone', 0.01, 0.008, rng.uniform(0.08, 0.14), 5, -0.2 + rng.uniform(-0.12, 0.12), -0.7 + rng.uniform(-0.08, 0.08), 0.01,
              rx=math.pi / 2, rz=a)
    # path of stones out of the cave
    for k in range(7):
        b.rock('rock_dark', 0.06, 0.05, 0.03, rng.uniform(-0.15, 0.15), -0.6 - k * 0.05, -0.005, rz=rng.uniform(0, TAU), seed=20 + k)
    ground_rocks(b, rng, 9, 0.6, 0.95, (0.06, 0.14))


def ruin_dungeon(b, rng):
    # grassy barrow mound
    b.rock('turf', 0.95, 0.72, 0.45, 0.0, 0.2, 0.0, seed=3, rough=0.1, subdiv=3)
    # stone platform, steps and portal
    b.box('ruin_dark', 0.78, 0.42, 0.2, 0, -0.42, -0.1)
    for k in range(2):
        b.box('ruin', 0.56 - k * 0.04, 0.12, 0.05, 0, -0.66 + k * 0.08, k * 0.05)
    with b.frame(0, -0.3, 0.1):
        b.box('dark', 0.34, 0.3, 0.52, 0, 0.02, 0)
        for s in (-1, 1):
            b.box('ruin_dark', 0.14, 0.18, 0.62, s * 0.24, 0, 0)
            b.box('ruin', 0.18, 0.22, 0.05, s * 0.24, 0, 0)
            b.box('ruin', 0.18, 0.22, 0.05, s * 0.24, 0, 0.6)
        b.box('ruin_dark', 0.7, 0.24, 0.14, 0, 0, 0.62)
        b.gable_wall('ruin_dark', 0.72, 0.2, 0, 0, 0.76, depth=0.2)
        skull(b, 0, -0.12, 0.62, s=0.045)
        # descending steps disappearing into the dark
        for k in range(3):
            b.box('ruin_dark', 0.32, 0.07, 0.03, 0, -0.08 + k * 0.07, 0.0 - k * 0.04)
        # rusted portcullis, half raised
        for k in range(6):
            b.box('iron', 0.012, 0.012, 0.22, -0.14 + k * 0.056, -0.12, 0.3)
        b.box('iron', 0.34, 0.012, 0.014, 0, -0.12, 0.34)
    # green witch-fire braziers flanking the stair
    for s in (-1, 1):
        brazier(b, 'glow_green', s * 0.46, -0.72, 0.0)
    # broken walls outlining a sunken forecourt
    b.ragged_wall('ruin', 0.55, 0.1, [0.3, 0.26, 0.2, 0.22, 0.1, 0.03], x=-0.62, y=-0.28, rz=math.pi / 2 + 0.1)
    b.ragged_wall('ruin', 0.5, 0.1, [0.05, 0.15, 0.24, 0.2, 0.27, 0.3], x=0.62, y=-0.3, rz=math.pi / 2 - 0.1)
    column(b, 'ruin', 0.05, 0.5, -0.72, -0.72, 0.0, broken=0.45, rng=rng)
    b.cyl('ruin', 0.05, 0.05, 0.4, 10, 0.75, -0.72, 0.05, rx=math.pi / 2, rz=0.6)  # toppled column
    b.rubble('ruin', rng, 0.55, -0.62, 0.2, 10, 0.05)
    ground_rocks(b, rng, 5, 0.75, 0.95)


def ruin_temple(b, rng):
    # three-step stylobate
    for k, (sx, sy) in enumerate([(1.6, 1.2), (1.46, 1.06), (1.32, 0.92)]):
        b.box('marble', sx, sy, 0.08 if k else 0.2, 0, 0, -0.12 + k * 0.08 if k else -0.12)
    top = 0.12
    xs = [-0.54, -0.18, 0.18, 0.54]
    cols = [(x, -0.34) for x in xs] + [(x, 0.34) for x in xs] + [(-0.54, 0.0), (0.54, 0.0)]
    # which columns still stand: back-left corner keeps its architrave
    standing = {(-0.54, 0.34), (-0.18, 0.34), (-0.54, 0.0), (-0.54, -0.34)}
    for (x, y) in cols:
        if (x, y) in standing:
            column(b, 'marble', 0.06, 0.82, x, y, top)
        elif (x, y) == (0.18, -0.34):
            continue  # this one lies on the steps
        else:
            column(b, 'marble', 0.06, 0.82, x, y, top, broken=rng.uniform(0.15, 0.6), rng=rng)
    ez = top + 0.97
    b.box('marble', 0.5, 0.16, 0.1, -0.36, 0.34, ez)
    b.box('marble', 0.16, 0.84, 0.1, -0.54, 0.0, ez)
    b.box('marble', 0.2, 0.9, 0.05, -0.54, 0.0, ez + 0.1)
    b.gable_wall('marble', 0.5, 0.18, -0.36, 0.34, ez + 0.1, depth=0.12)
    # cella wall remnants
    b.ragged_wall('ruin', 0.62, 0.08, [0.45, 0.4, 0.3, 0.32, 0.12, 0.05], x=0.05, y=0.16, z=top)
    b.ragged_wall('ruin', 0.34, 0.08, [0.4, 0.35, 0.2, 0.08], x=-0.26, y=0.0, z=top, rz=math.pi / 2)
    # the fallen column: drums scattered down the front steps
    for k, (x, y, z, rz) in enumerate([(0.2, -0.56, 0.02, 0.3), (0.32, -0.7, -0.04, 0.5), (0.47, -0.78, -0.06, 0.2)]):
        b.cyl('marble', 0.06, 0.06, 0.22, 12, x, y, z + 0.06, rx=math.pi / 2, rz=rz)
    b.box('marble', 0.17, 0.17, 0.05, 0.62, -0.6, -0.02, rz=0.7, rx=0.2)
    # headless statue on a plinth and its head in the grass
    b.box('marble', 0.16, 0.16, 0.18, 0.2, 0.08, top)
    b.cyl('marble', 0.045, 0.04, 0.2, 8, 0.2, 0.08, top + 0.18)
    b.rock('marble', 0.04, 0.04, 0.045, 0.72, 0.62, 0.02, seed=4, rough=0.05)
    b.rubble('marble', rng, 0.3, -0.1, 0.3, 12, 0.05, z=top)
    ground_rocks(b, rng, 4, 0.8, 0.95)


def ruin_crypt(b, rng):
    # mausoleum
    with b.frame(0, 0.28, 0):
        b.box('ruin_dark', 0.72, 0.56, 0.2, 0, 0, -0.14)
        b.box('ruin', 0.6, 0.46, 0.5, 0, 0, 0.06)
        b.gable('stone_dark', 0.72, 0.58, 0.24, 0, 0, 0.55, rz=math.pi / 2, thick=0.03)
        b.gable_wall('ruin', 0.58, 0.24, 0, -0.24, 0.56, depth=0.04)
        b.box('dark', 0.2, 0.03, 0.3, 0, -0.235, 0.06)
        b.box('glow_green', 0.14, 0.004, 0.22, 0, -0.249, 0.07)  # ghostly light inside
        for k in range(4):
            b.box('iron', 0.01, 0.012, 0.28, -0.075 + k * 0.05, -0.25, 0.07)
        for s in (-1, 1):
            column(b, 'ruin', 0.03, 0.36, s * 0.2, -0.29, 0.06)
        b.box('ruin_dark', 0.52, 0.1, 0.06, 0, -0.29, 0.51)
        b.cyl('glow_green', 0.03, 0.03, 0.01, 8, 0, -0.26, 0.64, rx=math.pi / 2)  # rose window
        # obelisk finial and a broken corner of the roof
        b.cyl('ruin_dark', 0.05, 0.02, 0.22, 4, 0, 0.0, 0.78, rz=math.pi / 4)
        b.rubble('stone_dark', rng, 0.35, 0.2, 0.12, 5, 0.05, z=0.0)
    # graveyard
    spots = [(-0.62, -0.1), (-0.4, -0.25), (-0.66, -0.45), (-0.38, -0.6), (0.42, -0.22), (0.66, -0.12), (0.48, -0.55), (0.72, -0.48), (0.05, -0.72), (-0.2, -0.82)]
    for k, (x, y) in enumerate(spots):
        tilt, rz = rng.uniform(-0.25, 0.25), rng.uniform(-0.3, 0.3)
        with b.frame(x, y, -0.02, rz=rz, rx=tilt):
            if k % 4 == 1:  # stone cross
                b.box('stone', 0.04, 0.035, 0.26)
                b.box('stone', 0.15, 0.035, 0.04, 0, 0, 0.16)
            else:
                b.box('stone', 0.12, 0.035, 0.13)
                b.cyl('stone', 0.06, 0.06, 0.035, 10, 0, -0.0175, 0.13, rx=math.pi / 2)
        b.rock('earth', 0.07, 0.14, 0.04, x, y - 0.17, 0.0, rz=rz, seed=k + 30, rough=0.1)
    # broken iron fence
    posts = [(-0.9, -0.95 + i * 0.2) for i in range(8)] + [(-0.9 + i * 0.2, -0.95) for i in range(1, 10)]
    for i, (x, y) in enumerate(posts):
        if i in (5, 11, 12):
            continue
        lean = rng.uniform(-0.12, 0.12)
        b.cyl('iron', 0.008, 0.008, 0.24, 5, x, y, -0.02, rx=lean)
        b.cyl('iron', 0.016, 0.0, 0.04, 4, x, y + lean * 0.24, 0.22)
    for (a, c) in [((-0.9, -0.95), (-0.9, -0.05)), ((-0.9, -0.95), (0.9, -0.95))]:
        for zz in (0.06, 0.19):
            b.beam('iron', (a[0], a[1], zz), (c[0], c[1], zz + rng.uniform(-0.03, 0.03)), 0.01)
    dead_tree(b, rng, 0.62, 0.35, 0.85)
    dead_tree(b, rng, -0.68, 0.45, 0.6)
    ground_rocks(b, rng, 4, 0.7, 0.95)


# --- shrines --------------------------------------------------------------------------------------


def shrine_circle(b, rng):
    n = 9
    R = 0.72
    stones = []
    for i in range(n):
        a = -math.pi / 2 + (i + 0.5) / n * TAU
        if i == 4:
            continue  # a gap in the ring (fallen stone below)
        h = rng.uniform(0.36, 0.5)
        x, y = math.cos(a) * R, math.sin(a) * R
        b.rock('rock', 0.1, 0.065, h, x, y, h * 0.2, rz=a + math.pi / 2, rx=rng.uniform(-0.06, 0.06), seed=i + 1, rough=0.1)
        stones.append((a, x, y, h))
        # a carved rune on the inner face
        if i % 2 == 0:
            b.box('glow_blue', 0.03, 0.01, 0.12, x * 0.9, y * 0.9, h * 0.62, rz=a + math.pi / 2)
    # trilithon lintels on two pairs of stones
    for i in (0, 5):
        (a1, x1, y1, h1), (a2, x2, y2, h2) = stones[i], stones[i + 1]
        top = max(h1, h2) * 1.18 + 0.02
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        b.rock('rock', math.hypot(x2 - x1, y2 - y1) * 0.62, 0.06, 0.05, mx, my, top, rz=math.atan2(y2 - y1, x2 - x1), seed=40 + i, rough=0.1)
    # the fallen stone
    a = -math.pi / 2 + 4.5 / n * TAU
    b.rock('rock', 0.42, 0.1, 0.07, math.cos(a) * (R + 0.1), math.sin(a) * (R + 0.1), 0.03, rz=a + 0.3, seed=50, rough=0.1)
    # altar with runes and a hovering crystal
    b.rock('rock_dark', 0.28, 0.18, 0.12, 0, 0, 0.1, seed=60, rough=0.08)
    b.box('rock_dark', 0.36, 0.22, 0.05, 0, 0, 0.18)
    for k in range(4):
        b.box('glow_blue', 0.02, 0.12, 0.012, -0.12 + k * 0.08, 0, 0.225)
    crystal(b, 'glow_blue', 0.07, 0.26, 0, 0, 0.42, rz=0.3)
    # ring of small pebbles and offerings
    for i in range(14):
        a = i / 14 * TAU
        b.rock('rock', 0.04, 0.035, 0.025, math.cos(a) * 0.4, math.sin(a) * 0.4, 0.0, seed=70 + i, rough=0.2)
    for (x, y) in [(0.25, -0.2), (-0.22, -0.24)]:
        b.cyl('bone', 0.02, 0.02, 0.05, 8, x, y, 0.0)
        b.cyl('glow_fire', 0.012, 0.0, 0.04, 5, x, y, 0.05)


def shrine_temple(b, rng):
    for k, r in enumerate((0.8, 0.72, 0.64)):
        b.cyl('marble', r, r, 0.3 if k == 0 else 0.07, 24, 0, 0, -0.2 if k == 0 else 0.03 + (k - 1) * 0.07)
    base = 0.17
    for i in range(8):
        a = (i + 0.5) / 8 * TAU
        column(b, 'marble', 0.042, 0.66, math.cos(a) * 0.52, math.sin(a) * 0.52, base)
    ez = base + 0.81
    b.cyl('marble', 0.62, 0.62, 0.1, 24, 0, 0, ez)
    b.cyl('marble', 0.64, 0.6, 0.04, 24, 0, 0, ez + 0.1)
    dome(b, 'verdigris', 0.55, 0, 0, ez + 0.14, h=0.42, seg=20)
    b.cyl('gold', 0.06, 0.04, 0.08, 10, 0, 0, ez + 0.54)
    b.cyl('gold', 0.025, 0.0, 0.2, 8, 0, 0, ez + 0.62)
    b.rock('gold', 0.035, 0.035, 0.035, 0, 0, ez + 0.64, rough=0.02, subdiv=2)
    # golden idol with raised arms
    b.cyl('marble', 0.12, 0.1, 0.14, 12, 0, 0.04, base)
    with b.frame(0, 0.04, base + 0.14):
        b.cyl('gold', 0.05, 0.035, 0.22, 10)
        b.cyl('gold', 0.07, 0.04, 0.06, 10)
        b.rock('gold', 0.035, 0.035, 0.04, 0, 0, 0.26, rough=0.02, subdiv=2)
        for s in (-1, 1):
            b.beam('gold', (s * 0.03, 0, 0.18), (s * 0.1, 0, 0.32), 0.018)
        b.cyl('glow_gold', 0.09, 0.09, 0.008, 16, 0, 0.01, 0.33, rx=math.pi / 2)  # halo
    # eternal flame in front of the idol and braziers at the stair
    b.cyl('gold', 0.04, 0.07, 0.05, 12, 0, -0.2, base)
    b.cyl('glow_gold', 0.05, 0.0, 0.14, 7, 0, -0.2, base + 0.05)
    for s in (-1, 1):
        brazier(b, 'glow_fire', s * 0.3, -0.86, 0.0, h=0.24, flame=0.1)
    # front stair
    for k in range(3):
        b.box('marble', 0.4, 0.1, 0.06 + k * 0.05, 0, -0.84 + k * 0.08, -0.02)


def shrine_obelisk(b, rng):
    b.cyl('cobble', 0.85, 0.85, 0.03, 24, 0, 0, -0.01)
    b.box('stone_dark', 0.62, 0.62, 0.22, 0, 0, -0.08)
    b.box('stone_dark', 0.46, 0.46, 0.1, 0, 0, 0.14)
    with b.frame(0, 0, 0.24, rz=math.pi / 4):
        b.cyl('rock_dark', 0.2, 0.13, 1.35, 4)
        b.cyl('gold', 0.13, 0.0, 0.2, 4, z=1.35)
    # glowing rune columns on every face
    for f in range(4):
        a = f * math.pi / 2
        c, s = math.cos(a), math.sin(a)
        for k in range(6):
            z = 0.42 + k * 0.17
            r = 0.2 - (z - 0.24) / 1.35 * 0.07
            w = 0.05 if k % 2 else 0.03
            b.box('glow_violet', w, 0.012, 0.075, c * r * 0.72, s * r * 0.72, z, rz=a + math.pi / 2)
    # crystal pylons at the corners
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        x, y = math.cos(a) * 0.62, math.sin(a) * 0.62
        b.rock('rock_dark', 0.1, 0.09, 0.08, x, y, 0.02, seed=i + 5, rough=0.2)
        crystal(b, 'glow_violet', 0.05, 0.3, x, y, 0.06, rz=a, rx=0.12)
        crystal(b, 'glow_violet', 0.03, 0.16, x + 0.05 * math.cos(a + 1), y + 0.05 * math.sin(a + 1), 0.04, rz=a, rx=-0.35)
    # chains from the plinth to the pylons
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        b.beam('iron', (math.cos(a) * 0.3, math.sin(a) * 0.3, 0.2), (math.cos(a) * 0.56, math.sin(a) * 0.56, 0.08), 0.012)
    ground_rocks(b, rng, 5, 0.86, 0.96, mat='rock_dark')


SPECS = [
    ('Ruin_Tower', ruin_tower, 61),
    ('Ruin_Cave', ruin_cave, 62),
    ('Ruin_Dungeon', ruin_dungeon, 63),
    ('Ruin_Temple', ruin_temple, 64),
    ('Ruin_Crypt', ruin_crypt, 65),
    ('Shrine_Circle', shrine_circle, 71),
    ('Shrine_Temple', shrine_temple, 72),
    ('Shrine_Obelisk', shrine_obelisk, 73),
]

if __name__ == '__main__' or True:
    _bake = os.environ.get('BAKE', '1') != '0'
    _only = os.environ.get('ONLY')
    _specs = [s for s in SPECS if not _only or s[0] in _only.split(',')]
    _mats = materials.make(materials.SITES)
    _objs = lib.build_baked(_specs, _mats, 'Sites', atlas=1024, bake=_bake)
    if os.environ.get('PREVIEW'):
        lib.preview(_objs, os.environ['PREVIEW'], cols=4, cell=2.4)
    if _bake and not _only and os.environ.get('EXPORT', '1') != '0':
        lib.export_set(_objs, OUT)
