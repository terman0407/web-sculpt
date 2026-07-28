// ---------------------------------------------------------------------------
// renderer.js - WebGPU レンダラ
//
//  * メッシュ頂点は「非インターリーブ 4 バッファ」構成（pos / nrm / col / mask）。
//    CPU 側の配列をそのまま dirty レンジ転送できるので、彫刻中の再パックが不要。
//  * ピッキングは深度テクスチャの 8x8 リードバック → 逆射影。CPU 側に加速構造を
//    持たずに O(1) でオクルージョン込みの正確な表面座標が得られる。
// ---------------------------------------------------------------------------

import { clamp } from './math.js';
import { DIRTY_SHIFT, DIRTY_BLOCK } from './mesh.js';
import { generateMatcapLayer, MATERIALS } from './matcap.js';
import {
  UNIFORM_FLOATS, UO,
  BG_WGSL, MESH_WGSL, WIRE_WGSL, OVERLAY_WGSL, GRID_WGSL, SSAO_WGSL, BLUR_WGSL, PRESENT_WGSL, RING_WGSL, PICK_WGSL,
} from './shaders.js';

const COLOR_FORMAT = 'rgba16float';
const NORMAL_FORMAT = 'rgba16float';
const DEPTH_FORMAT = 'depth32float';
const AO_FORMAT = 'rgba8unorm';
const RING_SEGMENTS = 96;
const PICK_SEARCH = 4;               // カーソル周辺の深度探索半径（px）
const PICK_BYTES = 16;               // vec4<f32>

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

    this.kernelBuf = device.createBuffer({
      size: 24 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.kernelBuf, 0, ssaoKernel(24));

    // リングオーバーレイ用ユニフォーム: mat4x4 * 8 + color + info
    this.ringData = new Float32Array(8 * 16 + 4 + 4);
    this.ringBuf = device.createBuffer({
      size: this.ringData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // --- メッシュ用 GPU バッファ ---
    this.gpuCapV = 0;
    this.gpuCapT = 0;

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

    this.bglMain = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.bglRing = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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

    this.bgMain = d.createBindGroup({
      layout: this.bglMain,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: this.matcapTex.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: this.linearSampler },
      ],
    });
    this.bgRing = d.createBindGroup({
      layout: this.bglRing,
      entries: [{ binding: 0, resource: { buffer: this.ringBuf } }],
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
      ],
    });
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

  destroy() {
    for (const b of [this.vbPos, this.vbNrm, this.vbCol, this.vbMask, this.vbCurv, this.ib, this.wireIb,
      this.visIb, this.overlayBuf]) {
      if (b) b.destroy();
    }
  }
}
