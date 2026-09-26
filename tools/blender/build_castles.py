"""Builds the three castle tiers and exports public/models/castles.glb.

    Level 1  Palisade fort      – earth mound, sharpened log stockade, timber towers
    Level 2  Timber burgh       – stone footing with a covered wooden gallery, half-timbered keep
    Level 3  Stone castle       – curtain walls, round towers, gatehouse, great keep

Run headless (baking inside an interactive session can take minutes):
    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_castles.py

Units are world units (one map tile = 2). Ground is z = 0 and the castles fit
inside the 2-unit radius the generator flattens around each city. Surfaces are
baked (procedural albedo x AO) into one atlas per tier. Faction-coloured parts use
the `*_Accent` / `*_Flag` materials; three.js tints those per owner and makes
flags flutter using the `Wave` vertex colour (0 at the pole, 1 at the tip).
"""
import importlib
import math
import os
import random
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/Users/tomaszszkudlarek/Projects/Warlords/tools/blender'
sys.path.insert(0, HERE)
import lib  # noqa: E402
import materials  # noqa: E402

importlib.reload(lib)
importlib.reload(materials)
from lib import Builder, export_material  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.environ.get('CASTLES_OUT') or os.path.join(ROOT, 'public', 'models', 'castles.glb')
ATLAS = 2048
TAU = math.pi * 2

# --- materials ------------------------------------------------------------------------------


def make_materials():
    return materials.make(materials.CASTLE)


# --- reusable structures ------------------------------------------------------------------


def timber_box(b, sx, sy, h, x=0, y=0, z=0, rz=0, pitch=0.15, braces=True, t=0.022):
    """Plastered box with half-timber framing on all four faces."""
    with b.frame(x, y, z, rz):
        b.box('plaster', sx, sy, h)
        off = t / 2 - 0.002
        faces = [
            ((-sx / 2, -sy / 2 - off), (1, 0), sx),
            ((sx / 2, sy / 2 + off), (-1, 0), sx),
            ((sx / 2 + off, -sy / 2), (0, 1), sy),
            ((-sx / 2 - off, sy / 2), (0, -1), sy),
        ]
        for (ox, oy), (ax, ay), L in faces:
            P = lambda u, zz: (ox + ax * u, oy + ay * u, zz)
            b.beam('beam', P(0, t / 2), P(L, t / 2), t)
            b.beam('beam', P(0, h - t / 2), P(L, h - t / 2), t)
            b.beam('beam', P(0, h * 0.5), P(L, h * 0.5), t * 0.8)
            n = max(1, round(L / pitch))
            for i in range(n + 1):
                u = L * i / n
                b.beam('beam', P(u, 0), P(u, h), t)
            if braces and n >= 2:
                b.beam('beam', P(0, 0), P(L / n, h * 0.5), t * 0.8)
                b.beam('beam', P(L, 0), P(L - L / n, h * 0.5), t * 0.8)
                mid = n // 2
                b.beam('beam', P(L * mid / n, h * 0.5), P(L * (mid + 1) / n, h), t * 0.8)
                b.beam('beam', P(L * (mid + 1) / n, h * 0.5), P(L * mid / n, h), t * 0.8)


def windows_on(b, sx, sy, z, rz=0, x=0, y=0, count=2, w=0.05, h=0.08, faces=(0, 1, 2, 3)):
    with b.frame(x, y, 0, rz):
        for f in faces:
            L = sx if f < 2 else sy
            for i in range(count):
                u = (i + 1) / (count + 1) * L - L / 2
                if f == 0:
                    b.box('dark', w, 0.02, h, u, -sy / 2 - 0.004, z)
                elif f == 1:
                    b.box('dark', w, 0.02, h, u, sy / 2 + 0.004, z)
                elif f == 2:
                    b.box('dark', 0.02, w, h, sx / 2 + 0.004, u, z)
                else:
                    b.box('dark', 0.02, w, h, -sx / 2 - 0.004, u, z)


def pole_with_flag(b, x, y, z, pole=0.4, fw=0.3, fh=0.18, rz=0.4, pennant=False, finial=True):
    b.cyl('beam', 0.011, 0.008, pole, 6, x, y, z)
    if finial:
        b.cyl('gold', 0.018, 0.0, 0.03, 6, x, y, z + pole)
    b.flag('flag', fw, fh, x, y, z + pole - fh - 0.01, rz=rz, pennant=pennant)


def wood_tower(b, x, y, h, s, rz=0, roof='thatch', flag=True, rng=None):
    """Timber watchtower: four posts, braces, a walled platform and a pyramid roof."""
    with b.frame(x, y, 0, rz):
        hs = s / 2
        corners = [(-hs, -hs), (hs, -hs), (hs, hs), (-hs, hs)]
        for cx, cy in corners:
            b.cyl('wood', 0.024, 0.022, h, 6, cx, cy, 0)
        for i in range(4):
            (ax, ay), (bx, by) = corners[i], corners[(i + 1) % 4]
            b.beam('beam', (ax, ay, 0.05), (bx, by, h * 0.55), 0.016)
            b.beam('beam', (bx, by, 0.05), (ax, ay, h * 0.55), 0.016)
        top = h - 0.22
        b.box('planks', s + 0.08, s + 0.08, 0.03, 0, 0, top)
        for i, (ox, oy, sx_, sy_) in enumerate([(0, -hs - 0.035, s + 0.08, 0.018), (0, hs + 0.035, s + 0.08, 0.018),
                                               (hs + 0.035, 0, 0.018, s + 0.08), (-hs - 0.035, 0, 0.018, s + 0.08)]):
            b.box('planks', sx_, sy_, 0.12, ox, oy, top + 0.03)
        b.pyramid(roof, s + 0.2, s + 0.2, 0.24, 0, 0, h - 0.03)
        if flag:
            pole_with_flag(b, 0, 0, h + 0.18, pole=0.28, fw=0.2, fh=0.11, pennant=True, finial=False)


def round_tower(b, x, y, r, h, roof='accent', roof_h=None, cap='cone', slits=3, face=0.0, parapet=True):
    b.cyl('stone_dark', r * 1.12, r * 1.02, 0.5, 16, x, y, -0.4)
    b.cyl('stone', r * 1.02, r * 0.96, h - 0.1, 16, x, y, 0.1)
    for i in range(slits):
        a = face + (i - (slits - 1) / 2) * 0.9
        zz = 0.3 + (i % 2) * 0.28
        b.box('dark', 0.03, 0.02, 0.09, x + math.cos(a) * r * 0.97, y + math.sin(a) * r * 0.97, zz + h * 0.25, rz=a + math.pi / 2)
    top = h
    if parapet:
        b.corbel_ring('stone', r * 1.03, top - 0.07, count=16, s=0.035)
        b.cyl('stone', r * 1.1, r * 1.1, 0.1, 16, x, y, top - 0.02)
        with b.frame(x, y):
            b.merlon_ring('stone', r * 1.06, top + 0.08, h=0.07, t=0.05, count=10)
    if cap == 'cone':
        rh = roof_h or r * 2.3
        b.cyl(roof, r * 1.12, 0.0, rh, 16, x, y, top + 0.02)
        b.cyl('gold', 0.016, 0.0, 0.07, 6, x, y, top + 0.02 + rh - 0.01)
        return top + 0.02 + rh
    return top + 0.15


# --- level 1: palisade fort ------------------------------------------------------------------


def level1(b, rng):
    b.cyl('earth', 1.8, 1.64, 0.5, 28, z=-0.42)
    R = 1.42
    gate = -math.pi / 2
    n = 104
    for i in range(n):
        a = i / n * TAU
        da = (a - gate + math.pi) % TAU - math.pi
        if abs(da) < 0.17:
            continue
        h = 0.5 + rng.uniform(-0.06, 0.07)
        r = 0.043 + rng.uniform(-0.007, 0.006)
        x, y = math.cos(a) * R, math.sin(a) * R
        tx, ty = rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04)
        with b.frame(x, y, 0.0, rx=tx, ry=ty):
            b.cyl('wood', r, r * 0.95, h, 7, 0, 0, -0.05)
            b.cyl('wood', r * 0.95, 0.0, 0.09, 7, 0, 0, h - 0.05)
    # inner rail and walkway planks
    for i in range(36):
        a0, a1 = i / 36 * TAU, (i + 1) / 36 * TAU
        mid = (a0 + a1) / 2
        if abs((mid - gate + math.pi) % TAU - math.pi) < 0.25:
            continue
        rr = R - 0.07
        b.beam('beam', (math.cos(a0) * rr, math.sin(a0) * rr, 0.3), (math.cos(a1) * rr, math.sin(a1) * rr, 0.3), 0.022)
        b.box('planks', 0.26, 0.11, 0.02, math.cos(mid) * (R - 0.13), math.sin(mid) * (R - 0.13), 0.27, rz=mid + math.pi / 2)
    # gate towers, doors and walkway
    gx = 0.27
    for sx in (-1, 1):
        wood_tower(b, sx * gx, -R + 0.02, 0.95, 0.26, rng=rng)
        b.banner('accent', 0.12, 0.22, sx * gx, -R - 0.13, 0.7)
    b.box('planks', 0.36, 0.05, 0.42, 0, -R + 0.02, 0.05)
    b.box('beam', 0.16, 0.055, 0.42, 0, -R + 0.01, 0.05)  # darker seam between the leaves
    b.box('planks', 0.3, 0.2, 0.03, 0, -R + 0.02, 0.62)
    b.beam('beam', (-gx, -R - 0.08, 0.66), (gx, -R - 0.08, 0.66), 0.02)
    # longhouse
    with b.frame(0.1, 0.5, 0.08, rz=0.12):
        b.box('planks', 0.95, 0.44, 0.26)
        b.gable_wall('planks', 0.44, 0.3, -0.465, 0, 0.26, rz=math.pi / 2)
        b.gable_wall('planks', 0.44, 0.3, 0.465, 0, 0.26, rz=math.pi / 2)
        b.gable('thatch', 1.08, 0.66, 0.36, 0, 0, 0.23, thick=0.04)
        b.box('dark', 0.1, 0.02, 0.16, 0.1, -0.225, 0)
        b.banner('accent', 0.1, 0.16, -0.2, -0.235, 0.23)
        for sx in (-1, 1):  # crossed gable horns
            b.beam('beam', (sx * 0.55, -0.06, 0.5), (sx * 0.62, 0.06, 0.66), 0.02)
            b.beam('beam', (sx * 0.55, 0.06, 0.5), (sx * 0.62, -0.06, 0.66), 0.02)
    # round huts
    for (x, y, r) in [(-0.78, 0.0, 0.2), (0.82, -0.25, 0.18), (-0.35, -0.72, 0.16)]:
        b.cyl('planks', r, r, 0.19, 10, x, y, 0.08)
        b.cyl('thatch', r * 1.35, 0.0, r * 1.7, 10, x, y, 0.25)
        b.box('dark', 0.07, 0.02, 0.12, x, y - r, 0.08)
    # watchtower with the big banner
    wood_tower(b, -0.6, 0.72, 1.25, 0.28, rz=0.3, flag=False)
    pole_with_flag(b, -0.6, 0.72, 1.44, pole=0.5, fw=0.38, fh=0.22)
    # yard clutter: hay, crates, a fire pit, a woodpile
    for (x, y) in [(0.55, 0.05), (0.7, 0.2)]:
        b.cyl('hay', 0.1, 0.09, 0.1, 10, x, y, 0.08)
        b.cyl('hay', 0.09, 0.0, 0.08, 10, x, y, 0.18)
    for (x, y, s, rz) in [(-0.2, -0.3, 0.09, 0.3), (-0.1, -0.35, 0.07, 0.9), (0.35, -0.6, 0.08, 0.2)]:
        b.box('planks', s, s, s, x, y, 0.08, rz=rz)
    b.cyl('stone_dark', 0.09, 0.08, 0.04, 8, 0.25, -0.15, 0.08)
    b.cyl('dark', 0.06, 0.0, 0.07, 6, 0.25, -0.15, 0.1)
    for i in range(6):
        b.cyl('wood', 0.022, 0.022, 0.26, 6, 0.95, 0.35 + (i % 3) * 0.045, 0.1 + (i // 3) * 0.04, rx=math.pi / 2, rz=0.4)


# --- level 2: timber burgh -------------------------------------------------------------------


def level2(b, rng):
    b.cyl('earth', 1.95, 1.84, 0.5, 32, z=-0.42)
    H = 1.28
    corners = [(-H, -H), (H, -H), (H, H), (-H, H)]
    # walls: stone footing + covered wooden gallery
    for i in range(4):
        (ax, ay), (bx, by) = corners[i], corners[(i + 1) % 4]
        L = math.hypot(bx - ax, by - ay)
        ang = math.atan2(by - ay, bx - ax)
        mx, my = (ax + bx) / 2, (ay + by) / 2
        segs = [(-L / 2 + 0.26, -0.3), (0.3, L / 2 - 0.26)] if i == 0 else [(-L / 2 + 0.26, L / 2 - 0.26)]
        with b.frame(mx, my, 0, ang):
            for u0, u1 in segs:
                c, w = (u0 + u1) / 2, u1 - u0
                b.box('stone_dark', w, 0.2, 0.4, c, 0, -0.3)
                b.box('stone', w, 0.17, 0.3, c, 0, 0.08)
                b.box('planks', w, 0.13, 0.2, c, 0.0, 0.38)
                for k in range(int(w / 0.14)):
                    u = u0 + 0.07 + k * 0.14
                    b.box('dark', 0.04, 0.02, 0.05, u, -0.075, 0.48)
                    b.beam('beam', (u, -0.07, 0.38), (u, -0.07, 0.58), 0.018)
                b.gable('shingle', w + 0.02, 0.26, 0.09, c, 0, 0.58, thick=0.02)
    # front: stone round towers, hoarding and shingle cones
    for sx in (-1, 1):
        x, y = sx * H, -H
        b.cyl('stone_dark', 0.3, 0.28, 0.5, 14, x, y, -0.4)
        b.cyl('stone', 0.27, 0.25, 0.72, 14, x, y, 0.1)
        b.cyl('planks', 0.3, 0.3, 0.2, 14, x, y, 0.8)
        for k in range(8):
            a = k / 8 * TAU
            b.box('dark', 0.04, 0.02, 0.06, x + math.cos(a) * 0.305, y + math.sin(a) * 0.305, 0.88, rz=a + math.pi / 2)
        b.corbel_ring('beam', 0.285, 0.74, count=12, s=0.03)
        b.cyl('shingle', 0.38, 0.0, 0.55, 14, x, y, 0.98)
        pole_with_flag(b, x, y, 1.5, pole=0.3, fw=0.22, fh=0.12, pennant=True)
        b.box('dark', 0.03, 0.02, 0.1, x + sx * 0.0, y - 0.255, 0.4)
    # back: half-timbered square towers
    for sx in (-1, 1):
        x, y = sx * H, H
        b.box('stone_dark', 0.5, 0.5, 0.5, x, y, -0.4)
        b.box('stone', 0.46, 0.46, 0.5, x, y, 0.1)
        timber_box(b, 0.52, 0.52, 0.34, x, y, 0.6, pitch=0.13)
        windows_on(b, 0.52, 0.52, 0.72, x=x, y=y, count=1, w=0.06, h=0.1)
        b.pyramid('tile', 0.66, 0.66, 0.48, x, y, 0.94)
        pole_with_flag(b, x, y, 1.38, pole=0.3, fw=0.22, fh=0.12, pennant=True)
    # gatehouse
    with b.frame(0, -H, 0):
        b.box('stone_dark', 0.66, 0.44, 0.5, 0, 0, -0.4)
        b.box('stone', 0.62, 0.4, 0.5, 0, 0, 0.1)
        b.box('dark', 0.24, 0.03, 0.34, 0, -0.2, 0.1)
        b.cyl('dark', 0.12, 0.12, 0.03, 12, 0, -0.2, 0.44, rx=math.pi / 2)
        for k in range(5):
            b.box('iron', 0.012, 0.035, 0.3, -0.1 + k * 0.05, -0.21, 0.12)
        timber_box(b, 0.7, 0.46, 0.3, 0, 0, 0.6, pitch=0.14)
        windows_on(b, 0.7, 0.46, 0.7, count=2, faces=(0, 1))
        b.gable('tile', 0.8, 0.56, 0.34, 0, 0, 0.9, thick=0.025)
        b.gable_wall('plaster', 0.46, 0.3, -0.35, 0, 0.9, rz=math.pi / 2)
        b.gable_wall('plaster', 0.46, 0.3, 0.35, 0, 0.9, rz=math.pi / 2)
        for sx in (-1, 1):
            b.banner('accent', 0.12, 0.3, sx * 0.22, -0.215, 0.56)
    # keep: stone ground floor, two jettied timber storeys, steep tiled roof
    with b.frame(0.05, 0.3, 0, 0.0):
        b.box('stone_dark', 0.86, 0.76, 0.5, 0, 0, -0.4)
        b.box('stone', 0.82, 0.72, 0.52, 0, 0, 0.1)
        b.box('dark', 0.14, 0.02, 0.22, 0, -0.365, 0.1)
        windows_on(b, 0.82, 0.72, 0.36, count=2, w=0.035, h=0.08)
        timber_box(b, 0.9, 0.8, 0.36, 0, 0, 0.62, pitch=0.15)
        windows_on(b, 0.9, 0.8, 0.74, count=3, w=0.06, h=0.1)
        timber_box(b, 0.96, 0.86, 0.32, 0, 0, 0.98, pitch=0.16)
        windows_on(b, 0.96, 0.86, 1.08, count=3, w=0.06, h=0.09)
        b.gable('tile', 1.08, 1.02, 0.62, 0, 0, 1.28, thick=0.03)
        b.gable_wall('plaster', 0.86, 0.56, -0.48, 0, 1.3, rz=math.pi / 2)
        b.gable_wall('plaster', 0.86, 0.56, 0.48, 0, 1.3, rz=math.pi / 2)
        b.box('dark', 0.02, 0.07, 0.12, -0.495, 0, 1.4)
        b.box('dark', 0.02, 0.07, 0.12, 0.495, 0, 1.4)
        b.box('stone', 0.12, 0.12, 0.5, 0.28, 0.22, 1.35)
        # dormer
        with b.frame(-0.1, -0.3, 1.36):
            b.box('plaster', 0.16, 0.14, 0.12)
            b.box('dark', 0.07, 0.02, 0.08, 0, -0.075, 0.02)
            b.gable('tile', 0.16, 0.2, 0.1, 0, -0.01, 0.12, rz=math.pi / 2, thick=0.015)
        for sx in (-1, 1):
            b.banner('accent', 0.14, 0.36, sx * 0.25, -0.44, 0.94)
        pole_with_flag(b, 0.0, 0.0, 1.88, pole=0.5, fw=0.42, fh=0.24)
    # houses
    for (x, y, rz, roof) in [(-0.72, -0.45, 0.1, 'thatch'), (0.78, -0.35, -0.15, 'tile'), (-0.85, 0.45, 1.5, 'tile')]:
        with b.frame(x, y, 0.08, rz):
            timber_box(b, 0.44, 0.3, 0.26, pitch=0.12, braces=False)
            b.gable_wall('plaster', 0.3, 0.2, -0.22, 0, 0.26, rz=math.pi / 2)
            b.gable_wall('plaster', 0.3, 0.2, 0.22, 0, 0.26, rz=math.pi / 2)
            b.gable(roof, 0.52, 0.42, 0.24, 0, 0, 0.24, thick=0.025)
            b.box('dark', 0.06, 0.02, 0.12, 0.08, -0.155, 0)
    # well and market stall
    b.cyl('stone', 0.08, 0.08, 0.08, 10, 0.55, -0.9 + 0.2, 0.08)
    b.cyl('dark', 0.06, 0.06, 0.005, 10, 0.55, -0.7, 0.16)
    with b.frame(-0.25, -0.62, 0.08, 0.2):
        b.box('planks', 0.22, 0.12, 0.08)
        for sx in (-1, 1):
            b.beam('beam', (sx * 0.1, 0.05, 0), (sx * 0.1, 0.05, 0.2), 0.015)
            b.beam('beam', (sx * 0.1, -0.05, 0), (sx * 0.1, -0.05, 0.16), 0.015)
        b.box('accent', 0.26, 0.16, 0.012, 0, -0.0, 0.17, rx=0.25)


# --- level 3: stone castle -------------------------------------------------------------------


def level3(b, rng):
    b.cyl('stone_dark', 2.02, 1.94, 0.55, 32, z=-0.45)
    b.cyl('cobble', 1.9, 1.9, 0.02, 32, z=0.1)
    H = 1.22
    corners = [(-H, -H), (H, -H), (H, H), (-H, H)]
    wall_h = 0.8
    for i in range(4):
        (ax, ay), (bx, by) = corners[i], corners[(i + 1) % 4]
        L = math.hypot(bx - ax, by - ay)
        ang = math.atan2(by - ay, bx - ax)
        mx, my = (ax + bx) / 2, (ay + by) / 2
        with b.frame(mx, my, 0, ang):
            if i == 0:
                spans = [(-L / 2, -0.3), (0.3, L / 2)]
            else:
                spans = [(-L / 2, L / 2)]
            for u0, u1 in spans:
                c, w = (u0 + u1) / 2, u1 - u0
                b.box('stone', w, 0.22, wall_h, c, 0, 0.1)
                b.box('stone_dark', w, 0.26, 0.12, c, 0, 0.1)  # battered plinth
                b.merlons('stone', (u0 + 0.28, -0.085), (u1 - 0.28, -0.085), wall_h + 0.1, h=0.09, t=0.05, pitch=0.13)
                b.merlons('stone', (u0 + 0.28, 0.085), (u1 - 0.28, 0.085), wall_h + 0.1, h=0.05, t=0.04, pitch=0.2)
                for k in range(max(1, int(w / 0.5))):
                    u = u0 + (k + 0.5) * w / max(1, int(w / 0.5))
                    b.box('dark', 0.025, 0.02, 0.08, u, -0.115, 0.5)
            if i in (1, 2, 3):
                b.banner('accent', 0.16, 0.42, 0, -0.12, wall_h + 0.05)
                b.box('beam', 0.2, 0.02, 0.02, 0, -0.125, wall_h + 0.04)
    for (x, y) in corners:
        face = math.atan2(y, x)
        top = round_tower(b, x, y, 0.3, 1.25, roof='accent', slits=3, face=face)
        pole_with_flag(b, x, y, top - 0.02, pole=0.3, fw=0.24, fh=0.13, pennant=True, finial=False)
    # gatehouse with twin drum towers, portcullis and drawbridge
    with b.frame(0, -H, 0):
        b.box('stone', 0.56, 0.5, 1.02, 0, 0, 0.1)
        b.merlons('stone', (-0.28, -0.22), (0.28, -0.22), 1.12, h=0.09, t=0.05, pitch=0.12)
        b.merlons('stone', (-0.28, 0.22), (0.28, 0.22), 1.12, h=0.06, t=0.05, pitch=0.18)
        b.box('dark', 0.24, 0.03, 0.4, 0, -0.25, 0.1)
        b.cyl('dark', 0.12, 0.12, 0.03, 14, 0, -0.25, 0.5, rx=math.pi / 2)
        for k in range(5):
            b.box('iron', 0.014, 0.02, 0.44, -0.1 + k * 0.05, -0.268, 0.1)
        for k in range(4):
            b.box('iron', 0.24, 0.02, 0.012, 0, -0.27, 0.16 + k * 0.1)
        b.box('planks', 0.26, 0.42, 0.03, 0, -0.44, 0.07)
        b.beam('iron', (-0.12, -0.25, 0.5), (-0.12, -0.6, 0.1), 0.008)
        b.beam('iron', (0.12, -0.25, 0.5), (0.12, -0.6, 0.1), 0.008)
        b.banner('accent', 0.2, 0.3, 0, -0.26, 1.0, notch=False)
        for sx in (-1, 1):
            top = round_tower(b, sx * 0.34, -0.12, 0.2, 1.12, roof='accent', slits=2, face=-math.pi / 2)
            pole_with_flag(b, sx * 0.34, -0.12, top - 0.02, pole=0.25, fw=0.2, fh=0.11, pennant=True, finial=False)
    # great keep with corner turrets
    with b.frame(0.1, 0.32, 0):
        K, kh = 0.96, 1.85
        b.box('stone_dark', K + 0.08, K + 0.08, 0.3, 0, 0, 0.0)
        b.box('stone', K, K, kh, 0, 0, 0.1)
        for i in range(4):
            a = i * math.pi / 2
            with b.frame(0, 0, 0, a):
                b.merlons('stone', (-K / 2 + 0.12, -K / 2 - 0.01), (K / 2 - 0.12, -K / 2 - 0.01), kh + 0.1, h=0.09, t=0.06, pitch=0.12)
                for k in range(8):
                    b.box('stone', 0.035, 0.05, 0.05, -K / 2 + (k + 0.5) * K / 8, -K / 2 - 0.02, kh + 0.02)
                for lvl, zz in enumerate((0.55, 1.0, 1.42)):
                    for c in ((-0.2, 0.2) if lvl else (0.0,)):
                        b.box('dark', 0.05 if lvl else 0.035, 0.02, 0.13 if lvl else 0.09, c, -K / 2 - 0.004, zz)
                        if lvl:
                            b.cyl('dark', 0.025, 0.025, 0.02, 8, c, -K / 2 - 0.004, zz + 0.13, rx=math.pi / 2)
        b.box('dark', 0.16, 0.02, 0.26, 0, -K / 2 - 0.005, 0.1)
        b.box('stone', 0.3, 0.22, 0.04, 0, -K / 2 - 0.1, 0.1)
        for k in range(3):
            b.box('stone', 0.3 - k * 0.04, 0.06, 0.03, 0, -K / 2 - 0.2 + k * 0.045, 0.1 - 0.03 * (k + 1))
        for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x, y = sx * K / 2, sy * K / 2
            b.cyl('stone', 0.15, 0.14, kh + 0.35, 14, x, y, 0.1)
            b.corbel_ring('stone', 0.15, kh + 0.32, count=10, s=0.03)
            b.cyl('stone', 0.18, 0.18, 0.06, 14, x, y, kh + 0.38)
            b.cyl('accent', 0.2, 0.0, 0.5, 14, x, y, kh + 0.44)
            b.cyl('gold', 0.012, 0.0, 0.05, 6, x, y, kh + 0.93)
        b.pyramid('slate', K - 0.2, K - 0.2, 0.5, 0, 0, kh + 0.1)
        for sx in (-1, 1):
            b.banner('accent', 0.18, 0.62, sx * 0.24, -K / 2 - 0.012, 1.3)
            b.box('iron', 0.22, 0.015, 0.015, sx * 0.24, -K / 2 - 0.015, 1.3)
        pole_with_flag(b, 0, 0, kh + 0.58, pole=0.6, fw=0.52, fh=0.3)
    # great hall along the west wall
    with b.frame(-0.72, 0.45, 0.1, math.pi / 2):
        b.box('stone', 1.0, 0.42, 0.46)
        b.gable('slate', 1.08, 0.56, 0.3, 0, 0, 0.44, thick=0.025)
        b.gable_wall('stone', 0.42, 0.28, -0.5, 0, 0.46, rz=math.pi / 2, depth=0.03)
        b.gable_wall('stone', 0.42, 0.28, 0.5, 0, 0.46, rz=math.pi / 2, depth=0.03)
        for k in range(4):
            b.box('dark', 0.05, 0.02, 0.16, -0.36 + k * 0.24, 0.215, 0.18)
            b.cyl('dark', 0.025, 0.025, 0.02, 8, -0.36 + k * 0.24, 0.215, 0.34, rx=math.pi / 2)
    # chapel with a little bell tower
    with b.frame(0.78, -0.45, 0.1, 0.0):
        b.box('stone', 0.34, 0.56, 0.4)
        b.gable('slate', 0.64, 0.46, 0.3, 0, 0, 0.38, rz=math.pi / 2, thick=0.02)
        b.gable_wall('stone', 0.34, 0.26, 0, -0.28, 0.4, depth=0.03)
        b.cyl('dark', 0.04, 0.04, 0.02, 10, 0, -0.29, 0.5, rx=math.pi / 2)
        b.box('stone', 0.14, 0.14, 0.4, 0, 0.26, 0.4)
        b.box('dark', 0.05, 0.15, 0.08, 0, 0.26, 0.66)
        b.box('dark', 0.15, 0.05, 0.08, 0, 0.26, 0.66)
        b.pyramid('slate', 0.2, 0.2, 0.26, 0, 0.26, 0.8)
        b.cyl('gold', 0.01, 0.0, 0.08, 6, 0, 0.26, 1.05)
    # a house and the well
    with b.frame(-0.72, -0.62, 0.1, 0.0):
        timber_box(b, 0.36, 0.26, 0.26, pitch=0.12, braces=False)
        b.gable('tile', 0.44, 0.38, 0.22, 0, 0, 0.24, thick=0.02)
        b.gable_wall('plaster', 0.26, 0.18, -0.18, 0, 0.26, rz=math.pi / 2)
        b.gable_wall('plaster', 0.26, 0.18, 0.18, 0, 0.26, rz=math.pi / 2)
    b.cyl('stone', 0.08, 0.08, 0.09, 10, 0.3, -0.62, 0.1)
    b.cyl('dark', 0.06, 0.06, 0.005, 10, 0.3, -0.62, 0.19)
    for sx in (-1, 1):
        b.beam('beam', (0.3 + sx * 0.07, -0.62, 0.19), (0.3 + sx * 0.07, -0.62, 0.34), 0.015)
    b.gable('tile', 0.18, 0.2, 0.08, 0.3, -0.62, 0.33, thick=0.015)


# --- build, bake, export -------------------------------------------------------------------

LEVELS = [('Castle_L1', level1), ('Castle_L2', level2), ('Castle_L3', level3)]


def build_all(bake=True, only=None):
    lib.clear_startup_scene()
    mats = make_materials()
    coll = lib.fresh_collection('Castles')
    lib.setup_cycles(samples=24)
    results = []
    for idx, (name, fn) in enumerate(LEVELS):
        if only and name not in only:
            continue
        b = Builder(coll, mats)
        fn(b, random.Random(1000 + idx))
        ob = lib.join(b.parts, name)
        lib.drop_bottom_faces(ob)
        ob.data.color_attributes.active_color = ob.data.color_attributes['Wave']
        # keep the models apart while baking so their AO doesn't mix
        ob.location = (idx * 7.0, 0, 0)
        lib.smart_uv(ob, margin=0.003)
        if bake:
            ground = _ground(coll, ob.location)
            img = bpy.data.images.get(name + '_atlas') or bpy.data.images.new(name + '_atlas', ATLAS, ATLAS)
            img.scale(ATLAS, ATLAS)
            lib.bake_emit(ob, img)
            bpy.data.objects.remove(ground, do_unlink=True)
            _finalize_materials(ob, name, img)
        results.append(ob)
    return results


def _ground(coll, loc):
    me = bpy.data.meshes.new('bake_ground')
    s = 4.0
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new('bake_ground', me)
    ob.location = loc
    coll.objects.link(ob)
    mat = bpy.data.materials.get('bake_groundmat') or bpy.data.materials.new('bake_groundmat')
    me.materials.append(mat)
    return ob


def _finalize_materials(ob, name, img):
    tag = name.split('_')[1]
    base = export_material(tag + '_Base', img, rough=0.88)
    accent = export_material(tag + '_Accent', img, rough=0.75, double_sided=True)
    flag = export_material(tag + '_Flag', img, rough=0.8, double_sided=True)
    new_idx = []
    for slot in ob.material_slots:
        n = slot.material.name
        new_idx.append(2 if n == 'bake_flag' else 1 if n == 'bake_accent' else 0)
    idx = [new_idx[p.material_index] for p in ob.data.polygons]
    ob.data.materials.clear()
    for m in (base, accent, flag):
        ob.data.materials.append(m)
    for p, i in zip(ob.data.polygons, idx):
        p.material_index = i


def export(objs):
    locs = [tuple(o.location) for o in objs]
    for o in objs:
        o.location = (0, 0, 0)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    lib.export_glb(objs, OUT, jpeg_quality=86)
    for o, l in zip(objs, locs):
        o.location = l


if __name__ == '__main__' or True:
    _objs = build_all(bake=globals().get('CASTLE_BAKE', True), only=globals().get('CASTLE_ONLY'))
    if globals().get('CASTLE_EXPORT', True):
        export(_objs)
