"""Builds the river bridges and exports public/models/bridges.glb.

    Bridge_Wood     timber trestle for streams            nominal length 2.6
    Bridge_Stone_1  single-arch humpback bridge           nominal length 3.0
    Bridge_Stone_3  three-arch bridge with cutwaters      nominal length 4.6

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_bridges.py
    (env BAKE=0 skips the bake, PREVIEW=/path.png renders a check image)

The span runs along X and z = 0 is the water surface. The deck ends sit END_DECK
above the water; piers and abutments reach down to -1.8 so they stay buried when
the game lifts a bridge to meet high banks. The game stretches each model along X
to the crossing length (see NOMINAL in src/render/Structures.js).
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
OUT = os.path.join(ROOT, 'public', 'models', 'bridges.glb')
END_DECK = 0.3
BOTTOM = -1.8


def profile_extrude(b, mat, xs, top, bot, y0, y1):
    """Solid between y0..y1 whose XZ section is bounded by top(x) above and bot(x) below.
    Built from quad strips so concave arch profiles triangulate cleanly."""
    bm = bmesh.new()
    cols = []
    for x in xs:
        t, u = top(x), bot(x)
        cols.append([bm.verts.new(p) for p in [(x, y0, u), (x, y1, u), (x, y1, t), (x, y0, t)]])
    bm.faces.new(cols[0][::-1])
    bm.faces.new(cols[-1])
    for i in range(len(cols) - 1):
        a, c = cols[i], cols[i + 1]
        for q in range(4):
            r = (q + 1) % 4
            bm.faces.new((a[q], c[q], c[r], a[r]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return b.emit(bm, mat)


def samples(L, breaks, n=90):
    """Even samples over [-L/2, L/2] plus both sides of every break (pier faces)."""
    xs = {round(-L / 2 + L * i / n, 5) for i in range(n + 1)}
    for x in breaks:
        xs.add(round(x - 0.003, 5))
        xs.add(round(x + 0.003, 5))
    return sorted(xs)


def diamond(b, mat, hx, hy, z0, z1, x=0.0, cap=0.0):
    """Four-sided prism with its corners on the axes (pier cutwater), optional pointed cap."""
    bm = bmesh.new()
    ring = [(hx, 0), (0, hy), (-hx, 0), (0, -hy)]
    lo = [bm.verts.new((x + px, py, z0)) for px, py in ring]
    hi = [bm.verts.new((x + px, py, z1)) for px, py in ring]
    bm.faces.new(lo[::-1])
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    if cap > 0:
        apex = bm.verts.new((x, 0, z1 + cap))
        for i in range(4):
            bm.faces.new((hi[i], hi[(i + 1) % 4], apex))
    else:
        bm.faces.new(hi)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return b.emit(bm, mat)


def stone_bridge(b, rng, L, arches, crown_deck, W=0.82):
    """arches: list of (x0, x1, spring_z, crown_z) intrados spans."""
    hw = W / 2
    deck = lambda x: END_DECK + (crown_deck - END_DECK) * (1 - (2 * x / L) ** 2) ** 0.8

    def bottom(x):
        for x0, x1, zs, zc in arches:
            if x0 <= x <= x1:
                m, r = (x0 + x1) / 2, (x1 - x0) / 2
                return zs + (zc - zs) * math.sqrt(max(0.0, 1 - ((x - m) / r) ** 2))
        return BOTTOM

    breaks = [a for arch in arches for a in arch[:2]]
    xs = samples(L, breaks)
    profile_extrude(b, 'bridge_stone', xs, deck, bottom, -hw, hw)
    # cobbled roadway
    profile_extrude(b, 'cobble', xs, lambda x: deck(x) + 0.018, lambda x: deck(x) - 0.01, -hw + 0.1, hw - 0.1)
    # parapets with a coping course
    for s in (-1, 1):
        y0, y1 = (hw - 0.085, hw) if s > 0 else (-hw, -hw + 0.085)
        profile_extrude(b, 'bridge_stone', xs, lambda x: deck(x) + 0.2, lambda x: deck(x) - 0.02, y0, y1)
        yc0, yc1 = (hw - 0.1, hw + 0.012) if s > 0 else (-hw - 0.012, -hw + 0.1)
        profile_extrude(b, 'stone', xs, lambda x: deck(x) + 0.235, lambda x: deck(x) + 0.2, yc0, yc1)
    # string course under the parapet
    for y0, y1 in ((-hw - 0.018, -hw + 0.02), (hw - 0.02, hw + 0.018)):
        profile_extrude(b, 'stone_dark', xs, lambda x: deck(x) - 0.03, lambda x: deck(x) - 0.08, y0, y1)
    # voussoirs: radial arch stones standing proud of both faces
    for x0, x1, zs, zc in arches:
        m, r = (x0 + x1) / 2, (x1 - x0) / 2
        rise = zc - zs
        n = max(9, int(r * 14))
        for i in range(n):
            t0, t1 = math.pi * i / n, math.pi * (i + 1) / n
            tm = (t0 + t1) / 2
            px, pz = m - math.cos(tm) * r, zs + math.sin(tm) * rise
            # outward normal of the ellipse
            nx, nz = -math.cos(tm) / r, math.sin(tm) / max(rise, 1e-3)
            ang = math.atan2(nx, nz)
            seg = math.hypot(math.cos(t1) - math.cos(t0), (math.sin(t1) - math.sin(t0)) * rise / r) * r
            depth = 0.15 + (0.03 if i % 2 else 0.0)
            with b.frame(px, 0, pz, ry=ang):
                b.box('stone' if i % 3 else 'stone_dark', seg * 0.94, W + 0.03, depth, 0, 0, -0.01)
    # end posts
    for sx in (-1, 1):
        for sy in (-1, 1):
            x = sx * (L / 2 - 0.08)
            b.box('stone', 0.14, 0.14, 0.34, x, sy * (hw - 0.04), deck(x) - 0.05)
            b.cyl('stone', 0.05, 0.0, 0.07, 4, x, sy * (hw - 0.04), deck(x) + 0.29, rz=math.pi / 4)


def bridge_stone_1(b, rng):
    L = 3.0
    stone_bridge(b, rng, L, [(-0.95, 0.95, -0.12, 0.5)], crown_deck=0.78)


def bridge_stone_3(b, rng):
    L = 4.6
    arches = [(-1.95, -0.85, -0.1, 0.38), (-0.6, 0.6, -0.12, 0.58), (0.85, 1.95, -0.1, 0.38)]
    stone_bridge(b, rng, L, arches, crown_deck=0.86)
    hw = 0.41
    for x0, x1 in ((-0.85, -0.6), (0.6, 0.85)):
        xc, hx = (x0 + x1) / 2, (x1 - x0) / 2
        # pointed cutwaters facing up- and downstream
        diamond(b, 'bridge_stone', hx * 1.02, hw + 0.3, BOTTOM, 0.3, xc, cap=0.18)


def bridge_wood(b, rng):
    L, W = 2.6, 0.7
    hw = W / 2
    crown = 0.44
    deck = lambda x: END_DECK + (crown - END_DECK) * (1 - (2 * x / L) ** 2)
    # stone abutments at both banks
    for sx in (-1, 1):
        x = sx * (L / 2 - 0.2)
        b.box('stone_dark', 0.44, W + 0.12, END_DECK - BOTTOM - 0.06, x, 0, BOTTOM)
        b.box('stone', 0.46, W + 0.14, 0.06, x, 0, END_DECK - 0.07)
    # stringers (three beams following the camber)
    xs = [(-L / 2 + 0.3) + (L - 0.6) * i / 8 for i in range(9)]
    for y in (-hw + 0.08, 0, hw - 0.08):
        for i in range(8):
            b.beam('beam', (xs[i], y, deck(xs[i]) - 0.07), (xs[i + 1], y, deck(xs[i + 1]) - 0.07), 0.06)
    # plank deck
    n = int((L - 0.1) / 0.085)
    for i in range(n):
        x = -L / 2 + 0.05 + (i + 0.5) * (L - 0.1) / n
        dz = deck(x)
        slope = math.atan(-(crown - END_DECK) * 8 * x / L ** 2)
        b.box('planks', 0.078, W + rng.uniform(-0.03, 0.05), 0.03, x + rng.uniform(-0.004, 0.004),
              rng.uniform(-0.02, 0.02), dz - 0.035, ry=slope, rz=rng.uniform(-0.03, 0.03))
    # trestle bents in the stream
    for x in (-0.55, 0.55):
        top = deck(x) - 0.1
        for y in (-hw + 0.02, hw - 0.02):
            b.cyl('wood', 0.04, 0.035, top - BOTTOM, 7, x, y, BOTTOM)
        b.beam('beam', (x, -hw - 0.05, top), (x, hw + 0.05, top), 0.06)
        b.beam('beam', (x, -hw + 0.02, -0.05), (x, hw - 0.02, top - 0.05), 0.03)
        b.beam('beam', (x, hw - 0.02, -0.05), (x, -hw + 0.02, top - 0.05), 0.03)
        # driftwood / ice breaker in front of the upstream post
        b.beam('wood', (x, -hw - 0.35, -0.3), (x, -hw + 0.02, 0.25), 0.05)
    # railings
    posts = [-L / 2 + 0.25 + (L - 0.5) * i / 6 for i in range(7)]
    for y in (-hw + 0.02, hw - 0.02):
        for x in posts:
            b.cyl('wood', 0.022, 0.02, 0.3, 6, x, y, deck(x) - 0.03)
        for i in range(6):
            a, c = posts[i], posts[i + 1]
            b.beam('beam', (a, y, deck(a) + 0.25), (c, y, deck(c) + 0.25), 0.028)
            b.beam('beam', (a, y, deck(a) + 0.12), (c, y, deck(c) + 0.12), 0.018)


SPECS = [
    ('Bridge_Wood', bridge_wood, 51),
    ('Bridge_Stone_1', bridge_stone_1, 52),
    ('Bridge_Stone_3', bridge_stone_3, 53),
]

if __name__ == '__main__' or True:
    _bake = os.environ.get('BAKE', '1') != '0'
    _mats = materials.make(materials.SITES)
    _objs = lib.build_baked(SPECS, _mats, 'Bridges', atlas=1024, bake=_bake)
    if os.environ.get('PREVIEW'):
        lib.preview(_objs, os.environ['PREVIEW'], cols=3, cell=5.0)
    if _bake and os.environ.get('EXPORT', '1') != '0':
        lib.export_set(_objs, OUT)
