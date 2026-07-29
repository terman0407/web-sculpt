// ---------------------------------------------------------------------------
// renderer.js - WebGPU レンダラ
//
//  * メッシュ頂点は「非インターリーブ 4 バッファ」構成（pos / nrm / col / mask）。
//    CPU 側の配列をそのまま dirty レンジ転送できるので、彫刻中の再パックが不要。
//  * ピッキングは深度テクスチャの 8x8 リードバック → 逆射影。CPU 側に加速構造を
//    持たずに O(1) でオクルージョン込みの正確な表面座標が得られる。
// ---------------------------------------------------------------------------

import { clamp, M4, V3 } from './math.js';
import { DIRTY_SHIFT, DIRTY_BLOCK } from './mesh.js';
import { generateMatcapLayer, MATERIALS } from './matcap.js';
import {
  UNIFORM_FLOATS, UO,
  BG_WGSL, MESH_WGSL, SHADOW_WGSL, WIRE_WGSL, OVERLAY_WGSL, GRID_WGSL, SSAO_WGSL, BLUR_WGSL, PRESENT_WGSL, RING_WGSL, PICK_WGSL,
} from './shaders.js';

const COLOR_FORMAT = 'rgba16float';
const NORMAL_FORMAT = 'rgba16float';
const DEPTH_FORMAT = 'depth32float';
const AO_FORMAT = 'rgba8unorm';
const RING_SEGMENTS = 96;
const PICK_SEARCH = 4;               // カーソル周辺の深度探索半径（px）
const PICK_BYTES = 16;               // vec4<f32>
// シャドウマップの一辺。2048² の depth32float で 16MB。仕上げレンダリング専用で、
// 実時間表示では描画すらしないので常時確保でも実害はない。
const SHADOW_SIZE = 2048;

/** 1 / 2 / 5 × 10^n に丸める（グリッド間隔用） */
function niceStep(x) {
  if (!(x > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  const s = m < 1.5 ? 1 : (m < 3.5 ? 2 : (m < 7.5 ? 5 : 10));
  return s * e;
}

function ssaoKernel(n = 24) {
  const a = new Float32Array(n * 4);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    let x, y, z, l;
    do {
      x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd();
      l = Math.hypot(x, y, z);
    } while (l < 0.15 || l > 1);
    x /= l; y /= l; z /= l;
    let s = i / n;
    s = 0.18 + 0.82 * s * s;
    a[i * 4] = x * s; a[i * 4 + 1] = y * s; a[i * 4 + 2] = z * s; a[i * 4 + 3] = 0;
  }
  return a;
}

export class Renderer {
  constructor(canvas, device, context, format) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;

    this.renderScale = 1;
    this.rtW = 1; this.rtH = 1;
    this.targets = null;

    this.uniformData = new Float32Array(UNIFORM_FLOATS);
    this.uniformBuf = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // AO のサンプル方向。実時間表示は先頭 24 個、仕上げレンダリングは 64 個を使う
    // （シェーダ側はループ回数を uniform で変えるだけ）。
    this.kernelBuf = device.createBuffer({
      size: 64 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.kernelBuf, 0, ssaoKernel(64));

    // リングオーバーレイ用ユニフォーム: mat4x4 * 8 + color + info
    this.ringData = new Float32Array(8 * 16 + 4 + 4);
    this.ringBuf = device.createBuffer({
      size: this.ringData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // --- メッシュ用 GPU バッファ ---
    this.gpuCapV = 0;
    this.gpuCapT = 0;

    // 非アクティブなサブツールの静的バッファ（id → スロット）
    this.staticSlots = new Map();

    // 部分表示用インデックス（0 なら全部描く）
    this.visIb = null;
    this.visCap = 0;
    this.visCount = 0;
    // オーバーレイ線（位置 vec3 + 色 vec4 = 7 float / 頂点）
    this.overlayBuf = null;
    this.overlayCap = 0;
    this.overlayCount = 0;
    this.overlayFront = true;
    this.vbPos = null; this.vbNrm = null; this.vbCol = null; this.vbMask = null; this.vbCurv = null;
    this.ib = null;
    this.wireIb = null;
    this.wireCapT = 0;
    this.wireCount = 0;
    this.wireVersion = -1;
    this.wireBuiltAt = 0;

    // --- ピッキング ---
    this.pickParams = new Float32Array(4);
    this.pickParamsBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pickResultBuf = device.createBuffer({
      size: PICK_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.pickPool = [];
    for (let i = 0; i < 3; i++) {
      this.pickPool.push({
        buffer: device.createBuffer({
          size: PICK_BYTES,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        busy: false,
      });
    }
    this.pickRequest = null;
    this.pick = { ok: false, point: new Float32Array(3) };

    this.frame = 0;
    this._buildStatic();
    this.resize();
  }

  static async create(canvas) {
    if (!navigator.gpu) throw new Error('このブラウザは WebGPU に対応していません。');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU アダプタを取得できませんでした。');
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 * 1024 * 1024),
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('webgpu コンテキストを取得できませんでした。');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const r = new Renderer(canvas, device, context, format);
    r.adapterInfo = adapter.info || {};
    device.lost.then((info) => {
      console.error('WebGPU device lost:', info.message);
      if (r.onDeviceLost) r.onDeviceLost(info);
    });
    return r;
  }

  // -----------------------------------------------------------------------
  // パイプライン / 静的リソース
  // -----------------------------------------------------------------------
  _buildStatic() {
    const d = this.device;
    // パイプラインの生成が失敗しても例外にならず、使ったときに
    // 「is invalid due to a previous error」という形で初めて表に出る。
    // それだと原因のシェーダが分からないので、ここで捕まえて記録する。
    // スコープは **この関数の最後で** 閉じること（すぐ pop すると何も入らない）。
    this.buildError = null;
    d.pushErrorScope('validation');

    // binding 3/4 はシャドウマップ。使うのは MESH シェーダだけだが、
    // bglMain は BG / WIRE / GRID / OVERLAY でも共有している。WebGPU では
    // シェーダがレイアウトの一部だけを使うのは許されるので、まとめて持たせる。
    this.bglMain = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    this.bglRing = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    // シャドウマップを描くパス専用。**bgMain は使えない**。
    // bgMain にはシャドウマップ自体がテクスチャとして入っているので、
    // 同じパスで「書き込み対象」と「読み取り対象」を兼ねることになり、
    // WebGPU に弾かれる（usage includes writable usage and another usage
    // in the same synchronization scope）。ユニフォームだけを渡す。
    this.bglShadow = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    this.bglSSAO = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: AO_FORMAT } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    this.bglBlur = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: AO_FORMAT } },
      ],
    });
    this.bglPick = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.bglPresent = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // 輪郭線と透明背景の判定に深度と法線を読む
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const mod = (code) => d.createShaderModule({ code });
    const bgMod = mod(BG_WGSL);
    const meshMod = mod(MESH_WGSL);
    const wireMod = mod(WIRE_WGSL);
    const gridMod = mod(GRID_WGSL);
    const overlayMod = mod(OVERLAY_WGSL);
    const ssaoMod = mod(SSAO_WGSL);
    const blurMod = mod(BLUR_WGSL);
    const presentMod = mod(PRESENT_WGSL);
    const ringMod = mod(RING_WGSL);
    const pickMod = mod(PICK_WGSL);

    const mainLayout = d.createPipelineLayout({ bindGroupLayouts: [this.bglMain] });
    const depthState = (write, compare) => ({
      format: DEPTH_FORMAT, depthWriteEnabled: write, depthCompare: compare,
    });

    this.pipeBg = d.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: bgMod, entryPoint: 'vs' },
      fragment: {
        module: bgMod, entryPoint: 'fs',
        targets: [{ format: COLOR_FORMAT }, { format: NORMAL_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthState(false, 'always'),
    });

    const vbLayouts = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }] },
      { arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }] },
      { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32' }] },
    ];
    const alphaBlend = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    this.pipeMesh = d.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: meshMod, entryPoint: 'vs', buffers: vbLayouts },
      fragment: {
        module: meshMod, entryPoint: 'fs',
        targets: [{ format: COLOR_FORMAT }, { format: NORMAL_FORMAT }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState(true, 'less'),
    });

    // シャドウマップ（深度だけ。色の添付なし）
    const shadowMod = mod(SHADOW_WGSL);
    this.pipeShadow = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bglShadow] }),
      vertex: {
        module: shadowMod, entryPoint: 'vs',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState(true, 'less'),
    });
    this.bgShadow = d.createBindGroup({
      layout: this.bglShadow,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }],
    });

    this.pipeWire = d.createRenderPipeline({
      layout: mainLayout,
      vertex: {
        module: wireMod, entryPoint: 'vs',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: {
        module: wireMod, entryPoint: 'fs',
        targets: [
          {
            format: COLOR_FORMAT,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
          { format: NORMAL_FORMAT, writeMask: 0 },
        ],
      },
      primitive: { topology: 'line-list' },
      depthStencil: depthState(false, 'less-equal'),
    });

    // オーバーレイの線。頂点は (位置 vec3, 色 vec4) の 28 バイトストライド。
    // depth 付き（形状に隠れる）と depth 無し（常に手前）の 2 本を作り、
    // ハンドルは「隠れる線を薄く + 手前の線を濃く」の重ね描きで見やすくする。
    const overlayVB = [{
      arrayStride: 28,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x4' },
      ],
    }];
    const overlayTargets = [
      { format: COLOR_FORMAT, blend: alphaBlend },
      { format: NORMAL_FORMAT, writeMask: 0 },
    ];
    this.pipeOverlay = d.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: overlayMod, entryPoint: 'vs', buffers: overlayVB },
      fragment: { module: overlayMod, entryPoint: 'fs', targets: overlayTargets },
      primitive: { topology: 'line-list' },
      depthStencil: depthState(false, 'less-equal'),
    });
    this.pipeOverlayFront = d.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: overlayMod, entryPoint: 'vs', buffers: overlayVB },
      fragment: { module: overlayMod, entryPoint: 'fs', targets: overlayTargets },
      primitive: { topology: 'line-list' },
      depthStencil: depthState(false, 'always'),
    });

    // フロアグリッドはメッシュの後に描く（深度テストのみ、書き込みなし）
    this.pipeGrid = d.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: gridMod, entryPoint: 'vs' },
      fragment: {
        module: gridMod, entryPoint: 'fs',
        targets: [
          { format: COLOR_FORMAT, blend: alphaBlend },
          { format: NORMAL_FORMAT, writeMask: 0 },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState(false, 'less'),
    });

    this.pipeSSAO = d.createComputePipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bglSSAO] }),
      compute: { module: ssaoMod, entryPoint: 'main' },
    });
    this.pipeBlur = d.createComputePipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bglBlur] }),
      compute: { module: blurMod, entryPoint: 'main' },
    });
    this.pipePick = d.createComputePipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bglPick] }),
      compute: { module: pickMod, entryPoint: 'main' },
    });

    this.pipePresent = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bglPresent] }),
      vertex: { module: presentMod, entryPoint: 'vs' },
      fragment: { module: presentMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.pipeRing = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bglMain, this.bglRing] }),
      vertex: { module: ringMod, entryPoint: 'vs' },
      fragment: {
        module: ringMod, entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'line-list' },
    });

    // --- MatCap テクスチャ ---
    // MatCap は 1 枚 9ms かかる。起動時は表示中の 1 枚だけ作り、
    // 残りは初回描画のあとにアイドル時間で埋める（起動を 80ms ほど短縮）。
    const MC_SIZE = 256;
    this.matcapSize = MC_SIZE;
    this.matcapCount = MATERIALS.length;
    this.materialNames = MATERIALS.map(m => m.jp);
    this.matcapReady = new Uint8Array(this.matcapCount);
    this.matcapTex = d.createTexture({
      size: [MC_SIZE, MC_SIZE, this.matcapCount],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.ensureMatcap(0);

    this.linearSampler = d.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    // 比較サンプラ。ハードウェアの深度比較 + 線形補間が使えるので、
    // 3x3 の PCF が実質 3x3 の「なめらかな」比較になる。
    this.shadowSampler = d.createSampler({
      compare: 'less-equal',
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
    this.matcapView = this.matcapTex.createView({ dimension: '2d-array' });
    this._ensureShadowMap(SHADOW_SIZE);
    this._rebuildMainBG();

    this.bgRing = d.createBindGroup({
      layout: this.bglRing,
      entries: [{ binding: 0, resource: { buffer: this.ringBuf } }],
    });

    d.popErrorScope().then((e) => {
      if (!e) return;
      this.buildError = e.message;
      console.error('パイプラインの生成に失敗しました:\n' + e.message);
    });
  }

  /** 指定マテリアルの MatCap をまだ作っていなければ生成して該当レイヤへ書く */
  ensureMatcap(index) {
    if (index < 0 || index >= this.matcapCount || this.matcapReady[index]) return false;
    const size = this.matcapSize;
    const data = generateMatcapLayer(index, size);
    this.device.queue.writeTexture(
      { texture: this.matcapTex, origin: { x: 0, y: 0, z: index } },
      data,
      { bytesPerRow: size * 4, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: 1 },
    );
    this.matcapReady[index] = 1;
    return true;
  }

  /** まだ作っていない MatCap を 1 枚だけ埋める。毎フレーム呼んで少しずつ進める */
  fillNextMatcap() {
    for (let i = 0; i < this.matcapCount; i++) {
      if (!this.matcapReady[i]) return this.ensureMatcap(i);
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // リサイズ / レンダーターゲット
  // -----------------------------------------------------------------------
  setRenderScale(s) {
    const ns = clamp(s, 0.5, 2);
    if (Math.abs(ns - this.renderScale) < 1e-4) return;
    this.renderScale = ns;
    this.resize(true);
  }

  resize(force = false) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(1, this.canvas.clientWidth || this.canvas.width);
    const cssH = Math.max(1, this.canvas.clientHeight || this.canvas.height);
    const cw = Math.max(1, Math.round(cssW * dpr));
    const ch = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
      force = true;
    }
    const w = Math.max(8, Math.round(cw * this.renderScale));
    const h = Math.max(8, Math.round(ch * this.renderScale));
    if (!force && w === this.rtW && h === this.rtH) return;
    this.rtW = w; this.rtH = h;
    this._resizeTo(w, h);
  }

  /**
   * 描画ターゲットとバインドグループを w×h で作り直す。
   * 仕上げレンダリングが一時的に解像度を上げるためにも使うので、
   * canvas のサイズ計算とは切り離してある。
   */
  _resizeTo(w, h) {
    const d = this.device;
    if (this.targets) {
      for (const t of Object.values(this.targets)) { if (t.destroy) t.destroy(); }
    }
    const color = d.createTexture({
      size: [w, h], format: COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const normal = d.createTexture({
      size: [w, h], format: NORMAL_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const depth = d.createTexture({
      size: [w, h], format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const ao = d.createTexture({
      size: [w, h], format: AO_FORMAT,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const aoBlur = d.createTexture({
      size: [w, h], format: AO_FORMAT,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.targets = { color, normal, depth, ao, aoBlur };
    this.views = {
      color: color.createView(), normal: normal.createView(), depth: depth.createView(),
      ao: ao.createView(), aoBlur: aoBlur.createView(),
    };

    this.bgSSAO = d.createBindGroup({
      layout: this.bglSSAO,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.views.depth },
        { binding: 2, resource: this.views.normal },
        { binding: 3, resource: this.views.ao },
        { binding: 4, resource: { buffer: this.kernelBuf } },
      ],
    });
    this.bgBlur = d.createBindGroup({
      layout: this.bglBlur,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.views.ao },
        { binding: 2, resource: this.views.depth },
        { binding: 3, resource: this.views.aoBlur },
      ],
    });
    this.bgPick = d.createBindGroup({
      layout: this.bglPick,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.views.depth },
        { binding: 2, resource: { buffer: this.pickParamsBuf } },
        { binding: 3, resource: { buffer: this.pickResultBuf } },
      ],
    });
    this.bgPresent = d.createBindGroup({
      layout: this.bglPresent,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.views.color },
        { binding: 2, resource: this.views.aoBlur },
        { binding: 3, resource: this.linearSampler },
        { binding: 4, resource: this.views.depth },
        { binding: 5, resource: this.views.normal },
      ],
    });
    this._rebuildMainBG();
  }

  /**
   * bgMain を作り直す。シャドウマップの view を含むので、
   * シャドウマップを張り替えたときと解像度を変えたときの両方で呼ぶ。
   */
  _rebuildMainBG() {
    const d = this.device;
    if (!this.shadowTex) this._ensureShadowMap(SHADOW_SIZE);
    this.bgMain = d.createBindGroup({
      layout: this.bglMain,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.matcapView },
        { binding: 2, resource: this.linearSampler },
        { binding: 3, resource: this.shadowView },
        { binding: 4, resource: this.shadowSampler },
      ],
    });
  }

  /** シャドウマップ（深度のみ）を用意する */
  _ensureShadowMap(size) {
    if (this.shadowTex && this.shadowSize === size) return;
    if (this.shadowTex) this.shadowTex.destroy();
    this.shadowSize = size;
    this.shadowTex = this.device.createTexture({
      size: [size, size], format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTex.createView();
  }

  // -----------------------------------------------------------------------
  // 非アクティブなサブツールの静的バッファ
  //
  // アクティブなサブツールは既存の vbPos… を dirty 転送で毎フレーム更新する。
  // 非アクティブなものは彫刻されないので、一度だけ丸ごと上げて置いておけばよい。
  // パイプラインと頂点レイアウトはアクティブと同じなので、描画時にバッファを
  // 差し替えるだけで済む。
  // -----------------------------------------------------------------------

  /** id のスロットを（無ければ作って）返す。geomVersion が変わっていたら上げ直す */
  ensureStatic(id, mesh) {
    let slot = this.staticSlots.get(id);
    const needCapV = mesh.nv, needCapT = mesh.nt;
    if (slot && (slot.capV < needCapV || slot.capT < needCapT)) {
      this.destroyStatic(id);
      slot = null;
    }
    const d = this.device;
    if (!slot) {
      const vu = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
      const capV = Math.max(1, needCapV), capT = Math.max(1, needCapT);
      slot = {
        capV, capT,
        pos: d.createBuffer({ size: capV * 12, usage: vu }),
        nrm: d.createBuffer({ size: capV * 12, usage: vu }),
        col: d.createBuffer({ size: capV * 12, usage: vu }),
        msk: d.createBuffer({ size: capV * 4, usage: vu }),
        crv: d.createBuffer({ size: capV * 4, usage: vu }),
        ib: d.createBuffer({ size: capT * 12, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }),
        count: 0,
        stamp: -1,
      };
      this.staticSlots.set(id, slot);
    }
    // 形や色が変わっていたら上げ直す。geomVersion と topoVersion の両方を見る
    const stamp = mesh.geomVersion * 1048576 + mesh.topoVersion;
    if (slot.stamp !== stamp) {
      d.queue.writeBuffer(slot.pos, 0, mesh.positions, 0, mesh.nv * 3);
      d.queue.writeBuffer(slot.nrm, 0, mesh.normals, 0, mesh.nv * 3);
      d.queue.writeBuffer(slot.col, 0, mesh.colors, 0, mesh.nv * 3);
      d.queue.writeBuffer(slot.msk, 0, mesh.mask, 0, mesh.nv);
      d.queue.writeBuffer(slot.crv, 0, mesh.curv, 0, mesh.nv);
      d.queue.writeBuffer(slot.ib, 0, mesh.tris, 0, mesh.nt * 3);
      slot.count = mesh.nt * 3;
      slot.stamp = stamp;
    }
    return slot;
  }

  destroyStatic(id) {
    const slot = this.staticSlots.get(id);
    if (!slot) return;
    for (const b of [slot.pos, slot.nrm, slot.col, slot.msk, slot.crv, slot.ib]) {
      if (b) b.destroy();
    }
    this.staticSlots.delete(id);
  }

  /** 使われていないスロットを片付ける（keep に無い id を捨てる） */
  pruneStatic(keep) {
    for (const id of [...this.staticSlots.keys()]) {
      if (!keep.has(id)) this.destroyStatic(id);
    }
    // drawSlots は破棄したスロットを掴んでいる可能性があるので必ず落とす。
    // 次のフレームで syncSubtoolSlots が作り直す。残すと破棄済みバッファを
    // バインドしかねない。
    this.drawSlots = null;
  }

  // -----------------------------------------------------------------------
  // メッシュ転送
  // -----------------------------------------------------------------------
  syncMesh(mesh) {
    const d = this.device;
    let full = false;

    if (mesh.capV > this.gpuCapV) {
      const cap = mesh.capV;
      for (const b of [this.vbPos, this.vbNrm, this.vbCol, this.vbMask, this.vbCurv]) if (b) b.destroy();
      const vu = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
      this.vbPos = d.createBuffer({ size: cap * 12, usage: vu });
      this.vbNrm = d.createBuffer({ size: cap * 12, usage: vu });
      this.vbCol = d.createBuffer({ size: cap * 12, usage: vu });
      this.vbMask = d.createBuffer({ size: cap * 4, usage: vu });
      this.vbCurv = d.createBuffer({ size: cap * 4, usage: vu });
      this.gpuCapV = cap;
      full = true;
    }
    if (mesh.capT > this.gpuCapT) {
      if (this.ib) this.ib.destroy();
      this.ib = d.createBuffer({
        size: mesh.capT * 12,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.gpuCapT = mesh.capT;
      full = true;
    }

    if (full) {
      d.queue.writeBuffer(this.vbPos, 0, mesh.positions, 0, mesh.nv * 3);
      d.queue.writeBuffer(this.vbNrm, 0, mesh.normals, 0, mesh.nv * 3);
      d.queue.writeBuffer(this.vbCol, 0, mesh.colors, 0, mesh.nv * 3);
      d.queue.writeBuffer(this.vbMask, 0, mesh.mask, 0, mesh.nv);
      d.queue.writeBuffer(this.vbCurv, 0, mesh.curv, 0, mesh.nv);
      d.queue.writeBuffer(this.ib, 0, mesh.tris, 0, mesh.nt * 3);
      mesh.clearDirty();
      return;
    }

    // dirty をブロック単位で見て、連続する塊だけを転送する。
    // min〜max の 1 区間で送ると、ブラシが触れた頂点がインデックス上に
    // 散らばっている場合に配列全体（数百万頂点 = 100MB 超）を毎フレーム送ることになる。
    if (mesh.vBlockMax >= mesh.vBlockMin) {
      const blocks = mesh.vBlocks;
      let run = -1;
      for (let b = mesh.vBlockMin; b <= mesh.vBlockMax + 1; b++) {
        const on = b <= mesh.vBlockMax && blocks[b] === 1;
        if (on && run < 0) run = b;
        else if (!on && run >= 0) {
          const a = run * DIRTY_BLOCK;
          const e = Math.min(mesh.nv, b * DIRTY_BLOCK);
          const n = e - a;
          if (n > 0) {
            d.queue.writeBuffer(this.vbPos, a * 12, mesh.positions, a * 3, n * 3);
            d.queue.writeBuffer(this.vbNrm, a * 12, mesh.normals, a * 3, n * 3);
            d.queue.writeBuffer(this.vbCol, a * 12, mesh.colors, a * 3, n * 3);
            d.queue.writeBuffer(this.vbMask, a * 4, mesh.mask, a, n);
            d.queue.writeBuffer(this.vbCurv, a * 4, mesh.curv, a, n);
          }
          run = -1;
        }
      }
    }
    if (mesh.tBlockMax >= mesh.tBlockMin) {
      const blocks = mesh.tBlocks;
      let run = -1;
      for (let b = mesh.tBlockMin; b <= mesh.tBlockMax + 1; b++) {
        const on = b <= mesh.tBlockMax && blocks[b] === 1;
        if (on && run < 0) run = b;
        else if (!on && run >= 0) {
          const a = run * DIRTY_BLOCK;
          const e = Math.min(mesh.nt, b * DIRTY_BLOCK);
          if (e > a) d.queue.writeBuffer(this.ib, a * 12, mesh.tris, a * 3, (e - a) * 3);
          run = -1;
        }
      }
    }
    mesh.clearDirty();
  }

  /**
   * 部分表示のインデックスを差し替える。null / count 0 を渡すと全体表示に戻る。
   * ポリグループの表示状態が変わったときだけ呼ぶ（毎フレーム呼ぶものではない）。
   */
  setVisibleIndices(indices, count) {
    if (!indices || !count) { this.visCount = 0; return; }
    const d = this.device;
    if (!this.visIb || this.visCap < count) {
      if (this.visIb) this.visIb.destroy();
      this.visCap = Math.ceil(count * 1.4);
      this.visIb = d.createBuffer({
        size: this.visCap * 4,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    }
    d.queue.writeBuffer(this.visIb, 0, indices, 0, count);
    this.visCount = count;
  }

  /**
   * オーバーレイの線を差し替える。
   * @param {Float32Array} verts (x,y,z,r,g,b,a) を線分の端点ごとに並べたもの
   * @param {number} vertCount   頂点数（線分数 × 2）
   * @param {boolean} front      形状に隠れずに常に手前へ描くか
   */
  setOverlayLines(verts, vertCount, front = true) {
    if (!verts || !vertCount) { this.overlayCount = 0; return; }
    const d = this.device;
    const need = vertCount * 7;
    if (!this.overlayBuf || this.overlayCap < need) {
      if (this.overlayBuf) this.overlayBuf.destroy();
      this.overlayCap = Math.ceil(need * 1.5);
      this.overlayBuf = d.createBuffer({
        size: this.overlayCap * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    d.queue.writeBuffer(this.overlayBuf, 0, verts, 0, need);
    this.overlayCount = vertCount;
    this.overlayFront = front;
  }

  _syncWireframe(mesh, now) {
    if (mesh.topoVersion === this.wireVersion) return;
    if (this.wireVersion >= 0 && now - this.wireBuiltAt < 160) return;   // 構築を間引く
    const d = this.device;
    const need = mesh.liveTris * 6;
    if (need === 0) { this.wireCount = 0; this.wireVersion = mesh.topoVersion; return; }
    if (!this.wireIb || this.wireCapT < need) {
      if (this.wireIb) this.wireIb.destroy();
      this.wireCapT = Math.ceil(need * 1.4);
      this.wireIb = d.createBuffer({
        size: this.wireCapT * 4,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    }
    const arr = new Uint32Array(need);
    const T = mesh.tris;
    let w = 0;
    for (let t = 0; t < mesh.nt; t++) {
      const i = t * 3;
      const a = T[i], b = T[i + 1], c = T[i + 2];
      if (a === b && b === c) continue;
      arr[w++] = a; arr[w++] = b;
      arr[w++] = b; arr[w++] = c;
      arr[w++] = c; arr[w++] = a;
    }
    d.queue.writeBuffer(this.wireIb, 0, arr, 0, w);
    this.wireCount = w;
    this.wireVersion = mesh.topoVersion;
    this.wireBuiltAt = now;
  }

  // -----------------------------------------------------------------------
  // ピッキング
  // -----------------------------------------------------------------------
  /** CSS ピクセル座標で要求（次フレーム以降に this.pick が更新される） */
  requestPick(cssX, cssY) {
    this.pickRequest = { x: cssX, y: cssY };
  }

  _encodePick(encoder) {
    if (!this.pickRequest) return null;
    const slot = this.pickPool.find(s => !s.busy);
    if (!slot) return null;

    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth || this.canvas.width);
    const px = Math.round(this.pickRequest.x * dpr * this.renderScale);
    const py = Math.round(this.pickRequest.y * dpr * this.renderScale);
    if (px < 0 || py < 0 || px >= this.rtW || py >= this.rtH) {
      this.pick.ok = false;
      return null;
    }

    this.pickParams[0] = px;
    this.pickParams[1] = py;
    this.pickParams[2] = PICK_SEARCH;
    this.pickParams[3] = 0;
    this.device.queue.writeBuffer(this.pickParamsBuf, 0, this.pickParams);

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipePick);
    pass.setBindGroup(0, this.bgPick);
    pass.dispatchWorkgroups(1);
    pass.end();

    encoder.copyBufferToBuffer(this.pickResultBuf, 0, slot.buffer, 0, PICK_BYTES);
    slot.busy = true;
    return slot;
  }

  _resolvePick(slot) {
    slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
      const f = new Float32Array(slot.buffer.getMappedRange().slice(0));
      slot.buffer.unmap();
      slot.busy = false;
      if (f[3] < 0.5 || !Number.isFinite(f[0]) || !Number.isFinite(f[1]) || !Number.isFinite(f[2])) {
        this.pick.ok = false;
        return;
      }
      this.pick.point[0] = f[0];
      this.pick.point[1] = f[1];
      this.pick.point[2] = f[2];
      this.pick.ok = true;
    }).catch(() => { slot.busy = false; });
  }

  // -----------------------------------------------------------------------
  // 描画
  // -----------------------------------------------------------------------
  /**
   * @param camera OrbitCamera
   * @param mesh   SculptMesh
   * @param state  表示設定
   * @param rings  [{pos:Float32Array(3), normal:Float32Array(3), radius:number}] 最大 8
   */
  render(camera, mesh, state, rings) {
    this.frame++;
    const d = this.device;
    const now = performance.now();

    // --- ユニフォーム ---
    const U = this.uniformData;
    U.set(camera.view, UO.view);
    U.set(camera.proj, UO.proj);
    U.set(camera.viewProj, UO.viewProj);
    U.set(camera.invProj, UO.invProj);
    U.set(camera.invViewProj, UO.invViewProj);
    U[UO.camPos] = camera.eye[0]; U[UO.camPos + 1] = camera.eye[1];
    U[UO.camPos + 2] = camera.eye[2]; U[UO.camPos + 3] = 1;
    U[UO.params] = camera.near;
    U[UO.params + 1] = camera.far;
    const matIdx = clamp(state.material | 0, 0, this.matcapCount - 1);
    this.ensureMatcap(matIdx);   // 未生成なら即座に作る（切り替え時 9ms）
    U[UO.params + 2] = matIdx;
    U[UO.params + 3] = state.debugView || 0;
    U[UO.rt] = this.rtW; U[UO.rt + 1] = this.rtH;
    U[UO.rt + 2] = 1 / this.rtW; U[UO.rt + 3] = 1 / this.rtH;
    // AO 半径はモデルスケールに追従させる（凹凸が見えるだけの大きさが必要）
    U[UO.aoP] = Math.max(1e-4, camera.modelRadius * 0.20 * state.aoRadius);
    U[UO.aoP + 1] = state.aoIntensity;
    U[UO.aoP + 2] = Math.max(1e-5, camera.modelRadius * 0.0015);
    U[UO.aoP + 3] = state.aoPower;
    U.set(state.bgTop, UO.bgTop);
    U.set(state.bgBot, UO.bgBot);
    U[UO.misc] = state.exposure;
    U[UO.misc + 1] = state.wireAlpha;
    U[UO.misc + 2] = state.maskDarken;
    U[UO.misc + 3] = state.ao ? 1 : 0;
    U[UO.cav] = state.cavity;
    U[UO.cav + 1] = state.peak;
    U[UO.cav + 2] = state.cavityGain;
    U[UO.cav + 3] = 0;
    // グリッド間隔はモデルサイズに合わせて 1-2-5 系列で丸める
    U[UO.grid] = niceStep(camera.modelRadius * 0.5);
    U[UO.grid + 1] = camera.modelRadius * 16;      // 板の広さ（フェード距離の基準にもなる）
    U[UO.grid + 2] = 1.0;
    U[UO.grid + 3] = state.gridY || 0;             // 床の高さ（モデルの底に合わせる）
    U.set(state.gridColor, UO.gridCol);
    this._writeBpr(null);
    d.queue.writeBuffer(this.uniformBuf, 0, U);

    // --- リング ---
    let ringInstances = 0;
    if (rings && rings.length) {
      ringInstances = Math.min(rings.length, 8);
      for (let i = 0; i < ringInstances; i++) this.ringData.set(rings[i].matrix, i * 16);
      const off = 8 * 16;
      this.ringData[off] = state.ringColor[0];
      this.ringData[off + 1] = state.ringColor[1];
      this.ringData[off + 2] = state.ringColor[2];
      this.ringData[off + 3] = state.ringColor[3];
      this.ringData[off + 4] = RING_SEGMENTS;
      this.ringData[off + 5] = 0.5;
      d.queue.writeBuffer(this.ringBuf, 0, this.ringData);
    }

    this.syncMesh(mesh);
    if (state.wireframe) this._syncWireframe(mesh, now);

    const encoder = d.createCommandEncoder();

    // --- パス1: 背景 + メッシュ + ワイヤ ---
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: this.views.color, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
          { view: this.views.normal, clearValue: { r: 0, g: 0, b: 1, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: this.views.depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
        },
      });
      pass.setBindGroup(0, this.bgMain);

      pass.setPipeline(this.pipeBg);
      pass.draw(3);

      if (mesh.nt > 0 && this.ib) {
        pass.setPipeline(this.pipeMesh);
        pass.setVertexBuffer(0, this.vbPos);
        pass.setVertexBuffer(1, this.vbNrm);
        pass.setVertexBuffer(2, this.vbCol);
        pass.setVertexBuffer(3, this.vbMask);
        pass.setVertexBuffer(4, this.vbCurv);
        // 部分表示（ポリグループのハイド）中は、可視な三角形だけを詰めた
        // インデックスバッファを使う。退化三角形に書き換えて隠す方法もあるが、
        // それだとトポロジ自体を壊すので表示だけ差し替える。
        if (this.visCount > 0 && this.visIb) {
          pass.setIndexBuffer(this.visIb, 'uint32');
          pass.drawIndexed(this.visCount);
        } else {
          pass.setIndexBuffer(this.ib, 'uint32');
          pass.drawIndexed(mesh.nt * 3);
        }
      }

      // 非アクティブなサブツール（静的バッファから描く。彫刻されないので転送不要）
      if (this.drawSlots && this.drawSlots.length) {
        pass.setPipeline(this.pipeMesh);
        for (const sl of this.drawSlots) {
          if (!sl || sl.count === 0) continue;
          pass.setVertexBuffer(0, sl.pos);
          pass.setVertexBuffer(1, sl.nrm);
          pass.setVertexBuffer(2, sl.col);
          pass.setVertexBuffer(3, sl.msk);
          pass.setVertexBuffer(4, sl.crv);
          pass.setIndexBuffer(sl.ib, 'uint32');
          pass.drawIndexed(sl.count);
        }
      }

      // グリッドはメッシュの後（深度テストで隠れるように）
      if (state.grid) {
        pass.setPipeline(this.pipeGrid);
        pass.draw(6);
      }

      if (mesh.nt > 0 && this.ib && state.wireframe && this.wireCount > 0 && this.wireIb) {
        pass.setPipeline(this.pipeWire);
        pass.setVertexBuffer(0, this.vbPos);
        pass.setIndexBuffer(this.wireIb, 'uint32');
        pass.drawIndexed(this.wireCount);
      }

      // オーバーレイの線（トランスポーズのハンドル / クリップのガイド）。
      // 隠れる線を薄く重ねてから手前の線を描くと、奥行きが分かりつつ操作しやすい。
      if (this.overlayCount > 0 && this.overlayBuf) {
        pass.setPipeline(this.pipeOverlay);
        pass.setVertexBuffer(0, this.overlayBuf);
        pass.draw(this.overlayCount);
        if (this.overlayFront) {
          pass.setPipeline(this.pipeOverlayFront);
          pass.setVertexBuffer(0, this.overlayBuf);
          pass.draw(this.overlayCount);
        }
      }
      pass.end();
    }

    // --- パス2/3: SSAO ---
    if (state.ao) {
      const gx = Math.ceil(this.rtW / 8), gy = Math.ceil(this.rtH / 8);
      const p1 = encoder.beginComputePass();
      p1.setPipeline(this.pipeSSAO);
      p1.setBindGroup(0, this.bgSSAO);
      p1.dispatchWorkgroups(gx, gy);
      p1.end();
      const p2 = encoder.beginComputePass();
      p2.setPipeline(this.pipeBlur);
      p2.setBindGroup(0, this.bgBlur);
      p2.dispatchWorkgroups(gx, gy);
      p2.end();
    }

    // --- ピッキング（compute で 1 点だけ逆射影してリードバック） ---
    const pickSlot = this._encodePick(encoder);

    // --- パス4: present ---
    const canvasView = this.context.getCurrentTexture().createView();
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: canvasView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(this.pipePresent);
      pass.setBindGroup(0, this.bgPresent);
      pass.draw(3);
      pass.end();
    }

    // --- パス5: ブラシリング ---
    if (ringInstances > 0) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: canvasView, loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(this.pipeRing);
      pass.setBindGroup(0, this.bgMain);
      pass.setBindGroup(1, this.bgRing);
      pass.draw(RING_SEGMENTS * 2 * 2, ringInstances);
      pass.end();
    }

    d.queue.submit([encoder.finish()]);
    if (pickSlot) this._resolvePick(pickSlot);
  }

  // -----------------------------------------------------------------------
  // 仕上げレンダリング（ZBrush の BPR 相当）
  //
  // ここが GPU の使い所。彫刻の計算を GPU に出すと結果を CPU に戻す転送が
  // 支配的になって遅くなるが（実測 3.2ms 対 27ms）、レンダリングは結果を
  // 戻す必要がない。PNG にするときだけ 1 回読み戻す。
  //
  // やっていること:
  //   1. 光源から深度だけを描く（シャドウマップ）
  //   2. 解像度を 2〜4 倍に上げて本描画（影 + 拡散光つき）
  //   3. AO のサンプル数を 24 → 64 に上げる
  //   4. 輪郭線を合成
  //   5. 読み戻して JS 側で N×N を平均（スーパーサンプリングの解決）
  // 4 の輪郭線と 5 の平均以外は実時間表示と同じパイプラインを使い回す。
  // -----------------------------------------------------------------------

  /** BPR 用ユニフォームを書く。opts が null なら実時間表示の値（影なし） */
  _writeBpr(opts) {
    const U = this.uniformData;
    if (!opts) {
      U.fill(0, UO.lightVP, UO.lightVP + 16);
      U[UO.bprA] = 0;                    // 影なし → メッシュシェーダの分岐が丸ごと飛ぶ
      U[UO.bprA + 1] = 1;
      U[UO.bprA + 2] = 24;               // 実時間表示の AO サンプル数
      U[UO.bprA + 3] = this.shadowSize || SHADOW_SIZE;
      U[UO.bprB] = 0;                    // 輪郭線なし
      U[UO.bprB + 1] = 0;
      U[UO.bprB + 2] = 0;
      U[UO.bprB + 3] = 1;
      U[UO.lightDir] = 0; U[UO.lightDir + 1] = 0; U[UO.lightDir + 2] = 0;
      U[UO.lightDir + 3] = 0;            // 透明背景オフ
      return;
    }
    U.set(opts.lightVP, UO.lightVP);
    U[UO.bprA] = opts.shadow;
    U[UO.bprA + 1] = opts.shadowSoft;
    U[UO.bprA + 2] = opts.aoSamples;
    U[UO.bprA + 3] = this.shadowSize || SHADOW_SIZE;
    U[UO.bprB] = opts.outline;
    U[UO.bprB + 1] = opts.outlineStrength;
    U[UO.bprB + 2] = opts.diffuse;
    U[UO.bprB + 3] = opts.ambient;
    U[UO.lightDir] = opts.lightDir[0];
    U[UO.lightDir + 1] = opts.lightDir[1];
    U[UO.lightDir + 2] = opts.lightDir[2];
    U[UO.lightDir + 3] = opts.transparent ? 1 : 0;
  }

  /**
   * 光源からの viewProj を作る。
   * 平行光源なので ortho。範囲はモデルの外接球にぴったり合わせる
   * （広く取りすぎるとテクセルが粗くなって影がガタガタになる）。
   */
  _lightMatrix(center, radius, dir, out) {
    const r = Math.max(radius, 1e-4);
    const eye = V3.create(
      center[0] + dir[0] * r * 3,
      center[1] + dir[1] * r * 3,
      center[2] + dir[2] * r * 3);
    const up = Math.abs(dir[1]) > 0.95 ? V3.create(0, 0, 1) : V3.create(0, 1, 0);
    const view = M4.create();
    M4.lookAt(view, eye, center, up);
    const proj = M4.create();
    // 視点はモデルから 3r 離れているので、near/far は r で挟めば全体が入る
    M4.ortho(proj, r * 1.05, r * 1.05, r * 2, r * 4);
    M4.multiply(out, proj, view);
    return out;
  }

  /**
   * 仕上げレンダリングして PNG の Blob を返す。
   *
   * @param {object} camera
   * @param {object} mesh
   * @param {object} state 通常の描画 state（マテリアル・AO・背景色などを流用）
   * @param {object} o {
   *   scale, shadow, shadowSoft, aoSamples, outline, outlineStrength,
   *   diffuse, ambient, lightDir, transparent, grid
   * }
   * @returns {Promise<{blob: Blob, width: number, height: number, ms: number}>}
   */
  async renderStill(camera, mesh, state, o = {}) {
    const d = this.device;
    const t0 = performance.now();
    const scale = clamp(Math.round(o.scale || 2), 1, 4);
    const outW = this.canvas.width, outH = this.canvas.height;


    // 上限を超えたら倍率を落とす（4x で 4K だと 1 辺が 16384 を超える）
    const lim = d.limits ? d.limits.maxTextureDimension2D : 8192;
    let sc = scale;
    while (sc > 1 && (outW * sc > lim || outH * sc > lim)) sc--;
    const rw = outW * sc, rh = outH * sc;

    const bb = mesh.bounds();
    const dir = o.lightDir || [-0.45, 0.75, 0.5];
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const lightDir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    const lightVP = this._lightMatrix(bb.center, bb.radius, lightDir, M4.create());
    const bpr = {
      lightVP, lightDir,
      shadow: o.shadow === undefined ? 0.75 : clamp(o.shadow, 0, 1),
      shadowSoft: o.shadowSoft === undefined ? 1.5 : Math.max(0, o.shadowSoft),
      aoSamples: clamp(Math.round(o.aoSamples || 64), 1, 64),
      // 輪郭線の太さは「出力の px」で指定させる。スーパーサンプリング中の
      // 高解像度バッファ上で数えるので、倍率を掛けないと縮小で薄まって
      // 点々になる（2 倍だと 1/4 の濃さになった）。
      outline: Math.max(0, o.outline === undefined ? 0 : o.outline) * sc,
      outlineStrength: clamp(o.outlineStrength === undefined ? 0.7 : o.outlineStrength, 0, 1),
      diffuse: o.diffuse === undefined ? 0.75 : Math.max(0, o.diffuse),
      ambient: o.ambient === undefined ? 0.45 : Math.max(0, o.ambient),
      transparent: !!o.transparent,
    };

    // 実時間表示の解像度を退避して、レンダ用に上げる。
    // resize() が全ターゲットとバインドグループを作り直してくれるので、
    // 専用のパスを別に持たずに済む。
    const savedScale = this.renderScale;
    const savedRtW = this.rtW, savedRtH = this.rtH;
    this.rtW = rw; this.rtH = rh;
    let out = null, readBuf = null;
    try {
      this._resizeTo(rw, rh);

      // --- ユニフォーム ---
      this.syncMesh(mesh);
      const U = this.uniformData;
      U.set(camera.view, UO.view);
      U.set(camera.proj, UO.proj);
      U.set(camera.viewProj, UO.viewProj);
      U.set(camera.invProj, UO.invProj);
      U.set(camera.invViewProj, UO.invViewProj);
      U[UO.camPos] = camera.eye[0]; U[UO.camPos + 1] = camera.eye[1];
      U[UO.camPos + 2] = camera.eye[2]; U[UO.camPos + 3] = 1;
      U[UO.params] = camera.near;
      U[UO.params + 1] = camera.far;
      const matIdx = clamp(state.material | 0, 0, this.matcapCount - 1);
      this.ensureMatcap(matIdx);
      U[UO.params + 2] = matIdx;
      U[UO.params + 3] = 0;                          // デバッグ表示は使わない
      U[UO.rt] = rw; U[UO.rt + 1] = rh;
      U[UO.rt + 2] = 1 / rw; U[UO.rt + 3] = 1 / rh;
      U[UO.aoP] = Math.max(1e-4, camera.modelRadius * 0.20 * state.aoRadius);
      U[UO.aoP + 1] = state.aoIntensity;
      U[UO.aoP + 2] = Math.max(1e-5, camera.modelRadius * 0.0015);
      U[UO.aoP + 3] = state.aoPower;
      U.set(state.bgTop, UO.bgTop);
      U.set(state.bgBot, UO.bgBot);
      U[UO.misc] = state.exposure;
      U[UO.misc + 1] = 0;                            // ワイヤは出さない
      U[UO.misc + 2] = 0;                            // マスクの色も出さない
      U[UO.misc + 3] = 1;                            // AO は常に入れる
      U[UO.cav] = state.cavity;
      U[UO.cav + 1] = state.peak;
      U[UO.cav + 2] = state.cavityGain;
      U[UO.cav + 3] = 0;
      U[UO.grid] = niceStep(camera.modelRadius * 0.5);
      U[UO.grid + 1] = camera.modelRadius * 16;
      U[UO.grid + 2] = 1.0;
      U[UO.grid + 3] = state.gridY || 0;
      U.set(state.gridColor, UO.gridCol);
      this._writeBpr(bpr);
      d.queue.writeBuffer(this.uniformBuf, 0, U);

      out = d.createTexture({
        size: [rw, rh], format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });

      // WebGPU の検証エラーはコマンドバッファを黙って捨てる（例外にならない）。
      // それだと「全部ゼロの画像が返る」という形で表に出てきて原因が分からないので、
      // ここでエラースコープを張って例外に変える。実際にこれで
      // 「バインドグループのレイアウトが合っていない」を掴んだ。
      d.pushErrorScope('validation');
      const encoder = d.createCommandEncoder();

      // --- 1. シャドウマップ ---
      if (bpr.shadow > 0.001) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: this.shadowView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
          },
        });
        pass.setBindGroup(0, this.bgShadow);
        pass.setPipeline(this.pipeShadow);
        if (mesh.nt > 0 && this.ib) {
          pass.setVertexBuffer(0, this.vbPos);
          pass.setIndexBuffer(this.ib, 'uint32');
          pass.drawIndexed(mesh.nt * 3);
        }
        // 非アクティブなサブツールも影を落とす
        if (this.drawSlots) {
          for (const sl of this.drawSlots) {
            if (!sl || sl.count === 0) continue;
            pass.setVertexBuffer(0, sl.pos);
            pass.setIndexBuffer(sl.ib, 'uint32');
            pass.drawIndexed(sl.count);
          }
        }
        pass.end();
      }

      // --- 2. 本描画 ---
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: this.views.color, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
            { view: this.views.normal, clearValue: { r: 0, g: 0, b: 1, a: 0 }, loadOp: 'clear', storeOp: 'store' },
          ],
          depthStencilAttachment: {
            view: this.views.depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
          },
        });
        pass.setBindGroup(0, this.bgMain);
        // 透明背景のときは背景のグラデーションを描かない
        if (!bpr.transparent) { pass.setPipeline(this.pipeBg); pass.draw(3); }
        if (mesh.nt > 0 && this.ib) {
          pass.setPipeline(this.pipeMesh);
          pass.setVertexBuffer(0, this.vbPos);
          pass.setVertexBuffer(1, this.vbNrm);
          pass.setVertexBuffer(2, this.vbCol);
          pass.setVertexBuffer(3, this.vbMask);
          pass.setVertexBuffer(4, this.vbCurv);
          if (this.visCount > 0 && this.visIb) {
            pass.setIndexBuffer(this.visIb, 'uint32');
            pass.drawIndexed(this.visCount);
          } else {
            pass.setIndexBuffer(this.ib, 'uint32');
            pass.drawIndexed(mesh.nt * 3);
          }
        }
        if (this.drawSlots && this.drawSlots.length) {
          pass.setPipeline(this.pipeMesh);
          for (const sl of this.drawSlots) {
            if (!sl || sl.count === 0) continue;
            pass.setVertexBuffer(0, sl.pos);
            pass.setVertexBuffer(1, sl.nrm);
            pass.setVertexBuffer(2, sl.col);
            pass.setVertexBuffer(3, sl.msk);
            pass.setVertexBuffer(4, sl.crv);
            pass.setIndexBuffer(sl.ib, 'uint32');
            pass.drawIndexed(sl.count);
          }
        }
        if (o.grid && !bpr.transparent) { pass.setPipeline(this.pipeGrid); pass.draw(6); }
        pass.end();
      }

      // --- 3. AO（サンプル数を上げてある）---
      {
        const gx = Math.ceil(rw / 8), gy = Math.ceil(rh / 8);
        const p1 = encoder.beginComputePass();
        p1.setPipeline(this.pipeSSAO);
        p1.setBindGroup(0, this.bgSSAO);
        p1.dispatchWorkgroups(gx, gy);
        p1.end();
        const p2 = encoder.beginComputePass();
        p2.setPipeline(this.pipeBlur);
        p2.setBindGroup(0, this.bgBlur);
        p2.dispatchWorkgroups(gx, gy);
        p2.end();
      }

      // --- 4. 合成（FXAA + AO + 輪郭線 + sRGB）---
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: out.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
          ],
        });
        pass.setPipeline(this.pipePresent);
        pass.setBindGroup(0, this.bgPresent);
        pass.draw(3);
        pass.end();
      }

      // --- 5. 読み戻し ---
      // copyTextureToBuffer は行のバイト数が 256 の倍数でなければならない
      const bpr4 = Math.ceil(rw * 4 / 256) * 256;
      readBuf = d.createBuffer({
        size: bpr4 * rh,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer(
        { texture: out },
        { buffer: readBuf, bytesPerRow: bpr4, rowsPerImage: rh },
        { width: rw, height: rh, depthOrArrayLayers: 1 });
      d.queue.submit([encoder.finish()]);
      const gpuErr = await d.popErrorScope();
      if (gpuErr) throw new Error('GPU: ' + gpuErr.message);

      await readBuf.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(readBuf.getMappedRange()).slice();
      readBuf.unmap();

      // スーパーサンプリングの解決（N×N の平均）と BGRA→RGBA の並べ替えを
      // まとめて 1 回のループでやる。GPU でもできるが、パス 1 本ぶんの
      // パイプラインを増やすより読み戻しのついでに済ませたほうが簡単。
      const bgra = /bgra/i.test(this.format);
      const px = new Uint8ClampedArray(outW * outH * 4);
      const inv = 1 / (sc * sc);
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          let r = 0, g = 0, b = 0, a = 0;
          for (let sy = 0; sy < sc; sy++) {
            const row = (y * sc + sy) * bpr4;
            for (let sx = 0; sx < sc; sx++) {
              const i = row + (x * sc + sx) * 4;
              if (bgra) { b += src[i]; g += src[i + 1]; r += src[i + 2]; }
              else { r += src[i]; g += src[i + 1]; b += src[i + 2]; }
              a += src[i + 3];
            }
          }
          const j = (y * outW + x) * 4;
          px[j] = r * inv; px[j + 1] = g * inv; px[j + 2] = b * inv; px[j + 3] = a * inv;
        }
      }

      const cv = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(outW, outH)
        : Object.assign(document.createElement('canvas'), { width: outW, height: outH });
      const ctx = cv.getContext('2d');
      ctx.putImageData(new ImageData(px, outW, outH), 0, 0);
      const blob = cv.convertToBlob
        ? await cv.convertToBlob({ type: 'image/png' })
        : await new Promise((res) => cv.toBlob(res, 'image/png'));

      return {
        blob, width: outW, height: outH, scale: sc,
        ms: Math.round(performance.now() - t0),
        renderedAt: [rw, rh],
      };
    } finally {
      if (readBuf) readBuf.destroy();
      if (out) out.destroy();
      // 実時間表示に戻す
      this.renderScale = savedScale;
      this.rtW = savedRtW; this.rtH = savedRtH;
      this._resizeTo(savedRtW, savedRtH);

    }
  }

  destroy() {
    if (this.shadowTex) { this.shadowTex.destroy(); this.shadowTex = null; }
    for (const id of [...this.staticSlots.keys()]) this.destroyStatic(id);
    for (const b of [this.vbPos, this.vbNrm, this.vbCol, this.vbMask, this.vbCurv, this.ib, this.wireIb,
      this.visIb, this.overlayBuf]) {
      if (b) b.destroy();
    }
  }
}
