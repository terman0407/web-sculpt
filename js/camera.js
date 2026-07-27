// ---------------------------------------------------------------------------
// camera.js - 軌道カメラ。行列は毎フレーム同じ Float32Array に書き込む。
// ---------------------------------------------------------------------------

import { M4, V3, clamp } from './math.js';

const UP = V3.create(0, 1, 0);

export class OrbitCamera {
  constructor() {
    this.target = V3.create(0, 0, 0);
    this.distance = 3.2;
    // 初期姿勢は正面（+Z からモデルを見る）
    this.yaw = 0;             // ラジアン
    this.pitch = 0;
    this.fov = 40 * Math.PI / 180;
    this.modelRadius = 1;
    this.invertOrbitY = false;

    this.eye = V3.create();
    this.view = M4.create();
    this.proj = M4.create();
    this.viewProj = M4.create();
    this.invProj = M4.create();
    this.invView = M4.create();
    this.invViewProj = M4.create();
    this.near = 0.01;
    this.far = 100;
    this.aspect = 1;
    this.viewportH = 1;
  }

  /**
   * 画面ピクセル量で軌道回転。
   * 「掴んだ表面の点がカーソルに追従する」向きに合わせている（パンと同じ規約）:
   * 下へドラッグ → モデルの手前側が下がる → カメラは上へ回り込む（pitch 増加）。
   */
  orbit(dx, dy) {
    this.yaw -= dx * 0.0075;
    const sy = this.invertOrbitY ? -1 : 1;
    this.pitch = clamp(this.pitch + sy * dy * 0.0075, -1.5533, 1.5533);
  }

  /** 画面ピクセル量でパン（ターゲット平面上で 1:1 になるように換算） */
  pan(dx, dy, viewportH) {
    const worldPerPx = (2 * Math.tan(this.fov * 0.5) * this.distance) / Math.max(1, viewportH);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // カメラ右方向 / 上方向
    const rx = cy, ry = 0, rz = -sy;
    const ux = -sy * sp, uy = cp, uz = -cy * sp;
    this.target[0] += (-dx * rx + dy * ux) * worldPerPx;
    this.target[1] += (-dx * ry + dy * uy) * worldPerPx;
    this.target[2] += (-dx * rz + dy * uz) * worldPerPx;
  }

  zoom(steps) {
    this.distance = clamp(this.distance * Math.pow(1.12, steps), this.modelRadius * 0.02, this.modelRadius * 60);
  }

  frame(center, radius, resetAngles = false) {
    V3.copy(this.target, center);
    this.modelRadius = Math.max(radius, 1e-3);
    this.distance = this.modelRadius / Math.tan(this.fov * 0.5) * 1.35;
    if (resetAngles) { this.yaw = 0; this.pitch = 0; }
  }

  /** 定型視点（正面 / 背面 / 左 / 右 / 上 / 下） */
  setView(name) {
    const H = Math.PI / 2;
    switch (name) {
      case 'front': this.yaw = 0; this.pitch = 0; break;
      case 'back': this.yaw = Math.PI; this.pitch = 0; break;
      case 'right': this.yaw = H; this.pitch = 0; break;
      case 'left': this.yaw = -H; this.pitch = 0; break;
      case 'top': this.yaw = 0; this.pitch = 1.5533; break;
      case 'bottom': this.yaw = 0; this.pitch = -1.5533; break;
      default: break;
    }
  }

  update(width, height) {
    this.aspect = Math.max(1e-4, width / Math.max(1, height));
    this.viewportH = Math.max(1, height);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    this.eye[0] = this.target[0] + this.distance * cp * sy;
    this.eye[1] = this.target[1] + this.distance * sp;
    this.eye[2] = this.target[2] + this.distance * cp * cy;

    const span = this.modelRadius + this.distance;
    this.near = Math.max(this.distance * 0.002, span * 1e-4, 1e-4);
    this.far = span * 4 + this.modelRadius * 4;

    M4.lookAt(this.view, this.eye, this.target, UP);
    M4.perspective(this.proj, this.fov, this.aspect, this.near, this.far);
    M4.multiply(this.viewProj, this.proj, this.view);
    M4.invert(this.invProj, this.proj);
    M4.invert(this.invView, this.view);
    M4.invert(this.invViewProj, this.viewProj);
  }

  /** ある深度（カメラからの距離 d）における 1 ピクセルあたりのワールドサイズ */
  worldPerPixel(distanceToCamera) {
    return (2 * Math.tan(this.fov * 0.5) * distanceToCamera) / this.viewportH;
  }
}
