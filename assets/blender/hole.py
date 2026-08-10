"""hole.py — the empty BOLT HOLE that stays behind on a plate after its screw
is unscrewed.  Blender 5.2.0 LTS, headless.

    "/Applications/Blender.app/Contents/MacOS/Blender" --background --factory-startup \
        --python assets/blender/hole.py

WHAT IT IS
  A stamped washer seat with a real countersunk bore drilled through it.  The
  point of modelling actual geometry (rather than the dark disc the prototype
  uses today) is that the bore wall and floor pick up their own gradient under
  the single upper-left key, so the hole reads as a hole from every angle
  instead of as a printed dot.

ORIENTATION
  Origin sits exactly on the PLATE SURFACE PLANE (z = 0).  The bore runs into
  the plate along Blender -Z, i.e. away from the viewer.  export_yup=True maps
  Blender +Z -> three.js +Y, so in three.js the flange faces +Y (out of the
  wall, toward the camera) and the bore recedes toward -Y.  One global rotation
  for every asset in this set.

DIMENSIONS (three.js world units; 1 BU = 1 unit)
  flange outer radius   0.300   (= 1.40 x the measured 0.430 screw head dia)
  flange crown proud    0.014   (4.7% of radius: catches the key, never a puck)
  bore radius           0.155   (0.157 at the lip; 0.002 of draft down the wall
                                 so it shades as a gradient, not a dead flat)
  bore floor            z = -0.190, dipping to -0.210 at the drill point
  solid body bottom     z = -0.238  (closed, so it casts a clean shadow)

  The bore depth is set by the plate, not by taste: plate.glb is 0.260 thick
  (z = -0.130 .. +0.130) and this prop seats on its FRONT face, so the body
  bottom at -0.238 leaves 0.022 of plate behind it.  Depth from the countersink
  lip to the floor is 0.194 against a bore radius of 0.155 -- deep enough that
  the floor falls into its own shadow.  The first cut of this asset stopped at
  -0.140, and at that depth the flat floor caught the key square-on and the
  part rendered as a shallow DISH, not a hole.  Do not make it shallower.

GEOMETRY BUDGET
  Hand-lathed surface of revolution, so the count is exactly predictable:
      base   = 16 * SEGMENTS                    (2 pole fans + 7 quad bands)
      bevel  = 4 * SEGMENTS per weighted loop   (3 loops, 2 segments each)
      total  = 28 * SEGMENTS
  At SEGMENTS = 48 that is 768 + 576 = 1344, against the project cap of 4000
  and alongside siblings screw.glb (2908), holder.glb (1898) and plate.glb
  (1788) — all four measured out of the exported files.  SEGMENTS = 30
  (840 tris) was tried first and is NOT enough: the outer skirt is a bare
  0.6-unit-wide silhouette against the plate and the 30-gon facets are plainly
  countable in a render.  Circular silhouette is the whole read of this part;
  48 is the cheapest count that buys it.  The bevel is WEIGHT-limited rather
  than ANGLE-limited so only the three edges the player can actually see get
  chamfered; the hidden bottom rim and the crease at the base of the bore stay
  sharp (shade_smooth_by_angle keeps them crisp) and cost nothing.
"""
import bpy, bmesh, math, os, struct, json
from mathutils import Vector

NAME = "hole"
REPO = "/Users/macbook/Documents/hackerton/nhn-ai"
OUT_GLB = os.path.join(REPO, "public", "models", "%s.glb" % NAME)

SEGMENTS = 48
BUDGET = 4000          # the project-wide per-asset cap, shared by all four scripts
MAT_NAME = "HoleMetal"


def srgb(hexcolour):
    """sRGB hex from src/ui/scene.ts -> the LINEAR triple glTF stores in
    baseColorFactor (and that three.js reads straight back into material.color).
    Pasting the sRGB value in raw is a silent ~2x brightness error."""
    out = []
    for shift in (16, 8, 0):
        c = ((hexcolour >> shift) & 0xFF) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


# ============================================================ helpers
def reset_scene():
    # The background-mode startup scene is ['Cube','Light','Camera'] and the
    # cube WOULD be exported into the GLB.
    bpy.ops.wm.read_factory_settings(use_empty=True)


def activate(obj):
    """Make obj the sole selected + active object — bpy.ops act on the
    selection, and hitting the wrong object is a silent no-op."""
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


def new_material(name, rgb, metallic, rough):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    # Blender defaults to no backface culling, which exports as
    # "doubleSided": true and lands in three.js as side: DoubleSide — double
    # the raster and shadow-map work on a mesh that is a closed solid and is
    # instanced more than anything else in the scene.
    m.use_backface_culling = True
    return m


def shade_hard_surface(obj, sharp_deg=30.0):
    """Blender 5.2 replacement for mesh.use_auto_smooth.  Deliberately avoids
    bpy.ops.object.shade_auto_smooth(), whose 'Smooth by Angle' geometry-nodes
    modifier is pinned to the BOTTOM of the stack and would therefore recompute
    (destroy) the Bevel harden_normals / WeightedNormal result.
    shade_smooth_by_angle bakes a `sharp_edge` attribute and adds no modifier."""
    activate(obj)
    bpy.ops.object.shade_smooth()
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(sharp_deg),
                                         keep_sharp_edges=False)


def chamfer(obj, width, segments=2):
    """WEIGHT-limited bevel — only edges carrying bevel_weight_edge > 0."""
    b = obj.modifiers.new("Bevel", 'BEVEL')
    b.width = width
    b.segments = segments
    b.limit_method = 'WEIGHT'
    b.harden_normals = True          # defaults to False
    b.miter_outer = 'MITER_ARC'
    b.profile = 0.5
    w = obj.modifiers.new("WeightedNormal", 'WEIGHTED_NORMAL')
    w.mode = 'FACE_AREA_WITH_ANGLE'
    w.weight = 100
    w.keep_sharp = True
    return b, w


def print_stats(obj):
    deps = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(deps)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    tris, verts = len(me.loop_triangles), len(me.vertices)
    mats = [m.name if m else "<none>" for m in me.materials]
    mw = obj.matrix_world
    cos = [mw @ v.co for v in me.vertices]
    mn = Vector((min(c.x for c in cos), min(c.y for c in cos), min(c.z for c in cos)))
    mx = Vector((max(c.x for c in cos), max(c.y for c in cos), max(c.z for c in cos)))
    ev.to_mesh_clear()
    print("STATS %s tris=%d verts=%d bbox=%.4f,%.4f,%.4f,%.4f,%.4f,%.4f materials=%s"
          % (obj.name, tris, verts, mn.x, mn.y, mn.z, mx.x, mx.y, mx.z, ",".join(mats)))
    return tris, verts


# ============================================================ build
reset_scene()

# src/ui/scene.ts:184  this.hole = color 0x333c4d, metalness 0.75, roughness 0.62
# This prop replaces the flat recessed disc that scene.ts draws with `this.hole`,
# so it takes that material verbatim rather than a hand-picked dark steel.  The
# v1 values (linear 0.050/0.058/0.078 == sRGB #3F444F, metallic 0.85, rough 0.50)
# were close but not the same part: darker AND shinier, which in a scene running
# environmentIntensity 0.34 reads as a near-black pit instead of a machined bore.
MAT = new_material(MAT_NAME, srgb(0x333C4D), metallic=0.75, rough=0.62)
print("  HoleMetal baseColor linear=%s (from sRGB #333C4D) metallic=0.75 rough=0.62"
      % (tuple(round(c, 5) for c in srgb(0x333C4D)),))

# ---- 1. the lathe profile, (radius, z) --------------------------------------
# Walked from the bore floor centre, up the bore, out across the flange crown,
# down the outer skirt and back along the underside to the axis — a closed
# solid.  `bevel` marks the vertex ring that gets a weighted chamfer.
#
#   i   r        z         bevel   what
#   0   0.0000  -0.2100      -     drill-point centre (pole), 0.020 below the
#                                  floor rim -- a real twist drill leaves a cone,
#                                  and a cone tilts out of the key light instead
#                                  of bouncing it straight back at the camera
#   1   0.1150  -0.1900      -     bore floor rim
#   2   0.1550  -0.1715      -     floor -> wall fillet cone (sharp, unchamfered:
#                                  a crisp crease at the bottom of a drilled hole)
#   3   0.1570  -0.0420      Y     bore wall top
#   4   0.1980   0.0040      Y     countersink lip (~48 deg chamfer up to the seat)
#   5   0.2400   0.0120      -     seat crown, inner
#   6   0.2700   0.0140      -     seat crown, outer
#   7   0.3000   0.0080      Y     flange outer top edge
#   8   0.3000  -0.2380      -     skirt bottom (buried in the plate)
#   9   0.0000  -0.2380      -     underside centre (pole)
PROFILE = [
    (0.0000, -0.2100, False),
    (0.1150, -0.1900, False),
    (0.1550, -0.1715, False),
    (0.1570, -0.0420, True),
    (0.1980,  0.0040, True),
    (0.2400,  0.0120, False),
    (0.2700,  0.0140, False),
    (0.3000,  0.0080, True),
    (0.3000, -0.2380, False),
    (0.0000, -0.2380, False),
]

# Six shallow stamp marks pressed into the seat crown.  Pure z modulation, so
# they cost zero extra triangles.
#
# Two rules learned from rendering the first cut, both worth keeping:
#   * they must NOT touch profile index 7, the flange outer top edge.  That edge
#     is the part's silhouette.  Modulating it made the rim visibly wavy, and a
#     dented rim reads as a sloppy model, not as a stamped one.  Index 7 is now
#     perfectly circular and the marks live only on the crown top (5, 6).
#   * a mark one vertex wide is a pinch, not a dimple.  Each mark is spread over
#     three vertices (1.0 / 0.45 at either side) so it presses in as a soft flat.
# The resulting dihedral stays a few degrees, under the 30 deg sharp threshold,
# so the marks stay smooth-shaded and never catch a hard specular line.
MARK_EVERY = 8                          # 48 / 8 = 6 marks
MARK_DEPTH = {5: -0.0022, 6: -0.0034}   # profile index -> dz at the mark centre
MARK_FALLOFF = 0.45                     # relative depth one segment either side

N = SEGMENTS
assert N % MARK_EVERY == 0, "SEGMENTS must divide evenly by MARK_EVERY"
assert 7 not in MARK_DEPTH, "never modulate the silhouette edge"
ang = [2.0 * math.pi * k / N for k in range(N)]

# per-segment mark weight, built once
MARK_W = [0.0] * N
for _k0 in range(0, N, MARK_EVERY):
    MARK_W[_k0] = 1.0
    for _o in (-1, 1):
        _j = (_k0 + _o) % N
        MARK_W[_j] = max(MARK_W[_j], MARK_FALLOFF)

bm = bmesh.new()
top_pole = bm.verts.new((0.0, 0.0, PROFILE[0][1]))
bot_pole = bm.verts.new((0.0, 0.0, PROFILE[-1][1]))

rings = {}          # profile index -> vertex ring
for i in range(1, len(PROFILE) - 1):
    r, z, _ = PROFILE[i]
    ring = []
    for k in range(N):
        dz = MARK_DEPTH.get(i, 0.0) * MARK_W[k]
        ring.append(bm.verts.new((r * math.cos(ang[k]),
                                  r * math.sin(ang[k]),
                                  z + dz)))
    rings[i] = ring

# Winding: (along +profile) then (along +theta) gives outward normals — for the
# bore floor that is +Z, for the bore wall it is -radial (facing the axis), for
# the seat crown +Z, for the outer skirt +radial.  Asserted below.
for k in range(N):                                              # bore floor fan
    bm.faces.new((top_pole, rings[1][k], rings[1][(k + 1) % N]))
for i in range(1, len(PROFILE) - 2):                            # quad bands
    a, b = rings[i], rings[i + 1]
    for k in range(N):
        k2 = (k + 1) % N
        bm.faces.new((a[k], b[k], b[k2], a[k2]))
for k in range(N):                                              # underside fan
    bm.faces.new((rings[len(PROFILE) - 2][k], bot_pole,
                  rings[len(PROFILE) - 2][(k + 1) % N]))

me = bpy.data.meshes.new(NAME)
bm.to_mesh(me)
bm.free()
obj = bpy.data.objects.new(NAME, me)
bpy.context.collection.objects.link(obj)
obj.name = obj.data.name = NAME      # object AND mesh datablock, or the GLB
                                     # mesh comes out named something else

# ---- 2. assert the winding before anything depends on it --------------------
def _radial(v):
    return math.hypot(v.x, v.y)


def _radial_dot(p):
    return (Vector((p.center.x, p.center.y, 0.0)).normalized()
            .dot(Vector((p.normal.x, p.normal.y, 0.0)).normalized()))


# These windows are keyed to PROFILE — every one of them has a radial term as
# well as a z term, because with a deep bore the drill-point cone, the bore wall
# and the skirt all share overlapping z ranges and a z-only window silently
# matches the wrong band (which is how a winding bug gets through a green run).
checks = [
    ("drill point", [p for p in me.polygons
                     if p.center.z < -0.180 and _radial(p.center) < 0.11],
     lambda p: p.normal.z, +1.0, "faces the camera"),
    ("bore wall  ", [p for p in me.polygons
                     if -0.16 < p.center.z < -0.05 and _radial(p.center) < 0.20],
     _radial_dot, -1.0, "faces the axis"),
    ("seat crown ", [p for p in me.polygons
                     if p.center.z > 0.0 and 0.24 < _radial(p.center) < 0.29],
     lambda p: p.normal.z, +1.0, "faces the camera"),
    ("outer skirt", [p for p in me.polygons
                     if p.center.z < -0.02 and _radial(p.center) > 0.29],
     _radial_dot, +1.0, "faces outward"),
    ("underside  ", [p for p in me.polygons
                     if p.center.z < -0.230 and _radial(p.center) < 0.29],
     lambda p: p.normal.z, -1.0, "faces away"),
]
for label, faces, fn, want, why in checks:
    assert faces, "winding check '%s' matched no faces" % label
    got = fn(faces[0])
    print("  CHECK %s n=%3d  %+.3f (want %+.0f, %s)" % (label, len(faces), got, want, why))
    assert got * want > 0.9, "WINDING WRONG on %s" % label

# ---- 3. bevel weights on exactly the three visible edge loops ---------------
bw = me.attributes.new("bevel_weight_edge", 'FLOAT', 'EDGE')
targets = [(PROFILE[i][0], PROFILE[i][1]) for i in range(len(PROFILE))
           if PROFILE[i][2]]
weighted = 0
for idx, e in enumerate(me.edges):
    v0, v1 = (me.vertices[j].co for j in e.vertices)
    for tr, tz in targets:
        # A ring edge has BOTH endpoints on the profile ring.  Testing only one
        # endpoint also matches the vertical meridian edges of the skirt, whose
        # upper vertex shares the flange radius and z.  The tolerance is tight
        # on z as well as r: no beveled ring carries a stamp mark, so an exact
        # match is expected, and a loose z window would quietly re-admit one.
        if all(abs(_radial(v) - tr) < 1e-4 and abs(v.z - tz) < 1e-4
               for v in (v0, v1)):
            bw.data[idx].value = 1.0
            weighted += 1
            break
print("  bevel-weighted edges: %d  (expect %d = %d loops x %d)"
      % (weighted, len(targets) * N, len(targets), N))
assert weighted == len(targets) * N, "bevel weight selection is wrong"

# ---- 4. exactly one material ------------------------------------------------
me.materials.append(MAT)
for p in me.polygons:
    p.material_index = 0
assert [m.name for m in me.materials] == [MAT_NAME]

# ---- 5. shading, then chamfer (harden_normals is a no-op on a flat mesh) ----
shade_hard_surface(obj, sharp_deg=30.0)
chamfer(obj, width=0.0055, segments=2)

# ---- 6. transforms — unapplied scale would export as a node scale -----------
activate(obj)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
print("  obj.location =", tuple(round(v, 6) for v in obj.location),
      " obj.scale =", tuple(round(v, 6) for v in obj.scale))

# ---- 7. export --------------------------------------------------------------
os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format='GLB',
    export_apply=True,
    export_materials='EXPORT',
    export_yup=True,
)

# ---- 8. stats ---------------------------------------------------------------
tris, verts = print_stats(obj)
print("  predicted base=%d + bevel=%d = %d"
      % (16 * N, len(targets) * 4 * N, 16 * N + len(targets) * 4 * N))

# ---- 9. verify what actually landed on disk ---------------------------------
with open(OUT_GLB, "rb") as f:
    d = f.read()
jl = struct.unpack_from("<I", d, 12)[0]
js = json.loads(d[20:20 + jl].decode("utf-8"))
print("VERIFY file=%s size=%dB nodes=%s meshes=%s materials=%s images=%d"
      % (os.path.basename(OUT_GLB), len(d),
         [n["name"] for n in js["nodes"]],
         [m["name"] for m in js["meshes"]],
         [m["name"] for m in js["materials"]],
         len(js.get("images", []))))
prims = js["meshes"][0]["primitives"]
for p in prims:
    acc = js["accessors"][p["attributes"]["POSITION"]]
    print("   prim mat=%s verts=%d tris=%d attrs=%s min=%s max=%s"
          % (js["materials"][p["material"]]["name"], acc["count"],
             js["accessors"][p["indices"]]["count"] // 3,
             sorted(p["attributes"].keys()),
             [round(x, 4) for x in acc["min"]], [round(x, 4) for x in acc["max"]]))
for m in js["materials"]:
    pbr = m["pbrMetallicRoughness"]
    print("   MAT %s baseColorFactor=%s metallicFactor=%s roughnessFactor=%s "
          "doubleSided=%s"
          % (m["name"], [round(c, 6) for c in pbr["baseColorFactor"]],
             pbr.get("metallicFactor", "ABSENT(defaults 1.0)"),
             pbr.get("roughnessFactor", "ABSENT(defaults 1.0)"),
             m.get("doubleSided", False)))
    # glTF defaults an omitted metallicFactor to 1.0, and at metalness 1.0 there
    # is no diffuse term at all — under this scene's environmentIntensity 0.34
    # that is the difference between a machined part and a dark silhouette.
    assert "metallicFactor" in pbr, "metallicFactor must be explicit, not defaulted"
    assert "roughnessFactor" in pbr, "roughnessFactor must be explicit"
    assert abs(pbr["metallicFactor"] - 0.75) < 1e-4, "HoleMetal metallic != 0.75"
    assert abs(pbr["roughnessFactor"] - 0.62) < 1e-4, "HoleMetal roughness != 0.62"
    for got, want in zip(pbr["baseColorFactor"], srgb(0x333C4D) + (1.0,)):
        assert abs(got - want) < 2e-3, "HoleMetal baseColorFactor != linear #333C4D"
assert len(prims) == 1, "expected a single primitive"
assert len(js["materials"]) == 1 and js["materials"][0]["name"] == MAT_NAME
assert js["materials"][0].get("doubleSided") is not True, \
    "doubleSided would become side: DoubleSide in three.js"
assert "images" not in js, "no textures may ship in this GLB"
assert "COLOR_0" not in prims[0]["attributes"], \
    "vertex colours would multiply three.js instanceColor"
assert "NORMAL" in prims[0]["attributes"], \
    "missing normals would force flatShading in GLTFLoader"
print("BUDGET ok (%d < %d)" % (tris, BUDGET) if tris < BUDGET
      else "BUDGET EXCEEDED (%d >= %d)" % (tris, BUDGET))
assert tris < BUDGET, "over the %d-triangle project budget" % BUDGET
assert tris == 1344, "hole tri count changed; this pass must not touch geometry"

# ---- 10. the integration constraint, derived from the profile ---------------
# Everything below z = 0 is inside the plate.  A solid plate front face at z = 0
# depth-occludes it, so the plate needs a bore at least as wide as the widest
# part of this prop that dips below the surface plane — that is where the
# countersink cone crosses z = 0.
(r_lip, z_lip, _), (r_bore, z_bore, _) = PROFILE[4], PROFILE[3]
t = (z_lip - 0.0) / (z_lip - z_bore)
r_min = r_lip - t * (r_lip - r_bore)
print("INTEGRATION plate must be bored to radius >= %.4f (recommend %.2f; "
      "anything up to %.3f is hidden by the flange skirt). A solid plate face "
      "at z=0 occludes the whole bore."
      % (r_min, 0.20, PROFILE[7][0]))

# Depth budget: this prop seats on the plate's FRONT face, so everything below
# z = 0 eats into the plate's thickness.  plate.glb measures 0.260 thick.
PLATE_THICKNESS = 0.260
depth = -min(z for _, z, _ in PROFILE)
print("INTEGRATION depth below the surface plane = %.4f of the plate's %.3f "
      "thickness (%.3f to spare). Bore depth lip->floor = %.4f."
      % (depth, PLATE_THICKNESS, PLATE_THICKNESS - depth,
         PROFILE[4][1] - PROFILE[1][1]))
assert depth < PLATE_THICKNESS, \
    "the prop is deeper than the plate is thick — it would poke out the back"
print("HOLE DONE")
