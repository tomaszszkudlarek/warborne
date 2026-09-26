"""Builds the procedural army units and exports public/models/units/<unit>.glb.

Superseded by the Meshy units (build_meshy_hero.py for infantry, build_meshy_cavalry.py
for cavalry): running this overwrites them. horse_lib.py is still used by the cavalry.

    LightInfantry   spearman in a quilted gambeson (faction colour), kettle hat over a
                    mail coif, painted round shield and a leaf-bladed spear
    HeavyInfantry   blackened plate with gold trim, crested close helm, faction surcoat
                    and cape, great tower shield and a broadsword
    LightCavalry    outrider on a bay horse: bronze scale shirt, plumed open helm,
                    streaming cloak, round shield and a pennoned spear
    HeavyCavalry    knight with a winged great helm, heater shield and a striped lance on
                    a black destrier in a faction caparison and steel chanfron

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_units.py
    (env BAKE=0 skips the bake, ONLY=HeavyCavalry builds a subset, EXPORT=0 skips
     the GLB export, PREVIEW=/path.png renders a check image; CLIP=Walk|Run|Gallop
     and POSE=<frame> pose it, CAM_ANGLE=<deg> turns the camera)

Infantry use the hero skeleton (hero_lib) and carry Walk (1 s), Run (0.67 s) and Idle
(3 s) clips. Cavalry are one armature: the horse (horse_lib) with the rider's hips
hanging from its `saddle` bone; clips Walk (1.07 s), Gallop (0.6 s) and Idle (3 s).
In the gallop the knight couches his lance and the outrider raises his spear.
The armature carries `stride` (metres per Walk cycle), `run_stride` (per Run or
Gallop cycle) and `height` as glTF extras. Materials follow the heroes: *_Metal,
*_Base, *_Skin, *_Coat, *_Accent (faction colour) and *_Glow.
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/Users/tomaszszkudlarek/Projects/Warlords/tools/blender'
sys.path.insert(0, HERE)
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import lib  # noqa: E402
import hero_lib as H  # noqa: E402
import horse_lib as HL  # noqa: E402
import materials as M  # noqa: E402
import build_heroes as BH  # noqa: E402

for _m in (lib, H, HL, M, BH):
    importlib.reload(_m)

from hero_lib import Body, make_joints, w_torso, w_near, w_zchain, w_skirt, blend_w, smooth, lerp, rot, X, Y, Z  # noqa: E402
from build_heroes import (TORSO, grow, ring_at, surf, arc_band, front_strip, hood_surface, neck, head, arm, grip_point, leg, boot,  # noqa: E402
                          skirt, cape, p_metal, p_cloth, p_streaks, p_leather, _mul)

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(ROOT, 'public', 'models', 'units')
TAU = math.tau
rad = math.radians


def V(x, y, z):
    return Vector((x, y, z))


# --- materials -----------------------------------------------------------------------------------------


def p_coat(c, dark=None, knee=0.55, dapple=None):
    """Horse coat: sleek hair running along the body, darker 'points' below the knees."""
    def pat(k, co, pxy, sep):
        n = k.noise(co, 4.0, 3.0, 0.5)
        col = k.ramp(n, [(0.3, _mul(c, 0.8)), (0.7, _mul(c, 1.15))])
        hair = k.noise(k.vmath('MULTIPLY', co, (70.0, 10.0, 70.0)), 1.0, 2.0)
        col = k.mix(k.math('MULTIPLY', hair, 0.3), col, _mul(c, 0.72))
        if dapple:
            e = k.voronoi_edge(k.vmath('MULTIPLY', co, (1.0, 1.0, 1.0)), 9.0)
            d = k.math('MULTIPLY', k.math('SUBTRACT', 1.0, k.math('MULTIPLY', e, 9.0, clamp=True)), 0.6)
            col = k.mix(d, col, dapple)
        if dark:
            z = sep.outputs[2]
            f = k.math('MULTIPLY_ADD', z, -1 / 0.22, knee / 0.22, clamp=True)
            col = k.mix(f, col, dark)
        return col
    return pat


def p_quilt(c, scale=16.0, line=0.5):
    """Quilted cloth: diamond stitching lines over a soft cloth."""
    def pat(k, co, pxy, sep):
        base = p_cloth(c, 0.06, 0.12)(k, co, pxy, sep)
        x, z = sep.outputs[0], sep.outputs[2]
        y = sep.outputs[1]
        u = k.math('ADD', k.math('ADD', x, y), z)
        v = k.math('SUBTRACT', k.math('ADD', x, y), z)
        out = None
        for a in (u, v):
            fr = k.math('FRACT', k.math('MULTIPLY', a, scale))
            d = k.math('ABSOLUTE', k.math('SUBTRACT', fr, 0.5))
            l = k.math('POWER', k.math('MULTIPLY', d, 2.0), 14.0)
            out = l if out is None else k.math('MAXIMUM', out, l)
        return k.mix(k.math('MULTIPLY', out, line), base, _mul(c, 0.4))
    return pat


def p_scales(c):
    """Overlapping scale armour: rows of small plates with dark gaps."""
    def pat(k, co, pxy, sep):
        col, _ = k.brick(pxy, _mul(c, 1.2), _mul(c, 0.85), _mul(c, 0.2), 0.034, 0.028, msize=0.004, offset=0.5)
        n = k.noise(co, 30.0, 2.0)
        return k.mix(k.math('MULTIPLY', n, 0.3), col, _mul(c, 1.5))
    return pat


def p_stripes(c1, c2, width=0.16):
    """Painted lance: spiral stripes."""
    def pat(k, co, pxy, sep):
        a = k.math('ADD', k.math('MULTIPLY', sep.outputs[2], 1.0 / width), k.math('MULTIPLY', k.math('ARCTAN2', sep.outputs[1], sep.outputs[0]), 1 / math.pi))
        f = k.math('GREATER_THAN', k.math('FRACT', a), 0.5)
        return k.mix(f, c1, c2)
    return pat


UNIT_PALETTE = dict(BH.PALETTE)
UNIT_PALETTE.update({
    'horse_bay': (p_coat((0.2, 0.065, 0.022), dark=(0.018, 0.014, 0.012), knee=0.52), 'coat'),
    'horse_black': (p_coat((0.022, 0.02, 0.022)), 'coat'),
    'horse_grey': (p_coat((0.42, 0.42, 0.43), dark=(0.1, 0.1, 0.1), knee=0.4, dapple=(0.7, 0.7, 0.72)), 'coat'),
    'horse_muzzle': (M._flat((0.025, 0.022, 0.024), 0.15, 30.0), 'skin'),
    'hoof': (p_streaks((0.06, 0.05, 0.04), (0.02, 0.018, 0.016), 60, 4), 'base'),
    'accent_quilt': (p_quilt((0.8, 0.8, 0.8)), 'accent'),
    'accent_dark': (p_cloth((0.36, 0.36, 0.36), 0.08, 0.2), 'accent'),
    'accent_lance': (p_stripes((0.8, 0.8, 0.8), (0.75, 0.72, 0.62)), 'accent'),
    'scale_bronze': (p_scales((0.4, 0.23, 0.09)), 'metal'),
    'steel_black': (p_metal((0.07, 0.072, 0.08), 0.15, 0.08), 'metal'),
    'feather_white': (p_streaks((0.85, 0.84, 0.8), (0.5, 0.49, 0.46), 40, 260), 'base'),
    'cloth_red': (p_cloth((0.3, 0.03, 0.025)), 'base'),
    'leather_red': (p_leather((0.2, 0.03, 0.02)), 'base'),
})

ROLES = dict(BH.ROLES)
ROLES['coat'] = (0.0, 0.52)


def make_materials():
    out = {}
    for name, (pat, role) in UNIT_PALETTE.items():
        glow = role == 'glow'
        out[name] = lib.bake_material('unit_' + name, pat, ao_distance=0.12, ao_strength=0.0 if glow else 0.75,
                                      grime=0.0 if glow else 0.12)
    return out


# --- shared pieces ----------------------------------------------------------------------------------------


def round_shield(b, c, rz, r, w, face='accent', paint='accent_dark', rim='steel', boss='steel', bulge=0.06, gyrons=True):
    """Convex round shield centred at c, facing -Y turned by rz; painted in faction colours."""
    with b.frame(c.x, c.y, c.z, rz=rz):
        def disc(u, v, rr=r, lift=0.0):
            a = u * TAU
            rad_ = v * rr
            return V(math.cos(a) * rad_, -bulge * (1 - (rad_ / r) ** 2) - lift, math.sin(a) * rad_)
        b.sheet('wood', lambda u, v: disc(u, v) + V(0, 0.015, 0), 24, 6, w, thick=0.02, closed_u=True)
        b.sheet(face, lambda u, v: disc(u, v, r * 0.96, 0.004), 24, 6, w, thick=0.006, closed_u=True)
        if gyrons:
            for q in range(4):
                a0 = q * math.pi / 2 + math.pi / 4

                def wedge(u, v, a0=a0):
                    a = a0 + (u - 0.5) * math.pi / 4
                    rr = lerp(0.1, 0.92, v) * r
                    return V(math.cos(a) * rr, -bulge * (1 - (rr / r) ** 2) - 0.009, math.sin(a) * rr)
                if q % 2 == 0:
                    b.sheet(paint, wedge, 6, 4, w, thick=0.004)
        # rim, studs and boss
        rim_pts = [V(math.cos(TAU * i / 40) * r, 0.005, math.sin(TAU * i / 40) * r) for i in range(41)]
        b.tube(rim, rim_pts, 0.012, w, seg=6)
        for i in range(12):
            a = TAU * i / 12
            p = disc(0, 0.86)
            rr = 0.86 * r
            b.sphere(rim, 0.011, w, seg=6, n=3, x=math.cos(a) * rr, y=-bulge * (1 - 0.86 ** 2) - 0.01, z=math.sin(a) * rr)
        b.ellipsoid(boss, 0.075, 0.06, 0.075, w, seg=16, n=8, y=-bulge - 0.005)
        b.loft(boss, [(0.0, 0.1, 0.1), (0.012, 0.1, 0.1), (0.012, 0.0, 0.0)], w, seg=16, rx=rad(90), y=-bulge + 0.02)
        b.sphere('gold', 0.016, w, seg=8, n=4, y=-bulge - 0.065)


def spear(b, g, d, lo, hi, w, head_len=0.26, shaft='wood', tip='blade', tassel=None, socket='steel'):
    """Spear through grip point g along direction d, from -lo to +hi."""
    d = d.normalized()
    with b.along(g - d * lo, g + d * hi) as L:
        b.loft(shaft, [(0.0, 0.017, 0.017), (L - head_len, 0.015, 0.015)], w, seg=8)
        b.cyl(socket, 0.02, 0.02, 0.05, w, seg=8, z=0.0)
        b.loft(socket, [(L - head_len - 0.07, 0.018, 0.018), (L - head_len + 0.01, 0.02, 0.02), (L - head_len + 0.02, 0.012, 0.012)], w, seg=8)
        b.loft(tip, [(L - head_len + 0.01, 0.012, 0.008), (L - head_len + 0.08, 0.045, 0.01), (L - head_len + 0.16, 0.038, 0.009), (L, 0.0, 0.0)],
               w, seg=4, sq=1.0, smooth=False)
        b.loft(socket, [(L - head_len + 0.01, 0.004, 0.012), (L - 0.02, 0.003, 0.0105)], w, seg=4, sq=1.0, smooth=False)
        if tassel:
            z = L - head_len - 0.08
            b.ring_band('leather_dark', z, 0.02, 0.02, 0.02, 0.006, w, seg=8)
            for i in range(8):
                a = TAU * i / 8
                b.tube(tassel, [V(math.cos(a) * 0.015, math.sin(a) * 0.015, z), V(math.cos(a) * 0.04, math.sin(a) * 0.04, z - 0.1),
                                V(math.cos(a) * 0.045, math.sin(a) * 0.045 + 0.02, z - 0.18)], [0.012, 0.01, 0.0], w, seg=5)


def riding_leg(b, side, thigh, shin, boot_mat, r=1.0, knee=None, sole='leather_dark', spur=None, cuff=None):
    """Seated leg: modelled along the joints (no ground-bound boot)."""
    J = b.J
    leg(b, side, thigh, shin, r=r, knee=knee)
    ft, sh = f'foot.{side}', f'shin.{side}'
    # boot shaft up the shin and a foot along the stirrup
    with b.along(J[f'ankle.{side}'], J[f'knee.{side}']) as L:
        b.loft(boot_mat, [(-0.05, 0.055 * r, 0.06 * r), (0.08, 0.05 * r, 0.052 * r), (0.22, 0.058 * r, 0.062 * r), (0.32, 0.062 * r, 0.066 * r)],
               w_near(J, sh, ft, power=4), seg=14, cap1=False)
        if cuff:
            b.loft(cuff, [(0.3, 0.064 * r, 0.068 * r), (0.34, 0.075 * r, 0.078 * r), (0.37, 0.07 * r, 0.073 * r), (0.37, 0.06 * r, 0.062 * r)],
                   w_near(J, sh, f'thigh.{side}', power=4), seg=14, cap0=False, cap1=False)
    a, t = J[f'ankle.{side}'], J[f'toe.{side}']
    with b.along(a + (a - t).normalized() * 0.07 + V(0, 0, -0.03), t + V(0, 0, -0.03)) as L:
        b.loft(boot_mat, [(0.0, 0.03 * r, 0.035), (0.015, 0.046 * r, 0.056), (0.07, 0.05 * r, 0.06, 0, -0.002), (0.15, 0.052 * r, 0.045, 0, -0.016),
                          (L * 0.85, 0.046 * r, 0.03, 0, -0.024), (L + 0.02, 0.0, 0.0, 0, -0.03)], ft, seg=14, rz=0.0)
        b.loft(sole, [(0.0, 0.033 * r, 0.012, 0, -0.05), (0.01, 0.05 * r, 0.012, 0, -0.05), (L * 0.95, 0.042 * r, 0.012, 0, -0.05),
                      (L + 0.02, 0.0, 0.0, 0, -0.05)], ft, seg=12)
        if spur:
            b.tube(spur, [V(0.045, 0.0, 0.0), V(0.0, 0.055, -0.01), V(-0.045, 0.0, 0.0)], 0.006, ft, seg=5)
            b.cyl(spur, 0.005, 0.005, 0.06, ft, seg=5, y=0.06, z=-0.01, rx=rad(90))
            b.cyl(spur, 0.022, 0.022, 0.006, ft, seg=8, y=0.115, z=-0.01, ry=rad(90))


# --- light infantry ---------------------------------------------------------------------------------------


def light_infantry(b):
    J = b.J
    T = TORSO
    gam = grow(T, 0.022)
    # quilted gambeson in the faction colour, down to mid thigh
    b.loft('accent_quilt', [r for r in gam if r[0] >= 0.92], w_torso(J), seg=24)
    skirt(b, 'accent_quilt', [(0.58, 0.24, 0.205), (0.62, 0.243, 0.207), (0.8, 0.222, 0.182), (0.96, 0.2, 0.158)], 0.96)
    b.loft('leather', [(0.575, 0.24, 0.205), (0.575, 0.247, 0.212), (0.605, 0.247, 0.212), (0.605, 0.24, 0.205)], w_skirt(0.96), seg=24, cap0=False, cap1=False)
    # padded collar and a scarf knotted at the front
    b.loft('accent_quilt', [(1.4, 0.15, 0.12), (1.46, 0.125, 0.105), (1.53, 0.085, 0.08)], w_zchain((1.52, 'neck'), (1.45, 'chest')), seg=20, cap0=False, cap1=False, y=0.005)
    b.tube('cloth_white', [V(0.1, -0.08, 1.46), V(0.03, -0.14, 1.41), V(-0.05, -0.13, 1.44), V(-0.11, -0.07, 1.47)], 0.025, 'chest', seg=8)
    b.tube('cloth_white', [V(-0.02, -0.14, 1.42), V(-0.03, -0.16, 1.33), V(-0.01, -0.155, 1.25)], [0.022, 0.018, 0.004], 'chest', seg=6)
    # belt with pouch, knife and a short sword on the left hip
    b.ring_band('leather_dark', 0.98, 0.205, 0.165, 0.045, 0.012, 'hips', seg=24)
    b.box('steel', 0.045, 0.02, 0.04, 'hips', bevel=0.006, y=-0.168, z=0.98)
    b.box('leather', 0.075, 0.045, 0.08, 'hips', bevel=0.014, x=-0.15, y=-0.1, z=0.92, rz=0.6)
    b.box('leather_dark', 0.03, 0.02, 0.12, 'hips', bevel=0.005, x=-0.2, y=0.06, z=0.9, ry=0.15)
    with b.frame(0.215, 0.02, 0.95, rx=rad(-28)):
        b.loft('leather_dark', [(-0.62, 0.0, 0.0), (-0.6, 0.026, 0.012), (0.0, 0.03, 0.013)], w_skirt(0.96, 0.3), seg=8)
        b.cyl('steel', 0.032, 0.032, 0.02, w_skirt(0.96, 0.3), seg=8, z=-0.61)
        b.box('steel', 0.1, 0.02, 0.018, 'hips', bevel=0.004, z=0.01)
        b.cyl('leather_dark', 0.015, 0.015, 0.11, 'hips', seg=8, z=0.02)
        b.sphere('steel', 0.022, 'hips', seg=8, n=4, z=0.14)
    # arms: quilted sleeves, leather bracers
    for side, sg in (('L', 1), ('R', -1)):
        arm(b, side, 'accent_quilt', 'accent_quilt', hand='fist', hand_mat='leather', r=1.12, fore_r=1.02)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            b.loft('leather', [(L * 0.35, 0.058, 0.056), (L * 0.4, 0.062, 0.06), (L + 0.02, 0.055, 0.052), (L + 0.02, 0.04, 0.04)],
                   w_near(J, f'forearm.{side}', f'hand.{side}'), seg=14, cap0=False)
            for t in (0.55, 0.8):
                b.ring_band('leather_dark', L * t, 0.064, 0.062, 0.012, 0.006, f'forearm.{side}', seg=14)
        # shoulder pads
        a = J[f'arm.{side}']
        b.ellipsoid('accent_quilt', 0.085, 0.09, 0.06, w_near(J, f'shoulder.{side}', f'upper_arm.{side}', power=3), seg=14, n=6, z0=-0.01,
                    x=a.x + sg * 0.01, y=a.y, z=a.z + 0.01, ry=sg * rad(25))
    # legs: trousers, wrapped shins, low boots
    for side in ('L', 'R'):
        leg(b, side, 'cloth_brown', 'cloth_brown', r=1.0)
        boot(b, side, 'leather', shaft=0.14, r=1.02)
        with b.along(J[f'knee.{side}'], J[f'ankle.{side}']) as L:
            for i in range(7):
                t = 0.18 + i * 0.1
                b.ring_band('cloth_grey', L * t, 0.064 - i * 0.002, 0.066 - i * 0.002, 0.05, 0.008, f'shin.{side}', seg=14, y=0.005,
                            rx=0.12 * (1 if i % 2 else -1))
    # head: face, mail coif and a broad-brimmed kettle hat
    neck(b, 'skin', 0.052)
    head(b, 'skin', brows='hair_black')
    wh = w_zchain((1.62, 'head'), (1.5, 'neck'), (1.42, 'chest'))
    with b.frame(*J['head']):
        coif = [(-0.02, 0.11, 0.115, 0, 0.02), (0.06, 0.112, 0.12, 0, 0.012), (0.16, 0.112, 0.124, 0, 0.012), (0.22, 0.095, 0.105, 0, 0.012)]
        b.sheet('chain', lambda u, v: hood_surface(coif, lerp(-2.3, 2.3, u), lerp(-0.07, 0.2, v)), 18, 8, wh, thick=0.012)
        b.loft('chain', [(-0.16, 0.19, 0.15, 0, 0.03), (-0.1, 0.13, 0.12, 0, 0.02), (-0.03, 0.11, 0.115, 0, 0.02)], wh, seg=20, cap0=False, cap1=False)
        # moustache
        b.ellipsoid('hair_black', 0.04, 0.012, 0.01, 'head', seg=8, n=4, y=-0.108, z=0.07, rx=0.2)
        hat = [(0.13, 0.122, 0.132, 0, 0.012), (0.2, 0.118, 0.128, 0, 0.012), (0.27, 0.095, 0.104, 0, 0.012), (0.315, 0.05, 0.055, 0, 0.012), (0.33, 0.0, 0.0, 0, 0.012)]
        b.loft('steel', hat, 'head', seg=22)
        front_strip(b, 'steel_dark', hat, 0.14, 0.32, 0.014, 'head', off=0.0)
        b.loft('steel', [(0.1, 0.22, 0.23, 0, 0.012), (0.115, 0.225, 0.235, 0, 0.012), (0.145, 0.13, 0.14, 0, 0.012), (0.13, 0.125, 0.135, 0, 0.012)],
               'head', seg=28, cap0=False, cap1=False)
        b.ring_band('steel_dark', 0.108, 0.225, 0.235, 0.016, 0.01, 'head', seg=28, y=0.012)
        b.ring_band('leather_dark', 0.145, 0.126, 0.136, 0.02, 0.008, 'head', seg=22, y=0.012)
        for i in range(10):
            a = TAU * i / 10
            p = surf(hat, 0.145, a, 0.004)
            b.sphere('steel_dark', 0.007, 'head', seg=6, n=3, x=p.x, y=p.y, z=p.z)
    # round shield on the left forearm
    e, wl = J['elbow.L'], J['wrist.L']
    c = e.lerp(wl, 0.5) + V(0.1, -0.02, 0.0)
    round_shield(b, c, rad(62), 0.34, 'forearm.L')
    # spear in the right hand, tipped forward
    g = grip_point(J, 'R', 0.05)
    spear(b, g, V(0, -0.17, 1), 0.95, 1.45, 'hand.R', tassel='accent')


# --- heavy infantry --------------------------------------------------------------------------------------------


def heavy_infantry(b):
    J = b.J
    T = TORSO
    with b.frame(s=(1.08, 1.05, 1.0)):
        plate = grow(T, 0.022)
        b.loft('steel_black', [r for r in plate if r[0] >= 1.0], w_torso(J), seg=26, sq=2.4)
        b.loft('chain', grow([r for r in T if r[0] <= 1.1], 0.014), w_torso(J), seg=22)
        # breastplate ridge and gold edging
        front_strip(b, 'gold', plate, 1.02, 1.44, 0.016, w_torso(J), off=0.0)
        arc_band(b, 'gold', plate, 1.43, 0.02, -1.1, 1.1, w_torso(J), off=0.0)
    # faction surcoat: short, split, trimmed in gold, with a sun emblem
    sur = grow([(z, x * 1.08, y * 1.05, c, d) for (z, x, y, c, d) in TORSO], 0.036)
    w_tab = blend_w(w_torso(J), w_skirt(1.02, 0.2), lambda lo, co: smooth(1.04, 0.96, co.z))
    for front in (True, False):
        def fn(u, v, front=front):
            z = lerp(1.38, 0.58, v)
            wdt = lerp(0.2, 0.235, v)
            x = (u - 0.5) * 2 * wdt
            rx, ry, cy = ring_at(sur, max(z, 1.02))
            depth = max(ry * math.sqrt(max(0.0, 1 - (x / max(rx, 1e-3)) ** 2)), 0.03)
            if z < 1.02:
                depth = lerp(depth, 0.23, smooth(1.02, 0.6, z))
            return V(x if front else -x, cy - depth if front else cy + depth, z)
        b.sheet('accent', fn, 8, 12, w_tab, thick=0.01)
        b.sheet('gold', lambda u, v, fn=fn: fn(u, 1.0) + V(0, 0, v * 0.04 - 0.005) + (V(0, -0.006, 0) if front else V(0, 0.006, 0)), 8, 1, w_tab, thick=0.006)
    with b.frame(0, -0.215, 1.22):
        b.cyl('gold', 0.06, 0.06, 0.012, w_torso(J), seg=20, rx=rad(90))
        for i in range(12):
            a = TAU * i / 12
            b.loft('gold', [(0.0, 0.016, 0.004), (0.05, 0.0, 0.0)], w_torso(J), seg=4, sq=1.0, x=math.cos(a) * 0.055, z=math.sin(a) * 0.055, y=0.0,
                   ry=-a + math.pi / 2, rx=0.0)
    b.ring_band('leather_dark', 1.02, 0.215, 0.165, 0.05, 0.012, 'hips', seg=24)
    b.box('gold', 0.06, 0.02, 0.05, 'hips', bevel=0.008, y=-0.175, z=1.02)
    # gorget and huge layered pauldrons with a raised neck guard
    b.loft('steel_black', [(1.42, 0.14, 0.12), (1.5, 0.1, 0.09), (1.57, 0.08, 0.075)], w_zchain((1.53, 'neck'), (1.47, 'chest')), seg=18, cap0=False, cap1=False, y=0.005)
    b.ring_band('gold', 1.5, 0.104, 0.094, 0.014, 0.01, w_zchain((1.53, 'neck'), (1.47, 'chest')), seg=18, y=0.005)
    for side, sg in (('L', 1), ('R', -1)):
        a = J[f'arm.{side}']
        wsh = w_near(J, f'shoulder.{side}', f'upper_arm.{side}', power=3)
        with b.frame(a.x + sg * 0.02, a.y, a.z + 0.03, ry=sg * rad(24)):
            b.ellipsoid('steel_black', 0.15, 0.155, 0.12, wsh, seg=20, n=8, z0=-0.02)
            b.ring_band('gold', -0.005, 0.152, 0.157, 0.02, 0.012, wsh, seg=20)
            for i, (dz, s) in enumerate(((-0.06, 0.15), (-0.11, 0.14), (-0.16, 0.128))):
                b.loft('steel_black', [(dz - 0.05, s, s * 1.02), (dz, s + 0.014, s * 1.02 + 0.014), (dz + 0.03, s * 0.85, s * 0.86)], wsh, seg=20, cap0=False, cap1=False,
                       x=sg * 0.02)
                b.loft('gold', [(dz - 0.05, s + 0.001, s * 1.02 + 0.001), (dz - 0.04, s + 0.004, s * 1.02 + 0.004)], wsh, seg=20, cap0=False, cap1=False, x=sg * 0.02)
            # neck guard (haute-piece)
            b.sheet('steel_black', lambda u, v: V(-sg * (0.06 + 0.02 * v), (u - 0.5) * 0.2, 0.09 + v * 0.05), 4, 2, wsh, thick=0.014)
            for k in range(3):
                b.sphere('gold', 0.013, wsh, seg=8, n=4, x=0.0, y=-0.13 + k * 0.012, z=0.03 - k * 0.05)
    # arms in blackened plate with gold-rimmed couters and flared gauntlets
    for side in ('L', 'R'):
        sg = 1 if side == 'L' else -1
        arm(b, side, 'steel_black', 'steel_black', hand='fist', hand_mat='steel_black', r=1.12, elbow='steel_black', fore_r=1.1)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            b.loft('steel_black', [(L - 0.06, 0.05, 0.048), (L + 0.02, 0.068, 0.066), (L + 0.05, 0.066, 0.064), (L + 0.05, 0.05, 0.048)],
                   f'hand.{side}', seg=14, cap0=False, cap1=False)
            b.ring_band('gold', L + 0.045, 0.068, 0.066, 0.01, 0.006, f'hand.{side}', seg=14)
        e = J[f'elbow.{side}']
        b.ellipsoid('steel_black', 0.016, 0.06, 0.06, w_near(J, f'upper_arm.{side}', f'forearm.{side}'), seg=12, n=6, x=e.x + sg * 0.055, y=e.y + 0.01, z=e.z)
        b.sphere('gold', 0.014, w_near(J, f'upper_arm.{side}', f'forearm.{side}'), seg=8, n=4, x=e.x + sg * 0.07, y=e.y + 0.01, z=e.z)
    # faulds, mail skirt, tassets
    b.loft('chain', [(0.66, 0.215, 0.18), (0.9, 0.195, 0.155), (1.0, 0.185, 0.145)], w_skirt(0.98), seg=24, cap0=False, cap1=False)
    for i, z in enumerate((1.0, 0.95, 0.9)):
        r = 0.2 + i * 0.012
        b.loft('steel_black', [(z - 0.055, r + 0.012, r * 0.78 + 0.012), (z, r, r * 0.78)], w_skirt(0.98, 0.25), seg=24, cap0=False, cap1=False)
    # legs: plate with gold knee cops, sabatons
    for side in ('L', 'R'):
        sg = 1 if side == 'L' else -1
        leg(b, side, 'steel_black', 'steel_black', r=1.14, knee='steel_black')
        boot(b, side, 'steel_black', sole='steel_dark', shaft=0.12, r=1.1, toe=1.08)
        k = J[f'knee.{side}']
        wk = w_near(J, f'thigh.{side}', f'shin.{side}')
        b.ellipsoid('steel_black', 0.05, 0.022, 0.056, wk, seg=12, n=6, x=k.x + sg * 0.055, y=k.y - 0.02, z=k.z)
        b.ellipsoid('gold', 0.028, 0.012, 0.03, wk, seg=10, n=5, x=k.x, y=k.y - 0.07, z=k.z)
        with b.along(J[f'knee.{side}'], J[f'ankle.{side}']) as L:
            b.loft('gold', [(0.08, 0.001, 0.069), (L * 0.8, 0.001, 0.058)], f'shin.{side}', seg=4, y=-0.004)
    # cape in a deeper shade of the faction colour
    cape(b, 'accent_dark', 1.48, 0.28, 0.24, 0.4, depth_top=0.16, depth_bot=0.36, folds=6, wrap=0.5, thick=0.016,
         hem=lambda u: 0.04 * abs(math.sin(u * math.pi * 4)))
    for sg in (1, -1):
        b.sphere('gold', 0.028, 'chest', x=sg * 0.17, y=-0.08, z=1.46)
    # close helm with a visor slit, breaths and a tall crest
    neck(b, 'skin', 0.056)
    helm = [(-0.06, 0.1, 0.11, 0, 0.0), (0.0, 0.122, 0.132, 0, -0.008), (0.12, 0.127, 0.138, 0, -0.012), (0.2, 0.121, 0.132, 0, -0.004),
            (0.26, 0.1, 0.11, 0, 0.004), (0.3, 0.06, 0.065, 0, 0.006), (0.315, 0.0, 0.0, 0, 0.006)]
    with b.frame(*J['head']):
        b.loft('steel_black', helm, 'head', seg=24, sq=2.3)
        # pointed visor ridge
        b.loft('steel_black', [(0.0, 0.0, 0.0, 0, -0.13), (0.02, 0.045, 0.02, 0, -0.14), (0.1, 0.07, 0.03, 0, -0.145), (0.14, 0.05, 0.02, 0, -0.14),
                               (0.15, 0.0, 0.0, 0, -0.135)], 'head', seg=10, sq=1.4)
        arc_band(b, 'steel_dark', helm, 0.145, 0.018, -1.0, 1.0, 'head', off=-0.002)
        arc_band(b, 'gold', helm, 0.17, 0.012, -1.1, 1.1, 'head', off=0.0)
        arc_band(b, 'gold', helm, -0.045, 0.014, -math.pi, math.pi, 'head', off=0.0, nu=30)
        for i in range(3):
            for sg in (1, -1):
                p = surf(helm, 0.04 + i * 0.022, sg * 0.5, 0.0)
                b.box('steel_dark', 0.02, 0.012, 0.008, 'head', x=p.x, y=p.y, z=p.z, rz=sg * 0.5)
        # crest holder and horsehair crest running front to back
        b.loft('gold', [(0.0, 0.012, 0.012), (0.03, 0.014, 0.014)], 'head', seg=8, z=0.3, y=0.006)
        for i in range(13):
            t = i / 12
            a = lerp(-1.3, 1.9, t)
            base = V(0, -math.sin(a) * 0.1, 0.23 + math.cos(a) * 0.1) * 0.9 + V(0, 0.01, 0.06)
            h = 0.12 + 0.06 * math.sin(t * math.pi) - 0.03 * t
            tip = base + V(0, 0.03 + 0.1 * t, h)
            b.tube('accent', [base, base.lerp(tip, 0.5) + V(0, 0.02, 0.0), tip], [0.028, 0.03, 0.0], 'head', seg=6)
        b.sheet('accent', lambda u, v: V(0, lerp(-0.1, 0.23, u) + 0.12 * v * u, 0.34 + 0.05 * math.sin(u * math.pi) + v * lerp(0.1, 0.02, u) - 0.25 * u * u),
                10, 2, 'head', thick=0.03)
    # tower shield on the left arm
    e, wl = J['elbow.L'], J['wrist.L']
    c = e.lerp(wl, 0.5) + V(0.11, -0.03, -0.08)
    with b.frame(c.x, c.y, c.z, rz=rad(58)):
        W, Hh, bulge = 0.31, 0.56, 0.1

        def sh(u, v, inset=0.0, lift=0.0):
            x = (u - 0.5) * 2 * (W - inset)
            z = lerp(Hh, -Hh * 1.05, v) * (1 - inset / W * 0.5)
            return V(x, -bulge * (1 - (x / W) ** 2) - lift, z)
        b.sheet('wood_dark', lambda u, v: sh(u, v) + V(0, 0.016, 0), 12, 14, 'forearm.L', thick=0.025)
        b.sheet('accent', lambda u, v: sh(u, v, 0.03, 0.006), 12, 14, 'forearm.L', thick=0.006)
        # steel frame, bands and rivets
        for (u0, v0, u1, v1) in ((0, 0, 1, 0), (0, 1, 1, 1), (0, 0, 0, 1), (1, 0, 1, 1)):
            pts = [sh(lerp(u0, u1, t), lerp(v0, v1, t), 0.0, 0.012) for t in [i / 10 for i in range(11)]]
            b.tube('steel_black', pts, 0.018, 'forearm.L', seg=6)
        for t in (0.22, 0.78):
            b.sheet('steel_black', lambda u, v, t=t: sh(u, t + (v - 0.5) * 0.04, 0.03, 0.01), 12, 1, 'forearm.L', thick=0.006)
            for i in range(7):
                p = sh(0.08 + i * 0.14, t, 0.03, 0.017)
                b.sphere('gold', 0.01, 'forearm.L', seg=6, n=3, x=p.x, y=p.y, z=p.z)
        # gold sun emblem with a boss
        cc = sh(0.5, 0.48, 0.0, 0.012)
        with b.frame(cc.x, cc.y, cc.z):
            b.cyl('gold', 0.09, 0.09, 0.012, 'forearm.L', seg=24, rx=rad(90))
            b.ellipsoid('steel_black', 0.05, 0.04, 0.05, 'forearm.L', seg=14, n=6, y=-0.015)
            b.sphere('gold', 0.018, 'forearm.L', seg=8, n=4, y=-0.055)
            for i in range(16):
                a = TAU * i / 16
                ln = 0.09 if i % 2 == 0 else 0.055
                b.loft('gold', [(0.0, 0.022, 0.004), (ln, 0.0, 0.0)], 'forearm.L', seg=4, sq=1.0,
                       x=math.cos(a) * 0.085, z=math.sin(a) * 0.085, y=-0.004, ry=math.pi / 2 - a)
    # broadsword held low and forward
    g = grip_point(J, 'R', 0.05)
    d = V(0.05, -0.55, -0.83).normalized()
    with b.along(g - d * 0.12, g + d * 1.0):
        b.loft('leather_dark', [(0.03, 0.018, 0.018), (0.2, 0.018, 0.018)], 'hand.R', seg=8)
        b.sphere('gold', 0.032, 'hand.R', seg=10, n=6, z=0.02)
        b.box('gold', 0.28, 0.034, 0.032, 'hand.R', bevel=0.01, z=0.215)
        for sx in (-1, 1):
            b.loft('gold', [(0.0, 0.018, 0.018), (0.04, 0.0, 0.0)], 'hand.R', seg=6, x=sx * 0.14, z=0.215, ry=sx * rad(90))
        b.loft('blade', [(0.23, 0.045, 0.011), (0.3, 0.042, 0.01), (0.85, 0.034, 0.008), (0.98, 0.012, 0.004), (1.02, 0.0, 0.0)], 'hand.R', seg=4, sq=1.0, smooth=False)
        b.loft('steel_dark', [(0.23, 0.006, 0.0115), (0.6, 0.004, 0.009)], 'hand.R', seg=4, sq=1.0, smooth=False)


# --- cavalry: riders ----------------------------------------------------------------------------------------------

# Seated legs (base coordinates, before the rider is lifted onto the saddle): thighs
# splay round the barrel, shins hang nearly straight, feet in the stirrups.
SEAT = dict(knee_L=(0.34, -0.23, 0.68), ankle_L=(0.35, -0.16, 0.27), toe_L=(0.37, -0.33, 0.22), leg_L=(0.12, -0.01, 0.9))
# Lift from base coordinates to the saddle.
SEAT_OFFSET = V(0, -0.1, 0.74)


def heavy_rider(b):
    J = b.J
    T = TORSO
    plate = grow(T, 0.02)
    b.loft('steel', [r for r in plate if r[0] >= 1.02], w_torso(J), seg=24, sq=2.4)
    b.loft('chain', grow([r for r in T if r[0] <= 1.1], 0.012), w_torso(J), seg=22)
    front_strip(b, 'gold', plate, 1.04, 1.43, 0.018, w_torso(J), off=0.0)
    arc_band(b, 'gold', plate, 1.42, 0.018, -1.0, 1.0, w_torso(J), off=0.0)
    # surcoat over the plate; its skirts fall to both sides over the saddle
    sur = grow(plate, 0.012)
    for front in (True, False):
        def fn(u, v, front=front):
            z = lerp(1.44, 1.0, v)
            wdt = 0.19
            x = (u - 0.5) * 2 * wdt
            rx, ry, cy = ring_at(sur, z)
            depth = max(ry * math.sqrt(max(0.0, 1 - (x / max(rx, 1e-3)) ** 2)) + 0.004, 0.02)
            return V(x if front else -x, cy - depth if front else cy + depth, z)
        b.sheet('accent', fn, 8, 8, w_torso(J), thick=0.01)
    for side, sg in (('L', 1), ('R', -1)):
        th = f'thigh.{side}'
        kn = J[f'knee.{side}']
        hp = J[f'leg.{side}']
        # skirt panel over the thigh, hanging down the horse's flank
        def panel(u, v, sg=sg, hp=hp, kn=kn):
            top = V(sg * 0.1, lerp(-0.17, 0.17, u), 1.0)
            along = hp.lerp(kn, 0.9) + V(sg * 0.07, lerp(-0.15, 0.2, u), 0.0)
            p = top.lerp(along, v)
            p.z -= 0.18 * v * v
            p.x += sg * 0.04 * math.sin(v * math.pi)
            return p
        b.sheet('accent', panel, 6, 6, blend_w('hips', w_near(J, 'hips', th, power=2), lambda lo, co: 0.7), thick=0.01)
        b.sheet('gold', lambda u, v, panel=panel: panel(u, 1.0) + V(sg * 0.004, 0, -v * 0.03 + 0.01), 6, 1, blend_w('hips', w_near(J, 'hips', th, power=2), lambda lo, co: 0.7), thick=0.006)
    # cross in gold on the chest
    front_strip(b, 'gold', grow(sur, 0.008), 1.1, 1.38, 0.035, w_torso(J), off=0.0)
    arc_band(b, 'gold', grow(sur, 0.008), 1.28, 0.035, -0.5, 0.5, w_torso(J), off=0.0, nu=10)
    b.ring_band('leather_dark', 1.02, 0.186, 0.14, 0.045, 0.012, 'hips', seg=24)
    b.box('gold', 0.05, 0.02, 0.045, 'hips', bevel=0.006, y=-0.145, z=1.02)
    # pauldrons
    b.loft('steel', [(1.43, 0.12, 0.1), (1.5, 0.085, 0.078), (1.56, 0.07, 0.068)], w_zchain((1.53, 'neck'), (1.47, 'chest')), seg=18, cap0=False, cap1=False, y=0.005)
    for side, sg in (('L', 1), ('R', -1)):
        a = J[f'arm.{side}']
        wsh = w_near(J, f'shoulder.{side}', f'upper_arm.{side}', power=3)
        with b.frame(a.x + sg * 0.01, a.y, a.z + 0.02, ry=sg * rad(26)):
            b.ellipsoid('steel', 0.125, 0.13, 0.1, wsh, seg=18, n=8, z0=-0.01)
            b.ring_band('gold', 0.0, 0.127, 0.132, 0.018, 0.012, wsh, seg=18)
            for dz, s in ((-0.05, 0.12), (-0.095, 0.11)):
                b.loft('steel', [(dz - 0.04, s, s * 1.05), (dz, s + 0.012, s * 1.05 + 0.012), (dz + 0.03, s * 0.8, s * 0.85)], wsh, seg=18, cap0=False, cap1=False, x=sg * 0.02)
        arm(b, side, 'steel', 'steel', hand='fist', hand_mat='steel_dark', r=1.05, elbow='steel', fore_r=1.08)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            b.loft('steel', [(L - 0.05, 0.045, 0.043), (L + 0.02, 0.06, 0.058), (L + 0.045, 0.058, 0.056), (L + 0.045, 0.045, 0.043)],
                   f'hand.{side}', seg=14, cap0=False, cap1=False)
        e = J[f'elbow.{side}']
        b.ellipsoid('steel', 0.014, 0.05, 0.05, w_near(J, f'upper_arm.{side}', f'forearm.{side}'), seg=12, n=6, x=e.x + sg * 0.048, y=e.y + 0.01, z=e.z)
        riding_leg(b, side, 'steel', 'steel', 'steel', r=1.06, knee='steel', sole='steel_dark', spur='gold')
        k = J[f'knee.{side}']
        b.ellipsoid('steel', 0.045, 0.05, 0.05, w_near(J, f'thigh.{side}', f'shin.{side}'), seg=12, n=6, x=k.x + sg * 0.03, y=k.y - 0.03, z=k.z)
        b.sphere('gold', 0.015, w_near(J, f'thigh.{side}', f'shin.{side}'), x=k.x + sg * 0.01, y=k.y - 0.075, z=k.z + 0.01)
    # great helm with a gold crown and a pair of white wings
    neck(b, 'skin', 0.055)
    helm = [(-0.05, 0.1, 0.11, 0, 0.0), (0.0, 0.12, 0.132, 0, -0.006), (0.12, 0.125, 0.137, 0, -0.01), (0.21, 0.119, 0.13, 0, -0.004),
            (0.27, 0.098, 0.106, 0, 0.004), (0.305, 0.056, 0.061, 0, 0.006), (0.318, 0.0, 0.0, 0, 0.006)]
    with b.frame(*J['head']):
        b.loft('steel', helm, 'head', seg=22, sq=2.3)
        arc_band(b, 'steel_dark', helm, 0.145, 0.02, -1.15, 1.15, 'head', off=-0.003)
        front_strip(b, 'gold', helm, 0.02, 0.27, 0.022, 'head', off=0.0)
        arc_band(b, 'gold', helm, 0.104, 0.018, -0.6, 0.6, 'head', off=0.0, nu=8)
        arc_band(b, 'gold', helm, 0.215, 0.024, -math.pi, math.pi, 'head', off=0.0, nu=30)
        for i in range(8):
            a = TAU * i / 8
            p = surf(helm, 0.235, a, 0.004)
            b.loft('gold', [(0.0, 0.016, 0.006), (0.045, 0.0, 0.0)], 'head', seg=4, sq=1.0, x=p.x, y=p.y, z=p.z - 0.01)
        for i in range(5):
            for j in range(2):
                p = surf(helm, 0.05 + i * 0.018, -0.55 - j * 0.12, 0.0)
                b.box('steel_dark', 0.01, 0.012, 0.007, 'head', x=p.x, y=p.y, z=p.z)
        for sg in (1, -1):
            wing_root = V(sg * 0.1, 0.03, 0.2)
            for i in range(7):
                t = i / 6
                ang = lerp(rad(10), rad(80), t)
                ln = lerp(0.36, 0.2, t) + 0.05 * math.sin(t * math.pi)
                d = V(sg * 0.55, math.sin(ang) * 0.9, math.cos(ang)).normalized()
                p0 = wing_root + V(sg * 0.01 * i, 0.012 * i, 0.012 * i)
                tip = p0 + d * ln
                mid = p0.lerp(tip, 0.5) + V(sg * 0.03, 0, 0)
                with b.along(p0, tip, side=(1, 0, 0)) as L:
                    b.loft('feather_white', [(0.0, 0.006, 0.02), (L * 0.15, 0.008, 0.045), (L * 0.7, 0.007, 0.04), (L, 0.0, 0.0)], 'head', seg=6, sq=1.6)
            b.ellipsoid('gold', 0.035, 0.05, 0.05, 'head', seg=12, n=6, x=wing_root.x, y=wing_root.y, z=wing_root.z)
    # heater shield on the left forearm, facing out
    e, wl = J['elbow.L'], J['wrist.L']
    c = e.lerp(wl, 0.35) + V(0.1, 0.02, 0.02)

    def shield_w(u):
        return 0.21 if u < 0.45 else 0.21 * math.sqrt(max(0.0, 1 - ((u - 0.45) / 0.55) ** 2))
    with b.frame(c.x, c.y, c.z, rz=rad(88)):
        def sh(u, v, inset=0.0, bulge=0.06):
            z = lerp(0.24, -0.36, v)
            hw = shield_w(v) - inset
            x = (u - 0.5) * 2 * hw
            return V(x, -bulge * (1 - (x / 0.21) ** 2) - 0.02, z)
        b.sheet('steel', lambda u, v: sh(u, v) + V(0, 0.012, 0), 12, 14, 'forearm.L', thick=0.02)
        b.sheet('accent', lambda u, v: sh(u, v, 0.02) + V(0, -0.004, 0), 12, 14, 'forearm.L', thick=0.01)
        b.sheet('accent_dark', lambda u, v: sh(0.5 + (u - 0.5) * 0.3, v * 0.95, 0.02) + V(0, -0.008, 0), 4, 12, 'forearm.L', thick=0.006)
        b.sheet('gold', lambda u, v: sh(u, 0.28 + (v - 0.5) * 0.08, 0.02) + V(0, -0.011, 0), 10, 1, 'forearm.L', thick=0.006)
        for i in range(3):
            p = sh(0.3 + 0.2 * i, 0.14, 0.02) + V(0, -0.014, 0)
            b.loft('gold', [(0.0, 0.025, 0.006), (0.025, 0.018, 0.006), (0.05, 0.0, 0.0)], 'forearm.L', seg=4, sq=1.0, x=p.x, y=p.y, z=p.z - 0.02,
                   rx=0.0)
    # lance: striped shaft, steel vamplate, long head; a swallow-tailed pennon below the tip
    g = grip_point(J, 'R', 0.05)
    d = V(0, 0.06, 1).normalized()
    with b.along(g - d * 0.55, g + d * 2.9) as L:
        b.loft('accent_lance', [(0.0, 0.028, 0.028), (0.4, 0.03, 0.03), (0.52, 0.026, 0.026), (0.6, 0.034, 0.034), (1.6, 0.03, 0.03), (L - 0.28, 0.02, 0.02)], 'hand.R', seg=10)
        b.cyl('steel', 0.03, 0.03, 0.04, 'hand.R', seg=10, z=0.0)
        b.loft('steel', [(0.64, 0.035, 0.035), (0.64, 0.05, 0.05), (0.7, 0.12, 0.12), (0.74, 0.12, 0.12), (0.74, 0.03, 0.03)], 'hand.R', seg=18, cap0=False, cap1=False)
        b.ring_band('gold', 0.7, 0.123, 0.123, 0.012, 0.008, 'hand.R', seg=18)
        b.loft('steel', [(L - 0.3, 0.022, 0.022), (L - 0.2, 0.026, 0.02), (L - 0.02, 0.008, 0.008), (L, 0.0, 0.0)], 'hand.R', seg=8, sq=1.6)
    PEN = pennon_joints(g + d * 2.2, d, 0.6)
    J.update(PEN)
    pennon(b, J, 'accent', 0.6, 0.26, swallow=True)


def pennon_joints(top, d, length):
    """Joints for a pennon flying from a vertical pole at `top` toward +Y (backwards)."""
    back = V(0, 1, 0)
    return {'pen0': top.copy(), 'pen1': top + back * length * 0.5, 'pen2': top + back * length}


PENNON_BONES = [('pennon_1', 'pen0', 'pen1', 'hand.R'), ('pennon_2', 'pen1', 'pen2', 'pennon_1')]


def pennon(b, J, mat, length, height, swallow=False):
    """Pennon flying back from the pole at pen0: tapering, optionally swallow-tailed.
    Weighted from the hand (at the pole) through pennon_1 to pennon_2 at the tail."""
    p0 = J['pen0']

    def w(lo, co):
        t = (co.y - p0.y) / length
        a = smooth(0.0, 0.5, t)
        c = smooth(0.45, 1.0, t)
        return {'hand.R': max(0.0, 1 - a), 'pennon_1': max(0.0, a - c), 'pennon_2': c}

    def at(u, zf):
        hh = lerp(height, height * 0.55, u)
        return p0 + V(0.03 * math.sin(u * math.pi * 2.2), u * length, zf * hh / 2)
    split = 0.62 if swallow else 1.0
    b.sheet(mat, lambda u, v: at(u * split, 1 - 2 * v), 10, 3, w, thick=0.008)
    if swallow:
        for sg in (1, -1):
            # each tail narrows from half the height to a point
            b.sheet(mat, lambda u, v, sg=sg: at(lerp(split, 1.0, u), sg * lerp(1.0, lerp(0.0, 0.85, u), v)), 5, 2, w, thick=0.008)
    b.tube('gold', [p0 + V(0, 0, height / 2), p0 + V(0, 0, -height / 2)], 0.012, 'hand.R', seg=6)


def light_rider(b):
    J = b.J
    T = TORSO
    tun = grow(T, 0.01)
    # bronze scale shirt over a faction tunic whose skirts fall over the thighs
    b.loft('scale_bronze', [r for r in grow(T, 0.022) if r[0] >= 0.98], w_torso(J), seg=24)
    b.loft('accent', [r for r in tun if r[0] <= 1.02], w_torso(J), seg=24, cap0=False)
    arc_band(b, 'gold', grow(T, 0.022), 1.0, 0.02, -math.pi, math.pi, w_torso(J), off=0.0, nu=30)
    arc_band(b, 'gold', grow(T, 0.022), 1.42, 0.016, -1.1, 1.1, w_torso(J), off=0.0)
    for side, sg in (('L', 1), ('R', -1)):
        th = f'thigh.{side}'
        kn = J[f'knee.{side}']
        hp = J[f'leg.{side}']

        def panel(u, v, sg=sg, hp=hp, kn=kn):
            top = V(sg * 0.1, lerp(-0.16, 0.16, u), 1.0)
            along = hp.lerp(kn, 0.7) + V(sg * 0.07, lerp(-0.14, 0.18, u), 0.0)
            p = top.lerp(along, v)
            p.z -= 0.14 * v * v
            p.x += sg * 0.035 * math.sin(v * math.pi)
            return p
        wp = blend_w('hips', w_near(J, 'hips', th, power=2), lambda lo, co: 0.7)
        b.sheet('accent', panel, 6, 6, wp, thick=0.01)
        b.sheet('gold', lambda u, v, panel=panel: panel(u, 1.0) + V(sg * 0.004, 0, -v * 0.025 + 0.008), 6, 1, wp, thick=0.006)
    b.ring_band('leather_dark', 1.0, 0.196, 0.152, 0.05, 0.012, 'hips', seg=24)
    b.box('gold', 0.05, 0.02, 0.045, 'hips', bevel=0.006, y=-0.158, z=1.0)
    # leather shoulder guards, bracers, gloves
    for side, sg in (('L', 1), ('R', -1)):
        a = J[f'arm.{side}']
        wsh = w_near(J, f'shoulder.{side}', f'upper_arm.{side}', power=3)
        with b.frame(a.x + sg * 0.01, a.y, a.z + 0.015, ry=sg * rad(28)):
            for i, s in enumerate((0.1, 0.095, 0.088)):
                b.loft('leather', [(-0.03 - i * 0.04, s + 0.01, s * 1.05 + 0.01), (-i * 0.04, s, s * 1.05), (-i * 0.04 + 0.03, s * 0.7, s * 0.75)], wsh, seg=16, cap0=False, cap1=False)
        arm(b, side, 'accent', 'accent', hand='fist', hand_mat='leather_dark', r=1.0)
        with b.along(J[f'elbow.{side}'], J[f'wrist.{side}']) as L:
            b.loft('leather_dark', [(L * 0.3, 0.056, 0.054), (L * 0.35, 0.06, 0.058), (L + 0.03, 0.054, 0.052), (L + 0.03, 0.038, 0.038)],
                   w_near(J, f'forearm.{side}', f'hand.{side}'), seg=14, cap0=False)
            for t in (0.5, 0.72, 0.92):
                b.ring_band('gold', L * t, 0.062, 0.06, 0.008, 0.005, f'forearm.{side}', seg=14)
        riding_leg(b, side, 'cloth_brown', 'cloth_brown', 'leather', r=1.0, cuff='leather_dark')
    # long cloak flowing back over the horse's quarters
    cape(b, 'accent', 1.47, 0.95, 0.22, 0.36, depth_top=0.15, depth_bot=0.46, folds=5, fold_amp=0.03, wrap=0.55, thick=0.014,
         hem=lambda u: 0.05 * abs(math.sin(u * math.pi * 3)))
    b.loft('accent', [(1.4, 0.23, 0.17), (1.47, 0.21, 0.155), (1.52, 0.11, 0.095)], w_torso(J), seg=24, cap0=False, cap1=False, y=0.01)
    for sg in (1, -1):
        b.sphere('gold', 0.024, 'chest', x=sg * 0.13, y=-0.09, z=1.45)
    # head: bearded face, open helm with cheek guards and a long white horsehair plume
    neck(b, 'skin_tan', 0.052)
    head(b, 'skin_tan', brows='hair_red')
    wb = w_zchain((1.55, 'head'), (1.45, 'neck'), (1.32, 'chest'))
    with b.frame(*J['head']):
        b.loft('hair_red', [(-0.1, 0.0, 0.0, 0, -0.1), (-0.04, 0.06, 0.04, 0, -0.09), (0.03, 0.085, 0.055, 0, -0.07), (0.09, 0.0, 0.0, 0, -0.06)], wb, seg=14)
        b.ellipsoid('hair_red', 0.045, 0.015, 0.012, 'head', seg=10, n=4, y=-0.108, z=0.07, rx=0.2)
        helm = [(0.1, 0.116, 0.13, 0, 0.012), (0.18, 0.114, 0.126, 0, 0.012), (0.25, 0.09, 0.1, 0, 0.012), (0.3, 0.045, 0.05, 0, 0.012), (0.315, 0.0, 0.0, 0, 0.012)]
        b.loft('steel', helm, 'head', seg=22)
        b.ring_band('bronze', 0.11, 0.12, 0.134, 0.028, 0.01, 'head', seg=22, y=0.012)
        front_strip(b, 'bronze', helm, 0.12, 0.3, 0.02, 'head')
        b.box('steel', 0.02, 0.012, 0.085, 'head', bevel=0.004, y=-0.13, z=0.09)
        # neck guard and cheek plates
        b.sheet('steel', lambda u, v: hood_surface([(0.0, 0.12, 0.13, 0, 0.015), (0.12, 0.12, 0.13, 0, 0.015)], lerp(-1.4, 1.4, u), lerp(-0.02, 0.11, v)) + V(0, 0.01 + 0.03 * (1 - v), 0),
                10, 3, wb, thick=0.012)
        for sg in (1, -1):
            b.sheet('steel', lambda u, v, sg=sg: V(sg * (0.118 - 0.02 * v), lerp(-0.07, 0.02, u) + 0.01 * v, lerp(0.12, 0.0, v)), 3, 4, 'head', thick=0.012)
        # crest ridge and plume streaming back
        b.loft('bronze', [(0.0, 0.012, 0.012), (0.04, 0.015, 0.015)], 'head', seg=8, z=0.3, y=0.02)
        for i in range(10):
            a = (i - 4.5) * 0.012
            pts = [V(a * 0.5, 0.0, 0.33), V(a * 1.2, 0.1, 0.37), V(a * 2.2, 0.21, 0.32), V(a * 3.0, 0.27, 0.16), V(a * 3.4, 0.29, -0.04)]
            b.tube('hair_white', pts, [0.022, 0.03, 0.03, 0.024, 0.0], w_zchain((0.25 + J['head'].z, 'head'), (0.0 + J['head'].z, 'neck'), (-0.15 + J['head'].z, 'chest')),
                   seg=6)
    # round shield on the left arm (rein hand)
    e, wl = J['elbow.L'], J['wrist.L']
    c = e.lerp(wl, 0.4) + V(0.1, 0.02, 0.0)
    round_shield(b, c, rad(85), 0.26, 'forearm.L', rim='bronze', boss='bronze', bulge=0.05)
    # spear with a pennon, held upright in the right hand
    g = grip_point(J, 'R', 0.05)
    d = V(0, 0.05, 1).normalized()
    spear(b, g, d, 0.6, 2.0, 'hand.R', head_len=0.3, tassel=None)
    J.update(pennon_joints(g + d * 1.55, d, 0.45))
    pennon(b, J, 'accent', 0.45, 0.2, swallow=True)


# --- cavalry: horse dress ---------------------------------------------------------------------------------------------


def _bp(st, y, ang, off=0.0):
    sx, sy, sz = st.scale
    p = HL.barrel_point(y, ang, off)
    return V(p.x * sx, p.y * sy, p.z * sz)


def saddle(bd, J, st, seat='leather', frame='wood_dark', trim='gold', cloth=None, cloth_trim='gold', high=False, rider_feet=None):
    """Saddle, pad, girth, breast strap and stirrups (the stirrups hang at the rider's feet)."""
    wb = HL.P + 'body'
    wsp = HL.w_spine(J)
    y0, y1 = -0.4, 0.2
    if cloth:
        # saddle cloth (shabraque) hanging down both flanks, with a trimmed border
        def drape(u, v, off=0.03):
            y = lerp(-0.5, 0.36, u)
            a = lerp(-1.85, 1.85, v)
            p = _bp(st, y, max(-math.pi / 2, min(math.pi / 2, a)), off)
            if abs(a) > math.pi / 2:
                p.z -= (abs(a) - math.pi / 2) * 0.3
                p.x += math.copysign(0.012, a)
            return p
        bd.sheet(cloth, drape, 12, 20, wsp, thick=0.012)
        for v0 in (0.0, 1.0):
            bd.sheet(cloth_trim, lambda u, v, v0=v0: drape(u, v0 + (v - 0.5) * 0.03 * (1 if v0 == 0 else -1), 0.036), 12, 1, wsp, thick=0.008)
        for u0 in (0.0, 1.0):
            bd.sheet(cloth_trim, lambda u, v, u0=u0: drape(u0 + (u - 0.5) * 0.02, v, 0.036), 1, 20, wsp, thick=0.008)
    # seat: shaped over the back with a pommel in front and a cantle behind
    ch = 0.2 if high else 0.1
    ph = 0.16 if high else 0.08

    def seat_fn(u, v):
        y = lerp(y0, y1, u)
        a = lerp(-1.2, 1.2, v)
        p = _bp(st, y, a, 0.05)
        rise = ph * smooth(0.2, 0.0, u) + ch * smooth(0.75, 1.0, u)
        p.z += rise * math.cos(a) ** 2
        return p
    bd.sheet(seat, seat_fn, 14, 12, wb, thick=0.03)
    for u in (0.0, 1.0):
        pts = [seat_fn(u, v / 12) + V(0, 0, 0.012) for v in range(13)]
        bd.tube(frame, pts, 0.025 if high else 0.018, wb, seg=8)
        bd.tube(trim, [p + V(0, (-0.012 if u == 0 else 0.012), 0.012) for p in pts], 0.008, wb, seg=5)
    # saddle flaps
    for sg in (1, -1):
        def flap(u, v, sg=sg):
            y = lerp(-0.3, 0.02, u)
            a = sg * lerp(1.1, 1.55, v)
            p = _bp(st, y, max(-math.pi / 2, min(math.pi / 2, a)), 0.04)
            if abs(a) > math.pi / 2:
                p.z -= (abs(a) - math.pi / 2) * 0.3
            return p
        bd.sheet(seat, flap, 6, 6, wsp, thick=0.014)
    # girth under the belly and a breast strap round the chest
    for yy in (-0.2,):
        pts = [_bp(st, yy, a, 0.045) for a in [lerp(-math.pi, math.pi, i / 24) for i in range(25)]]
        bd.tube('leather_dark', pts, 0.02, wsp, seg=6)
    breast = [_bp(st, -0.25, 1.55, 0.04), _bp(st, -0.62, 1.5, 0.045), _bp(st, -0.84, 1.3, 0.05), _bp(st, -0.9, 0.0, 0.05) + V(0, -0.02, -0.12),
              _bp(st, -0.84, -1.3, 0.05), _bp(st, -0.62, -1.5, 0.045), _bp(st, -0.25, -1.55, 0.04)]
    bd.tube('leather_dark', breast, 0.018, wsp, seg=6)
    bd.cyl(trim, 0.045, 0.045, 0.012, wsp, seg=16, x=breast[3].x, y=breast[3].y - 0.01, z=breast[3].z, rx=rad(90))
    # stirrup leathers from the saddle to the rider's feet, stirrups under the boots
    if rider_feet:
        for side, sg in (('L', 1), ('R', -1)):
            foot = rider_feet[side]
            top = _bp(st, -0.12, sg * 1.3, 0.06)
            fw = f'foot.{side}'

            def wl(lo, co, top=top, foot=foot, fw=fw):
                t = max(0.0, min(1.0, (top.z - co.z) / max(1e-3, top.z - foot.z)))
                return {wb: 1 - smooth(0.1, 0.9, t), fw: smooth(0.1, 0.9, t)}
            bd.sheet('leather_dark', lambda u, v, top=top, foot=foot: top.lerp(foot + V(0, 0.0, -0.02), v) + V(0, (u - 0.5) * 0.035, 0), 1, 6, wl, thick=0.008)
            with bd.frame(foot.x, foot.y, foot.z - 0.045):
                bd.tube(trim if high else 'steel', [V(0, -0.06, 0.07), V(0, -0.065, -0.005), V(0, 0.065, -0.005), V(0, 0.06, 0.07)], 0.009, fw, seg=6)
                bd.box(trim if high else 'steel', 0.012, 0.13, 0.012, fw, x=0, y=0, z=-0.008)


def light_horse_dress(bd, J, st, rider_hand, hand_w, feet):
    HL.bridle(bd, J, 'leather_red', 'bronze', tassel='accent')
    HL.reins(bd, J, 'leather_red', rider_hand, hand_w)
    saddle(bd, J, st, seat='leather', frame='wood', trim='bronze', cloth='accent', cloth_trim='gold', high=False, rider_feet=feet)
    # tassels hanging from the breast strap
    wsp = HL.w_spine(J)
    for sg in (1, -1):
        for yy, a in ((-0.7, 1.45), (-0.8, 1.3)):
            p = _bp(st, yy, sg * a, 0.05)
            bd.loft('accent', [(0.0, 0.01, 0.01), (0.02, 0.022, 0.022), (0.1, 0.03, 0.03), (0.11, 0.0, 0.0)], HL.w_near(J, 'chest', f'scap.{"L" if sg > 0 else "R"}', power=2),
                    seg=8, x=p.x, y=p.y, z=p.z, rx=math.pi)


def heavy_horse_dress(bd, J, st, rider_hand, hand_w, feet):
    """Caparison in the faction colour with gold trim and emblems, a cloth crinet over the
    neck, steel chanfron with a spike and plume, war saddle."""
    HL.bridle(bd, J, 'leather_red', 'gold')
    HL.reins(bd, J, 'leather_red', rider_hand, hand_w)
    sx, sy, sz = st.scale
    wsp = HL.w_spine(J)
    z_hem = 0.66 * sz
    a_rim = 1.25
    ys = [lerp(-0.9, 0.95, i / 30) for i in range(31)]

    def rim_pt(y, sg):
        return _bp(st, y, sg * a_rim, 0.04 + 0.13 * smooth(-0.45, -0.88, y) + 0.05 * smooth(0.7, 0.93, y))

    # the leg each part of the skirt follows
    fy, hy = J['fshoulder.L'].y, J['hip.L'].y

    def w_cap(lo, co):
        base = wsp(lo, co)
        t = smooth(1.2 * sz, z_hem, co.z)
        side = 'L' if co.x >= 0 else 'R'
        pf = math.exp(-((co.y - fy) / 0.3) ** 2) * t * 0.75
        ph = math.exp(-((co.y - hy - 0.08) / 0.3) ** 2) * t * 0.7
        out = {k: v * (1 - pf - ph) for k, v in base.items()}
        out[HL.b('scap', side)] = pf
        out[HL.b('femur', side)] = ph
        return out

    # top blanket over the back, from the spine to the rim
    for sg in (1, -1):
        def top(u, v, sg=sg):
            y = lerp(ys[0], ys[-1], u)
            return _bp(st, y, sg * a_rim * v, 0.04)
        bd.sheet('accent', top, 30, 6, wsp, thick=0.012)

    # skirt: a loop round the body from the rim down to the scalloped hem
    loop = [(y, 1) for y in ys] + [(y, -1) for y in reversed(ys)]
    n = len(loop)

    def skirt_pt(u, v, off=0.0):
        i = u * (n - 1)
        i0 = int(min(n - 2, math.floor(i)))
        t = i - i0
        (ya, sa), (yb, sb) = loop[i0], loop[i0 + 1]
        pa, pb = rim_pt(ya, sa), rim_pt(yb, sb)
        r = pa.lerp(pb, t)
        # hem: pushed out from the centre line, lower at the sides
        dirv = V(r.x, r.y * 0.55, 0)
        flare = dirv.normalized() * 0.1 if dirv.length > 1e-4 else V(0, 0, 0)
        hem = V(r.x * 1.05, r.y * 1.03, z_hem) + flare
        ph = u * 22
        scallop = 0.035 * (1 - abs(math.sin(ph * math.pi)))
        hem.z -= scallop
        p = r.lerp(hem, v)
        p.z += 0.05 * math.sin(v * math.pi) * 0.3
        return p + dirv.normalized() * off * (1 if dirv.length > 1e-4 else 0)
    bd.sheet('accent', skirt_pt, 120, 8, w_cap, thick=0.012)
    # gold trim along the hem and a darker border band above it
    bd.sheet('accent_dark', lambda u, v: skirt_pt(u, 0.84 + 0.12 * v, 0.009), 120, 2, w_cap, thick=0.006)
    bd.sheet('gold', lambda u, v: skirt_pt(u, 0.975 + 0.03 * v, 0.013), 120, 1, w_cap, thick=0.006)
    bd.sheet('gold', lambda u, v: skirt_pt(u, 0.82 + 0.012 * v, 0.013), 120, 1, w_cap, thick=0.005)
    # sun emblems on the flanks
    for sg in (1, -1):
        for yy in (-0.35, 0.45):
            c = _bp(st, yy, sg * a_rim, 0.04)
            c = V(sg * (abs(c.x) * 1.03 + 0.05), yy * sy, lerp(c.z, z_hem, 0.45))
            with bd.frame(c.x, c.y, c.z, rz=sg * rad(90)):
                bd.cyl('gold', 0.085, 0.085, 0.01, w_cap, seg=20, rx=rad(90))
                bd.cyl('accent_dark', 0.05, 0.05, 0.014, w_cap, seg=16, rx=rad(90))
                for i in range(12):
                    a = TAU * i / 12
                    ln = 0.08 if i % 2 == 0 else 0.05
                    bd.loft('gold', [(0.0, 0.02, 0.004), (ln, 0.0, 0.0)], w_cap, seg=4, sq=1.0,
                            x=math.cos(a) * 0.082, z=math.sin(a) * 0.082, y=0.0, ry=math.pi / 2 - a)
    # crinet: cloth over the top of the neck with a gold edge, and a mane ridge of plates
    n0, n1 = HL.neck_frame(J)
    wn = HL.w_neck(J)
    with bd.along(n0, n1) as L:
        k = L / 0.8

        def crin(u, v, off=0.025):
            z = lerp(0.02, 0.78, v) * k
            rx, ry, cy = HL._ring(HL.NECK_RINGS, z / k)
            a = lerp(-1.45, 1.45, u)
            return V(math.sin(a) * (rx * sx + off), cy + math.cos(a) * (ry * sy + off), z)
        bd.sheet('accent', crin, 16, 12, wn, thick=0.012)
        for u0 in (0.0, 1.0):
            bd.sheet('gold', lambda u, v, u0=u0: crin(u0 + (u - 0.5) * 0.03, v, 0.03), 1, 12, wn, thick=0.006)
        for i in range(9):
            z = lerp(0.08, 0.74, i / 8) * k
            rx, ry, cy = HL._ring(HL.NECK_RINGS, z / k)
            bd.ellipsoid('steel', 0.05, 0.03, 0.06, wn, seg=12, n=6, y=cy + ry * sy + 0.035, z=z)
    # chanfron: steel face plate with gold trim, eye guards, a spike and a plume
    h0, h1 = HL.head_frame(J)
    with bd.along(h0, h1) as L:
        k = L / 0.62

        def face(u, v, off=0.018):
            z = lerp(-0.02, 0.5, v) * k
            rx, ry, cy = HL._ring(HL.HEAD_RINGS, z / k)
            a = lerp(-1.1, 1.1, u)
            return V(math.sin(a) * (rx * sx + off), cy + math.cos(a) * (ry * sy + off), z)
        bd.sheet('steel', face, 10, 12, HL.P + 'head', thick=0.012)
        for u0 in (0.0, 1.0):
            bd.tube('gold', [face(u0, v / 10, 0.026) for v in range(11)], 0.008, HL.P + 'head', seg=5)
        bd.tube('gold', [face(u / 10, 1.0, 0.026) for u in range(11)], 0.008, HL.P + 'head', seg=5)
        bd.tube('gold', [face(0.5, v / 10, 0.028) for v in range(1, 10)], 0.007, HL.P + 'head', seg=5)
        for sg in (1, -1):
            p = face(0.5 + sg * 0.47, 0.3, 0.02)
            bd.ring_band('steel', 0.0, 0.04, 0.04, 0.03, 0.012, HL.P + 'head', seg=14, x=p.x + sg * 0.01, y=p.y - 0.01, z=p.z, ry=sg * rad(90), rx=0.0)
        # spike from the brow
        sp = face(0.5, 0.22, 0.02)
        bd.loft('steel', [(0.0, 0.03, 0.03), (0.02, 0.028, 0.028), (0.2, 0.0, 0.0)], HL.P + 'head', seg=10, x=sp.x, y=sp.y, z=sp.z, rx=rad(-80))
        bd.ring_band('gold', 0.01, 0.032, 0.032, 0.014, 0.008, HL.P + 'head', seg=10, x=sp.x, y=sp.y, z=sp.z, rx=rad(-80))
        # plume between the ears
        base = face(0.5, 0.0, 0.03)
        bd.cyl('gold', 0.02, 0.015, 0.06, HL.P + 'head', seg=10, x=base.x, y=base.y, z=base.z, rx=rad(-150))
        for i in range(7):
            a = (i - 3) * 0.12
            pts = [base + V(0, 0.02, -0.04), base + V(a * 0.1, 0.1, -0.12), base + V(a * 0.3, 0.12, -0.28), base + V(a * 0.4, 0.06, -0.4)]
            bd.tube('accent', pts, [0.02, 0.04, 0.035, 0.0], HL.P + 'head', seg=6)
    saddle(bd, J, st, seat='leather_red', frame='wood_dark', trim='gold', cloth=None, high=True, rider_feet=feet)


# --- assembly ----------------------------------------------------------------------------------------------------


def rider_bones():
    out = []
    for bn, h, t, par in H.BONES:
        out.append((bn, h, t, par or 'saddle'))
    return out


def build_cavalry(coll, mats, name, rider_fn, kind, over, hstyle, dress_fn, index, bake):
    J = make_joints((1.0, 1.0, 1.0), **{**SEAT, **over})
    rider_keys = set(J) | {'pen0', 'pen1', 'pen2'}
    HJ = HL.make_joints(hstyle.scale)
    J.update(HJ)
    bones = HL.BONES + rider_bones() + PENNON_BONES
    names = [bn[0] for bn in bones]
    bd = Body(J, bone_names=names)
    rider_fn(bd)
    # lift the rider (and his joints) onto the saddle: seat bone (z 0.86) on the saddle seat
    sad = HJ['saddle']
    off = V(0, sad.y, sad.z + 0.02 - 0.86)
    bmesh.ops.translate(bd.bm, vec=off, verts=list(bd.bm.verts))
    for k in rider_keys:
        if k in J:
            J[k] = J[k] + off
    hand = grip_point(J, 'L', 0.05)
    feet = {s: J[f'ankle.{s}'].lerp(J[f'toe.{s}'], 0.45) for s in ('L', 'R')}
    HL.build_horse(bd, J, hstyle)
    dress_fn(bd, J, hstyle, hand, 'hand.L', feet)
    ob = bd.to_object(name + '_Mesh', coll, mats)
    ob.location = (index * 4.0, 0, 0)
    arm_ob, ob = finish(ob, name, J, bones, coll, bake)
    strides = write_cavalry_clips(arm_ob, J, kind)
    arm_ob['stride'] = round(strides['Walk'], 4)
    arm_ob['run_stride'] = round(strides['Gallop'], 4)
    arm_ob['height'] = round(max((ob.matrix_world @ v.co).z for v in ob.data.vertices), 3)
    return arm_ob, ob


def finish(ob, name, J, bones, coll, bake):
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    lib.smart_uv(ob, margin=0.002)
    if bake:
        g = lib._bake_ground(coll, ob.location, size=2.5)
        img = bpy.data.images.get(name + '_atlas') or bpy.data.images.new(name + '_atlas', 2048, 2048)
        img.scale(2048, 2048)
        lib.bake_emit(ob, img)
        bpy.data.objects.remove(g, do_unlink=True)
        split_roles(ob, name, img)
    arm_ob = H.make_armature(name, J, coll, location=ob.location, bones=bones)
    H.bind(ob, arm_ob)
    print(f'{name}: {tris} tris', flush=True)
    return arm_ob, ob


def build_infantry(coll, mats, name, fn, scale, over, style, run_style, index, bake):
    J = make_joints(scale, **over)
    bd = Body(J)
    fn(bd)
    ob = bd.to_object(name + '_Mesh', coll, mats)
    ob.location = (index * 4.0, 0, 0)
    arm_ob, ob = finish(ob, name, J, H.BONES, coll, bake)
    bpy.context.scene.render.fps = H.FPS
    walk, stride = H.walk_pose(J, 30, style)
    H.write_action(arm_ob, 'Walk', 30, walk)
    run, run_stride = H.walk_pose(J, 20, {**style, **run_style})
    H.write_action(arm_ob, 'Run', 20, run)
    H.write_action(arm_ob, 'Idle', 90, H.idle_pose(J, 90, style))
    arm_ob['stride'] = round(stride, 4)
    arm_ob['run_stride'] = round(run_stride, 4)
    arm_ob['height'] = round(max((ob.matrix_world @ v.co).z for v in ob.data.vertices), 3)
    print(f'  stride {stride:.3f} run {run_stride:.3f}', flush=True)
    return arm_ob, ob


def split_roles(ob, name, img):
    roles, idx = [], []
    for p in ob.data.polygons:
        key = ob.material_slots[p.material_index].material.name.replace('unit_', '')
        role = UNIT_PALETTE[key][1]
        if role not in roles:
            roles.append(role)
        idx.append(roles.index(role))
    ob.data.materials.clear()
    for role in roles:
        metal, rough = ROLES[role]
        ob.data.materials.append(H.hero_export_material(f'{name}_{role.capitalize()}', img, metal, rough))
    for p, i in zip(ob.data.polygons, idx):
        p.material_index = i


# --- rider motion on top of the horse gait ------------------------------------------------------------------------


def rider_pose(kind, clip, frames):
    """Rider bones for one clip: stays upright against the horse's pitch, absorbs the bob,
    and (in the gallop) couches the lance or raises the spear."""
    def pose(f, st):
        p = st['p']
        pitch = math.degrees(st['pitch'])
        rots, locs = {}, {}
        s1, s2 = math.sin(TAU * p), math.sin(TAU * 2 * p)
        if clip == 'Walk':
            rots['hips'] = rot((X, -pitch * 0.6 + 1.0 * s2), (Y, 1.5 * s1))
            rots['spine'] = rot((X, 1.0 + 0.8 * math.sin(TAU * 2 * p - 0.6)), (Y, -1.0 * s1))
            rots['chest'] = rot((Y, -0.6 * s1))
            rots['neck'] = rot((X, -0.6 * math.sin(TAU * 2 * p - 1.2)))
            rots['head'] = rot((Z, 4 * math.sin(TAU * p * 0.5)))
            locs['hips'] = V(0, 0, -0.006 * s2)
            cape_amt, cape_lift, flut = 1.0, 8.0, 3.0
            pen_amp, pen_speed = 14.0, 2
        elif clip == 'Gallop':
            lean = 12.0
            rots['hips'] = rot((X, -pitch * 0.8 + lean * 0.5 + 2.0 * math.cos(TAU * (p - 0.2))))
            rots['spine'] = rot((X, lean * 0.3 + 2.5 * math.cos(TAU * (p - 0.35))))
            rots['chest'] = rot((X, lean * 0.2 + 2.0 * math.cos(TAU * (p - 0.45))))
            rots['neck'] = rot((X, -lean * 0.5))
            rots['head'] = rot((X, -lean * 0.4 - 2.5 * math.cos(TAU * (p - 0.5))))
            locs['hips'] = V(0, 0, -0.5 * (st['dz'] - (-0.07)) + 0.015)
            cape_amt, cape_lift, flut = 1.0, 62.0, 7.0
            pen_amp, pen_speed = 22.0, 3
            for sd in ('L', 'R'):
                rots[f'thigh.{sd}'] = rot((X, 6))
                rots[f'shin.{sd}'] = rot((X, 10 + 3 * math.cos(TAU * (p - 0.2))))
                rots[f'foot.{sd}'] = rot((X, -16))
        else:  # Idle
            rots['hips'] = rot((X, -pitch * 0.5))
            rots['spine'] = rot((X, 1.2 * s2))
            rots['chest'] = rot((X, -1.4 * s2))
            rots['neck'] = rot((Z, 10 * math.sin(TAU * p + 0.4)))
            rots['head'] = rot((Z, 12 * math.sin(TAU * p + 0.2)), (X, -2 * math.sin(TAU * p + 1.3)))
            cape_amt, cape_lift, flut = 1.0, 2.0, 2.0
            pen_amp, pen_speed = 10.0, 3
        # weapon arm
        if clip == 'Gallop' and kind == 'heavy':
            rots['shoulder.R'] = rot((X, 8))
            rots['upper_arm.R'] = rot((X, 26), (Y, 8))
            rots['forearm.R'] = rot((X, -52))
            rots['hand.R'] = rot((X, 101), (Y, -6), (Z, 6))
            rots['upper_arm.L'] = rot((X, -8))
        elif clip == 'Gallop' and kind == 'light':
            # spear levelled overarm, point forward and slightly down
            rots['shoulder.R'] = rot((X, -6))
            rots['upper_arm.R'] = rot((X, -35), (Y, -20))
            rots['forearm.R'] = rot((X, -30))
            rots['hand.R'] = rot((X, 95 + 3 * math.sin(TAU * p)))
            rots['upper_arm.L'] = rot((X, -10))
        else:
            rots['upper_arm.R'] = rot((X, 1.5 * s1))
            rots['upper_arm.L'] = rot((X, -1.5 * s1))
        # cape and pennon flutter
        c2 = TAU * pen_speed * p
        rots['cape_1'] = rot((X, (cape_lift * 0.55 + flut * math.sin(c2)) * cape_amt))
        rots['cape_2'] = rot((X, (cape_lift * 0.3 + flut * math.sin(c2 - 0.9)) * cape_amt))
        rots['cape_3'] = rot((X, (cape_lift * 0.2 + flut * 1.3 * math.sin(c2 - 1.8)) * cape_amt))
        if clip == 'Gallop' and kind == 'heavy':
            base = -95.0
        elif clip == 'Gallop' and kind == 'light':
            base = -85.0
        else:
            base = 0.0
        rots['pennon_1'] = rot((Z, pen_amp * math.sin(c2)), (X, base))
        rots['pennon_2'] = rot((Z, pen_amp * 1.4 * math.sin(c2 - 1.1)))
        return rots, locs
    return pose


def write_cavalry_clips(arm_ob, J, kind):
    bpy.context.scene.render.fps = H.FPS
    out = {}
    for clip, spec in (('Walk', HL.WALK), ('Gallop', HL.GALLOP)):
        g = HL.Gait(J, dict(spec))
        rp = rider_pose(kind, clip, spec['frames'])

        def pose(f, g=g, rp=rp):
            rots, locs, st = g.pose(f)
            r2, l2 = rp(f, st)
            rots.update(r2)
            locs.update(l2)
            return rots, locs
        # warm up the IK so the first frame starts from a solved pose
        for f in range(spec['frames']):
            g.pose(f)
        H.write_action(arm_ob, clip, spec['frames'], pose)
        out[clip] = spec['stride']
    ip = HL.idle_pose(J, 90)
    rp = rider_pose(kind, 'Idle', 90)

    def idle(f):
        rots, locs, st = ip(f)
        r2, l2 = rp(f, st)
        rots.update(r2)
        locs.update(l2)
        return rots, locs
    H.write_action(arm_ob, 'Idle', 90, idle)
    return out


# --- unit table ------------------------------------------------------------------------------------------------------

INFANTRY = {
    'LightInfantry': (light_infantry, (1.0, 1.0, 1.0), dict(
        elbow_R=(-0.28, -0.0, 1.19), wrist_R=(-0.3, -0.22, 1.1), hand_end_R=(-0.3, -0.31, 1.08),
        elbow_L=(0.3, 0.02, 1.2), wrist_L=(0.28, -0.22, 1.1), hand_end_L=(0.27, -0.31, 1.09)),
        dict(arm_L=0.3, arm_R=0.35, A=26, lean=4, cape=0.0, B=20),
        dict(A=36, K=80, lean=12, B=26, arm_L=0.4, arm_R=0.45)),
    'HeavyInfantry': (heavy_infantry, (1.08, 1.04, 1.03), dict(
        elbow_R=(-0.33, 0.0, 1.2), wrist_R=(-0.34, -0.2, 1.08), hand_end_R=(-0.34, -0.29, 1.05),
        elbow_L=(0.33, 0.04, 1.2), wrist_L=(0.3, -0.2, 1.1), hand_end_L=(0.29, -0.29, 1.09)),
        dict(arm_L=0.15, arm_R=0.4, A=22, K=50, lean=3, cape=0.8, B=16),
        dict(A=30, K=72, lean=10, B=20, arm_L=0.2, arm_R=0.5)),
}

CAVALRY = {
    'LightCavalry': (light_rider, 'light', dict(
        elbow_R=(-0.3, 0.02, 1.18), wrist_R=(-0.3, -0.2, 1.12), hand_end_R=(-0.3, -0.29, 1.11),
        elbow_L=(0.26, 0.02, 1.18), wrist_L=(0.14, -0.22, 1.1), hand_end_L=(0.1, -0.3, 1.09)),
        HL.HorseStyle(coat='horse_bay', mane='hair_black', scale=(0.92, 0.96, 0.95), leg=0.92, mane_long=True),
        light_horse_dress),
    'HeavyCavalry': (heavy_rider, 'heavy', dict(
        elbow_R=(-0.3, 0.02, 1.18), wrist_R=(-0.31, -0.2, 1.12), hand_end_R=(-0.31, -0.29, 1.11),
        elbow_L=(0.27, 0.02, 1.18), wrist_L=(0.15, -0.22, 1.1), hand_end_L=(0.11, -0.3, 1.09)),
        HL.HorseStyle(coat='horse_black', mane='hair_black', scale=(1.06, 1.03, 1.02), leg=1.12, feathers='hair_black', mane_long=False),
        heavy_horse_dress),
}

ORDER = ['LightInfantry', 'HeavyInfantry', 'LightCavalry', 'HeavyCavalry']


def export_unit(arm_ob, mesh_ob, path):
    loc = tuple(arm_ob.location)
    arm_ob.location = (0, 0, 0)
    ctx = bpy.context
    for o in ctx.selected_objects:
        o.select_set(False)
    arm_ob.select_set(True)
    mesh_ob.select_set(True)
    ctx.view_layer.objects.active = arm_ob
    for t in arm_ob.animation_data.nla_tracks:
        t.mute = False
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


def tint_accents(color=(0.62, 0.06, 0.05)):
    """Preview only: multiply the accent materials (baked or not) by a faction colour."""
    for m in bpy.data.materials:
        if not m.use_nodes or not (m.name.endswith('_Accent') or m.name.startswith('unit_accent')):
            continue
        nt = m.node_tree
        if m.name.endswith('_Accent'):
            src = next((n for n in nt.nodes if n.type == 'TEX_IMAGE'), None)
            dst = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if not src or not dst:
                continue
            out, inp = src.outputs['Color'], dst.inputs['Base Color']
        else:
            dst = next((n for n in nt.nodes if n.type == 'EMISSION'), None)
            if not dst or not dst.inputs['Color'].links:
                continue
            inp = dst.inputs['Color']
            out = inp.links[0].from_socket
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs[7].default_value = (*color, 1)
        nt.links.new(out, mix.inputs[6])
        nt.links.new(mix.outputs[2], inp)


def preview(arms, path, clip=None, frame=None):
    sc = bpy.context.scene
    n = len(arms)
    xs = []
    x = 0.0
    for a in arms:
        w = 3.2 if 'Cavalry' in a.name else 1.6
        xs.append(x + w / 2)
        x += w
    for a, cx in zip(arms, xs):
        a.location = (cx - x / 2, 0 if 'Cavalry' not in a.name else 0.4, 0)
        for t in a.animation_data.nla_tracks:
            t.mute = not (clip and frame is not None and (t.name == clip or (clip == 'Run' and t.name == 'Gallop') or (clip == 'Gallop' and t.name == 'Run')))
    sc.frame_set(frame if frame is not None else 0)
    tint_accents()
    W = x / 2 + 3
    ground = bpy.data.objects.new('pv_ground', bpy.data.meshes.new('pv_ground'))
    ground.data.from_pydata([(-W - 6, -8, 0), (W + 6, -8, 0), (W + 6, 10, 0), (-W - 6, 10, 0)], [], [(0, 1, 2, 3)])
    gm = bpy.data.materials.get('pv_groundmat') or bpy.data.materials.new('pv_groundmat')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.1, 0.12, 0.06, 1)
    ground.data.materials.append(gm)
    sc.collection.objects.link(ground)
    sun = bpy.data.objects.new('pv_sun', bpy.data.lights.new('pv_sun', 'SUN'))
    sun.data.energy = 4.5
    sun.data.color = (1.0, 0.92, 0.8)
    sun.rotation_euler = (0.85, 0.15, -0.6)
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('pv_cam', bpy.data.cameras.new('pv_cam'))
    sc.collection.objects.link(cam)
    cam.data.lens = 50
    target = V(float(os.environ.get('CAM_X', 0)), 0, float(os.environ.get('CAM_Z', 1.25)))
    d = float(os.environ.get('CAM_DIST', max(6.0, x * 1.25)))
    ca = math.radians(float(os.environ.get('CAM_ANGLE', 25)))
    cam.location = target + V(math.sin(ca) * d, -math.cos(ca) * d, d * 0.22)
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.world = sc.world or bpy.data.worlds.new('W')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs[0].default_value = (0.45, 0.55, 0.72, 1)
    sc.world.node_tree.nodes['Background'].inputs[1].default_value = 0.7
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = (int(os.environ.get('RES_X', 1800)), int(os.environ.get('RES_Y', 900)))
    frames = os.environ.get('FRAMES')
    if not frames:
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        return
    # contact sheet: one render per frame, stitched into a grid
    import numpy as np
    fs = [int(f) for f in frames.split(',')]
    cols = int(os.environ.get('COLS', min(4, len(fs))))
    tiles = []
    for f in fs:
        sc.frame_set(f)
        tmp = path.replace('.png', f'_f{f}.png')
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        im = bpy.data.images.load(tmp)
        w, h = im.size
        tiles.append(np.array(im.pixels[:]).reshape(h, w, 4))
        bpy.data.images.remove(im)
        os.remove(tmp)
    rows = (len(tiles) + cols - 1) // cols
    h, w = tiles[0].shape[:2]
    sheet = np.ones((rows * h, cols * w, 4))
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = t
    out = bpy.data.images.new('sheet', cols * w, rows * h, alpha=True)
    out.pixels[:] = sheet.ravel()
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()


if __name__ != 'build_units':
    _bake = os.environ.get('BAKE', '1') != '0'
    _only = os.environ.get('ONLY')
    lib.clear_startup_scene()
    _coll = lib.fresh_collection('Units')
    lib.setup_cycles(samples=16)
    _mats = make_materials()
    _built = []
    for _i, _name in enumerate(ORDER):
        if _only and _name not in _only.split(','):
            continue
        if _name in INFANTRY:
            _fn, _scale, _over, _style, _run = INFANTRY[_name]
            _arm, _mesh = build_infantry(_coll, _mats, _name, _fn, _scale, _over, _style, _run, _i, _bake)
        else:
            _fn, _kind, _over, _hs, _dress = CAVALRY[_name]
            _arm, _mesh = build_cavalry(_coll, _mats, _name, _fn, _kind, _over, _hs, _dress, _i, _bake)
        _built.append((_name, _arm, _mesh))
    if _bake and os.environ.get('EXPORT', '1') != '0':
        for _name, _arm, _mesh in _built:
            export_unit(_arm, _mesh, os.path.join(OUT_DIR, _name.lower() + '.glb'))
    if os.environ.get('PREVIEW'):
        _pose = os.environ.get('POSE') or (os.environ.get('FRAMES', '').split(',')[0] or None)
        preview([a for _, a, _ in _built], os.environ['PREVIEW'], os.environ.get('CLIP', 'Walk'), int(_pose) if _pose else None)
