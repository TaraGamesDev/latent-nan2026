"""HOLDER — the catch tray that sits below the wall of plates.

Three of these sit side by side; each has three wells. The well interior stays a
separate material slot ("HolderWell") so it can be addressed independently.

Materials — taken from src/ui/scene.ts, not chosen here:
  HolderBody -> this.steelEdge (0x545c6a, metalness 0.84, roughness 0.50), the
                material the procedural tray this GLB replaces is built with.
  HolderWell -> this.hole      (0x333c4d, metalness 0.75, roughness 0.62), the
                material scene.ts:340 uses for the empty well.  The well is NOT
                tinted at runtime — the *cap* mesh dropped into it is (scene.ts
                sync()).  If that ever changes and the well does get tinted, this
                slot must go WHITE first, for the same reason ScrewHead is white:
                three.js multiplies the tint into baseColorFactor, so a dark base
                would silently crush every colour.
  Both were previously guessed in isolation (HolderBody sRGB #C3C7CC with NO
  metallicFactor at all, i.e. the glTF default 1.0).  Metalness 1.0 has zero
  diffuse response, and this scene runs environmentIntensity 0.34 with
  toneMappingExposure 0.78 — the tray came out darker and flatter than the box
  it replaces.  Explicit factors, matched to the game, fix that.

Shape
-----
A moulded rounded-corner tray, 2.02 x 0.90 x 0.34, with:
  * a 45 deg chamfer around the front edge,
  * a raised front rim (0.05 proud) so it reads as a container, not a plate,
  * a recessed inner panel,
  * three circular wells drilled into that panel with an explicit chamfered lip.

Axes (project convention)
-------------------------
Blender +Z = out of the wall toward the camera (the front face).
Blender +X = tray width, Blender +Y = tray height (screen up).
Exported with export_yup=True, so glTF(x,y,z) = Blender(x, z, -y):
three.js +Y comes out of the wall, three.js -Z is screen-up before the
integrator's single global rotation.

Run:
  "/Applications/Blender.app/Contents/MacOS/Blender" --background --factory-startup \
      --python assets/blender/holder.py
"""
import bpy, bmesh, math, os, struct, json
from mathutils import Vector

NAME = "holder"
OUT_GLB = "/Users/macbook/Documents/hackerton/nhn-ai/public/models/holder.glb"

# ------------------------------------------------------------------ dimensions
# Width and socket pitch are pinned to what the game already draws procedurally,
# so the GLB drops straight in. src/ui/scene.ts:319 computes
#   spacing = max(2.4, spanX / 3);  tray width = spacing * 0.84;  pitch = spacing * 0.24
# At the minimum spacing of 2.4 that is width 2.016 and pitch 0.576.
W, H, D = 2.02, 0.90, 0.34
HW, HH = W * 0.5, H * 0.5              # 1.01, 0.45
Z_BACK, Z_FRONT = -D * 0.5, D * 0.5    # -0.17, +0.17

NC = 4                                  # arc segments per rounded corner -> 20 pts/ring
CORNER_R = 0.13                         # outer corner radius
TAPER = 0.965                           # gentle draft: the back is slightly smaller

Z_EDGE = 0.140                          # where the front chamfer starts
Z_PANEL = 0.120                         # recessed inner panel (rim stands 0.05 proud)

CHAMF = 0.030                           # front edge chamfer (45 deg: 0.030 in, 0.030 up)
RIM_BAND = 0.050                        # flat top of the rim
WALL_IN = 0.012                         # draft on the rim's inner wall

# Wells.
#
# The socket has ONE hard requirement: it must swallow the head of screw.glb.
# Measured from the exported sibling asset, the ScrewHead primitive spans
# +/-0.215 in both cross-axes, i.e. a hex head of circumradius 0.215. Anything
# at or under that radius is a socket the screw cannot physically enter.
#
# The brief's "radius 0.30 at pitch 0.46" is geometrically impossible: 0.60
# diameter against 0.46 centres overlaps by 0.14 and merges neighbouring wells.
# Rather than shrink the well until it fits that pitch (0.19, which is SMALLER
# than the 0.215 head and so silently breaks the game), widen the pitch to the
# 0.576 the game already uses and take the largest radius that still leaves a
# land between lips and a margin to the rim:
#   panel half-width = HW - CHAMF - RIM_BAND - WALL_IN = 0.918
#   lip outer radius = R_WELL + C_LIP                  = 0.265
#   land between adjacent lips = 0.576 - 2 * 0.265     = 0.046
#   margin from outer lip to the rim wall = 0.918 - 0.576 - 0.265 = 0.077
#   clearance over the 0.215 screw head   = 0.245 - 0.215         = 0.030
# That also fixes a composition bug in the 0.46-pitch version: it left 0.186 of
# dead panel at each end while the wells crowded the centre at 0.036 apart.
WELL_X = (-0.576, 0.0, 0.576)
R_WELL = 0.245
C_LIP = 0.020                           # 45 deg chamfered lip -> outer lip r = 0.265
Z_FLOOR = Z_PANEL - 0.140               # -0.02, i.e. 0.14 deep from the panel
SEG = 24                                # lathe segments per well (20 read faceted)

BEVEL_W = 0.007
BEVEL_SEG = 2
SHARP_DEG = 30.0

BUDGET = 4000           # project-wide per-asset triangle cap, same in all four
                        # scripts.  This file used to check 2500 and plate.py
                        # 2500 while screw.py checked 4000; the low numbers were
                        # not a tighter local budget, just drift.


def srgb(hexcolour):
    """sRGB hex from src/ui/scene.ts -> the LINEAR triple glTF stores in
    baseColorFactor (and that three.js reads straight back into material.color).
    Pasting the sRGB value in raw is a silent ~2x brightness error."""
    out = []
    for shift in (16, 8, 0):
        c = ((hexcolour >> shift) & 0xFF) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)

# Circumradius of the hex head of screw.glb, measured from that exported file's
# ScrewHead primitive bounds (+/-0.215 on both cross-axes). The well has to be
# bigger than this or the screw cannot drop in. Re-measure if screw.glb changes.
SCREW_HEAD_R = 0.215


def check_geometry():
    """Fail the build rather than export a tray the screw cannot drop into.

    Every one of these was violated by an earlier revision, and none of them is
    visible in a render until you put a screw next to it."""
    panel_hw = HW - CHAMF - RIM_BAND - WALL_IN
    panel_hh = HH - CHAMF - RIM_BAND - WALL_IN
    lip = R_WELL + C_LIP
    pitch = WELL_X[1] - WELL_X[0]
    land = pitch - 2 * lip
    margin_x = panel_hw - max(WELL_X) - lip
    margin_y = panel_hh - lip
    clear = R_WELL - SCREW_HEAD_R
    assert clear > 0.01, (
        "well r=%.3f will not accept the screw head r=%.3f" % (R_WELL, SCREW_HEAD_R))
    assert land > 0.02, "wells overlap or leave no land: land=%.3f" % land
    assert margin_x > 0.02, "outer well breaks the rim wall: margin=%.3f" % margin_x
    assert margin_y > 0.02, "well breaks the rim wall vertically: margin=%.3f" % margin_y
    assert Z_FLOOR < Z_PANEL - C_LIP, "well floor is above its own chamfer"
    print("  CHECK head_clearance=%.3f land=%.3f margin_x=%.3f margin_y=%.3f depth=%.3f"
          % (clear, land, margin_x, margin_y, Z_PANEL - Z_FLOOR))



# ------------------------------------------------------------------ helpers
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def activate(obj):
    """Make obj the sole selected + active object. bpy.ops act on the selection,
    and silently no-op on the object you *meant* if it is not active.

    view_layer.objects is STALE after a manual collection.objects.link() -- in
    5.2 it keeps its old length but yields None for the new entries, so
    o.select_set() blows up with AttributeError. view_layer.update() resyncs it.
    (Probed: raw view_layer.objects == [] right after link, == [obj] after."""
    bpy.context.view_layer.update()
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


def new_material(name, rgb, metallic, rough):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    # The exporter writes glTF doubleSided from `not use_backface_culling`, and
    # Blender's default is False -> doubleSided:true -> three.js side=DoubleSide,
    # which shades the hidden interior of a closed solid for nothing.
    m.use_backface_culling = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    return m


def apply_modifier(obj, name):
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=name)


def boolean_cut(target, cutter):
    m = target.modifiers.new("Bool", 'BOOLEAN')
    m.operation, m.object, m.solver = 'DIFFERENCE', cutter, 'EXACT'
    apply_modifier(target, "Bool")
    bpy.data.objects.remove(cutter, do_unlink=True)   # hiding is NOT enough


def shade_hard_surface(obj, sharp_deg=SHARP_DEG):
    """Blender 5.2 replacement for the removed mesh.use_auto_smooth.
    Deliberately avoids shade_auto_smooth(), whose pinned 'Smooth by Angle'
    geometry-nodes modifier evaluates after Bevel and destroys harden_normals."""
    activate(obj)
    bpy.ops.object.shade_smooth()
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(sharp_deg),
                                         keep_sharp_edges=False)


def chamfer(obj, width=BEVEL_W, segments=BEVEL_SEG, angle_deg=SHARP_DEG):
    b = obj.modifiers.new("Bevel", 'BEVEL')
    b.width = width
    b.segments = segments
    b.limit_method = 'ANGLE'
    b.angle_limit = math.radians(angle_deg)
    b.harden_normals = True
    b.miter_outer = 'MITER_ARC'
    b.profile = 0.5
    w = obj.modifiers.new("WeightedNormal", 'WEIGHTED_NORMAL')
    w.mode = 'FACE_AREA_WITH_ANGLE'
    w.weight = 100
    w.keep_sharp = True


def rounded_rect(hw, hh, r, n):
    """CCW point list for a stadium/rounded rectangle in XY. 4*(n+1) points."""
    pts = []
    quads = ((hw - r, hh - r, 0.0), (-(hw - r), hh - r, 90.0),
             (-(hw - r), -(hh - r), 180.0), (hw - r, -(hh - r), 270.0))
    for cx, cy, a0 in quads:
        for i in range(n + 1):
            a = math.radians(a0 + 90.0 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


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


def lathe(profile, segs, name, cx, cy):
    """Closed solid of revolution about the Z axis through (cx, cy).
    `profile` is a top-to-bottom list of (radius, z); radius 0 makes a pole."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        if r <= 1e-9:
            rings.append([bm.verts.new((cx, cy, z))])
        else:
            rings.append([bm.verts.new((cx + r * math.cos(2 * math.pi * i / segs),
                                        cy + r * math.sin(2 * math.pi * i / segs), z))
                          for i in range(segs)])
    for k in range(len(rings) - 1):
        up, lo = rings[k], rings[k + 1]
        if len(up) == 1:
            for i in range(segs):
                bm.faces.new((up[0], lo[i], lo[(i + 1) % segs]))
        elif len(lo) == 1:
            for i in range(segs):
                bm.faces.new((up[i], up[(i + 1) % segs], lo[0]))
        else:
            for i in range(segs):
                j = (i + 1) % segs
                bm.faces.new((up[i], up[j], lo[j], lo[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


# ------------------------------------------------------------------ build
check_geometry()
reset_scene()

BODY_RGB, BODY_M, BODY_R = srgb(0x545C6A), 0.84, 0.50   # scene.ts this.steelEdge
WELL_RGB, WELL_M, WELL_R = srgb(0x333C4D), 0.75, 0.62   # scene.ts this.hole
MAT_BODY = new_material("HolderBody", BODY_RGB, BODY_M, BODY_R)
MAT_WELL = new_material("HolderWell", WELL_RGB, WELL_M, WELL_R)
print("  HolderBody linear=%s (sRGB #545C6A) metallic=%.2f rough=%.2f"
      % (tuple(round(c, 5) for c in BODY_RGB), BODY_M, BODY_R))
print("  HolderWell linear=%s (sRGB #333C4D) metallic=%.2f rough=%.2f"
      % (tuple(round(c, 5) for c in WELL_RGB), WELL_M, WELL_R))

# ---- 1. the shell: five stacked rounded-rect rings, back -> rim -> panel ----
r_edge = CORNER_R                                    # 0.130
r_top = CORNER_R - CHAMF                             # 0.100
r_rim = r_top - RIM_BAND                             # 0.050
r_pan = r_rim - WALL_IN                              # 0.038

RINGS = [
    (rounded_rect(HW * TAPER, HH * TAPER, CORNER_R * TAPER, NC), Z_BACK),
    (rounded_rect(HW, HH, r_edge, NC), Z_EDGE),
    (rounded_rect(HW - CHAMF, HH - CHAMF, r_top, NC), Z_FRONT),
    (rounded_rect(HW - CHAMF - RIM_BAND, HH - CHAMF - RIM_BAND, r_rim, NC), Z_FRONT),
    (rounded_rect(HW - CHAMF - RIM_BAND - WALL_IN,
                  HH - CHAMF - RIM_BAND - WALL_IN, r_pan, NC), Z_PANEL),
]

bm = bmesh.new()
rings = [[bm.verts.new((x, y, z)) for (x, y) in pts] for pts, z in RINGS]
n = len(rings[0])

bm.faces.new(list(reversed(rings[0])))               # back cap, normal -Z
for k in range(len(rings) - 1):                      # wall / chamfer / rim / inner wall
    lo, hi = rings[k], rings[k + 1]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
bm.faces.new(rings[-1])                              # recessed panel, normal +Z

bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
me = bpy.data.meshes.new(NAME)
bm.to_mesh(me)
bm.free()
body = bpy.data.objects.new(NAME, me)
bpy.context.collection.objects.link(body)
print("  shell built: verts=%d faces=%d" % (len(me.vertices), len(me.polygons)))

# ---- 2. drill the three wells ----------------------------------------------
# Profile, top to bottom: a wide cap floating above the panel (cuts nothing),
# the outer lip, the 45 deg chamfer down to full radius, the barrel, the floor.
WELL_PROFILE = [
    (0.0,               Z_PANEL + 0.09),
    (R_WELL + C_LIP,    Z_PANEL + 0.09),
    (R_WELL + C_LIP,    Z_PANEL),
    (R_WELL,            Z_PANEL - C_LIP),
    (R_WELL,            Z_FLOOR),
    (0.0,               Z_FLOOR),
]
for idx, wx in enumerate(WELL_X):
    cutter = lathe(WELL_PROFILE, SEG, "WellCut%d" % idx, wx, 0.0)
    boolean_cut(body, cutter)
print("  after wells: verts=%d faces=%d objects=%s"
      % (len(body.data.vertices), len(body.data.polygons),
         [o.name for o in bpy.context.scene.objects]))

# ---- 3. materials -----------------------------------------------------------
body.data.materials.clear()
body.data.materials.append(MAT_BODY)   # index 0
body.data.materials.append(MAT_WELL)   # index 1

lip_r = R_WELL + C_LIP + 0.004
n_well = 0
for p in body.data.polygons:
    c = p.center
    inside = (Z_FLOOR - 0.004) < c.z < (Z_PANEL - 0.0015)
    if inside and any(math.hypot(c.x - wx, c.y) < lip_r for wx in WELL_X):
        p.material_index = 1
        n_well += 1
    else:
        p.material_index = 0
print("  faces tagged HolderWell: %d / %d" % (n_well, len(body.data.polygons)))
assert n_well > 0, "no well faces found - the material test is wrong"

# ---- 4. shading + chamfer ---------------------------------------------------
body.name = body.data.name = NAME
shade_hard_surface(body)
chamfer(body)

# ---- 5. transforms ----------------------------------------------------------
activate(body)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
print("  scale=%s location=%s" % (tuple(body.scale), tuple(body.location)))

# ---- 6. export --------------------------------------------------------------
os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format='GLB',
    export_apply=True,
    export_materials='EXPORT',
    export_yup=True,
)

# ---- 7. stats + verify what actually landed in the file ---------------------
tris, verts = print_stats(body)

with open(OUT_GLB, "rb") as f:
    d = f.read()
jl = struct.unpack_from("<I", d, 12)[0]
js = json.loads(d[20:20 + jl].decode("utf-8"))
print("VERIFY file=%s size=%dB nodes=%s meshes=%s materials=%s"
      % (os.path.basename(OUT_GLB), len(d),
         [nd["name"] for nd in js["nodes"]],
         [m["name"] for m in js["meshes"]],
         [m["name"] for m in js["materials"]]))
# Frozen per-primitive bounds from the previous good export. A triangle count alone
# does not pin geometry — the sibling screw.py rebuilt its head at the wrong radius
# with an unchanged count when a material constant shadowed a dimension constant.
BASELINE = {
    "HolderBody": ([-1.0092, -0.1700, -0.4496], [1.0092, 0.1700, 0.4496]),
    "HolderWell": ([-0.8416, -0.0200, -0.2656], [0.8416, 0.1185, 0.2656]),
}
total = 0
for p in js["meshes"][0]["primitives"]:
    acc = js["accessors"][p["attributes"]["POSITION"]]
    t = js["accessors"][p["indices"]]["count"] // 3
    total += t
    nm = js["materials"][p["material"]]["name"]
    print("   prim mat=%s verts=%d tris=%d attrs=%s min=%s max=%s"
          % (nm, acc["count"], t, sorted(p["attributes"].keys()),
             [round(x, 4) for x in acc["min"]], [round(x, 4) for x in acc["max"]]))
    want_mn, want_mx = BASELINE[nm]
    for got, want in zip(acc["min"] + acc["max"], want_mn + want_mx):
        assert abs(got - want) < 5e-4, \
            "%s bounds moved: this pass must not change geometry" % nm
print("   glb total tris=%d" % total)

WANT = {"HolderBody": (BODY_RGB, BODY_M, BODY_R),
        "HolderWell": (WELL_RGB, WELL_M, WELL_R)}
for m in js["materials"]:
    pbr = m["pbrMetallicRoughness"]
    print("   MAT %s baseColorFactor=%s metallicFactor=%s roughnessFactor=%s "
          "doubleSided=%s"
          % (m["name"], [round(c, 6) for c in pbr["baseColorFactor"]],
             pbr.get("metallicFactor", "ABSENT(defaults 1.0)"),
             pbr.get("roughnessFactor", "ABSENT(defaults 1.0)"),
             m.get("doubleSided", False)))
    # An omitted metallicFactor is not neutral: glTF defaults it to 1.0, which
    # kills the diffuse term this dim scene relies on.  Demand it in the bytes.
    assert "metallicFactor" in pbr, "metallicFactor must be explicit, not defaulted"
    assert "roughnessFactor" in pbr, "roughnessFactor must be explicit"
    rgb, met, rgh = WANT[m["name"]]
    assert abs(pbr["metallicFactor"] - met) < 1e-4, "%s metallic" % m["name"]
    assert abs(pbr["roughnessFactor"] - rgh) < 1e-4, "%s roughness" % m["name"]
    for got, want in zip(pbr["baseColorFactor"], rgb + (1.0,)):
        assert abs(got - want) < 2e-3, "%s baseColorFactor" % m["name"]

print("BUDGET %s (%d tris, limit %d, headroom %d)"
      % ("ok" if tris < BUDGET else "EXCEEDED", tris, BUDGET, BUDGET - tris))
assert tris < BUDGET, "over the %d-triangle project budget" % BUDGET
assert tris == 1898, "holder tri count changed; this pass must not touch geometry"
print("HOLDER DONE")
