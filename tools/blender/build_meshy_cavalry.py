"""Builds the cavalry unit GLBs from Meshy AI models (tools/meshy/<unit>/) on the
procedural horse rig of horse_lib.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_meshy_cavalry.py
    (env ONLY=lightcavalry|heavycavalry builds one, TEX=<px> sets the texture size
     (default 1024), EXPORT=0 skips the export, PREVIEW=/path.png renders a contact
     sheet, CLIP=Walk|Gallop|Idle FRAMES=0,4,8 COLS=3 CAM_ANGLE=<deg> tune it,
     BONES=1 draws the skeleton in the preview, ORTHO=<m> the view height per unit)

Each source is one Meshy image-to-3d task (meshy-7, PBR) of horse and rider standing
square in profile. Meshy can't rig a horse, so the mesh is skinned here:

  * the horse skeleton (horse_lib.BONES) is fitted to the mesh: the lower-leg columns
    give the length and width scale, the croup height the height scale;
  * the rider, his saddle, weapon and shield are one rigid part on the `saddle` bone
    (a box over the barrel plus everything above the horse's ears);
  * the rest of the horse is weighted by distance to its bones, left legs only to the
    left side and right to the right, the tail only behind the croup.

Clips are the horse_lib gaits used by build_units.py: Walk, Gallop and Idle, with the
`stride`, `run_stride` and `height` extras on the armature. Output matches
build_units.py (public/models/units/<unit>.glb); royal-blue cloth goes to
<Unit>_Accent for the faction colour.
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
import horse_lib as HL  # noqa: E402
import meshy_lib  # noqa: E402
from meshy_lib import pixels  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
MESHY = os.path.join(ROOT, 'tools', 'meshy')
OUT_DIR = os.path.join(ROOT, 'public', 'models', 'units')
TEX = int(os.environ.get('TEX', '1024'))

# unit -> name, croup height (m) the model is scaled to; midline: half width of the
# chest ruff and belly fur between a wolf's close-set legs, kept off the leg bones
# (both legs would pull it apart); reach scales how far a leg bone's pull extends (the
# ruff hangs close to a wolf's forelegs); rider=False for a beast
# without one (only its barrel band rides the saddle bone). The wolves use the horse
# rig too: fitted to their legs and croup, their gait is a horse's.
UNITS = {
    'lightcavalry': dict(name='LightCavalry', croup=1.5),
    'heavycavalry': dict(name='HeavyCavalry', croup=1.6),
    'wolfrider': dict(name='Wolfrider', croup=1.2, legsplit=True),
    'unicorn': dict(name='Unicorn', croup=1.55, rider=False),
    'warg': dict(name='Warg', croup=1.2, rider=False, legsplit=True),
    # the spear grounded beside the forelegs rides with the torso (capsule a, b, radius
    # in fitted metres)
    'centaur': dict(name='Centaur', croup=1.45, poles=[((-0.23, -0.48, 0.0), (-0.49, -0.96, 2.66), 0.05)]),
    'elephant': dict(name='Elephant', croup=2.6, legsplit=True),
    # `gait` scales the horse's stride and hoof lift to a smaller beast's legs
    # `skirt`: a caparison hanging down to that height (m) rides the body
    'elvencavalry': dict(name='ElvenCavalry', croup=1.5, skirt=0.5, ahead=0.35),
    'gnollcavalry': dict(name='GnollCavalry', croup=1.15, legsplit=True, gait=0.72),
    'giantrat': dict(name='GiantRat', croup=0.9, rider=False, legsplit=True, gait=0.5),
    'undeadbeast': dict(name='UndeadBeast', croup=1.9, rider=False, legsplit=True, gait=0.85),
    # flyers: feathered wings raised over the back go on wing bones (see WINGS)
    'pegasus': dict(name='Pegasus', croup=1.55, rider=False,
                    wings=dict(y=(-0.35, 0.8), z=1.72, x=0.12, high=2.05)),
    # its eagle talons reach well ahead of the fetlock (`ahead`, m: still leg there)
    'griffon': dict(name='Griffon', croup=1.45, rider=False, legsplit=True, ahead=0.45,
                    wings=dict(y=(-0.85, 0.5), z=1.75, x=0.24, high=2.15)),
}

# wing beats of the flyers, degrees each wing turns down from its raised rest pose
# about the body's front-back axis: flight (Walk, the gallop's legs) and hover (Idle)
WING_FLY = dict(amp=78, beats=1)  # one beat per gallop cycle (HL.GALLOP frames)
WING_HOVER = dict(amp=58, beats=3)  # over the 90-frame idle

# horse_lib's base horse: lower-leg column centres (y) and their half spread (x),
# and the croup top above the hind legs
BASE_FRONT_Y = -0.58
BASE_HIND_Y = 0.6
BASE_LEG_X = 0.19
BASE_CROUP = 1.56


def _ramp(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def import_model(src):
    before = {o.name for o in bpy.data.objects}
    bpy.ops.import_scene.gltf(filepath=os.path.join(MESHY, src, 'model_static.glb'))
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


def leg_columns(co):
    """Front and hind lower-leg centres (y) and the legs' half spread (x) near the ground."""
    low = co[co[:, 2] < co[:, 2].min() + 0.12 * (co[:, 2].max() - co[:, 2].min())]
    mid = (low[:, 1].min() + low[:, 1].max()) / 2
    front, hind = low[low[:, 1] < mid], low[low[:, 1] >= mid]
    return float(np.median(front[:, 1])), float(np.median(hind[:, 1])), float(np.median(np.abs(low[:, 0])))


def fit(ob, spec):
    """Scale the mesh to the unit's croup height with its ground at z = 0, and return
    horse joints fitted to it."""
    co = coords(ob)
    ob.data.transform(Matrix.Translation((0, 0, -co[:, 2].min())))
    co = coords(ob)
    fy, hy, lx = leg_columns(co)
    # croup: highest point in a thin slice over the hind legs, inside the body width
    sl = co[(np.abs(co[:, 1] - (hy - 0.05 * (hy - fy))) < 0.03 * (hy - fy)) & (np.abs(co[:, 0]) < lx)]
    croup = float(sl[:, 2].max())
    s = spec['croup'] / croup
    ob.data.transform(Matrix.Scale(s, 4))
    fy, hy, lx, croup = fy * s, hy * s, lx * s, croup * s
    sy = (hy - fy) / (BASE_HIND_Y - BASE_FRONT_Y)
    sz = croup / BASE_CROUP
    sx = lx / BASE_LEG_X
    J = HL.make_joints((sx, sy, sz))
    dy = (fy + hy) / 2 - (BASE_FRONT_Y + BASE_HIND_Y) / 2 * sy
    for k in J:
        J[k] = J[k] + Vector((0, dy, 0))
    # Meshy horses are shorter behind the hips than the base horse: move the tail
    # chain onto the hanging tail (hair behind the croup, between tail1 and tail2)
    co = coords(ob)
    t = co[(co[:, 1] > J['pelvis_t'].y) & (np.abs(co[:, 0]) < 0.1)
           & (co[:, 2] < J['tail1'].z) & (co[:, 2] > J['tail2'].z)]
    if len(t):
        ty = float(np.percentile(t[:, 1], 50)) - (J['tail1'].y + J['tail2'].y) / 2
        for k in ('tail0', 'tail1', 'tail2', 'tail3'):
            J[k] = J[k] + Vector((0, ty, 0))
    print(f'{spec["name"]}: scale {s:.3f}, legs front y={fy:.2f} hind y={hy:.2f} x=+-{lx:.2f}, '
          f'croup {croup:.2f}; joint scale ({sx:.2f}, {sy:.2f}, {sz:.2f}) dy {dy:.2f}', flush=True)
    return J


def cut_bridges(ob, J, gap=0.03):
    """Delete faces that join the left and right legs under the belly: built from a
    profile view, Meshy spans big triangles between the near and far legs (hidden
    behind the near legs), which tear into sheets once the legs step apart."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    zb = J['felbow.L'].z
    kill = [f for f in bm.faces
            if max(v.co.z for v in f.verts) < zb
            and min(v.co.x for v in f.verts) < -gap and max(v.co.x for v in f.verts) > gap]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(ob.data)
    bm.free()
    print(f'  cut {len(kill)} faces bridging the legs', flush=True)


def _seg_dist(co, a, b):
    a, b = np.array(a), np.array(b)
    d = b - a
    t = np.clip(((co - a) @ d) / (d @ d), 0, 1)
    return np.linalg.norm(co - (a + t[:, None] * d), axis=1)


def split_legs(co, J, names, W, ahead=0.15):
    """Under the belly every vertex belongs to its own leg (quadrant by side and front /
    hind), spread over that leg's bones by height. Distance weighting fails on beasts
    whose legs are shaped unlike the horse template (a wolf's hock sits higher), leaving
    leg fur on the body to tear."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    mid_y = (J['fknee.L'].y + J['hock.L'].y) / 2
    body = co[(np.abs(x) < 0.04) & (y > J["felbow.L"].y + 0.1) & (y < J["stifle.L"].y - 0.1)]
    zb = float(body[:, 2].min()) if len(body) else J['felbow.L'].z
    # the hanging tail reaches below the belly on the midline behind the hind legs: not leg
    # (a bushy tail is wider than the midline, so well behind the hocks counts too)
    tail = np.maximum(_ramp((y - J['hock.L'].y) / 0.05) * _ramp((0.07 - np.abs(x)) / 0.02),
                      _ramp((y - J['hock.L'].y - 0.12) / 0.06))
    before = _ramp((J['ffet.L'].y - ahead - y) / 0.06)  # trunk, tusks
    f = _ramp((zb - z) / 0.1) * (1 - tail) * (1 - before)
    Wl = np.zeros_like(W)
    for sd, sg in (('L', 1), ('R', -1)):
        for front in (True, False):
            chain = ('humerus', 'forearm', 'fcannon', 'fhoof') if front else ('femur', 'gaskin', 'hcannon', 'hhoof')
            sel = (np.sign(x + 1e-6) == sg) & ((y < mid_y) if front else (y >= mid_y))
            for c in chain:
                n = HL.b(c, sd)
                _, a, b, _ = HL.BONE[n]
                lo, hi = sorted((J[a].z, J[b].z))
                dz = np.maximum(np.maximum(lo - z, z - hi), 0)
                Wl[sel, names.index(n)] = np.exp(-(dz[sel] / 0.04) ** 2) + 1e-6
    Wl /= np.maximum(Wl.sum(1, keepdims=True), 1e-9)
    print(f'  legs split under the belly (z < {zb:.2f})', flush=True)
    return W * (1 - f)[:, None] + Wl * f[:, None]


def skin(ob, J, has_rider=True, midline=0.0, reach=1.0, legsplit=False, poles=(), ahead=0.15, skirt=None):
    """Vertex groups: the rider rigid on `saddle`, the horse by distance to its bones."""
    co = coords(ob)
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    # rider: over the barrel between withers and hips, above the elbows; or anything
    # higher than the ears (lance, pennon, helmet crest)
    y0, y1 = J['withers.L'].y + 0.02, J['hip.L'].y - 0.1
    zb = J['felbow.L'].z + 0.25
    ears = J['poll'].z + 0.25
    box = _ramp((y - y0) / 0.06) * _ramp((y1 - y) / 0.06) * _ramp((z - zb) / 0.08)
    # the barrel itself stays on the horse bones: the rider is outside its cross-section
    # or above the back
    back = J['saddle'].z - 0.12
    barrel_r = 0.9 * max(abs(J['fshoulder.L'].x), abs(J['stifle.L'].x)) + 0.05
    outside = np.maximum(_ramp((z - back) / 0.05), _ramp((np.abs(x) - barrel_r) / 0.04))
    rider = np.maximum(box * outside, _ramp((z - ears) / 0.05))
    if not has_rider:  # a unicorn's horn rises above its ears
        rider = np.zeros(len(co))
    for a, b, r in poles:
        rider = np.maximum(rider, _ramp((r - _seg_dist(co, a, b)) / 0.01 + 0.5))

    names = [bn[0] for bn in HL.BONES if bn[0] != 'saddle']
    D = np.stack([_seg_dist(co, J[HL.BONE[n][1]], J[HL.BONE[n][2]]) for n in names], axis=1)
    legs = [i for i, n in enumerate(names) if n.endswith(('.L', '.R'))]
    # between the legs' tops everything that isn't leg (the barrel, the rider's legs in
    # the stirrups, a caparison's skirt) rides with the body, like the saddle
    dleg = D[:, legs].min(1)
    band = (_ramp((y - y0) / 0.06) * _ramp((y1 - y) / 0.06)
            * _ramp((z - (J['felbow.L'].z - 0.1)) / 0.06) * _ramp((dleg - 0.14) / 0.08))
    rider = np.maximum(rider, band)
    if skirt:
        # a long caparison, chest panel to rump, down to `skirt` m: all of it that isn't
        # leg rides the body too (a leg's pull tears the hanging cloth into sheets)
        ys0, ys1 = J['ffet.L'].y - 0.4, J['hock.L'].y + 0.3
        cloth = (_ramp((y - ys0) / 0.06) * _ramp((ys1 - y) / 0.06)
                 * _ramp((z - skirt) / 0.05) * _ramp((dleg - 0.1) / 0.06))
        rider = np.maximum(rider, cloth)
    for i, n in enumerate(names):
        if n.endswith('.L'):
            D[x < -0.02, i] = np.inf
        elif n.endswith('.R'):
            D[x > 0.02, i] = np.inf
        if 'tail' in n:
            D[y < J['tail0'].y - 0.05, i] = np.inf
        if midline and n.endswith(('.L', '.R')):
            D[np.abs(x) < midline, i] = np.inf
        # well ahead of the front hooves hang a trunk or a grounded spear, not legs
        if n.endswith(('.L', '.R')):
            D[y < J['ffet.L'].y - ahead, i] = np.inf
    W = 1.0 / np.maximum(D, 0.01) ** 5
    W /= np.maximum(W.sum(1, keepdims=True), 1e-30)
    # a leg bone only moves what is close to it, so cloth hanging past it stays put:
    # its share fades out with distance and goes to the spine bones instead
    spine = [i for i, n in enumerate(names) if n.split('_')[1] in ('body', 'chest', 'pelvis', 'neck1')]
    for i in legs:
        upper = any(k in names[i] for k in ('scap', 'humerus', 'femur'))
        W[:, i] *= _ramp(((0.3 if upper else 0.15) * reach - D[:, i]) / (0.1 * reach))
    rest = 1 - W.sum(1)
    Ws = 1.0 / np.maximum(D[:, spine], 0.01) ** 3
    W[:, spine] += rest[:, None] * Ws / Ws.sum(1, keepdims=True)
    # keep the four nearest bones
    if W.shape[1] > 4:
        cut = np.partition(W, -4, axis=1)[:, -4][:, None]
        W[W < cut] = 0
    W /= W.sum(1, keepdims=True)
    if legsplit:
        W = split_legs(co, J, names, W, ahead)
    W *= (1 - rider)[:, None]

    groups = {n: ob.vertex_groups.new(name=n) for n in names + ['saddle']}
    for i, n in enumerate(names):
        g = groups[n]
        for v in np.nonzero(W[:, i] > 1e-3)[0]:
            g.add([int(v)], float(W[v, i]), 'REPLACE')
    for v in np.nonzero(rider > 1e-3)[0]:
        groups['saddle'].add([int(v)], float(rider[v]), 'REPLACE')
    print(f'  rider: {int((rider > 0.5).sum())} of {len(co)} vertices rigid on the saddle', flush=True)


def wing_mask(co, J, w):
    """Wing vertices: above the back over the barrel, clear of the neck's width or
    higher than the head reaches."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    band = _ramp((y - w['y'][0]) / 0.04) * _ramp((w['y'][1] - y) / 0.04) * _ramp((z - w['z']) / 0.04)
    return band * np.maximum(_ramp((np.abs(x) - w['x']) / 0.03), _ramp((z - w['high']) / 0.04))


def add_wing_joints(ob, J, w):
    """Wing root beside the withers and tip at the far end of each wing (fitted metres)."""
    co = coords(ob)
    m = wing_mask(co, J, w) > 0.5
    for side, sg in (('L', 1), ('R', -1)):
        pts = co[m & (np.sign(co[:, 0]) == sg)]
        near = pts[np.abs(pts[:, 0]) < np.percentile(np.abs(pts[:, 0]), 8)]
        root = near.mean(0)
        root[0] = sg * max(abs(root[0]), 0.06)
        root[2] = min(root[2], w['z'] + 0.05)
        far = pts[np.linalg.norm(pts - root, axis=1) > np.percentile(np.linalg.norm(pts - root, axis=1), 90)]
        J[f'wroot.{side}'] = Vector(root.tolist())
        J[f'wtip.{side}'] = Vector(far.mean(0).tolist())
        print(f'  wing {side}: root {tuple(round(v, 2) for v in root)} tip '
              f'{tuple(round(v, 2) for v in J[f"wtip.{side}"])}, {int(m.sum())} vertices', flush=True)
    return [(f'wing.{sd}', f'wroot.{sd}', f'wtip.{sd}', HL.P + 'chest') for sd in ('L', 'R')]


def skin_wings(ob, J, w):
    """Wings rigid on their bones, easing into the chest at the root."""
    co = coords(ob)
    m = wing_mask(co, J, w)
    groups = {g.name: g for g in ob.vertex_groups}
    names = [g.name for g in ob.vertex_groups]
    for sd in ('L', 'R'):
        groups[f'wing.{sd}'] = ob.vertex_groups.new(name=f'wing.{sd}')
    me = ob.data
    for i in np.nonzero(m > 1e-3)[0]:
        sd = 'L' if co[i, 0] > 0 else 'R'
        r = np.linalg.norm(co[i] - np.array(J[f'wroot.{sd}']))
        f = float(_ramp((r - 0.05) / 0.25))
        v = me.vertices[int(i)]
        old = {names[g.group]: g.weight for g in v.groups}
        tot = sum(old.values()) or 1
        new = {n: (1 - m[i] * f) * x / tot for n, x in old.items()}
        new[f'wing.{sd}'] = m[i] * f
        for n in old:
            groups[n].remove([v.index])
        for n, x in new.items():
            if x > 1e-4:
                groups[n].add([v.index], float(x), 'REPLACE')


def with_wings(pose, frames, amp, beats):
    """Adds a wing beat to a gait pose: each wing turns down from its raised rest about
    the front-back axis, the downstroke quicker than the upstroke."""
    def f(fr):
        rots, locs = pose(fr)[:2]
        p = math.tau * beats * fr / frames
        q = p + 0.35 * math.sin(p)
        a = amp * 0.5 * (1 - math.cos(q))
        rots = dict(rots)
        rots['wing.L'] = H.rot((H.Y, a))
        rots['wing.R'] = H.rot((H.Y, -a))
        return rots, locs
    return f


def scaled_gait(spec, k):
    """A horse gait for a beast k times a horse's size: stride, hoof lift and reach scale."""
    s = dict(spec)
    for key in ('stride', 'lift_f', 'lift_h', 'reach_f', 'reach_h', 'bob', 'drop'):
        if key in s:
            s[key] = s[key] * k
    return s


def write_clips(arm_ob, J, wings=False, k=1.0):
    bpy.context.scene.render.fps = H.FPS
    walk, gallop = scaled_gait(HL.WALK, k), scaled_gait(HL.GALLOP, k)
    for clip, spec in (('Walk', walk), ('Gallop', gallop)):
        g = HL.Gait(J, dict(spec))
        for f in range(spec['frames']):  # warm up the IK
            g.pose(f)
        if wings and clip == 'Walk':
            continue
        pose = lambda f, g=g: g.pose(f)[:2]
        if wings:  # a flyer's Walk is its flight: galloping legs under beating wings
            clip = 'Walk'
            pose = with_wings(pose, spec['frames'], WING_FLY['amp'], WING_FLY['beats'])
        H.write_action(arm_ob, clip, spec['frames'], pose)
    ip = HL.idle_pose(J, 90)
    pose = lambda f: ip(f)[:2]
    if wings:
        pose = with_wings(pose, 90, WING_HOVER['amp'], WING_HOVER['beats'])
    H.write_action(arm_ob, 'Idle', 90, pose)
    arm_ob['stride'] = walk['stride']
    arm_ob['run_stride'] = gallop['stride']


def build(unit, index):
    spec = UNITS[unit]
    name = spec['name']
    ob = import_model(unit)
    J = fit(ob, spec)
    ob.name = name + '_Mesh'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, unit), name)
    coll = bpy.context.scene.collection
    wings = spec.get('wings')
    bones = HL.BONES + (add_wing_joints(ob, J, wings) if wings else [])
    arm_ob = H.make_armature(name, J, coll, bones=bones)
    if spec.get('midline'):
        cut_bridges(ob, J)
    skin(ob, J, spec.get('rider', True), spec.get('midline', 0.0), spec.get('reach', 1.0),
         spec.get('legsplit', False), spec.get('poles', ()), spec.get('ahead', 0.15), spec.get('skirt'))
    if wings:
        skin_wings(ob, J, wings)
    H.bind(ob, arm_ob)
    write_clips(arm_ob, J, bool(wings), spec.get('gait', 1.0))
    arm_ob['height'] = round(float(coords(ob)[:, 2].max()), 3)
    print(f'{name}: {len(ob.data.polygons)} faces, height {arm_ob["height"]} m', flush=True)
    return arm_ob, ob


def export(arm_ob, ob, path):
    loc = tuple(arm_ob.location)
    arm_ob.location = (0, 0, 0)
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
    arm_ob.location = loc
    print(f'wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)', flush=True)


def bone_sticks(arms):
    """Thin emissive rods along every bone, parented to it, for the preview."""
    mat = bpy.data.materials.new('stick')
    b = mat.node_tree.nodes['Principled BSDF']
    b.inputs['Emission Color'].default_value = (1, 1, 0, 1)
    b.inputs['Emission Strength'].default_value = 4
    for arm in arms:
        for bone in arm.data.bones:
            L = bone.length
            bpy.ops.mesh.primitive_cylinder_add(radius=0.012, depth=L, vertices=6)
            st = bpy.context.active_object
            st.data.materials.append(mat)
            st.show_in_front = True
            st.parent = arm
            st.parent_type = 'BONE'
            st.parent_bone = bone.name
            # bone space: Y along the bone, parent at the tail
            st.matrix_parent_inverse = Matrix()
            st.location = (0, -L / 2, 0)
            st.rotation_euler = (math.radians(90), 0, 0)


def preview(arms, path):
    sc = bpy.context.scene
    clip = os.environ.get('CLIP', 'Walk')
    for arm in arms:
        for t in arm.animation_data.nla_tracks:
            t.mute = t.name != clip
    if os.environ.get('BONES'):
        bone_sticks(arms)
    frames = [int(f) for f in os.environ.get('FRAMES', '0,8,16,24').split(',')]
    cols = int(os.environ.get('COLS', len(frames)))
    ang = math.radians(float(os.environ.get('CAM_ANGLE', '90')))
    # units side by side across the view
    across = Vector((math.cos(ang), math.sin(ang), 0))
    for i, arm in enumerate(arms):
        arm.location = across * (i * 4.0)
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 500 * len(arms), 500
    world = bpy.data.worlds.new('W')
    world.color = (0.35, 0.38, 0.42)
    sc.world = world
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = float(os.environ.get('ORTHO', '3.6')) * len(arms)
    mid = across * ((len(arms) - 1) * 2.0)
    d = 12
    cam.location = (mid.x + math.sin(ang) * d, mid.y - math.cos(ang) * d, float(os.environ.get('ORTHO', '3.6')) * 0.39)
    cam.rotation_euler = (math.radians(90), 0, ang)
    sc.camera = cam
    for rot, e in (((50, 10, 35), 4), ((70, 0, 200), 1.2)):
        sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
        sun.data.energy = e
        sun.rotation_euler = [math.radians(a) for a in rot]
        sc.collection.objects.link(sun)
    tiles = []
    tmp = path + '.frame.png'
    meshes = [o for o in sc.objects if o.type == 'MESH' and o.name.endswith('_Mesh')]
    for hide in ((False, True) if os.environ.get('BONES') else (False,)):
        for m in meshes:
            m.hide_render = hide
        for f in frames:
            sc.frame_set(f)
            sc.render.filepath = tmp
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(tmp, check_existing=False)
            tiles.append(pixels(img))
            bpy.data.images.remove(img)
    if os.environ.get('BONES'):
        cols = len(frames)
    os.remove(tmp)
    h, w = tiles[0].shape[:2]
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.zeros((rows * h, cols * w, 4), np.float32)
    for i, t in enumerate(tiles):
        r = rows - 1 - i // cols
        sheet[r * h:(r + 1) * h, (i % cols) * w:(i % cols + 1) * w] = t
    out = bpy.data.images.new('sheet', cols * w, rows * h)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    print(f'preview {path}', flush=True)


def main():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    only = os.environ.get('ONLY')
    built = []
    for i, unit in enumerate(u for u in UNITS if not only or u in only.split(',')):
        arm_ob, ob = build(unit, i)
        meshy_lib.downsize([ob], TEX)
        if os.environ.get('EXPORT', '1') != '0':
            export(arm_ob, ob, os.path.join(OUT_DIR, unit + '.glb'))
        built.append(arm_ob)
    if os.environ.get('PREVIEW'):
        preview(built, os.environ['PREVIEW'])


main()
