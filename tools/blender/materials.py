"""Procedural bake materials shared by the model scripts (linear colours).

Each entry is a pattern fn(kit, co, pxy, sep) -> albedo socket; lib.bake_material
wraps it with ambient occlusion and ground grime and bakes it into the atlas.
`make(spec)` builds the materials named in a spec dict and returns {name: material}.
"""
from lib import bake_material

# --- patterns ------------------------------------------------------------------------------


def _stone(c1, c2, mortar, w=0.11, h=0.052, dirt=0.35):
    def pat(k, co, pxy, sep):
        col, fac = k.brick(pxy, c1, c2, mortar, w, h, msize=0.006, bias=0.0)
        n = k.noise(co, 9.0, 4.0, 0.6)
        tint = k.ramp(n, [(0.3, (0.82, 0.8, 0.78)), (0.7, (1.08, 1.05, 1.0))])
        col = k.mix(1.0, col, tint, 'MULTIPLY')
        moss = k.noise(co, 3.0, 2.0)
        return k.mix(k.math('MULTIPLY', k.math('GREATER_THAN', moss, 0.62), dirt * 0.6), col, (0.12, 0.14, 0.07))
    return pat


def _wood_logs(dark, light):
    def pat(k, co, pxy, sep):
        v = k.vmath('MULTIPLY', co, (60.0, 60.0, 4.0))
        return k.ramp(k.noise(v, 1.0, 5.0, 0.7), [(0.25, dark), (0.75, light)])
    return pat


def _planks(c1, c2, gap):
    def pat(k, co, pxy, sep):
        v = k.combine(sep.outputs[2], k.math('ADD', sep.outputs[0], sep.outputs[1]), 0.0)
        col, _ = k.brick(v, c1, c2, gap, 0.7, 0.045, msize=0.004, bias=0.0, offset=0.3)
        grain = k.noise(k.vmath('MULTIPLY', co, (40.0, 40.0, 6.0)), 1.0, 4.0)
        return k.mix(k.math('MULTIPLY', grain, 0.35), col, (c2[0] * 0.6, c2[1] * 0.6, c2[2] * 0.6))
    return pat


def _flat(c, var=0.12, scale=14.0):
    def pat(k, co, pxy, sep):
        n = k.noise(co, scale, 3.0)
        lo = tuple(x * (1 - var) for x in c)
        hi = tuple(x * (1 + var) for x in c)
        return k.ramp(n, [(0.3, lo), (0.7, hi)])
    return pat


def _rows(c1, c2, gap, w, h):
    """Roof coverings: staggered rows along the slope."""
    def pat(k, co, pxy, sep):
        col, _ = k.brick(pxy, c1, c2, gap, w, h, msize=0.005, bias=-0.2)
        n = k.noise(co, 6.0, 3.0)
        lichen = k.math("MULTIPLY", k.math("GREATER_THAN", n, 0.68), 0.18)
        return k.mix(lichen, col, (0.22, 0.22, 0.12))
    return pat


def _thatch(c1, c2):
    def pat(k, co, pxy, sep):
        v = k.vmath('MULTIPLY', co, (90.0, 90.0, 9.0))
        streak = k.noise(v, 1.0, 4.0, 0.7)
        col = k.ramp(streak, [(0.28, c2), (0.72, c1)])
        rows = k.math('SINE', k.math('MULTIPLY', sep.outputs[2], 110.0))
        return k.mix(k.math('MULTIPLY', k.math('GREATER_THAN', rows, 0.75), 0.25), col, c2)
    return pat


def _earth(c1, c2):
    def pat(k, co, pxy, sep):
        n = k.noise(co, 5.0, 5.0, 0.6)
        return k.ramp(n, [(0.4, c1), (0.6, c2)])
    return pat


def _cobble(c, gap):
    def pat(k, co, pxy, sep):
        e = k.voronoi_edge(co, 22.0)
        m = k.math('SMOOTH_MIN', k.math('MULTIPLY', e, 12.0), 1.0, 0.3)
        tint = k.ramp(k.noise(co, 30.0, 2.0), [(0.3, tuple(x * 0.85 for x in c)), (0.7, tuple(x * 1.1 for x in c))])
        return k.mix(m, gap, tint)
    return pat


def _cloth():
    def pat(k, co, pxy, sep):
        n = k.noise(co, 60.0, 2.0)
        return k.ramp(n, [(0.3, (0.78, 0.78, 0.78)), (0.7, (0.9, 0.9, 0.9))])
    return pat


# --- ruin / wilderness patterns ------------------------------------------------------------------


def _up_moss(k, col, amount, moss=(0.07, 0.1, 0.03), thresh=0.55):
    """Moss and lichen on upward-facing surfaces, broken up by noise."""
    geo = k.node('ShaderNodeNewGeometry')
    nsep = k.node('ShaderNodeSeparateXYZ')
    k.link(geo.outputs['Normal'], nsep.inputs[0])
    up = k.math('MULTIPLY', k.math('SUBTRACT', nsep.outputs[2], 0.35), 2.2, clamp=True)
    n = k.noise(geo.outputs['Position'], 7.0, 4.0, 0.6)
    patch = k.math('MULTIPLY', k.math('SUBTRACT', n, thresh - 0.12), 5.0, clamp=True)
    fac = k.math('MULTIPLY', k.math('MAXIMUM', k.math('MULTIPLY', up, patch), k.math('MULTIPLY', patch, 0.25)), amount)
    return k.mix(fac, col, moss)


def _ruin_stone(c1, c2, mortar, w=0.12, h=0.06, moss=0.8):
    """Weathered ashlar: uneven blocks, dark streaks running down, moss on top faces."""
    def pat(k, co, pxy, sep):
        col, _ = k.brick(pxy, c1, c2, mortar, w, h, msize=0.007, bias=0.1)
        n = k.noise(co, 8.0, 4.0, 0.6)
        tint = k.ramp(n, [(0.25, (0.72, 0.7, 0.66)), (0.75, (1.1, 1.06, 1.0))])
        col = k.mix(1.0, col, tint, 'MULTIPLY')
        streak = k.noise(k.vmath('MULTIPLY', co, (26.0, 26.0, 2.0)), 1.0, 3.0)
        col = k.mix(k.math('MULTIPLY', k.math('GREATER_THAN', streak, 0.6), 0.35), col, (0.05, 0.05, 0.045))
        return _up_moss(k, col, moss)
    return pat


def _rock(c1, c2, moss=0.6):
    """Natural rock: blotchy two-tone with dark fissures and lichen."""
    def pat(k, co, pxy, sep):
        n = k.noise(co, 3.5, 6.0, 0.62)
        col = k.ramp(n, [(0.3, c2), (0.7, c1)])
        crack = k.voronoi_edge(k.vmath('MULTIPLY', co, (1.0, 1.0, 1.6)), 5.0)
        cm = k.math('SUBTRACT', 1.0, k.math('MULTIPLY', crack, 30.0, clamp=True))
        col = k.mix(k.math('MULTIPLY', cm, 0.7), col, (0.03, 0.028, 0.025))
        fine = k.noise(co, 40.0, 2.0)
        col = k.mix(1.0, col, k.ramp(fine, [(0.3, (0.85, 0.85, 0.85)), (0.7, (1.1, 1.1, 1.1))]), 'MULTIPLY')
        return _up_moss(k, col, moss, moss=(0.09, 0.11, 0.04), thresh=0.5)
    return pat


def _marble(c, vein):
    def pat(k, co, pxy, sep):
        n = k.noise(k.vmath('MULTIPLY', co, (3.0, 3.0, 1.0)), 2.0, 6.0, 0.65)
        v = k.math('SINE', k.math('MULTIPLY', k.math('ADD', sep.outputs[2], k.math('MULTIPLY', n, 1.4)), 30.0))
        vm = k.math('POWER', k.math('ABSOLUTE', v), 12.0)
        col = k.mix(k.math('MULTIPLY', vm, 0.5), c, vein)
        blocks, _ = k.brick(pxy, (1, 1, 1), (0.9, 0.9, 0.88), (0.45, 0.42, 0.38), 0.3, 0.16, msize=0.004)
        col = k.mix(1.0, col, blocks, 'MULTIPLY')
        return _up_moss(k, col, 0.55, moss=(0.2, 0.22, 0.1), thresh=0.6)
    return pat


def _turf(c1, c2, soil):
    def pat(k, co, pxy, sep):
        n = k.noise(co, 6.0, 5.0, 0.6)
        col = k.ramp(n, [(0.35, c2), (0.65, c1)])
        bare = k.noise(co, 2.5, 3.0)
        return k.mix(k.math('MULTIPLY', k.math('GREATER_THAN', bare, 0.62), 0.8), col, soil)
    return pat


def _verdigris():
    def pat(k, co, pxy, sep):
        n = k.noise(co, 10.0, 4.0, 0.6)
        col = k.ramp(n, [(0.3, (0.05, 0.2, 0.15)), (0.7, (0.14, 0.38, 0.28))])
        streak = k.noise(k.vmath('MULTIPLY', co, (30.0, 30.0, 3.0)), 1.0, 3.0)
        return k.mix(k.math('MULTIPLY', k.math('GREATER_THAN', streak, 0.55), 0.6), col, (0.1, 0.08, 0.04))
    return pat


def _glow(c):
    def pat(k, co, pxy, sep):
        n = k.noise(co, 25.0, 2.0)
        return k.ramp(n, [(0.3, tuple(x * 0.8 for x in c)), (0.7, c)])
    return pat


# --- specs -----------------------------------------------------------------------------------------

CASTLE = {
    'stone': _stone((0.42, 0.40, 0.36), (0.33, 0.31, 0.28), (0.19, 0.18, 0.16)),
    'stone_dark': _stone((0.24, 0.23, 0.21), (0.19, 0.18, 0.17), (0.09, 0.09, 0.08), w=0.24, h=0.11, dirt=0.6),
    'wood': _wood_logs((0.09, 0.055, 0.028), (0.24, 0.15, 0.075)),
    'planks': _planks((0.25, 0.155, 0.08), (0.18, 0.11, 0.055), (0.05, 0.03, 0.015)),
    'beam': _flat((0.075, 0.045, 0.025), 0.2, 30.0),
    'plaster': _flat((0.72, 0.65, 0.5), 0.1, 8.0),
    'thatch': _thatch((0.46, 0.34, 0.15), (0.25, 0.17, 0.06)),
    'shingle': _rows((0.17, 0.12, 0.08), (0.13, 0.1, 0.075), (0.04, 0.03, 0.02), 0.06, 0.035),
    'tile': _rows((0.42, 0.13, 0.055), (0.33, 0.1, 0.045), (0.12, 0.04, 0.02), 0.05, 0.03),
    'slate': _rows((0.1, 0.11, 0.135), (0.075, 0.085, 0.1), (0.03, 0.03, 0.035), 0.07, 0.035),
    'earth': _earth((0.15, 0.1, 0.055), (0.1, 0.13, 0.045)),
    'cobble': _cobble((0.3, 0.285, 0.26), (0.08, 0.075, 0.07)),
    'dark': _flat((0.018, 0.015, 0.012), 0.2),
    'iron': _flat((0.05, 0.05, 0.055), 0.2, 40.0),
    'gold': _flat((0.62, 0.4, 0.1), 0.1),
    'hay': _thatch((0.55, 0.42, 0.17), (0.35, 0.25, 0.08)),
    'accent': _cloth(),
    'flag': _cloth(),
}

# Ruins, shrines and bridges share one palette. Materials whose name starts with
# 'glow' are baked without AO and become emissive at runtime.
SITES = {
    'stone': CASTLE['stone'],
    'stone_dark': CASTLE['stone_dark'],
    'ruin': _ruin_stone((0.38, 0.36, 0.32), (0.3, 0.285, 0.26), (0.14, 0.13, 0.11)),
    'ruin_dark': _ruin_stone((0.2, 0.195, 0.185), (0.16, 0.155, 0.15), (0.07, 0.07, 0.065), w=0.2, h=0.1, moss=1.0),
    'bridge_stone': _ruin_stone((0.4, 0.37, 0.32), (0.32, 0.3, 0.26), (0.16, 0.15, 0.13), w=0.16, h=0.07, moss=0.6),
    'rock': _rock((0.3, 0.285, 0.26), (0.17, 0.16, 0.15)),
    'rock_dark': _rock((0.12, 0.115, 0.12), (0.06, 0.058, 0.065), moss=0.2),
    'marble': _marble((0.6, 0.58, 0.52), (0.26, 0.24, 0.22)),
    'turf': _turf((0.16, 0.2, 0.06), (0.09, 0.12, 0.035), (0.13, 0.09, 0.05)),
    'earth': CASTLE['earth'],
    'cobble': CASTLE['cobble'],
    'wood': CASTLE['wood'],
    'planks': CASTLE['planks'],
    'beam': CASTLE['beam'],
    'dark': CASTLE['dark'],
    'iron': CASTLE['iron'],
    'gold': _flat((0.7, 0.46, 0.12), 0.12),
    'bone': _flat((0.62, 0.58, 0.48), 0.15, 20.0),
    'verdigris': _verdigris(),
    'glow_blue': _glow((0.35, 0.8, 1.0)),
    'glow_green': _glow((0.45, 1.0, 0.35)),
    'glow_fire': _glow((1.0, 0.55, 0.15)),
    'glow_gold': _glow((1.0, 0.82, 0.4)),
    'glow_violet': _glow((0.7, 0.4, 1.0)),
}


def make(spec, only=None):
    out = {}
    for name, pat in spec.items():
        if only and name not in only:
            continue
        if name.startswith('glow'):
            out[name] = bake_material('bake_' + name, pat, ao_strength=0.0, grime=0.0)
        else:
            out[name] = bake_material('bake_' + name, pat)
    return out
