"""Shared helpers for the procedural asset scripts (castles, trees).

Run inside Blender (tested with 5.2). Geometry is written straight into mesh
data in model space; objects keep identity transforms so Object texture
coordinates equal model coordinates, which the procedural bake shaders rely on.

Blender is Z-up; the glTF exporter turns +Z into +Y and -Y into +Z, so a model's
"front" (-Y here) faces +Z in three.js.
"""
import bpy
import bmesh
import math
from contextlib import contextmanager
from mathutils import Matrix, Euler, Vector, noise

# --- scene / collections -------------------------------------------------------------


def clear_startup_scene():
    """In background runs (blender -b --factory-startup) drop the default cube/light/camera."""
    if not bpy.app.background:
        return
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)


def fresh_collection(name):
    coll = bpy.data.collections.get(name)
    if coll:
        for ob in list(coll.objects):
            me = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if me and me.users == 0:
                bpy.data.meshes.remove(me)
    else:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    return coll


class Builder:
    """Collects parts for one model. Helpers place geometry through a transform stack."""

    def __init__(self, coll, mats):
        self.coll = coll
        self.mats = mats
        self.parts = []
        self.stack = [Matrix.Identity(4)]

    @property
    def M(self):
        return self.stack[-1]

    @contextmanager
    def frame(self, x=0, y=0, z=0, rz=0, rx=0, ry=0, s=1):
        m = Matrix.Translation((x, y, z)) @ Euler((rx, ry, rz)).to_matrix().to_4x4() @ Matrix.Scale(s, 4)
        self.stack.append(self.M @ m)
        try:
            yield
        finally:
            self.stack.pop()

    def emit(self, bm, mat, wave=None):
        """wave: optional fn(local_co) -> 0..1 flag flutter weight (stored as a color attribute)."""
        bmesh.ops.transform(bm, matrix=self.M, verts=bm.verts)
        me = bpy.data.meshes.new('part')
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new('part', me)
        self.coll.objects.link(ob)
        me.materials.append(self.mats[mat])
        attr = me.color_attributes.new('Wave', 'FLOAT_COLOR', 'POINT')
        if wave:
            inv = self.M.inverted()
            for i, v in enumerate(me.vertices):
                w = wave(inv @ v.co)
                attr.data[i].color = (w, w, w, 1)
        else:
            for d in attr.data:
                d.color = (0, 0, 0, 1)
        self.parts.append(ob)
        return ob

    # --- primitives (all bottom-anchored unless noted) --------------------------------

    def box(self, mat, sx, sy, sz, x=0, y=0, z=0, rz=0, rx=0, ry=0):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
        bmesh.ops.translate(bm, vec=(0, 0, sz / 2), verts=bm.verts)
        _place(bm, x, y, z, rx, ry, rz)
        return self.emit(bm, mat)

    def cyl(self, mat, r1, r2, h, seg=12, x=0, y=0, z=0, rz=0, rx=0, ry=0, cap=True):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=seg, radius1=r1, radius2=max(r2, 0.0), depth=h)
        bmesh.ops.translate(bm, vec=(0, 0, h / 2), verts=bm.verts)
        if r2 <= 0:
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        _place(bm, x, y, z, rx, ry, rz)
        return self.emit(bm, mat)

    def cone(self, mat, r, h, seg=12, x=0, y=0, z=0, rz=0):
        return self.cyl(mat, r, 0, h, seg, x, y, z, rz)

    def pyramid(self, mat, sx, sy, h, x=0, y=0, z=0, rz=0, apex=0.0):
        """Hip/pyramid roof over an sx*sy rectangle; apex>0 gives a short ridge."""
        bm = bmesh.new()
        hx, hy = sx / 2, sy / 2
        a = min(apex, sx) / 2
        v = [bm.verts.new(p) for p in [(-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0), (-a, 0, h), (a, 0, h)]]
        if a > 1e-4:
            faces = [(0, 1, 5, 4), (1, 2, 5), (2, 3, 4, 5), (3, 0, 4), (3, 2, 1, 0)]
        else:
            bm.verts.remove(v[5])
            v = v[:5]
            faces = [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (3, 2, 1, 0)]
        for f in faces:
            bm.faces.new([v[i] for i in f])
        _place(bm, x, y, z, 0, 0, rz)
        return self.emit(bm, mat)

    def gable(self, mat, length, span, h, x=0, y=0, z=0, rz=0, thick=0.025):
        """Gabled roof, ridge along local X. Built as two slabs so eaves read as a real roof."""
        bm = bmesh.new()
        hl, hs = length / 2, span / 2
        pts = [(-hs, 0), (0, h), (hs, 0), (hs - thick * 0.6, -thick), (0, h - thick * 1.4), (-hs + thick * 0.6, -thick)]
        front = [bm.verts.new((-hl, y2, z2)) for y2, z2 in pts]
        back = [bm.verts.new((hl, y2, z2)) for y2, z2 in pts]
        bm.faces.new(front[::-1])
        bm.faces.new(back)
        for i in range(6):
            j = (i + 1) % 6
            bm.faces.new((front[i], front[j], back[j], back[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        _place(bm, x, y, z, 0, 0, rz)
        return self.emit(bm, mat)

    def gable_wall(self, mat, width, h, x=0, y=0, z=0, rz=0, depth=0.02):
        """Triangular gable end (in local XZ plane, extruded along Y)."""
        bm = bmesh.new()
        hw, hd = width / 2, depth / 2
        f = [bm.verts.new(p) for p in [(-hw, -hd, 0), (hw, -hd, 0), (0, -hd, h)]]
        b = [bm.verts.new(p) for p in [(-hw, hd, 0), (hw, hd, 0), (0, hd, h)]]
        bm.faces.new(f)
        bm.faces.new(b[::-1])
        for i in range(3):
            j = (i + 1) % 3
            bm.faces.new((f[j], f[i], b[i], b[j]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        _place(bm, x, y, z, 0, 0, rz)
        return self.emit(bm, mat)

    def beam(self, mat, a, b, t=0.022):
        """Square beam between two local points."""
        a, b = Vector(a), Vector(b)
        d = b - a
        L = d.length
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.scale(bm, vec=(t, t, L), verts=bm.verts)
        bmesh.ops.translate(bm, vec=(0, 0, L / 2), verts=bm.verts)
        rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
        bmesh.ops.transform(bm, matrix=Matrix.Translation(a) @ rot, verts=bm.verts)
        return self.emit(bm, mat)

    def flag(self, mat, w, h, x=0, y=0, z=0, rz=0, pennant=False, segs=8):
        """Cloth attached along its local -X edge at (x, y, z..z+h), flying toward +X.
        Carries a 'Wave' weight (0 at the pole, 1 at the free end) for the flutter shader."""
        bm = bmesh.new()
        rows = []
        for i in range(segs + 1):
            u = i / segs
            hh = h * (1 - u * 0.92) if pennant else h
            zc = h / 2
            # a slight static droop and curl so still frames don't look like cardboard
            dy = math.sin(u * math.pi * 1.5) * 0.02 * w
            rows.append((bm.verts.new((u * w, dy, zc - hh / 2 - u * u * 0.08 * h)), bm.verts.new((u * w, dy, zc + hh / 2 - u * u * 0.08 * h))))
        for i in range(segs):
            bm.faces.new((rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]))
        _place(bm, x, y, z, 0, 0, rz)
        return self.emit(bm, mat, wave=lambda co, x=x, y=y, rz=rz, w=w: _flag_u(co, x, y, rz, w))

    def banner(self, mat, w, h, x=0, y=0, z=0, rz=0, notch=True):
        """Vertical hanging banner (top edge at z), facing local -Y. Swallow-tail bottom."""
        bm = bmesh.new()
        hw = w / 2
        pts = [(-hw, 0, 0), (hw, 0, 0), (hw, 0, -h), (0, 0, -h + (w * 0.45 if notch else 0)), (-hw, 0, -h)]
        bm.faces.new([bm.verts.new(p) for p in pts])
        _place(bm, x, y, z, 0, 0, rz)
        return self.emit(bm, mat)

    # --- compound pieces ---------------------------------------------------------------

    def merlons(self, mat, a, b, z, h=0.08, t=0.06, pitch=0.13, w=None):
        a, b = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
        d = b - a
        L = d.length
        n = max(1, int(L / pitch))
        w = w or pitch * 0.55
        ang = math.atan2(d.y, d.x)
        for i in range(n):
            c = a + d * ((i + 0.5) / n)
            self.box(mat, w, t, h, c.x, c.y, z, rz=ang)

    def merlon_ring(self, mat, r, z, h=0.08, t=0.06, count=10, w=None):
        w = w or (2 * math.pi * r / count) * 0.55
        for i in range(count):
            a = (i + 0.5) / count * 2 * math.pi
            self.box(mat, w, t, h, math.cos(a) * r, math.sin(a) * r, z, rz=a + math.pi / 2)

    def corbel_ring(self, mat, r, z, count=14, s=0.035):
        for i in range(count):
            a = i / count * 2 * math.pi
            self.box(mat, s, s * 1.4, s * 1.6, math.cos(a) * r, math.sin(a) * r, z, rz=a + math.pi / 2)

    def window(self, mat, x, y, z, rz, w=0.05, h=0.08, arch=True):
        """Dark window/slit on a wall whose outward normal is local -Y after rz."""
        self.box(mat, w, 0.02, h, x, y, z, rz=rz)

    # --- ruins and wilderness ------------------------------------------------------------

    def rock(self, mat, sx, sy, sz, x=0, y=0, z=0, rz=0, rx=0, ry=0, seed=0, rough=0.28, subdiv=2, flat_bottom=True):
        """Irregular boulder: a noise-displaced icosphere of radii (sx, sy, sz), centred at z."""
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
        off = Vector((seed * 7.31, seed * 3.17, seed * 5.53))
        for v in bm.verts:
            d = v.co.normalized()
            n = noise.noise(d * 1.6 + off) * 0.7 + noise.noise(d * 3.7 + off * 2.0) * 0.3
            f = 1 + n * rough * 2.0
            # flatten into facets a little so it reads as rock, not a blob
            v.co = Vector((d.x * sx * f, d.y * sy * f, d.z * sz * f))
            if flat_bottom and v.co.z < -sz * 0.35:
                v.co.z = -sz * 0.35 - (v.co.z + sz * 0.35) * 0.15
        _place(bm, x, y, z, rx, ry, rz)
        return self.emit(bm, mat)

    def ragged_wall(self, mat, length, thick, heights, x=0, y=0, z=0, rz=0, jitter=0.0, seed=0):
        """Wall along local X, centred, whose top follows `heights` (one per column edge).
        Stepped, broken tops read as ruined masonry."""
        bm = bmesh.new()
        n = len(heights) - 1
        ht = thick / 2
        cols = []
        for i, hgt in enumerate(heights):
            u = -length / 2 + length * i / n
            j = (noise.noise(Vector((u * 3.1, seed, 0.3))) * jitter) if jitter else 0.0
            cols.append([bm.verts.new(p) for p in [(u, -ht + j, 0), (u, ht + j, 0), (u, ht + j, max(0.01, hgt)), (u, -ht + j, max(0.01, hgt))]])
        bm.faces.new(cols[0][::-1])
        bm.faces.new(cols[-1])
        for i in range(n):
            a, b = cols[i], cols[i + 1]
            for q in range(4):
                r = (q + 1) % 4
                bm.faces.new((a[q], b[q], b[r], a[r]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        _place(bm, x, y, z, 0, 0, rz)
        return self.emit(bm, mat)

    def ring_wall(self, mat, r, thick, heights, x=0, y=0, z=0, a0=0.0):
        """Round wall built from len(heights) curved blocks with individual tops.
        A height <= 0 leaves a breach."""
        n = len(heights)
        for i, hgt in enumerate(heights):
            if hgt <= 0:
                continue
            bm = bmesh.new()
            aa, ab = a0 + i / n * math.tau, a0 + (i + 1) / n * math.tau
            ro, ri = r, r - thick
            pts = []
            for a in (aa, ab):
                c, s = math.cos(a), math.sin(a)
                pts.append([(ro * c, ro * s), (ri * c, ri * s)])
            v = []
            for zz in (0, hgt):
                for (po, pi) in pts:
                    v.append(bm.verts.new((po[0], po[1], zz)))
                    v.append(bm.verts.new((pi[0], pi[1], zz)))
            # v: 0 aOut0 1 aIn0 2 bOut0 3 bIn0 4 aOutH 5 aInH 6 bOutH 7 bInH
            for f in [(0, 2, 6, 4), (3, 1, 5, 7), (1, 0, 4, 5), (2, 3, 7, 6), (4, 6, 7, 5), (0, 1, 3, 2)]:
                bm.faces.new([v[k] for k in f])
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            _place(bm, x, y, z, 0, 0, 0)
            self.emit(bm, mat)

    def rubble(self, mat, rng, cx, cy, radius, count, size=0.06, z=0.0):
        """Scattered fallen blocks around (cx, cy)."""
        for _ in range(count):
            a = rng.uniform(0, math.tau)
            d = radius * math.sqrt(rng.random())
            s = size * rng.uniform(0.6, 1.4)
            self.box(mat, s * rng.uniform(1.0, 1.8), s, s * rng.uniform(0.6, 1.0),
                     cx + math.cos(a) * d, cy + math.sin(a) * d, z - s * 0.2,
                     rz=rng.uniform(0, math.tau), rx=rng.uniform(-0.3, 0.3), ry=rng.uniform(-0.3, 0.3))


def _place(bm, x, y, z, rx, ry, rz):
    m = Matrix.Translation((x, y, z)) @ Euler((rx, ry, rz)).to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts)


def _flag_u(co, x, y, rz, w):
    # co is in the builder's current frame; project onto the flag's own axis
    dx, dy = co.x - x, co.y - y
    u = (dx * math.cos(rz) + dy * math.sin(rz)) / w
    return max(0.0, min(1.0, u))


# --- joining, UVs, baking, export ---------------------------------------------------------


def join(parts, name):
    ctx = bpy.context
    for ob in ctx.selected_objects:
        ob.select_set(False)
    for ob in parts:
        ob.select_set(True)
    ctx.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = ctx.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    # merge duplicate material slots
    uniq, remap = [], []
    for slot in ob.material_slots:
        m = slot.material
        if m not in uniq:
            uniq.append(m)
        remap.append(uniq.index(m))
    idx = [remap[p.material_index] for p in ob.data.polygons]
    ob.data.materials.clear()
    for m in uniq:
        ob.data.materials.append(m)
    for p, i in zip(ob.data.polygons, idx):
        p.material_index = i
    return ob


def drop_bottom_faces(ob, limit=-0.95):
    """Removes faces pointing straight down; the camera never sees them and they
    would otherwise take up atlas space."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    dead = [f for f in bm.faces if f.normal.z < limit]
    bmesh.ops.delete(bm, geom=dead, context='FACES_ONLY')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(ob.data)
    bm.free()


def smart_uv(ob, margin=0.003):
    ctx = bpy.context
    for o in ctx.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    ctx.view_layer.objects.active = ob
    if not ob.data.uv_layers:
        ob.data.uv_layers.new(name='UVMap')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def setup_cycles(samples=24):
    """CPU by default: Cycles' Metal kernel loading crashes intermittently on Blender 5.2
    (NSException in ShaderCache::load_kernel). Set BAKE_GPU=1 to try the GPU anyway."""
    import os
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    if os.environ.get('BAKE_GPU'):
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.refresh_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False


def bake_emit(ob, image, margin=6):
    """Bakes each material's Emission output into `image` (materials must contain an
    active Image Texture node named 'BakeTarget')."""
    for slot in ob.material_slots:
        nt = slot.material.node_tree
        node = nt.nodes['BakeTarget']
        node.image = image
        nt.nodes.active = node
    ctx = bpy.context
    for o in ctx.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    ctx.view_layer.objects.active = ob
    sc = ctx.scene
    sc.render.bake.margin = margin
    sc.render.bake.use_clear = True
    sc.render.bake.target = 'IMAGE_TEXTURES'
    bpy.ops.object.bake(type='EMIT')


def export_glb(objects, path, jpeg_quality=88):
    ctx = bpy.context
    for o in ctx.selected_objects:
        o.select_set(False)
    for o in objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True,
        export_texcoords=True, export_normals=True, export_vertex_color='ACTIVE',
        export_all_vertex_colors=False, export_image_format='JPEG', export_image_quality=jpeg_quality,
        export_materials='EXPORT', export_yup=True, export_cameras=False, export_lights=False,
    )


# --- procedural bake materials ---------------------------------------------------------------
#
# Every material outputs Emission = albedo * ambient occlusion * ground grime, which
# is baked into one texture atlas per model. Patterns use Object coordinates so they
# stay continuous across parts. Vertical surfaces use (x + y, z) as their 2D pattern
# space, which reads correctly on walls facing either axis.

class NodeKit:
    def __init__(self, nt):
        self.nt = nt
        self.x = 0

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        n.location = (self.x, 0)
        self.x += 180
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def math(self, op, a, b=None, c=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self._in(n.inputs[0], a)
        if b is not None:
            self._in(n.inputs[1], b)
        if c is not None:
            self._in(n.inputs[2], c)
        return n.outputs[0]

    def vmath(self, op, a, b=None):
        n = self.node('ShaderNodeVectorMath', operation=op)
        self._in(n.inputs[0], a)
        if b is not None:
            self._in(n.inputs[1], b)
        return n.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        self._in(n.inputs['Factor'], fac)
        self._in(n.inputs[6], a)
        self._in(n.inputs[7], b)
        return n.outputs[2]

    def combine(self, x, y, z):
        n = self.node('ShaderNodeCombineXYZ')
        for i, v in enumerate((x, y, z)):
            self._in(n.inputs[i], v)
        return n.outputs[0]

    def noise(self, vec, scale, detail=3.0, rough=0.55, dim='3D'):
        n = self.node('ShaderNodeTexNoise', noise_dimensions=dim)
        self._in(n.inputs['Vector'], vec)
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        return n.outputs['Fac']

    def ramp(self, fac, stops):
        n = self.node('ShaderNodeValToRGB')
        self._in(n.inputs['Fac'], fac)
        el = n.color_ramp.elements
        while len(el) > len(stops):
            el.remove(el[-1])
        while len(el) < len(stops):
            el.new(0.5)
        for e, (pos, col) in zip(el, stops):
            e.position = pos
            e.color = (*col, 1)
        return n.outputs['Color']

    def brick(self, vec, c1, c2, mortar, width, height, msize=0.004, bias=0.0, offset=0.5):
        n = self.node('ShaderNodeTexBrick', offset=offset, offset_frequency=2)
        self._in(n.inputs['Vector'], vec)
        n.inputs['Color1'].default_value = (*c1, 1)
        n.inputs['Color2'].default_value = (*c2, 1)
        n.inputs['Mortar'].default_value = (*mortar, 1)
        n.inputs['Scale'].default_value = 1.0
        n.inputs['Mortar Size'].default_value = msize
        n.inputs['Mortar Smooth'].default_value = 0.3
        n.inputs['Bias'].default_value = bias
        n.inputs['Brick Width'].default_value = width
        n.inputs['Row Height'].default_value = height
        return n.outputs['Color'], n.outputs['Fac']

    def voronoi_edge(self, vec, scale):
        n = self.node('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE')
        self._in(n.inputs['Vector'], vec)
        n.inputs['Scale'].default_value = scale
        return n.outputs['Distance']

    def _in(self, sock, v):
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, tuple):
            sock.default_value = (*v, 1) if len(v) == 3 and len(sock.default_value) == 4 else v
        else:
            self.link(v, sock)


def bake_material(name, pattern, ao_distance=0.22, ao_strength=0.72, grime=0.28, rough=0.85):
    """pattern(kit, co, pxy) -> albedo socket. co: object-space vector, pxy: (x+y, z, 0) wall space."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    k = NodeKit(nt)
    tc = k.node('ShaderNodeTexCoord')
    co = tc.outputs['Object']
    sep = k.node('ShaderNodeSeparateXYZ')
    k.link(co, sep.inputs[0])
    xy = k.math('ADD', sep.outputs[0], sep.outputs[1])
    pxy = k.combine(xy, sep.outputs[2], 0.0)
    albedo = pattern(k, co, pxy, sep)
    ao = k.node('ShaderNodeAmbientOcclusion', samples=24, only_local=False)
    ao.inputs['Distance'].default_value = ao_distance
    aof = k.math('MULTIPLY_ADD', ao.outputs['AO'], ao_strength, 1 - ao_strength)
    aof = k.math('POWER', aof, 1.3)
    # grime toward the ground
    g = k.math('MULTIPLY', sep.outputs[2], 1 / 0.3)
    g = k.math('MINIMUM', g, 1.0)
    g = k.math('MAXIMUM', g, 0.0)
    g = k.math('MULTIPLY_ADD', g, grime, 1 - grime)
    shade = k.math('MULTIPLY', aof, g)
    col = k.mix(1.0, albedo, k.combine(shade, shade, shade), blend='MULTIPLY')
    em = k.node('ShaderNodeEmission')
    k.link(col, em.inputs['Color'])
    out = k.node('ShaderNodeOutputMaterial')
    k.link(em.outputs[0], out.inputs['Surface'])
    tgt = k.node('ShaderNodeTexImage')
    tgt.name = 'BakeTarget'
    mat['rough'] = rough
    return mat


def export_material(name, image, rough=0.85, color=(1, 1, 1), double_sided=False):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = image
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    mat.use_backface_culling = not double_sided
    return mat


# --- shared pipeline for baked model sets (bridges, ruins, shrines) --------------------------------


def _bake_ground(coll, loc, size=4.0):
    me = bpy.data.meshes.new('bake_ground')
    me.from_pydata([(-size, -size, 0), (size, -size, 0), (size, size, 0), (-size, size, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new('bake_ground', me)
    ob.location = loc
    coll.objects.link(ob)
    mat = bpy.data.materials.get('bake_groundmat') or bpy.data.materials.new('bake_groundmat')
    me.materials.append(mat)
    return ob


def build_baked(specs, mats, coll_name, atlas=1024, bake=True, spacing=8.0, ground=True, samples=24):
    """specs: [(object name, fn(builder, rng), seed)]. Each model is joined, UV-unwrapped
    and baked into its own atlas. Materials whose name contains 'glow' end up in a
    separate `<name>_Glow` material (emissive at runtime), everything else in `<name>_Base`."""
    import random
    clear_startup_scene()
    coll = fresh_collection(coll_name)
    setup_cycles(samples=samples)
    out = []
    for idx, (name, fn, seed) in enumerate(specs):
        b = Builder(coll, mats)
        fn(b, random.Random(seed))
        ob = join(b.parts, name)
        drop_bottom_faces(ob)
        ob.data.color_attributes.active_color = ob.data.color_attributes['Wave']
        ob.location = ((idx % 4) * spacing, (idx // 4) * spacing, 0)
        smart_uv(ob, margin=0.004)
        if bake:
            g = _bake_ground(coll, ob.location) if ground else None
            img = bpy.data.images.get(name + '_atlas') or bpy.data.images.new(name + '_atlas', atlas, atlas)
            img.scale(atlas, atlas)
            bake_emit(ob, img)
            if g:
                bpy.data.objects.remove(g, do_unlink=True)
            _split_roles(ob, name, img)
        print(name, 'tris', sum(len(p.vertices) - 2 for p in ob.data.polygons), flush=True)
        out.append(ob)
    return out


def _split_roles(ob, name, img):
    base = export_material(name + '_Base', img, rough=0.88)
    glow = export_material(name + '_Glow', img, rough=0.5)
    idx = [1 if 'glow' in ob.material_slots[p.material_index].material.name else 0 for p in ob.data.polygons]
    ob.data.materials.clear()
    ob.data.materials.append(base)
    if any(idx):
        ob.data.materials.append(glow)
    for p, i in zip(ob.data.polygons, idx):
        p.material_index = i


def export_set(objs, path, jpeg_quality=86):
    import os
    locs = [tuple(o.location) for o in objs]
    for o in objs:
        o.location = (0, 0, 0)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    export_glb(objs, path, jpeg_quality=jpeg_quality)
    for o, l in zip(objs, locs):
        o.location = l


def preview(objs, path, cols=4, cell=3.0, res=(1600, 900), cam_dist=None):
    """Quick EEVEE render of the models laid out on a grid (camera from the south, like the game)."""
    sc = bpy.context.scene
    rows = (len(objs) + cols - 1) // cols
    for i, ob in enumerate(objs):
        ob.location = ((i % cols - (cols - 1) / 2) * cell, (rows - 1 - i // cols) * cell, 0)
    W, H = cols * cell / 2 + 1, rows * cell / 2 + 1
    ground = bpy.data.objects.new('pv_ground', bpy.data.meshes.new('pv_ground'))
    ground.data.from_pydata([(-W - 2, -3, 0), (W + 2, -3, 0), (W + 2, rows * cell + 2, 0), (-W - 2, rows * cell + 2, 0)], [], [(0, 1, 2, 3)])
    gm = bpy.data.materials.get('pv_groundmat') or bpy.data.materials.new('pv_groundmat')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.1, 0.13, 0.05, 1)
    ground.data.materials.append(gm)
    sc.collection.objects.link(ground)
    sun = bpy.data.objects.new('pv_sun', bpy.data.lights.new('pv_sun', 'SUN'))
    sun.data.energy = 4.0
    sun.rotation_euler = (0.85, 0.15, 0.6)
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('pv_cam', bpy.data.cameras.new('pv_cam'))
    sc.collection.objects.link(cam)
    cam.data.lens = 50
    d = cam_dist or max(W * 2.2, rows * cell * 1.6)
    target = Vector((0, (rows - 1) * cell / 2, 0.4))
    cam.location = target + Vector((0, -d * 0.8, d * 0.62))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.world = sc.world or bpy.data.worlds.new('W')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs[0].default_value = (0.5, 0.6, 0.75, 1)
    sc.world.node_tree.nodes['Background'].inputs[1].default_value = 0.8
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for ob in (ground, sun, cam):
        bpy.data.objects.remove(ob, do_unlink=True)
