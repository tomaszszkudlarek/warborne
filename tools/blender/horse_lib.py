"""Rigged horses for the cavalry units: skeleton, body builder and IK gait cycles.

Used by build_units.py. Same conventions as hero_lib: Blender Z-up, the horse faces
-Y, its left is +X, units are metres. The base horse is a destrier (withers about
1.62 m); a joint scale gives lighter breeds.

The rig is one armature: a spine (body -> pelvis / chest -> neck -> head), a tail
chain, a `saddle` bone the rider's hips hang from, and four legs. Leg poses are
solved each frame with a small two-parameter IK in the side (Y-Z) plane: a swing of
the whole leg plus one flexion value that bends the joints together (like the
reciprocal apparatus of a real horse), so planted hooves never slide.
"""
import math

from mathutils import Vector

import hero_lib as H
from hero_lib import rot, smooth, lerp, X, Y, Z

TAU = math.tau
P = 'horse_'

# --- skeleton -----------------------------------------------------------------------------------

BASE_JOINTS = {
    'body': (0, 0.12, 1.3), 'body_t': (0, -0.38, 1.36), 'pelvis_t': (0, 0.64, 1.44),
    'chest_t': (0, -0.64, 1.44), 'neck1': (0, -0.86, 1.72), 'poll': (0, -1.04, 1.96), 'muzzle': (0, -1.44, 1.5),
    'tail0': (0, 0.86, 1.47), 'tail1': (0, 0.97, 1.3), 'tail2': (0, 1.02, 1.02), 'tail3': (0, 1.04, 0.66),
    'saddle': (0, -0.1, 1.6), 'saddle_t': (0, -0.1, 1.75),
    'withers.L': (0.15, -0.42, 1.52), 'fshoulder.L': (0.2, -0.74, 1.14), 'felbow.L': (0.2, -0.56, 0.9),
    'fknee.L': (0.19, -0.58, 0.5), 'ffet.L': (0.19, -0.58, 0.18), 'ftoe.L': (0.19, -0.67, 0.02),
    'hip.L': (0.19, 0.5, 1.3), 'stifle.L': (0.22, 0.3, 0.94), 'hock.L': (0.19, 0.66, 0.56),
    'hfet.L': (0.19, 0.63, 0.18), 'htoe.L': (0.19, 0.55, 0.02),
}

BONES = [
    (P + 'body', 'body', 'body_t', None),
    (P + 'pelvis', 'body', 'pelvis_t', P + 'body'),
    (P + 'chest', 'body_t', 'chest_t', P + 'body'),
    (P + 'neck1', 'chest_t', 'neck1', P + 'chest'),
    (P + 'neck2', 'neck1', 'poll', P + 'neck1'),
    (P + 'head', 'poll', 'muzzle', P + 'neck2'),
    (P + 'tail1', 'tail0', 'tail1', P + 'pelvis'),
    (P + 'tail2', 'tail1', 'tail2', P + 'tail1'),
    (P + 'tail3', 'tail2', 'tail3', P + 'tail2'),
    ('saddle', 'saddle', 'saddle_t', P + 'body'),
]
for _s in ('L', 'R'):
    BONES += [
        (f'{P}scap.{_s}', f'withers.{_s}', f'fshoulder.{_s}', P + 'chest'),
        (f'{P}humerus.{_s}', f'fshoulder.{_s}', f'felbow.{_s}', f'{P}scap.{_s}'),
        (f'{P}forearm.{_s}', f'felbow.{_s}', f'fknee.{_s}', f'{P}humerus.{_s}'),
        (f'{P}fcannon.{_s}', f'fknee.{_s}', f'ffet.{_s}', f'{P}forearm.{_s}'),
        (f'{P}fhoof.{_s}', f'ffet.{_s}', f'ftoe.{_s}', f'{P}fcannon.{_s}'),
        (f'{P}femur.{_s}', f'hip.{_s}', f'stifle.{_s}', P + 'pelvis'),
        (f'{P}gaskin.{_s}', f'stifle.{_s}', f'hock.{_s}', f'{P}femur.{_s}'),
        (f'{P}hcannon.{_s}', f'hock.{_s}', f'hfet.{_s}', f'{P}gaskin.{_s}'),
        (f'{P}hhoof.{_s}', f'hfet.{_s}', f'htoe.{_s}', f'{P}hcannon.{_s}'),
    ]
BONE = {b[0]: b for b in BONES}


def make_joints(scale=(1.0, 1.0, 1.0)):
    """Joints scaled by (width, length, height); left joints mirrored to the right."""
    sx, sy, sz = scale
    J = {k: Vector((x * sx, y * sy, z * sz)) for k, (x, y, z) in BASE_JOINTS.items()}
    for k in list(J):
        if k.endswith('.L'):
            v = J[k]
            J[k[:-2] + '.R'] = Vector((-v.x, v.y, v.z))
    return J


def b(name, side=None):
    """Horse bone name: b('femur', 'L') -> 'horse_femur.L'."""
    return f'{P}{name}.{side}' if side else (name if name == 'saddle' else P + name)


# --- weights --------------------------------------------------------------------------------------


def w_near(J, *bones, power=6):
    return H.w_near(J, *[bn if bn in BONE else b(bn) for bn in bones], power=power, table=BONE)


def w_spine(J):
    """Barrel and back: pelvis behind, chest in front, body in the middle (by Y)."""
    y_p = J['body'].y + 0.12
    y_c = J['body_t'].y - 0.02

    def f(lo, co):
        wp = smooth(y_p - 0.1, y_p + 0.15, co.y)
        wc = smooth(y_c + 0.1, y_c - 0.15, co.y)
        return {P + 'pelvis': wp, P + 'chest': wc, P + 'body': max(0.0, 1 - wp - wc)}
    return f


def w_neck(J):
    """Neck: chest at the base, neck1, neck2 near the poll, following the neck axis."""
    a, m, c = J['chest_t'], J['neck1'], J['poll']

    def f(lo, co):
        axis = (c - a)
        t = (co - a).dot(axis) / axis.length_squared
        t1 = (m - a).dot(axis) / axis.length_squared
        w0 = smooth(0.08, -0.12, t)
        w2 = smooth(t1 - 0.05, t1 + 0.35, t)
        wh = smooth(0.92, 1.05, t)
        w2 -= wh
        return {P + 'chest': w0, P + 'neck1': max(0.0, 1 - w0 - max(w2, 0) - wh), P + 'neck2': max(w2, 0.0), P + 'head': wh}
    return f


def w_blend(fa, fb, t_fn):
    return H.blend_w(fa, fb, t_fn)


# --- building -----------------------------------------------------------------------------------------

# Barrel profile of the destrier: (y, half width, top z, bottom z), rear to front.
BARREL = [
    (0.95, 0.03, 1.49, 1.38),
    (0.92, 0.12, 1.55, 1.2),
    (0.86, 0.19, 1.585, 1.06),
    (0.76, 0.25, 1.615, 0.98),
    (0.6, 0.285, 1.625, 0.965),
    (0.38, 0.3, 1.585, 0.95),
    (0.12, 0.315, 1.54, 0.9),
    (-0.12, 0.318, 1.55, 0.87),
    (-0.34, 0.305, 1.6, 0.86),
    (-0.5, 0.28, 1.66, 0.875),
    (-0.64, 0.25, 1.62, 0.92),
    (-0.76, 0.21, 1.53, 0.97),
    (-0.85, 0.15, 1.43, 1.03),
    (-0.9, 0.06, 1.34, 1.12),
]


def barrel_at(y):
    """Interpolated (half width, top, bottom) of the barrel at y (base proportions)."""
    pr = sorted(BARREL, key=lambda r: r[0])
    if y <= pr[0][0]:
        return pr[0][1:]
    for a, c in zip(pr, pr[1:]):
        if a[0] <= y <= c[0]:
            t = (y - a[0]) / (c[0] - a[0])
            return tuple(lerp(a[i], c[i], t) for i in (1, 2, 3))
    return pr[-1][1:]


BARREL_SQ = 2.35


def barrel_point(y, ang, off=0.0):
    """Point on the barrel surface (base proportions) at y; ang 0 = top, +pi/2 = left side, pi = belly."""
    hw, top, bot = barrel_at(y)
    cz, rz = (top + bot) / 2, (top - bot) / 2
    s, c = math.sin(ang), math.cos(ang)
    e = 2.0 / BARREL_SQ
    x = (hw + off) * math.copysign(abs(s) ** e, s)
    z = cz + (rz + off) * math.copysign(abs(c) ** e, c)
    return Vector((x, y, z))


class HorseStyle:
    def __init__(self, coat='horse_bay', mane='hair_black', hoof='hoof', muzzle='horse_muzzle', eye='eye',
                 scale=(1.0, 1.0, 1.0), leg=1.0, feathers=None, mane_long=True, tail_long=True, mane_side=-1):
        self.coat, self.mane, self.hoof, self.muzzle, self.eye = coat, mane, hoof, muzzle, eye
        self.scale = scale
        self.leg = leg            # leg thickness factor
        self.feathers = feathers  # material for fetlock feathering (None = clean legs)
        self.mane_long = mane_long
        self.tail_long = tail_long
        self.mane_side = mane_side


def neck_frame(J):
    """(base centre, poll-side end) of the neck axis."""
    return J['chest_t'] + Vector((0, -0.02, -0.12)), J['poll'] + Vector((0, 0.0, -0.03))


NECK_RINGS = [(-0.12, 0.22, 0.26, 0, 0.0), (0.0, 0.215, 0.25, 0, 0.0), (0.18, 0.185, 0.225, 0, 0.02), (0.36, 0.155, 0.19, 0, 0.035),
              (0.54, 0.13, 0.16, 0, 0.03), (0.7, 0.11, 0.135, 0, 0.005), (0.8, 0.095, 0.11, 0, -0.01), (0.84, 0.0, 0.0, 0, -0.01)]

HEAD_RINGS = [(-0.07, 0.0, 0.0, 0, -0.01), (-0.05, 0.07, 0.09, 0, -0.01), (0.0, 0.095, 0.135, 0, -0.035), (0.08, 0.105, 0.165, 0, -0.065),
              (0.17, 0.098, 0.15, 0, -0.05), (0.27, 0.083, 0.11, 0, -0.008), (0.4, 0.068, 0.088, 0, 0.004), (0.5, 0.068, 0.09, 0, -0.002),
              (0.57, 0.07, 0.092, 0, -0.008), (0.63, 0.058, 0.07, 0, -0.012), (0.655, 0.0, 0.0, 0, -0.012)]


def head_frame(J):
    return J['poll'] + Vector((0, 0.01, 0.0)), J['muzzle']


def build_horse(bd, J, st):
    """Adds the horse to Body `bd` (whose joints include the horse joints J)."""
    coat = st.coat
    sx, sy, sz = st.scale
    lg = st.leg
    wsp = w_spine(J)
    # barrel
    with bd.frame(s=st.scale):
        with bd.along(Vector((0, BARREL[0][0], 1.3)), Vector((0, BARREL[-1][0], 1.3))):
            rings = [(BARREL[0][0] - y, hw, (top - bot) / 2, 0, (top + bot) / 2 - 1.3) for (y, hw, top, bot) in BARREL]
            bd.loft(coat, rings, wsp, seg=28, sq=BARREL_SQ)
        # chest (pectorals) between the forelegs, withers ridge, spine groove and belly
        for sg in (1, -1):
            bd.ellipsoid(coat, 0.1, 0.07, 0.15, w_blend(P + 'chest', w_near(J, 'chest', f'humerus.{"L" if sg > 0 else "R"}', power=2),
                                                        lambda lo, co: 0.4), seg=16, n=8, x=sg * 0.085, y=-0.77, z=1.08, rx=0.25)
        bd.ellipsoid(coat, 0.14, 0.34, 0.1, wsp, seg=16, n=8, y=-0.44, z=1.57)
        bd.ellipsoid(coat, 0.22, 0.3, 0.1, wsp, seg=16, n=8, y=0.62, z=1.54)
    # shoulders, forearms, hindquarters and hind legs
    for side, sg in (('L', 1), ('R', -1)):
        _foreleg(bd, J, st, side, sg)
        _hindleg(bd, J, st, side, sg)
    # neck
    n0, n1 = neck_frame(J)
    wn = w_neck(J)
    with bd.along(n0, n1) as L:
        k = L / 0.8
        bd.loft(coat, [(r[0] * k, r[1] * sx, r[2] * sy, 0, r[4]) for r in NECK_RINGS], wn, seg=22, sq=2.1)
        # crest muscle along the top and the jugular groove underneath
        bd.ellipsoid(coat, 0.07 * sx, 0.06, 0.3 * k, wn, seg=14, n=8, y=0.15, z=0.42 * k)
    # head
    h0, h1 = head_frame(J)
    with bd.along(h0, h1) as L:
        k = L / 0.62
        rings = [(r[0] * k, r[1] * sx, r[2] * sy, 0, r[4]) for r in HEAD_RINGS]
        bd.loft(coat, rings, P + 'head', seg=22, sq=2.2)
        # cheek (masseter) discs, brow bones, eyes
        for sg in (1, -1):
            bd.ellipsoid(coat, 0.03, 0.08, 0.075, P + 'head', seg=14, n=7, x=sg * 0.083 * sx, y=-0.07, z=0.1 * k)
            bd.ellipsoid(coat, 0.028, 0.025, 0.035, P + 'head', seg=10, n=5, x=sg * 0.07 * sx, y=0.06, z=0.12 * k)
            bd.ellipsoid(st.eye, 0.018, 0.024, 0.026, P + 'head', seg=10, n=5, x=sg * 0.082 * sx, y=0.03, z=0.15 * k)
            # nostrils and the soft muzzle
            bd.ellipsoid(st.muzzle, 0.022, 0.012, 0.03, P + 'head', seg=10, n=5, x=sg * 0.042, y=0.045, z=0.6 * k, rx=-0.3)
        bd.ellipsoid(st.muzzle, 0.075 * sx, 0.094, 0.06, P + 'head', seg=16, n=8, y=-0.005, z=0.6 * k)
        bd.ellipsoid(st.muzzle, 0.05 * sx, 0.04, 0.05, P + 'head', seg=12, n=6, y=-0.07, z=0.56 * k)
        # ears
        for sg in (1, -1):
            with bd.frame(sg * 0.06, 0.1, -0.02, rx=math.radians(-138), ry=sg * math.radians(14)):
                bd.loft(coat, [(-0.02, 0.02, 0.025), (0.0, 0.028, 0.035), (0.06, 0.03, 0.035, 0, -0.005), (0.12, 0.018, 0.02, 0, -0.012),
                               (0.16, 0.0, 0.0, 0, -0.02)], P + 'head', seg=10)
                bd.loft(st.muzzle, [(0.0, 0.02, 0.022, 0, -0.018), (0.1, 0.012, 0.012, 0, -0.022), (0.13, 0.0, 0.0, 0, -0.024)], P + 'head', seg=8)
    _mane(bd, J, st)
    _tail(bd, J, st)


def _foreleg(bd, J, st, side, sg):
    coat, lg = st.coat, st.leg
    sx, sy, sz = st.scale
    sc, hu, fa, fc, fh = (b(n, side) for n in ('scap', 'humerus', 'forearm', 'fcannon', 'fhoof'))
    w_sh = w_near(J, 'chest', sc, hu, power=3)
    # shoulder blade muscle on the side of the chest
    with bd.along(J[f'withers.{side}'] + Vector((0, 0.03, 0.06)), J[f'fshoulder.{side}']) as L:
        bd.loft(coat, [(-0.04, 0.02 * lg, 0.06), (0.06, 0.06 * lg, 0.14), (0.28, 0.075 * lg, 0.17), (0.46, 0.07 * lg, 0.13), (L + 0.05, 0.05 * lg, 0.08),
                       (L + 0.08, 0.0, 0.0)], w_sh, seg=16, x=sg * 0.055 * sx)
    # upper arm (triceps) from the point of shoulder to the elbow
    w_hu = w_near(J, sc, hu, fa, power=3)
    with bd.along(J[f'fshoulder.{side}'] + Vector((0, -0.02, 0.04)), J[f'felbow.{side}'] + Vector((0, 0.02, -0.03))) as L:
        bd.loft(coat, [(-0.04, 0.0, 0.0), (0.0, 0.075 * lg, 0.08), (0.12, 0.1 * lg, 0.13, 0, 0.02), (0.26, 0.095 * lg, 0.13, 0, 0.03), (L + 0.02, 0.06 * lg, 0.07),
                       (L + 0.05, 0.0, 0.0)], w_hu, seg=16, x=sg * 0.03 * sx)
    # forearm: muscular at the top, slim above the knee
    w_fa = w_near(J, hu, fa, fc)
    with bd.along(J[f'felbow.{side}'], J[f'fknee.{side}']) as L:
        bd.loft(coat, [(-0.1, 0.0, 0.0, 0, -0.03), (-0.07, 0.07 * lg, 0.08, 0, -0.02), (0.02, 0.078 * lg, 0.09, 0, 0.0), (0.14, 0.066 * lg, 0.075, 0, 0.005),
                       (L * 0.72, 0.047 * lg, 0.05), (L - 0.02, 0.044 * lg, 0.047)], w_fa, seg=16)
    # knee, cannon with the tendon behind, fetlock
    k = J[f'fknee.{side}']
    bd.ellipsoid(coat, 0.05 * lg, 0.055, 0.06, w_near(J, fa, fc), seg=14, n=7, x=k.x, y=k.y - 0.005, z=k.z)
    _lower_leg(bd, J, st, side, f'fknee.{side}', f'ffet.{side}', f'ftoe.{side}', fa, fc, fh)


def _hindleg(bd, J, st, side, sg):
    coat, lg = st.coat, st.leg
    sx, sy, sz = st.scale
    fe, ga, hc, hh = (b(n, side) for n in ('femur', 'gaskin', 'hcannon', 'hhoof'))
    # hindquarter: the big thigh muscle mass from the hip to the stifle and the buttock
    hip, sti = J[f'hip.{side}'], J[f'stifle.{side}']
    wq = w_near(J, 'pelvis', fe, power=2.5)
    c = hip.lerp(sti, 0.45) + Vector((sg * 0.02 * sx, 0.08 * sy, 0.0))
    bd.ellipsoid(coat, 0.1 * sx * lg, 0.27 * sy, 0.3 * sz, wq, seg=18, n=10, x=c.x, y=c.y, z=c.z, rx=math.radians(-18))
    bd.ellipsoid(coat, 0.08 * sx * lg, 0.14 * sy, 0.22 * sz, w_near(J, 'pelvis', fe, ga, power=3), seg=16, n=8,
                 x=c.x - sg * 0.02, y=c.y + 0.2 * sy, z=c.z - 0.1 * sz, rx=math.radians(10))
    # stifle
    bd.ellipsoid(coat, 0.07 * lg, 0.08, 0.08, w_near(J, fe, ga, power=4), seg=14, n=7, x=sti.x, y=sti.y + 0.03, z=sti.z + 0.02)
    # gaskin: second thigh, muscular behind
    w_ga = w_near(J, fe, ga, hc)
    with bd.along(J[f'stifle.{side}'], J[f'hock.{side}']) as L:
        bd.loft(coat, [(-0.08, 0.06 * lg, 0.08, 0, -0.01), (0.04, 0.085 * lg, 0.12, 0, -0.01), (0.2, 0.07 * lg, 0.1, 0, -0.025),
                       (L * 0.72, 0.05 * lg, 0.065, 0, -0.01), (L - 0.02, 0.045 * lg, 0.055)], w_ga, seg=16)
    # hock with the point of the hock behind
    hk = J[f'hock.{side}']
    w_hk = w_near(J, ga, hc, power=5)
    bd.ellipsoid(coat, 0.048 * lg, 0.06, 0.07, w_hk, seg=14, n=7, x=hk.x, y=hk.y - 0.005, z=hk.z - 0.01)
    bd.ellipsoid(coat, 0.03 * lg, 0.05, 0.035, w_hk, seg=10, n=5, x=hk.x, y=hk.y + 0.045, z=hk.z + 0.03, rx=0.6)
    _lower_leg(bd, J, st, side, f'hock.{side}', f'hfet.{side}', f'htoe.{side}', ga, hc, hh)


def _lower_leg(bd, J, st, side, top, fet, toe, up_bone, cannon, hoof):
    coat, lg = st.coat, st.leg
    w_c = w_near(J, up_bone, cannon, hoof)
    with bd.along(J[top], J[fet]) as L:
        bd.loft(coat, [(0.0, 0.046 * lg, 0.05), (0.08, 0.04 * lg, 0.046, 0, -0.004), (L * 0.7, 0.038 * lg, 0.046, 0, -0.008), (L, 0.043 * lg, 0.052, 0, -0.01)],
                w_c, seg=14)
    f, t = J[fet], J[toe]
    w_f = w_near(J, cannon, hoof, power=5)
    bd.ellipsoid(coat, 0.05 * lg, 0.058, 0.055, w_f, seg=14, n=7, x=f.x, y=f.y + 0.012, z=f.z)
    # pastern down to the coronet, then the hoof standing on the ground
    g = Vector((t.x, t.y + 0.055 * lg, 0.0))
    cor = Vector((t.x, t.y + 0.07 * lg, 0.095 * lg))
    bd.tube(coat, [f + Vector((0, 0.01, -0.02)), f.lerp(cor, 0.5) + Vector((0, 0.005, 0)), cor], [0.043 * lg, 0.04 * lg, 0.046 * lg], w_near(J, cannon, hoof, power=4), seg=12)
    with bd.frame(g.x, g.y, g.z):
        bd.loft(st.hoof, [(0.0, 0.062 * lg, 0.068 * lg, 0, 0.0), (0.012, 0.064 * lg, 0.07 * lg, 0, 0.0), (0.06, 0.056 * lg, 0.058 * lg, 0, 0.018),
                          (0.1 * lg, 0.048 * lg, 0.05 * lg, 0, 0.032)], hoof, seg=16, cap1=True)
    if st.feathers:
        import random
        rng = random.Random(hash(fet) & 0xffff)
        n = 16
        for i in range(n):
            a = TAU * i / n + rng.uniform(-0.1, 0.1)
            back = max(0.0, math.cos(a))  # longer at the back (+Y)
            p0 = f + Vector((math.sin(a) * 0.045 * lg, math.cos(a) * 0.05 * lg + 0.01, 0.06))
            out = Vector((math.sin(a), math.cos(a), 0))
            p2 = Vector((g.x, g.y, 0.0)) + out * (0.085 + 0.04 * back) * lg + Vector((0, 0.03 * back, 0.01 + rng.uniform(0, 0.02)))
            p1 = p0.lerp(p2, 0.5) + out * 0.025
            bd.tube(st.feathers, [p0, p1, p2], [0.024 * lg, 0.02 * lg, 0.0], w_blend(cannon, hoof, lambda lo, co: smooth(f.z + 0.05, f.z - 0.08, co.z)), seg=6)


def _mane(bd, J, st):
    """Mane falling to one side of the crest, and a forelock between the ears."""
    n0, n1 = neck_frame(J)
    wn = w_neck(J)
    axis = (n1 - n0)
    L = axis.length
    d = axis.normalized()
    up = d.cross(Vector((1, 0, 0))).normalized()  # crest side (back / up)
    if up.z < 0:
        up = -up
    side = st.mane_side
    count = 26
    import random
    rng = random.Random(3)
    for i in range(count):
        t = 0.06 + 0.9 * i / (count - 1)
        k = L / 0.8
        z = t * 0.84 * k
        rx, ry, cy = _ring(NECK_RINGS, z / k)
        base = n0 + d * z + up * (ry * st.scale[1] + cy + 0.015)
        length = (0.26 if st.mane_long else 0.14) * (0.85 + 0.3 * rng.random()) * (0.75 + 0.35 * math.sin(t * math.pi))
        sidev = Vector((side, 0, 0))
        tip = base + sidev * (rx * st.scale[0] + 0.05) + Vector((0, 0.05, -length))
        mid = base + sidev * (rx * st.scale[0] * 0.9) + Vector((0, 0.02, -length * 0.3)) + up * 0.03
        w = 0.05 + 0.02 * rng.random()
        bd.tube(st.mane, [base - sidev * 0.02, mid, tip], [w * 0.55, w * 0.5, 0.0], wn, seg=6)
        # a few strands over the other side for volume at the crest
        if i % 3 == 0:
            bd.tube(st.mane, [base, base - sidev * 0.06 + Vector((0, 0.02, -0.06))], [0.03, 0.0], wn, seg=5)
    # forelock
    h0, h1 = head_frame(J)
    hd = (h1 - h0).normalized()
    fu = hd.cross(Vector((1, 0, 0))).normalized()
    if fu.z < 0:
        fu = -fu
    top = h0 + fu * 0.1 - hd * 0.02
    for sgx in (-1, 0, 1):
        p0 = top + Vector((sgx * 0.02, 0, 0))
        p1 = p0 + hd * 0.1 + fu * 0.035 + Vector((sgx * 0.01, 0, 0))
        p2 = p0 + hd * 0.2 + fu * 0.02 + Vector((sgx * 0.02, 0, 0))
        bd.tube(st.mane, [p0, p1, p2], [0.025, 0.02, 0.0], P + 'head', seg=6)


def _ring(rings, z):
    rs = sorted(rings, key=lambda r: r[0])
    for a, c in zip(rs, rs[1:]):
        if a[0] <= z <= c[0]:
            t = (z - a[0]) / max(1e-9, c[0] - a[0])
            return lerp(a[1], c[1], t), lerp(a[2], c[2], t), lerp(a[4], c[4], t)
    r = rs[0] if z < rs[0][0] else rs[-1]
    return r[1], r[2], r[4]


def _tail(bd, J, st):
    """Tail dock plus a full fall of hair, weighted down the tail chain."""
    t0, t1, t2, t3 = J['tail0'], J['tail1'], J['tail2'], J['tail3']
    wt = w_near(J, 'pelvis', 'tail1', 'tail2', 'tail3', power=4)
    bd.tube(st.coat, [t0 + Vector((0, -0.05, 0.01)), t0, t0.lerp(t1, 0.5)], [0.07, 0.065, 0.05], w_near(J, 'pelvis', 'tail1', power=4), seg=10)
    import random
    rng = random.Random(7)
    length = 1.0 if st.tail_long else 0.75
    for i in range(14):
        a = TAU * i / 14
        o = Vector((math.cos(a) * 0.035, math.sin(a) * 0.03, 0))
        spread = Vector((math.cos(a) * 0.05, 0.02 + math.sin(a) * 0.04, 0))
        pts = [t0.lerp(t1, 0.4) + o, t1 + o * 1.4, t2 + o * 1.8 + spread * 0.6, t2.lerp(t3, 0.5) + o * 1.7 + spread,
               t3.lerp(t3 + (t3 - t2), length - 0.8) + spread * 1.2 + Vector((0, 0, rng.uniform(0.0, 0.12)))]
        bd.tube(st.mane, pts, [0.045, 0.05, 0.048, 0.035, 0.0], wt, seg=6)


# --- tack ------------------------------------------------------------------------------------------------


def bridle(bd, J, strap, metal, tassel=None):
    """Headstall, noseband, browband and bit rings."""
    h0, h1 = head_frame(J)
    with bd.along(h0, h1) as L:
        k = L / 0.62

        def band(t, extra=0.012, width=0.022, mat=strap):
            rx, ry, cy = _ring(HEAD_RINGS, t / k)
            bd.ring_band(mat, t, rx + extra, ry + extra, width, 0.012, P + 'head', seg=20, cy=cy)
        band(0.03 * k, 0.015)       # crown piece / throatlatch
        band(0.5 * k, 0.012)        # noseband
        # browband
        bd.tube(strap, [Vector((0.1, 0.06, 0.05)), Vector((0, 0.11, 0.04)), Vector((-0.1, 0.06, 0.05))], 0.01, P + 'head', seg=6)
        # cheek pieces
        for sg in (1, -1):
            bd.tube(strap, [Vector((sg * 0.1, 0.0, 0.04)), Vector((sg * 0.095, 0.0, 0.3 * k)), Vector((sg * 0.078, 0.0, 0.57 * k))], 0.009, P + 'head', seg=6)
            bd.ring_band(metal, 0.0, 0.03, 0.03, 0.012, 0.007, P + 'head', seg=12, x=sg * 0.075, y=-0.045, z=0.6 * k, ry=math.pi / 2)
            bd.sphere(metal, 0.016, P + 'head', seg=10, n=5, x=sg * 0.102, y=0.0, z=0.04)
        if tassel:
            bd.tube(strap, [Vector((0, -0.14, 0.12)), Vector((0, -0.2, 0.1))], 0.006, P + 'head', seg=5)
            bd.loft(tassel, [(0.0, 0.012, 0.012), (0.03, 0.03, 0.03), (0.12, 0.04, 0.04), (0.13, 0.0, 0.0)], P + 'head', seg=10, x=0, y=-0.2, z=0.1, rx=math.radians(160))


def _up(d):
    u = d.cross(Vector((1, 0, 0))).normalized()
    return -u if u.z < 0 else u


def reins(bd, J, strap, hand, hand_w, metal=None):
    """Reins from both bit rings, round the sides of the neck, to the rider's hand."""
    h0, h1 = head_frame(J)
    hd = h1 - h0
    L = hd.length
    d = hd.normalized()
    up = _up(d)
    n0, n1 = neck_frame(J)
    nd = (n1 - n0).normalized()
    nu = _up(nd)
    k = (n1 - n0).length / 0.8
    rx, ry, cy = _ring(NECK_RINGS, 0.62)
    for sg in (1, -1):
        bit = h0 + d * (0.6 * L) - up * 0.05 + Vector((sg * 0.08, 0, 0))
        way = n0 + nd * (0.62 * k) + nu * (cy + ry * 0.55) + Vector((sg * (rx + 0.025), 0, 0))
        hp = hand + Vector((sg * 0.025, 0, 0))
        wb = w_blend(P + 'head', P + 'neck2', lambda lo, co, a=bit, c=way: smooth(0.15, 0.95, (co - a).dot(c - a) / (c - a).length_squared))
        mid = bit.lerp(way, 0.5) + Vector((0, 0, -0.03))
        bd.tube(strap, [bit, mid, way], 0.008, wb, seg=5)
        wh = w_blend(P + 'neck2', hand_w, lambda lo, co, a=way, c=hp: smooth(0.05, 0.6, (co - a).dot(c - a) / (c - a).length_squared))
        mid2 = way.lerp(hp, 0.5) + Vector((0, 0, -0.04))
        bd.tube(strap, [way, mid2, hp], 0.008, wh, seg=5)


# --- gaits ---------------------------------------------------------------------------------------------------


def _r2(v, a):
    c, s = math.cos(a), math.sin(a)
    return (v[0] * c - v[1] * s, v[0] * s + v[1] * c)


def _yz(v):
    return (v.y, v.z)


class Leg:
    """One leg in the side plane. bones: chain from the root to the hoof; coup: joint
    angle per unit of flexion; flex_bone: index of the bone the swing folds (knee)."""

    def __init__(self, J, side, front):
        s = side
        if front:
            names = [b('scap', s), b('humerus', s), b('forearm', s), b('fcannon', s), b('fhoof', s)]
            joints = [f'withers.{s}', f'fshoulder.{s}', f'felbow.{s}', f'fknee.{s}', f'ffet.{s}', f'ftoe.{s}']
            self.coup = [0.0, 1.0, -2.0, 0.0]
            self.parent = P + 'chest'
            self.fold = 3        # the knee folds the cannon back in the swing
        else:
            names = [b('femur', s), b('gaskin', s), b('hcannon', s), b('hhoof', s)]
            joints = [f'hip.{s}', f'stifle.{s}', f'hock.{s}', f'hfet.{s}', f'htoe.{s}']
            self.coup = [-1.0, 2.0, -2.0]
            self.parent = P + 'pelvis'
            self.fold = 2        # extra hock fold in the swing
        self.front = front
        self.names = names
        self.pivot = _yz(J[joints[0]])
        self.vecs = [(J[joints[i + 1]].y - J[joints[i]].y, J[joints[i + 1]].z - J[joints[i]].z) for i in range(len(names))]
        self.fet = _yz(J[joints[-2]])
        self.toe = _yz(J[joints[-1]])
        self.n = len(names) - 1   # bones up to the fetlock
        self.x0 = [0.0, 0.0]

    def locals(self, a, f, fold):
        out = [self.coup[i] * f for i in range(self.n)]
        out[0] += a
        if self.front:
            out[self.fold] += fold
        else:
            out[self.fold] -= fold
            out[1] += fold * 0.5
        return out

    def end(self, pivot, base, a, f, fold):
        ang = base
        p = pivot
        for v, th in zip(self.vecs[:self.n], self.locals(a, f, fold)):
            ang += th
            r = _r2(v, ang)
            p = (p[0] + r[0], p[1] + r[1])
        return p, ang

    def solve(self, pivot, base, target, fold):
        a, f = self.x0
        for _ in range(30):
            (py, pz), _ = self.end(pivot, base, a, f, fold)
            ey, ez = py - target[0], pz - target[1]
            if ey * ey + ez * ez < 1e-10:
                break
            h = 1e-4
            (ay, az), _ = self.end(pivot, base, a + h, f, fold)
            (fy, fz), _ = self.end(pivot, base, a, f + h, fold)
            j11, j21 = (ay - py) / h, (az - pz) / h
            j12, j22 = (fy - py) / h, (fz - pz) / h
            lam = 1e-4
            # damped least squares
            a11, a12, a22 = j11 * j11 + j21 * j21 + lam, j11 * j12 + j21 * j22, j12 * j12 + j22 * j22 + lam
            g1, g2 = j11 * ey + j21 * ez, j12 * ey + j22 * ez
            det = a11 * a22 - a12 * a12
            da = -(a22 * g1 - a12 * g2) / det
            df = -(-a12 * g1 + a11 * g2) / det
            a += max(-0.3, min(0.3, da))
            f = max(-0.12, min(1.2, f + max(-0.3, min(0.3, df))))
        self.x0 = [a, f]
        return a, f


class Gait:
    """Procedural gait. spec keys:
      frames, stride (m per cycle), duty (stance fraction), phase {leg: offset},
      lift_f / lift_h (swing height of the fetlock), fold_f / fold_h (deg),
      flip (hoof flip in the swing, deg), reach_f / reach_h (shift of the foot
      centre forward), bob (m), bob_n (bobs per cycle), bob_phase, pitch (deg),
      pitch_phase, neck (deg), neck_phase, neck_n, tail (deg lift), roll (deg)."""

    LEGS = ('LF', 'RF', 'LH', 'RH')

    def __init__(self, J, spec):
        self.J = J
        self.s = spec
        self.legs = {k: Leg(J, k[0], k[1] == 'F') for k in self.LEGS}
        self.B0 = _yz(J['body'])
        self.C0 = _yz(J['body_t'])

    def body(self, p):
        s = self.s
        bob = s.get('bob', 0.0) * math.cos(TAU * (s.get('bob_n', 2) * p - s.get('bob_phase', 0.0)))
        pitch = math.radians(s.get('pitch', 0.0)) * math.cos(TAU * (p - s.get('pitch_phase', 0.0)))
        return bob + s.get('drop', 0.0), pitch

    def xf(self, bone_pitch, head, pt, dz, bpitch):
        """World (y, z) of rest point pt on a bone rotating about `head` after the body moved."""
        B0 = self.B0
        # body transform
        def body_t(q):
            r = _r2((q[0] - B0[0], q[1] - B0[1]), bpitch)
            return (B0[0] + r[0], B0[1] + r[1] + dz)
        h = body_t(head)
        r = _r2((pt[0] - head[0], pt[1] - head[1]), bpitch + bone_pitch)
        return (h[0] + r[0], h[1] + r[1])

    def pose(self, f):
        s = self.s
        N = s['frames']
        p = (f % N) / N
        dz, bp = self.body(p)
        cp = math.radians(s.get('chest_pitch', 0.0)) * math.cos(TAU * (p - s.get('chest_phase', 0.0)))
        pp = math.radians(s.get('pelvis_pitch', 0.0)) * math.cos(TAU * (p - s.get('pelvis_phase', 0.0)))
        rots, locs = {}, {}
        rots[P + 'body'] = rot((X, math.degrees(bp)), (Y, s.get('roll', 0.0) * math.sin(TAU * p)))
        locs[P + 'body'] = Vector((0, 0, dz))
        rots[P + 'chest'] = rot((X, math.degrees(cp)))
        rots[P + 'pelvis'] = rot((X, math.degrees(pp)))
        S = s['stride']
        duty = s['duty']
        for key, leg in self.legs.items():
            front = key[1] == 'F'
            ph = (p - s['phase'][key]) % 1.0
            base = bp + (cp if front else pp)
            head = self.C0 if front else self.B0
            pivot = self.xf(cp if front else pp, head, leg.pivot, dz, bp)
            sweep = S * duty
            yc = leg.fet[0] - s.get('reach_f' if front else 'reach_h', 0.0)
            fz = leg.fet[1]
            if ph < duty:
                u = ph / duty
                ty = yc - sweep / 2 + sweep * u
                tz = fz
                fold = 0.0
                flip = 0.0
            else:
                u = (ph - duty) / (1 - duty)
                e = u * u * (3 - 2 * u)
                e = lerp(u, e, 0.7)
                ty = yc + sweep / 2 - sweep * e
                lift = s.get('lift_f' if front else 'lift_h', 0.15)
                tz = fz + lift * math.sin(math.pi * u) ** 0.9
                fmax = math.radians(s.get('fold_f' if front else 'fold_h', 60.0))
                fold = fmax * math.sin(math.pi * min(1.0, u * 1.15)) ** 1.3
                flip = math.radians(s.get('flip', 50.0)) * math.sin(math.pi * u) ** 1.2
            a, fl = leg.solve(pivot, base, (ty, tz), fold)
            locs_ = leg.locals(a, fl, fold)
            ang = base
            for nm, th in zip(leg.names, locs_):
                rots[nm] = rot((X, math.degrees(th)))
                ang += th
            # hoof: flat on the ground in the stance, flipped back in the swing
            rest_ang = 0.0  # the hoof's world angle relative to rest
            want = rest_ang + flip
            total = sum(locs_) + base
            rots[leg.names[-1]] = rot((X, math.degrees(want - total)))
        # neck and head nod, tail
        nk = s.get('neck', 0.0) * math.cos(TAU * (s.get('neck_n', 1) * p - s.get('neck_phase', 0.0)))
        rots[P + 'neck1'] = rot((X, nk * 0.6 - math.degrees(bp) * 0.5 + s.get('neck_base', 0.0)))
        rots[P + 'neck2'] = rot((X, nk * 0.4 + s.get('neck_base2', 0.0)))
        rots[P + 'head'] = rot((X, -nk * 0.5 - math.degrees(bp) * 0.3 + s.get('head_base', 0.0)))
        tl = s.get('tail', 0.0)
        sw = s.get('tail_sway', 4.0)
        for i, nm in enumerate(('tail1', 'tail2', 'tail3')):
            rots[P + nm] = rot((X, tl * (0.5 if i == 0 else 0.3) + 2.0 * math.sin(TAU * (p * 2 - 0.15 * i))), (Z, sw * math.sin(TAU * (p - 0.12 * i))))
        return rots, locs, {'p': p, 'dz': dz, 'pitch': bp}


WALK = dict(frames=32, stride=1.75, duty=0.64, phase={'LH': 0.0, 'LF': 0.25, 'RH': 0.5, 'RF': 0.75},
            lift_f=0.14, lift_h=0.1, fold_f=70, fold_h=18, flip=45, reach_f=0.02, reach_h=0.0,
            bob=0.012, bob_n=2, bob_phase=0.1, pitch=0.8, pitch_phase=0.2, neck=3.5, neck_n=2, neck_phase=0.1,
            drop=-0.015, tail=6, tail_sway=5, roll=0.8)

GALLOP = dict(frames=18, stride=3.8, duty=0.3, phase={'LH': 0.0, 'RH': 0.1, 'LF': 0.3, 'RF': 0.4},
              lift_f=0.4, lift_h=0.34, fold_f=110, fold_h=40, flip=85, reach_f=0.12, reach_h=0.3,
              bob=0.055, bob_n=1, bob_phase=0.85, pitch=5.0, pitch_phase=0.45, neck=9, neck_n=1, neck_phase=0.35,
              chest_pitch=2.0, chest_phase=0.3, pelvis_pitch=3.0, pelvis_phase=0.95,
              drop=-0.07, tail=38, tail_sway=3, neck_base=6, head_base=4, roll=1.2)


def idle_pose(J, frames):
    """Standing: weight shifts, head drops and lifts, tail swishes; hooves stay put."""
    legs = {k: Leg(J, k[0], k[1] == 'F') for k in Gait.LEGS}
    B0, C0 = _yz(J['body']), _yz(J['body_t'])
    g = Gait(J, dict(frames=frames, stride=0.0, duty=1.0, phase={k: 0.0 for k in Gait.LEGS}))

    def pose(f):
        p = (f % frames) / frames
        s1, s2 = math.sin(TAU * p), math.sin(TAU * 2 * p)
        dz = -0.008 + 0.006 * s2
        bp = math.radians(0.6 * math.sin(TAU * p + 0.8))
        rots, locs = {}, {}
        rots[P + 'body'] = rot((X, math.degrees(bp)), (Y, 1.2 * s1))
        locs[P + 'body'] = Vector((0.012 * s1, 0, dz))
        for key, leg in legs.items():
            front = key[1] == 'F'
            head = C0 if front else B0
            pivot = g.xf(0.0, head, leg.pivot, dz, bp)
            a, fl = leg.solve(pivot, bp, leg.fet, 0.0)
            locs_ = leg.locals(a, fl, 0.0)
            for nm, th in zip(leg.names, locs_):
                rots[nm] = rot((X, math.degrees(th)))
            rots[leg.names[-1]] = rot((X, -math.degrees(sum(locs_) + bp)))
        # head: grazing glance down, then up and around
        look = math.sin(TAU * p + 0.5)
        rots[P + 'neck1'] = rot((X, 4 + 5 * look), (Z, 6 * math.sin(TAU * p)))
        rots[P + 'neck2'] = rot((X, 3 * look), (Z, 4 * math.sin(TAU * p - 0.4)))
        rots[P + 'head'] = rot((X, -3 * look + 2 * s2), (Z, 3 * math.sin(TAU * p - 0.8)))
        for i, nm in enumerate(('tail1', 'tail2', 'tail3')):
            sw = math.exp(-((p - 0.62) / 0.08) ** 2)
            rots[P + nm] = rot((X, 2 * math.sin(TAU * p * 3 - i * 0.4)), (Z, (6 + 22 * sw) * math.sin(TAU * (p * 3 - 0.12 * i))))
        return rots, locs, {'p': p, 'dz': dz, 'pitch': bp}

    return pose
