"""Rigged hero figures: skeleton, skinned-mesh builder and procedural walk/idle cycles.

Used by build_heroes.py. A figure is one bmesh whose vertices carry deform weights
for a shared humanoid skeleton. Parts are modelled in the rest pose, and the rest
pose can differ per hero (a raised sword arm, a staff held forward), so the walk
and idle cycles only add rotations on top of it.

Blender is Z-up and the figure faces -Y; the glTF exporter turns that into +Z
forward in three.js. The character's left is +X. Units are metres; a figure is
about 1.9 m tall and the game scales it to the map.
"""
import math
from contextlib import contextmanager

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector, Euler

TAU = math.tau
FPS = 30

# --- skeleton ---------------------------------------------------------------------------------

BASE_JOINTS = {
    'hips': (0, 0.0, 0.98),
    'spine': (0, 0.0, 1.12),
    'chest': (0, 0.0, 1.30),
    'neck': (0, 0.01, 1.51),
    'head': (0, 0.0, 1.59),
    'head_top': (0, 0.0, 1.88),
    'clav.L': (0.04, 0.0, 1.47),
    'arm.L': (0.2, 0.02, 1.45),
    'elbow.L': (0.25, 0.04, 1.17),
    'wrist.L': (0.28, 0.0, 0.93),
    'hand_end.L': (0.29, -0.01, 0.83),
    'leg.L': (0.1, 0.0, 0.92),
    'knee.L': (0.11, -0.02, 0.52),
    'ankle.L': (0.115, 0.02, 0.1),
    'toe.L': (0.12, -0.16, 0.03),
    'cape0': (0, 0.16, 1.47),
    'cape1': (0, 0.2, 1.05),
    'cape2': (0, 0.23, 0.6),
    'cape3': (0, 0.26, 0.12),
    'skirt_f0': (0, -0.1, 0.96),
    'skirt_f1': (0, -0.13, 0.45),
    'skirt_b0': (0, 0.1, 0.96),
    'skirt_b1': (0, 0.13, 0.45),
}

# (bone, head joint, tail joint, parent)
BONES = [
    ('hips', 'hips', 'spine', None),
    ('spine', 'spine', 'chest', 'hips'),
    ('chest', 'chest', 'neck', 'spine'),
    ('neck', 'neck', 'head', 'chest'),
    ('head', 'head', 'head_top', 'neck'),
]
for _s in ('L', 'R'):
    BONES += [
        (f'shoulder.{_s}', f'clav.{_s}', f'arm.{_s}', 'chest'),
        (f'upper_arm.{_s}', f'arm.{_s}', f'elbow.{_s}', f'shoulder.{_s}'),
        (f'forearm.{_s}', f'elbow.{_s}', f'wrist.{_s}', f'upper_arm.{_s}'),
        (f'hand.{_s}', f'wrist.{_s}', f'hand_end.{_s}', f'forearm.{_s}'),
        (f'thigh.{_s}', f'leg.{_s}', f'knee.{_s}', 'hips'),
        (f'shin.{_s}', f'knee.{_s}', f'ankle.{_s}', f'thigh.{_s}'),
        (f'foot.{_s}', f'ankle.{_s}', f'toe.{_s}', f'shin.{_s}'),
    ]
BONES += [
    ('cape_1', 'cape0', 'cape1', 'chest'),
    ('cape_2', 'cape1', 'cape2', 'cape_1'),
    ('cape_3', 'cape2', 'cape3', 'cape_2'),
    ('skirt_f', 'skirt_f0', 'skirt_f1', 'hips'),
    ('skirt_b', 'skirt_b0', 'skirt_b1', 'hips'),
]
BONE = {b[0]: b for b in BONES}
BONE_NAMES = [b[0] for b in BONES]


def make_joints(scale=(1.0, 1.0, 1.0), **overrides):
    """Base joints scaled by (width, depth, height); overrides are final positions.
    Left joints are mirrored to the right unless the right one is given too.
    Keyword names use '_L' / '_R' for '.L' / '.R'."""
    sx, sy, sz = scale
    J = {k: Vector((x * sx, y * sy, z * sz)) for k, (x, y, z) in BASE_JOINTS.items()}
    ov = {k.replace('_L', '.L').replace('_R', '.R') if k.endswith(('_L', '_R')) else k: Vector(v) for k, v in overrides.items()}
    J.update(ov)
    for k in list(J):
        if k.endswith('.L'):
            r = k[:-2] + '.R'
            if r not in ov:
                v = J[k]
                J[r] = Vector((-v.x, v.y, v.z))
    return J


# --- small maths ----------------------------------------------------------------------------------


def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
    return (a + ab * t - p).length


# --- weight functions (called with local and world coordinates of each vertex) ---------------------


def w_torso(J, shoulder=True):
    """Hips / spine / chest by height, easing into the shoulder bones near the arms."""
    zs, zc, za = J['spine'].z, J['chest'].z, J['arm.L'].z
    xa = J['arm.L'].x

    def f(lo, co):
        z = co.z
        wh = 1 - smooth(zs - 0.07, zs + 0.03, z)
        wc = smooth(zc - 0.06, zc + 0.04, z)
        w = {'hips': wh, 'spine': max(0.0, 1 - wh - wc), 'chest': wc}
        if shoulder:
            sh = smooth(xa * 0.6, xa * 1.05, abs(co.x)) * smooth(za - 0.18, za - 0.05, z) * 0.85
            if sh > 0:
                w = {k: v * (1 - sh) for k, v in w.items()}
                w['shoulder.L' if co.x > 0 else 'shoulder.R'] = sh
        return w
    return f


def w_near(J, *bones, power=6, table=None):
    """Inverse-distance weights to the given bone segments: smooth elbows and knees.
    `table` maps bone -> (name, head joint, tail joint, parent) for other skeletons."""
    table = table or BONE
    segs = [(b, J[table[b][1]], J[table[b][2]]) for b in bones]

    def f(lo, co):
        ws = {b: 1.0 / (seg_dist(co, a, c) ** power + 1e-14) for b, a, c in segs}
        s = sum(ws.values())
        return {b: v / s for b, v in ws.items()}
    return f


def w_zchain(*pairs):
    """[(z, bone), ...] from top to bottom: linear blend between neighbours by height."""
    def f(lo, co):
        z = co.z
        if z >= pairs[0][0]:
            return {pairs[0][1]: 1.0}
        for (z0, b0), (z1, b1) in zip(pairs, pairs[1:]):
            if z >= z1:
                t = (z0 - z) / (z0 - z1)
                return {b0: 1 - t, b1: t}
        return {pairs[-1][1]: 1.0}
    return f


def w_skirt(top_z, blend=0.2, sides=0.0):
    """Robes and tabards: the front follows skirt_f (the forward leg), the back skirt_b."""
    def f(lo, co):
        h = Vector((co.x, co.y, 0))
        c = -h.y / (h.length + 1e-9)
        depth = smooth(0.0, blend, top_z - co.z)
        wf = max(0.0, c) ** 1.6 * depth
        wb = max(0.0, -c) ** 1.6 * depth
        return {'hips': max(0.0, 1 - wf - wb), 'skirt_f': wf, 'skirt_b': wb}
    return f


def w_cape(J, top_bone='chest'):
    return w_zchain((J['cape0'].z - 0.04, top_bone), (J['cape1'].z + 0.12, 'cape_1'),
                    (J['cape2'].z + 0.1, 'cape_2'), (J['cape3'].z + 0.2, 'cape_3'))


def as_wf(w):
    """Bone name, {bone: w} dict or weight function -> weight function."""
    if isinstance(w, str):
        return lambda lo, co: {w: 1.0}
    if isinstance(w, dict):
        return lambda lo, co: w
    return w


def blend_w(fa, fb, t_fn):
    """Mix two weights (any form as_wf accepts) by t_fn(lo, co) in 0..1."""
    fa, fb = as_wf(fa), as_wf(fb)

    def f(lo, co):
        t = t_fn(lo, co)
        a, b = fa(lo, co), fb(lo, co)
        out = {}
        for k, v in a.items():
            out[k] = out.get(k, 0) + v * (1 - t)
        for k, v in b.items():
            out[k] = out.get(k, 0) + v * t
        return out
    return f


# --- primitive bmeshes (local space) -----------------------------------------------------------------


def _ring(bm, z, rx, ry, cx, cy, seg, sq, phase):
    if rx <= 1e-6 and ry <= 1e-6:
        return [bm.verts.new((cx, cy, z))]
    e = 2.0 / sq
    out = []
    for i in range(seg):
        a = phase + TAU * i / seg
        c, s = math.cos(a), math.sin(a)
        out.append(bm.verts.new((cx + rx * math.copysign(abs(c) ** e, c), cy + ry * math.copysign(abs(s) ** e, s), z)))
    return out


def _bridge(bm, rings, seg, flip):
    def face(vs):
        try:
            bm.faces.new(vs[::-1] if flip else vs)
        except ValueError:
            pass
    for A, B in zip(rings, rings[1:]):
        if len(A) == 1 and len(B) == 1:
            continue
        for i in range(seg):
            j = (i + 1) % seg
            if len(A) == 1:
                face((A[0], B[j], B[i]))
            elif len(B) == 1:
                face((A[i], A[j], B[0]))
            else:
                face((A[i], A[j], B[j], B[i]))


def loft_bm(rings, seg=16, cap0=True, cap1=True, sq=2.0, phase=0.0):
    """Lathe-like loft along local Z. rings: (z, rx, ry[, cx, cy]); a zero radius closes
    the shape to a point. Trace the profile along the outside surface (bottom to top)."""
    bm = bmesh.new()
    rs = [_ring(bm, r[0], r[1], r[2], r[3] if len(r) > 3 else 0.0, r[4] if len(r) > 4 else 0.0, seg, sq, phase) for r in rings]
    flip = rings[-1][0] < rings[0][0]
    _bridge(bm, rs, seg, flip)
    if cap0 and len(rs[0]) > 1:
        bm.faces.new(rs[0] if flip else rs[0][::-1])
    if cap1 and len(rs[-1]) > 1:
        bm.faces.new(rs[-1][::-1] if flip else rs[-1])
    return bm


def ellipsoid_rings(rx, ry, rz, n=8, z0=None, z1=None, cy=0.0):
    """Rings for loft_bm describing an ellipsoid centred at the origin (optionally cut)."""
    out = []
    for i in range(n + 1):
        t = math.pi * (1 - i / n)
        z = math.cos(t) * rz
        r = math.sin(t)
        out.append((z, rx * r, ry * r, 0.0, cy))
    if z0 is not None:
        out = [o for o in out if o[0] >= z0 - 1e-9]
    if z1 is not None:
        out = [o for o in out if o[0] <= z1 + 1e-9]
    return out


def tube_bm(pts, radii, seg=8, cap=True):
    """Sweep a circle along a polyline with parallel-transported frames."""
    pts = [Vector(p) for p in pts]
    if not isinstance(radii, (list, tuple)):
        radii = [radii] * len(pts)
    n = len(pts)
    tans = []
    for i in range(n):
        a, b = pts[max(0, i - 1)], pts[min(n - 1, i + 1)]
        tans.append((b - a).normalized())
    ref = Vector((0, 0, 1)) if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
    nrm = (ref - tans[0] * ref.dot(tans[0])).normalized()
    bm = bmesh.new()
    rings = []
    for i in range(n):
        if i > 0:
            q = tans[i - 1].rotation_difference(tans[i])
            nrm = (q @ nrm)
            nrm = (nrm - tans[i] * nrm.dot(tans[i])).normalized()
        bi = tans[i].cross(nrm)
        r = radii[i]
        if r <= 1e-6:
            rings.append([bm.verts.new(pts[i])])
            continue
        rings.append([bm.verts.new(pts[i] + (nrm * math.cos(a) + bi * math.sin(a)) * r) for a in (TAU * k / seg for k in range(seg))])
    _bridge(bm, rings, seg, False)
    if cap:
        if len(rings[0]) > 1:
            bm.faces.new(rings[0][::-1])
        if len(rings[-1]) > 1:
            bm.faces.new(rings[-1])
    return bm


def box_bm(sx, sy, sz, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=bevel, segments=1, affect='EDGES', profile=0.5)
    return bm


def sheet_bm(fn, nu, nv, thick=0.01, closed_u=False):
    """Thick cloth sheet: fn(u, v) -> Vector on the mid surface, u across, v along.
    Both faces plus the rim are built, so it is a closed shell."""
    P = [[Vector(fn(i / nu, j / nv)) for j in range(nv + 1)] for i in range(nu + (0 if closed_u else 1))]
    NU = len(P)

    def normal(i, j):
        iu0, iu1 = (i - 1) % NU if closed_u else max(0, i - 1), (i + 1) % NU if closed_u else min(NU - 1, i + 1)
        du = P[iu1][j] - P[iu0][j]
        dv = P[i][min(nv, j + 1)] - P[i][max(0, j - 1)]
        n = du.cross(dv)
        return n.normalized() if n.length > 1e-9 else Vector((0, 0, 1))

    bm = bmesh.new()
    F = [[bm.verts.new(P[i][j] + normal(i, j) * thick / 2) for j in range(nv + 1)] for i in range(NU)]
    B = [[bm.verts.new(P[i][j] - normal(i, j) * thick / 2) for j in range(nv + 1)] for i in range(NU)]
    iu = range(NU) if closed_u else range(NU - 1)
    for i in iu:
        i2 = (i + 1) % NU
        for j in range(nv):
            bm.faces.new((F[i][j], F[i2][j], F[i2][j + 1], F[i][j + 1]))
            bm.faces.new((B[i][j + 1], B[i2][j + 1], B[i2][j], B[i][j]))
    for i in iu:
        i2 = (i + 1) % NU
        bm.faces.new((F[i2][0], F[i][0], B[i][0], B[i2][0]))
        bm.faces.new((F[i][nv], F[i2][nv], B[i2][nv], B[i][nv]))
    if not closed_u:
        for j in range(nv):
            bm.faces.new((F[0][j + 1], F[0][j], B[0][j], B[0][j + 1]))
            bm.faces.new((F[NU - 1][j], F[NU - 1][j + 1], B[NU - 1][j + 1], B[NU - 1][j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def _xform(x=0, y=0, z=0, rx=0, ry=0, rz=0, s=1):
    sc = Matrix.Diagonal((*s, 1)) if isinstance(s, (tuple, list)) else Matrix.Scale(s, 4)
    return Matrix.Translation((x, y, z)) @ Euler((rx, ry, rz)).to_matrix().to_4x4() @ sc


# --- the figure builder ---------------------------------------------------------------------------------


class Body:
    """Accumulates one skinned mesh. Parts are placed through a transform stack and
    carry weights: a bone name, a {bone: w} dict or fn(local, world) -> dict."""

    def __init__(self, J, bone_names=None):
        self.J = J
        self.bone_names = bone_names or BONE_NAMES
        self.bm = bmesh.new()
        self.dl = self.bm.verts.layers.deform.verify()
        self.gi = {b: i for i, b in enumerate(self.bone_names)}
        self.mats = []
        self.stack = [Matrix.Identity(4)]

    @property
    def M(self):
        return self.stack[-1]

    def j(self, name):
        return self.J[name].copy()

    @contextmanager
    def frame(self, x=0, y=0, z=0, rx=0, ry=0, rz=0, s=1):
        self.stack.append(self.M @ _xform(x, y, z, rx, ry, rz, s))
        try:
            yield
        finally:
            self.stack.pop()

    @contextmanager
    def along(self, a, b, roll=0.0, side=None):
        """Frame at a with local Z toward b; local X stays near world X (or `side`)."""
        a = self.J[a] if isinstance(a, str) else Vector(a)
        b = self.J[b] if isinstance(b, str) else Vector(b)
        z = (b - a).normalized()
        ref = Vector(side) if side else Vector((1, 0, 0))
        if abs(z.dot(ref)) > 0.95:
            ref = Vector((0, 1, 0))
        x = (ref - z * ref.dot(z)).normalized()
        y = z.cross(x)
        m = Matrix((x, y, z)).transposed().to_4x4()
        m.translation = a
        m = m @ Matrix.Rotation(roll, 4, 'Z')
        self.stack.append(self.M @ m)
        try:
            yield (b - a).length
        finally:
            self.stack.pop()

    def _mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def add(self, part, mat, w, smooth=True, **place):
        M = self.M @ _xform(**place) if place else self.M
        mi = self._mi(mat)
        vmap = {}
        wf = as_wf(w)
        for v in part.verts:
            co = M @ v.co
            nv = self.bm.verts.new(co)
            ws = sorted(((k, x) for k, x in wf(v.co, co).items() if x > 1e-4), key=lambda kv: -kv[1])[:4]
            s = sum(x for _, x in ws) or 1.0
            for k, x in ws:
                nv[self.dl][self.gi[k]] = x / s
            vmap[v] = nv
        for f in part.faces:
            try:
                nf = self.bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            nf.material_index = mi
            nf.smooth = smooth
        part.free()

    # convenience wrappers -------------------------------------------------------------------------

    def loft(self, mat, rings, w, seg=16, sq=2.0, smooth=True, cap0=True, cap1=True, phase=0.0, **place):
        self.add(loft_bm(rings, seg, cap0, cap1, sq, phase), mat, w, smooth, **place)

    def ellipsoid(self, mat, ax, ay, az, w, seg=16, n=8, smooth=True, z0=None, z1=None, **place):
        self.add(loft_bm(ellipsoid_rings(ax, ay, az, n, z0, z1), seg), mat, w, smooth, **place)

    def sphere(self, mat, r, w, seg=12, n=6, **place):
        self.ellipsoid(mat, r, r, r, w, seg, n, **place)

    def box(self, mat, sx, sy, sz, w, bevel=0.0, smooth=False, **place):
        self.add(box_bm(sx, sy, sz, bevel), mat, w, smooth, **place)

    def cyl(self, mat, r1, r2, h, w, seg=12, smooth=True, cap=True, **place):
        self.add(loft_bm([(0, r1, r1), (h, r2, r2)], seg, cap, cap), mat, w, smooth, **place)

    def tube(self, mat, pts, radii, w, seg=8, smooth=True, cap=True, **place):
        self.add(tube_bm(pts, radii, seg, cap), mat, w, smooth, **place)

    def sheet(self, mat, fn, nu, nv, w, thick=0.012, smooth=True, closed_u=False, **place):
        self.add(sheet_bm(fn, nu, nv, thick, closed_u), mat, w, smooth, **place)

    def ring_band(self, mat, zc, ax, ay, h, t, w, seg=24, cy=0.0, sq=2.0, **place):
        """Band (belt, rim) at height zc round the local Z axis: outer radii ax/ay, thickness t."""
        rings = [(zc - h / 2, ax - t, ay - t, 0, cy), (zc - h / 2, ax, ay, 0, cy), (zc + h / 2, ax, ay, 0, cy), (zc + h / 2, ax - t, ay - t, 0, cy)]
        self.loft(mat, rings, w, seg, sq, cap0=False, cap1=False, **place)

    # finishing ------------------------------------------------------------------------------------

    def to_object(self, name, coll, materials):
        me = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        for b in self.bone_names:
            ob.vertex_groups.new(name=b)
        for m in self.mats:
            me.materials.append(materials[m])
        me.set_sharp_from_angle(angle=math.radians(48))
        return ob


# --- armature ------------------------------------------------------------------------------------------


def make_armature(name, J, coll, location=(0, 0, 0), bones=None):
    arm = bpy.data.armatures.new(name + '_Rig')
    ob = bpy.data.objects.new(name, arm)
    coll.objects.link(ob)
    ob.location = location
    ctx = bpy.context
    for o in ctx.selected_objects:
        o.select_set(False)
    ctx.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for bn, h, t, par in bones or BONES:
        eb = arm.edit_bones.new(bn)
        eb.head = J[h]
        eb.tail = J[t]
        eb.roll = 0.0
        if par:
            eb.parent = arm.edit_bones[par]
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob


def bind(mesh_ob, arm_ob):
    mesh_ob.parent = arm_ob
    mesh_ob.location = (0, 0, 0)
    mod = mesh_ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm_ob


# --- animation -------------------------------------------------------------------------------------------
#
# Poses are written as rotations about axes of the armature's rest frame (X = the
# figure's right-to-left axis, Y = front-to-back, Z = up), applied relative to the
# parent bone, so they don't depend on bone rolls. Rotating a hanging limb by a
# negative angle about X swings it forward.

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))


def rot(*pairs):
    """rot((axis, degrees), ...) -> Quaternion, applied left to right."""
    q = Quaternion()
    for axis, deg in pairs:
        q = Quaternion(axis, math.radians(deg)) @ q
    return q


def write_action(arm_ob, name, frames, pose_fn):
    """pose_fn(frame) -> ({bone: Quaternion in rest-armature space}, {bone: Vector offset}).
    Keys every frame 0..frames (last equals first, so it loops) and stores the action
    as an NLA track named `name`, which the glTF exporter turns into one clip."""
    ad = arm_ob.animation_data or arm_ob.animation_data_create()
    act = bpy.data.actions.new(f'{arm_ob.name}_{name}')
    ad.action = act
    pbs = arm_ob.pose.bones
    rest = {pb.name: pb.bone.matrix_local.to_3x3() for pb in pbs}
    for pb in pbs:
        pb.rotation_mode = 'QUATERNION'
    for f in range(frames + 1):
        rots, locs = pose_fn(f % frames)
        for pb in pbs:
            R = rest[pb.name]
            q = rots.get(pb.name)
            if q is not None:
                pb.rotation_quaternion = (R.inverted() @ q.to_matrix() @ R).to_quaternion()
            else:
                pb.rotation_quaternion = Quaternion()
            d = locs.get(pb.name)
            pb.location = (R.inverted() @ d) if d is not None else Vector()
            pb.keyframe_insert('rotation_quaternion', frame=f)
            pb.keyframe_insert('location', frame=f)
    ad.action = None
    track = ad.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, act)
    strip.name = name
    track.mute = False
    return act


def leg_angles(p, A, K):
    """Forward swing a, knee bend k (degrees) of a leg at gait phase p (0 = passing, moving forward)."""
    a = A * math.sin(TAU * p)
    k = 6 + K * max(0.0, math.cos(TAU * p + 0.45)) ** 1.5
    return a, k


def _wrap(d):
    return (d + 0.5) % 1.0 - 0.5


def walk_pose(J, frames, style):
    """Returns (pose_fn, stride). style: dict of per-hero tweaks:
    A thigh swing (deg), K knee bend, arm_L / arm_R swing scale, bob, lean,
    cape (amount), skirt (bool)."""
    A, K = style.get('A', 26.0), style.get('K', 55.0)
    lt = (J['knee.L'] - J['leg.L']).length
    ls = (J['ankle.L'] - J['knee.L']).length
    rest_drop = lt + ls

    def drop(a, k):
        ar, kr = math.radians(a), math.radians(k)
        return rest_drop - (lt * math.cos(ar) + ls * math.cos(ar - kr))

    def reach(a, k):
        ar, kr = math.radians(a), math.radians(k)
        return lt * math.sin(ar) + ls * math.sin(ar - kr)

    # distance covered per cycle: the stance foot sweeps from front contact to lift-off
    stride = 2 * (reach(*leg_angles(0.25, A, K)) - reach(*leg_angles(0.75, A, K)))
    armL, armR = style.get('arm_L', 1.0), style.get('arm_R', 1.0)
    B = style.get('B', 22.0)
    lean = style.get('lean', 4.0)
    cape = style.get('cape', 1.0)

    def pose(f):
        p = f / frames
        s = math.sin(TAU * p)
        rots, locs = {}, {}
        drops = []
        for side, pl in (('L', p), ('R', p + 0.5)):
            a, k = leg_angles(pl % 1.0, A, K)
            drops.append(drop(a, k))
            pp = pl % 1.0
            toe_off = 22 * math.exp(-(_wrap(pp - 0.74) / 0.07) ** 2)
            lift = -14 * math.exp(-(_wrap(pp - 0.97) / 0.1) ** 2)
            rots[f'thigh.{side}'] = rot((X, -a))
            rots[f'shin.{side}'] = rot((X, k))
            rots[f'foot.{side}'] = rot((X, a - k + toe_off + lift))
        # body height follows the lower (stance) foot so it stays on the ground
        dz = -min(drops)
        sway = -0.018 * math.cos(TAU * p)
        locs['hips'] = Vector((sway, 0, dz))
        rots['hips'] = rot((Z, -6 * s), (Y, 3 * math.cos(TAU * p)), (X, lean * 0.5))
        rots['spine'] = rot((Z, 4 * s), (X, lean * 0.5 + 1.5 * math.cos(2 * TAU * p)))
        rots['chest'] = rot((Z, 5 * s), (Y, -2 * math.cos(TAU * p)))
        rots['neck'] = rot((Z, -2 * s), (X, -lean * 0.4))
        rots['head'] = rot((Z, -1.5 * s), (X, -lean * 0.3 - 1.2 * math.cos(2 * TAU * p)))
        for side, sc, sg in (('L', armL, 1), ('R', armR, -1)):
            fwd = -B * s * sg * sc  # arm forward angle, opposite to the leg
            rots[f'shoulder.{side}'] = rot((X, -0.2 * fwd))
            rots[f'upper_arm.{side}'] = rot((X, -fwd), (Y, sg * -2 * sc))
            rots[f'forearm.{side}'] = rot((X, -(6 + 10 * max(0.0, fwd) / max(B, 1)) * sc))
            rots[f'hand.{side}'] = rot((X, -3 * s * sg * sc))
        # cape trails and ripples; skirt panels follow the forward / backward leg
        c2 = TAU * 2 * p
        rots['cape_1'] = rot((X, (14 + 3 * math.sin(c2)) * cape))
        rots['cape_2'] = rot((X, (7 + 5 * math.sin(c2 - 0.9)) * cape))
        rots['cape_3'] = rot((X, (6 + 7 * math.sin(c2 - 1.8)) * cape))
        aL = A * math.sin(TAU * p)
        rots['skirt_f'] = rot((X, -max(aL, -aL) * 0.85 - 3))
        rots['skirt_b'] = rot((X, max(aL, -aL) * 0.7 + 2))
        return rots, locs

    return pose, stride


def idle_pose(J, frames, style):
    arm = style.get('idle_arm', 1.0)
    cape = style.get('cape', 1.0)

    def pose(f):
        p = f / frames
        b = math.sin(TAU * p)
        b2 = math.sin(TAU * 2 * p)
        rots, locs = {}, {}
        locs['hips'] = Vector((0.006 * math.sin(TAU * p + 0.6), 0, -0.006 + 0.004 * b2))
        rots['hips'] = rot((Y, 1.2 * math.sin(TAU * p + 0.6)))
        rots['spine'] = rot((X, 1.2 * b2))
        rots['chest'] = rot((X, -1.6 * b2))
        rots['neck'] = rot((X, 1.0 * b2))
        rots['head'] = rot((Z, 9 * math.sin(TAU * p)), (X, -2 * math.sin(TAU * p + 1.3)))
        for side, sg in (('L', 1), ('R', -1)):
            rots[f'shoulder.{side}'] = rot((X, -0.8 * b2))
            rots[f'upper_arm.{side}'] = rot((X, 1.5 * arm * math.sin(TAU * p + sg)), (Y, sg * -1.2 * arm * b2))
            rots[f'forearm.{side}'] = rot((X, -2 * arm * (0.5 + 0.5 * b2)))
        rots['cape_1'] = rot((X, (2 + 1.5 * b2) * cape))
        rots['cape_2'] = rot((X, (1 + 2 * math.sin(TAU * 2 * p - 0.9)) * cape))
        rots['cape_3'] = rot((X, (1 + 3 * math.sin(TAU * 2 * p - 1.8)) * cape))
        return rots, locs

    return pose


# --- materials for the bake ------------------------------------------------------------------------------

def hero_export_material(name, image, metallic=0.0, rough=0.8):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metallic
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = image
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    mat.use_backface_culling = True
    return mat
