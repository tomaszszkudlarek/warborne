"""Shared helpers for turning Meshy AI models (tools/meshy/<name>/) into game assets.

Meshy's GLB carries only the base colour; the PBR maps of the same task sit in
model_static_textures/ with identical UVs. Faction colour is painted royal blue in
the concept, so faces whose texels are that blue move to an `*_Accent` material
whose texture has them turned grey for three.js to tint per owner.
"""
import os

import bpy
import numpy as np

# royal blue, in HSV
ACCENT_HUE = (0.55, 0.72)
ACCENT_SAT = 0.35
ACCENT_VAL = 0.10


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def accent_mask(rgb):
    """Pixels in the faction-coloured cloth or roofing (royal blue)."""
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-5)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    d = np.maximum(mx - mn, 1e-5)
    hue = np.where(mx == b, 4 + (r - g) / d, np.where(mx == g, 2 + (b - r) / d, (g - b) / d)) / 6 % 1
    return (hue > ACCENT_HUE[0]) & (hue < ACCENT_HUE[1]) & (sat > ACCENT_SAT) & (mx > ACCENT_VAL)


# magic glows: hue range (0..1), minimum saturation and value. Meshy's de-lighting leaves
# witch-fire as pale, bright yellow-green ('palegreen'), unlike the darker grass.
GLOW_HUES = {'green': ((0.22, 0.45), 0.45, 0.6), 'palegreen': ((0.17, 0.5), 0.2, 0.6),
             'violet': ((0.72, 0.9), 0.45, 0.6), 'blue': ((0.5, 0.64), 0.45, 0.6),
             'paleblue': ((0.42, 0.62), 0.15, 0.55),
             # lamplit windows and torches after de-lighting: saturated orange, not so bright
             'warm': ((0.04, 0.16), 0.55, 0.6)}


def glow_mask(rgb, kind='fire'):
    """Pixels that glow: 'fire' is molten lava or flame (bright, saturated orange to
    yellow); 'green' / 'violet' / 'blue' are bright, saturated magic of that hue."""
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-5)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    if kind in (True, 'fire'):
        return (r >= g) & (g >= b) & (g > 0.25 * r) & (sat > 0.55) & (mx > 0.7)
    d = np.maximum(mx - mn, 1e-5)
    hue = np.where(mx == b, 4 + (r - g) / d, np.where(mx == g, 2 + (b - r) / d, (g - b) / d)) / 6 % 1
    (lo, hi), smin, vmin = GLOW_HUES[kind]
    return (hue > lo) & (hue < hi) & (sat > smin) & (mx > vmin)


def load_map(src, name, colorspace='Non-Color'):
    img = bpy.data.images.load(os.path.join(src, 'model_static_textures', name))
    img.colorspace_settings.name = colorspace
    return img


def make_material(name, base_img, metal, rough, normal):
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])

    def tex(img):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = img
        return n
    nt.links.new(tex(base_img).outputs['Color'], bsdf.inputs['Base Color'])
    if metal:
        nt.links.new(tex(metal).outputs['Color'], bsdf.inputs['Metallic'])
    else:
        bsdf.inputs['Metallic'].default_value = 0
    nt.links.new(tex(rough).outputs['Color'], bsdf.inputs['Roughness'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tex(normal).outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def base_image(mesh):
    old = mesh.data.materials[0]
    return next(n.image for n in old.node_tree.nodes if n.type == 'TEX_IMAGE')


def pbr_materials(mesh, src, tag, accent=True, share=0.5, metallic=True, glow=False):
    """Replace Meshy's material with <tag>_Base (+ <tag>_Accent on faces whose
    corner/centre texels are more than `share` blue). metallic=False drops the
    metallic map (Meshy's is all zero on buildings). glow=True (or a glow_mask kind) moves faces that
    are mostly lava / flame (or that magic) to <tag>_Glow, which the game lights by its own texture."""
    base = base_image(mesh)
    base.name = f'{tag}_base'
    metal = load_map(src, 'metallic.png') if metallic else None
    rough, normal = load_map(src, 'roughness.png'), load_map(src, 'normal.png')
    mats = [make_material(f'{tag}_Base', base, metal, rough, normal)]
    if accent:
        px = pixels(base)
        mask = accent_mask(px[..., :3])
        # the blue goes grey (keeping its shading) so the faction colour multiplies cleanly
        acc = px.copy()
        grey = np.clip(px[..., :3].max(-1) * 1.35, 0, 1)
        acc[mask, 0:3] = grey[mask, None]
        img = bpy.data.images.new(f'{tag}_accent', base.size[0], base.size[1])
        img.pixels.foreach_set(acc.ravel())
        img.file_format = 'PNG'
        img.pack()
        mats.append(make_material(f'{tag}_Accent', img, metal, rough, normal))
    mesh.data.materials.clear()
    for m in mats:
        mesh.data.materials.append(m)
    if accent:
        idx = accent_faces(mesh, mask, share)
        print(f'{tag}: accent faces {idx.sum()} / {len(idx)}', flush=True)
    if glow:
        mesh.data.materials.append(make_material(f'{tag}_Glow', base, metal, rough, normal))
        g = face_share(mesh, glow_mask(pixels(base)[..., :3], glow)) > 0.35
        mi = np.empty(len(mesh.data.polygons), np.int32)
        mesh.data.polygons.foreach_get('material_index', mi)
        mi[g] = len(mesh.data.materials) - 1
        mesh.data.polygons.foreach_set('material_index', mi)
        mesh.data.update()
        print(f'{tag}: glow faces {int(g.sum())} / {len(g)}', flush=True)


def emissive_lights(mesh, tag, kind='warm', gain=1.6):
    """Lamplit windows and torches as an emissive texture on every material of the mesh:
    the base colour where glow_mask(kind) holds, brightened; black elsewhere. Unlike the
    *_Glow faces this catches lights smaller than a face (a window in a wall)."""
    mats = list(mesh.data.materials)
    base = next(n.image for n in mats[0].node_tree.nodes if n.type == 'TEX_IMAGE')
    px = pixels(base)
    mask = glow_mask(px[..., :3], kind)
    em = np.zeros_like(px)
    em[..., 3] = 1
    em[mask, 0:3] = np.clip(px[mask, 0:3] * gain, 0, 1)
    img = bpy.data.images.new(f'{tag}_emissive', base.size[0], base.size[1])
    img.pixels.foreach_set(em.ravel())
    img.file_format = 'PNG'
    img.pack()
    for m in mats:
        nt = m.node_tree
        bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = img
        nt.links.new(t.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0
    print(f'{tag}: emissive texels {int(mask.sum())}', flush=True)


def accent_faces(mesh, mask, share=0.5):
    """Material index 1 where over `share` of a face's corner and centre texels are accent."""
    idx = (face_share(mesh, mask) > share).astype(np.int32)
    mesh.data.polygons.foreach_set('material_index', idx)
    mesh.data.update()
    return idx


def face_share(mesh, mask):
    """Per face, the share of its corner and centre texels inside `mask`."""
    me = mesh.data
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    h, w = mask.shape

    def at(p):
        return mask[np.clip((p[:, 1] * h).astype(int), 0, h - 1), np.clip((p[:, 0] * w).astype(int), 0, w - 1)]
    start = np.empty(len(me.polygons), np.int32)
    total = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_start', start)
    me.polygons.foreach_get('loop_total', total)
    corner = np.add.reduceat(at(uv).astype(np.float32), start) / total
    centre = at(np.add.reduceat(uv, start) / total[:, None])
    return (corner + centre) / 2


def downsize(meshes, px):
    """Scale every texture on these meshes down to `px` wide (Meshy's are 2048)."""
    if not px:
        return
    imgs = {n.image.name: n.image for ob in meshes for m in ob.data.materials
            for n in m.node_tree.nodes if n.type == 'TEX_IMAGE'}
    for img in imgs.values():
        if img.size[0] > px:
            img.scale(px, px * img.size[1] // img.size[0])
    print(f'textures downsized to {px}px', flush=True)
