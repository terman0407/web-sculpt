// ---------------------------------------------------------------------------
// shaders.js - WGSL シェーダー
//
// パス構成:
//   1. main   : 背景 → メッシュ(MatCap) → ワイヤフレーム  →  colorTex / normalTex / depthTex
//   2. ssao   : compute, depth+normal → aoTex
//   3. blur   : compute, aoTex → aoBlurTex (深度考慮)
//   4. present: fullscreen, FXAA(colorTex) * AO → canvas (linear→sRGB)
//   5. overlay: ブラシリングを canvas に直接描画
// ---------------------------------------------------------------------------

// 行列5 + vec4×10 = 120 float = 480 byte
export const UNIFORM_FLOATS = 5 * 16 + 10 * 4;

// Float32Array 内のオフセット（float 単位）
export const UO = {
  view: 0, proj: 16, viewProj: 32, invProj: 48, invViewProj: 64,
  camPos: 80, params: 84, rt: 88, aoP: 92, bgTop: 96, bgBot: 100, misc: 104,
  cav: 108,        // x キャビティ強度, y ピーク強度, z キャビティゲイン, w 予約
  grid: 112,       // x マス間隔, y 全体サイズ, z 線の太さ, w 表示フラグ
  gridCol: 116,    // rgb 線の色, a 濃さ
};

const COMMON = /* wgsl */`
struct Uniforms {
  view        : mat4x4<f32>,
  proj        : mat4x4<f32>,
  viewProj    : mat4x4<f32>,
  invProj     : mat4x4<f32>,
  invViewProj : mat4x4<f32>,
  camPos      : vec4<f32>,   // xyz カメラ位置
  params      : vec4<f32>,   // x near, y far, z matcapLayer, w flags
  rt          : vec4<f32>,   // x width, y height, z 1/width, w 1/height
  aoP         : vec4<f32>,   // x radius, y intensity, z bias, w power
  bgTop       : vec4<f32>,
  bgBot       : vec4<f32>,
  misc        : vec4<f32>,   // x exposure, y wireAlpha, z maskDarken, w aoEnabled
  cav         : vec4<f32>,   // x cavity, y peak, z gain, w -
  grid        : vec4<f32>,   // x spacing, y extent, z thickness, w floorY
  gridCol     : vec4<f32>,
};

fn linearDepthFromNdc(d: f32, near: f32, far: f32) -> f32 {
  // proj: z' = far/(near-far)*z + far*near/(near-far), w = -z
  return (far * near) / (far + d * (near - far));
}
`;

// ---------------------------------------------------------------------------
// 1a. 背景（フルスクリーン三角形、深度は書かない）
// ---------------------------------------------------------------------------
export const BG_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  var o : VSOut;
  o.pos = vec4<f32>(p[vi], 1.0, 1.0);
  o.uv = vec2<f32>((p[vi].x + 1.0) * 0.5, 1.0 - (p[vi].y + 1.0) * 0.5);
  return o;
}

struct FSOut {
  @location(0) color  : vec4<f32>,
  @location(1) normal : vec4<f32>,
};

@fragment
fn fs(i : VSOut) -> FSOut {
  let t = clamp(i.uv.y, 0.0, 1.0);
  var c = mix(u.bgTop.rgb, u.bgBot.rgb, pow(t, 1.15));
  // 中央に向かってわずかに明るくする（ビネットの逆）
  let d = length(i.uv - vec2<f32>(0.5, 0.5));
  c = c * (1.0 + 0.30 * (1.0 - smoothstep(0.0, 0.9, d)));
  var o : FSOut;
  o.color = vec4<f32>(c, 0.0);
  o.normal = vec4<f32>(0.0, 0.0, 1.0, 0.0);
  return o;
}
`;

// ---------------------------------------------------------------------------
// 1b. メッシュ（MatCap シェーディング）
// ---------------------------------------------------------------------------
export const MESH_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var matcapTex : texture_2d_array<f32>;
@group(0) @binding(2) var matcapSmp : sampler;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vnrm : vec3<f32>,
  @location(1) col  : vec3<f32>,
  @location(2) mask : f32,
  @location(3) curv : f32,
};

@vertex
fn vs(
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) color    : vec3<f32>,
  @location(3) mask     : f32,
  @location(4) curv     : f32,
) -> VSOut {
  var o : VSOut;
  o.pos = u.viewProj * vec4<f32>(position, 1.0);
  o.vnrm = (u.view * vec4<f32>(normal, 0.0)).xyz;
  o.col = color;
  o.mask = mask;
  o.curv = curv;
  return o;
}

struct FSOut {
  @location(0) color  : vec4<f32>,
  @location(1) normal : vec4<f32>,
};

@fragment
fn fs(i : VSOut, @builtin(front_facing) ff : bool) -> FSOut {
  var n = normalize(i.vnrm);
  if (!ff) { n = -n; }

  var uv = n.xy * 0.5 + vec2<f32>(0.5, 0.5);
  uv.y = 1.0 - uv.y;
  let layer = i32(u.params.z);
  var c = textureSampleLevel(matcapTex, matcapSmp, uv, layer, 0.0).rgb;

  c = c * i.col;

  // キャビティシェーディング：離散平均曲率で溝を暗く、稜線をわずかに明るくする。
  // ZBrush で彫刻の形が読み取りやすいのはこの成分によるところが大きい。
  {
    let k = clamp(i.curv * u.cav.z, -1.0, 1.0);
    let cavity = max(k, 0.0);
    let peak = max(-k, 0.0);
    let cd = 1.0 - u.cav.x * (cavity * cavity * (3.0 - 2.0 * cavity));
    c = c * cd;
    c = c + c * (u.cav.y * peak * peak);
  }

  // マスク表示（ZBrush 風に暗い青灰色）
  let mk = clamp(i.mask, 0.0, 1.0) * u.misc.z;
  if (mk > 0.001) {
    let g = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    let mc = mix(vec3<f32>(g, g, g), vec3<f32>(0.16, 0.21, 0.30), 0.6) * 0.72;
    c = mix(c, mc, mk);
  }

  var o : FSOut;
  o.color = vec4<f32>(c * u.misc.x, 1.0);
  o.normal = vec4<f32>(n, 1.0);
  return o;
}
`;

// ---------------------------------------------------------------------------
// 1c. ワイヤフレーム（line-list）
// ---------------------------------------------------------------------------
export const WIRE_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u : Uniforms;

struct FSOut {
  @location(0) color  : vec4<f32>,
  @location(1) normal : vec4<f32>,
};

@vertex
fn vs(@location(0) position : vec3<f32>) -> @builtin(position) vec4<f32> {
  var p = u.viewProj * vec4<f32>(position, 1.0);
  p.z = p.z - 0.00012 * p.w;   // 深度バイアス（線には depthBias が効かないため手動）
  return p;
}

@fragment
fn fs() -> FSOut {
  var o : FSOut;
  o.color = vec4<f32>(0.02, 0.03, 0.04, u.misc.y);
  o.normal = vec4<f32>(0.0, 0.0, 1.0, 1.0);
  return o;
}
`;

// ---------------------------------------------------------------------------
// 1c-2. オーバーレイの線（トランスポーズのハンドル、クリップ平面のガイドなど）
//
// ワイヤフレームと違い頂点ごとに色を持たせる。ハンドルは軸ごとに色を変えたいし、
// 「いま掴んでいるハンドルだけ明るくする」のを CPU 側で色を差し替えて表現したい。
// 深度テストは呼び出し側で 2 通り使う: 隠れる線（形状把握用）と、
// 常に手前に出る線（操作用）。パイプラインを 2 本用意して使い分ける。
// ---------------------------------------------------------------------------
export const OVERLAY_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) color : vec4<f32>,
};

struct FSOut {
  @location(0) color  : vec4<f32>,
  @location(1) normal : vec4<f32>,
};

@vertex
fn vs(@location(0) position : vec3<f32>, @location(1) color : vec4<f32>) -> VSOut {
  var o : VSOut;
  var p = u.viewProj * vec4<f32>(position, 1.0);
  // 線が面と同じ深度に来ると z ファイティングするので少し手前へ寄せる
  p.z = p.z - 0.00030 * p.w;
  o.pos = p;
  o.color = color;
  return o;
}

@fragment
fn fs(i : VSOut) -> FSOut {
  var o : FSOut;
  o.color = i.color;
  o.normal = vec4<f32>(0.0, 0.0, 1.0, 1.0);
  return o;
}
`;

// ---------------------------------------------------------------------------
// 1d. フロアグリッド（Y=0 平面。頂点バッファ不要の大きな四角形を 1 枚描き、
//     フラグメントで解析的にラインを引く。fwidth で距離に応じたアンチエイリアス）
// ---------------------------------------------------------------------------
export const GRID_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) wxz : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var q = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0,  1.0), vec2<f32>(-1.0,  1.0),
  );
  let s = u.grid.y;
  let p = q[vi] * s;
  var o : VSOut;
  o.pos = u.viewProj * vec4<f32>(p.x, u.grid.w, p.y, 1.0);
  o.wxz = p;
  return o;
}

fn gridLine(coord : vec2<f32>, width : f32) -> f32 {
  let d = abs(fract(coord - vec2<f32>(0.5, 0.5)) - vec2<f32>(0.5, 0.5));
  let w = fwidth(coord) * width;
  let g = d / max(w, vec2<f32>(1e-6, 1e-6));
  return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
}

struct GridOut {
  @location(0) color  : vec4<f32>,
  @location(1) normal : vec4<f32>,
};

@fragment
fn fs(i : VSOut) -> GridOut {
  let sp = max(u.grid.x, 1e-6);
  let thick = u.grid.z;

  let fine = gridLine(i.wxz / sp, thick);
  let coarse = gridLine(i.wxz / (sp * 10.0), thick);

  var a = fine * 0.22 + coarse * 0.55;

  // 中心軸を色分けする（X = 赤、Z = 青）
  var col = u.gridCol.rgb;
  let axisW = fwidth(i.wxz) * (thick * 1.6);
  if (abs(i.wxz.y) < axisW.y) { col = vec3<f32>(0.80, 0.30, 0.28); a = max(a, 0.80); }
  if (abs(i.wxz.x) < axisW.x) { col = vec3<f32>(0.32, 0.46, 0.88); a = max(a, 0.80); }

  // カメラからの距離でフェードさせる（地平線まで伸びて主張しないように）
  let wp = vec3<f32>(i.wxz.x, u.grid.w, i.wxz.y);
  let dist = length(wp - u.camPos.xyz);
  a = a * (1.0 - smoothstep(u.grid.y * 0.10, u.grid.y * 0.40, dist));
  a = a * u.gridCol.a;
  if (a < 0.002) { discard; }
  var o : GridOut;
  o.color = vec4<f32>(col * a, a);   // 事前乗算（ブレンドは one / 1-src-alpha）
  o.normal = vec4<f32>(0.0, 0.0, 1.0, 1.0);
  return o;
}
`;

// ---------------------------------------------------------------------------
// 2. SSAO (compute)
// ---------------------------------------------------------------------------
export const SSAO_WGSL = COMMON + /* wgsl */`
struct Kernel { s : array<vec4<f32>, 24> };

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var depthTex  : texture_depth_2d;
@group(0) @binding(2) var normalTex : texture_2d<f32>;
@group(0) @binding(3) var aoOut     : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<uniform> k : Kernel;

fn hash21(p : vec2<f32>) -> f32 {
  var p3 = fract(p.xyx * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 = p3 + vec3<f32>(dot(p3, p3.yzx + vec3<f32>(33.33, 33.33, 33.33)));
  return fract((p3.x + p3.y) * p3.z);
}

fn viewPos(coord : vec2<i32>, d : f32) -> vec3<f32> {
  let uv = (vec2<f32>(f32(coord.x), f32(coord.y)) + vec2<f32>(0.5, 0.5)) * u.rt.zw;
  let ndc = vec3<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0, d);
  let p = u.invProj * vec4<f32>(ndc, 1.0);
  return p.xyz / p.w;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let dim = vec2<i32>(textureDimensions(depthTex));
  let c = vec2<i32>(i32(gid.x), i32(gid.y));
  if (c.x >= dim.x || c.y >= dim.y) { return; }

  let d = textureLoad(depthTex, c, 0);
  if (d >= 0.99999) {
    textureStore(aoOut, c, vec4<f32>(1.0, 1.0, 1.0, 1.0));
    return;
  }

  let vp = viewPos(c, d);
  let n = normalize(textureLoad(normalTex, c, 0).xyz);

  let a = hash21(vec2<f32>(f32(c.x), f32(c.y))) * 6.2831853;
  let rv = vec3<f32>(cos(a), sin(a), 0.0);
  var t = rv - n * dot(rv, n);
  let tl = length(t);
  if (tl < 1e-4) {
    t = normalize(select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n.x) > 0.9));
  } else {
    t = t / tl;
  }
  let b = cross(n, t);

  let radius = u.aoP.x;
  let bias = u.aoP.z;
  var occ = 0.0;
  let N = 24;
  for (var i = 0; i < N; i = i + 1) {
    let ks = k.s[i].xyz;
    let sp = vp + (t * ks.x + b * ks.y + n * ks.z) * radius;
    let cp = u.proj * vec4<f32>(sp, 1.0);
    if (cp.w <= 0.0) { continue; }
    var suv = cp.xy / cp.w;
    suv = vec2<f32>(suv.x * 0.5 + 0.5, 1.0 - (suv.y * 0.5 + 0.5));
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { continue; }
    let sc = vec2<i32>(i32(suv.x * f32(dim.x)), i32(suv.y * f32(dim.y)));
    let sd = textureLoad(depthTex, clamp(sc, vec2<i32>(0, 0), dim - vec2<i32>(1, 1)), 0);
    if (sd >= 0.99999) { continue; }
    let sceneZ = viewPos(sc, sd).z;
    // view 空間では手前ほど z が大きい（-Z 方向を見る）
    if (sceneZ >= sp.z + bias) {
      let rc = smoothstep(0.0, 1.0, radius / max(1e-5, abs(vp.z - sceneZ)));
      occ = occ + rc;
    }
  }
  var ao = 1.0 - occ / f32(N);
  ao = pow(clamp(ao, 0.0, 1.0), u.aoP.w);
  textureStore(aoOut, c, vec4<f32>(ao, ao, ao, 1.0));
}
`;

// ---------------------------------------------------------------------------
// 3. AO ブラー (compute, 深度考慮のクロス 9tap ×2 相当の 5x5)
// ---------------------------------------------------------------------------
export const BLUR_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var aoIn    : texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var aoOut   : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let dim = vec2<i32>(textureDimensions(aoIn));
  let c = vec2<i32>(i32(gid.x), i32(gid.y));
  if (c.x >= dim.x || c.y >= dim.y) { return; }

  let dc = textureLoad(depthTex, c, 0);
  if (dc >= 0.99999) {
    textureStore(aoOut, c, vec4<f32>(1.0, 1.0, 1.0, 1.0));
    return;
  }
  let lc = linearDepthFromNdc(dc, u.params.x, u.params.y);

  var sum = 0.0;
  var wsum = 0.0;
  for (var dy = -2; dy <= 2; dy = dy + 1) {
    for (var dx = -2; dx <= 2; dx = dx + 1) {
      let sc = clamp(c + vec2<i32>(dx, dy), vec2<i32>(0, 0), dim - vec2<i32>(1, 1));
      let sd = textureLoad(depthTex, sc, 0);
      if (sd >= 0.99999) { continue; }
      let ls = linearDepthFromNdc(sd, u.params.x, u.params.y);
      let dw = exp(-abs(ls - lc) / max(1e-5, lc * 0.035));
      let s = textureLoad(aoIn, sc, 0).r;
      sum = sum + s * dw;
      wsum = wsum + dw;
    }
  }
  let ao = select(1.0, sum / wsum, wsum > 1e-5);
  textureStore(aoOut, c, vec4<f32>(ao, ao, ao, 1.0));
}
`;

// ---------------------------------------------------------------------------
// 4. present : FXAA + AO 合成 + sRGB
// ---------------------------------------------------------------------------
export const PRESENT_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var colTex : texture_2d<f32>;
@group(0) @binding(2) var aoTex  : texture_2d<f32>;
@group(0) @binding(3) var smp    : sampler;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  var o : VSOut;
  o.pos = vec4<f32>(p[vi], 0.0, 1.0);
  o.uv = vec2<f32>((p[vi].x + 1.0) * 0.5, 1.0 - (p[vi].y + 1.0) * 0.5);
  return o;
}

fn luma(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }

fn srgbEncode(c : vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(1e-5, 1e-5, 1e-5)), vec3<f32>(1.0 / 2.4, 1.0 / 2.4, 1.0 / 2.4)) - vec3<f32>(0.055);
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

fn fetch(uv : vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(colTex, smp, uv, 0.0).rgb;
}

// FXAA (console 版相当)
fn fxaa(uv : vec2<f32>) -> vec3<f32> {
  let rcp = u.rt.zw;
  let m  = fetch(uv);
  let nw = fetch(uv + vec2<f32>(-rcp.x, -rcp.y));
  let ne = fetch(uv + vec2<f32>( rcp.x, -rcp.y));
  let sw = fetch(uv + vec2<f32>(-rcp.x,  rcp.y));
  let se = fetch(uv + vec2<f32>( rcp.x,  rcp.y));
  let lm = luma(m);
  let lnw = luma(nw); let lne = luma(ne); let lsw = luma(sw); let lse = luma(se);
  let lmin = min(lm, min(min(lnw, lne), min(lsw, lse)));
  let lmax = max(lm, max(max(lnw, lne), max(lsw, lse)));
  if (lmax - lmin < lmax * 0.10 + 0.018) { return m; }

  var dir = vec2<f32>(-((lnw + lne) - (lsw + lse)), ((lnw + lsw) - (lne + lse)));
  let reduce = max((lnw + lne + lsw + lse) * 0.25 * 0.125, 1.0 / 128.0);
  let rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2<f32>(-8.0, -8.0), vec2<f32>(8.0, 8.0)) * rcp;

  let rA = 0.5 * (fetch(uv + dir * (1.0 / 3.0 - 0.5)) + fetch(uv + dir * (2.0 / 3.0 - 0.5)));
  let rB = rA * 0.5 + 0.25 * (fetch(uv + dir * -0.5) + fetch(uv + dir * 0.5));
  let lb = luma(rB);
  if (lb < lmin || lb > lmax) { return rA; }
  return rB;
}

@fragment
fn fs(i : VSOut) -> @location(0) vec4<f32> {
  // デバッグ表示: 1 = AO のみ
  if (u.params.w > 0.5) {
    let ao = textureSampleLevel(aoTex, smp, i.uv, 0.0).r;
    return vec4<f32>(srgbEncode(vec3<f32>(ao, ao, ao)), 1.0);
  }
  var c = fxaa(i.uv);
  if (u.misc.w > 0.5) {
    let ao = textureSampleLevel(aoTex, smp, i.uv, 0.0).r;
    c = c * mix(1.0, ao, clamp(u.aoP.y, 0.0, 1.0));
  }
  // 軽いビネット
  let d = length(i.uv - vec2<f32>(0.5, 0.5));
  c = c * (1.0 - 0.20 * smoothstep(0.55, 1.15, d));
  return vec4<f32>(srgbEncode(c), 1.0);
}
`;

// ---------------------------------------------------------------------------
// 4b. ピッキング (compute)
//
// 深度テクスチャは「サブリソース全体」しか copyTextureToBuffer できないという
// WebGPU の制約があるため、カーソル周辺の深度探索と逆射影を compute で行い、
// ワールド座標 16 バイトだけを CPU に返す。フル画面のリードバックを避けられる。
// ---------------------------------------------------------------------------
export const PICK_WGSL = COMMON + /* wgsl */`
struct PickParams { cursor : vec4<f32> };      // x px, y py, z 探索半径(px)
struct PickResult { world : vec4<f32> };       // xyz ワールド座標, w 有効フラグ

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var depthTex : texture_depth_2d;
@group(0) @binding(2) var<uniform> pp : PickParams;
@group(0) @binding(3) var<storage, read_write> outBuf : PickResult;

@compute @workgroup_size(1, 1, 1)
fn main() {
  let dim = vec2<i32>(textureDimensions(depthTex));
  let cx = i32(pp.cursor.x);
  let cy = i32(pp.cursor.y);
  let rad = i32(pp.cursor.z);

  var bestD = 1.0;
  var bestX = -1;
  var bestY = -1;
  var bestDist = 1.0e30;

  for (var dy = -rad; dy <= rad; dy = dy + 1) {
    for (var dx = -rad; dx <= rad; dx = dx + 1) {
      let x = cx + dx;
      let y = cy + dy;
      if (x < 0 || y < 0 || x >= dim.x || y >= dim.y) { continue; }
      let d = textureLoad(depthTex, vec2<i32>(x, y), 0);
      if (d >= 0.999999) { continue; }
      let dist = f32(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestD = d;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestX < 0) {
    outBuf.world = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return;
  }
  let uv = (vec2<f32>(f32(bestX), f32(bestY)) + vec2<f32>(0.5, 0.5)) * u.rt.zw;
  let ndc = vec3<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0, bestD);
  let p = u.invViewProj * vec4<f32>(ndc, 1.0);
  let w = select(p.w, 1.0, abs(p.w) < 1.0e-12);
  outBuf.world = vec4<f32>(p.xyz / w, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 5. overlay : ブラシリング（頂点バッファ不要、line-list）
// ---------------------------------------------------------------------------
export const RING_WGSL = COMMON + /* wgsl */`
struct RingU {
  xf    : array<mat4x4<f32>, 8>,
  color : vec4<f32>,
  info  : vec4<f32>,   // x segments, y inner scale
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(1) @binding(0) var<uniform> r : RingU;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) fade : f32,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  let segs = u32(r.info.x);
  let perRing = segs * 2u;
  let ringIdx = vi / perRing;
  let local = vi % perRing;
  let seg = local / 2u;
  let end = local % 2u;
  let a = (f32(seg) + f32(end)) / f32(segs) * 6.2831853;
  var scale = 1.0;
  if (ringIdx == 1u) { scale = r.info.y; }
  let p = vec3<f32>(cos(a) * scale, sin(a) * scale, 0.0);
  var o : VSOut;
  o.pos = u.viewProj * r.xf[ii] * vec4<f32>(p, 1.0);
  o.fade = select(1.0, 0.45, ringIdx == 1u);
  return o;
}

@fragment
fn fs(i : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(r.color.rgb, r.color.a * i.fade);
}
`;
