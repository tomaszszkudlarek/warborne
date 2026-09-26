"""Builds the dragon and the catapult unit GLBs from Meshy AI models (tools/meshy/<unit>/)
on skeletons made here: Meshy only rigs humanoids.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_meshy_beasts.py
    (env ONLY=dragon|catapult builds one, TEX=<px> sets the texture size (default
     1024), EXPORT=0 skips the export, PREVIEW=/path.png renders a contact sheet,
     CLIP=Walk|Idle FRAMES=0,6,12,18 CAM_ANGLE=<deg> CAM_TILT=<deg> tune it)

Both come out in world units (HERO_TYPES gives them scale 1) with the usual clips:

  dragon    Meshy made it upright, wings spread in the picture plane. It is tipped
            into level flight, the wing span set to SPAN, and skinned by x (wing
            root -> wrist -> tip) and by distance to a spine chain (head, neck, body,
            tail). Walk is the flight cycle (one wing beat per `stride` flown), Idle a
            slower, fuller hovering beat. The origin is the body's centre: the game
            flies it at a height above the ground.
  catapult  Turned to face -Y, ground at z = 0, LENGTH long. Its four wheels are
            found in the mesh and each is rigid on a bone at its hub; Walk is one
            wheel turn (`stride` = the wheel's circumference), Idle stands still.

Royal-blue wing membranes, pennant and cloth go to <Unit>_Accent for the faction colour.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hero_lib as H  # noqa: E402
import meshy_lib  # noqa: E402
from meshy_lib import pixels  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
MESHY = os.path.join(ROOT, 'tools', 'meshy')
OUT_DIR = os.path.join(ROOT, 'public', 'models', 'units')
TEX = int(os.environ.get('TEX', '1024'))
X, Y, Z = H.X, H.Y, H.Z

SPAN = 4.4  # dragon wing span, world units (a tile is 2)
DRAGON_PITCH = 57  # degrees about X that level Meshy's upright dragon (its wing plane)
FLY_SPEED = 2.6  # world units per second, Heroes.js FLY_SPEED
FLAP = 24  # frames per wing beat in flight
HOVER = 36  # frames per wing beat hovering
LENGTH = 2.4  # catapult length, world units


def _ramp(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def import_model(unit):
    before = {o.name for o in bpy.data.objects}
    bpy.ops.import_scene.gltf(filepath=os.path.join(MESHY, unit, 'model_static.glb'))
    new = [o for o in bpy.data.objects if o.name not in before]
    ob = next(o for o in new if o.type == 'MESH')
    ob.data.transform(ob.matrix_world)
    ob.parent = None
    ob.matrix_world = Matrix()
    for o in new:
        if o.name != ob.name:
            bpy.data.objects.remove(o, do_unlink=True)
    return ob


def coords(ob):
    co = np.empty(len(ob.data.vertices) * 3, np.float32)
    ob.data.vertices.foreach_get('co', co)
    return co.reshape(-1, 3)


def _seg_dist(co, a, b):
    a, b = np.array(a), np.array(b)
    d = b - a
    t = np.clip(((co - a) @ d) / (d @ d), 0, 1)
    return np.linalg.norm(co - (a + t[:, None] * d), axis=1)


def write_weights(ob, W, names):
    groups = {n: ob.vertex_groups.new(name=n) for n in names}
    for i, n in enumerate(names):
        for v in np.nonzero(W[:, i] > 1e-3)[0]:
            groups[n].add([int(v)], float(W[v, i]), 'REPLACE')


# --- dragon ---------------------------------------------------------------------------------


def dragon_joints(ob):
    """Level the dragon, centre its body on the origin, scale it to SPAN and return
    its joints and the wing root / wrist half-widths."""
    ob.data.transform(Matrix.Rotation(math.radians(DRAGON_PITCH), 4, 'X'))
    co = coords(ob)
    s = SPAN / (co[:, 0].max() - co[:, 0].min())
    ob.data.transform(Matrix.Scale(s, 4))
    co = coords(ob)
    body = co[np.abs(co[:, 0]) < 0.06 * SPAN]
    c = np.median(body, 0)
    ob.data.transform(Matrix.Translation((0, -c[1], -c[2])))
    co = coords(ob)
    body = co[np.abs(co[:, 0]) < 0.05 * SPAN]
    y0, y1 = float(body[:, 1].min()), float(body[:, 1].max())

    def spine(y):
        """Centre of the body's cross-section at y."""
        sl = body[np.abs(body[:, 1] - y) < 0.02 * SPAN]
        return Vector((0, y, float(np.median(sl[:, 2])) if len(sl) else 0.0))

    sx = 0.075 * SPAN  # wing root, half width
    band = co[(np.abs(co[:, 0]) > sx) & (np.abs(co[:, 0]) < sx + 0.03 * SPAN)]
    sh = band.mean(0)
    wx = 0.195 * SPAN  # the wrist, where the wing fingers fan out

    def edge(x):
        """Leading edge of the wing at half width x: its front 20 % there."""
        sl = co[np.abs(np.abs(co[:, 0]) - x) < 0.01 * SPAN]
        sl = sl[sl[:, 1] < np.percentile(sl[:, 1], 20)]
        return float(sl[:, 1].mean()), float(sl[:, 2].mean())

    J = {}
    chest_y = float(sh[1])
    hips_y = chest_y + 0.085 * SPAN
    J['snout'] = spine(y0 + 0.01 * SPAN)
    J['headbase'] = spine(y0 + 0.05 * SPAN)
    J['chest'] = spine(chest_y)
    J['hips'] = spine(hips_y)
    for k, t in (('t1', 0.3), ('t2', 0.62), ('tip', 1.0)):
        J[k] = spine(hips_y + t * (y1 - 0.01 * SPAN - hips_y))
    wy, wz = edge(wx)
    ty, tz = edge(0.47 * SPAN)
    for side, sg in (('L', 1), ('R', -1)):
        J[f'shoulder.{side}'] = Vector((sg * sx, float(sh[1]), float(sh[2])))
        J[f'wrist.{side}'] = Vector((sg * wx, wy, wz))
        J[f'wtip.{side}'] = Vector((sg * 0.47 * SPAN, ty, tz))
    print(f'dragon: scale {s:.3f}, body y {y0:.2f}..{y1:.2f}, chest y {chest_y:.2f} '
          f'wrist ({wx:.2f}, {wy:.2f}, {wz:.2f})', flush=True)
    return J, sx, wx


DRAGON_BONES = [
    ('root', 'hips', 'chest', None),
    ('neck', 'chest', 'headbase', 'root'),
    ('head', 'headbase', 'snout', 'neck'),
    ('tail1', 'hips', 't1', 'root'),
    ('tail2', 't1', 't2', 'tail1'),
    ('tail3', 't2', 'tip', 'tail2'),
]
for _s in ('L', 'R'):
    DRAGON_BONES += [
        (f'wing1.{_s}', f'shoulder.{_s}', f'wrist.{_s}', 'root'),
        (f'wing2.{_s}', f'wrist.{_s}', f'wtip.{_s}', f'wing1.{_s}'),
    ]


def dragon_skin(ob, J, sx, wx):
    """Wings by half width (root -> wrist -> tip), the rest by distance to the spine."""
    co = coords(ob)
    x, y = co[:, 0], co[:, 1]
    ax = np.abs(x)
    w2 = _ramp((ax - wx + 0.01 * SPAN) / (0.03 * SPAN))
    w1 = _ramp((ax - sx + 0.005 * SPAN) / (0.03 * SPAN)) * (1 - w2)
    spine = ['root', 'neck', 'head', 'tail1', 'tail2', 'tail3']
    ends = {n: (J[h], J[t]) for n, h, t, _ in DRAGON_BONES if n in spine}
    D = np.stack([_seg_dist(co, *ends[n]) for n in spine], axis=1)
    D[y > J['chest'].y + 0.03 * SPAN, 1:3] = np.inf  # head and neck only in front
    D[y < J['hips'].y - 0.03 * SPAN, 3:] = np.inf  # tail only behind
    Ws = 1 / np.maximum(D, 0.01) ** 4
    Ws /= Ws.sum(1, keepdims=True)
    Ws *= (1 - w1 - w2)[:, None]
    names = spine + ['wing1.L', 'wing2.L', 'wing1.R', 'wing2.R']
    left = x > 0
    W = np.concatenate([Ws, np.stack([w1 * left, w2 * left, w1 * ~left, w2 * ~left], 1)], 1)
    write_weights(ob, W, names)
    print(f'  wings: {int((w1 + w2 > 0.5).sum())} of {len(co)} vertices', flush=True)


def dragon_pose(frames, up, amp, lag_amp, bob, sway):
    """Wing beat: the upper wing swings about the body axis, the outer wing follows
    late; the body rises on the downstroke, the tail undulates."""
    def pose(f):
        p = math.tau * f / frames
        q = p + 0.35 * math.sin(p)  # quicker downstroke
        a1 = up + amp * math.cos(q)
        a2 = 6 + lag_amp * math.cos(q - 1.0)
        rots = {
            'wing1.L': H.rot((Y, -a1)), 'wing1.R': H.rot((Y, a1)),
            'wing2.L': H.rot((Y, -a2)), 'wing2.R': H.rot((Y, a2)),
            'neck': H.rot((X, -3 * math.cos(q - 0.8)), (Z, sway * math.sin(p))),
            'head': H.rot((X, 4 * math.cos(q - 1.2))),
            'tail1': H.rot((X, -6 + 4 * math.sin(p - 1.0)), (Z, sway * math.sin(p + 1))),
            'tail2': H.rot((X, -4 + 5 * math.sin(p - 1.8)), (Z, sway * math.sin(p + 0.2))),
            'tail3': H.rot((X, 6 * math.sin(p - 2.6)), (Z, sway * math.sin(p - 0.6))),
        }
        locs = {'root': Vector((0, 0, -bob * math.cos(q - 0.4)))}
        return rots, locs
    return pose


def build_dragon():
    name = 'Dragon'
    ob = import_model('dragon')
    J, sx, wx = dragon_joints(ob)
    ob.name = name + '_Mesh'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, 'dragon'), name)
    arm_ob = H.make_armature(name, J, bpy.context.scene.collection, bones=DRAGON_BONES)
    dragon_skin(ob, J, sx, wx)
    H.bind(ob, arm_ob)
    bpy.context.scene.render.fps = H.FPS
    H.write_action(arm_ob, 'Walk', FLAP, dragon_pose(FLAP, 6, 34, 18, 0.05 * SPAN / 4.4, 2))
    H.write_action(arm_ob, 'Idle', HOVER, dragon_pose(HOVER, 12, 42, 24, 0.08 * SPAN / 4.4, 5))
    arm_ob['stride'] = round(FLY_SPEED * FLAP / H.FPS, 4)
    arm_ob['height'] = round(float(coords(ob)[:, 2].max()), 3)
    arm_ob['span'] = SPAN
    return arm_ob, ob


# --- catapult -------------------------------------------------------------------------------


def catapult_wheels(ob):
    """Face -Y, stand on z = 0, LENGTH long; returns the wheels: (name, hub, radius, mask)."""
    # Meshy's catapult throws toward +X (the arm is cocked back toward -X)
    ob.data.transform(Matrix.Rotation(math.radians(-90), 4, 'Z'))
    co = coords(ob)
    s = LENGTH / (co[:, 1].max() - co[:, 1].min())
    c = (co.min(0) + co.max(0)) / 2
    ob.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation((-c[0], -c[1], -co[:, 2].min())))
    co = coords(ob)
    half = np.abs(co[:, 0]).max()
    outer = co[np.abs(co[:, 0]) > 0.84 * half]
    ymid = (outer[:, 1].min() + outer[:, 1].max()) / 2
    wheels = []
    for fb, fsg in (('F', -1), ('B', 1)):
        for side, sg in (('L', 1), ('R', -1)):
            w = outer[(np.sign(outer[:, 0]) == sg) & (np.sign(outer[:, 1] - ymid) == fsg)]
            lo, hi = w.min(0), w.max(0)
            hub = (lo + hi) / 2
            r = max(hi[1] - lo[1], hi[2] - lo[2]) / 2
            d = np.hypot(co[:, 1] - hub[1], co[:, 2] - hub[2])
            mask = (np.sign(co[:, 0]) == sg) & (np.abs(co[:, 0]) > 0.72 * half) & (d < r * 1.06)
            hub[0] = sg * 0.8 * half
            wheels.append((f'wheel.{fb}{side}', Vector(hub.tolist()), float(r), mask))
            print(f'  {fb}{side}: hub ({hub[0]:.2f}, {hub[1]:.2f}, {hub[2]:.2f}) r {r:.3f}, '
                  f'{int(mask.sum())} vertices', flush=True)
    return wheels


def build_catapult():
    name = 'Catapult'
    ob = import_model('catapult')
    print(f'{name}:', flush=True)
    wheels = catapult_wheels(ob)
    ob.name = name + '_Mesh'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, 'catapult'), name)
    J = {'c0': Vector((0, 0.3, 0.3)), 'c1': Vector((0, -0.3, 0.3))}
    bones = [('chassis', 'c0', 'c1', None)]
    for n, hub, _, _ in wheels:
        J[n] = hub
        J[n + '_t'] = hub + Vector((0.15 * math.copysign(1, hub.x), 0, 0))
        bones.append((n, n, n + '_t', 'chassis'))
    arm_ob = H.make_armature(name, J, bpy.context.scene.collection, bones=bones)
    co = coords(ob)
    W = np.zeros((len(co), 1 + len(wheels)), np.float32)
    W[:, 0] = 1
    for i, (_, _, _, mask) in enumerate(wheels):
        W[mask, 0] = 0
        W[mask, i + 1] = 1
    write_weights(ob, W, ['chassis'] + [w[0] for w in wheels])
    H.bind(ob, arm_ob)
    r = float(np.mean([w[2] for w in wheels]))
    frames = 30

    def roll(f):
        p = math.tau * f / frames
        rots = {n: H.rot((X, 360 * f / frames)) for n, _, _, _ in wheels}
        rots['chassis'] = H.rot((X, 0.5 * math.sin(2 * p)))  # jolts over the ruts
        return rots, {'chassis': Vector((0, 0, 0.006 * abs(math.sin(2 * p))))}
    bpy.context.scene.render.fps = H.FPS
    H.write_action(arm_ob, 'Walk', frames, roll)
    H.write_action(arm_ob, 'Idle', frames, lambda f: ({}, {}))
    arm_ob['stride'] = round(math.tau * r, 4)
    arm_ob['height'] = round(float(co[:, 2].max()), 3)
    print(f'{name}: {len(ob.data.polygons)} faces, wheel r {r:.3f}, stride {math.tau * r:.3f}, '
          f'height {arm_ob["height"]}', flush=True)
    return arm_ob, ob


# --- winged flyers (eagle, bat, bee) ----------------------------------------------------------
#
# Built like the dragon: levelled into flight, wings weighted by half width (root ->
# wrist -> tip), the rest by distance to a spine chain. Meshy made the eagle and bat
# upright with their wings in the picture plane (`head` 'up'), the bee lying flat
# (`head` 'front'); the pitch that levels them comes from the body's main axis.
# span: wing span, world units; root / wrist: half widths as a share of it; frames and
# beats of the flight (Walk) and hover (Idle) clips; up / amp / lag: wing angles (deg).

FLYERS = {
    'eagle': dict(name='Eagle', span=3.0, head='up', root=0.06, wrist=0.24,
                  fly=dict(frames=24, beats=1, up=4, amp=32, lag=16, bob=0.05, sway=2),
                  hover=dict(frames=30, beats=1, up=10, amp=40, lag=22, bob=0.07, sway=4)),
    'giantbat': dict(name='GiantBat', span=2.6, head='up', root=0.07, wrist=0.2,
                     fly=dict(frames=16, beats=1, up=-2, amp=30, lag=16, bob=0.06, sway=3),
                     hover=dict(frames=20, beats=1, up=2, amp=34, lag=20, bob=0.08, sway=4)),
    # the bee's legs splay as wide as its wings: its wings are only what's above the body
    'giantbee': dict(name='GiantBee', span=1.9, head='front', root=0.1, wrist=0.28, above=0.02,
                     fly=dict(frames=24, beats=8, up=12, amp=44, lag=4, bob=0.02, sway=2),
                     hover=dict(frames=24, beats=8, up=14, amp=48, lag=4, bob=0.035, sway=4)),
}


def level_flyer(ob, head):
    """Turn the body's main axis level, head toward -Y (belly down)."""
    co = coords(ob)
    w = co[:, 0].max() - co[:, 0].min()
    body = co[np.abs(co[:, 0] - np.median(co[:, 0])) < 0.05 * w][:, 1:3]
    body = body - body.mean(0)
    a = np.linalg.eigh(body.T @ body)[1][:, -1]  # (y, z) of the longest axis
    if (head == 'up' and a[1] < 0) or (head == 'front' and a[0] > 0):
        a = -a
    phi = math.pi - math.atan2(a[1], a[0])
    phi = math.atan2(math.sin(phi), math.cos(phi))
    ob.data.transform(Matrix.Rotation(phi, 4, 'X'))
    return math.degrees(phi)


def flyer_joints(ob, spec):
    pitch = level_flyer(ob, spec['head'])
    span = spec['span']
    co = coords(ob)
    s = span / (co[:, 0].max() - co[:, 0].min())
    ob.data.transform(Matrix.Scale(s, 4))
    co = coords(ob)
    cx = (co[:, 0].max() + co[:, 0].min()) / 2
    body = co[np.abs(co[:, 0] - cx) < 0.06 * span]
    c = np.median(body, 0)
    ob.data.transform(Matrix.Translation((-cx, -c[1], -c[2])))
    co = coords(ob)
    body = co[np.abs(co[:, 0]) < 0.05 * span]
    y0, y1 = float(body[:, 1].min()), float(body[:, 1].max())

    def spine(y):
        sl = body[np.abs(body[:, 1] - y) < 0.02 * span]
        return Vector((0, y, float(np.median(sl[:, 2])) if len(sl) else 0.0))

    sx, wx = spec['root'] * span, spec['wrist'] * span
    band = co[(np.abs(co[:, 0]) > sx) & (np.abs(co[:, 0]) < sx + 0.03 * span)]
    sh = band.mean(0)

    def edge(x):
        sl = co[np.abs(np.abs(co[:, 0]) - x) < 0.01 * span]
        sl = sl[sl[:, 1] < np.percentile(sl[:, 1], 20)]
        return float(sl[:, 1].mean()), float(sl[:, 2].mean())

    J = {}
    chest_y = float(sh[1])
    hips_y = min(chest_y + 0.3 * (y1 - chest_y), y1 - 0.02 * span)
    J['snout'] = spine(y0 + 0.01 * span)
    J['headbase'] = spine(y0 + 0.35 * (chest_y - y0))
    J['chest'] = spine(chest_y)
    J['hips'] = spine(hips_y)
    for k, t in (('t1', 0.33), ('t2', 0.66), ('tip', 1.0)):
        J[k] = spine(hips_y + t * (y1 - 0.01 * span - hips_y))
    wy, wz = edge(wx)
    ty, tz = edge(0.46 * span)
    for side, sg in (('L', 1), ('R', -1)):
        J[f'shoulder.{side}'] = Vector((sg * sx, float(sh[1]), float(sh[2])))
        J[f'wrist.{side}'] = Vector((sg * wx, wy, wz))
        J[f'wtip.{side}'] = Vector((sg * 0.46 * span, ty, tz))
    print(f'{spec["name"]}: pitch {pitch:.1f} deg, scale {s:.3f}, body y {y0:.2f}..{y1:.2f}', flush=True)
    return J, sx, wx


def flyer_skin(ob, J, sx, wx, span, above=None):
    """dragon_skin with the flyer's own span; `above`: wings only higher than that (m)."""
    co = coords(ob)
    x, y = co[:, 0], co[:, 1]
    ax = np.abs(x)
    w2 = _ramp((ax - wx + 0.01 * span) / (0.03 * span))
    w1 = _ramp((ax - sx + 0.005 * span) / (0.03 * span)) * (1 - w2)
    if above is not None:
        up = _ramp((co[:, 2] - above) / 0.02)
        w1, w2 = w1 * up, w2 * up
    spine = ['root', 'neck', 'head', 'tail1', 'tail2', 'tail3']
    ends = {n: (J[h], J[t]) for n, h, t, _ in DRAGON_BONES if n in spine}
    D = np.stack([_seg_dist(co, *ends[n]) for n in spine], axis=1)
    D[y > J['chest'].y + 0.03 * span, 1:3] = np.inf
    D[y < J['hips'].y - 0.03 * span, 3:] = np.inf
    Ws = 1 / np.maximum(D, 0.01) ** 4
    Ws /= Ws.sum(1, keepdims=True)
    Ws *= (1 - w1 - w2)[:, None]
    names = spine + ['wing1.L', 'wing2.L', 'wing1.R', 'wing2.R']
    left = x > 0
    W = np.concatenate([Ws, np.stack([w1 * left, w2 * left, w1 * ~left, w2 * ~left], 1)], 1)
    write_weights(ob, W, names)
    print(f'  wings: {int((w1 + w2 > 0.5).sum())} of {len(co)} vertices', flush=True)


def flyer_pose(c, span):
    """dragon_pose with `beats` wing beats per clip."""
    base = dragon_pose(c['frames'] / c['beats'], c['up'], c['amp'], c['lag'], c['bob'] * span / 4.4, c['sway'])
    body = dragon_pose(c['frames'], c['up'], c['amp'], c['lag'], c['bob'] * span / 4.4, c['sway'])

    def pose(f):
        rots, locs = base(f % (c['frames'] / c['beats']))
        brots, blocs = body(f)
        for k in ('neck', 'head', 'tail1', 'tail2', 'tail3'):
            rots[k] = brots[k]  # the body sways once per clip, the wings beat `beats` times
        return rots, blocs
    return pose


def build_flyer(unit):
    spec = FLYERS[unit]
    name = spec['name']
    ob = import_model(unit)
    J, sx, wx = flyer_joints(ob, spec)
    ob.name = name + '_Mesh'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, unit), name)
    arm_ob = H.make_armature(name, J, bpy.context.scene.collection, bones=DRAGON_BONES)
    flyer_skin(ob, J, sx, wx, spec['span'], spec.get('above'))
    H.bind(ob, arm_ob)
    bpy.context.scene.render.fps = H.FPS
    H.write_action(arm_ob, 'Walk', spec['fly']['frames'], flyer_pose(spec['fly'], spec['span']))
    H.write_action(arm_ob, 'Idle', spec['hover']['frames'], flyer_pose(spec['hover'], spec['span']))
    arm_ob['stride'] = round(FLY_SPEED * spec['fly']['frames'] / H.FPS, 4)
    arm_ob['height'] = round(float(coords(ob)[:, 2].max()), 3)
    arm_ob['span'] = spec['span']
    return arm_ob, ob


# --- many-legged crawlers (spider, scorpion) --------------------------------------------------
#
# Meshy stood them on their feet, head toward -Y. The feet are the clusters of low
# vertices around the body (k-means on their bearing); each leg gets a hip at the body's
# edge, a knee at its highest point and a foot. Legs skin by distance to their own
# bones, within their own bearing sector only. The scorpion's two frontmost clusters are
# its claws, and a tail chain runs up through the vertices high over its back.
# size: length of the whole beast, world units; legs: foot clusters (with the claws).

CRAWLERS = {
    'giantspider': dict(name='GiantSpider', size=2.2, legs=8, claws=0, tail=False, swing=16, lift=18),
    'giantscorpion': dict(name='GiantScorpion', size=2.5, legs=10, claws=2, tail=True, swing=12, lift=14),
}


def _bearing_clusters(ang, k, iters=40):
    """k-means on the unit circle: returns up to k cluster centre bearings, sorted (a
    foot Meshy left raised off the ground makes no cluster)."""
    # seed with the k strongest peaks of a 5-degree histogram, at least 12 degrees apart
    h, e = np.histogram(ang, bins=72, range=(-math.pi, math.pi))
    mids = (e[:-1] + e[1:]) / 2
    c = []
    for i in np.argsort(-h):
        if h[i] > 0.25 * h.max() and all(abs(np.angle(np.exp(1j * (mids[i] - x)))) > math.radians(12) for x in c):
            c.append(mids[i])
        if len(c) == k:
            break
    c = np.sort(np.array(c))
    k = len(c)
    for _ in range(iters):
        d = np.abs(np.angle(np.exp(1j * (ang[:, None] - c[None, :]))))
        lab = d.argmin(1)
        for i in range(k):
            if (lab == i).any():
                c[i] = np.angle(np.exp(1j * ang[lab == i]).mean())
    return np.sort(c)


def crawler_joints(ob, spec):
    co = coords(ob)
    s = spec['size'] / max(np.ptp(co[:, 0]), np.ptp(co[:, 1]))
    ob.data.transform(Matrix.Scale(s, 4))
    co = coords(ob)
    Hh = np.ptp(co[:, 2])
    high = co[co[:, 2] > co[:, 2].min() + 0.35 * Hh]
    if spec['tail']:  # the tail towers over the back: the body is lower
        high = co[(co[:, 2] > co[:, 2].min() + 0.15 * Hh) & (co[:, 2] < co[:, 2].min() + 0.4 * Hh)]
    c = np.median(high, 0)
    ob.data.transform(Matrix.Translation((-c[0], -c[1], -co[:, 2].min())))
    co = coords(ob)
    r = np.hypot(co[:, 0], co[:, 1])
    ang = np.arctan2(co[:, 1], co[:, 0])
    low = (co[:, 2] < 0.06 * Hh) & (r > 0.25 * r.max())
    # half the feet on each side (clustered together, one side could take an extra)
    centres = np.sort(np.concatenate([_bearing_clusters(ang[low & (np.sign(co[:, 0]) == sg)], spec['legs'] // 2)
                                      for sg in (1, -1)]))
    legs = []
    for i, a in enumerate(centres):
        d = np.abs(np.angle(np.exp(1j * (ang - a))))
        gap = min(np.abs(np.angle(np.exp(1j * (centres - a))))[np.arange(len(centres)) != i]) / 2
        sector = d < gap
        tipsel = low & sector & (d < gap * 0.8)
        tip = co[tipsel].mean(0)
        rt = float(np.hypot(tip[0], tip[1]))
        seg = co[sector & (r > 0.3 * rt) & (r < 0.85 * rt)]
        if len(seg) < 10:  # a thin sector (a claw's): halfway, raised
            seg = co[sector & (r > 0.2 * rt)]
        knee = seg[seg[:, 2] >= np.percentile(seg[:, 2], 90)].mean(0)
        hipsel = sector & (np.abs(r - 0.28 * rt) < 0.06 * rt)
        hip = co[hipsel].mean(0) if hipsel.any() else knee * [0.5, 0.5, 0.8]
        legs.append(dict(a=float(a), gap=float(gap), hip=hip, knee=knee, tip=tip, rt=rt))
    # claws: the frontmost clusters (most -Y)
    order = sorted(range(len(legs)), key=lambda i: legs[i]['tip'][1])
    for i in order[:spec['claws']]:
        legs[i]['claw'] = True
    J = {}
    body = co[r < 0.2 * r.max()]
    J['front'] = Vector((0, float(body[:, 1].min()), float(np.median(body[:, 2]))))
    J['mid'] = Vector((0, 0, float(np.median(body[:, 2]))))
    J['back'] = Vector((0, float(body[:, 1].max()), float(np.median(body[:, 2]))))
    bones = [('thorax', 'mid', 'front', None), ('abdomen', 'mid', 'back', 'thorax')]
    # name legs by side and order from the front
    for side, sg in (('L', 1), ('R', -1)):
        mine = sorted([l for l in legs if np.sign(l['tip'][0]) == sg and not l.get('claw')], key=lambda l: l['tip'][1])
        for n, l in enumerate(mine):
            l['name'] = f'leg{n + 1}.{side}'
        for l in legs:
            if l.get('claw') and np.sign(l['tip'][0]) == sg:
                l['name'] = f'claw.{side}'
    for l in legs:
        n = l['name']
        J[n + '_h'], J[n + '_k'], J[n + '_t'] = (Vector(l[k].tolist()) for k in ('hip', 'knee', 'tip'))
        bones += [(n, n + '_h', n + '_k', 'thorax'), (n + '_lo', n + '_k', n + '_t', n)]
    if spec['tail']:
        top = co[:, 2].max()
        zb = float(np.median(body[:, 2]))
        tv = co[(co[:, 1] > 0.15 * r.max()) & (co[:, 2] > zb + 0.15 * (top - zb)) & (np.abs(co[:, 0]) < 0.25 * r.max())]
        edges = np.linspace(tv[:, 2].min(), top, 5)
        pts = [J['back']] + [Vector(tv[(tv[:, 2] >= a) & (tv[:, 2] <= b)].mean(0).tolist()) for a, b in zip(edges, edges[1:])]
        par = 'abdomen'
        for i in range(4):
            J[f't{i}'], J[f't{i + 1}'] = pts[i], pts[i + 1]
            bones.append((f'tail{i + 1}', f't{i}', f't{i + 1}', par))
            par = f'tail{i + 1}'
    print(f'{spec["name"]}: scale {s:.3f}, {len(legs)} limbs, bearings '
          + ' '.join(f'{l["name"]}:{math.degrees(l["a"]):.0f}' for l in legs), flush=True)
    return J, bones, legs


def crawler_skin(ob, J, bones, legs, spec):
    co = coords(ob)
    ang = np.arctan2(co[:, 1], co[:, 0])
    names = [b[0] for b in bones]
    D = np.stack([_seg_dist(co, J[h], J[t]) for _, h, t, _ in bones], axis=1)
    for l in legs:
        d = np.abs(np.angle(np.exp(1j * (ang - l['a']))))
        out = d > l['gap'] * 1.05
        for n in (l['name'], l['name'] + '_lo'):
            D[out, names.index(n)] = np.inf
    if spec['tail']:  # the tail only behind and above the body
        for i, n in enumerate(names):
            if n.startswith('tail'):
                D[co[:, 1] < J['back'].y - 0.1, i] = np.inf
    W = 1 / np.maximum(D, 0.01) ** 5
    cut = np.partition(W, -3, axis=1)[:, -3][:, None]
    W[W < cut] = 0
    W /= W.sum(1, keepdims=True)
    write_weights(ob, W, names)


def crawler_pose(legs, frames, spec, walk=True):
    """Alternating tetrapod: L1 R2 L3 R4 swing together, then the others. A leg swings
    about the vertical and lifts about the horizontal across it; the lower leg folds a
    little as it lifts so the foot clears the ground."""
    def pose(f):
        p = math.tau * f / frames
        rots, locs = {}, {}
        for l in legs:
            n = l['name']
            sg = 1 if n.endswith('.L') else -1
            if l.get('claw'):
                ph = p + (0 if sg > 0 else math.pi)
                rots[n] = H.rot((Z, sg * 4 * math.sin(ph)), (X, -5 + 3 * math.sin(ph + 0.6)))
                rots[n + '_lo'] = H.rot((Z, -sg * (6 + 6 * math.sin(2 * ph))))
                continue
            k = int(n[3]) - 1
            grp = (k + (0 if sg > 0 else 1)) % 2
            ph = p + grp * math.pi
            d = Vector((math.cos(l['a']), math.sin(l['a']), 0))
            across = Z.cross(d).normalized()
            if walk:
                swing = -sg * spec['swing'] * math.sin(ph)  # forward swing while lifted
                lift = spec['lift'] * max(0.0, math.cos(ph))
            else:
                swing = 1.5 * math.sin(p + k)
                lift = 3 * max(0.0, math.sin(p + 1.3 * k)) ** 8
            rots[n] = H.rot((across, -lift), (Z, swing))
            rots[n + '_lo'] = H.rot((across, 0.6 * lift))
        bob = 0.012 * math.sin(2 * p) if walk else 0.006 * math.sin(p)
        locs['thorax'] = Vector((0, 0, bob))
        rots['abdomen'] = H.rot((X, 2 * math.sin(2 * p + 0.5)), (Z, 2 * math.sin(p)))
        for i in range(4):
            rots[f'tail{i + 1}'] = H.rot((X, 3 * math.sin(p - 0.5 * i)), (Z, (4 + 2 * i) * math.sin(p - 0.6 * i)))
        return rots, locs
    return pose


def build_crawler(unit):
    spec = CRAWLERS[unit]
    name = spec['name']
    ob = import_model(unit)
    J, bones, legs = crawler_joints(ob, spec)
    ob.name = name + '_Mesh'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, unit), name)
    arm_ob = H.make_armature(name, J, bpy.context.scene.collection, bones=bones)
    crawler_skin(ob, J, bones, legs, spec)
    H.bind(ob, arm_ob)
    bpy.context.scene.render.fps = H.FPS
    frames = 24
    H.write_action(arm_ob, 'Walk', frames, crawler_pose(legs, frames, spec))
    H.write_action(arm_ob, 'Idle', 90, crawler_pose(legs, 90, spec, walk=False))
    # each half cycle a foot sweeps 2 r sin(swing) under the body
    rt = float(np.median([l['rt'] for l in legs if not l.get('claw')]))
    arm_ob['stride'] = round(4 * rt * math.sin(math.radians(spec['swing'])), 4)
    arm_ob['height'] = round(float(coords(ob)[:, 2].max()), 3)
    print(f'{name}: {len(ob.data.polygons)} faces, stride {arm_ob["stride"]}, height {arm_ob["height"]}', flush=True)
    return arm_ob, ob


# --- cockatrice (biped) -------------------------------------------------------------------------
#
# Standing in profile, head toward -Y. Two bird legs (thigh, shank, foot) under the
# body, a neck and head in front, a tail chain behind, and small wings off the
# shoulders. Walk: the legs step by planar IK (hip -> ankle, knee forward), the body
# bobs, the head pecks forward with each step, the tail sways.

COCK_H = 1.9  # height to the comb, world units


def cock_joints(ob):
    co = coords(ob)
    s = COCK_H / np.ptp(co[:, 2])
    ob.data.transform(Matrix.Scale(s, 4))
    co = coords(ob)
    ob.data.transform(Matrix.Translation((-np.median(co[:, 0]), 0, -co[:, 2].min())))
    co = coords(ob)
    Hh = co[:, 2].max()
    feet = co[co[:, 2] < 0.05 * Hh]
    fy = float(np.median(feet[:, 1]))
    fx = float(np.median(np.abs(feet[:, 0])))
    toe_y = float(np.percentile(feet[:, 1], 5))
    # belly: lowest body point over the feet, between the legs
    mid = co[(np.abs(co[:, 0]) < 0.4 * fx) & (np.abs(co[:, 1] - fy) < 0.15)]
    belly = float(mid[mid[:, 2] > 0.2 * Hh][:, 2].min())
    head = co[co[:, 2] > 0.8 * Hh]
    hy = float(head[:, 1].min())
    J = {}
    J['pelvis'] = Vector((0, fy + 0.05, belly + 0.12))
    J['chest'] = Vector((0, fy - 0.25, belly + 0.2))
    neck_base = co[(co[:, 1] < fy - 0.2) & (co[:, 1] > fy - 0.4) & (np.abs(co[:, 0]) < 0.15)]
    J['neck0'] = Vector((0, fy - 0.3, float(np.percentile(neck_base[:, 2], 70))))
    J['neck1'] = Vector((0, float(head[:, 1].mean()) + 0.08, 0.8 * Hh))
    J['head'] = Vector((0, float(head[:, 1].mean()), 0.9 * Hh))
    J['beak'] = Vector((0, hy, 0.88 * Hh))
    # tail: centroids of what trails behind the hips
    tv = co[co[:, 1] > fy + 0.25]
    ty = np.linspace(fy + 0.25, tv[:, 1].max(), 4)
    J['tail0'] = J['pelvis'] + Vector((0, 0.2, 0))
    for i in range(3):
        sl = tv[(tv[:, 1] >= ty[i]) & (tv[:, 1] <= ty[i + 1])]
        J[f'tail{i + 1}'] = Vector((0, float(ty[i + 1]), float(np.median(sl[:, 2]))))
    for side, sg in (('L', 1), ('R', -1)):
        hip_z = belly + 0.08
        J[f'hip.{side}'] = Vector((sg * fx, fy, hip_z))
        J[f'knee.{side}'] = Vector((sg * fx, fy - 0.12, 0.62 * hip_z))
        J[f'ankle.{side}'] = Vector((sg * fx, fy + 0.04, 0.12 * hip_z))
        J[f'toe.{side}'] = Vector((sg * fx, toe_y, 0.02))
        # wings: the vertices well outside the body above the belly
        wv = co[(np.sign(co[:, 0]) == sg) & (np.abs(co[:, 0]) > 0.3) & (co[:, 2] > belly + 0.2)]
        J[f'wroot.{side}'] = Vector((sg * 0.18, float(np.median(wv[:, 1])), float(np.percentile(wv[:, 2], 20))))
        J[f'wtip.{side}'] = Vector(wv[np.argmax(np.abs(wv[:, 0]))].tolist())
    bones = [('body', 'pelvis', 'chest', None), ('neck1', 'neck0', 'neck1', 'body'), ('head', 'neck1', 'beak', 'neck1'),
             ('tail1', 'tail0', 'tail1', 'body'), ('tail2', 'tail1', 'tail2', 'tail1'), ('tail3', 'tail2', 'tail3', 'tail2')]
    for sd in ('L', 'R'):
        bones += [(f'thigh.{sd}', f'hip.{sd}', f'knee.{sd}', 'body'), (f'shank.{sd}', f'knee.{sd}', f'ankle.{sd}', f'thigh.{sd}'),
                  (f'foot.{sd}', f'ankle.{sd}', f'toe.{sd}', f'shank.{sd}'), (f'wing.{sd}', f'wroot.{sd}', f'wtip.{sd}', 'body')]
    print(f'Cockatrice: scale {s:.3f}, feet y {fy:.2f} x +-{fx:.2f}, belly {belly:.2f}, head y {hy:.2f}', flush=True)
    return J, bones


def cock_skin(ob, J, bones):
    co = coords(ob)
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    names = [b[0] for b in bones]
    D = np.stack([_seg_dist(co, J[h], J[t]) for _, h, t, _ in bones], axis=1)
    below = z < J['hip.L'].z
    for i, n in enumerate(names):
        if n.endswith('.L'):
            D[x < -0.02, i] = np.inf
        elif n.endswith('.R'):
            D[x > 0.02, i] = np.inf
        if n.startswith(('thigh', 'shank', 'foot')):
            D[z > J['hip.L'].z + 0.08, i] = np.inf
        elif n.startswith('wing'):
            D[np.abs(x) < 0.2, i] = np.inf
        else:  # under the belly between the feet: legs only
            D[below & (np.abs(x) > 0.04) & (z < J['hip.L'].z - 0.1) & (np.abs(y - J['hip.L'].y) < 0.35), i] = np.inf
        if n.startswith('tail'):
            D[y < J['pelvis'].y, i] = np.inf
        if n in ('neck1', 'head'):
            D[y > J['chest'].y + 0.1, i] = np.inf
    W = 1 / np.maximum(D, 0.01) ** 5
    cut = np.partition(W, -3, axis=1)[:, -3][:, None]
    W[W < cut] = 0
    W[W.sum(1) == 0, names.index('body')] = 1  # excluded from every bone: rides the body
    W /= W.sum(1, keepdims=True)
    write_weights(ob, W, names)


def _ik2(hip, target, l1, l2):
    """Planar two-bone IK in (y, z), knee toward -Y: returns (knee, clamped target)."""
    d = target - hip
    L = min(np.linalg.norm(d), (l1 + l2) * 0.999)
    u = d / np.linalg.norm(d)
    t = hip + u * L
    a = (l1 * l1 - l2 * l2 + L * L) / (2 * L)
    h = math.sqrt(max(l1 * l1 - a * a, 0))
    n = np.array([-u[1], u[0]])  # left normal of hip->target in (y, z)
    if n[0] > 0:
        n = -n
    return hip + u * a + n * h, t


def cock_pose(J, frames, stride, walk=True):
    Y2 = lambda v: np.array([v.y, v.z])
    rest = {}
    for sd in ('L', 'R'):
        h, k, a = Y2(J[f'hip.{sd}']), Y2(J[f'knee.{sd}']), Y2(J[f'ankle.{sd}'])
        rest[sd] = (h, k, a, np.linalg.norm(k - h), np.linalg.norm(a - k))

    def ang(v):
        return math.atan2(v[1], v[0])

    def pose(f):
        p = (f % frames) / frames
        rots, locs = {}, {}
        bob = (0.03 * math.cos(4 * math.pi * p) - 0.02) if walk else 0.008 * math.sin(math.tau * p)
        locs['body'] = Vector((0, 0, bob))
        for sd, ph0 in (('L', 0.0), ('R', 0.5)):
            h, k, a, l1, l2 = rest[sd]
            if walk:
                ph = (p + ph0) % 1
                duty = 0.6
                if ph < duty:
                    u = ph / duty
                    ty, lift = stride * duty * (0.5 - u), 0.0
                else:
                    u = (ph - duty) / (1 - duty)
                    ty, lift = stride * duty * (u - 0.5), 0.18 * math.sin(math.pi * u)
            else:
                ty, lift = 0.0, 0.0
            hip = h + np.array([0, bob])
            knee, ank = _ik2(hip, a + np.array([ty, lift]), l1, l2)
            # bone rotations about X: from the rest direction to the posed one
            th = ang(knee - hip) - ang(k - h)
            ts = ang(ank - knee) - ang(a - k) - th
            rots[f'thigh.{sd}'] = H.rot((X, math.degrees(th)))
            rots[f'shank.{sd}'] = H.rot((X, math.degrees(ts)))
            rots[f'foot.{sd}'] = H.rot((X, -math.degrees(th + ts) + (25 * math.sin(math.pi * u) if walk and ph >= 0.6 else 0)))
        q = math.tau * p
        if walk:
            peck = 6 * math.sin(2 * q + 0.8)
            rots['neck1'] = H.rot((X, peck))
            rots['head'] = H.rot((X, -peck * 0.8))
            rots['wing.L'] = H.rot((Y, 6 * math.sin(2 * q)))
            rots['wing.R'] = H.rot((Y, -6 * math.sin(2 * q)))
        else:
            rots['neck1'] = H.rot((X, 3 * math.sin(q)), (Z, 12 * math.sin(q + 0.5)))
            rots['head'] = H.rot((X, -2 * math.sin(q)), (Z, 10 * math.sin(2 * q)))
            ruffle = 14 * max(0.0, math.sin(q * 2 - 1)) ** 6
            rots['wing.L'] = H.rot((Y, ruffle))
            rots['wing.R'] = H.rot((Y, -ruffle))
        for i in range(3):
            rots[f'tail{i + 1}'] = H.rot((X, 2 * math.sin(q * (2 if walk else 1) - i * 0.5)),
                                         (Z, (5 + 3 * i) * math.sin(q - i * 0.6)))
        return rots, locs
    return pose


def build_cockatrice():
    name = 'Cockatrice'
    ob = import_model('cockatrice')
    J, bones = cock_joints(ob)
    ob.name = name + '_Mesh'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, 'cockatrice'), name)
    arm_ob = H.make_armature(name, J, bpy.context.scene.collection, bones=bones)
    cock_skin(ob, J, bones)
    H.bind(ob, arm_ob)
    bpy.context.scene.render.fps = H.FPS
    stride = 1.1
    H.write_action(arm_ob, 'Walk', 28, cock_pose(J, 28, stride))
    H.write_action(arm_ob, 'Idle', 90, cock_pose(J, 90, stride, walk=False))
    arm_ob['stride'] = stride
    arm_ob['height'] = round(float(coords(ob)[:, 2].max()), 3)
    return arm_ob, ob


# --- green slime ----------------------------------------------------------------------------------
#
# One bone from the base up through the blob; every vertex on it, so scaling the bone
# squashes and stretches the whole blob about its base. Walk: it heaves forward, tall
# and leaning, then slumps flat; Idle: a slow wobbling breath.

SLIME_W = 1.9  # width, world units


def write_scaled_action(arm_ob, name, frames, fn):
    """fn(f) -> (rotation Quaternion, location Vector, scale Vector) of the single bone."""
    ad = arm_ob.animation_data or arm_ob.animation_data_create()
    act = bpy.data.actions.new(f'{arm_ob.name}_{name}')
    ad.action = act
    pb = arm_ob.pose.bones[0]
    pb.rotation_mode = 'QUATERNION'
    R = pb.bone.matrix_local.to_3x3()
    for f in range(frames + 1):
        q, loc, sc = fn(f % frames)
        pb.rotation_quaternion = (R.inverted() @ q.to_matrix() @ R).to_quaternion()
        pb.location = R.inverted() @ loc
        # bone Y is the blob's up axis; X and Z its width
        pb.scale = (sc.x, sc.z, sc.y)
        for path in ('rotation_quaternion', 'location', 'scale'):
            pb.keyframe_insert(path, frame=f)
    ad.action = None
    track = ad.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act).name = name


def build_slime():
    name = 'GreenSlime'
    ob = import_model('greenslime')
    co = coords(ob)
    s = SLIME_W / max(np.ptp(co[:, 0]), np.ptp(co[:, 1]))
    c = (co.min(0) + co.max(0)) / 2
    ob.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation((-c[0], -c[1], -co[:, 2].min())))
    ob.name = name + '_Mesh'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, 'greenslime'), name, accent=False)
    top = float(coords(ob)[:, 2].max())
    J = {'base': Vector((0, 0, 0)), 'top': Vector((0, 0, top))}
    arm_ob = H.make_armature(name, J, bpy.context.scene.collection, bones=[('blob', 'base', 'top', None)])
    write_weights(ob, np.ones((len(ob.data.vertices), 1), np.float32), ['blob'])
    H.bind(ob, arm_ob)
    bpy.context.scene.render.fps = H.FPS

    def walk(f):
        p = math.tau * f / 30
        up = 0.16 * math.sin(p)
        lean = -7 * math.sin(p - 0.7)
        return (H.rot((X, lean)), Vector((0, -0.05 * math.sin(p - 1.2), 0)),
                Vector((1 - 0.45 * up, 1 - 0.3 * up, 1 + up)))

    def idle(f):
        p = math.tau * f / 60
        up = 0.05 * math.sin(p)
        return (H.rot((X, 1.5 * math.sin(2 * p)), (Y, 1.5 * math.sin(p))), Vector(),
                Vector((1 - 0.5 * up + 0.02 * math.sin(3 * p), 1 - 0.5 * up - 0.02 * math.sin(3 * p), 1 + up)))
    write_scaled_action(arm_ob, 'Walk', 30, walk)
    write_scaled_action(arm_ob, 'Idle', 60, idle)
    arm_ob['stride'] = 0.9
    arm_ob['height'] = round(top, 3)
    print(f'{name}: scale {s:.3f}, height {top:.2f}', flush=True)
    return arm_ob, ob


# --- ballista, siege tower (wheeled) --------------------------------------------------------------
#
# The catapult's rig: yawed to face -Y, the wheels found as outer-|x| vertex clusters
# low down (the ballista's bow arms reach wider than its wheels), rigid on hub bones.

WHEELED = {
    'ballista': dict(name='Ballista', yaw=90, length=2.3, wheel_z=0.45, sway=0.5),
    'siegeengine': dict(name='SiegeEngine', yaw=90, length=1.7, wheel_z=0.22, sway=1.2),
}


def build_wheeled(unit):
    spec = WHEELED[unit]
    name = spec['name']
    ob = import_model(unit)
    ob.data.transform(Matrix.Rotation(math.radians(spec['yaw']), 4, 'Z'))
    co = coords(ob)
    s = spec['length'] / np.ptp(co[:, 1])
    c = (co.min(0) + co.max(0)) / 2
    ob.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation((-c[0], -c[1], -co[:, 2].min())))
    co = coords(ob)
    Hh = co[:, 2].max()
    lowv = co[co[:, 2] < spec['wheel_z'] * Hh]
    half = np.abs(lowv[:, 0]).max()
    outer = lowv[np.abs(lowv[:, 0]) > 0.8 * half]
    ymid = (outer[:, 1].min() + outer[:, 1].max()) / 2
    wheels = []
    print(f'{name}:', flush=True)
    for fb, fsg in (('F', -1), ('B', 1)):
        for side, sg in (('L', 1), ('R', -1)):
            w = outer[(np.sign(outer[:, 0]) == sg) & (np.sign(outer[:, 1] - ymid) == fsg)]
            lo, hi = w.min(0), w.max(0)
            hub = (lo + hi) / 2
            r = max(hi[1] - lo[1], hi[2] - lo[2]) / 2
            d = np.hypot(co[:, 1] - hub[1], co[:, 2] - hub[2])
            mask = (np.sign(co[:, 0]) == sg) & (np.abs(co[:, 0]) > 0.66 * half) & (d < r * 1.06)
            hub[0] = sg * 0.8 * half
            wheels.append((f'wheel.{fb}{side}', Vector(hub.tolist()), float(r), mask))
            print(f'  {fb}{side}: hub ({hub[0]:.2f}, {hub[1]:.2f}, {hub[2]:.2f}) r {r:.3f}, {int(mask.sum())} vertices', flush=True)
    ob.name = name + '_Mesh'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, unit), name)
    J = {'c0': Vector((0, 0.3, 0.3)), 'c1': Vector((0, -0.3, 0.3))}
    bones = [('chassis', 'c0', 'c1', None)]
    for n, hub, _, _ in wheels:
        J[n] = hub
        J[n + '_t'] = hub + Vector((0.15 * math.copysign(1, hub.x), 0, 0))
        bones.append((n, n, n + '_t', 'chassis'))
    arm_ob = H.make_armature(name, J, bpy.context.scene.collection, bones=bones)
    W = np.zeros((len(co), 1 + len(wheels)), np.float32)
    W[:, 0] = 1
    for i, (_, _, _, mask) in enumerate(wheels):
        W[mask, 0] = 0
        W[mask, i + 1] = 1
    write_weights(ob, W, ['chassis'] + [w[0] for w in wheels])
    H.bind(ob, arm_ob)
    r = float(np.mean([w[2] for w in wheels]))
    frames = 30

    def roll(f):
        p = math.tau * f / frames
        rots = {n: H.rot((X, 360 * f / frames)) for n, _, _, _ in wheels}
        rots['chassis'] = H.rot((X, spec['sway'] * math.sin(2 * p)), (Y, 0.6 * spec['sway'] * math.sin(p)))
        return rots, {'chassis': Vector((0, 0, 0.006 * abs(math.sin(2 * p))))}
    bpy.context.scene.render.fps = H.FPS
    H.write_action(arm_ob, 'Walk', frames, roll)
    H.write_action(arm_ob, 'Idle', frames, lambda f: ({}, {}))
    arm_ob['stride'] = round(math.tau * r, 4)
    arm_ob['height'] = round(float(co[:, 2].max()), 3)
    print(f'{name}: {len(ob.data.polygons)} faces, wheel r {r:.3f}, height {arm_ob["height"]}', flush=True)
    return arm_ob, ob


# --- export / preview -----------------------------------------------------------------------


def export(arm_ob, ob, path):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    arm_ob.select_set(True)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = arm_ob
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
    print(f'wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)', flush=True)


def preview(arm_ob, path):
    sc = bpy.context.scene
    clip = os.environ.get('CLIP', 'Walk')
    for t in arm_ob.animation_data.nla_tracks:
        t.mute = t.name != clip
    frames = [int(f) for f in os.environ.get('FRAMES', '0,6,12,18').split(',')]
    ang = math.radians(float(os.environ.get('CAM_ANGLE', '30')))
    tilt = math.radians(float(os.environ.get('CAM_TILT', '30')))
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = sc.render.resolution_y = 600
    world = bpy.data.worlds.new('W')
    world.color = (0.35, 0.38, 0.42)
    sc.world = world
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = float(os.environ.get('ORTHO', 0)) or 1.25 * max(arm_ob.dimensions.x, arm_ob.dimensions.y, SPAN if 'Dragon' in arm_ob.name else LENGTH)
    d = 12
    cam.location = (math.sin(ang) * math.cos(tilt) * d, -math.cos(ang) * math.cos(tilt) * d,
                    math.sin(tilt) * d + (0 if 'Dragon' in arm_ob.name else 0.6))
    cam.rotation_euler = (math.pi / 2 - tilt, 0, ang)
    sc.camera = cam
    for rot, e in (((50, 10, 35), 4), ((70, 0, 200), 1.2)):
        sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
        sun.data.energy = e
        sun.rotation_euler = [math.radians(a) for a in rot]
        sc.collection.objects.link(sun)
    tiles = []
    tmp = path + '.frame.png'
    for f in frames:
        sc.frame_set(f)
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(tmp, check_existing=False)
        tiles.append(pixels(img))
        bpy.data.images.remove(img)
    os.remove(tmp)
    h, w = tiles[0].shape[:2]
    sheet = np.concatenate(tiles, axis=1)
    out = bpy.data.images.new('sheet', w * len(tiles), h)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    print(f'preview {path}', flush=True)


BUILDERS = {'dragon': build_dragon, 'catapult': build_catapult, 'cockatrice': build_cockatrice,
            'greenslime': build_slime}
for _u in FLYERS:
    BUILDERS[_u] = lambda u=_u: build_flyer(u)
for _u in CRAWLERS:
    BUILDERS[_u] = lambda u=_u: build_crawler(u)
for _u in WHEELED:
    BUILDERS[_u] = lambda u=_u: build_wheeled(u)


def main():
    only = os.environ.get('ONLY')
    for unit, fn in BUILDERS.items():
        if only and unit not in only.split(','):
            continue
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        arm_ob, ob = fn()
        meshy_lib.downsize([ob], TEX)
        if os.environ.get('EXPORT', '1') != '0':
            export(arm_ob, ob, os.path.join(OUT_DIR, unit + '.glb'))
        if os.environ.get('PREVIEW'):
            p = os.environ['PREVIEW']
            preview(arm_ob, p if only else p.replace('.png', f'_{unit}.png'))


main()
