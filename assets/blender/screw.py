"""Hero prop: the SCREW for the "unscrew the plates" puzzle wall.

Built for Blender 5.2 LTS, headless:
  "/Applications/Blender.app/Contents/MacOS/Blender" --background --factory-startup \
      --python /Users/macbook/Documents/hackerton/nhn-ai/assets/blender/screw.py

FORM
  Cross-recess (+ dialect, axis-aligned) PAN head with the genre's two-concentric-circle
  signature: outer head edge at D, raised inner boss at 0.85 * D. A thin integrated
  seating flange under the head (slightly wider than the head) puts the origin exactly on
  the plate face. Threaded shaft below with a real helical ridge (7 turns).

  NOTE ON HEAD STYLE: the asset brief asked for a hex head; the art-direction rules
  supplied alongside it forbid hex heads for board fasteners ("cross-recess pan head,
  essentially universally ... I found no slotted, no socket cap, and no hex *heads*
  anywhere in the plate sub-genre"). The two inputs contradict each other. This build
  follows the art direction and ships the pan head.

  HEAD_STYLE = "hex" builds the brief's version instead and has been run and rendered:
  it snaps the head and boss (everything above z = 0.055) to a hexagon of the same
  across-flats, 0.40, circumradius 0.2304, leaving the flange and shaft round. Same
  materials, same origin, same recess, 2704 tris. The only cosmetic side effect is that
  the hex corners overhang the 0.215-radius flange, so the round flange shows between
  them. Switch with the constant below or on the command line (see the sweep args).

AXES
  Modelled Z-up. Exported with export_yup=True, so glTF(x,y,z) = Blender(x, z, -y):
  Blender +Z becomes three.js +Y. The head therefore points along three.js +Y, i.e. out
  of the wall toward the camera. Origin sits on the seating plane (flange underside).

MATERIALS (exactly two, names are load-bearing) — values taken from
src/ui/scene.ts, not invented here.
  ScrewHead  -> head + flange. The game recolours THIS one per screw, from
                COLOUR_HEX at metalness 0.45 / roughness 0.28.
                Base colour is WHITE, and that is not laziness — three.js
                MULTIPLIES the runtime tint into baseColorFactor. The v1 build
                shipped 0.840/0.848/0.862 (sRGB #ECEDEF), which is 0.84 linear
                grey: every one of the eight anodised colours would have come
                out ~16% dark, uniformly, in a way no single colour looks wrong
                enough to catch. White is the only value that lets COLOUR_HEX
                arrive unchanged.
                Blender's exporter DROPS baseColorFactor when it is exactly
                [1,1,1,1] because that is the glTF default, so this file stamps
                it back in after export (see step 8b) — the field being present
                and white is the whole contract with the renderer, and it should
                not have to be inferred from an absence.
  ScrewMetal -> shaft, thread, and the inside of the drive recess. Stays steel:
                scene.ts this.shaftMat = 0x3d4453, metalness 0.85, roughness 0.50.
                v1 wrote NO metallicFactor at all, which glTF defaults to 1.0.
                At metalness 1.0 there is no diffuse term whatsoever, and this
                scene runs environmentIntensity 0.34 with toneMappingExposure
                0.78 — the shaft came out markedly darker and flatter than the
                cylinder it replaces. 0.85 keeps the 15% diffuse that carries it.
"""
import bpy, bmesh, math, os, struct, json
from mathutils import Vector

NAME = "screw"
OUT_GLB = "/Users/macbook/Documents/hackerton/nhn-ai/public/models/screw.glb"

HEAD_STYLE = "pan"        # "pan" (art direction) | "hex" (original brief wording)

# ---------------------------------------------------------------- dimensions
HEAD_D      = 0.40                 # head diameter / across-flats
HEAD_R      = HEAD_D * 0.5         # 0.200
BOSS_R      = HEAD_D * 0.425       # 0.170  = 0.85 * D  -> concentric-ring signature
FLANGE_R    = 0.215                # slightly wider than the head, thin
FLANGE_H    = 0.030
HEAD_TOP    = 0.185                # boss rim height; the crown domes a little above it
CROWN_TOP   = 0.193                # total proud height above the seating plane
BOSS_BASE   = 0.150                # where the outer head wall stops
BOSS_STEP   = 0.162                # top of the step chamfer into the boss

CORE_R      = 0.086                # shaft core radius
CREST_R     = 0.110                # thread crest radius  (~ brief's "radius ~0.115")
SHAFT_LEN   = 0.500                # below the seating plane
TIP_Z       = -SHAFT_LEN
THREAD_TURNS = 7
THREAD_PITCH = 0.060
THREAD_HH    = 0.022               # half-height of the ridge -> 0.016 gap between turns

REC_SPAN    = HEAD_D * 0.52        # 0.208 total tip-to-tip
REC_THICK   = HEAD_D * 0.18        # 0.072 arm thickness at centre
REC_FLOOR   = 0.125                # recess bottom  -> 0.060 deep
REC_TAPER   = 0.75                 # bottom cross-section as a fraction of the top one

# 30 segments: the genre camera is near-orthographic top-down, so the head is read as a
# CIRCLE. At 20 the silhouette was visibly a polygon in the top view.
LATHE_SEGS  = 30
# 20 steps per turn. At the original 12 the helix crest was a visible 12-gon: rendered
# from the side, every turn read as a chunky faceted ring with hard corners, right next
# to a 30-segment (smooth) shaft core -- the single worst "programmer art" tell on the
# asset, and the screw IS fully on screen while it spins out and drops into the holder.
# Swept 12/16/20/24/30 -> 2572/2740/2908/3076/3328 tris. 20 is where the faceting stops
# being visible at any size; 30 is indistinguishable from 20 and costs 420 more tris.
THREAD_SEGS = 20

BEVEL_W     = 0.005
BEVEL_SEGS  = 2                    # body: this is the "crisp chamfer" the brief asks for
THREAD_BEVEL_SEGS = 1              # thread: 0 to skip entirely (it is inside the wall)

# Quick sweep from the command line, for re-checking the trade-offs above:
#   -- <lathe_segs> <thread_bevel_segs> <head_style> <out_glb>
import sys as _sys
if "--" in _sys.argv:
    _a = _sys.argv[_sys.argv.index("--") + 1:]
    if len(_a) > 0:
        LATHE_SEGS = int(_a[0])
    if len(_a) > 1:
        THREAD_BEVEL_SEGS = int(_a[1])
    if len(_a) > 2:
        HEAD_STYLE = _a[2]
    if len(_a) > 3:
        OUT_GLB = _a[3]


# ---------------------------------------------------------------- helpers
def srgb(hexcolour):
    """sRGB hex from src/ui/scene.ts -> the LINEAR triple glTF stores in
    baseColorFactor (and that three.js reads straight back into material.color).
    Pasting the sRGB value in raw is a silent ~2x brightness error."""
    out = []
    for shift in (16, 8, 0):
        c = ((hexcolour >> shift) & 0xFF) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def activate(obj):
    # bpy.data.objects.new() + collection.link() leaves view_layer.objects stale (it
    # reports [] or even a None entry until the view layer resyncs), so force it first.
    bpy.context.view_layer.update()
    for o in bpy.context.scene.objects:
        if o is not None:
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
    # -> glTF "doubleSided": false -> three.js THREE.FrontSide, i.e. backface culling on.
    # Without this the exporter writes doubleSided:true and the renderer shades every
    # back face of every instance. Verified safe: the mesh has globally consistent
    # outward winding (signed volume +0.0392, matching the analytic solid volume), and
    # the helical thread is a closed "tent" sitting on the shaft core rather than a
    # zero-thickness ribbon, so nothing disappears when back faces are dropped.
    m.use_backface_culling = True
    return m


def apply_modifier(obj, name):
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=name)


def boolean_cut(target, cutter, solver='EXACT'):
    m = target.modifiers.new("Bool", 'BOOLEAN')
    m.operation, m.object, m.solver = 'DIFFERENCE', cutter, solver
    apply_modifier(target, "Bool")
    bpy.data.objects.remove(cutter, do_unlink=True)


def link(name, me):
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def build_lathe(profile, segs, name, hex_above_z=None):
    """Revolve a (radius, z) polyline around Z. Points with r == 0 collapse to a single
    pole vertex, so the caps come out as fans of triangles with no degenerate quads.

    hex_above_z: if set, rings at or above that height get their radius pushed out to the
    hexagon whose APOTHEM is the ring radius, turning them into 6-flat prisms of the same
    across-flats. Only the head is snapped -- the flange and the shaft must stay round.
    segs must be a multiple of 6 for the hex corners to land on actual vertices."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for (r, z) in profile:
        if abs(r) < 1e-9:
            rings.append([bm.verts.new((0.0, 0.0, z))] * segs)
            continue
        snap = hex_above_z is not None and z >= hex_above_z - 1e-9
        row = []
        for i in range(segs):
            a = 2.0 * math.pi * i / segs
            rr = r
            if snap:
                t = (a % (math.pi / 3.0)) - math.pi / 6.0
                rr = r / math.cos(t)
            row.append(bm.verts.new((rr * math.cos(a), rr * math.sin(a), z)))
        rings.append(row)

    for j in range(len(rings) - 1):
        A, B = rings[j], rings[j + 1]
        for i in range(segs):
            k = (i + 1) % segs
            loop = []
            for v in (A[i], A[k], B[k], B[i]):
                if not loop or loop[-1] is not v:
                    loop.append(v)
            if len(loop) > 2 and loop[0] is loop[-1]:
                loop.pop()
            if len(loop) < 3:
                continue
            try:
                bm.faces.new(loop)
            except ValueError:
                pass

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    return link(name, me)


def build_tapered_box(name, hx0, hy0, z0, hx1, hy1, z1, rot_z=0.0):
    """8-vert prism, cross-section (hx0,hy0) at z0 linearly becoming (hx1,hy1) at z1."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    c, s = math.cos(rot_z), math.sin(rot_z)

    def ring(hx, hy, z):
        out = []
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x, y = sx * hx, sy * hy
            out.append(bm.verts.new((x * c - y * s, x * s + y * c, z)))
        return out

    lo, hi = ring(hx0, hy0, z0), ring(hx1, hy1, z1)
    for i in range(4):
        k = (i + 1) % 4
        bm.faces.new((lo[i], lo[k], hi[k], hi[i]))
    bm.faces.new(lo)
    bm.faces.new(hi)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    return link(name, me)


def shade_hard_surface(obj, sharp_deg=30.0):
    activate(obj)
    bpy.ops.object.shade_smooth()
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(sharp_deg),
                                         keep_sharp_edges=False)


def chamfer(obj, width, segments, angle_deg=30.0):
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


def raw_tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ---------------------------------------------------------------- build
reset_scene()

# ScrewHead is the slot the game recolours, and a tint is a MULTIPLY, so the base has to
# be exactly white or every COLOUR_HEX arrives pre-darkened. Finish taken from the
# runtime material scene.ts:210 builds for a decided screw: metalness 0.45, roughness
# 0.28. ("keep it light" was the v1 rule and it is not good enough -- 0.84 light is
# still a 16% multiply.)
# NB: named HEAD_BASE/..._SHINE and not HEAD_RGB/HEAD_M/HEAD_R -- HEAD_R is the head
# RADIUS, a geometry constant twenty lines up, and shadowing it here silently rebuilt
# the lathe at r = 0.28 (the roughness value) with an unchanged triangle count.
HEAD_BASE, HEAD_METALLIC, HEAD_ROUGHNESS = (1.0, 1.0, 1.0), 0.45, 0.28
MAT_HEAD = new_material("ScrewHead", HEAD_BASE, HEAD_METALLIC, HEAD_ROUGHNESS)
# ScrewMetal == scene.ts:185 this.shaftMat, 0x3d4453 / metalness 0.85 / roughness 0.50.
# It lines the drive recess as well as the shaft. The v1 values (linear 0.13/0.14/0.155,
# metallic left to the glTF default of 1.0, rough 0.60) were tuned in isolation against a
# bright probe render; against the game's own dim IBL they render the socket as a dead
# black slot rather than the sunk steel one the wall already has.
METAL_BASE, METAL_METALLIC, METAL_ROUGHNESS = srgb(0x3D4453), 0.85, 0.50
MAT_METAL = new_material("ScrewMetal", METAL_BASE, METAL_METALLIC, METAL_ROUGHNESS)
print("  ScrewHead  linear=%s (WHITE, runtime tint multiplies into it) "
      "metallic=%.2f rough=%.2f" % (HEAD_BASE, HEAD_METALLIC, HEAD_ROUGHNESS))
print("  ScrewMetal linear=%s (sRGB #3D4453) metallic=%.2f rough=%.2f"
      % (tuple(round(c, 5) for c in METAL_BASE), METAL_METALLIC, METAL_ROUGHNESS))
assert abs(HEAD_R - HEAD_D * 0.5) < 1e-12, "a material constant shadowed HEAD_R"

# ---- 1. one-piece lathe: shaft core + flange + pan head + boss -------------
PROFILE = [
    (0.000,  TIP_Z),            # bottom pole
    (CORE_R, TIP_Z + 0.058),    # single cone tip (lives inside the wall, keep it cheap)
    (CORE_R, 0.000),            # core up to the seating plane
    (FLANGE_R, 0.000),          # flange underside == SEATING FACE, origin plane
    (FLANGE_R, FLANGE_H),       # flange outer wall
    (HEAD_R, 0.055),            # cone up to head diameter
    (HEAD_R, BOSS_BASE),        # head cylinder wall
    (BOSS_R, BOSS_STEP),        # step in -> the second concentric circle
    (BOSS_R, HEAD_TOP),         # boss wall
    (0.120,  0.191),            # gentle pan crown so the key light rolls off the top
    (0.000,  CROWN_TOP),        # top pole
]
body = build_lathe(PROFILE, LATHE_SEGS, "Body",
                   hex_above_z=(0.055 if HEAD_STYLE == "hex" else None))
print("  lathe: faces=%d tris=%d verts=%d" % (len(body.data.polygons), raw_tris(body),
                                              len(body.data.vertices)))

# ---- 2. cross (+) drive recess, cut for real with two tapered boxes --------
# Cross-section is REC_SPAN x REC_THICK at the head top and REC_TAPER of that at the
# floor; the linear taper is simply extended above the head, where it cuts nothing.
def arm_dims(z):
    """half-extents of the recess arm at height z, from the two control heights."""
    t = (z - REC_FLOOR) / (HEAD_TOP - REC_FLOOR)
    hx_f, hx_t = REC_SPAN * 0.5 * REC_TAPER, REC_SPAN * 0.5
    hy_f, hy_t = REC_THICK * 0.5 * REC_TAPER, REC_THICK * 0.5
    return hx_f + (hx_t - hx_f) * t, hy_f + (hy_t - hy_f) * t


Z_HI = 0.300
hx0, hy0 = arm_dims(REC_FLOOR)
hx1, hy1 = arm_dims(Z_HI)
print("  recess: floor %.4f x %.4f  top(%.3f) %.4f x %.4f"
      % (hx0 * 2, hy0 * 2, HEAD_TOP, arm_dims(HEAD_TOP)[0] * 2, arm_dims(HEAD_TOP)[1] * 2))

for idx, rot in enumerate((0.0, math.pi * 0.5)):
    cut = build_tapered_box("Cut%d" % idx, hx0, hy0, REC_FLOOR, hx1, hy1, Z_HI, rot_z=rot)
    boolean_cut(body, cut)
print("  after recess: faces=%d tris=%d" % (len(body.data.polygons), raw_tris(body)))

# ---- 3. materials on the BODY, before any bevel ------------------------------
# Assigning before the bevel matters: bevel faces inherit the material of the faces they
# were generated from, so the recess rim stays a clean boundary. Assigning afterwards
# would have to classify the chamfer strip itself, which straddles the test and speckles.
def face_is_metal(c, n):
    if c.z < -1e-5:                                   # shaft core + tip
        return True
    if c.z > REC_FLOOR - 0.005 and math.hypot(c.x, c.y) < BOSS_R * 0.85:
        if abs(n.z) <= 0.7:                           # recess side walls
            return True
        if c.z < REC_FLOOR + 0.02:                    # recess floor
            return True
    return False


# clear() first: applying a BOOLEAN whose cutter has no material leaves an EMPTY slot on
# the target, which silently shifts every material_index you then assign by one.
body.data.materials.clear()
body.data.materials.append(MAT_HEAD)     # slot 0
body.data.materials.append(MAT_METAL)    # slot 1
n_head = n_metal = 0
for p in body.data.polygons:
    m = face_is_metal(p.center, p.normal)
    p.material_index = 1 if m else 0
    n_metal += m
    n_head += (not m)
print("  body material split: ScrewHead=%d ScrewMetal=%d" % (n_head, n_metal))

# ---- 4. shade + chamfer the BODY ONLY, then bake it down ----------------------
# The thread is excluded on purpose and gets its own cheaper 1-segment pass below.
# Splitting the passes this way is measurably cheaper than one 2-segment bevel over the
# joined mesh, with no visible difference in the thread crest highlight at any size a
# phone will show. Dropping the thread bevel entirely is cheaper again but the crest
# goes mushy. (Absolute counts move with THREAD_SEGS; see the sweep noted there.)
shade_hard_surface(body, sharp_deg=30.0)
chamfer(body, BEVEL_W, BEVEL_SEGS, angle_deg=30.0)
apply_modifier(body, "Bevel")
apply_modifier(body, "WeightedNormal")
print("  body after chamfer: tris=%d" % raw_tris(body))

# ---- 5. helical thread ------------------------------------------------------
tm = bpy.data.meshes.new("ThreadProfile")
thread = link("Thread", tm)
bm = bmesh.new()
v0 = bm.verts.new((CORE_R, 0.0, -THREAD_HH))
v1 = bm.verts.new((CREST_R, 0.0, 0.0))
v2 = bm.verts.new((CORE_R, 0.0, THREAD_HH))
bm.edges.new((v0, v1))
bm.edges.new((v1, v2))
bm.to_mesh(tm)
bm.free()
thread.location = (0.0, 0.0, -0.400)

sc = thread.modifiers.new("Screw", 'SCREW')
sc.axis = 'Z'
sc.angle = math.radians(360)
sc.screw_offset = THREAD_PITCH
sc.iterations = THREAD_TURNS
sc.steps = sc.render_steps = THREAD_SEGS
sc.use_merge_vertices = True
sc.use_normal_calculate = True
sc.use_smooth_shade = True
apply_modifier(thread, "Screw")
activate(thread)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# same two slots in the same order so join() merges them 1:1; the whole ridge is steel
thread.data.materials.clear()
thread.data.materials.append(MAT_HEAD)
thread.data.materials.append(MAT_METAL)
for p in thread.data.polygons:
    p.material_index = 1
shade_hard_surface(thread, sharp_deg=30.0)
if THREAD_BEVEL_SEGS:
    tb = thread.modifiers.new("Bevel", 'BEVEL')
    tb.width, tb.segments = BEVEL_W * 0.7, THREAD_BEVEL_SEGS
    tb.limit_method, tb.angle_limit = 'ANGLE', math.radians(35)
    tb.harden_normals = True
    tw = thread.modifiers.new("WeightedNormal", 'WEIGHTED_NORMAL')
    tw.mode, tw.weight, tw.keep_sharp = 'FACE_AREA_WITH_ANGLE', 100, True
    apply_modifier(thread, "Bevel")
    apply_modifier(thread, "WeightedNormal")
zs = [v.co.z for v in thread.data.vertices]
print("  thread: tris=%d z=[%.4f,%.4f]" % (raw_tris(thread), min(zs), max(zs)))

# ---- 6. join into a single object -------------------------------------------
bpy.context.view_layer.update()
for o in bpy.context.scene.objects:
    o.select_set(False)
body.select_set(True)
thread.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
obj = bpy.context.active_object
obj.name = obj.data.name = NAME
print("  after join: scene objects =", [o.name for o in bpy.context.scene.objects],
      "slots =", [m.name for m in obj.data.materials])
per_slot = {}
for p in obj.data.polygons:
    per_slot[obj.data.materials[p.material_index].name] = \
        per_slot.get(obj.data.materials[p.material_index].name, 0) + 1
print("  joined material split:", per_slot)

# ---- 7. transforms (origin already sits on the seating plane, z = 0) ----------
activate(obj)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
print("  loc=%s scale=%s" % (tuple(obj.location), tuple(obj.scale)))

# ---- 8. export ------------------------------------------------------------------
os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format='GLB',
    export_apply=True,
    export_materials='EXPORT',
    export_yup=True,
)

# ---- 8b. stamp the WHITE baseColorFactor back in --------------------------------
# io_scene_gltf2/blender/exp/material/pbr_metallic_roughness.py:
#     if rgba == [1, 1, 1, 1]: return None
# i.e. the exporter deletes the field precisely when it is white, because glTF
# defaults it to white. Semantically identical -- and still worth undoing. This
# asset's whole colour system is "the game multiplies COLOUR_HEX into the head's
# base colour", so whether that base is white is the one fact a reviewer decoding
# this file will look for, and it should be *stated*, not left to a spec default
# that reads identically to the metallicFactor bug this pass exists to fix.
#
# Rewriting the JSON chunk is safe: bufferView byteOffsets are relative to the
# start of the BIN chunk, so as long as the JSON chunk stays 4-byte aligned and
# the header lengths are rebuilt, every accessor still resolves. The BIN chunk is
# copied through byte for byte and asserted identical below.
def glb_split(raw):
    off, out = 12, []
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        out.append((ctype, raw[off + 8:off + 8 + clen]))
        off += 8 + clen
    return out


with open(OUT_GLB, "rb") as f:
    raw = f.read()
chunks = glb_split(raw)
doc = json.loads(next(b for t, b in chunks if t == 0x4E4F534A).decode("utf-8"))
binc = next((b for t, b in chunks if t == 0x004E4942), b"")
patched = []
for m in doc["materials"]:
    pbr = m.setdefault("pbrMetallicRoughness", {})
    if "baseColorFactor" not in pbr:
        pbr["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
        patched.append(m["name"])
if patched:
    jb = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    jb += b" " * ((4 - len(jb) % 4) % 4)              # chunks must be 4-aligned
    bb = binc + b"\x00" * ((4 - len(binc) % 4) % 4)
    payload = (struct.pack("<II", len(jb), 0x4E4F534A) + jb
               + (struct.pack("<II", len(bb), 0x004E4942) + bb if bb else b""))
    with open(OUT_GLB, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + len(payload)) + payload)
    print("  stamped explicit white baseColorFactor on: %s" % ", ".join(patched))
    assert next(b for t, b in glb_split(open(OUT_GLB, "rb").read())
                if t == 0x004E4942) == bb, "BIN chunk changed during the rewrite"

# ---- 9. stats + hard verification of what actually landed on disk ---------------
tris, verts = print_stats(obj)

with open(OUT_GLB, "rb") as f:
    d = f.read()
js = json.loads(next(b for t, b in glb_split(d) if t == 0x4E4F534A).decode("utf-8"))
print("VERIFY file=%s size=%dB nodes=%s meshes=%s materials=%s"
      % (os.path.basename(OUT_GLB), len(d),
         [n["name"] for n in js["nodes"]],
         [m["name"] for m in js["meshes"]],
         [m["name"] for m in js["materials"]]))
WANT = {"ScrewHead": (HEAD_BASE, HEAD_METALLIC, HEAD_ROUGHNESS),
        "ScrewMetal": (METAL_BASE, METAL_METALLIC, METAL_ROUGHNESS)}
for m in js["materials"]:
    pbr = m["pbrMetallicRoughness"]
    print("   MAT %s baseColorFactor=%s metallicFactor=%s roughnessFactor=%s "
          "doubleSided=%s"
          % (m["name"], [round(c, 6) for c in pbr["baseColorFactor"]],
             pbr.get("metallicFactor", "ABSENT(defaults 1.0)"),
             pbr.get("roughnessFactor", "ABSENT(defaults 1.0)"),
             m.get("doubleSided", False)))
    assert "metallicFactor" in pbr, "metallicFactor must be explicit, not defaulted"
    assert "roughnessFactor" in pbr, "roughnessFactor must be explicit"
    rgb, met, rgh = WANT[m["name"]]
    assert abs(pbr["metallicFactor"] - met) < 1e-4, "%s metallic" % m["name"]
    assert abs(pbr["roughnessFactor"] - rgh) < 1e-4, "%s roughness" % m["name"]
    for got, want in zip(pbr["baseColorFactor"], tuple(rgb) + (1.0,)):
        assert abs(got - want) < 2e-3, "%s baseColorFactor" % m["name"]
assert js["materials"][[m["name"] for m in js["materials"]].index("ScrewHead")] \
    ["pbrMetallicRoughness"]["baseColorFactor"] == [1.0, 1.0, 1.0, 1.0], \
    "ScrewHead must be pure white or the runtime tint is multiplied down"

# Frozen per-primitive bounds, measured out of the previous good export. A triangle
# count alone does NOT pin the geometry: shadowing HEAD_R with a roughness value
# rebuilt the head at r=0.28 and still produced exactly 2908 triangles.
BASELINE = {
    "ScrewHead":  ([-0.2150, -0.0005, -0.2138], [0.2150, 0.1921, 0.2138]),
    "ScrewMetal": ([-0.1084, -0.5000, -0.1084], [0.1084, 0.1916, 0.1084]),
}
glb_tris = 0
for p in js["meshes"][0]["primitives"]:
    acc = js["accessors"][p["attributes"]["POSITION"]]
    t = js["accessors"][p["indices"]]["count"] // 3
    glb_tris += t
    name = js["materials"][p["material"]]["name"]
    print("   prim mat=%s verts=%d tris=%d attrs=%s min=%s max=%s"
          % (name, acc["count"], t, sorted(p["attributes"].keys()),
             [round(x, 4) for x in acc["min"]], [round(x, 4) for x in acc["max"]]))
    if (LATHE_SEGS, THREAD_BEVEL_SEGS, HEAD_STYLE) == (30, 1, "pan"):
        want_mn, want_mx = BASELINE[name]
        for got, want in zip(acc["min"] + acc["max"], want_mn + want_mx):
            assert abs(got - want) < 5e-4, \
                "%s bounds moved: this pass must not change geometry" % name
print("   glb_total_tris=%d  images=%d  extensionsUsed=%s"
      % (glb_tris, len(js.get("images", [])), js.get("extensionsUsed", [])))
# Shared convention for every asset in this project: UNDER 4000 triangles.
BUDGET = 4000
print("BUDGET %s glb_tris=%d limit=%d headroom=%d"
      % ("ok" if glb_tris < BUDGET else "EXCEEDED", glb_tris, BUDGET,
         BUDGET - glb_tris))
assert glb_tris < BUDGET, "over the %d-triangle project budget" % BUDGET
if (LATHE_SEGS, THREAD_BEVEL_SEGS, HEAD_STYLE) == (30, 1, "pan"):
    assert glb_tris == 2908, "screw tri count changed; this pass must not touch geometry"
print("DONE")
