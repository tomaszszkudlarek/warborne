"""Builds castles.glb and ports.glb from Meshy AI models (tools/meshy/<name>/).

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_meshy_structures.py
    (env ONLY=castles|ports builds one file, TEX=<px> sets the texture size
     (default 1024, 0 keeps Meshy's 2048), PREVIEW=/path.png renders a check image)

Sources, each one Meshy image-to-3d task (meshy-7, PBR) from concept.png:
    castle_l1/  palisade fort on an earth mound      -> Castle_L1
    castle_l2/  timber burgh with a half-timbered keep -> Castle_L2
    castle_l3/  stone castle with a great keep       -> Castle_L3
    port/       stone quay, warehouse, crane, pier   -> Port
    ship/       the cog units sail in at sea          -> Ship
    barge/ boneship/ greatship/ warship/ waterelemental/
                faction boats (Heroes.js FACTION_BOATS)  -> Boat_<Name>
    banner/     army war banner (ONLY=banner)         -> units/banner.glb
    site_<type>/ special sites (ONLY=specials)        -> specials.glb Site_<Type>:
                mine, stables, smithy, weaponmaster, barracks, ranger (src/game/specials.js)
    ruin_<type>/ shrine_<type>/ map sites (ONLY=sites) -> sites.glb Ruin_<Type> / Shrine_<Type>
                (SiteTypes in src/generator/terrainTypes.js); braziers, runes and crystals
                go to <Name>_Glow, which the game lights with a slow pulse

Castles keep the contract of build_castles.py: ground at z = 0, gatehouse toward -Y
(+Z in three.js), footprint about 2 units from the centre (the game rescales it to
fill the city's 2x2 tiles). Their royal-blue roofs and banners go to L<n>_Accent,
tinted per owner. There is no L<n>_Flag: the flags are fused into the mesh, so they
take the faction colour but don't flutter.

Port keeps build_ports.py's: origin on the quay edge at sea level, quay on land
toward +Y with its top at QUAY_TOP (PORT_QUAY in src/generator/ports.js), pier out
over the water toward -Y.

Banner: pole on the Z axis from z = 0 up, BANNER_HEIGHT tall, cloth toward -Y (+Z in
three.js) in its own mesh Banner_Flag, whose vertex colour red is the flutter weight
(0 at the pole, 1 at the free edge); the game turns the banner downwind and tints
the cloth (Banner_Flag material) in the owner's colour.

Ship keeps build_ports.py's cog contract: bow toward -Y, waterline at z = 0, about
SHIP_LENGTH long. Its royal-blue sail goes to Ship_Accent, tinted per owner.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import meshy_lib  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
MESHY = os.path.join(ROOT, 'tools', 'meshy')
MODELS = os.path.join(ROOT, 'public', 'models')
TEX = int(os.environ.get('TEX', '1024'))

CASTLE_HALF = 1.95  # footprint half-extent before the game's own fit
CASTLE_SINK = 0.1   # base below ground so it sits into uneven terrain
ACCENT_SHARE = float(os.environ.get('ACCENT_SHARE', '0.25'))  # roofs span blue and trim texels
# yaw (deg) that turns each model's gate to -Y; Meshy put L1's on +X
# (the first set, castle_l1..3, was replaced 2026-09-25 by castle2_l1..3: broader, with lit
# windows and torches that go to L<n>_Glow)
CASTLES = [('castle2_l1', 'L1', 0), ('castle2_l2', 'L2', 0), ('castle2_l3', 'L3', 0)]

QUAY_TOP = 0.32
PORT_SCALE = 1.6  # quay ~1.66 wide x 1.46 deep, pier ~1.6 long

BANNER_HEIGHT = 3.0

# special sites: one tile (2 units) each, ground at z = 0, centred; front toward -Y.
# Their royal-blue pennants go to Site_<Type>_Accent, tinted per owner.
SITE_HALF = 0.92
SITE_SINK = 0.06
SITE_TEX = 1024
SPECIALS = [('site_mine', 'Site_Mine', 0), ('site_stables', 'Site_Stables', 0), ('site_smithy', 'Site_Smithy', 0),
            ('site_weaponmaster', 'Site_Weaponmaster', 0), ('site_barracks', 'Site_Barracks', 0), ('site_ranger', 'Site_Ranger', 0)]

# ruins and shrines (sites.glb): same contract as the special sites, no faction accent.
# (source, object name, yaw that turns the entrance to -Y, glow kind of meshy_lib.glow_mask)
# (the tower's portal runes came out near-white: no glow found, it stays a dead ruin)
MAP_SITES = [('ruin_tower', 'Ruin_Tower', 0, 'violet'), ('ruin_cave', 'Ruin_Cave', 0, 'palegreen'),
             ('ruin_dungeon', 'Ruin_Dungeon', 0, 'palegreen'), ('ruin_temple', 'Ruin_Temple', 0, 'violet'),
             ('ruin_crypt', 'Ruin_Crypt', 0, 'palegreen'), ('shrine_circle', 'Shrine_Circle', 0, 'paleblue'),
             ('shrine_temple', 'Shrine_Temple', 0, False), ('shrine_obelisk', 'Shrine_Obelisk', 0, 'violet')]

SHIP_YAW = 90       # Meshy put the bow on -X
SHIP_LENGTH = 1.75  # stem to sternpost, as the procedural cog
SHIP_DRAFT = 0.13   # keel below the waterline
# faction boats, same contract as the ship: source, object name, yaw that turns the
# bow to -Y, length stem to stern, keel below the waterline
BOAT_TEX = 512
BOAT_DECIMATE = 0.4
BOATS = [('barge', 'Boat_Barge', 90, 1.6, 0.08), ('boneship', 'Boat_Boneship', 90, 1.9, 0.13),
         ('greatship', 'Boat_Greatship', -90, 2.2, 0.16), ('warship', 'Boat_Warship', 90, 2.2, 0.1),
         # the living wave carries its army in its curl, which leans forward
         ('waterelemental', 'Boat_WaterElemental', 180, 1.5, 0.15)]


def import_model(name):
    before = {o.name for o in bpy.data.objects}
    bpy.ops.import_scene.gltf(filepath=os.path.join(MESHY, name, 'model_static.glb'))
    new = [o for o in bpy.data.objects if o.name not in before]
    meshes = [o for o in new if o.type == 'MESH']
    assert len(meshes) == 1, f'{name}: expected one mesh, got {len(meshes)}'
    ob = meshes[0]
    # bake the importer's Y-up conversion into the vertices, drop its empties
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


def place(ob, yaw, scale, offset):
    """v' = Rz(yaw) * scale * v + offset, applied to the mesh data."""
    m = Matrix.Translation(offset) @ Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Scale(scale, 4)
    ob.data.transform(m)
    ob.data.update()


def build_castle(src, tag, yaw):
    ob = import_model(src)
    place(ob, yaw, 1, (0, 0, 0))
    co = coords(ob)
    lo, hi = co.min(0), co.max(0)
    s = CASTLE_HALF / max((hi[:2] - lo[:2]) / 2)
    place(ob, 0, s, (0, 0, 0))
    c = (lo + hi) / 2 * s
    place(ob, 0, 1, (-c[0], -c[1], -lo[2] * s - CASTLE_SINK))
    ob.name = f'Castle_{tag}'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, src), tag, share=ACCENT_SHARE, metallic=False, glow='fire')
    meshy_lib.emissive_lights(ob, tag)
    co = coords(ob)
    print(f'{ob.name}: {len(ob.data.polygons)} faces, x {co[:, 0].min():.2f}..{co[:, 0].max():.2f} '
          f'y {co[:, 1].min():.2f}..{co[:, 1].max():.2f} z {co[:, 2].min():.2f}..{co[:, 2].max():.2f}', flush=True)
    return ob


def build_special(src, name, yaw, glow=None):
    ob = import_model(src)
    place(ob, yaw, 1, (0, 0, 0))
    co = coords(ob)
    lo, hi = co.min(0), co.max(0)
    sc = SITE_HALF / max((hi[:2] - lo[:2]) / 2)
    c = (lo + hi) / 2 * sc
    place(ob, 0, sc, (-c[0], -c[1], -lo[2] * sc - SITE_SINK))
    ob.name = name
    if glow is None:
        meshy_lib.pbr_materials(ob, os.path.join(MESHY, src), name, share=0.35, metallic=False, glow=src == 'site_smithy')
    else:
        meshy_lib.pbr_materials(ob, os.path.join(MESHY, src), name, accent=False, metallic=False, glow=glow)
    co = coords(ob)
    print(f'{name}: {len(ob.data.polygons)} faces, x {co[:, 0].min():.2f}..{co[:, 0].max():.2f} '
          f'y {co[:, 1].min():.2f}..{co[:, 1].max():.2f} z {co[:, 2].min():.2f}..{co[:, 2].max():.2f}', flush=True)
    return ob


def quay_top(ob, edge):
    """Height of the paved quay: the most common height of upward faces behind the edge."""
    me = ob.data
    n = len(me.polygons)
    cen, nor, area = np.empty(n * 3, np.float32), np.empty(n * 3, np.float32), np.empty(n, np.float32)
    me.polygons.foreach_get('center', cen)
    me.polygons.foreach_get('normal', nor)
    me.polygons.foreach_get('area', area)
    cen, nor = cen.reshape(-1, 3), nor.reshape(-1, 3)
    sel = (nor[:, 2] > 0.95) & (cen[:, 1] > edge + 0.05)
    hist, bins = np.histogram(cen[sel, 2], bins=400, weights=area[sel])
    k = hist.argmax()
    return (bins[k] + bins[k + 1]) / 2


def build_port():
    ob = import_model('port')
    co = coords(ob)
    # the pier is the narrow part; the quay's seaward face is where the wide part starts
    edge = co[np.abs(co[:, 0]) > 0.6 * np.abs(co[:, 0]).max(), 1].min()
    top = quay_top(ob, edge)
    place(ob, 0, PORT_SCALE, (0, 0, 0))
    place(ob, 0, 1, (-(co[:, 0].min() + co[:, 0].max()) / 2 * PORT_SCALE, -edge * PORT_SCALE,
                     QUAY_TOP - top * PORT_SCALE))
    ob.name = 'Port'
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, 'port'), 'Port', accent=False, metallic=False)
    co = coords(ob)
    print(f'Port: {len(ob.data.polygons)} faces, quay edge y={edge:.3f} top z={top:.3f} (Meshy units); '
          f'x {co[:, 0].min():.2f}..{co[:, 0].max():.2f} y {co[:, 1].min():.2f}..{co[:, 1].max():.2f} '
          f'z {co[:, 2].min():.2f}..{co[:, 2].max():.2f}', flush=True)
    return ob


def build_ship(src='ship', name='Ship', yaw=SHIP_YAW, length=SHIP_LENGTH, draft=SHIP_DRAFT):
    ob = import_model(src)
    place(ob, yaw, 1, (0, 0, 0))
    co = coords(ob)
    lo, hi = co.min(0), co.max(0)
    s = length / (hi[1] - lo[1])
    place(ob, 0, s, (-(lo[0] + hi[0]) / 2 * s, -(lo[1] + hi[1]) / 2 * s, -lo[2] * s - draft))
    ob.name = name
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, src), name, metallic=False)
    co = coords(ob)
    print(f'{name}: {len(ob.data.polygons)} faces, x {co[:, 0].min():.2f}..{co[:, 0].max():.2f} '
          f'y {co[:, 1].min():.2f}..{co[:, 1].max():.2f} z {co[:, 2].min():.2f}..{co[:, 2].max():.2f}', flush=True)
    return ob


def build_banner():
    ob = import_model('banner')
    co = coords(ob)
    lo, hi = co.min(0), co.max(0)
    H = hi[2] - lo[2]
    # the pole alone below the cloth gives the axis; the cloth sticks out to one side
    low = co[co[:, 2] < lo[2] + 0.3 * H]
    ax = np.median(low[:, :2], axis=0)
    rp = np.percentile(np.linalg.norm(low[:, :2] - ax, axis=1), 90)
    r = np.linalg.norm(co[:, :2] - ax, axis=1)
    far = co[r > 0.5 * r.max(), :2] - ax
    ang = math.atan2(far[:, 1].mean(), far[:, 0].mean())
    place(ob, 0, 1, (-ax[0], -ax[1], -lo[2]))
    place(ob, math.degrees(-math.pi / 2 - ang), BANNER_HEIGHT / H, (0, 0, 0))
    meshy_lib.pbr_materials(ob, os.path.join(MESHY, 'banner'), 'Banner', metallic=False)
    # cloth: faces clear of the pole (rings and finial stay with it)
    me = ob.data
    n = len(me.polygons)
    cen = np.empty(n * 3, np.float32)
    me.polygons.foreach_get('center', cen)
    cen = cen.reshape(-1, 3)
    cut = max(3 * rp, 0.03 * H) * BANNER_HEIGHT / H
    me.polygons.foreach_set('material_index', (np.hypot(cen[:, 0], cen[:, 1]) > cut).astype(np.int32))
    me.materials[1].name = 'Banner_Flag'
    me.update()
    ob.name = 'Banner'
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.mesh.separate(type='MATERIAL')
    bpy.ops.object.mode_set(mode='OBJECT')
    # separate() doesn't say which half keeps the original object: go by material
    parts = list(bpy.context.selected_objects)

    def used(o):
        return o.data.materials[o.data.polygons[0].material_index].name
    flag = next(o for o in parts if used(o) == 'Banner_Flag')
    ob = next(o for o in parts if o.name != flag.name)
    ob.name = 'Banner'
    flag.name = 'Banner_Flag'
    for o, keep in ((ob, 'Banner_Base'), (flag, 'Banner_Flag')):
        while len(o.data.materials) > 1:  # separate() may keep both slots
            i = next(k for k, m in enumerate(o.data.materials) if m.name != keep)
            o.data.materials.pop(index=i)
    # flutter weight: distance from the pole along the cloth
    fc = coords(flag)
    w = np.clip(-fc[:, 1] / max(-fc[:, 1].min(), 1e-6), 0, 1)
    attr = flag.data.color_attributes.new('aWave', 'FLOAT_COLOR', 'POINT')
    rgba = np.zeros((len(fc), 4), np.float32)
    rgba[:, 0] = w
    rgba[:, 3] = 1
    attr.data.foreach_set('color', rgba.ravel())
    flag.data.color_attributes.active_color = attr
    co = coords(ob)
    print(f'Banner: pole {len(ob.data.polygons)} faces, cloth {len(flag.data.polygons)} faces, '
          f'cloth y {fc[:, 1].min():.2f}..{fc[:, 1].max():.2f} z {fc[:, 2].min():.2f}..{fc[:, 2].max():.2f}, '
          f'height {co[:, 2].max():.2f}', flush=True)
    return [ob, flag]


def export(objs, path, colors=False):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=False,
        export_texcoords=True, export_normals=True, export_vertex_color='ACTIVE' if colors else 'NONE',
        export_image_format='JPEG', export_image_quality=88, export_materials='EXPORT',
        export_yup=True, export_cameras=False, export_lights=False, export_animations=False,
    )
    print(f'wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)', flush=True)


def preview(objs, path):
    """EEVEE three-quarter view of every model in a row, accents painted red."""
    sc = bpy.context.scene
    for m in bpy.data.materials:
        if m.name.endswith('_Accent'):
            bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
            tex = bsdf.inputs['Base Color'].links[0].from_node
            mix = m.node_tree.nodes.new('ShaderNodeMix')
            mix.data_type, mix.blend_type = 'RGBA', 'MULTIPLY'
            mix.inputs['Factor'].default_value = 1
            mix.inputs['B'].default_value = (0.8, 0.1, 0.1, 1)
            m.node_tree.links.new(tex.outputs['Color'], mix.inputs['A'])
            m.node_tree.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
        if m.name.endswith('_Glow') and os.environ.get('GLOWCHECK'):
            bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
            for l in list(bsdf.inputs['Base Color'].links):
                m.node_tree.links.remove(l)
            bsdf.inputs['Base Color'].default_value = (1, 0, 1, 1)
    for i, o in enumerate(objs):
        o.location.x = i * 5.0
    if os.environ.get('SHOW'):
        keep = os.environ['SHOW'].split(',')
        for o in objs:
            o.hide_render = not any(o.name.startswith(k) for k in keep)
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 600 * len(objs), 600
    world = bpy.data.worlds.new('W')
    world.color = (0.35, 0.38, 0.42)
    sc.world = world
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 5.0 * len(objs)
    mid = (len(objs) - 1) * 2.5
    cam.location = (mid, -30, 22)
    cam.rotation_euler = (math.radians(55), 0, 0)
    sc.camera = cam
    for rot, e in (((50, 10, 35), 4), ((70, 0, 200), 1.2)):
        sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
        sun.data.energy = e
        sun.rotation_euler = [math.radians(a) for a in rot]
        sc.collection.objects.link(sun)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f'preview {path}', flush=True)


def main():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    only = os.environ.get('ONLY')
    shown = []
    if only in (None, 'castles'):
        castles = [build_castle(*c) for c in CASTLES]
        meshy_lib.downsize(castles, TEX)
        if os.environ.get('EXPORT', '1') != '0':
            export(castles, os.path.join(MODELS, 'castles.glb'))
        shown += castles
    if only in (None, 'ports'):
        boats = [build_ship(*b) for b in BOATS]
        for b in boats:  # ~12k faces is plenty for a boat this size on the map
            m = b.modifiers.new('Decimate', 'DECIMATE')
            m.ratio = BOAT_DECIMATE
            bpy.context.view_layer.objects.active = b
            bpy.ops.object.modifier_apply(modifier=m.name)
        port = [build_port(), build_ship()] + boats
        meshy_lib.downsize(boats, BOAT_TEX)  # small on the map, and one per army at sea
        meshy_lib.downsize(port, TEX)
        if os.environ.get('EXPORT', '1') != '0':
            export(port, os.path.join(MODELS, 'ports.glb'))
        shown += port
    if only == 'specials':
        sites = [build_special(*x) for x in SPECIALS]
        meshy_lib.downsize(sites, SITE_TEX)
        if os.environ.get('EXPORT', '1') != '0':
            export(sites, os.path.join(MODELS, 'specials.glb'))
        shown += sites
    if only == 'sites':
        sites = [build_special(*x) for x in MAP_SITES]
        meshy_lib.downsize(sites, SITE_TEX)
        if os.environ.get('EXPORT', '1') != '0':
            export(sites, os.path.join(MODELS, 'sites.glb'))
        shown += sites
    if only == 'banner':
        banner = build_banner()
        meshy_lib.downsize(banner, TEX)
        if os.environ.get('EXPORT', '1') != '0':
            export(banner, os.path.join(MODELS, 'units', 'banner.glb'), colors=True)
        shown += banner[:1]
    if os.environ.get('PREVIEW'):
        preview(shown, os.environ['PREVIEW'])


main()
