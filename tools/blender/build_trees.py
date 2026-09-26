"""Builds the vegetation models and exports public/models/trees.glb.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_trees.py

Models are instanced thousands of times, so they stay small (roughly 250-800
triangles) and carry everything in vertex attributes: albedo x ambient occlusion
in the colour attribute, and soft "crown" normals that point away from the
canopy centre, so foliage shades like a volume instead of showing every facet.
AO is ray-traced here with a BVH (no Cycles bake needed).

Object names map to vegetation kinds in src/render/Vegetation.js:
Pine_A, Pine_B, SnowPine_A, SnowPine_B, Oak_A, Oak_B, Bush_A, Bush_B, Dead_A, Dead_B.
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector, noise
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/Users/tomaszszkudlarek/Projects/Warlords/tools/blender'
sys.path.insert(0, HERE)
import lib  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'public', 'models', 'trees.glb')
TAU = math.pi * 2


class Mesh:
    """Accumulates vertices with per-vertex colour and 'soft' normal targets."""

    def __init__(self):
        self.v, self.f, self.col, self.soft = [], [], [], []

    def add(self, verts, faces, col, soft):
        base = len(self.v)
        self.v += [Vector(p) for p in verts]
        self.f += [tuple(i + base for i in f) for f in faces]
        self.col += col if isinstance(col, list) else [col] * len(verts)
        self.soft += soft if isinstance(soft, list) else [soft] * len(verts)
        return base


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def scale_c(c, s):
    return tuple(x * s for x in c)


# --- primitives ---------------------------------------------------------------------------


def tube(m, a, b, r0, r1, seg, col, rng=None):
    """Tapered cylinder between points a and b (open ends)."""
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    t = d.orthogonal().normalized()
    u = d.cross(t)
    verts = []
    for k, (p, r) in enumerate(((a, r0), (b, r1))):
        for i in range(seg):
            ang = i / seg * TAU
            verts.append(p + (t * math.cos(ang) + u * math.sin(ang)) * r)
    faces = [(i, (i + 1) % seg, seg + (i + 1) % seg, seg + i) for i in range(seg)]
    soft = [None] * len(verts)  # use geometric normals
    m.add(verts, faces, col, soft)


def blob(m, center, radius, col_fn, rng, subdiv=1, squash=(1, 1, 0.85), rough=0.18, crown=None, crown_w=0.7):
    """Displaced icosphere clump. Normals blend toward the crown centre direction."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    off = Vector((rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100)))
    verts = []
    for v in bm.verts:
        p = v.co.copy()
        n = noise.noise(p * 1.6 + off) * 0.5 + noise.noise(p * 3.7 + off) * 0.25
        s = 1 + n * rough * 2 + rng.uniform(-rough, rough) * 0.4
        p = Vector((p.x * squash[0], p.y * squash[1], p.z * squash[2])) * radius * s
        verts.append(Vector(center) + p)
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    c = Vector(crown if crown is not None else center)
    soft, cols = [], []
    for p in verts:
        own = (p - Vector(center)).normalized()
        rad = (p - c).normalized()
        soft.append((own * (1 - crown_w) + rad * crown_w).normalized())
        cols.append(col_fn(p))
    m.add(verts, faces, cols, soft)


# --- species ------------------------------------------------------------------------------

BARK = (0.055, 0.035, 0.022)
BARK_GREY = (0.07, 0.06, 0.05)


def pine(m, rng, H=1.5, tiers=10, snow=False, spread=1.0):
    """Fir/spruce: drooping whorls of boughs. Each whorl has a raised mid ring so it
    bulges like a bough rather than reading as a flat cone, and a star-shaped rim
    whose long points hang lower (branch tips)."""
    tube(m, (0, 0, -0.05), (0, 0, H * 0.96), 0.055, 0.012, 6, BARK)
    dark = (0.01, 0.03, 0.018)
    mid = (0.026, 0.06, 0.032)
    tip = (0.055, 0.095, 0.045)
    snowc = (0.55, 0.59, 0.65)
    for i in range(tiers):
        t = i / (tiers - 1)
        top = 0.3 + t ** 0.92 * (H - 0.3) + rng.uniform(-0.015, 0.015)
        R = (0.52 * (1 - t) ** 0.9 + 0.06) * spread * rng.uniform(0.92, 1.06)
        hgt = (0.36 * (1 - 0.5 * t) + 0.04) * rng.uniform(0.92, 1.08)
        n = 12
        rot = rng.uniform(0, TAU)
        apex = Vector((rng.uniform(-0.01, 0.01), rng.uniform(-0.01, 0.01), top))
        ring, rim = [], []
        for k in range(n):
            a = rot + k / n * TAU + rng.uniform(-0.1, 0.1)
            long = k % 2 == 0
            rr = R * (1.0 if long else rng.uniform(0.62, 0.74)) * rng.uniform(0.88, 1.1)
            droop = hgt * (1.0 + (0.3 if long else 0.0)) + rng.uniform(-0.02, 0.025)
            rim.append(Vector((math.cos(a) * rr, math.sin(a) * rr, top - droop)))
            am = a + rng.uniform(-0.08, 0.08)
            ring.append(Vector((math.cos(am) * rr * 0.52, math.sin(am) * rr * 0.52, top - hgt * 0.38)))
        under = Vector((0, 0, top - hgt * 0.62))
        verts = [apex] + ring + rim + [under]
        A, Rg, Rm, U = 0, 1, 1 + n, 1 + 2 * n
        faces = []
        for k in range(n):
            k1 = (k + 1) % n
            faces.append((A, Rg + k, Rg + k1))
            faces.append((Rg + k, Rm + k, Rm + k1))
            faces.append((Rg + k, Rm + k1, Rg + k1))
            faces.append((U, Rm + k1, Rm + k))
        cols, soft = [], []
        for j, p in enumerate(verts):
            radial = min(1.0, Vector((p.x, p.y, 0)).length / max(R, 1e-3))
            if j == A or j == U:
                c = mix(dark, mid, 0.3 + 0.3 * t)
            else:
                c = mix(mid, tip, radial ** 1.5 * rng.uniform(0.55, 1.0))
            c = scale_c(c, rng.uniform(0.9, 1.1))
            if snow and j != U:
                on_top = 1.0 if j < Rm else 0.55
                c = mix(c, snowc, on_top * rng.uniform(0.4, 0.7))
            cols.append(c)
            sn = Vector((p.x, p.y, 0.0))
            sn = (sn.normalized() if sn.length > 1e-4 else Vector((0, 0, 1))) + Vector((0, 0, 0.8))
            soft.append(sn.normalized() if j != U else Vector((0, 0, -1)))
        m.add(verts, faces, cols, soft)
    m.add([Vector((0, 0, H + 0.12)), Vector((0.035, 0, H - 0.04)), Vector((-0.02, 0.03, H - 0.04)), Vector((-0.02, -0.03, H - 0.04))],
          [(0, 1, 2), (0, 2, 3), (0, 3, 1)], (0.07, 0.11, 0.05) if not snow else snowc, Vector((0, 0, 1)))


def broadleaf(m, rng, kind='oak'):
    """Deciduous tree: a branching trunk carrying a crown built from a core plus many
    small jittered leaf clusters, which gives a broken, leafy silhouette. Normals point
    away from the crown centre so the whole canopy shades as one soft volume."""
    if kind == 'oak':
        trunk_h, crown_c, rad, n_cl = 0.42, Vector((0, 0, 0.84)), Vector((0.5, 0.5, 0.36)), 11
        greens = [(0.032, 0.07, 0.016), (0.045, 0.088, 0.02), (0.062, 0.1, 0.022), (0.04, 0.078, 0.028)]
    else:  # linden/beech: taller, narrower crown
        trunk_h, crown_c, rad, n_cl = 0.55, Vector((0, 0, 1.0)), Vector((0.38, 0.38, 0.46)), 11
        greens = [(0.045, 0.092, 0.02), (0.06, 0.108, 0.024), (0.078, 0.12, 0.028), (0.052, 0.094, 0.032)]
    tube(m, (0, 0, -0.05), (0, 0, trunk_h), 0.075, 0.05, 7, BARK)

    def col_fn_for(base):
        def f(p):
            h = (p.z - crown_c.z) / rad.z
            c = scale_c(base, 0.8 + 0.35 * max(-0.3, min(1, h * 0.5 + 0.5)))
            n = noise.noise(p * 6.0)
            return mix(c, (0.09, 0.12, 0.03), max(0, n) * 0.4)
        return f

    # points spread over the crown ellipsoid, biased to the surface
    pts = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n_cl):
        zz = 1 - 2 * (i + 0.5) / n_cl
        zz = zz * 0.85 + 0.1
        r = math.sqrt(max(0, 1 - zz * zz))
        a = i * golden + rng.uniform(-0.3, 0.3)
        d = rng.uniform(0.72, 0.95)
        pts.append(crown_c + Vector((math.cos(a) * r * rad.x * d, math.sin(a) * r * rad.y * d, zz * rad.z * d)))
    # a few branches reach out to the lower clusters
    low = sorted(pts, key=lambda p: p.z)[:5]
    for p in low[::1]:
        start = Vector((0, 0, trunk_h * rng.uniform(0.8, 1.0)))
        mid = start.lerp(p, 0.5) + Vector((0, 0, 0.05))
        tube(m, start, mid, 0.036, 0.022, 5, BARK)
        tube(m, mid, p * 0.92 + crown_c * 0.08, 0.022, 0.01, 4, BARK)
    blob(m, crown_c, 1.0, col_fn_for(greens[0]), rng, subdiv=2, squash=tuple(rad * 0.78), rough=0.12, crown=crown_c, crown_w=0.9)
    for i, p in enumerate(pts):
        r = rng.uniform(0.17, 0.23) * (rad.x / 0.5) ** 0.5
        blob(m, p, r, col_fn_for(greens[i % len(greens)]), rng, subdiv=2, squash=(1, 1, 0.8), rough=0.28, crown=crown_c, crown_w=0.85)


def bush(m, rng):
    greens = [(0.04, 0.08, 0.02), (0.055, 0.095, 0.025), (0.07, 0.1, 0.03)]
    center = Vector((0, 0, 0.12))
    n = rng.randint(3, 4)
    for i in range(n):
        a = i / n * TAU + rng.uniform(-0.4, 0.4)
        d = rng.uniform(0.08, 0.16)
        p = center + Vector((math.cos(a) * d, math.sin(a) * d, rng.uniform(-0.02, 0.06)))
        base = greens[i % len(greens)]
        blob(m, p, rng.uniform(0.13, 0.19), lambda q, base=base: scale_c(base, 0.8 + 0.4 * max(0, min(1, q.z / 0.3))), rng,
             subdiv=2, squash=(1, 1, 0.75), rough=0.22, crown=center)
    blob(m, center + Vector((0, 0, 0.08)), 0.16, lambda q: scale_c(greens[1], 1.1), rng, subdiv=2, squash=(1, 1, 0.8), rough=0.2, crown=center)


def dead(m, rng):
    def branch(p, d, length, r, depth):
        end = p + d * length
        tube(m, p, end, r, r * 0.6, 5 if depth < 2 else 4, BARK_GREY)
        if depth >= 3 or length < 0.08:
            return
        for k in range(rng.randint(2, 3)):
            nd = (d + Vector((rng.uniform(-0.9, 0.9), rng.uniform(-0.9, 0.9), rng.uniform(-0.1, 0.5)))).normalized()
            branch(end, nd, length * rng.uniform(0.5, 0.7), r * 0.6, depth + 1)
    # gnarled trunk: a few kinked segments
    p = Vector((0, 0, -0.05))
    d = Vector((0, 0, 1))
    r = 0.07
    for s in range(3):
        d = (d + Vector((rng.uniform(-0.25, 0.25), rng.uniform(-0.25, 0.25), 0))).normalized()
        end = p + d * 0.3
        tube(m, p, end, r, r * 0.8, 6, BARK_GREY)
        if s >= 1:
            nd = (d + Vector((rng.uniform(-1.2, 1.2), rng.uniform(-1.2, 1.2), 0.2))).normalized()
            branch(end, nd, 0.3, r * 0.5, 1)
        p, r = end, r * 0.8
    branch(p, d, 0.25, r, 1)


# --- finishing: normals, AO, export --------------------------------------------------------


def finish(m, name, coll, ao_rays=32, ao_dist=0.45):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in m.v], [], m.f)
    me.update()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    # vertex normals: geometric where no soft target, else the soft target
    geo = [Vector(v.normal) for v in me.vertices]
    normals = [(s if s is not None else g).normalized() for s, g in zip(m.soft, geo)]
    me.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
    # ambient occlusion by ray casting (ground plane at z = 0 occludes too)
    bvh = BVHTree.FromPolygons([tuple(v) for v in m.v], m.f)
    rng = random.Random(5)
    dirs = []
    for i in range(ao_rays):
        u, v = (i + 0.5) / ao_rays, rng.random()
        r, ph = math.sqrt(u), v * TAU
        dirs.append(Vector((r * math.cos(ph), r * math.sin(ph), math.sqrt(max(0, 1 - u)))))
    attr = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, (p, n) in enumerate(zip(m.v, normals)):
        t = n.orthogonal().normalized()
        b = n.cross(t)
        occ = 0
        for d in dirs:
            w = (t * d.x + b * d.y + n * d.z).normalized()
            o = p + n * 0.012
            if w.z < 0 and o.z / -w.z < ao_dist:
                occ += 1
                continue
            hit = bvh.ray_cast(o, w, ao_dist)
            if hit[0] is not None:
                occ += 1
        ao = 1 - occ / len(dirs)
        shade = 0.3 + 0.7 * ao ** 1.2
        c = m.col[i]
        attr.data[i].color = (c[0] * shade, c[1] * shade, c[2] * shade, 1)
    me.color_attributes.active_color = attr
    me.materials.append(_vertex_color_material())
    return ob


def _vertex_color_material():
    mat = bpy.data.materials.get('Vegetation')
    if mat:
        return mat
    mat = bpy.data.materials.new('Vegetation')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.9
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Color'
    nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def preview(objs, path):
    """Renders the models side by side (EEVEE) for a quick visual check."""
    sc = bpy.context.scene
    for i, ob in enumerate(objs):
        ob.location = ((i % 5) * 1.6 - 3.2, (i // 5) * 1.8, 0)
    ground = bpy.data.objects.new('ground', bpy.data.meshes.new('ground'))
    ground.data.from_pydata([(-6, -3, 0), (6, -3, 0), (6, 5, 0), (-6, 5, 0)], [], [(0, 1, 2, 3)])
    gm = bpy.data.materials.new('groundmat')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.12, 0.16, 0.06, 1)
    ground.data.materials.append(gm)
    sc.collection.objects.link(ground)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 4.0
    sun.rotation_euler = (0.9, 0.2, 0.8)
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    cam.data.lens = 40
    cam.location = (0, -9.5, 5.0)
    target = Vector((0, 0.9, 0.5))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.world = sc.world or bpy.data.worlds.new('W')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs[0].default_value = (0.45, 0.55, 0.7, 1)
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 1400, 800
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for ob in objs:
        ob.location = (0, 0, 0)


SPECIES = [
    ('Pine_A', lambda m, r: pine(m, r, H=1.5, tiers=10), 11),
    ('Pine_B', lambda m, r: pine(m, r, H=1.35, tiers=8, spread=1.1), 12),
    ('SnowPine_A', lambda m, r: pine(m, r, H=1.45, tiers=10, snow=True), 13),
    ('SnowPine_B', lambda m, r: pine(m, r, H=1.3, tiers=8, snow=True, spread=1.05), 14),
    ('Oak_A', lambda m, r: broadleaf(m, r, 'oak'), 21),
    ('Oak_B', lambda m, r: broadleaf(m, r, 'linden'), 22),
    ('Bush_A', bush, 31),
    ('Bush_B', bush, 32),
    ('Dead_A', dead, 41),
    ('Dead_B', dead, 42),
]


def build_all():
    lib.clear_startup_scene()
    coll = lib.fresh_collection('Trees')
    objs = []
    for i, (name, fn, seed) in enumerate(SPECIES):
        m = Mesh()
        fn(m, random.Random(seed))
        ob = finish(m, name, coll)
        objs.append(ob)
        print(name, 'tris', sum(len(p.vertices) - 2 for p in ob.data.polygons))
    return objs


if __name__ == '__main__' or True:
    _objs = build_all()
    if os.environ.get('TREES_PREVIEW'):
        preview(_objs, os.environ['TREES_PREVIEW'])
    if globals().get('TREES_EXPORT', True):
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        lib.export_glb(_objs, OUT)
