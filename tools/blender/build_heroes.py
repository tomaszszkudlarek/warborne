"""Builds the hero figures and exports public/models/heroes/<hero>.glb.

    Paladin       plate armour, great helm with plume, raised longsword, heater shield
    Barbarian     bare-chested, horned helm, fur mantle, great double axe
    Vampire       pale lord in a high-collared cape, rapier and blood-red medallion
    Mage          robed old wizard, pointed hat, staff with a glowing orb
    Rogue         hooded, leather jerkin, recurve bow and dagger, quiver on the back
    Druid         leaf-mantled robe, antlered hood, living staff with a green crystal

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_heroes.py
    (env BAKE=0 skips the bake, ONLY=Paladin,Mage builds a subset,
     PREVIEW=/path.png renders a check image, POSE=12 poses it at that walk frame)

Each figure is a single skinned mesh on the hero_lib skeleton with two looping
clips: Walk (1 s, one full stride cycle) and Idle (3 s). The armature carries
`stride` (metres per walk cycle) and `height` as glTF extras so the game can match
walking speed to the animation. Materials: *_Metal, *_Base, *_Skin, *_Accent
(tinted with the owner's faction colour at runtime) and *_Glow (emissive).
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/Users/tomaszszkudlarek/Projects/Warlords/tools/blender'
sys.path.insert(0, HERE)
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import lib  # noqa: E402
import hero_lib as H  # noqa: E402
import materials as M  # noqa: E402

importlib.reload(lib)
importlib.reload(H)
importlib.reload(M)

from hero_lib import (Body, make_joints, w_torso, w_near, w_zchain, w_skirt, w_cape, blend_w, smooth, lerp)  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(ROOT, 'public', 'models', 'heroes')
TAU = math.tau
rad = math.radians


def V(x, y, z):
    return Vector((x, y, z))


# --- bake patterns (linear colours; object coordinates in metres) ---------------------------------------


def _mul(c, f):
    return tuple(x * f for x in c)


def p_metal(c, var=0.08, scratch=0.1):
    def pat(k, co, pxy, sep):
        n = k.noise(co, 18.0, 3.0, 0.5)
        col = k.ramp(n, [(0.3, _mul(c, 1 - var)), (0.7, _mul(c, 1 + var))])
        s = k.noise(k.vmath('MULTIPLY', co, (160.0, 160.0, 14.0)), 1.0, 2.0)
        return k.mix(k.math('MULTIPLY', k.math('GREATER_THAN', s, 0.64), scratch), col, _mul(c, 1.4))
    return pat


def p_chain(c):
    def pat(k, co, pxy, sep):
        col, _ = k.brick(pxy, _mul(c, 1.15), _mul(c, 0.95), _mul(c, 0.25), 0.014, 0.009, msize=0.0022, offset=0.5)
        return col
    return pat


def p_leather(c, var=0.18):
    def pat(k, co, pxy, sep):
        n = k.noise(co, 26.0, 4.0, 0.6)
        col = k.ramp(n, [(0.3, _mul(c, 1 - var)), (0.7, _mul(c, 1 + var))])
        e = k.voronoi_edge(co, 60.0)
        crease = k.math('SUBTRACT', 1.0, k.math('MULTIPLY', e, 40.0, clamp=True))
        return k.mix(k.math('MULTIPLY', crease, 0.35), col, _mul(c, 0.45))
    return pat


def p_cloth(c, var=0.1, fold=0.18):
    def pat(k, co, pxy, sep):
        n = k.noise(co, 90.0, 2.0)
        col = k.ramp(n, [(0.3, _mul(c, 1 - var)), (0.7, _mul(c, 1 + var))])
        f = k.noise(k.vmath('MULTIPLY', co, (9.0, 9.0, 2.5)), 1.0, 2.0)
        return k.mix(1.0, col, k.ramp(f, [(0.3, _mul((1, 1, 1), 1 - fold)), (0.7, (1.05, 1.05, 1.05))]), 'MULTIPLY')
    return pat


def p_streaks(c1, c2, sx=90.0, sz=6.0):
    """Fur and hair: streaks running down."""
    def pat(k, co, pxy, sep):
        n = k.noise(k.vmath('MULTIPLY', co, (sx, sx, sz)), 1.0, 4.0, 0.7)
        return k.ramp(n, [(0.25, c2), (0.75, c1)])
    return pat


def p_skin(c):
    def pat(k, co, pxy, sep):
        n = k.noise(co, 9.0, 3.0)
        col = k.ramp(n, [(0.3, _mul(c, 0.93)), (0.7, (c[0] * 1.06, c[1] * 1.0, c[2] * 0.98))])
        f = k.noise(co, 70.0, 2.0)
        return k.mix(k.math('MULTIPLY', f, 0.12), col, _mul(c, 0.8))
    return pat


def p_wood(c1, c2):
    def pat(k, co, pxy, sep):
        v = k.vmath('MULTIPLY', co, (70.0, 70.0, 5.0))
        return k.ramp(k.noise(v, 1.0, 5.0, 0.7), [(0.25, c1), (0.75, c2)])
    return pat


def p_leaf(c):
    def pat(k, co, pxy, sep):
        n = k.noise(co, 14.0, 3.0)
        return k.ramp(n, [(0.25, _mul(c, 0.7)), (0.5, c), (0.8, (c[0] * 1.6, c[1] * 1.25, c[2] * 0.7))])
    return pat


# key: (pattern, role). Roles become the exported materials.
PALETTE = {
    'steel': (p_metal((0.5, 0.51, 0.54)), 'metal'),
    'steel_dark': (p_metal((0.12, 0.125, 0.135), 0.12), 'metal'),
    'blade': (p_metal((0.62, 0.63, 0.66), 0.04, 0.05), 'metal'),
    'gold': (p_metal((0.8, 0.52, 0.17), 0.1, 0.06), 'metal'),
    'bronze': (p_metal((0.42, 0.24, 0.1), 0.12), 'metal'),
    'chain': (p_chain((0.34, 0.34, 0.36)), 'metal'),
    'leather': (p_leather((0.17, 0.085, 0.04)), 'base'),
    'leather_dark': (p_leather((0.06, 0.04, 0.028)), 'base'),
    'leather_red': (p_leather((0.22, 0.03, 0.025)), 'base'),
    'cloth_white': (p_cloth((0.72, 0.69, 0.6)), 'base'),
    'cloth_blue': (p_cloth((0.025, 0.05, 0.22)), 'base'),
    'cloth_green': (p_cloth((0.06, 0.12, 0.04)), 'base'),
    'cloth_moss': (p_cloth((0.12, 0.14, 0.05)), 'base'),
    'cloth_brown': (p_cloth((0.13, 0.085, 0.045)), 'base'),
    'cloth_grey': (p_cloth((0.09, 0.09, 0.095)), 'base'),
    'cloth_dark': (p_cloth((0.03, 0.03, 0.035)), 'base'),
    'velvet_black': (p_cloth((0.018, 0.016, 0.022), 0.15, 0.3), 'base'),
    'velvet_red': (p_cloth((0.24, 0.012, 0.02), 0.15, 0.3), 'base'),
    'fur': (p_streaks((0.3, 0.2, 0.11), (0.1, 0.065, 0.035)), 'base'),
    'fur_light': (p_streaks((0.6, 0.55, 0.46), (0.28, 0.24, 0.18)), 'base'),
    'hair_red': (p_streaks((0.42, 0.14, 0.04), (0.16, 0.05, 0.015), 200, 8), 'base'),
    'hair_black': (p_streaks((0.035, 0.03, 0.035), (0.008, 0.007, 0.01), 200, 8), 'base'),
    'hair_white': (p_streaks((0.8, 0.79, 0.75), (0.45, 0.44, 0.42), 200, 8), 'base'),
    'hair_grey': (p_streaks((0.42, 0.4, 0.36), (0.16, 0.15, 0.13), 200, 8), 'base'),
    'skin': (p_skin((0.58, 0.36, 0.25)), 'skin'),
    'skin_tan': (p_skin((0.46, 0.25, 0.14)), 'skin'),
    'skin_pale': (p_skin((0.6, 0.6, 0.66)), 'skin'),
    'eye': (M._flat((0.015, 0.012, 0.01), 0.1), 'skin'),
    'lips': (M._flat((0.3, 0.1, 0.08), 0.1), 'skin'),
    'wood': (p_wood((0.09, 0.05, 0.022), (0.24, 0.14, 0.065)), 'base'),
    'wood_dark': (p_wood((0.04, 0.025, 0.012), (0.12, 0.075, 0.035)), 'base'),
    'bone': (M._flat((0.62, 0.56, 0.42), 0.15, 25.0), 'base'),
    'horn': (p_streaks((0.5, 0.42, 0.3), (0.12, 0.08, 0.05), 20, 60), 'base'),
    'leaf': (p_leaf((0.1, 0.22, 0.035)), 'base'),
    'leaf_autumn': (p_leaf((0.3, 0.16, 0.03)), 'base'),
    'rope': (p_streaks((0.35, 0.27, 0.15), (0.15, 0.11, 0.06), 40, 120), 'base'),
    'feather': (p_streaks((0.55, 0.52, 0.48), (0.12, 0.1, 0.09), 30, 200), 'base'),
    'accent': (p_cloth((0.8, 0.8, 0.8), 0.08, 0.22), 'accent'),
    'glow_blue': (M._glow((0.35, 0.75, 1.0)), 'glow'),
    'glow_green': (M._glow((0.5, 1.0, 0.35)), 'glow'),
    'glow_red': (M._glow((1.0, 0.08, 0.05)), 'glow'),
    'glow_gold': (M._glow((1.0, 0.8, 0.35)), 'glow'),
}

ROLES = {  # role -> (metallic, roughness)
    'metal': (0.9, 0.34),
    'base': (0.0, 0.82),
    'skin': (0.0, 0.55),
    'accent': (0.0, 0.78),
    'glow': (0.0, 0.5),
}


def make_materials():
    out = {}
    for name, (pat, role) in PALETTE.items():
        glow = role == 'glow'
        out[name] = lib.bake_material('hero_' + name, pat, ao_distance=0.1, ao_strength=0.0 if glow else 0.75,
                                      grime=0.0 if glow else 0.12)
    return out


# --- shared anatomy -----------------------------------------------------------------------------------

# Torso cross-sections in base-joint space: (z, half width, half depth, 0, centre y). +y is the back.
TORSO = [
    (0.84, 0.15, 0.11, 0, 0.005),
    (0.92, 0.168, 0.12, 0, 0.0),
    (1.0, 0.163, 0.115, 0, 0.0),
    (1.08, 0.152, 0.108, 0, 0.0),
    (1.17, 0.162, 0.115, 0, -0.004),
    (1.27, 0.182, 0.125, 0, -0.012),
    (1.36, 0.196, 0.126, 0, -0.012),
    (1.43, 0.19, 0.115, 0, -0.002),
    (1.48, 0.12, 0.085, 0, 0.005),
    (1.51, 0.06, 0.06, 0, 0.01),
]


def ring_at(rings, z):
    """Interpolated (rx, ry, cy) of a loft profile at height z."""
    rs = sorted(rings, key=lambda r: r[0])
    if z <= rs[0][0]:
        r = rs[0]
        return r[1], r[2], r[4] if len(r) > 4 else 0.0
    for a, b in zip(rs, rs[1:]):
        if a[0] <= z <= b[0]:
            t = (z - a[0]) / max(1e-9, b[0] - a[0])
            return lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[4] if len(a) > 4 else 0, b[4] if len(b) > 4 else 0, t)
    r = rs[-1]
    return r[1], r[2], r[4] if len(r) > 4 else 0.0


def grow(rings, d, dy=0.0):
    return [(r[0], r[1] + d, r[2] + d, 0, (r[4] if len(r) > 4 else 0) + dy) for r in rings]


def surf(rings, z, ang, off=0.0):
    """Point on an elliptic loft surface at height z; ang 0 = front (-Y), +90deg = left (+X)."""
    rx, ry, cy = ring_at(rings, z)
    return V(math.sin(ang) * (rx + off), cy - math.cos(ang) * (ry + off), z)


def arc_band(b, mat, rings, z, h, a0, a1, w, off=0.004, thick=0.012, nu=16):
    """Strip of height h wrapped round a loft surface between angles a0..a1 (0 = front)."""
    def fn(u, v):
        a = lerp(a0, a1, u)
        return surf(rings, z + (v - 0.5) * h, a, off + thick / 2)
    b.sheet(mat, fn, nu, 1, w, thick=thick)


def front_strip(b, mat, rings, z0, z1, width, w, off=0.004, thick=0.01, x=0.0, nv=8):
    """Vertical strip following the front of a loft profile (crosses, plackets, trims)."""
    def fn(u, v):
        z = lerp(z0, z1, v)
        rx, ry, cy = ring_at(rings, z)
        xx = x + (u - 0.5) * width
        yy = cy - ry * math.sqrt(max(0.0, 1 - (xx / max(rx, 1e-3)) ** 2)) - off - thick / 2
        return V(xx, yy, z)
    b.sheet(mat, fn, 2, nv, w, thick=thick)


def hood_surface(rings, a, z):
    """Point on a hood around the head; a = 0 at the back, +-pi at the (open) face."""
    rx, ry, cy = ring_at(rings, max(0.0, z))
    return V(math.sin(a) * max(rx, 0.02), cy + math.cos(a) * max(ry, 0.02), z)


def neck(b, mat, r=0.058):
    J = b.J
    b.loft(mat, [(J['neck'].z - 0.1, r * 1.1, r), (J['neck'].z, r, r * 0.95), (J['head'].z + 0.07, r * 0.92, r * 0.9)],
           w_zchain((J['head'].z, 'head'), (J['neck'].z - 0.02, 'neck'), (J['neck'].z - 0.08, 'chest')), seg=12,
           x=J['neck'].x, y=J['neck'].y + 0.005)


def head(b, skin, eye='eye', hair=None, brows=None, ears=True, s=1.0, pointed_ears=False, lips='lips'):
    """Face and skull in a frame at the head joint (z up, face toward -Y)."""
    with b.frame(*b.J['head'], s=s):
        b.ellipsoid(skin, 0.1, 0.113, 0.123, 'head', seg=18, n=10, z=0.13, y=0.012)
        b.ellipsoid(skin, 0.083, 0.083, 0.085, 'head', seg=16, n=8, z=0.07, y=-0.022)
        b.ellipsoid(skin, 0.032, 0.03, 0.03, 'head', seg=10, n=5, z=0.025, y=-0.07)
        # cheekbones and brow
        for sx in (-1, 1):
            b.ellipsoid(skin, 0.03, 0.025, 0.022, 'head', seg=10, n=5, x=sx * 0.05, y=-0.075, z=0.1)
        b.ellipsoid(skin, 0.075, 0.03, 0.022, 'head', seg=12, n=5, y=-0.093, z=0.145)
        # nose
        b.loft(skin, [(0.0, 0.012, 0.012), (0.035, 0.016, 0.02, 0, -0.012), (0.055, 0.02, 0.02, 0, -0.01), (0.062, 0.0, 0.0, 0, -0.004)],
               'head', seg=8, rx=rad(-90) + 0.25, y=-0.098, z=0.14)
        b.ellipsoid(skin, 0.022, 0.018, 0.014, 'head', seg=10, n=5, y=-0.112, z=0.09)
        # eyes and lids
        for sx in (-1, 1):
            b.sphere(eye, 0.0135, 'head', x=sx * 0.036, y=-0.094, z=0.125)
            b.ellipsoid(skin, 0.02, 0.012, 0.008, 'head', seg=10, n=4, x=sx * 0.036, y=-0.094, z=0.137)
        if lips:
            b.ellipsoid(lips, 0.024, 0.01, 0.007, 'head', seg=10, n=4, y=-0.1, z=0.05)
        if ears:
            for sx in (-1, 1):
                if pointed_ears:
                    b.loft(skin, [(0, 0.012, 0.022), (0.05, 0.008, 0.016), (0.1, 0.0, 0.0)], 'head', seg=8,
                           x=sx * 0.095, y=0.015, z=0.115, ry=sx * rad(62), rx=rad(-10))
                else:
                    b.ellipsoid(skin, 0.014, 0.024, 0.036, 'head', seg=10, n=5, x=sx * 0.099, y=0.018, z=0.12, rz=sx * 0.25)
        if brows:
            for sx in (-1, 1):
                b.box(brows, 0.045, 0.016, 0.012, 'head', bevel=0.004, x=sx * 0.037, y=-0.105, z=0.15, ry=sx * -0.18)


def arm(b, side, upper, fore, hand='fist', hand_mat='skin', r=1.0, elbow=None, fore_r=1.0):
    J = b.J
    sg = 1 if side == 'L' else -1
    ua, fa, hb = f'upper_arm.{side}', f'forearm.{side}', f'hand.{side}'
    w_up = w_near(J, f'shoulder.{side}', ua, fa)
    w_fa = w_near(J, ua, fa, hb)
    if upper:
        with b.along(J[f'arm.{side}'], J[f'elbow.{side}']) as L:
            b.loft(upper, [(-0.05, 0.05 * r, 0.05 * r), (0.0, 0.062 * r, 0.06 * r), (L * 0.35, 0.062 * r, 0.058 * r),
                           (L * 0.8, 0.05 * r, 0.047 * r), (L + 0.03, 0.043 * r, 0.043 * r)], w_up, seg=14)
    if elbow:
        b.sphere(elbow, 0.046 * r, w_near(J, ua, fa), seg=12, n=6, x=J[f'elbow.{side}'].x, y=J[f'elbow.{side}'].y, z=J[f'elbow.{side}'].z)
    if fore:
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            fr = r * fore_r
            b.loft(fore, [(-0.03, 0.044 * fr, 0.044 * fr), (L * 0.25, 0.052 * fr, 0.05 * fr), (L * 0.7, 0.043 * fr, 0.04 * fr),
                          (L + 0.01, 0.034 * fr, 0.031 * fr)], w_fa, seg=14)
    if hand:
        with b.along(J[f'wrist.{side}'], J[f'hand_end.{side}']) as L:
            if hand == 'fist':
                b.ellipsoid(hand_mat, 0.04, 0.047, 0.055, hb, seg=12, n=6, z=0.05)
                b.ellipsoid(hand_mat, 0.016, 0.018, 0.035, hb, seg=8, n=4, x=-sg * 0.034, z=0.045, y=-0.018, ry=-sg * 0.5)
            elif hand == 'open':
                b.loft(hand_mat, [(-0.01, 0.03, 0.018), (0.04, 0.045, 0.016), (0.08, 0.043, 0.012), (0.11, 0.036, 0.01), (0.12, 0.0, 0.0)],
                       hb, seg=10)
                b.ellipsoid(hand_mat, 0.012, 0.012, 0.03, hb, seg=8, n=4, x=-sg * 0.04, z=0.035, ry=-sg * 0.6)
            elif hand == 'claw':
                b.loft(hand_mat, [(-0.01, 0.028, 0.017), (0.04, 0.04, 0.015), (0.07, 0.036, 0.012)], hb, seg=10)
                for i in range(4):
                    x = (i - 1.5) * 0.019
                    b.tube(hand_mat, [V(x, 0, 0.065), V(x * 1.1, -0.02, 0.1), V(x * 1.15, -0.045, 0.125)], [0.007, 0.006, 0.005], hb, seg=6)
                    b.cyl('bone', 0.005, 0.0, 0.03, hb, seg=5, x=x * 1.15, y=-0.045, z=0.125, rx=rad(-40))
                b.ellipsoid(hand_mat, 0.011, 0.011, 0.03, hb, seg=8, n=4, x=-sg * 0.036, z=0.03, ry=-sg * 0.6)


def grip_point(J, side, d=0.05):
    w, e = J[f'wrist.{side}'], J[f'hand_end.{side}']
    return w + (e - w).normalized() * d


def leg(b, side, thigh, shin, r=1.0, knee=None, thigh_top=0.05):
    J = b.J
    th, sh, ft = f'thigh.{side}', f'shin.{side}', f'foot.{side}'
    if thigh:
        wt = blend_w({'hips': 1.0}, w_near(J, th, sh), lambda lo, co: smooth(J['leg.L'].z + 0.02, J['leg.L'].z - 0.08, co.z))
        with b.along(J[f'leg.{side}'], J[f'knee.{side}']) as L:
            b.loft(thigh, [(-thigh_top, 0.085 * r, 0.085 * r), (0.0, 0.093 * r, 0.09 * r), (L * 0.45, 0.083 * r, 0.08 * r, 0, -0.005),
                           (L * 0.9, 0.062 * r, 0.06 * r), (L + 0.035, 0.055 * r, 0.055 * r)], wt, seg=14)
    if knee:
        k = J[f'knee.{side}']
        b.sphere(knee, 0.055 * r, w_near(J, th, sh), x=k.x, y=k.y, z=k.z)
    if shin:
        with b.along(J[f'knee.{side}'], J[f'ankle.{side}']) as L:
            b.loft(shin, [(-0.03, 0.056 * r, 0.056 * r), (L * 0.28, 0.06 * r, 0.064 * r, 0, 0.008), (L * 0.75, 0.044 * r, 0.044 * r),
                          (L + 0.02, 0.04 * r, 0.04 * r)], w_near(J, th, sh, ft), seg=14)


def boot(b, side, mat, sole='leather_dark', shaft=0.3, cuff=None, r=1.0, toe=1.0, shaft_top=None, cuff_mat=None):
    """Boot: foot part along -Y from the heel, plus a shaft up the shin."""
    J = b.J
    a = J[f'ankle.{side}']
    ft, sh = f'foot.{side}', f'shin.{side}'
    L = 0.27 * toe
    with b.along(V(a.x, a.y + 0.07, 0.06), V(a.x, a.y + 0.07 - L, 0.06)):
        prof = [(0.0, 0.03 * r, 0.035), (0.015, 0.046 * r, 0.056), (0.07, 0.05 * r, 0.06, 0, -0.002), (0.15, 0.053 * r, 0.045, 0, -0.016),
                (L * 0.83, 0.048 * r, 0.032, 0, -0.026), (L * 0.95, 0.036 * r, 0.024, 0, -0.033), (L, 0.0, 0.0, 0, -0.036)]
        b.loft(mat, prof, ft, seg=14)
        if sole:
            b.loft(sole, [(0.0, 0.033 * r, 0.012, 0, -0.056), (0.01, 0.05 * r, 0.012, 0, -0.056), (L * 0.95, 0.042 * r, 0.012, 0, -0.056),
                          (L + 0.005, 0.0, 0.0, 0, -0.056)], ft, seg=12)
    if shaft:
        top = shaft_top or (0.06 + shaft)
        rings = [(0.05, 0.055 * r, 0.06 * r, 0, 0.0), (0.14, 0.05 * r, 0.052 * r), (0.3, 0.06 * r, 0.064 * r), (top, 0.063 * r, 0.066 * r)]
        wsh = w_near(J, sh, ft, power=4)
        b.loft(mat, rings, wsh, seg=14, x=a.x, y=a.y + 0.005)
        if cuff:
            b.loft(cuff_mat or mat, [(top - 0.06, 0.066 * r, 0.068 * r), (top - 0.005, 0.075 * r * cuff, 0.078 * r * cuff), (top + 0.02, 0.07 * r * cuff, 0.073 * r * cuff),
                                     (top + 0.02, 0.06 * r, 0.062 * r)], w_near(J, sh, f'thigh.{side}', power=4), seg=14, cap0=False, cap1=False, x=a.x, y=a.y + 0.005)


def skirt(b, mat, rings, top_z, cap1=True):
    b.loft(mat, rings, w_skirt(top_z), seg=24, cap0=False, cap1=cap1)


def cape(b, mat, top_z, bot_z, w_top, w_bot, depth_top=0.13, depth_bot=0.3, folds=5, fold_amp=0.025, wrap=0.55,
         thick=0.014, hem=None, y0=0.0, weights=None, nu=22, nv=16):
    """Cape hanging from the shoulders, curving round the back. wrap: fraction of a half
    circle it covers (0.5 = back only). hem(u) -> extra drop at the bottom edge."""
    J = b.J

    def fn(u, v):
        z = lerp(top_z, bot_z, v)
        if hem:
            z -= hem(u) * v
        hw = lerp(w_top, w_bot, v ** 0.8)
        dp = lerp(depth_top, depth_bot, v ** 0.9)
        a = (u - 0.5) * math.pi * wrap * 2
        fold = math.sin(u * TAU * folds / 2 + 0.3) * fold_amp * smooth(0.0, 0.6, v)
        x = math.sin(a) * hw
        y = y0 + math.cos(a) * dp + fold
        return V(x, y, z)
    b.sheet(mat, fn, nu, nv, weights or w_cape(J), thick=thick)


# --- heroes -----------------------------------------------------------------------------------------------


def paladin(b):
    J = b.J
    T = TORSO
    # breastplate over an arming coat
    plate = grow(T, 0.018)
    b.loft('steel', [r for r in plate if r[0] >= 1.02], w_torso(J), seg=24, sq=2.4)
    b.loft('chain', grow([r for r in T if r[0] <= 1.1], 0.012), w_torso(J), seg=22)
    front_strip(b, 'gold', plate, 1.05, 1.42, 0.022, w_torso(J), off=0.0)
    for z in (1.05,):
        arc_band(b, 'gold', plate, z, 0.02, -2.6, 2.6, w_torso(J), off=0.0)
    arc_band(b, 'gold', plate, 1.4, 0.018, -1.0, 1.0, w_torso(J), off=0.0)
    # gorget and pauldrons
    b.loft('steel', [(1.43, 0.12, 0.1), (1.5, 0.085, 0.078), (1.56, 0.07, 0.068)], w_zchain((1.53, 'neck'), (1.47, 'chest')), seg=18, cap0=False, cap1=False, y=0.005)
    b.ring_band('gold', 1.5, 0.09, 0.083, 0.016, 0.01, w_zchain((1.53, 'neck'), (1.47, 'chest')), seg=18, y=0.005)
    for side, sg in (('L', 1), ('R', -1)):
        a = J[f'arm.{side}']
        wsh = w_near(J, f'shoulder.{side}', f'upper_arm.{side}', power=3)
        with b.frame(a.x + sg * 0.01, a.y, a.z + 0.02, ry=sg * rad(28)):
            b.ellipsoid('steel', 0.115, 0.125, 0.1, wsh, seg=18, n=8, z0=-0.01)
            b.ring_band('gold', 0.0, 0.118, 0.128, 0.018, 0.012, wsh, seg=18)
            for i, (dz, s) in enumerate(((-0.05, 0.11), (-0.095, 0.1))):
                b.loft('steel', [(dz - 0.04, s, s * 1.05), (dz, s + 0.012, s * 1.05 + 0.012), (dz + 0.03, s * 0.8, s * 0.85)], wsh, seg=18, cap0=False, cap1=False,
                       x=sg * 0.02)
            b.sphere('gold', 0.012, wsh, x=0, y=-0.1, z=0.05)
    # arms: rerebrace, couter, vambrace, gauntlets
    for side in ('L', 'R'):
        arm(b, side, 'steel', 'steel', hand='fist', hand_mat='steel_dark', r=1.05, elbow='steel', fore_r=1.08)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            b.loft('steel', [(L - 0.05, 0.045, 0.043), (L + 0.02, 0.06, 0.058), (L + 0.045, 0.058, 0.056), (L + 0.045, 0.045, 0.043)],
                   f'hand.{side}', seg=14, cap0=False, cap1=False)
        e = J[f'elbow.{side}']
        sg = 1 if side == 'L' else -1
        b.ellipsoid('steel', 0.014, 0.05, 0.05, w_near(J, f'upper_arm.{side}', f'forearm.{side}'), seg=12, n=6, x=e.x + sg * 0.048, y=e.y + 0.01, z=e.z)
    # faulds and tassets over a mail skirt
    b.loft('chain', [(0.72, 0.19, 0.155), (0.9, 0.175, 0.135), (1.0, 0.165, 0.125)], w_skirt(0.98), seg=24, cap0=False, cap1=False)
    for i, z in enumerate((1.0, 0.95, 0.9)):
        r = 0.178 + i * 0.012
        b.loft('steel', [(z - 0.055, r + 0.012, r * 0.76 + 0.012), (z, r, r * 0.76)], w_skirt(0.98, 0.25), seg=24, cap0=False, cap1=False)
    for side, sg in (('L', 1), ('R', -1)):
        with b.along(J[f'leg.{side}'] + V(sg * 0.03, -0.03, 0.02), J[f'knee.{side}'] + V(sg * 0.02, -0.06, 0.2)):
            b.sheet('steel', lambda u, v: V((u - 0.5) * 0.17, -math.sin(u * math.pi) * 0.035 - 0.07, v * 0.2), 6, 3,
                    w_near(J, f'thigh.{side}', power=2), thick=0.012)
    # legs
    for side in ('L', 'R'):
        leg(b, side, 'steel', 'steel', r=1.08, knee='steel')
        boot(b, side, 'steel', sole='steel_dark', shaft=0.1, r=1.05)
        k = J[f'knee.{side}']
        sg = 1 if side == 'L' else -1
        b.ellipsoid('steel', 0.045, 0.02, 0.05, w_near(J, f'thigh.{side}', f'shin.{side}'), seg=12, n=6, x=k.x + sg * 0.05, y=k.y - 0.02, z=k.z)
        b.sphere('gold', 0.014, w_near(J, f'thigh.{side}', f'shin.{side}'), x=k.x, y=k.y - 0.063, z=k.z)
        with b.along(J[f'knee.{side}'], J[f'ankle.{side}']) as L:
            for t in (0.2, 0.85):
                b.ring_band('leather', L * t, 0.068, 0.07, 0.014, 0.008, f'shin.{side}', seg=14, y=0.005)
    # tabard: white with a golden cross, trimmed in gold
    tab = grow(plate, 0.012)
    w_tab = blend_w(w_torso(J), w_skirt(1.02, 0.2), lambda lo, co: smooth(1.04, 0.96, co.z))
    for sgn, ang in ((1, 0.0), (-1, math.pi)):
        def fn(u, v, ang=ang):
            z = lerp(1.44, 0.6, v)
            wdt = lerp(0.19, 0.21, v)
            x = (u - 0.5) * 2 * wdt
            zz = max(z, 1.02)
            rx, ry, cy = ring_at(tab, zz)
            depth = ry * math.sqrt(max(0.0, 1 - (x / max(rx, 1e-3)) ** 2)) + 0.004
            depth = max(depth, 0.02)
            if z < 1.02:
                depth = lerp(depth, 0.205, smooth(1.02, 0.6, z))
            y = cy - depth if ang == 0 else cy + depth
            return V(x if ang == 0 else -x, y, z)
        b.sheet('cloth_white', fn, 8, 12, w_tab, thick=0.01)
        if ang == 0:
            for (x0, z0, x1, z1) in ((0.0, 1.38, 0.0, 0.66), (-0.12, 1.2, 0.12, 1.2)):
                pass
    # golden cross on the front of the tabard
    front_strip(b, 'gold', grow(tab, 0.008), 1.02, 1.36, 0.04, w_torso(J), off=0.0)
    arc_band(b, 'gold', grow(tab, 0.008), 1.25, 0.04, -0.55, 0.55, w_torso(J), off=0.0, nu=10)
    # belt
    b.ring_band('leather_dark', 1.02, 0.182, 0.138, 0.04, 0.012, 'hips', seg=24)
    b.box('gold', 0.05, 0.02, 0.045, 'hips', bevel=0.006, y=-0.14, z=1.02)
    # cape (faction colour) with gold clasps
    cape(b, 'accent', 1.47, 0.2, 0.19, 0.34, depth_top=0.14, depth_bot=0.34, folds=6, wrap=0.52, y0=0.0)
    for sg in (1, -1):
        b.sphere('gold', 0.022, 'chest', x=sg * 0.14, y=-0.085, z=1.43)
    # great helm with a golden cross, crown band and plume
    helm = [(-0.045, 0.1, 0.11, 0, 0.0), (0.0, 0.118, 0.13, 0, -0.006), (0.12, 0.123, 0.135, 0, -0.01), (0.21, 0.117, 0.128, 0, -0.004),
            (0.27, 0.096, 0.104, 0, 0.004), (0.305, 0.055, 0.06, 0, 0.006), (0.318, 0.0, 0.0, 0, 0.006)]
    with b.frame(*J['head']):
        b.loft('steel', helm, 'head', seg=22, sq=2.3)
        arc_band(b, 'steel_dark', helm, 0.145, 0.02, -1.15, 1.15, 'head', off=-0.003)
        front_strip(b, 'gold', helm, 0.02, 0.27, 0.022, 'head', off=0.0)
        arc_band(b, 'gold', helm, 0.104, 0.018, -0.6, 0.6, 'head', off=0.0, nu=8)
        arc_band(b, 'gold', helm, 0.21, 0.022, -math.pi, math.pi, 'head', off=0.0, nu=30)
        for i in range(5):
            for j in range(2):
                p = surf(helm, 0.05 + i * 0.018, -0.55 - j * 0.12, 0.0)
                b.box('steel_dark', 0.01, 0.012, 0.007, 'head', x=p.x, y=p.y, z=p.z)
        b.ring_band('steel', -0.03, 0.105, 0.115, 0.02, 0.01, 'head', seg=22)
        for i in range(8):
            a = TAU * i / 8
            p = surf(helm, 0.21, a, 0.012)
            b.sphere('gold', 0.009, 'head', seg=8, n=4, x=p.x, y=p.y, z=p.z)
        # plume holder and plume
        b.cyl('gold', 0.018, 0.012, 0.05, 'head', seg=10, y=0.02, z=0.3)
        pts = [V(0, 0.0, 0.34), V(0, 0.05, 0.4), V(0, 0.12, 0.42), V(0, 0.19, 0.38), V(0, 0.24, 0.3), V(0, 0.26, 0.2)]
        for i in range(len(pts) - 1):
            for t in (0.0, 0.5):
                p = pts[i].lerp(pts[i + 1], t)
                rr = 0.055 - i * 0.006
                d = (pts[i + 1] - pts[i]).normalized()
                b.ellipsoid('accent', rr * 0.55, rr, rr * 0.8, 'head', seg=10, n=5, x=p.x, y=p.y, z=p.z, rx=math.atan2(d.z, -d.y))
    # longsword raised in the right hand
    g = grip_point(J, 'R', 0.05)
    d = V(0, -0.28, 1).normalized()
    with b.along(g - d * 0.12, g + d * 1.12):
        b.loft('leather_dark', [(0.03, 0.017, 0.017), (0.22, 0.017, 0.017)], 'hand.R', seg=8)
        b.sphere('gold', 0.03, 'hand.R', seg=10, n=6, z=0.02)
        b.box('gold', 0.26, 0.03, 0.03, 'hand.R', bevel=0.008, z=0.23)
        for sx in (-1, 1):
            b.sphere('gold', 0.02, 'hand.R', seg=8, n=4, x=sx * 0.135, z=0.23)
        b.loft('blade', [(0.245, 0.035, 0.01), (0.3, 0.033, 0.009), (0.95, 0.024, 0.007), (1.1, 0.012, 0.004), (1.14, 0.0, 0.0)], 'hand.R', seg=4, sq=1.0, smooth=False)
        b.loft('gold', [(0.245, 0.006, 0.0105), (0.55, 0.004, 0.0085)], 'hand.R', seg=4, sq=1.0, smooth=False)
    # heater shield on the left forearm
    e, w = J['elbow.L'], J['wrist.L']
    c = e.lerp(w, 0.45) + V(0.075, 0.0, -0.02)

    def shield_w(u):
        return 0.25 if u < 0.45 else 0.25 * math.sqrt(max(0.0, 1 - ((u - 0.45) / 0.55) ** 2))
    with b.frame(c.x, c.y, c.z, rz=rad(68)):
        def sh(u, v, inset=0.0, bulge=0.07):
            z = lerp(0.3, -0.42, v)
            hw = shield_w(v) - inset
            x = (u - 0.5) * 2 * hw
            return V(x, -bulge * (1 - (x / 0.25) ** 2) - 0.02, z)
        b.sheet('steel', lambda u, v: sh(u, v) + V(0, 0.012, 0), 12, 14, 'forearm.L', thick=0.022)
        b.sheet('accent', lambda u, v: sh(u, v, 0.022) + V(0, -0.004, 0), 12, 14, 'forearm.L', thick=0.012)
        b.sheet('gold', lambda u, v: V((u - 0.5) * 0.05, -0.1, lerp(0.24, -0.33, v)) + V(0, 0.07 * ((u - 0.5) * 0.05 / 0.25) ** 2, 0), 2, 8, 'forearm.L', thick=0.012)
        b.sheet('gold', lambda u, v: V((u - 0.5) * 0.36, -0.1 + 0.07 * (((u - 0.5) * 0.36) / 0.25) ** 2, lerp(0.14, 0.09, v)), 8, 1, 'forearm.L', thick=0.012)
        b.sphere('gold', 0.035, 'forearm.L', seg=12, n=6, y=-0.11, z=0.115)


def barbarian(b):
    J = b.J
    T = TORSO
    sk = 'skin_tan'
    with b.frame(s=(1.1, 1.08, 1.0)):
        b.loft(sk, T, w_torso(J), seg=24)
        # pecs, abs, obliques, traps
        for sx in (-1, 1):
            b.ellipsoid(sk, 0.085, 0.045, 0.06, w_torso(J), seg=14, n=6, x=sx * 0.075, y=-0.105, z=1.33, ry=sx * 0.25)
            b.ellipsoid(sk, 0.05, 0.05, 0.08, w_torso(J), seg=12, n=6, x=sx * 0.08, y=0.02, z=1.44, rx=0.5)
            for i in range(3):
                b.ellipsoid(sk, 0.03, 0.02, 0.028, w_torso(J), seg=10, n=5, x=sx * 0.034, y=-0.107 + i * 0.004, z=1.21 - i * 0.055)
        b.ellipsoid(sk, 0.13, 0.05, 0.1, w_torso(J), seg=16, n=6, y=0.1, z=1.33)
    # deltoids
    for side, sg in (('L', 1), ('R', -1)):
        a = J[f'arm.{side}']
        b.ellipsoid(sk, 0.075, 0.08, 0.07, w_near(J, f'shoulder.{side}', f'upper_arm.{side}', power=3), seg=14, n=7, x=a.x + sg * 0.01, y=a.y, z=a.z - 0.03)
        arm(b, side, sk, sk, hand='fist', hand_mat=sk, r=1.25, fore_r=1.05)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            b.loft('leather', [(L * 0.3, 0.06, 0.057), (L * 0.35, 0.064, 0.061), (L * 0.95, 0.052, 0.049), (L, 0.047, 0.045)],
                   w_near(J, f'forearm.{side}', f'hand.{side}'), seg=14, cap0=False, cap1=False)
            for t in (0.45, 0.62, 0.8):
                for k in range(3):
                    ang = (k - 1) * 0.6
                    b.sphere('steel', 0.009, f'forearm.{side}', seg=6, n=3, x=math.sin(ang) * 0.06 * sg, y=-math.cos(ang) * 0.058 + 0.0, z=L * t)
        with b.along(J[f'arm.{side}'], J[f'elbow.{side}']) as L:
            b.ring_band('gold', L * 0.55, 0.072, 0.07, 0.03, 0.01, f'upper_arm.{side}', seg=16)
    # cross strap with studs and belt with a skull buckle
    b.tube('leather_dark', [V(0.17, -0.1, 1.45), V(0.05, -0.16, 1.3), V(-0.1, -0.15, 1.12), V(-0.19, -0.1, 1.0)], 0.018, w_torso(J), seg=8)
    b.tube('leather_dark', [V(0.17, 0.1, 1.45), V(0.05, 0.16, 1.3), V(-0.1, 0.15, 1.12), V(-0.19, 0.1, 1.0)], 0.018, w_torso(J), seg=8)
    for t in (0.2, 0.4, 0.6, 0.8):
        p = V(0.17, -0.1, 1.45).lerp(V(-0.19, -0.1, 1.0), t) + V(0, -0.06 * math.sin(t * math.pi) - 0.02, 0)
        b.sphere('steel', 0.012, w_torso(J), seg=8, n=4, x=p.x, y=p.y, z=p.z)
    b.ring_band('leather_dark', 1.0, 0.195, 0.145, 0.07, 0.015, 'hips', seg=24)
    with b.frame(0, -0.155, 1.0):
        b.ellipsoid('bone', 0.045, 0.035, 0.05, 'hips', seg=12, n=6)
        for sx in (-1, 1):
            b.sphere('eye', 0.012, 'hips', seg=8, n=4, x=sx * 0.018, y=-0.03, z=0.005)
        b.box('bone', 0.045, 0.03, 0.025, 'hips', bevel=0.005, y=-0.005, z=-0.045)
    # fur loincloth and faction-coloured front flap
    skirt(b, 'fur', [(0.6, 0.23, 0.2), (0.62, 0.24, 0.21), (0.8, 0.215, 0.17), (0.98, 0.19, 0.145)], 0.98)
    for i in range(28):
        a = TAU * i / 28
        p = V(math.sin(a) * 0.235, -math.cos(a) * 0.205, 0.62)
        b.loft('fur', [(0, 0.022, 0.012), (-0.07, 0.0, 0.0)], w_skirt(0.98), seg=5, x=p.x, y=p.y, z=p.z, rz=-a)
    b.sheet('accent', lambda u, v: V((u - 0.5) * lerp(0.2, 0.16, v), -0.215 - 0.02 * v - 0.01 * math.sin(u * math.pi), lerp(0.97, 0.52, v)), 4, 8, w_skirt(0.98, 0.15), thick=0.012)
    for side in ('L', 'R'):
        leg(b, side, 'leather', 'leather', r=1.15, knee=None)
        boot(b, side, 'fur', sole='leather_dark', shaft=0.36, r=1.25, cuff=1.12, cuff_mat='fur')
        with b.along(J[f'knee.{side}'], J[f'ankle.{side}']) as L:
            for t in (0.45, 0.62, 0.78):
                b.ring_band('leather_dark', L * t, 0.083, 0.087, 0.018, 0.01, f'shin.{side}', seg=14, y=0.005)
    # fur mantle over the shoulders and a short fur cape
    for i in range(34):
        a = TAU * i / 34
        rx, ry = 0.24, 0.17
        p = V(math.sin(a) * rx, -math.cos(a) * ry + 0.01, 1.44)
        tip = p + V(math.sin(a) * 0.08, -math.cos(a) * 0.05, -0.12)
        b.tube('fur', [p, p.lerp(tip, 0.5) + V(0, 0, 0.015), tip], [0.05, 0.035, 0.0], w_torso(J), seg=6)
    b.loft('fur', [(1.38, 0.25, 0.18), (1.46, 0.23, 0.16), (1.5, 0.14, 0.11)], w_torso(J), seg=24, cap0=False, y=0.01)
    cape(b, 'fur', 1.46, 0.82, 0.24, 0.3, depth_top=0.16, depth_bot=0.25, folds=4, fold_amp=0.02, wrap=0.46, thick=0.03,
         hem=lambda u: 0.06 * abs(math.sin(u * math.pi * 6)))
    # head: rugged face, wild red hair, braided beard, horned helm
    neck(b, sk, 0.07)
    head(b, sk, brows='hair_red', s=1.02)
    with b.frame(*J['head'], s=1.02):
        b.loft('hair_red', [(0.0, 0.07, 0.04, 0, -0.06), (0.05, 0.085, 0.06, 0, -0.045), (0.09, 0.09, 0.06, 0, -0.04), (0.11, 0.05, 0.03, 0, -0.065)], 'head', seg=14,
               cap0=True)
        b.ellipsoid('hair_red', 0.05, 0.02, 0.012, 'head', seg=10, n=4, y=-0.108, z=0.068, rx=0.2)
        for sx in (-1, 1):
            b.tube('hair_red', [V(sx * 0.025, -0.1, 0.03), V(sx * 0.03, -0.11, -0.04), V(sx * 0.028, -0.1, -0.12), V(sx * 0.025, -0.09, -0.18)],
                   [0.022, 0.02, 0.016, 0.012], w_zchain((0.0, 'head'), (-0.1, 'neck'), (-0.18, 'chest')), seg=8)
            b.ring_band('gold', -0.16, 0.02, 0.02, 0.018, 0.008, w_zchain((0.0, 'head'), (-0.1, 'neck'), (-0.18, 'chest')), seg=8, x=sx * 0.026, y=-0.093)
        # long hair down the back
        for i in range(9):
            a = rad(-80 + i * 20)
            p = V(math.sin(a) * 0.095, math.cos(a) * 0.1 + 0.02, 0.2)
            b.tube('hair_red', [p, p + V(math.sin(a) * 0.03, 0.04, -0.12), p + V(math.sin(a) * 0.04, 0.07, -0.25), p + V(math.sin(a) * 0.03, 0.08, -0.33)],
                   [0.03, 0.028, 0.02, 0.0], w_zchain((0.0, 'head'), (-0.12, 'neck'), (-0.25, 'chest')), seg=7)
        helm = [(0.12, 0.112, 0.128, 0, 0.012), (0.2, 0.108, 0.122, 0, 0.012), (0.26, 0.08, 0.09, 0, 0.012), (0.3, 0.0, 0.0, 0, 0.012)]
        b.loft('steel', helm, 'head', seg=20)
        b.ring_band('bronze', 0.13, 0.117, 0.133, 0.03, 0.012, 'head', seg=20, y=0.012)
        front_strip(b, 'bronze', helm, 0.14, 0.28, 0.025, 'head')
        b.box('steel', 0.022, 0.012, 0.09, 'head', bevel=0.004, y=-0.13, z=0.1)
        for i in range(10):
            a = TAU * i / 10
            p = surf([(0.13, 0.117, 0.133, 0, 0.012)], 0.13, a, 0.004)
            b.sphere('steel', 0.009, 'head', seg=8, n=4, x=p.x, y=p.y, z=p.z)
        for sx in (-1, 1):
            pts = [V(sx * 0.1, 0.0, 0.2), V(sx * 0.17, -0.01, 0.23), V(sx * 0.23, -0.03, 0.3), V(sx * 0.25, -0.05, 0.38), V(sx * 0.23, -0.08, 0.44)]
            b.tube('horn', pts, [0.034, 0.03, 0.022, 0.013, 0.0], 'head', seg=10)
            b.ring_band('bronze', 0.0, 0.036, 0.036, 0.02, 0.008, 'head', seg=10, x=sx * 0.12, y=-0.002, z=0.21, ry=sx * rad(70))
    # great double axe held upright in the right hand
    g = grip_point(J, 'R', 0.05)
    d = V(0, 0.22, 1).normalized()
    with b.along(g - d * 0.62, g + d * 0.78):
        b.loft('wood_dark', [(0.0, 0.02, 0.02), (1.4, 0.019, 0.019)], 'hand.R', seg=10)
        b.sphere('steel', 0.032, 'hand.R', seg=10, n=5, z=0.0)
        for t in (0.52, 0.56, 0.6, 0.64, 0.68):
            b.ring_band('leather', t, 0.025, 0.025, 0.028, 0.008, 'hand.R', seg=10)
        b.cyl('steel_dark', 0.04, 0.036, 0.18, 'hand.R', seg=10, z=1.2)
        b.cyl('steel', 0.03, 0.0, 0.13, 'hand.R', seg=8, z=1.38)
        for sy in (-1, 1):
            def blade(u, v, sy=sy):
                span = lerp(0.14, 0.4, v ** 0.8)
                z = 1.29 + (u - 0.5) * span - 0.02 * v
                reach = 0.04 + v * 0.23 + 0.05 * (1 - (2 * u - 1) ** 2) * v
                return V(0, sy * reach, z)
            b.sheet('steel', blade, 8, 6, 'hand.R', thick=0.026)
            b.sheet('blade', lambda u, v, sy=sy: V(0, sy * (0.27 + 0.05 * (1 - (2 * u - 1) ** 2) + v * 0.02), 1.29 + (u - 0.5) * 0.4 - 0.02), 10, 1,
                    'hand.R', thick=0.012)
            b.sphere('gold', 0.018, 'hand.R', seg=8, n=4, x=0.014 * 0, y=sy * 0.09, z=1.29)


def vampire(b):
    J = b.J
    T = TORSO
    sk = 'skin_pale'
    # doublet: crimson velvet with gold buttons, black waistcoat front
    coat = grow(T, 0.008)
    with b.frame(s=(0.95, 0.97, 1.0)):
        b.loft('velvet_red', coat, w_torso(J), seg=24)
        front_strip(b, 'velvet_black', coat, 0.95, 1.43, 0.11, w_torso(J), off=0.0)
        for i in range(6):
            z = 1.0 + i * 0.07
            p = surf(coat, z, 0.0, 0.012)
            for sx in (-1, 1):
                b.sphere('gold', 0.011, w_torso(J), seg=8, n=4, x=sx * 0.035, y=p.y - 0.002, z=z)
        b.ring_band('leather_dark', 0.99, 0.165, 0.123, 0.035, 0.01, 'hips', seg=24)
        b.box('gold', 0.045, 0.02, 0.04, 'hips', bevel=0.006, y=-0.13, z=0.99)
        # coat tails
        skirt(b, 'velvet_black', [(0.62, 0.22, 0.18), (0.8, 0.19, 0.145), (0.97, 0.168, 0.125)], 0.97, cap1=False)
    # ruffled jabot and medallion
    for i in range(4):
        b.ellipsoid('cloth_white', 0.05 - i * 0.004, 0.025, 0.028, 'chest', seg=12, n=5, y=-0.118 - i * 0.004, z=1.43 - i * 0.04)
    b.tube('gold', [V(-0.1, -0.1, 1.45), V(-0.06, -0.13, 1.3), V(0, -0.14, 1.22), V(0.06, -0.13, 1.3), V(0.1, -0.1, 1.45)], 0.006, 'chest', seg=6)
    b.ellipsoid('gold', 0.04, 0.012, 0.05, 'chest', seg=14, n=6, y=-0.14, z=1.2)
    b.ellipsoid('glow_red', 0.024, 0.012, 0.032, 'chest', seg=12, n=6, y=-0.152, z=1.2)
    # epaulettes
    for side, sg in (('L', 1), ('R', -1)):
        a = J[f'arm.{side}']
        wsh = w_near(J, f'shoulder.{side}', f'upper_arm.{side}', power=3)
        b.ellipsoid('velvet_black', 0.075, 0.08, 0.05, wsh, seg=14, n=6, z0=-0.005, x=a.x + sg * 0.01, y=a.y, z=a.z + 0.01, ry=sg * rad(25))
        for i in range(7):
            ang = rad(-60 + i * 20)
            p = V(a.x + sg * (0.05 + 0.03 * math.cos(ang)), a.y + 0.07 * math.sin(ang), a.z - 0.01)
            b.tube('gold', [p, p + V(sg * 0.01, 0, -0.05)], 0.006, wsh, seg=5)
        arm(b, side, 'velvet_red', 'velvet_red', hand='claw' if side == 'L' else 'fist', hand_mat=sk, r=0.95)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            b.loft('cloth_white', [(L - 0.03, 0.045, 0.043), (L + 0.03, 0.06, 0.058), (L + 0.03, 0.03, 0.03)], w_near(J, f'forearm.{side}', f'hand.{side}'), seg=14, cap0=False)
            b.loft('velvet_black', [(L - 0.1, 0.048, 0.046), (L - 0.03, 0.055, 0.053), (L - 0.02, 0.04, 0.04)], f'forearm.{side}', seg=14, cap0=False)
    for side in ('L', 'R'):
        leg(b, side, 'cloth_dark', 'cloth_dark', r=0.92)
        boot(b, side, 'leather_dark', sole='leather_dark', shaft=0.42, r=1.02, cuff=1.15, toe=1.05)
    # head: gaunt pale face, slick black hair with a widow's peak, pointed ears, glowing eyes
    neck(b, sk, 0.05)
    head(b, sk, eye='glow_red', brows='hair_black', pointed_ears=True, lips='velvet_red', s=0.98)
    with b.frame(*J['head'], s=0.98):
        hair = [(0.07, 0.1, 0.075, 0, 0.065), (0.13, 0.106, 0.1, 0, 0.035), (0.18, 0.106, 0.12, 0, 0.012), (0.22, 0.092, 0.108, 0, 0.012),
                (0.25, 0.06, 0.07, 0, 0.012), (0.262, 0.0, 0.0, 0, 0.014)]
        b.loft('hair_black', hair, 'head', seg=20)
        b.loft('hair_black', [(0.0, 0.0, 0.0), (0.03, 0.022, 0.006), (0.05, 0.0, 0.0)], 'head', seg=4, sq=1.0, y=-0.112, z=0.155)
        b.ellipsoid('hair_black', 0.075, 0.05, 0.06, 'head', seg=14, n=6, y=0.09, z=0.08)
        for sx in (-1, 1):
            b.cyl('bone', 0.004, 0.0, 0.014, 'head', seg=5, x=sx * 0.012, y=-0.1, z=0.047, rx=math.pi)
        b.ring_band('gold', 0.2, 0.105, 0.118, 0.012, 0.006, 'head', seg=20, y=0.012)
        b.ellipsoid('glow_red', 0.012, 0.006, 0.016, 'head', seg=8, n=4, y=-0.118, z=0.205)
    # high-collared cape: black outside, faction-coloured lining
    hem = lambda u: 0.07 * abs(math.sin(u * math.pi * 5))  # noqa: E731
    cape(b, 'velvet_black', 1.46, 0.12, 0.2, 0.44, depth_top=0.14, depth_bot=0.38, folds=7, fold_amp=0.03, wrap=0.58, thick=0.012, hem=hem)
    cape(b, 'accent', 1.44, 0.14, 0.19, 0.42, depth_top=0.125, depth_bot=0.36, folds=7, fold_amp=0.03, wrap=0.56, thick=0.008, hem=hem)

    def collar(u, v, inner=0.0):
        a = (u - 0.5) * math.pi * 1.25
        z = lerp(1.45, 1.86, v)
        r = lerp(0.13, 0.26, v ** 1.4) - inner
        tip = 0.06 * v * abs(math.sin(u * math.pi * 3)) * (1 if v > 0.9 else 0)
        return V(math.sin(a) * r * 1.05, math.cos(a) * r * 0.85 + 0.03, z + tip)
    wc = w_zchain((1.5, 'chest'), (1.45, 'chest'))
    b.sheet('velvet_black', collar, 16, 6, wc, thick=0.012)
    b.sheet('accent', lambda u, v: collar(u, v, 0.012), 16, 6, wc, thick=0.006)
    for sx in (-1, 1):
        b.ellipsoid('gold', 0.025, 0.012, 0.025, 'chest', seg=10, n=5, x=sx * 0.13, y=-0.08, z=1.44)
    b.tube('gold', [V(-0.13, -0.085, 1.44), V(0, -0.12, 1.36), V(0.13, -0.085, 1.44)], 0.005, 'chest', seg=5)
    # rapier held low
    g = grip_point(J, 'R', 0.05)
    d = V(0, -0.75, -0.55).normalized()
    with b.along(g - d * 0.09, g + d * 1.0):
        b.loft('leather_dark', [(0.03, 0.014, 0.014), (0.17, 0.014, 0.014)], 'hand.R', seg=8)
        b.sphere('gold', 0.024, 'hand.R', seg=10, n=5, z=0.02)
        b.box('gold', 0.18, 0.018, 0.018, 'hand.R', bevel=0.005, z=0.18)
        b.tube('gold', [V(0.0, 0, 0.18), V(-0.05, 0.0, 0.13), V(-0.045, 0, 0.06), V(0.0, 0, 0.03)], 0.006, 'hand.R', seg=6)
        b.ellipsoid('gold', 0.045, 0.04, 0.012, 'hand.R', seg=12, n=5, z=0.19)
        b.loft('blade', [(0.19, 0.012, 0.006), (0.9, 0.008, 0.004), (1.08, 0.0, 0.0)], 'hand.R', seg=4, sq=1.0, smooth=False)


def mage(b):
    J = b.J
    robe = grow(TORSO, 0.012)
    b.loft('cloth_blue', [r for r in robe if r[0] >= 0.98], w_torso(J), seg=24)
    rob = [(0.12, 0.3, 0.27), (0.13, 0.32, 0.29), (0.4, 0.27, 0.23), (0.7, 0.22, 0.17), (0.9, 0.19, 0.145), (1.02, 0.177, 0.132)]
    skirt(b, 'cloth_blue', [(0.35, 0.28, 0.24)] + rob, 1.0)
    b.loft('gold', [(0.12, 0.305, 0.275), (0.12, 0.325, 0.295), (0.16, 0.316, 0.286), (0.16, 0.3, 0.27)], w_skirt(1.0), seg=24, cap0=False, cap1=False)
    b.loft('gold', [(0.23, 0.3, 0.265), (0.23, 0.312, 0.277), (0.25, 0.308, 0.273), (0.25, 0.3, 0.265)], w_skirt(1.0), seg=24, cap0=False, cap1=False)
    # rope belt with pouches, a scroll and a potion
    b.ring_band('rope', 1.02, 0.19, 0.145, 0.03, 0.015, 'hips', seg=24)
    b.tube('rope', [V(0.06, -0.15, 1.02), V(0.07, -0.18, 0.85), V(0.065, -0.2, 0.7)], 0.011, w_skirt(1.02, 0.2), seg=6)
    b.sphere('rope', 0.02, w_skirt(1.02, 0.2), x=0.065, y=-0.2, z=0.69)
    b.ellipsoid('leather', 0.05, 0.035, 0.06, 'hips', seg=12, n=6, x=-0.15, y=-0.08, z=0.95)
    b.cyl('cloth_white', 0.022, 0.022, 0.16, 'hips', seg=10, x=0.17, y=0.02, z=0.9, ry=0.3)
    b.ellipsoid('glow_blue', 0.03, 0.03, 0.035, 'hips', seg=10, n=5, x=0.18, y=-0.07, z=0.94)
    b.cyl('wood', 0.01, 0.01, 0.03, 'hips', seg=6, x=0.18, y=-0.07, z=0.97)
    # stole in the faction colour
    for sx in (-1, 1):
        b.sheet('accent', lambda u, v, sx=sx: V(sx * (0.07 + u * 0.075 + v * 0.01), -(ring_at(robe, max(1.0, lerp(1.45, 0.6, v)))[1]) - 0.02 - 0.12 * smooth(1.0, 0.6, lerp(1.45, 0.6, v)),
                                               lerp(1.45, 0.6, v)), 3, 10, blend_w(w_torso(J), w_skirt(1.0), lambda lo, co: smooth(1.02, 0.95, co.z)), thick=0.01)
    b.loft('accent', [(1.4, 0.2, 0.135), (1.44, 0.205, 0.14), (1.49, 0.13, 0.1)], w_torso(J), seg=24, cap0=False, cap1=False, y=-0.005)
    for side, sg in (('L', 1), ('R', -1)):
        arm(b, side, 'cloth_blue', None, hand='open' if side == 'L' else 'fist', hand_mat='skin', r=1.0)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            wf = w_near(J, f'upper_arm.{side}', f'forearm.{side}')
            b.loft('cloth_blue', [(-0.04, 0.05, 0.05), (L * 0.4, 0.07, 0.07), (L * 0.95, 0.11, 0.11, 0, 0.02), (L * 0.95, 0.1, 0.1, 0, 0.02), (L * 0.5, 0.04, 0.04)],
                   wf, seg=16, cap0=False, cap1=False)
            b.loft('gold', [(L * 0.9, 0.103, 0.103, 0, 0.018), (L * 0.95, 0.113, 0.113, 0, 0.02), (L * 0.95, 0.105, 0.105, 0, 0.02)], wf, seg=16, cap0=False, cap1=False)
            b.loft('skin', [(L * 0.6, 0.035, 0.033), (L + 0.01, 0.033, 0.03)], f'forearm.{side}', seg=10)
        leg(b, side, None, 'cloth_blue', r=0.9)
        boot(b, side, 'leather', shaft=0.12, toe=1.1)
    # spark above the open left hand
    gl = grip_point(J, 'L', 0.06)
    b.sphere('glow_blue', 0.035, 'hand.L', seg=12, n=6, x=gl.x, y=gl.y, z=gl.z + 0.09)
    for i in range(3):
        a = TAU * i / 3
        b.ellipsoid('glow_blue', 0.008, 0.008, 0.02, 'hand.L', seg=6, n=3, x=gl.x + math.cos(a) * 0.06, y=gl.y + math.sin(a) * 0.06, z=gl.z + 0.12 + i * 0.02)
    # old face, long beard, bushy brows, pointed hat
    neck(b, 'skin', 0.052)
    head(b, 'skin', brows='hair_white')
    wb = w_zchain((1.55, 'head'), (1.45, 'neck'), (1.32, 'chest'))
    with b.frame(*J['head']):
        b.loft('hair_white', [(-0.28, 0.0, 0.0, 0, -0.14), (-0.2, 0.05, 0.03, 0, -0.14), (-0.08, 0.08, 0.05, 0, -0.12), (0.02, 0.085, 0.055, 0, -0.085), (0.08, 0.075, 0.05, 0, -0.065), (0.1, 0.0, 0.0, 0, -0.06)],
               wb, seg=14)
        for sx in (-1, 1):
            b.tube('hair_white', [V(sx * 0.01, -0.105, 0.075), V(sx * 0.05, -0.105, 0.06), V(sx * 0.07, -0.095, 0.02)], [0.012, 0.012, 0.0], 'head', seg=7)
            b.ellipsoid('hair_white', 0.028, 0.02, 0.022, 'head', seg=10, n=5, x=sx * 0.04, y=-0.11, z=0.16)
        b.ellipsoid('hair_white', 0.1, 0.07, 0.12, wb, seg=14, n=6, y=0.07, z=0.04)
        hat = [(0.155, 0.28, 0.27, 0, 0.0), (0.175, 0.28, 0.27, 0, 0.0), (0.18, 0.13, 0.14, 0, 0.005), (0.28, 0.1, 0.1, 0, 0.02),
               (0.38, 0.07, 0.07, 0, 0.05), (0.46, 0.04, 0.04, 0, 0.1), (0.5, 0.02, 0.02, 0, 0.16), (0.51, 0.0, 0.0, 0, 0.21)]
        b.loft('cloth_blue', [(0.15, 0.12, 0.135, 0, 0.005)] + hat, 'head', seg=24)
        b.loft('accent', [(0.18, 0.132, 0.142, 0, 0.005), (0.22, 0.124, 0.13, 0, 0.008)], 'head', seg=24, cap0=False, cap1=False)
        b.ellipsoid('gold', 0.03, 0.01, 0.03, 'head', seg=8, n=4, y=-0.14, z=0.21)
        for i in range(5):
            a = TAU * i / 5 + 0.3
            p = V(math.cos(a) * 0.2, math.sin(a) * 0.19, 0.18)
            b.ellipsoid('gold', 0.012, 0.012, 0.004, 'head', seg=5, n=2, x=p.x, y=p.y, z=p.z)
    # staff: knotted wood with claws holding the orb
    g = grip_point(J, 'R', 0.05)
    base, top = V(g.x, g.y - 0.02, 0.02), V(g.x, g.y + 0.02, 1.95)
    pts = [base.lerp(top, t) + V(0.012 * math.sin(t * 17), 0.01 * math.cos(t * 13), 0) for t in [i / 14 for i in range(15)]]
    b.tube('wood', pts, [0.02 + 0.006 * (i / 14) for i in range(15)], 'hand.R', seg=8)
    for t in (0.3, 0.55, 0.78):
        p = base.lerp(top, t)
        b.ellipsoid('wood', 0.03, 0.03, 0.022, 'hand.R', seg=8, n=4, x=p.x, y=p.y, z=p.z)
    b.ring_band('gold', top.z - 0.05, 0.03, 0.03, 0.04, 0.01, 'hand.R', seg=12, x=top.x, y=top.y)
    orb = top + V(0, 0, 0.1)
    for i in range(3):
        a = TAU * i / 3
        b.tube('wood', [top - V(0, 0, 0.02), top + V(math.cos(a) * 0.06, math.sin(a) * 0.06, 0.05), orb + V(math.cos(a) * 0.07, math.sin(a) * 0.07, 0.03),
                        orb + V(math.cos(a) * 0.03, math.sin(a) * 0.03, 0.1)], [0.018, 0.014, 0.01, 0.0], 'hand.R', seg=6)
    b.sphere('glow_blue', 0.06, 'hand.R', seg=16, n=8, x=orb.x, y=orb.y, z=orb.z)


def rogue(b):
    J = b.J
    T = TORSO
    jerk = grow(T, 0.01)
    b.loft('leather', [r for r in jerk if r[0] >= 0.84], w_torso(J), seg=24)
    front_strip(b, 'leather_dark', jerk, 0.86, 1.45, 0.02, w_torso(J), off=0.0)
    for i in range(7):
        z = 0.92 + i * 0.075
        p = surf(jerk, z, 0.0, 0.01)
        b.box('steel', 0.04, 0.012, 0.012, w_torso(J), bevel=0.003, y=p.y, z=z)
    # bandolier with throwing knives
    pts = [V(0.17, -0.105, 1.44), V(0.05, -0.155, 1.3), V(-0.1, -0.15, 1.12), V(-0.18, -0.1, 0.98)]
    b.tube('leather_dark', pts, 0.016, w_torso(J), seg=8)
    b.tube('leather_dark', [V(0.17, 0.105, 1.44), V(0.02, 0.15, 1.28), V(-0.12, 0.14, 1.1), V(-0.18, 0.1, 0.98)], 0.016, w_torso(J), seg=8)
    for t in (0.25, 0.4, 0.55):
        p = pts[1].lerp(pts[2], t * 1.2) + V(0, -0.02, 0)
        b.box('steel', 0.016, 0.006, 0.08, w_torso(J), x=p.x, y=p.y, z=p.z + 0.03, ry=0.8)
    b.ring_band('leather_dark', 0.97, 0.182, 0.137, 0.04, 0.012, 'hips', seg=24)
    b.box('steel', 0.04, 0.02, 0.04, 'hips', bevel=0.005, y=-0.143, z=0.97)
    for x, y in ((0.15, -0.08), (-0.1, -0.13), (0.17, 0.05)):
        b.box('leather', 0.06, 0.035, 0.07, 'hips', bevel=0.012, x=x, y=y, z=0.91, rz=math.atan2(x, -y))
    skirt(b, 'leather', [(0.74, 0.205, 0.16), (0.86, 0.19, 0.145), (0.97, 0.178, 0.133)], 0.97, cap1=False)
    for side, sg in (('L', 1), ('R', -1)):
        arm(b, side, 'cloth_grey', 'cloth_grey', hand='fist', hand_mat='leather_dark', r=0.95)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            b.loft('leather_dark', [(L * 0.3, 0.052, 0.05), (L * 0.35, 0.057, 0.055), (L + 0.03, 0.05, 0.048), (L + 0.03, 0.035, 0.035)],
                   w_near(J, f'forearm.{side}', f'hand.{side}'), seg=14, cap0=False)
            for t in (0.5, 0.75):
                b.ring_band('leather', L * t, 0.06, 0.058, 0.012, 0.006, f'forearm.{side}', seg=14)
        with b.along(J[f'arm.{side}'], J[f'elbow.{side}']) as L:
            b.loft('leather', [(-0.04, 0.07, 0.07), (0.0, 0.078, 0.076), (0.06, 0.07, 0.068), (0.08, 0.055, 0.055)], w_near(J, f'shoulder.{side}', f'upper_arm.{side}', power=3),
                   seg=14, cap0=False)
        leg(b, side, 'cloth_grey', 'cloth_grey', r=0.95)
        boot(b, side, 'leather', shaft=0.36, r=1.0, cuff=1.12, cuff_mat='leather_dark', toe=1.02)
        with b.along(J[f'knee.{side}'], J[f'ankle.{side}']) as L:
            b.ring_band('leather_dark', L * 0.55, 0.068, 0.07, 0.014, 0.006, f'shin.{side}', seg=14, y=0.005)
        b.ring_band('leather_dark', 0.7, 0.1, 0.1, 0.03, 0.01, w_near(J, f'thigh.{side}', f'shin.{side}'), seg=14,
                    x=J[f'leg.{side}'].lerp(J[f'knee.{side}'], 0.55).x, y=J[f'leg.{side}'].lerp(J[f'knee.{side}'], 0.55).y - 0.005)
    # dagger in the thigh sheath
    b.box('leather_dark', 0.035, 0.02, 0.14, 'thigh.R', bevel=0.006, x=-0.2, y=-0.02, z=0.67)
    b.box('leather_dark', 0.015, 0.015, 0.06, 'thigh.R', bevel=0.004, x=-0.2, y=-0.02, z=0.77)
    # face: shadowed, masked, under a deep hood
    neck(b, 'skin', 0.05)
    head(b, 'skin', brows='hair_black', ears=False)
    wh = w_zchain((1.62, 'head'), (1.5, 'neck'), (1.42, 'chest'))
    with b.frame(*J['head']):
        b.loft('cloth_dark', [(0.0, 0.09, 0.09, 0, -0.03), (0.04, 0.098, 0.1, 0, -0.03), (0.105, 0.105, 0.11, 0, -0.012)], 'head', seg=18, cap0=False)

        hood = [(0.0, 0.125, 0.125, 0, 0.03), (0.08, 0.13, 0.138, 0, 0.02), (0.18, 0.128, 0.138, 0, 0.012), (0.25, 0.105, 0.12, 0, 0.03),
                (0.29, 0.06, 0.08, 0, 0.07)]
        b.sheet('accent', lambda u, v: hood_surface(hood, lerp(-2.35, 2.35, u), lerp(-0.07, 0.29, v)), 18, 10, wh, thick=0.014)
        b.loft('accent', [(0.26, 0.05, 0.06, 0, 0.12), (0.3, 0.02, 0.02, 0, 0.2), (0.3, 0.0, 0.0, 0, 0.22)], 'head', seg=10)
    # short hooded cape
    cape(b, 'accent', 1.48, 0.95, 0.22, 0.32, depth_top=0.15, depth_bot=0.26, folds=5, fold_amp=0.02, wrap=0.6, thick=0.012)
    b.loft('accent', [(1.4, 0.23, 0.17), (1.47, 0.21, 0.155), (1.52, 0.11, 0.095)], w_torso(J), seg=24, cap0=False, cap1=False, y=0.01)
    b.sphere('steel', 0.02, 'chest', x=0.0, y=-0.12, z=1.46)
    # quiver with arrows on the back
    q0, q1 = V(-0.1, 0.17, 0.98), V(0.12, 0.2, 1.52)
    with b.along(q0, q1) as L:
        b.loft('leather', [(0.0, 0.05, 0.045), (0.02, 0.055, 0.05), (L, 0.058, 0.052), (L, 0.05, 0.045)], 'chest', seg=12, cap1=False)
        b.ring_band('leather_dark', L * 0.3, 0.058, 0.053, 0.02, 0.006, 'chest', seg=12)
        b.ring_band('leather_dark', L * 0.8, 0.06, 0.055, 0.02, 0.006, 'chest', seg=12)
        for i in range(6):
            a = TAU * i / 6
            x, y = math.cos(a) * 0.025, math.sin(a) * 0.022
            b.cyl('wood', 0.004, 0.004, 0.14, 'chest', seg=5, x=x, y=y, z=L - 0.02)
            for k in range(2):
                b.box('feather', 0.004, 0.03, 0.06, 'chest', x=x, y=y, z=L + 0.09, rz=a + k * math.pi / 2)
    b.tube('leather_dark', [q0 + V(0, -0.03, 0.05), V(0.05, -0.02, 1.45), q1 + V(0, -0.04, -0.06)], 0.012, 'chest', seg=6)
    # recurve bow in the left hand, dagger in the right
    g = grip_point(J, 'L', 0.05)
    bow = []
    for i in range(17):
        t = (i / 16) * 2 - 1
        z = t * 0.62
        y = -0.1 * (1 - t * t) + 0.06 * max(0.0, abs(t) - 0.75) / 0.25
        bow.append(g + V(0, y + 0.1, z))
    b.tube('wood_dark', bow, [0.012 + 0.012 * (1 - abs((i / 16) * 2 - 1)) for i in range(17)], 'hand.L', seg=8)
    b.tube('cloth_white', [bow[1] + V(0, 0.0, 0), bow[-2] + V(0, 0.0, 0)], 0.0025, 'hand.L', seg=4)
    b.ring_band('leather_dark', g.z, 0.024, 0.024, 0.07, 0.006, 'hand.L', seg=10, x=g.x, y=g.y + 0.0)
    g = grip_point(J, 'R', 0.05)
    d = V(0, -1, -0.25).normalized()
    with b.along(g - d * 0.06, g + d * 0.36):
        b.loft('leather_dark', [(0.0, 0.013, 0.013), (0.1, 0.013, 0.013)], 'hand.R', seg=8)
        b.sphere('steel', 0.018, 'hand.R', seg=8, n=4)
        b.box('steel', 0.1, 0.018, 0.015, 'hand.R', bevel=0.004, z=0.1)
        b.loft('blade', [(0.105, 0.022, 0.005), (0.3, 0.014, 0.004), (0.37, 0.0, 0.0)], 'hand.R', seg=4, sq=1.0, smooth=False)


def druid(b):
    J = b.J
    robe = grow(TORSO, 0.012)
    b.loft('cloth_moss', [r for r in robe if r[0] >= 0.98], w_torso(J), seg=24)
    rob = [(0.1, 0.31, 0.28), (0.4, 0.27, 0.23), (0.7, 0.22, 0.17), (0.9, 0.19, 0.145), (1.02, 0.177, 0.132)]
    skirt(b, 'cloth_moss', [(0.35, 0.28, 0.24), (0.1, 0.3, 0.27)] + rob, 1.0)
    # ragged hem strips
    for i in range(30):
        a = TAU * i / 30
        L = 0.05 + 0.04 * ((i * 7) % 5) / 4
        p = V(math.sin(a) * 0.3, -math.cos(a) * 0.27, 0.12)
        b.sheet('cloth_moss', lambda u, v, a=a, L=L: V((u - 0.5) * 0.06, 0, -v * L), 1, 2, w_skirt(1.0), thick=0.01, x=p.x, y=p.y, z=p.z, rz=-a)
    # belt of rope, golden sickle, herb pouch and faction sash
    b.ring_band('rope', 1.01, 0.19, 0.145, 0.035, 0.015, 'hips', seg=24)
    b.sheet('accent', lambda u, v: V(0.05 + (u - 0.5) * 0.07 + v * 0.02, -0.17 - 0.07 * smooth(0, 1, v), lerp(1.0, 0.55, v)), 2, 8, w_skirt(1.0, 0.2), thick=0.01)
    b.sheet('accent', lambda u, v: V(-0.05 + (u - 0.5) * 0.07 - v * 0.02, -0.17 - 0.07 * smooth(0, 1, v), lerp(1.0, 0.6, v)), 2, 8, w_skirt(1.0, 0.2), thick=0.01)
    b.ring_band('accent', 1.01, 0.195, 0.15, 0.05, 0.008, 'hips', seg=24)
    with b.frame(-0.19, -0.02, 0.96, rz=rad(90)):
        b.sheet('gold', lambda u, v: V(math.cos(lerp(-1.2, 1.6, u)) * lerp(0.08, 0.06, v), 0, math.sin(lerp(-1.2, 1.6, u)) * lerp(0.08, 0.06, v)), 10, 1, 'hips', thick=0.006)
        b.cyl('wood', 0.012, 0.012, 0.07, 'hips', x=0.08, z=-0.1, rx=0.0)
    b.ellipsoid('leather', 0.055, 0.04, 0.065, 'hips', seg=12, n=6, x=0.17, y=-0.07, z=0.93)
    for i in range(4):
        b.ellipsoid('leaf', 0.01, 0.004, 0.035, 'hips', seg=6, n=3, x=0.17 + (i - 1.5) * 0.012, y=-0.1, z=1.0, ry=(i - 1.5) * 0.3)
    # leaf mantle over the shoulders
    import random
    rng = random.Random(9)
    for ring in range(3):
        n = 24 - ring * 4
        for i in range(n):
            a = TAU * (i + ring * 0.5) / n
            rx, ry = 0.25 - ring * 0.04, 0.18 - ring * 0.03
            p = V(math.sin(a) * rx, -math.cos(a) * ry + 0.01, 1.4 + ring * 0.04)
            m = 'leaf_autumn' if rng.random() < 0.25 else 'leaf'
            with b.frame(p.x, p.y, p.z, rz=-a, rx=rad(rng.uniform(150, 170))):
                b.loft(m, [(0.0, 0.0, 0.0), (0.02, 0.025, 0.006), (0.07, 0.03, 0.006), (0.12, 0.012, 0.004), (0.14, 0.0, 0.0)], w_torso(J), seg=6)
    b.loft('cloth_brown', [(1.36, 0.23, 0.17), (1.44, 0.215, 0.155), (1.5, 0.12, 0.1)], w_torso(J), seg=24, cap0=False, y=0.01)
    # wooden bead necklace with a tooth
    for i in range(13):
        a = rad(-70 + i * (140 / 12))
        b.sphere('wood', 0.013, 'chest', seg=8, n=4, x=math.sin(a) * 0.12, y=-math.cos(a) * 0.1 - 0.035 - 0.05 * math.cos(a) ** 6, z=1.44 - 0.1 * math.cos(a) ** 4)
    b.cyl('bone', 0.012, 0.0, 0.05, 'chest', seg=6, y=-0.14, z=1.33, rx=math.pi)
    for side in ('L', 'R'):
        arm(b, side, 'cloth_moss', None, hand='open' if side == 'L' else 'fist', hand_mat='skin_tan', r=1.0)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            wf = w_near(J, f'upper_arm.{side}', f'forearm.{side}')
            b.loft('cloth_moss', [(-0.04, 0.05, 0.05), (L * 0.5, 0.065, 0.065), (L * 0.9, 0.085, 0.085, 0, 0.012), (L * 0.9, 0.075, 0.075, 0, 0.012), (L * 0.5, 0.04, 0.04)],
                   wf, seg=16, cap0=False, cap1=False)
            b.loft('skin_tan', [(L * 0.6, 0.035, 0.033), (L + 0.01, 0.033, 0.03)], f'forearm.{side}', seg=10)
            for t in (0.7, 0.8):
                b.ring_band('leather', L * t + 0.1, 0.04, 0.038, 0.012, 0.006, f'forearm.{side}', seg=10)
        leg(b, side, None, 'cloth_brown', r=0.9)
        boot(b, side, 'leather', shaft=0.2, toe=1.0)
        a = J[f'ankle.{side}']
        for z in (0.1, 0.16, 0.22):
            b.ring_band('leather_dark', z, 0.058, 0.063, 0.012, 0.006, w_near(J, f'shin.{side}', f'foot.{side}'), seg=12, x=a.x, y=a.y + 0.005)
    # green wisp above the open left hand
    gl = grip_point(J, 'L', 0.06)
    b.ellipsoid('glow_green', 0.03, 0.03, 0.045, 'hand.L', seg=12, n=6, x=gl.x, y=gl.y, z=gl.z + 0.1)
    # head: bearded, in a hood crowned with antlers
    neck(b, 'skin_tan', 0.052)
    head(b, 'skin_tan', brows='hair_grey')
    wb = w_zchain((1.55, 'head'), (1.45, 'neck'), (1.32, 'chest'))
    with b.frame(*J['head']):
        b.loft('hair_grey', [(-0.2, 0.0, 0.0, 0, -0.12), (-0.12, 0.05, 0.03, 0, -0.12), (-0.02, 0.08, 0.05, 0, -0.1), (0.06, 0.08, 0.05, 0, -0.065), (0.09, 0.0, 0.0, 0, -0.06)], wb, seg=14)
        for sx in (-1, 1):
            b.tube('hair_grey', [V(sx * 0.01, -0.105, 0.075), V(sx * 0.05, -0.1, 0.055), V(sx * 0.065, -0.09, 0.0)], [0.011, 0.011, 0.0], 'head', seg=7)
        hood = [(0.0, 0.12, 0.12, 0, 0.03), (0.08, 0.128, 0.135, 0, 0.02), (0.18, 0.125, 0.135, 0, 0.012), (0.26, 0.1, 0.11, 0, 0.02), (0.31, 0.05, 0.06, 0, 0.04), (0.32, 0.0, 0.0, 0, 0.05)]

        b.sheet('cloth_brown', lambda u, v: hood_surface(hood, lerp(-2.4, 2.4, u), lerp(-0.06, 0.32, v)), 18, 10, wb, thick=0.014)
        b.loft('cloth_brown', [(-0.12, 0.14, 0.13, 0, 0.02), (-0.03, 0.13, 0.13, 0, 0.03), (0.0, 0.12, 0.12, 0, 0.03)], wb, seg=18, cap0=False, cap1=False)
        # antlers
        for sx in (-1, 1):
            base = V(sx * 0.09, 0.02, 0.24)
            main = [base, base + V(sx * 0.06, 0.0, 0.08), base + V(sx * 0.1, 0.03, 0.18), base + V(sx * 0.12, 0.07, 0.28), base + V(sx * 0.11, 0.1, 0.34)]
            b.tube('horn', main, [0.018, 0.016, 0.013, 0.009, 0.0], 'head', seg=8)
            for (t0, off) in ((1, V(sx * 0.02, -0.07, 0.1)), (2, V(sx * 0.08, -0.03, 0.1)), (3, V(-sx * 0.02, -0.04, 0.09))):
                p = main[t0]
                b.tube('horn', [p, p + off * 0.5 + V(0, 0, 0.02), p + off], [0.011, 0.008, 0.0], 'head', seg=6)
            b.ellipsoid('leaf', 0.015, 0.005, 0.03, 'head', seg=6, n=3, x=main[1].x, y=main[1].y - 0.015, z=main[1].z, ry=sx * 0.6)
    # living staff: twisted wood looping round a green crystal, leaves and a feather charm
    g = grip_point(J, 'R', 0.05)
    base, top = V(g.x, g.y - 0.02, 0.02), V(g.x, g.y + 0.02, 1.78)
    pts = [base.lerp(top, t) + V(0.012 * math.sin(t * 19), 0.012 * math.cos(t * 11), 0) for t in [i / 16 for i in range(17)]]
    b.tube('wood', pts, [0.02 + 0.008 * (i / 16) for i in range(17)], 'hand.R', seg=8)
    cen = top + V(0, 0, 0.14)
    for k in range(2):
        loop = []
        for i in range(19):
            a = -math.pi / 2 + TAU * i / 18 * 0.95 + k * 0.4
            loop.append(cen + V(0.018 * k, math.cos(a) * 0.11, math.sin(a) * 0.13))
        b.tube('wood', [top] + loop, [0.022] + [0.02 - 0.012 * (i / 18) for i in range(19)], 'hand.R', seg=7)
    with b.frame(cen.x, cen.y, cen.z - 0.07):
        b.cyl('glow_green', 0.0001, 0.035, 0.05, 'hand.R', seg=6)
        b.cyl('glow_green', 0.035, 0.0, 0.1, 'hand.R', seg=6, z=0.05)
    for i in range(7):
        t = 0.55 + i * 0.06
        p = pts[int(t * 16)]
        a = i * 2.4
        b.loft('leaf' if i % 3 else 'leaf_autumn', [(0.0, 0.0, 0.0), (0.015, 0.02, 0.005), (0.05, 0.022, 0.005), (0.09, 0.0, 0.0)], 'hand.R', seg=6,
               x=p.x + math.cos(a) * 0.02, y=p.y + math.sin(a) * 0.02, z=p.z, rz=a, ry=rad(60))
    ch = top + V(0.0, -0.03, -0.12)
    b.tube('rope', [top + V(0, -0.02, -0.02), ch], 0.004, 'hand.R', seg=4)
    b.ellipsoid('bone', 0.012, 0.012, 0.018, 'hand.R', seg=6, n=3, x=ch.x, y=ch.y, z=ch.z)
    b.ellipsoid('feather', 0.004, 0.018, 0.06, 'hand.R', seg=6, n=3, x=ch.x, y=ch.y, z=ch.z - 0.05, rx=0.2)


# --- pipeline -----------------------------------------------------------------------------------------------

HEROES = [
    # name, builder, joint scale, joint overrides, walk style
    ('Paladin', paladin, (1.04, 1.0, 1.0), dict(
        elbow_R=(-0.29, -0.05, 1.2), wrist_R=(-0.3, -0.29, 1.15), hand_end_R=(-0.3, -0.39, 1.14),
        elbow_L=(0.3, 0.02, 1.2), wrist_L=(0.28, -0.22, 1.1), hand_end_L=(0.27, -0.31, 1.09)),
        dict(arm_L=0.25, arm_R=0.3, A=24, lean=3, cape=0.7)),
    ('Barbarian', barbarian, (1.1, 1.05, 1.02), dict(
        elbow_R=(-0.33, 0.02, 1.2), wrist_R=(-0.34, -0.2, 1.08), hand_end_R=(-0.34, -0.29, 1.05)),
        dict(arm_L=1.2, arm_R=0.25, A=27, K=58, lean=6, cape=0.5, B=26)),
    ('Vampire', vampire, (0.95, 0.95, 1.06), dict(),
        dict(arm_L=0.6, arm_R=0.5, A=22, lean=1, cape=1.0, B=16)),
    ('Mage', mage, (1.0, 1.0, 1.0), dict(
        elbow_R=(-0.28, -0.0, 1.19), wrist_R=(-0.3, -0.22, 1.1), hand_end_R=(-0.3, -0.31, 1.08),
        elbow_L=(0.28, 0.02, 1.19), wrist_L=(0.31, -0.2, 1.1), hand_end_L=(0.32, -0.3, 1.11)),
        dict(arm_L=0.3, arm_R=0.3, A=20, K=45, lean=4, cape=0.0)),
    ('Rogue', rogue, (0.97, 0.97, 0.98), dict(
        elbow_L=(0.28, 0.02, 1.18), wrist_L=(0.3, -0.19, 1.08), hand_end_L=(0.3, -0.28, 1.06)),
        dict(arm_L=0.35, arm_R=1.0, A=27, lean=7, cape=1.0, B=24)),
    ('Druid', druid, (1.0, 1.0, 1.0), dict(
        elbow_R=(-0.28, -0.0, 1.19), wrist_R=(-0.3, -0.22, 1.1), hand_end_R=(-0.3, -0.31, 1.08),
        elbow_L=(0.28, 0.02, 1.19), wrist_L=(0.31, -0.2, 1.1), hand_end_L=(0.32, -0.3, 1.11)),
        dict(arm_L=0.3, arm_R=0.3, A=21, K=48, lean=5, cape=0.0)),
]


def build_hero(coll, mats, name, fn, scale, over, style, index, bake):
    J = make_joints(scale, **over)
    b = Body(J)
    fn(b)
    ob = b.to_object(name + '_Mesh', coll, mats)
    ob.location = (index * 3.0, 0, 0)
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    lib.smart_uv(ob, margin=0.003)
    if bake:
        g = lib._bake_ground(coll, ob.location, size=1.5)
        img = bpy.data.images.get(name + '_atlas') or bpy.data.images.new(name + '_atlas', 1024, 1024)
        img.scale(1024, 1024)
        lib.bake_emit(ob, img)
        bpy.data.objects.remove(g, do_unlink=True)
        split_roles(ob, name, img)
    arm_ob = H.make_armature(name, J, coll, location=ob.location)
    H.bind(ob, arm_ob)
    sc = bpy.context.scene
    sc.render.fps = H.FPS
    walk, stride = H.walk_pose(J, 30, style)
    H.write_action(arm_ob, 'Walk', 30, walk)
    H.write_action(arm_ob, 'Idle', 90, H.idle_pose(J, 90, style))
    arm_ob['stride'] = round(stride, 4)
    arm_ob['height'] = round(max((ob.matrix_world @ v.co).z for v in ob.data.vertices), 3)
    print(f'{name}: {tris} tris, stride {stride:.3f} m/cycle, height {arm_ob["height"]}', flush=True)
    return arm_ob, ob


def split_roles(ob, name, img):
    roles = []
    idx = []
    for p in ob.data.polygons:
        key = ob.material_slots[p.material_index].material.name.replace('hero_', '')
        role = PALETTE[key][1]
        if role not in roles:
            roles.append(role)
        idx.append(roles.index(role))
    ob.data.materials.clear()
    for role in roles:
        metal, rough = ROLES[role]
        ob.data.materials.append(H.hero_export_material(f'{name}_{role.capitalize()}', img, metal, rough))
    for p, i in zip(ob.data.polygons, idx):
        p.material_index = i


def export_hero(arm_ob, mesh_ob, path):
    loc = tuple(arm_ob.location)
    arm_ob.location = (0, 0, 0)
    ctx = bpy.context
    for o in ctx.selected_objects:
        o.select_set(False)
    arm_ob.select_set(True)
    mesh_ob.select_set(True)
    ctx.view_layer.objects.active = arm_ob
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=False,
        export_texcoords=True, export_normals=True, export_vertex_color='NONE',
        export_image_format='JPEG', export_image_quality=88, export_materials='EXPORT',
        export_yup=True, export_cameras=False, export_lights=False, export_extras=True,
        export_skins=True, export_animations=True, export_animation_mode='NLA_TRACKS',
        export_force_sampling=True, export_optimize_animation_size=True, export_def_bones=False,
    )
    arm_ob.location = loc


def preview(arms, path, frame=None):
    sc = bpy.context.scene
    n = len(arms)
    for i, a in enumerate(arms):
        a.location = ((i - (n - 1) / 2) * 1.2, 0, 0)
        if frame is not None:
            for t in a.animation_data.nla_tracks:
                t.mute = t.name != 'Walk'
    sc.frame_set(frame if frame is not None else 0)
    if frame is None:
        for a in arms:
            for t in a.animation_data.nla_tracks:
                t.mute = True
        sc.frame_set(0)
    W = n * 0.65 + 1
    ground = bpy.data.objects.new('pv_ground', bpy.data.meshes.new('pv_ground'))
    ground.data.from_pydata([(-W - 3, -4, 0), (W + 3, -4, 0), (W + 3, 6, 0), (-W - 3, 6, 0)], [], [(0, 1, 2, 3)])
    gm = bpy.data.materials.get('pv_groundmat') or bpy.data.materials.new('pv_groundmat')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.12, 0.14, 0.07, 1)
    ground.data.materials.append(gm)
    sc.collection.objects.link(ground)
    sun = bpy.data.objects.new('pv_sun', bpy.data.lights.new('pv_sun', 'SUN'))
    sun.data.energy = 4.0
    sun.rotation_euler = (0.8, 0.2, 0.5)
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('pv_cam', bpy.data.cameras.new('pv_cam'))
    sc.collection.objects.link(cam)
    cam.data.lens = 50
    target = V(0, 0, 1.0)
    d = max(4.5, n * 1.75)
    ca = math.radians(float(os.environ.get('CAM_ANGLE', 0)))
    cam.location = target + V(math.sin(ca) * d, -math.cos(ca) * d, d * 0.28)
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.world = sc.world or bpy.data.worlds.new('W')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs[0].default_value = (0.5, 0.6, 0.75, 1)
    sc.world.node_tree.nodes['Background'].inputs[1].default_value = 0.8
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = (max(900, 420 * n), 900)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


if __name__ != 'build_heroes':  # run as a script (not when imported by build_units.py)
    _bake = os.environ.get('BAKE', '1') != '0'
    _only = os.environ.get('ONLY')
    lib.clear_startup_scene()
    _coll = lib.fresh_collection('Heroes')
    lib.setup_cycles(samples=16)
    _mats = make_materials()
    _built = []
    for _i, (_name, _fn, _scale, _over, _style) in enumerate(HEROES):
        if _only and _name not in _only.split(','):
            continue
        _built.append((_name, *build_hero(_coll, _mats, _name, _fn, _scale, _over, _style, _i, _bake)))
    if _bake and os.environ.get('EXPORT', '1') != '0':
        for _name, _arm, _mesh in _built:
            # heroes with a Meshy model (build_meshy_hero.py) keep it unless PROCEDURAL=1
            _meshy = os.path.join(HERE, '..', 'meshy', _name.lower(), 'walk.glb')
            if os.path.exists(_meshy) and os.environ.get('PROCEDURAL') != '1':
                print(f'{_name}: kept the Meshy model (PROCEDURAL=1 overwrites it)', flush=True)
                continue
            export_hero(_arm, _mesh, os.path.join(OUT_DIR, _name.lower() + '.glb'))
    if os.environ.get('PREVIEW'):
        _pose = os.environ.get('POSE')
        preview([a for _, a, _ in _built], os.environ['PREVIEW'], int(_pose) if _pose else None)
