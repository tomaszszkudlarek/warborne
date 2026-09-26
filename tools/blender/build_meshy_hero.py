"""Builds a hero or infantry GLB from a Meshy AI rigged character (tools/meshy/<hero>/).

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        --python tools/blender/build_meshy_hero.py
    (env HERO=paladin picks the source folder, TEX=<px> sets the texture size
     (default 1024, 0 keeps Meshy's 2048), PREVIEW=/path.png renders a contact
     sheet of the walk, FRAMES=0,8,16,24 COLS=4 CAM_ANGLE=<deg> tune it)

Source files in tools/meshy/<hero>/, all from one Meshy rig task:
    walk.glb            rigged mesh + walking clip (Meshy's free rig animation)
    idle_11.glb         same rig + Idle_02 (animation library action 11)
    run.glb             (units only) the rig's free running clip
    model_static_textures/{metallic,roughness,normal}.png
                        PBR maps of the pre-rig model; the rig keeps its UVs, but
                        its GLB only carries the base colour.

Output public/models/heroes/<hero>.glb matches build_heroes.py: one skinned mesh,
NLA clips Walk (one stride cycle) and Idle, `stride` and `height` extras on the
armature. Army units (HERO=lightinfantry|heavyinfantry|giant|archon) go to
public/models/units/<unit>.glb with a Run clip and a `run_stride` extra as well, like
build_units.py. The archon flies: two wing bones are added on the upper spine, and its
Idle (hover) and Walk (flight) are Meshy's calm idle with the wings beating. Faces whose texture is the tabard/cloak blue go to <Hero>_Accent, whose
texture has those pixels turned grey so the game can tint them per faction.
"""
import math
import os
import sys

import bpy
import numpy as np
from bpy_extras import anim_utils
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import meshy_lib  # noqa: E402
from meshy_lib import pixels  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
HERO = os.environ.get('HERO', 'paladin')
SRC = os.path.join(ROOT, 'tools', 'meshy', HERO)
# Meshy textures are 2048px; 1024 looked as good on the map at under half the size
# (chosen 2026-09-23 as the standard for hero models). TEX=0 keeps the originals.
TEX = int(os.environ.get('TEX', '1024'))
# army units share the hero pipeline; the value is the object / material name
UNITS = {'lightinfantry': 'LightInfantry', 'heavyinfantry': 'HeavyInfantry', 'giant': 'Giant',
         'archon': 'Archon', 'archer': 'Archer', 'pikeman': 'Pikeman', 'dwarf': 'Dwarf', 'orc': 'Orc',
         'goblin': 'Goblin', 'skeleton': 'Skeleton', 'zombie': 'Zombie', 'demon': 'Demon', 'golem': 'Golem',
         'minotaur': 'Minotaur', 'ogre': 'Ogre', 'wraith': 'Wraith', 'elf': 'Elf', 'lich': 'Lich',
         'fireelemental': 'FireElemental', 'treant': 'Treant', 'harpy': 'Harpy', 'gnoll': 'Gnoll',
         'peasant': 'Peasant', 'halfling': 'Halfling', 'assassin': 'Assassin', 'reaver': 'Reaver',
         'mummy': 'Mummy', 'dryad': 'Dryad', 'medusa': 'Medusa', 'imp': 'Imp', 'plaguecarrier': 'PlagueCarrier',
         'moonguard': 'Moonguard', 'iceguard': 'Iceguard', 'dwarfmutant': 'DwarfMutant',
         'dwarfrunner': 'DwarfRunner', 'scout': 'Scout'}
# flying units: wing bones are added to Meshy's rig; they hover on the Idle clip and
# fly on Walk, both made from the calm idle with the wings beating (no walking legs)
FLYERS = {'archon', 'harpy', 'imp'}
# floating units without wings (robes to the ground): both clips are the calm idle
HOVERERS = {'wraith'}
# lava seams and flames go to <Name>_Glow (emissive in the game)
GLOWING = {'fireelemental'}
NAME = UNITS.get(HERO, HERO.capitalize())
OUT = os.path.join(ROOT, 'public', 'models', 'units' if HERO in UNITS else 'heroes', HERO + '.glb')
FPS = 30  # Meshy clips are keyed at 30 fps; importing at 30 keeps keys on whole frames

ARM_ANGLE = 12  # mean shoulder-to-wrist angle from hanging, degrees (Meshy's ~50)
# units hang their arms this far out from the side (clear of the gambeson / plate)
UNIT_ARMS = {'lightinfantry': 14, 'heavyinfantry': 18, 'giant': 20, 'archon': 14, 'archer': 14,
             'pikeman': 16, 'dwarf': 22, 'orc': 20, 'goblin': 14, 'skeleton': 12, 'zombie': 14,
             'demon': 22, 'golem': 28, 'minotaur': 20, 'ogre': 28, 'wraith': 14, 'elf': 14,
             'lich': 16, 'fireelemental': 20, 'treant': 22, 'harpy': 14, 'gnoll': 16,
             'peasant': 14, 'halfling': 16, 'assassin': 12, 'reaver': 20, 'mummy': 14, 'dryad': 12,
             'medusa': 16, 'imp': 16, 'plaguecarrier': 12, 'moonguard': 16, 'iceguard': 20,
             'dwarfmutant': 26, 'dwarfrunner': 18, 'scout': 14}
ELBOW_KEEP = 0.5  # share of Meshy's elbow flex the units keep
IDLE = 'idle_11.glb'  # Idle_02 (library action 11): calm stance; action 0 turns around


def _ramp(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def _sword(co):
    """Longsword hanging at the left hip, pommel forward, tip behind the calf."""
    a, b = np.array([0.18, -0.34, 1.26]), np.array([0.37, 0.36, 0.28])
    d = b - a
    t = np.clip(((co - a) @ d) / (d @ d), 0, 1)
    dist = np.linalg.norm(co - (a + t[:, None] * d), axis=1)
    r = np.where(t < 0.2, 0.05, 0.035)  # hilt and guard are wider than the blade
    return _ramp((r - dist) / 0.01 + 0.5)


def _shield(co):
    """Heater shield on the back: behind its tilted inner face, tapering to a point."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    inner = 0.04 + (1.71 - z) * (0.08 / 0.81)
    half = 0.02 + 0.31 * np.clip((z - 0.88) / 0.4, 0, 1) ** 0.6
    return (_ramp((y - inner + 0.005) / 0.02) * _ramp((z - 0.86) / 0.04)
            * _ramp((1.76 - z) / 0.03) * _ramp((half - np.abs(x)) / 0.03))


def _capsule(co, a, b, r, soft=0.01):
    """Around segment a-b; r may vary along it (an array over t in 0..1)."""
    a, b = np.array(a), np.array(b)
    d = b - a
    t = np.clip(((co - a) @ d) / (d @ d), 0, 1)
    dist = np.linalg.norm(co - (a + t[:, None] * d), axis=1)
    return _ramp(((r(t) if callable(r) else r) - dist) / soft + 0.5)


def _axe_haft(co):
    """Barbarian's great axe on his back: haft from the left hip up past the right shoulder."""
    return _capsule(co, (0.31, 0.2, 0.84), (-0.29, 0.2, 1.78), 0.04)


def _axe_head(co):
    """Both blades behind the right side of the helmet (they stand in the haft's plane)."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    return (_ramp((x + 0.5) / 0.02) * _ramp((-0.05 - x) / 0.02) * _ramp((z - 1.46) / 0.02)
            * _ramp((1.95 - z) / 0.02) * _ramp((y - 0.15) / 0.01) * _ramp((0.26 - y) / 0.01))


def _staff(co):
    """Druid's staff across his back: foot out behind the right calf, crystal over
    the left shoulder, where the gnarled crown is wider."""
    shaft = _capsule(co, (-0.5, 0.15, 0.38), (0.39, 0.13, 1.75), 0.04)
    # above the shoulder the gnarled wood splays out and the rig gave it to the arm
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    crown = (_ramp((x - 0.12) / 0.02) * _ramp((0.46 - x) / 0.02) * _ramp((y - 0.075) / 0.01)
             * _ramp((0.25 - y) / 0.01) * _ramp((z - 1.42) / 0.02) * _ramp((1.82 - z) / 0.02))
    return np.maximum(shaft, crown)


def _mage_staff(co):
    """Mage's staff across his back: foot behind the right knee, orb over the left shoulder."""
    shaft = _capsule(co, (-0.37, 0.12, 0.55), (0.29, 0.15, 1.6), 0.03)
    orb = _capsule(co, (0.29, 0.15, 1.62), (0.3, 0.16, 1.68), 0.065)
    return np.maximum(shaft, orb)


def _polyline(co, pts, r):
    return np.max([_capsule(co, a, b, r) for a, b in zip(pts, pts[1:])], axis=0)


def _bow(co):
    """Rogue's recurve bow on his back, upper tip over the left shoulder; the string
    runs straight between the tips."""
    limb = _polyline(co, [(0.35, 0.17, 1.85), (0.22, 0.17, 1.68), (0.07, 0.17, 1.53),
                          (-0.04, 0.17, 1.37), (-0.13, 0.17, 1.18), (-0.22, 0.17, 0.96),
                          (-0.29, 0.17, 0.78), (-0.36, 0.16, 0.58)], 0.04)
    string = _capsule(co, (0.34, 0.16, 1.84), (-0.34, 0.15, 0.6), 0.02)
    return np.maximum(limb, string)


def _quiver(co):
    """Quiver on the rogue's back, arrows up behind the right shoulder."""
    return _capsule(co, (0.07, 0.13, 1.04), (-0.17, 0.13, 1.72), lambda t: 0.06 + 0.06 * (t > 0.75))


def _dagger(co):
    """Sheathed dagger at the rogue's right hip, tip down."""
    return _capsule(co, (-0.165, 0.0, 1.12), (-0.23, 0.0, 0.69), 0.035)


def _rapier(co):
    """Vampire's rapier at his left hip: basket hilt forward, blade back to the calf."""
    return _capsule(co, (0.165, -0.19, 1.22), (0.22, 0.01, 0.32),
                    lambda t: np.where(t < 0.16, 0.065, 0.025))


def _round_shield(co):
    """Light infantry's round shield on his back, face out behind the shoulder blades."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    r = np.hypot(x, z - 1.19)
    return _ramp((0.32 - r) / 0.02) * _ramp((y - 0.118) / 0.01)


def _li_spear(co):
    """Spear between the shield and the back: butt by the right knee, head over the left shoulder."""
    return _capsule(co, (-0.39, 0.12, 0.58), (0.37, 0.12, 1.8), lambda t: np.where(t > 0.82, 0.05, 0.032))


def _tower_shield(co):
    """Heavy infantry's heater shield on his back: flat top, tapering to a point."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    half = 0.02 + 0.27 * np.clip((z - 0.88) / 0.34, 0, 1) ** 0.6
    return (_ramp((y - 0.13) / 0.01) * _ramp((z - 0.86) / 0.03) * _ramp((1.66 - z) / 0.03)
            * _ramp((half - np.abs(x)) / 0.03))


def _broadsword(co):
    """Broadsword at the left hip: hilt forward at the belt, tip behind the calf."""
    return _capsule(co, (0.12, -0.25, 1.29), (0.34, 0.15, 0.31), lambda t: np.where(t < 0.25, 0.06, 0.035))


def _club(co):
    """Giant's spiked club on his back: grip by the right hip, head over the left shoulder."""
    return _capsule(co, (-0.3, 0.18, 0.92), (0.3, 0.18, 1.84), lambda t: 0.045 + 0.04 * t)


def _box(co, lo, hi, soft=0.01):
    """Axis-aligned box lo..hi (rest-pose metres), soft-edged."""
    return np.prod([_ramp((co[:, i] - lo[i]) / soft) * _ramp((hi[i] - co[:, i]) / soft) for i in range(3)], axis=0)


def _goblin_spear(co):
    """Goblin's short spear on his back: butt beside the right knee, head over the left shoulder."""
    return _capsule(co, (-0.38, 0.17, 0.65), (0.36, 0.2, 1.73), lambda t: np.where(t > 0.85, 0.05, 0.035))


def _halberd(co):
    """Pikeman's halberd on his back: head over the right shoulder. Above the belt it
    rides the spine; the fused mesh joins its lower shaft to the sword scabbard and the
    left thigh, so that part follows the hip (_halberd_foot)."""
    shaft = _capsule(co, (-0.35, 0.14, 1.87), (0.41, 0.19, 0.36), 0.035) * _ramp((co[:, 2] - 1.0) / 0.12)
    head = _box(co, (-0.42, 0.06, 1.44), (-0.16, 0.24, 1.9))
    return np.maximum(shaft, head)


def _halberd_foot(co):
    return _capsule(co, (-0.35, 0.14, 1.87), (0.41, 0.19, 0.36), 0.06) * _ramp((1.06 - co[:, 2]) / 0.12)


def _cleaver_grip(co):
    """Orc's cleaver on his back: the grip over the right shoulder (the blade by the
    left hip is already on the spine)."""
    return _capsule(co, (-0.34, 0.2, 1.88), (-0.15, 0.2, 1.62), 0.045)


def _ogre_club(co):
    """Ogre's club on his back: banded grip by the right hip, head over the left shoulder."""
    return _capsule(co, (-0.44, 0.16, 0.8), (0.36, 0.25, 1.93), lambda t: np.where(t > 0.75, 0.14, 0.085))


def _archon_sword(co):
    """Archon's longsword at the left hip: hilt at the belt, tip down by the left shin."""
    return _capsule(co, (0.1, -0.3, 0.86), (0.345, -0.09, 0.265), lambda t: np.where(t < 0.2, 0.06, 0.03))


def _pitchfork(co):
    """Peasant's pitchfork on his back: butt by the right knee, tines over the left shoulder."""
    shaft = _capsule(co, (-0.4, 0.11, 0.6), (0.24, 0.12, 1.62), 0.03)
    return np.maximum(shaft, _box(co, (0.08, 0.05, 1.48), (0.42, 0.2, 1.92)))


def _flails(co):
    """Reaver's two flails hanging behind the shoulders, handles up, heads by the elbows."""
    x = np.abs(co[:, 0])
    return (_ramp((x - 0.15) / 0.02) * _ramp((0.37 - x) / 0.02) * _ramp((co[:, 1] - 0.085) / 0.01)
            * _ramp((co[:, 2] - 1.04) / 0.02) * _ramp((1.8 - co[:, 2]) / 0.02))


def _quiver_small(co):
    """Halfling's quiver behind the right shoulder."""
    return _box(co, (-0.48, 0.1, 1.42), (-0.12, 0.28, 1.78))


def _cloak_upper(co):
    """A cloak's back panel between the shoulder blades (arms stay out of it)."""
    return _box(co, (-0.3, 0.07, 0.95), (0.3, 0.3, 1.4))


def _cloak_lower(co):
    """A cloak's skirt behind the legs; follows the hips and both legs' mean swing."""
    return 0.9 * _box(co, (-0.5, 0.09, 0.2), (0.5, 0.35, 0.97))


def _twin_daggers(co):
    """Assassin's daggers crossed behind the shoulders, hilts up."""
    return np.maximum(_capsule(co, (-0.22, 0.13, 1.74), (0.06, 0.11, 1.32), 0.04),
                      _capsule(co, (0.22, 0.13, 1.74), (-0.06, 0.11, 1.32), 0.04))


def _longbow(co):
    """Moonguard's bow across his back: upper tip over the left shoulder, lower by the right hip."""
    limb = _polyline(co, [(0.47, 0.16, 1.86), (0.0, 0.15, 1.45), (-0.37, 0.12, 0.73)], 0.06)
    return np.maximum(limb, _box(co, (0.14, 0.07, 1.52), (0.52, 0.32, 1.92)))


def _moon_quiver(co):
    return _box(co, (-0.27, 0.1, 1.3), (-0.03, 0.3, 1.72))


def _greatsword(co):
    """Iceguard's greatsword on his back: hilt over the right shoulder, tip behind the left calf."""
    return _capsule(co, (-0.32, 0.16, 1.88), (0.44, 0.12, 0.41), lambda t: np.where(t < 0.15, 0.06, 0.04))


def _warhammer(co):
    """Dwarf mutant's hammer on his back: head over the left shoulder, grip by the right hip."""
    shaft = _capsule(co, (0.22, 0.18, 1.62), (-0.48, 0.15, 0.62), 0.05)
    return np.maximum(shaft, _box(co, (0.06, 0.07, 1.54), (0.48, 0.31, 1.92)))


def _crossed_axes(co):
    """Dwarf runner's hand axes crossed on his back, heads up behind the shoulders."""
    hafts = np.maximum(_capsule(co, (0.3, 0.14, 1.6), (-0.33, 0.14, 0.86), 0.035),
                       _capsule(co, (-0.3, 0.14, 1.6), (0.33, 0.14, 0.86), 0.035))
    x = np.abs(co[:, 0])
    heads = (_ramp((x - 0.18) / 0.02) * _ramp((0.42 - x) / 0.02) * _ramp((co[:, 1] - 0.1) / 0.01)
             * _ramp((co[:, 2] - 1.43) / 0.02) * _ramp((1.7 - co[:, 2]) / 0.02))
    return np.maximum(hafts, heads)


def _scout_spear(co):
    """Scout's spear on his back: head over the left shoulder, butt by the right knee."""
    return _capsule(co, (0.38, 0.15, 1.9), (-0.51, 0.12, 0.5), lambda t: np.where(t < 0.14, 0.08, 0.05), soft=0.02)


def _lute(co):
    """Bard's lute on his back: neck up over the left shoulder, the round body low by the right hip."""
    neck = _capsule(co, (0.24, 0.12, 1.72), (-0.05, 0.12, 1.1), 0.05)
    return np.maximum(neck, _box(co, (-0.36, 0.07, 0.68), (0.14, 0.26, 1.12)))


def _general_sword(co):
    """General's longsword on his back: hilt over the right shoulder, scabbard tip behind the left calf."""
    return _capsule(co, (-0.34, 0.15, 1.87), (0.47, 0.17, 0.27), lambda t: np.where(t < 0.15, 0.065, 0.06), soft=0.015)


def _upper(fn, z):
    """The part of region `fn` above z; _lower the rest. A long piece reaching down past
    the hips hangs among cloth the legs drive: its lower end rides the hips and the legs'
    mean swing (SKIRT) like that cloth, the upper end the back."""
    def up(co):
        return fn(co) * _ramp((co[:, 2] - z) / 0.1 + 0.5)
    up.__name__ = fn.__name__ + '_upper'
    return up


def _lower(fn, z):
    def lo(co):
        return fn(co) * _ramp((z - co[:, 2]) / 0.1 + 0.5)
    lo.__name__ = fn.__name__ + '_lower'
    return lo


def _staff_back(a, b, head=0.0):
    """A staff across the back from a (over the shoulder) to b, with a knob of radius `head` at a."""
    def fn(co):
        w = _capsule(co, a, b, 0.045, soft=0.015)
        if head:
            w = np.maximum(w, _ramp((head - np.linalg.norm(co - np.array(a), axis=1)) / 0.01 + 0.5))
        return w
    fn.__name__ = '_staff'
    return fn


def _ranger_bow(co):
    bow = _capsule(co, (0.37, 0.15, 1.87), (-0.37, 0.12, 0.66), 0.06, soft=0.015)
    return np.maximum(bow, _box(co, (-0.43, 0.08, 1.25), (-0.04, 0.3, 1.76)))


def _warrior_sword(co):
    return _capsule(co, (-0.37, 0.13, 1.91), (0.43, 0.1, 0.44), lambda t: np.where(t < 0.2, 0.06, 0.045))


BACK = {'Spine': 0.7, 'Spine01': 0.3}
SKIRT = {'Hips': 0.6, 'LeftUpLeg': 0.2, 'RightUpLeg': 0.2}


# Gear the auto-rig skinned like flesh (so it bent with the legs and arms): region
# test in rest-pose metres -> the bone weights every vertex of it gets. The same
# weights on all of its vertices keep the piece rigid; the sword follows the thigh
# a little so the swinging leg doesn't cut through it.
RIGID = {
    'paladin': [
        (_sword, {'Hips': 0.6, 'LeftUpLeg': 0.4}),
        (_shield, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'barbarian': [
        (_axe_haft, {'Spine': 0.7, 'Spine01': 0.3}),
        (_axe_head, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'druid': [
        (_staff, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'mage': [
        (_mage_staff, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'rogue': [
        (_bow, {'Spine': 0.7, 'Spine01': 0.3}),
        (_quiver, {'Spine': 0.7, 'Spine01': 0.3}),
        (_dagger, {'Hips': 0.6, 'RightUpLeg': 0.4}),
    ],
    'vampire': [
        (_rapier, {'Hips': 0.6, 'LeftUpLeg': 0.4}),
    ],
    'lightinfantry': [
        (_round_shield, {'Spine': 0.7, 'Spine01': 0.3}),
        (_li_spear, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'heavyinfantry': [
        (_tower_shield, {'Spine': 0.7, 'Spine01': 0.3}),
        (_broadsword, {'Hips': 0.6, 'LeftUpLeg': 0.4}),
    ],
    'giant': [
        (_club, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'archon': [
        (_archon_sword, {'Hips': 0.6, 'LeftUpLeg': 0.4}),
    ],
    'orc': [
        (_cleaver_grip, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'ogre': [
        (_ogre_club, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'goblin': [
        (_goblin_spear, {'Spine': 0.7, 'Spine01': 0.3}),
    ],
    'pikeman': [
        (_halberd, {'Spine': 0.7, 'Spine01': 0.3}),
        (_halberd_foot, {'Hips': 0.6, 'LeftUpLeg': 0.4}),
    ],
    'peasant': [(_pitchfork, BACK)],
    'reaver': [(_flails, BACK)],
    'halfling': [(_quiver_small, BACK), (_cloak_upper, BACK), (_cloak_lower, SKIRT)],
    'assassin': [(_twin_daggers, BACK)],
    'moonguard': [(_longbow, BACK), (_moon_quiver, BACK)],
    'iceguard': [(_greatsword, {'Spine': 0.6, 'Spine01': 0.2, 'Hips': 0.2})],
    'dwarfmutant': [(_warhammer, BACK)],
    'dwarfrunner': [(_crossed_axes, BACK)],
    'scout': [(_scout_spear, BACK), (_cloak_lower, SKIRT)],
    'bard': [(_lute, {'Spine': 0.5, 'Spine01': 0.2, 'Hips': 0.3})],
    'general': [(_upper(_general_sword, 1.0), BACK), (_lower(_general_sword, 1.0), SKIRT)],
    'summoner': [(_upper(_staff_back((-0.37, 0.14, 1.84), (0.5, 0.13, 0.47), head=0.09), 0.95), BACK),
                 (_lower(_staff_back((-0.37, 0.14, 1.84), (0.5, 0.13, 0.47)), 0.95), SKIRT)],
    'monk': [(_staff_back((0.34, 0.13, 1.86), (-0.5, 0.11, 0.51)), BACK)],
    'necromancer': [(_staff_back((0.32, 0.12, 1.86), (-0.5, 0.1, 0.59), head=0.09), BACK)],
    'priest': [(_staff_back((0.2, 0.12, 1.74), (-0.43, 0.1, 0.81), head=0.1), BACK)],
    'ranger': [(_ranger_bow, BACK)],
    'warrior': [(_warrior_sword, BACK)],
}

def _archon_wings(co):
    """Wings rising behind the archon's shoulders, tips up and out. Below the shoulders
    the lowest feathers hang beside the cape, so there only what's further back or
    further out than the cape counts."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    back = _ramp((y + 0.02) / 0.03)
    high = _ramp((z - 1.08) / 0.04)
    low = _ramp((z - 0.8) / 0.03) * np.maximum(_ramp((y - 0.03) / 0.02), _ramp((np.abs(x) - 0.27) / 0.02))
    return back * np.maximum(high, low) * _ramp((1.1 - np.abs(x)) / 0.02)


def _harpy_wings(co):
    """The harpy's wings hang folded behind her, shoulder blades to hips. At arm height
    only what's well behind the arms counts."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    arm_band = _ramp((z - 1.26) / 0.03) * _ramp((1.52 - z) / 0.03)
    back = _ramp((y - 0.02 - 0.05 * arm_band) / 0.02)
    return (back * _ramp((np.abs(x) - 0.13) / 0.02) * _ramp((0.5 - np.abs(x)) / 0.02)
            * _ramp((z - 0.68) / 0.03) * _ramp((1.9 - z) / 0.03))


def _imp_wings(co):
    """The imp's bat wings rise behind its shoulder blades; the arms hang in front of
    the back plane, the head's swept-back crest stays with the head."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    crest = _ramp((0.11 - np.abs(x)) / 0.02) * _ramp((z - 1.14) / 0.02)
    return _ramp((y + 0.08) / 0.03) * _ramp((z - 0.97) / 0.03) * (1 - crest)


# Flyers' wings (rest-pose metres, left side): bone root on the upper back and tip,
# the vertex mask, the axis a beat turns about (Y: tips out and down like the archon's
# raised wings; Z: the harpy's folded wings sweep back and forth), the (amplitude,
# offset) degrees of the flight and hover beats and their frames per beat.
WINGS = {
    'archon': dict(root=(0.1, -0.02, 1.08), tip=(0.85, 0.2, 1.8), mask=_archon_wings, axis=(0, 1, 0),
                   fly=(38, -4), hover=(26, 0), beat=(20, 34)),
    'harpy': dict(root=(0.14, 0.06, 1.32), tip=(0.32, 0.14, 1.8), mask=_harpy_wings, axis=(0, 0, 1),
                  fly=(60, 0), hover=(35, 0), beat=(16, 28)),
    'imp': dict(root=(0.1, -0.08, 1.04), tip=(0.85, 0.1, 1.85), mask=_imp_wings, axis=(0, 1, 0),
                fly=(42, -6), hover=(30, 0), beat=(12, 20)),
}


def import_glb(path):
    before = {o.name for o in bpy.data.objects}
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o.name not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    mesh = next(o for o in new if o.type == 'MESH' and o.parent and o.parent.name == arm.name)
    return arm, mesh, new


def remove_objects(objs):
    for o in objs:
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if isinstance(data, bpy.types.Mesh) and data.users == 0:
            bpy.data.meshes.remove(data)
        elif isinstance(data, bpy.types.Armature) and data.users == 0:
            bpy.data.armatures.remove(data)


def setup_materials(mesh):
    meshy_lib.pbr_materials(mesh, SRC, NAME, glow=HERO in GLOWING)


def rigid_gear(mesh):
    """Re-skin each RIGID part: blend its vertices toward the part's fixed weights."""
    parts = RIGID.get(HERO, [])
    if not parts:
        return
    me = mesh.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    M = np.array(mesh.matrix_world)
    co = co @ M[:3, :3].T + M[:3, 3]
    groups = {g.name: g for g in mesh.vertex_groups}
    names = [g.name for g in mesh.vertex_groups]
    for fn, bones in parts:
        w = fn(co)
        sel = np.nonzero(w > 1e-3)[0]
        for i in sel:
            v = me.vertices[int(i)]
            old = {names[g.group]: g.weight for g in v.groups}
            tot = sum(old.values()) or 1
            new = {n: (1 - w[i]) * x / tot for n, x in old.items()}
            for n, x in bones.items():
                new[n] = new.get(n, 0) + w[i] * x
            for n in old:
                groups[n].remove([v.index])
            for n, x in new.items():
                if x > 1e-4:
                    groups[n].add([v.index], x, 'REPLACE')
        print(f'{fn.__name__.strip("_")}: {int((w > 0.5).sum())} vertices rigid to {bones}', flush=True)


def add_wings(arm, mesh):
    """Wing bones on the upper spine; the wing vertices go rigid to them, blending into
    the spine at the root so the wings stay attached."""
    W = WINGS[HERO]
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    inv = arm.matrix_world.inverted()
    for side, sg in (('L', 1), ('R', -1)):
        eb = arm.data.edit_bones.new(f'Wing.{side}')
        eb.head = inv @ Vector((sg * W['root'][0], W['root'][1], W['root'][2]))
        eb.tail = inv @ Vector((sg * W['tip'][0], W['tip'][1], W['tip'][2]))
        eb.parent = arm.data.edit_bones['Spine']
    bpy.ops.object.mode_set(mode='OBJECT')
    me = mesh.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    M = np.array(mesh.matrix_world)
    co = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    m = W['mask'](co)
    groups = {g.name: g for g in mesh.vertex_groups}
    names = [g.name for g in mesh.vertex_groups]
    for side in ('L', 'R'):
        groups[f'Wing.{side}'] = mesh.vertex_groups.new(name=f'Wing.{side}')
    root = np.array(W['root'])
    for i in np.nonzero(m > 1e-3)[0]:
        side = 'L' if co[i, 0] > 0 else 'R'
        r = np.linalg.norm(co[i] - root * [np.sign(co[i, 0]) or 1, 1, 1])
        f = float(_ramp((r - 0.04) / 0.2))
        v = me.vertices[int(i)]
        old = {names[g.group]: g.weight for g in v.groups}
        tot = sum(old.values()) or 1
        new = {n: (1 - m[i]) * x / tot for n, x in old.items()}
        new['Spine'] = new.get('Spine', 0) + m[i] * (1 - f)
        new[f'Wing.{side}'] = m[i] * f
        for n in old:
            groups[n].remove([v.index])
        for n, x in new.items():
            if x > 1e-4:
                groups[n].add([v.index], float(x), 'REPLACE')
    print(f'wings: {int((m > 0.5).sum())} vertices on Wing.L / Wing.R', flush=True)


def flap(arm, act, beat, amp, up, axis):
    """Keys a wing beat into `act`: each wing turns about the body's front-back axis,
    tips out and down on the downstroke (quicker than the upstroke). The beat count is
    whole so the clip still loops."""
    f0, f1 = (int(round(v)) for v in act.frame_range)
    n = max(1, round((f1 - f0) / beat))
    use_action(arm, act)
    ax = (arm.matrix_world.to_3x3().inverted() @ Vector(axis)).normalized()
    for side, sg in (('L', 1), ('R', -1)):
        pb = arm.pose.bones[f'Wing.{side}']
        pb.rotation_mode = 'QUATERNION'
        B = pb.bone.matrix_local.to_3x3()
        for f in range(f0, f1 + 1):
            p = math.tau * n * (f - f0) / (f1 - f0)
            q = p + 0.35 * math.sin(p)
            ang = math.radians(up + amp * 0.5 * (1 - math.cos(q)))
            R = Quaternion(ax, sg * ang).to_matrix()
            pb.rotation_quaternion = (B.inverted() @ R @ B).to_quaternion()
            pb.keyframe_insert('rotation_quaternion', frame=f)
    arm.animation_data.action = None
    print(f'{act.name}: {n} wing beats of {(f1 - f0) / n:.1f} frames', flush=True)


def use_action(arm, act):
    """Assign an action imported onto another armature: bind its slot explicitly."""
    arm.animation_data.action = act
    arm.animation_data.action_slot = act.slots[0]


def bone_world(arm, name):
    return arm.matrix_world @ arm.pose.bones[name].head


def measure_walk(arm, act):
    """Loop period (frames) and stride (m per cycle) from the planted foot's speed."""
    sc = bpy.context.scene
    f0, f1 = (int(round(v)) for v in act.frame_range)
    use_action(arm, act)
    feet = {'L': [], 'R': []}
    for f in range(f0, f1 + 1):
        sc.frame_set(f)
        feet['L'].append(bone_world(arm, 'LeftFoot').copy())
        feet['R'].append(bone_world(arm, 'RightFoot').copy())
    speeds = []
    for pts in feet.values():
        zmin = min(p.z for p in pts)
        for a, b in zip(pts, pts[1:]):
            if a.z < zmin + 0.02 and b.z < zmin + 0.02:
                speeds.append(b.y - a.y)
    speed = float(np.median(speeds))
    # the first and last key hold the same pose when the clip loops seamlessly
    gap = (feet['L'][0] - feet['L'][-1]).length + (feet['R'][0] - feet['R'][-1]).length
    period = f1 - f0 if gap < 0.03 else f1 - f0 + 1
    print(f'walk keys {f0}..{f1}, loop gap {gap:.3f} m, period {period} frames, '
          f'planted-foot speed {speed:.4f} m/frame', flush=True)
    return period, abs(speed) * period


def arm_in_torso(arm, side):
    """Shoulder-to-wrist direction in the upper arm's parent rest frame (armature
    axes, torso pose undone), so a bent elbow counts."""
    pb = arm.pose.bones[f'{side}Arm']
    par = pb.parent
    undo = (par.matrix.to_3x3() @ par.bone.matrix_local.to_3x3().inverted()).inverted()
    return (undo @ (arm.pose.bones[f'{side}Hand'].head - pb.head)).normalized()


def lower_arms(arm, actions, target):
    """Meshy animates from its T-pose rest, which leaves the arms held out wide. Rotate
    each upper arm in the shoulder's frame (so the animated swing rides along) until
    its mean direction is `target` degrees from hanging straight down."""
    sc = bpy.context.scene
    down = Vector((0, 0, -1))
    for act in actions:
        use_action(arm, act)
        f0, f1 = (int(round(v)) for v in act.frame_range)
        cb = anim_utils.action_get_channelbag_for_slot(act, act.slots[0])
        for side in ('Left', 'Right'):
            mean = Vector()
            for f in range(f0, f1 + 1):
                sc.frame_set(f)
                mean += arm_in_torso(arm, side)
            mean.normalize()
            drop = mean.angle(down) - math.radians(target)
            off = Matrix.Rotation(drop, 3, mean.cross(down).normalized())
            B = arm.data.bones[f'{side}Arm'].matrix_local.to_3x3()
            q_off = (B.inverted() @ off @ B).to_quaternion()
            path = f'pose.bones["{side}Arm"].rotation_quaternion'
            fcs = [cb.fcurves.find(path, index=i) for i in range(4)]
            for k in range(len(fcs[0].keyframe_points)):
                q = q_off @ Quaternion([fc.keyframe_points[k].co[1] for fc in fcs])
                for i, fc in enumerate(fcs):
                    fc.keyframe_points[k].co[1] = q[i]
            for fc in fcs:
                fc.update()
            print(f'{act.name} {side}Arm: mean {math.degrees(mean.angle(down)):.1f} deg from '
                  f'hanging, lowered {math.degrees(drop):.1f}', flush=True)
    arm.animation_data.action = None


def _elbow_hinge(arm, actions, side):
    """Mean elbow flexion axis, in the upper arm's bone frame, over all clips."""
    fore = arm.data.bones[f'{side}ForeArm']
    to_upper = arm.data.bones[f'{side}Arm'].matrix_local.to_3x3().inverted() @ fore.matrix_local.to_3x3()
    acc = Vector()
    for act in actions:
        cb = anim_utils.action_get_channelbag_for_slot(act, act.slots[0])
        fcs = [cb.fcurves.find(f'pose.bones["{side}ForeArm"].rotation_quaternion', index=i) for i in range(4)]
        if not fcs[0]:
            continue
        for k in range(len(fcs[0].keyframe_points)):
            axis, ang = Quaternion([fc.keyframe_points[k].co[1] for fc in fcs]).to_axis_angle()
            if ang > math.pi:
                axis, ang = -axis, 2 * math.pi - ang
            acc += axis * ang
    return (to_upper @ acc).normalized()


def swing_arms(arm, actions, target):
    """Per key, turn each upper arm so it keeps its forward/back swing angle but hangs
    `target` degrees out from the side, and twist it so the elbow bends forward. A
    constant offset (lower_arms) turns Meshy's swing of the out-held arm into a sweep
    across the belly, with the forearm folding inward, which bulky armour and
    gambesons swallow; this keeps the hands swinging alongside the body."""
    sc = bpy.context.scene
    t = math.radians(target)
    fwd = Vector((0, -1, 0))
    Yb = Vector((0, 1, 0))
    for side in ('Left', 'Right'):
        sgn = 1 if side == 'Left' else -1
        hinge = _elbow_hinge(arm, actions, side)
        bend_local = hinge.cross(Yb).normalized()  # where the forearm swings as the elbow flexes
        B = arm.data.bones[f'{side}Arm'].matrix_local.to_3x3()
        pb = arm.pose.bones[f'{side}Arm']
        for act in actions:
            use_action(arm, act)
            cb = anim_utils.action_get_channelbag_for_slot(act, act.slots[0])
            path = f'pose.bones["{side}Arm"].rotation_quaternion'
            fcs = [cb.fcurves.find(path, index=i) for i in range(4)]
            offs = []
            for kp in fcs[0].keyframe_points:
                sc.frame_set(int(round(kp.co[0])))
                par = pb.parent
                undo = (par.matrix.to_3x3() @ par.bone.matrix_local.to_3x3().inverted()).inverted()
                U = undo @ pb.matrix.to_3x3()
                d = (U @ Yb).normalized()
                b = U @ bend_local
                b = (b - b.dot(d) * d).normalized()
                phi = math.atan2(-d.y, -d.z)  # swing in the side plane, forward positive
                d2 = Vector((sgn * math.sin(t), -math.cos(t) * math.sin(phi), -math.cos(t) * math.cos(phi)))
                b2 = (fwd - fwd.dot(d2) * d2).normalized()
                src = Matrix((d, b, d.cross(b))).transposed()
                dst = Matrix((d2, b2, d2.cross(b2))).transposed()
                off = dst @ src.transposed()
                offs.append((B.inverted() @ off @ B).to_quaternion())
            for k, q_off in enumerate(offs):
                q = q_off @ Quaternion([fc.keyframe_points[k].co[1] for fc in fcs])
                for i, fc in enumerate(fcs):
                    fc.keyframe_points[k].co[1] = q[i]
            for fc in fcs:
                fc.update()
    # Meshy's elbow flex suits arms held out; on a hanging arm it lifts the hand
    # across the belly, so keep only part of it
    for act in actions:
        cb = anim_utils.action_get_channelbag_for_slot(act, act.slots[0])
        for side in ('Left', 'Right'):
            fcs = [cb.fcurves.find(f'pose.bones["{side}ForeArm"].rotation_quaternion', index=i) for i in range(4)]
            if not fcs[0]:
                continue
            for k in range(len(fcs[0].keyframe_points)):
                q = Quaternion([fc.keyframe_points[k].co[1] for fc in fcs])
                q = Quaternion().slerp(q, ELBOW_KEEP)
                for i, fc in enumerate(fcs):
                    fc.keyframe_points[k].co[1] = q[i]
            for fc in fcs:
                fc.update()
    print(f'arms {target:.0f} deg out, swing kept, elbows bend forward ({ELBOW_KEEP:.0%} of the flex)', flush=True)
    arm.animation_data.action = None


def nla_clip(arm, name, act, length):
    ad = arm.animation_data or arm.animation_data_create()
    track = ad.nla_tracks.new()
    track.name = name
    start = act.frame_range[0]
    strip = track.strips.new(name, 0, act)
    strip.action_slot = act.slots[0]
    strip.name = name
    strip.action_frame_start = start
    strip.action_frame_end = start + length
    strip.frame_end = length
    return track


def main():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    sc = bpy.context.scene
    sc.render.fps = FPS

    arm, mesh, new = import_glb(os.path.join(SRC, 'walk.glb'))
    remove_objects([o for o in new if o.name not in (arm.name, mesh.name)])
    walk = arm.animation_data.action
    iarm, _, inew = import_glb(os.path.join(SRC, IDLE))
    idle = iarm.animation_data.action
    remove_objects(inew)
    run = None
    if HERO in UNITS and HERO not in FLYERS | HOVERERS:
        rarm, _, rnew = import_glb(os.path.join(SRC, 'run.glb'))
        run = rarm.animation_data.action
        remove_objects(rnew)
        run.name = f'{HERO}_run'
        run.use_fake_user = True
    arm.name = f'{NAME}Rig'
    mesh.name = NAME
    walk.name, idle.name = f'{HERO}_walk', f'{HERO}_idle'
    walk.use_fake_user = idle.use_fake_user = True

    setup_materials(mesh)
    rigid_gear(mesh)
    for t in list(arm.animation_data.nla_tracks):  # the importer stashes its clip here
        arm.animation_data.nla_tracks.remove(t)
    clips = [a for a in (walk, idle, run) if a]
    if HERO in FLYERS | HOVERERS:
        clips = [idle]
    if HERO in UNIT_ARMS:
        swing_arms(arm, clips, float(os.environ.get('ARM_ANGLE', UNIT_ARMS[HERO])))
    else:
        lower_arms(arm, clips, float(os.environ.get('ARM_ANGLE', ARM_ANGLE)))

    if HERO in FLYERS:
        # flight is the idle pose with quicker, fuller wing beats; the game plays it at
        # its own pace (the Walk clip isn't matched to a ground speed)
        add_wings(arm, mesh)
        walk = idle.copy()
        walk.name = f'{HERO}_fly'
        W = WINGS[HERO]
        flap(arm, walk, W['beat'][0], *W['fly'], W['axis'])
        flap(arm, idle, W['beat'][1], *W['hover'], W['axis'])
        w0, w1 = walk.frame_range
        period, stride = int(w1 - w0), 1.0
    elif HERO in HOVERERS:
        walk = idle.copy()
        walk.name = f'{HERO}_float'
        w0, w1 = walk.frame_range
        period, stride = int(w1 - w0), 1.0
    else:
        period, stride = measure_walk(arm, walk)
    if run:
        run_period, run_stride = measure_walk(arm, run)
        arm['run_stride'] = round(run_stride, 4)
    arm.animation_data.action = None
    sc.frame_set(0)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = mesh.evaluated_get(dg)
    height = max((mesh.matrix_world @ v.co).z for v in ev.data.vertices)
    arm['stride'] = round(stride, 4)
    arm['height'] = round(height, 3)
    i0, i1 = idle.frame_range
    nla_clip(arm, 'Idle', idle, i1 - i0)
    nla_clip(arm, 'Walk', walk, period)
    if run:
        nla_clip(arm, 'Run', run, run_period)
    print(f'{HERO}: {len(mesh.data.polygons)} faces, stride {stride:.3f} m/cycle '
          f'({period / FPS:.3f} s), height {height:.3f} m, idle {(i1 - i0) / FPS:.2f} s', flush=True)

    meshy_lib.downsize([mesh], TEX)
    if os.environ.get('EXPORT', '1') != '0':
        for o in bpy.context.selected_objects:
            o.select_set(False)
        arm.select_set(True)
        mesh.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.export_scene.gltf(
            filepath=OUT, export_format='GLB', use_selection=True, export_apply=False,
            export_texcoords=True, export_normals=True, export_vertex_color='NONE',
            export_image_format='JPEG', export_image_quality=88, export_materials='EXPORT',
            export_yup=True, export_cameras=False, export_lights=False, export_extras=True,
            export_skins=True, export_animations=True, export_animation_mode='NLA_TRACKS',
            export_force_sampling=True, export_optimize_animation_size=True, export_def_bones=False,
        )
        print(f'wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)', flush=True)

    if os.environ.get('PREVIEW'):
        preview(arm, os.environ['PREVIEW'], period)


def preview(arm, path, period):
    """EEVEE contact sheet of the walk (numpy-stitched, no PIL here)."""
    import math
    sc = bpy.context.scene
    frames = [int(f) for f in os.environ.get('FRAMES', f'0,{period // 4},{period // 2},{3 * period // 4}').split(',')]
    cols = int(os.environ.get('COLS', len(frames)))
    ang = math.radians(float(os.environ.get('CAM_ANGLE', '30')))
    for t in arm.animation_data.nla_tracks:
        t.mute = t.name != os.environ.get('CLIP', 'Walk')
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 600, 800
    sc.render.film_transparent = False
    world = bpy.data.worlds.new('W')
    world.color = (0.35, 0.38, 0.42)
    sc.world = world
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    d = 4.2
    cam.location = (math.sin(ang) * d, -math.cos(ang) * d, 1.0)
    cam.rotation_euler = (math.radians(86), 0, ang)
    cam.data.lens = 50
    sc.camera = cam
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
    sc.collection.objects.link(sun)
    fill = bpy.data.objects.new('Fill', bpy.data.lights.new('Fill', 'SUN'))
    fill.data.energy = 1.2
    fill.rotation_euler = (math.radians(70), 0, math.radians(200))
    sc.collection.objects.link(fill)
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
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.zeros((rows * h, cols * w, 4), np.float32)
    for i, t in enumerate(tiles):
        r = rows - 1 - i // cols  # image rows start at the bottom
        sheet[r * h:(r + 1) * h, (i % cols) * w:(i % cols + 1) * w] = t
    out = bpy.data.images.new('sheet', cols * w, rows * h)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    print(f'preview {path}', flush=True)


main()
