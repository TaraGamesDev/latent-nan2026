"""PLATE — the bolted steel panel of the unscrew-the-plates wall.

Built as a swept rounded-rectangle profile so it is a true 3D NINE-SLICE:

  * plan size 2.0 x 2.0 (half-extent 1.0), thickness 0.26 (z in [-0.13, +0.13])
  * EVERY corner arc of EVERY profile ring shares the same arc centre, +-0.74,
    because ring radius r_i and corner radius (R_OUT - inset_i) are offset by the
    same amount:  centre = r_i - (0.26 - (1.0 - r_i)) = 0.74  for all i.
    => no vertex anywhere in the mesh has |x| < 0.74 or |y| < 0.74.
  * the innermost profile ring sits at r = 0.812, i.e. all detail is inside
    0.19 of the outer border, and the whole middle is one flat n-gon cap with
    zero interior vertices.
  * so the integrator can translate every vertex with x > t outward (any
    split threshold 0 < t < 0.74) and the plate grows without touching a bevel.

Front face (the one that must point out of the wall at the camera) is +Z in
Blender, which export_yup=True maps to +Y in three.js.

READ THIS BEFORE RE-TUNING THE PROFILE.  The v1 profile put a RAISED LIP RING
cresting proud of the flat field, and split the 0.26 thickness into ~77% taper
and only 23% vertical rim.  Rendered, that is not a steel plate — it is a
moulded appliance lid.  Two rules keep it hard-surface:

  (a) THE FLAT FIELD IS THE FRONTMOST PLANE.  Nothing on the border may stick
      out in front of z = +0.130.  A border that rises above the face is the
      single strongest "plastic lid" cue there is.
  (b) THE VERTICAL RIM MUST DOMINATE THE EDGE.  Here the silhouette band at
      r = 1.000 spans z = +0.052 .. -0.072, i.e. 0.124 of the 0.26 thickness
      (48%), and it is bounded by ONE long 39.7 deg chamfer above and one short
      39.6 deg undercut below.  Long flat facets with big angular breaks are
      what produce a crisp highlight line; a stack of short facets each breaking
      by a little just reconstructs a smooth roll.

MATERIAL — exactly one, "PlateSteel", and it is NOT chosen in isolation.
  This GLB replaces the procedural rounded box that src/ui/scene.ts builds with
  `this.steel`, so it has to match that material or the swap is visible:
      steel = color 0x767f8e, metalness 0.86, roughness 0.46
  The v1 build shipped metallic 1.0 with no explicit metallicFactor at all (glTF
  defaults it to 1.0) on the theory that "a half-metal renders chalky".  That is
  true in a bright studio HDRI and false here: scene.ts runs
  environmentIntensity = 0.34 and toneMappingExposure = 0.78, and at metalness
  1.0 a Principled/Standard surface has NO diffuse term whatsoever — every photon
  it shows comes from that dimmed environment plus two directional lights.  The
  result is a plate markedly darker and flatter than the box it replaces.  0.86
  keeps 14% diffuse, which is what carries the value in a dim room.

  Base colour is written to glTF as baseColorFactor, which is LINEAR, so the
  sRGB hex from scene.ts is converted through srgb() below rather than pasted in.

UVs — the plate is the only asset in this set that gets any, because it is the
largest thing on screen and carries a tiling brushed-steel roughness map.
  Projection: uv = (x, y) * UV_PER_UNIT, a planar projection in the plane of the
  plate, applied in WORLD units and deliberately NOT normalised to a 0-1 box.
  A 0-1 box unwrap is wrong here for a specific reason: the integrator resizes
  this plate with the 3D nine-slice described above, which TRANSLATES border
  vertices outward.  With a 0-1 unwrap the same 0-1 range would then cover a
  wider plate and the brushed grain would visibly stretch.  With uv = pos * K the
  fix is exact and trivial:

      INTEGRATION CONTRACT — when the nine-slice translates a vertex by
      (dx, dy), translate that vertex's uv by (dx * K, dy * K), K = UV_PER_UNIT.

  so texel density stays at a constant real-world scale at every plate size.
  (Blender's exporter flips V — it writes v_gltf = 1 - v_blender — so V is
  pre-flipped below and the GLB really does contain uv = pos * K.)
"""
import bpy, bmesh, math, os, struct, json
from mathutils import Vector

NAME    = "plate"
REPO    = "/Users/macbook/Documents/hackerton/nhn-ai"
OUT_GLB = os.path.join(REPO, "public", "models", "plate.glb")

# ---------------------------------------------------------------- parameters
HALF      = 1.0        # plan half-extent
R_CORNER  = 0.26       # plan-view corner radius at the outer silhouette.
                       #   0.34 (17% of the width) read as soft-goods moulding;
                       #   0.26 reads machined and still catches a corner highlight
ARC_C     = HALF - R_CORNER   # 0.74 — corner-arc centre, identical on every ring
ARC_SEG   = 6          # segments per 90 deg corner  -> 15 deg facets, under the
                       #   30 deg sharp threshold so corners stay smooth-shaded
BEVEL_W   = 0.007      # 0.010 ate too much of each facet; the flats need to survive
BEVEL_SEG = 3          # 3 segments rolls the highlight instead of stair-stepping it
SHARP_DEG = 30.0

# ---------------------------------------------------------------- UV scale
# UV units per world unit.  2.0 => one texture tile spans 0.5 world units, so the
# 2.0-wide authored plate shows 4 tiles across.  Picked to land on the crisp end
# of what the procedural version already produced: scene.ts sets repeat (3,3) on
# a per-face 0-1 box unwrap of a plate that is p.w * 1.55 - 0.1 wide, i.e. a tile
# of 0.483 world units for a 1x1 plate but 1.0 for a 2x1 one — the density drifts
# with plate size, which is exactly the bug a world-scaled UV removes.
UV_PER_UNIT   = 2.0                  # K
UV_TILE_WORLD = 1.0 / UV_PER_UNIT    # 0.5 world units per tile


def srgb(hexcolour):
    """sRGB hex from scene.ts -> the LINEAR triple glTF stores in
    baseColorFactor (and that three.js reads straight back into material.color).
    Pasting the sRGB value in raw is a silent ~2x brightness error."""
    out = []
    for shift in (16, 8, 0):
        c = ((hexcolour >> shift) & 0xFF) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)

# Swept cross-section, traversed from the FRONT cap boundary, outward over the
# border, round the edge, and back to the BACK cap boundary.  (r, z).
# EVERY ring below breaks by 39.6 deg or more, i.e. all eight are over the 30 deg
# threshold, so all eight become sharp edges and all eight get a bevel: eight
# crisp highlight lines instead of one continuous roll.
#   0-3   pressed groove ring — 0.038 DEEP but only 0.032 wide at the floor.
#         Deeper than it is wide is what makes it read as a stamped line rather
#         than a dished channel; v1's 0.022-deep / 0.072-wide groove read soft.
#   3-4   flat border land, still at the full +0.130 (never proud of the field)
#   4-5   ONE long 39.7 deg chamfer facet (0.122 long), sharp at both ends
#         -> this is the highlight streak that sells the whole part
#   5-6   tall flat vertical rim band, 48% of the thickness -> the dark side wall
#   6-7   ONE short 39.6 deg undercut so the back is narrower than the front and
#         the rim self-shades clear of whatever is stacked beneath it
PROFILE = [
    (0.812,  0.130),   #  0  front cap boundary — flat field, the frontmost plane
    (0.828,  0.092),   #  1  groove inner wall foot
    (0.860,  0.092),   #  2  groove floor, outer end
    (0.876,  0.130),   #  3  groove outer wall top
    (0.906,  0.130),   #  4  border land, outer end (crisp break into the chamfer)
    (1.000,  0.052),   #  5  silhouette, top of the vertical rim band
    (1.000, -0.072),   #  6  silhouette, bottom of the vertical rim band
    (0.952, -0.130),   #  7  back cap boundary
]


# ---------------------------------------------------------------- helpers
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def activate(obj):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


def new_material(name, rgb, metallic, rough):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    # exports as glTF doubleSided=false -> THREE.FrontSide. Without this Blender
    # writes doubleSided=true, which costs a second fragment pass on every one of
    # the hundreds of instances for a closed solid that never shows a backface.
    m.use_backface_culling = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    return m


def shade_hard_surface(obj, sharp_deg=SHARP_DEG):
    activate(obj)
    bpy.ops.object.shade_smooth()
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(sharp_deg),
                                         keep_sharp_edges=False)


def chamfer(obj, width, segments, angle_deg):
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


def ring_points(r):
    """Rounded-rectangle loop of 4*(ARC_SEG+1) points, CCW seen from +Z.
    Corner arc centre is ARC_C on both axes for every r, by construction."""
    rad = r - ARC_C
    assert rad > 1e-6, "ring r=%.4f must exceed arc centre %.4f" % (r, ARC_C)
    centres = [(ARC_C, ARC_C), (-ARC_C, ARC_C), (-ARC_C, -ARC_C), (ARC_C, -ARC_C)]
    starts = [0.0, 90.0, 180.0, 270.0]
    pts = []
    for k in range(4):
        cx, cy = centres[k]
        for j in range(ARC_SEG + 1):
            a = math.radians(starts[k] + 90.0 * j / ARC_SEG)
            pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    return pts


def profile_dihedrals():
    """Report the cross-section break angle at every ring so it is obvious
    which loops the 30 deg sharp/bevel threshold will catch."""
    dirs = []
    for i in range(len(PROFILE) - 1):
        dr = PROFILE[i + 1][0] - PROFILE[i][0]
        dz = PROFILE[i + 1][1] - PROFILE[i][1]
        dirs.append(math.degrees(math.atan2(dz, dr)))
    dirs.insert(0, 0.0)          # front cap is flat: direction 0
    dirs.append(180.0)           # back cap is flat: direction 180
    out = []
    for i in range(len(PROFILE)):
        d = abs(dirs[i + 1] - dirs[i]) % 360.0
        d = min(d, 360.0 - d)
        out.append((i, PROFILE[i][0], PROFILE[i][1], d, "SHARP" if d > SHARP_DEG else "smooth"))
    return out


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
    return tris, verts, cos


def verify_nine_slice(cos):
    """The brief's own test: no vertex may sit in 0.35 < |x| < 0.55 unless it
    also lies in the border band (|y| >= 0.55) on the other axis, and mirrored."""
    BAND_LO, BAND_HI = 0.35, 0.55
    bad = []
    for c in cos:
        ax, ay = abs(c.x), abs(c.y)
        if BAND_LO < ax < BAND_HI and ay < BAND_HI:
            bad.append(("x", c.x, c.y, c.z))
        if BAND_LO < ay < BAND_HI and ax < BAND_HI:
            bad.append(("y", c.x, c.y, c.z))
    min_ax = min(abs(c.x) for c in cos)
    min_ay = min(abs(c.y) for c in cos)
    min_cheb = min(max(abs(c.x), abs(c.y)) for c in cos)
    n_inside = sum(1 for c in cos if abs(c.x) < BAND_HI and abs(c.y) < BAND_HI)
    print("NINESLICE min|x|=%.4f min|y|=%.4f min_max(|x|,|y|)=%.4f "
          "verts_inside_0.55_box=%d violations=%d"
          % (min_ax, min_ay, min_cheb, n_inside, len(bad)))
    for b in bad[:10]:
        print("   VIOLATION axis=%s xyz=%.4f,%.4f,%.4f" % b)
    print("NINESLICE %s" % ("PASS" if not bad else "FAIL"))
    return not bad


# ---------------------------------------------------------------- build
reset_scene()
# src/ui/scene.ts:172  this.steel = color 0x767f8e, metalness 0.86, roughness 0.46
# Matched exactly. Not "a nice steel" — THE steel this mesh is dropped in to
# replace, under environmentIntensity 0.34 / exposure 0.78.
MAT = new_material("PlateSteel", srgb(0x767F8E), 0.86, 0.46)
print("  PlateSteel baseColor linear=%s (from sRGB #767F8E) metallic=%.2f rough=%.2f"
      % (tuple(round(c, 5) for c in srgb(0x767F8E)), 0.86, 0.46))

print("profile break angles (threshold %.0f deg):" % SHARP_DEG)
for i, r, z, d, tag in profile_dihedrals():
    print("   ring %2d  r=%.3f z=%+.3f  break=%5.1f  %s" % (i, r, z, d, tag))

me = bpy.data.meshes.new(NAME)
obj = bpy.data.objects.new(NAME, me)
bpy.context.collection.objects.link(obj)

bm = bmesh.new()
N = 4 * (ARC_SEG + 1)
rings = []
for (r, z) in PROFILE:
    rings.append([bm.verts.new((x, y, z)) for (x, y) in ring_points(r)])
for i in range(len(rings) - 1):
    a, b = rings[i], rings[i + 1]
    for j in range(N):
        k = (j + 1) % N
        bm.faces.new((a[j], a[k], b[k], b[j]))
bm.faces.new(rings[0])                     # front cap  (flat, vertex-free middle)
bm.faces.new(list(reversed(rings[-1])))    # back cap   (flat, vertex-free middle)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
bm.to_mesh(me)
bm.free()
print("  built: verts=%d faces=%d  (ring verts N=%d, rings=%d)"
      % (len(me.vertices), len(me.polygons), N, len(rings)))

me.materials.append(MAT)
for p in me.polygons:
    p.material_index = 0

# ---------------------------------------------------------------- UVs
# Planar projection in the plane of the plate (Blender XY == the front face's own
# plane; export_yup maps it to glTF XZ, the +Y-facing face).  Written BEFORE the
# bevel so the modifier interpolates the chamfer strips into it; the strips are
# BEVEL_W = 0.007 wide, so the most any of them can deviate from the exact
# projection is 0.007 * K = 0.014 UV, and that is asserted against the decoded
# GLB at the bottom of this file rather than assumed.
#
# V is stored pre-flipped: io_scene_gltf2 writes v_gltf = 1 - v_blender, so
# v_blender = 1 - y*K comes out of the exporter as exactly v_gltf = y*K.
uvl = me.uv_layers.new(name="UVMap")
for poly in me.polygons:
    for li in poly.loop_indices:
        co = me.vertices[me.loops[li].vertex_index].co
        uvl.data[li].uv = (co.x * UV_PER_UNIT, 1.0 - co.y * UV_PER_UNIT)
print("  UV: planar XY, uv = pos * %.3f  (1 tile = %.3f world units, %.1f tiles "
      "across the %.1f-wide plate); loops=%d layer=%s"
      % (UV_PER_UNIT, UV_TILE_WORLD, 2 * HALF / UV_TILE_WORLD, 2 * HALF,
         len(me.loops), uvl.name))

shade_hard_surface(obj, SHARP_DEG)
print("  sharp edges baked:",
      sum(1 for e in me.edges if e.use_edge_sharp)
      if hasattr(me.edges[0], "use_edge_sharp") else "n/a")

chamfer(obj, BEVEL_W, BEVEL_SEG, SHARP_DEG)

activate(obj)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
obj.name = obj.data.name = NAME
print("  obj.scale=%s location=%s" % (tuple(obj.scale), tuple(obj.location)))

# ---------------------------------------------------------------- export
os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format='GLB',
    export_apply=True,
    export_materials='EXPORT',
    export_texcoords=True,     # explicit: no texture is bound to PlateSteel, and
                               # the UV set must survive anyway — the game binds a
                               # runtime-generated brushed roughness map to it.
    export_yup=True,
)

tris, verts, cos = print_stats(obj)
ok_slice = verify_nine_slice(cos)

# ---------------------------------------------------------------- verify GLB
# Everything below reads the FILE, not this script's variables.
CT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
      5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def glb_chunks(raw):
    off, jsn, binc = 12, None, None
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        body = raw[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            jsn = json.loads(body.decode("utf-8"))
        elif ctype == 0x004E4942:
            binc = body
        off += 8 + clen
    return jsn, binc


def accessor(jsn, binc, i):
    a = jsn["accessors"][i]
    fmt, sz = CT[a["componentType"]]
    n = NC[a["type"]]
    bv = jsn["bufferViews"][a["bufferView"]]
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or sz * n
    return [struct.unpack_from("<" + fmt * n, binc, base + k * stride)
            for k in range(a["count"])]


with open(OUT_GLB, "rb") as f:
    d = f.read()
js, bn = glb_chunks(d)
print("VERIFY file=%s size=%dB nodes=%s meshes=%s materials=%s images=%d"
      % (os.path.basename(OUT_GLB), len(d),
         [n["name"] for n in js["nodes"]],
         [m["name"] for m in js["meshes"]],
         [m["name"] for m in js["materials"]],
         len(js.get("images", []))))
for m in js["materials"]:
    pbr = m.get("pbrMetallicRoughness", {})
    print("   MAT %s baseColorFactor=%s metallicFactor=%s roughnessFactor=%s "
          "doubleSided=%s"
          % (m["name"],
             [round(c, 6) for c in pbr["baseColorFactor"]],
             pbr.get("metallicFactor", "ABSENT(defaults 1.0)"),
             pbr.get("roughnessFactor", "ABSENT(defaults 1.0)"),
             m.get("doubleSided", False)))
    # An absent factor is not "the same as not caring": glTF defaults BOTH to 1.0,
    # and metallic 1.0 kills the diffuse term this dim scene depends on.
    assert "metallicFactor" in pbr, "metallicFactor must be explicit, not defaulted"
    assert "roughnessFactor" in pbr, "roughnessFactor must be explicit"
    assert abs(pbr["metallicFactor"] - 0.86) < 1e-4, "PlateSteel metallic != 0.86"
    assert abs(pbr["roughnessFactor"] - 0.46) < 1e-4, "PlateSteel roughness != 0.46"
    for got, want in zip(pbr["baseColorFactor"], srgb(0x767F8E) + (1.0,)):
        assert abs(got - want) < 2e-3, "PlateSteel baseColorFactor != linear #767F8E"

glb_tris = 0
for p in js["meshes"][0]["primitives"]:
    acc = js["accessors"][p["attributes"]["POSITION"]]
    glb_tris += js["accessors"][p["indices"]]["count"] // 3
    print("   prim mat=%s verts=%d tris=%d attrs=%s min=%s max=%s"
          % (js["materials"][p["material"]]["name"], acc["count"],
             js["accessors"][p["indices"]]["count"] // 3,
             sorted(p["attributes"].keys()),
             [round(x, 4) for x in acc["min"]], [round(x, 4) for x in acc["max"]]))
    assert "TEXCOORD_0" in p["attributes"], "plate.glb must carry UVs"

# ---- the UV claim, checked against the bytes ---------------------------------
prim = js["meshes"][0]["primitives"][0]
POS = accessor(js, bn, prim["attributes"]["POSITION"])
UV = accessor(js, bn, prim["attributes"]["TEXCOORD_0"])
NRM = accessor(js, bn, prim["attributes"]["NORMAL"])
assert len(POS) == len(UV)
us = [u for u, _ in UV]
vs = [v for _, v in UV]
# glTF is y-up here: gltf(x, y, z) = blender(x, z, -y), so the plate's own plane
# is glTF XZ and the projection must read uv = (x, -z) * K.
err = max(max(abs(UV[i][0] - POS[i][0] * UV_PER_UNIT),
              abs(UV[i][1] + POS[i][2] * UV_PER_UNIT)) for i in range(len(POS)))
# Front face = the +Y-facing loops. Those are the ones that must be exact.
front = [i for i in range(len(POS)) if NRM[i][1] > 0.999]
ferr = max(max(abs(UV[i][0] - POS[i][0] * UV_PER_UNIT),
               abs(UV[i][1] + POS[i][2] * UV_PER_UNIT)) for i in front)
print("UV range u=[%.4f, %.4f] v=[%.4f, %.4f] span=%.4f x %.4f tiles"
      % (min(us), max(us), min(vs), max(vs), max(us) - min(us), max(vs) - min(vs)))
print("UV scale K=%.4f uv/world-unit -> %.4f world units per tile; "
      "max|uv - pos*K| whole mesh=%.6f, front face (n=%d)=%.9f"
      % (UV_PER_UNIT, UV_TILE_WORLD, err, len(front), ferr))
# 1e-5 is the float32 storage floor, not slack: measured ferr is ~7e-7.
assert ferr < 1e-5, "front face UV is not the exact planar projection"
assert err < BEVEL_W * UV_PER_UNIT * 1.5, \
    "some UV drifted further than the chamfer width can explain: %.6f" % err

# ---- budget: project-wide, 4000 tris per asset (screw.py, hole.py, holder.py) --
BUDGET = 4000
print("BUDGET %s (%d tris, limit %d, headroom %d)"
      % ("ok" if tris < BUDGET else "EXCEEDED", tris, BUDGET, BUDGET - tris))
assert tris < BUDGET, "over the %d-triangle project budget" % BUDGET
assert glb_tris == tris, "GLB tri count disagrees with the evaluated mesh"
print("RESULT %s" % ("OK" if (tris < BUDGET and ok_slice) else "PROBLEM"))
