"""オフィスの子犬のモデルを Blender で作る。毛を Blender の毛 (hair curves) で生やして色と法線をテクスチャに焼き込み、
軽い形に骨、動き、表情を付けて apps/office/public/models/puppy/ に .glb と .webp を書く。

使い方 (Python 3.13。venv はリポジトリの外に作る):
    uv venv -p 3.13 <venv>
    VIRTUAL_ENV=<venv> uv pip install -r apps/office/assets-src/puppy/requirements.txt
    <venv>/bin/python apps/office/assets-src/puppy/build.py

手で作る所は無く、流すたびに同じ形、骨、動き、表情と、同じ乱数の毛からテクスチャを作る。
座標は Blender の向き (z が上、子犬は -y を向く)。書き出しで three.js の向き (y が上、+z が前) になる。
"""

import argparse
import json
import math
import struct
import time
from pathlib import Path

import bpy  # bmesh と mathutils は bpy を読んだ後に読める
import bmesh
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "public" / "models" / "puppy"
# 毛色と顔の色。画面の部屋の案 (themes.ts) と同じ値にする (テストで確かめる)
COLORS = json.loads((HERE / "colors.json").read_text(encoding="utf-8"))
FPS = 30
SEED = 7

# 頭の真ん中。目、鼻、口、小物の位置の元。画面の小物 (props.ts) はこの点からの位置で置く
HEAD = Vector((0.0, -0.14, 0.56))
# 胴の真ん中
TORSO = Vector((0.0, 0.02, 0.23))
# 目の真ん中 (頭の真ん中から)。大きく離し、顔の真ん中より少し下に置く
EYE = Vector((0.12, 0.0, -0.025))
# metaball の楕円の大きさと、できる形の半径の比。1 つの球の時、半径 1 の場は size の 0.564 倍の所に面ができる
META_SURFACE = 0.564
STARTED = time.monotonic()


def step(name):
    """進み具合を出す"""
    print(f"[{time.monotonic() - STARTED:6.1f}s] {name}", flush=True)


def smooth(e0, e1, x):
    """0 から 1 へなめらかに変わる値。e0 が e1 より大きい時は逆向き。numpy の配列も受ける"""
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def srgb(hex_color):
    """#rrggbb を 0 から 1 の sRGB の 3 つにする"""
    h = hex_color.lstrip("#")
    return np.array([int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)])


def to_linear(c):
    c = np.asarray(c, dtype=float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(np.asarray(c, dtype=float), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


# ---------------------------------------------------------------- 形


def ball(at, radii, stiffness=2.0):
    """metaball の楕円 1 つ。radii はできる面の半径 (1 つだけの時)"""
    return (Vector(at), Vector(radii) / META_SURFACE, stiffness)


# 部位ごとの、骨、metaball の楕円、毛の長さと立ち上がり。楕円は同じ部位の中だけで溶け合う
def parts():
    h = HEAD
    ears = {}
    for side, name in ((1, "ear.L"), (-1, "ear.R")):
        s = side
        # 頭の横の上から、顎の下まで垂れる長い房。下の縁は小さな房を並べ、毛先の束に見せる
        ears[name] = {
            "bone": name,
            "balls": [
                ball((0.17 * s, -0.04, 0.79), (0.09, 0.12, 0.06)),
                ball((0.21 * s, -0.05, 0.74), (0.085, 0.125, 0.07)),
                ball((0.25 * s, -0.05, 0.66), (0.095, 0.14, 0.1)),
                # 縦に並ぶ毛の束。束ごとに長さを変え、下の縁を房に見せる
                *[
                    ball((0.272 * s, y, z), (0.08, 0.036, 0.13), stiffness=5.0)
                    for y, z in ((-0.13, 0.53), (-0.085, 0.5), (-0.04, 0.49), (0.005, 0.5), (0.05, 0.52))
                ],
            ],
            "length": 0.075,
            "height": 0.008,
        }
    legs = {}
    for name, x, y in (("leg.FL", 0.095, -0.12), ("leg.FR", -0.095, -0.12), ("leg.BL", 0.105, 0.13), ("leg.BR", -0.105, 0.13)):
        legs[name] = {
            "bone": name,
            "balls": [
                ball((x, y, 0.1), (0.068, 0.068, 0.085)),
                ball((x, y - 0.025, 0.035), (0.072, 0.082, 0.042)),
            ],
            "length": 0.028,
            "height": 0.006,
        }
    return {
        "head": {
            "bone": "head",
            "balls": [
                # 横に広く前後に浅い頭。顔は平たく、口元だけ前へ出す
                ball(h + Vector((0, 0.03, 0.04)), (0.295, 0.245, 0.225)),
                ball(h + Vector((0, 0.04, 0.17)), (0.225, 0.19, 0.12)),
                # 頭の上の毛の房。輪郭に柔らかな凹凸を出す
                ball(h + Vector((0, -0.02, 0.25)), (0.07, 0.06, 0.05)),
                ball(h + Vector((0.09, 0.0, 0.24)), (0.065, 0.06, 0.045)),
                ball(h + Vector((-0.09, 0.0, 0.24)), (0.065, 0.06, 0.045)),
                ball(h + Vector((0.0, 0.09, 0.23)), (0.07, 0.06, 0.045)),
                ball(h + Vector((0.12, -0.1, -0.09)), (0.125, 0.095, 0.09)),
                ball(h + Vector((-0.12, -0.1, -0.09)), (0.125, 0.095, 0.09)),
                ball(h + Vector((0, -0.235, -0.075)), (0.08, 0.075, 0.058)),
                ball(h + Vector((0, -0.09, -0.15)), (0.125, 0.09, 0.06)),
            ],
            "length": 0.034,
            "height": 0.008,
        },
        **ears,
        "body": {
            "bone": "body",
            "balls": [
                ball(TORSO, (0.17, 0.19, 0.145)),
                ball((0, -0.1, 0.25), (0.158, 0.11, 0.15)),
                ball((0, 0.13, 0.215), (0.155, 0.11, 0.13)),
                ball((0, -0.08, 0.36), (0.14, 0.11, 0.09)),
            ],
            "length": 0.04,
            "height": 0.009,
        },
        **legs,
        "tail": {
            "bone": "tail",
            "balls": [
                ball((0, 0.25, 0.33), (0.06, 0.06, 0.06)),
                ball((0.02, 0.245, 0.43), (0.098, 0.09, 0.092)),
                ball((0, 0.175, 0.475), (0.068, 0.062, 0.056)),
            ],
            "length": 0.045,
            "height": 0.012,
        },
    }


def metaball_mesh(name, balls, resolution, decimate):
    """metaball の楕円を溶け合わせ、形にする"""
    mb = bpy.data.metaballs.new(name)
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = 0.6
    for at, size, stiffness in balls:
        e = mb.elements.new(type="ELLIPSOID")
        e.co = at
        e.radius = 1.0
        e.size_x, e.size_y, e.size_z = size
        e.stiffness = stiffness
    ob = bpy.data.objects.new(name, mb)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    bpy.data.metaballs.remove(mb)
    # 画面で描く形は軽くする。面の向きの細かな変わりは法線の模様が受け持つ
    tmp = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(tmp)
    mod = tmp.modifiers.new("Decimate", "DECIMATE")
    mod.ratio = decimate
    dg = bpy.context.evaluated_depsgraph_get()
    low = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp)
    bpy.data.meshes.remove(me)
    return low


def mesh_arrays(me):
    """形の頂点、頂点の法線、三角を numpy で返す"""
    me.calc_loop_triangles()
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    nor = np.empty(n * 3)
    me.vertex_normals.foreach_get("vector", nor)
    tris = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", tris)
    return co.reshape(-1, 3), nor.reshape(-1, 3), tris.reshape(-1, 3)


# ---------------------------------------------------------------- 毛の模様と流れ


def coat_mask(part, p):
    """毛色の所を 1、クリーム色の所を 0 で返す。p は (n, 3) の位置"""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    if part == "head":
        r = p - np.array(HEAD)
        ax = np.abs(r[:, 0])
        # 額から鼻へ通る白い筋。頭の上で広がり、目の間で細り、口元の白につながる
        half = 0.03 + 0.05 * smooth(0.0, -0.09, r[:, 2]) + 0.05 * smooth(0.1, 0.2, r[:, 2])
        blaze = smooth(half + 0.03, half - 0.01, ax) * smooth(0.14, 0.0, r[:, 1])
        top = -0.065 - 0.3 * np.maximum(0, ax - 0.1)
        muzzle = smooth(top + 0.025, top - 0.03, r[:, 2]) * smooth(0.14, 0.0, r[:, 1])
        return 1 - np.maximum(blaze, muzzle)
    if part.startswith("ear"):
        return np.ones(len(p))
    if part == "body":
        r = p - np.array(TORSO)
        saddle = smooth(0.05, 0.12, r[:, 2]) * smooth(-0.08, 0.04, r[:, 1])
        shoulder = smooth(0.1, 0.15, np.abs(r[:, 0])) * smooth(-0.02, 0.08, r[:, 2]) * smooth(0.1, 0.0, np.abs(r[:, 1] + 0.06))
        haunch = smooth(0.1, 0.15, np.abs(r[:, 0])) * smooth(-0.04, 0.05, r[:, 2]) * smooth(0.07, 0.0, np.abs(r[:, 1] - 0.12))
        neck = smooth(0.32, 0.4, z) * smooth(-0.1, 0.0, y)
        return np.clip(np.maximum.reduce([saddle, shoulder * 0.85, haunch * 0.8, neck]), 0, 1)
    if part == "tail":
        return 0.55 * smooth(0.42, 0.32, z)
    return np.zeros(len(p))


def flow(part, p, n):
    """毛の流れる向き (面に沿わせる前)。p と n は (n, 3)"""
    x = p[:, 0]
    sx = np.where(x >= 0, 1.0, -1.0)
    one = np.ones(len(p))
    if part == "head":
        # 顔の前は鼻から外へ広がり、上と横は真ん中の分け目から横へ垂れる
        nose = np.array(HEAD) + np.array((0, -0.25, -0.06))
        face = p - nose
        side = np.stack([sx * 0.9, one * 0.35, -one * 0.6], 1)
        front = smooth(-0.15, -0.6, n[:, 1])[:, None]
        return side * (1 - front) + face * front * 6
    if part.startswith("ear"):
        return np.stack([sx * 0.12, one * 0.04, -one], 1)
    if part == "body":
        chest = smooth(-0.3, -0.7, n[:, 1])[:, None]
        back = np.stack([sx * 0.3, one * 0.35, -one], 1)
        down = np.stack([0 * one, -one * 0.1, -one], 1)
        return back * (1 - chest) + down * chest
    if part == "tail":
        return p - np.array((0, 0.25, 0.3))
    return np.stack([0 * one, -one * 0.15, -one], 1)


def sample_surface(co, nor, tris, count, rng):
    """面の上に面積に比べて点をまく。位置と、なめらかにした法線を返す"""
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    pick = rng.choice(len(tris), size=count, p=area / area.sum())
    u, v = rng.random(count), rng.random(count)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    w = 1 - u - v
    t = tris[pick]
    p = co[t[:, 0]] * w[:, None] + co[t[:, 1]] * u[:, None] + co[t[:, 2]] * v[:, None]
    n = nor[t[:, 0]] * w[:, None] + nor[t[:, 1]] * u[:, None] + nor[t[:, 2]] * v[:, None]
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    return p, n, area.sum()


def grow(part, spec, co, nor, tris, rng, density, points=6):
    """部位の毛を生やす。束 (房) に寄せた毛先で、フェルトの房の流れを出す。点の位置、毛の色の値、半径を返す"""
    p, n, area = sample_surface(co, nor, tris, 1, rng)
    count = max(200, int(area * density))
    p, n, _ = sample_surface(co, nor, tris, count, rng)
    d = flow(part, p, n)
    d -= n * np.sum(d * n, axis=1, keepdims=True)
    d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-6)
    length = spec["length"] * (0.75 + 0.5 * rng.random(count))
    s = np.linspace(0, 1, points)
    # 根元は面の少し内から立ち上がり、毛先は面へ寝る
    lift = -0.008 + (0.008 + spec["height"]) * (1 - (1 - s) ** 3) - 0.6 * spec["height"] * s**3
    curve = p[:, None, :] + n[:, None, :] * lift[None, :, None] + d[:, None, :] * (length[:, None] * s)[:, :, None]
    curve[:, :, 2] -= (length[:, None] * 0.18 * s**2)
    # 束: 近くの束の真ん中の毛へ毛先を寄せる
    clumps = max(8, count // 14)
    tree = KDTree(clumps)
    for i in range(clumps):
        tree.insert(p[i], i)
    tree.balance()
    owner = np.array([tree.find(q)[1] for q in p])
    pull = (0.55 * s**2)[None, :, None]
    curve = curve * (1 - pull) + curve[owner] * pull
    mask = coat_mask(part, p)
    # 房ごとに明るさを変える。耳は長い房の筋が見えるよう、差を大きくする
    spread = 0.2 if part.startswith("ear") else 0.1
    tone = 1.0 - spread + spread * rng.random(clumps)[owner] + 0.05 * rng.random(count)
    shade = tone[:, None] * (0.8 + 0.2 * s[None, :])
    color = np.zeros((count, points, 4))
    color[:, :, 0] = mask[:, None]
    color[:, :, 1] = shade
    color[:, :, 3] = 1
    radius = np.broadcast_to((0.0022 * (1 - 0.6 * s))[None, :], (count, points))
    return curve, color, radius


def hair_object(curves, colors, radii):
    """毛を Blender の hair curves にし、毛を管にする geometry nodes を付ける"""
    count, points = curves.shape[:2]
    hc = bpy.data.hair_curves.new("Hair")
    hc.add_curves([points] * count)
    hc.position_data.foreach_set("vector", curves.reshape(-1).astype(np.float32))
    rad = hc.attributes.new("radius", "FLOAT", "POINT")
    rad.data.foreach_set("value", np.ascontiguousarray(radii).reshape(-1).astype(np.float32))
    # 毛は Catmull-Rom の曲線。点の間を 2 つに分ければ毛の曲がりには足りる
    res = hc.attributes.new("resolution", "INT", "CURVE")
    res.data.foreach_set("value", np.full(count, 2, dtype=np.int32))
    col = hc.attributes.new("furcol", "FLOAT_COLOR", "POINT")
    col.data.foreach_set("color", colors.reshape(-1).astype(np.float32))
    ob = bpy.data.objects.new("Hair", hc)
    bpy.context.scene.collection.objects.link(ob)
    tree = bpy.data.node_groups.new("HairTubes", "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    gin = tree.nodes.new("NodeGroupInput")
    gout = tree.nodes.new("NodeGroupOutput")
    circle = tree.nodes.new("GeometryNodeCurvePrimitiveCircle")
    circle.inputs["Resolution"].default_value = 3
    circle.inputs["Radius"].default_value = 1.0
    to_mesh = tree.nodes.new("GeometryNodeCurveToMesh")
    tree.links.new(gin.outputs[0], to_mesh.inputs["Curve"])
    tree.links.new(circle.outputs["Curve"], to_mesh.inputs["Profile Curve"])
    # 管の太さは毛の点ごとの半径にする (Curve to Mesh は半径を自分では使わない)
    radius = tree.nodes.new("GeometryNodeInputNamedAttribute")
    radius.data_type = "FLOAT"
    radius.inputs["Name"].default_value = "radius"
    tree.links.new(radius.outputs["Attribute"], to_mesh.inputs["Scale"])
    tree.links.new(to_mesh.outputs["Mesh"], gout.inputs[0])
    mod = ob.modifiers.new("Tubes", "NODES")
    mod.node_group = tree
    # 毛を残したまま、管にした写しを形にする
    tubes = ob.copy()
    tubes.data = hc.copy()
    tubes.name = "HairTubes"
    bpy.context.scene.collection.objects.link(tubes)
    for o in bpy.context.scene.objects:
        o.select_set(o == tubes)
    bpy.context.view_layer.objects.active = tubes
    bpy.ops.object.convert(target="MESH")
    tubes = bpy.context.view_layer.objects.active
    step(f"  毛の管: 頂点 {len(tubes.data.vertices)}、大きさ {tuple(round(d, 3) for d in tubes.dimensions)}")
    return ob, tubes


# ---------------------------------------------------------------- 材質


def emit_material(name, attribute):
    """色の属性をそのまま光らせる材質。焼き込みの元に使う"""
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.clear()
    attr = nodes.new("ShaderNodeAttribute")
    attr.attribute_name = attribute
    em = nodes.new("ShaderNodeEmission")
    out = nodes.new("ShaderNodeOutputMaterial")
    links.new(attr.outputs["Color"], em.inputs["Color"])
    links.new(em.outputs["Emission"], out.inputs["Surface"])
    # 光る面を明かりとして数えない。数えると焼き込みの前に明かりの木を毛の数だけ組み、とても遅くなる
    m.cycles.emission_sampling = "NONE"
    return m


def principled(name, color, roughness=0.6, emission=None):
    """書き出す材質。glTF の金属と粗さの材質になる"""
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*to_linear(srgb(color)), 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*to_linear(srgb(emission)), 1)
        bsdf.inputs["Emission Strength"].default_value = 1.0
    return m


# ---------------------------------------------------------------- 焼き込み


def bake_textures(fur, sources, size, samples):
    """毛を低い形へ焼き込む。色の値 (毛色の所、明るさ) と法線の 2 枚を返す"""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.cycles.seed = SEED
    scene.cycles.use_light_tree = False
    target = bpy.data.materials.new("BakeTarget")
    node = target.node_tree.nodes.new("ShaderNodeTexImage")
    target.node_tree.nodes.active = node
    fur.data.materials.clear()
    fur.data.materials.append(target)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in sources:
        o.select_set(True)
    fur.select_set(True)
    bpy.context.view_layer.objects.active = fur
    images = {}
    for kind, float_buffer in (("EMIT", True), ("NORMAL", False)):
        img = bpy.data.images.new(kind, size, size, float_buffer=float_buffer, alpha=False)
        img.colorspace_settings.name = "Non-Color"
        node.image = img
        # 低い形の少し外から内へ光を当て、最初に当たった毛 (無ければ地肌) を写す
        bpy.ops.object.bake(type=kind, normal_space="TANGENT", use_selected_to_active=True, cage_extrusion=0.03, max_ray_distance=0.07, margin=6)
        px = np.empty(size * size * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        images[kind] = px.reshape(size, size, 4)
    return images


def save_webp(path, rgb, quality):
    """0 から 1 の RGB (下の行から) を、そのままの値で .webp に書く"""
    h, w = rgb.shape[:2]
    img = bpy.data.images.new(path.stem, w, h, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    px = np.ones((h, w, 4), dtype=np.float32)
    px[:, :, :3] = rgb
    img.pixels.foreach_set(px.reshape(-1))
    img.filepath_raw = str(path)
    img.file_format = "WEBP"
    img.save(filepath=str(path), quality=quality)
    bpy.data.images.remove(img)


def write_textures(images, out):
    """毛色ごとの色のテクスチャと、法線のテクスチャを書く"""
    emit = images["EMIT"]
    mask = np.clip(emit[:, :, 0], 0, 1)[:, :, None]
    shade = np.clip(emit[:, :, 1], 0, 1.2)[:, :, None]
    cream = to_linear(srgb(COLORS["cream"]))
    for coat in ("president", "builder", "reviewer"):
        base = to_linear(srgb(COLORS[coat]))
        # 毛の間の影は灰にせず、赤みを残して暗くする (フェルトの温かい影)
        dark = np.clip(1 - shade, 0, 1)
        color = (cream * (1 - mask) + base * mask) * (1 - dark * np.array([0.7, 0.95, 1.25]))
        save_webp(out / f"{coat}.webp", to_srgb(color), 80)
    save_webp(out / "normal.webp", images["NORMAL"][:, :, :3], 72)


# ---------------------------------------------------------------- 顔


class Builder:
    """頂点と面を貯め、形の鍵 (シェイプキー) の位置も一緒に持つ"""

    def __init__(self):
        self.verts, self.faces, self.mats = [], [], []
        self.keys = {"sleepy": [], "trouble": []}

    def add(self, verts, faces, mat, keys=None):
        base = len(self.verts)
        self.verts += [Vector(v) for v in verts]
        for f in faces:
            self.faces.append([base + i for i in f])
            self.mats.append(mat)
        for k in self.keys:
            self.keys[k] += [Vector(v) for v in (keys or {}).get(k, verts)]


def sphere(segments=20, rings=12):
    """半径 1 の球の頂点と面"""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    verts = [v.co.copy() for v in bm.verts]
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    return verts, faces


def surface_frame(bvh, x, z, back=0.0):
    """前から頭へ光を当てた所の位置と、面に沿う向き (横、上、外) を返す"""
    hit, normal, _, _ = bvh.ray_cast(Vector((x, -2.0, z)), Vector((0, 1, 0)))
    if hit is None:
        raise RuntimeError(f"顔の面が無い: x={x}, z={z}")
    w = normal.normalized()
    u = (Vector((1, 0, 0)) - w * w.x).normalized()
    v = w.cross(u).normalized()
    if v.z < 0:
        v = -v
    return hit - w * back, u, v, w


def tube(points, radius, sides=6):
    """折れ線に沿う細い管の頂点と面"""
    verts, faces = [], []
    pts = [Vector(p) for p in points]
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        a = t.cross(Vector((0, 1, 0)))
        if a.length < 1e-4:
            a = t.cross(Vector((1, 0, 0)))
        a.normalize()
        b = t.cross(a).normalized()
        r = radius * (0.55 + 0.45 * math.sin(math.pi * (0.15 + 0.7 * i / max(1, len(pts) - 1))))
        for k in range(sides):
            ang = 2 * math.pi * k / sides
            verts.append(p + (a * math.cos(ang) + b * math.sin(ang)) * r)
    for i in range(len(pts) - 1):
        for k in range(sides):
            a0, a1 = i * sides + k, i * sides + (k + 1) % sides
            faces.append([a0, a1, a1 + sides, a0 + sides])
    return verts, faces


def on_face(bvh, pts2d, lift):
    """顔の前の面 (x, z) の点を、頭の面の上へ写す"""
    out = []
    for x, z in pts2d:
        p, _, _, w = surface_frame(bvh, x, z)
        out.append(p + w * lift)
    return out


def build_face(bvh):
    """目、光の点、鼻、口、困り顔の眉を作る。ねむい (sleepy) と困り顔 (trouble) の形の鍵を持つ"""
    b = Builder()
    unit, faces = sphere(24, 14)
    for side in (1, -1):
        c, u, v, w = surface_frame(bvh, EYE.x * side, HEAD.z + EYE.z, back=0.016)
        a, bb, d = 0.058, 0.064, 0.028
        verts, sleepy, trouble = [], [], []
        for q in unit:
            verts.append(c + u * q.x * a + v * q.y * bb + w * q.z * d)
            # ねむい: 下へ丸い細い線にたたむ
            sx = q.x * 0.95
            sleepy.append(c + u * sx * a + v * (-0.25 * bb + 0.32 * bb * sx * sx + q.y * 0.07 * bb) + w * q.z * d * 0.7)
            # 困り顔: 目を少し細め、外の端を下げる
            ty = q.y * 0.9 - 0.12 * max(0.0, q.x * side) * (1 + q.y) * 0.5
            trouble.append(c + u * q.x * a + v * ty * bb + w * q.z * d)
        b.add(verts, faces, 0, {"sleepy": sleepy, "trouble": trouble})
        # 黒目の下の茶色。潤んだ深い目に見せる。ねむい時は目の奥へたたむ
        ic = c - v * 0.42 * bb + w * 0.5 * d
        iris = [ic + u * q.x * a * 0.66 + v * q.y * bb * 0.42 + w * q.z * d * 0.52 for q in unit]
        b.add(iris, faces, 5, {"sleepy": [c - w * 0.01] * len(unit)})
        # 光の点: 上に大きく、下に小さく
        for (hx, hy), r in (((-0.3, 0.36), 0.017), ((0.32, -0.38), 0.0085)):
            hz = math.sqrt(max(0.0, 1 - hx * hx - hy * hy))
            centre = c + u * hx * a + v * hy * bb + w * (max(hz, 0.98) * d + 0.004)
            sv, sf = sphere(12, 8)
            verts = [centre + u * q.x * r + v * q.y * r + w * q.z * r * 0.4 for q in sv]
            hidden = [c - w * 0.01] * len(sv)
            b.add(verts, sf, 1, {"sleepy": hidden, "trouble": verts})
    # 小さな黒い鼻
    nose_z = HEAD.z - 0.055
    c, u, v, w = surface_frame(bvh, 0.0, nose_z, back=0.004)
    sv, sf = sphere(12, 8)
    verts = [c + u * q.x * 0.034 + v * (q.y * 0.024 - 0.006 * q.x * q.x) + w * q.z * 0.022 for q in sv]
    b.add(verts, sf, 2)
    # 口: 鼻から下へ短い線と、下へ丸い 2 つの弧 (ω)。困り顔は上へ丸い小さな弧
    top = nose_z - 0.024
    stem = [(0, top), (0, top - 0.013)]
    stem_t = [(0, top - 0.004), (0, top - 0.012)]
    n = 13
    smile, frown = [], []
    for i in range(n):
        t = i / (n - 1) * 2 - 1
        x = 0.032 * t
        bump = abs(abs(t) - 0.5) * 2
        smile.append((x, top - 0.013 - 0.011 * (1 - bump * bump)))
        frown.append((x * 0.8, top - 0.026 + 0.009 * (1 - t * t) - 0.004 * t * t))
    for basis, sad in ((stem, stem_t), (smile, frown)):
        pts = on_face(bvh, basis, 0.003)
        sad_pts = on_face(bvh, sad, 0.003)
        verts, faces2 = tube(pts, 0.0042)
        sad_verts, _ = tube(sad_pts, 0.0042)
        b.add(verts, faces2, 3, {"trouble": sad_verts})
    # 困り顔の眉: ふだんは頭の中にたたんで隠し、困り顔で内側を上げて出す
    for side in (1, -1):
        brow = [(side * (0.06 + 0.075 * i / 6), HEAD.z + 0.075 - 0.025 * i / 6) for i in range(7)]
        pts = on_face(bvh, brow, 0.004)
        verts, faces2 = tube(pts, 0.006)
        mid = sum(pts, Vector()) / len(pts)
        hidden = [mid + (mid - HEAD).normalized() * -0.03] * len(verts)
        b.add([hidden[0]] * len(verts), faces2, 4, {"sleepy": [hidden[0]] * len(verts), "trouble": verts})
    return b


def face_object(b, materials):
    # 三角に分けてから渡す。書き出しに分け方を任せると、流すたびに三角の並びが変わる
    tris, mats = [], []
    for f, m in zip(b.faces, b.mats):
        for i in range(1, len(f) - 1):
            tris.append([f[0], f[i], f[i + 1]])
            mats.append(m)
    me = bpy.data.meshes.new("Face")
    me.from_pydata([tuple(v) for v in b.verts], [], tris)
    for m in materials:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", mats)
    me.polygons.foreach_set("use_smooth", [True] * len(tris))
    ob = bpy.data.objects.new("Face", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.shape_key_add(name="Basis", from_mix=False)
    for name, pts in b.keys.items():
        key = ob.shape_key_add(name=name, from_mix=False)
        key.data.foreach_set("co", np.array([tuple(p) for p in pts]).reshape(-1))
    return ob


# ---------------------------------------------------------------- 骨と動き

BONES = {
    # 名前: (根元, 先, 親)
    "root": ((0, 0, 0), (0, 0, 0.1), None),
    "body": ((0, 0.1, 0.15), (0, 0.1, 0.25), "root"),
    "head": ((0, -0.1, 0.4), (0, -0.1, 0.55), "body"),
    "ear.L": ((0.215, -0.06, 0.73), (0.275, -0.05, 0.42), "head"),
    "ear.R": ((-0.215, -0.06, 0.73), (-0.275, -0.05, 0.42), "head"),
    "leg.FL": ((0.095, -0.12, 0.17), (0.095, -0.12, 0.0), "body"),
    "leg.FR": ((-0.095, -0.12, 0.17), (-0.095, -0.12, 0.0), "body"),
    "leg.BL": ((0.105, 0.13, 0.17), (0.105, 0.13, 0.0), "body"),
    "leg.BR": ((-0.105, 0.13, 0.17), (-0.105, 0.13, 0.0), "body"),
    "tail": ((0, 0.2, 0.3), (0, 0.24, 0.44), "body"),
}


def build_rig():
    arm = bpy.data.armatures.new("Puppy")
    ob = bpy.data.objects.new("Puppy", arm)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (head, tail, parent) in BONES.items():
        e = arm.edit_bones.new(name)
        e.head, e.tail = head, tail
        if parent:
            e.parent = arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return ob


def skin(ob, rig, weights):
    """形を骨に付ける。weights は骨の名前から頂点ごとの重さ"""
    for name, w in weights.items():
        g = ob.vertex_groups.new(name=name)
        for i, value in enumerate(w):
            if value > 1e-4:
                g.add([i], float(value), "REPLACE")
    ob.parent = rig
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = rig


def world_rot(rig, bone, axis, angle):
    """骨の根元を中心に、世界の軸の回りに回す、骨の向きでの回転"""
    rest = rig.data.bones[bone].matrix_local.to_3x3()
    r = Matrix.Rotation(angle, 3, axis)
    return (rest.inverted() @ r @ rest).to_quaternion()


def key_pose(rig, frame, rot, lift=0.0):
    """全部の骨の形を 1 コマに打つ。rot は骨の名前から [(軸, 角度)]"""
    for pb in rig.pose.bones:
        q = Quaternion()
        for axis, angle in rot.get(pb.name, []):
            q = world_rot(rig, pb.name, axis, angle) @ q
        pb.rotation_quaternion = q
        pb.location = (0, 0, 0)
        if pb.name == "body":
            rest = rig.data.bones["body"].matrix_local.to_3x3()
            pb.location = rest.inverted() @ Vector((0, 0, lift))
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=pb.name)
        pb.keyframe_insert("location", frame=frame, group=pb.name)


def sit(extra=None, breath=0.0):
    """おすわりの形。胴を起こし、後ろ足を前へたたむ"""
    r = {
        "body": [("X", -0.32)],
        "head": [("X", 0.3)],
        "leg.FL": [("X", 0.3)],
        "leg.FR": [("X", 0.3)],
        "leg.BL": [("X", -1.05)],
        "leg.BR": [("X", -1.05)],
        "tail": [("X", 0.25)],
    }
    for k, v in (extra or {}).items():
        r[k] = r.get(k, []) + v
    return r


def wave(t, period, phase=0.0):
    return math.sin(2 * math.pi * t / period + phase)


def make_action(rig, name, seconds, pose_at):
    """1 つの動きを作って NLA に積む。pose_at は秒から (回転, 上下)"""
    rig.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data.action = act
    frames = round(seconds * FPS)
    for f in range(0, frames + 1):
        rot, lift = pose_at(f / FPS)
        key_pose(rig, f, rot, lift)
    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act)
    track.mute = True
    return act


def make_actions(rig, face):
    # 待つ: おすわりで 3.5 秒に 1 回息をし、首をゆっくり振り、5 秒ごとではなく 7 秒の初めに 1.2 秒しっぽを振る
    def wait(t):
        tail = 0.6 * wave(t, 0.25) if t < 1.2 else 0.08 * wave(t, 7 / 3)
        return sit({"head": [("Z", 0.35 * wave(t, 7))], "tail": [("Z", tail)]}), 0.012 * wave(t, 3.5)

    # 座る: 止めた時と止まっている時のおすわり。息だけ
    def seated(t):
        return sit(), 0.006 * wave(t, 3.5)

    # 働く: 机で前足を上げて打ち、首を少し振る
    def work(t):
        paw = 0.3 * wave(t, 1 / 3)
        return sit({"leg.FL": [("X", -1.4 + paw)], "leg.FR": [("X", -1.4 - paw)], "head": [("Z", 0.06 * wave(t, 2 / 3))]}), 0.006 * abs(wave(t, 1 / 3))

    # 歩く: 対角の足をそろえて振り、耳としっぽを揺らす
    def walk(t):
        leg = 0.6 * wave(t, 0.4)
        ear = 0.12 * wave(t, 0.4, 1)
        return {
            "leg.FL": [("X", leg)],
            "leg.BR": [("X", leg)],
            "leg.FR": [("X", -leg)],
            "leg.BL": [("X", -leg)],
            "ear.L": [("Y", ear)],
            "ear.R": [("Y", ear)],
            "tail": [("Z", 0.5 * wave(t, 0.4))],
            "head": [("X", 0.04 * wave(t, 0.2))],
        }, 0.02 * abs(wave(t, 0.4))

    # 書類を渡す: 立ったまま首を前へ出して差し出し、しっぽを振る
    def give(t):
        nod = 0.5 - 0.5 * math.cos(2 * math.pi * t / 1.2)
        return {"head": [("X", 0.28 * nod)], "tail": [("Z", 0.5 * wave(t, 0.3))], "ear.L": [("Y", 0.05 * nod)], "ear.R": [("Y", -0.05 * nod)]}, 0.0

    make_action(rig, "wait", 7.0, wait)
    make_action(rig, "sit", 3.5, seated)
    make_action(rig, "work", 2 / 3, work)
    make_action(rig, "walk", 0.8, walk)
    make_action(rig, "give", 1.2, give)

    # まばたき: 3.7 秒に 1 回、終わりの 0.15 秒だけ目を閉じる
    keys = face.data.shape_keys
    keys.animation_data_create()
    act = bpy.data.actions.new("blink")
    act.use_fake_user = True
    keys.animation_data.action = act
    sleepy = keys.key_blocks["sleepy"]
    close = round(3.55 * FPS)
    for f, value in ((0, 0.0), (close - 1, 0.0), (close, 1.0), (round(3.7 * FPS) - 1, 1.0), (round(3.7 * FPS), 0.0)):
        sleepy.value = value
        sleepy.keyframe_insert("value", frame=f)
    for fc in act_fcurves(act):
        for k in fc.keyframe_points:
            k.interpolation = "CONSTANT"
    keys.animation_data.action = None
    track = keys.animation_data.nla_tracks.new()
    track.name = "blink"
    track.strips.new("blink", 0, act)
    track.mute = True
    sleepy.value = 0.0


def act_fcurves(act):
    """動きの f カーブ。Blender 5 の層と束の中を見る"""
    out = []
    for layer in act.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                out += list(bag.fcurves)
    return out


def canonical_indices(path):
    """.glb の三角の並びをそろえる。書き出しは流すたびに三角の並びが変わるので、向きを変えずに並べ直し、毎回同じ中身にする"""
    data = bytearray(path.read_bytes())
    size = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + size])
    body = 20 + size + 8
    kinds = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32}
    done = set()
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            acc = prim.get("indices")
            if acc is None or acc in done:
                continue
            done.add(acc)
            a = gltf["accessors"][acc]
            view = gltf["bufferViews"][a["bufferView"]]
            kind = kinds[a["componentType"]]
            start = body + view.get("byteOffset", 0) + a.get("byteOffset", 0)
            end = start + a["count"] * np.dtype(kind).itemsize
            tris = np.frombuffer(bytes(data[start:end]), dtype=kind).reshape(-1, 3)
            # 一番小さな番号から始まるように回す (向きは変わらない)
            first = np.argmin(tris, axis=1)
            rolled = np.stack([np.roll(t, -f) for t, f in zip(tris, first)]) if len(tris) else tris
            order = np.lexsort((rolled[:, 2], rolled[:, 1], rolled[:, 0]))
            data[start:end] = rolled[order].astype(kind).tobytes()
    path.write_bytes(bytes(data))


# ---------------------------------------------------------------- 組み立て


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--size", type=int, default=1024, help="テクスチャの一辺")
    ap.add_argument("--density", type=float, default=36000, help="面積 1 あたりの毛の数")
    ap.add_argument("--samples", type=int, default=16)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    rng = np.random.default_rng(SEED)

    # 部位ごとに形を作り、毛を生やす
    step("形と毛")
    meshes, bones, curves, colors, radii = [], [], [], [], []
    head_mesh = None
    for part, spec in parts().items():
        me = metaball_mesh(part, spec["balls"], 0.03 if part in ("head", "body") else 0.024, 0.75 if part.startswith("ear") else 0.45)
        co, nor, tris = mesh_arrays(me)
        if part == "head":
            head_mesh = (co.copy(), tris.copy())
        c, col, r = grow(part, spec, co, nor, tris, rng, args.density)
        step(f"  {part}: 頂点 {len(co)}、三角 {len(tris)}、毛 {len(c)}")
        curves.append(c)
        colors.append(col)
        radii.append(r)
        meshes.append((part, co, nor, tris))
        bones.append(spec["bone"])
        bpy.data.meshes.remove(me)

    # 部位をまとめた軽い形 (画面で描く形)
    step("まとめた形と UV")
    all_co, all_tris, owner = [], [], []
    base = 0
    for i, (_, co, _, tris) in enumerate(meshes):
        all_co.append(co)
        all_tris.append(tris + base)
        owner += [i] * len(co)
        base += len(co)
    co = np.concatenate(all_co)
    tris = np.concatenate(all_tris)
    owner = np.array(owner)
    me = bpy.data.meshes.new("Fur")
    me.from_pydata(co.tolist(), [], tris.tolist())
    me.polygons.foreach_set("use_smooth", [True] * len(tris))
    fur = bpy.data.objects.new("Fur", me)
    scene.collection.objects.link(fur)
    bpy.context.view_layer.objects.active = fur
    fur.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.006, area_weight=1.0, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")

    # 焼き込みの元: 毛の管と、毛の根元の下の地肌
    step("毛の管")
    hair, tubes = hair_object(np.concatenate(curves), np.concatenate(colors), np.concatenate(radii))
    tubes.data.materials.append(emit_material("HairEmit", "furcol"))
    skin_me = me.copy()
    nor = np.concatenate([m[2] for m in meshes])
    skin_me.vertices.foreach_set("co", (co - nor * 0.006).reshape(-1))
    mask = np.zeros(len(co))
    for i, (part, pco, _, _) in enumerate(meshes):
        mask[owner == i] = coat_mask(part, pco)
    attr = skin_me.color_attributes.new("furcol", "FLOAT_COLOR", "POINT")
    attr.data.foreach_set("color", np.stack([mask, np.full(len(co), 0.72), np.zeros(len(co)), np.ones(len(co))], 1).reshape(-1).astype(np.float32))
    skin_me.materials.clear()
    skin_me.materials.append(emit_material("SkinEmit", "furcol"))
    skin_ob = bpy.data.objects.new("Skin", skin_me)
    scene.collection.objects.link(skin_ob)

    # 焼き込みは管にした形から取るので、元の毛は描く物から外す
    bpy.data.objects.remove(hair)
    step("焼き込み")
    images = bake_textures(fur, [tubes, skin_ob], args.size, args.samples)
    step("テクスチャ")
    write_textures(images, args.out)
    for o in (tubes, skin_ob):
        bpy.data.objects.remove(o)

    # 書き出す材質。毛の色と法線のテクスチャは画面で当てる (.glb に画像を入れない)
    me.materials.clear()
    me.materials.append(principled("fur", "#ffffff", roughness=1.0))

    # 顔
    step("顔")
    hco, htris = head_mesh
    bvh = BVHTree.FromPolygons([tuple(v) for v in hco], htris.tolist())
    face = face_object(
        build_face(bvh),
        [
            principled("eye", COLORS["eye"], roughness=0.12),
            principled("shine", "#ffffff", roughness=1.0, emission="#ffffff"),
            principled("nose", COLORS["nose"], roughness=0.3),
            principled("line", COLORS["mouth"], roughness=0.7),
            principled("brow", "#9a7058", roughness=0.9),
            principled("iris", COLORS["iris"], roughness=0.15),
        ],
    )

    step("骨と動き")
    # 骨を入れ、部位ごとに付ける。耳と脚の付け根は頭と胴にも少し重さを残し、曲げた所を割らない
    rig = build_rig()
    weights = {name: np.zeros(len(co)) for name in BONES}
    for i, (part, pco, _, _) in enumerate(meshes):
        idx = owner == i
        bone = bones[i]
        if bone.startswith("ear"):
            w = smooth(0.74, 0.64, pco[:, 2])
            weights[bone][idx] = w
            weights["head"][idx] = 1 - w
        elif bone.startswith("leg"):
            w = smooth(0.17, 0.11, pco[:, 2])
            weights[bone][idx] = w
            weights["body"][idx] = 1 - w
        else:
            weights[bone][idx] = 1.0
    skin(fur, rig, weights)
    skin(face, rig, {"head": np.ones(len(face.data.vertices))})
    make_actions(rig, face)

    for o in scene.objects:
        o.select_set(o in (rig, fur, face))
    step("書き出し")
    bpy.ops.export_scene.gltf(
        filepath=str(args.out / "puppy.glb"),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_skins=True,
        export_morph=True,
        export_morph_normal=False,
        export_try_sparse_sk=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_anim_slide_to_zero=True,
        export_reset_pose_bones=True,
        export_def_bones=False,
        export_leaf_bone=False,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
    )
    canonical_indices(args.out / "puppy.glb")
    print("書いた:", sorted(p.name for p in args.out.iterdir()))


if __name__ == "__main__":
    main()
