// ---------------------------------------------------------------------------
// brushes.js
// ブラシ 1 ダブ（stamp）の適用。すべて「領域頂点リスト + 減衰重み」に対する操作。
// ---------------------------------------------------------------------------

import { V3, clamp } from './math.js';
import { RING_STRIDE } from './mesh.js';
import { alphaWeightAt } from './alpha.js';

export const BRUSHES = [
  { id: 'clay', name: 'Clay Buildup', jp: 'クレイ', short: 'クレイ', icon: '◤', hint: '平均平面まで粘土を盛る。基本のブラシ' },
  { id: 'draw', name: 'Standard', jp: 'スタンダード', short: '標準', icon: '◍', hint: '平均法線方向に押し出す' },
  { id: 'inflate', name: 'Inflate', jp: 'インフレート', short: '膨張', icon: '◉', hint: '各頂点の法線方向に膨張' },
  { id: 'layer', name: 'Layer', jp: 'レイヤー', short: 'レイヤー', icon: '▤', hint: '一定の高さまでしか盛らない。段差やリボン状の形に' },
  { id: 'crease', name: 'Crease', jp: 'クリース', short: 'クリース', icon: '▽', hint: '溝を彫る（ピンチ＋押し込み）' },
  { id: 'pinch', name: 'Pinch', jp: 'ピンチ', short: 'ピンチ', icon: '✦', hint: '中心へ寄せてエッジを立てる' },
  { id: 'flatten', name: 'Flatten', jp: 'フラット', short: 'フラット', icon: '▬', hint: '平均平面に押しつける' },
  { id: 'hpolish', name: 'hPolish', jp: 'ポリッシュ', short: 'ポリッシュ', icon: '◫', hint: '出ている所だけ削って硬い面を作る' },
  { id: 'smooth', name: 'Smooth', jp: 'スムーズ', short: 'スムーズ', icon: '≈', hint: '平滑化 (Shift でいつでも呼べる)' },
  { id: 'relax', name: 'Relax', jp: 'リラックス', short: 'リラックス', icon: '◌', hint: '形を保ったままポリゴンの分布だけ整える' },
  { id: 'move', name: 'Move', jp: 'ムーブ', short: 'ムーブ', icon: '✥', hint: '掴んで引っぱる（領域を固定）' },
  { id: 'snakehook', name: 'Snake Hook', jp: 'スネークフック', short: 'フック', icon: '➰', hint: '引き伸ばして角や触手を作る' },
  { id: 'nudge', name: 'Nudge', jp: 'ナッジ', short: 'ナッジ', icon: '➤', hint: '表面に沿ってずらす' },
  { id: 'paint', name: 'Paint', jp: 'ペイント', short: 'ペイント', icon: '✎', hint: '頂点カラーを塗る (ポリペイント)' },
  { id: 'mask', name: 'Mask', jp: 'マスク', short: 'マスク', icon: '▩', hint: 'マスクを塗る (Ctrl+ドラッグでも可)' },
  { id: 'morph', name: 'Morph', jp: 'モーフ', short: 'モーフ', icon: '⟲', hint: '記憶した形へ部分的に戻す（モーフターゲットの記憶が先に必要）' },
];

export const BRUSH_IDS = BRUSHES.map(b => b.id);
export const BRUSH_BY_ID = new Map(BRUSHES.map(b => [b.id, b]));

/** そのブラシが動的トポロジを必要とするか */
export function needsTopology(id) {
  return id === 'clay' || id === 'draw' || id === 'inflate' || id === 'layer'
    || id === 'crease' || id === 'pinch' || id === 'snakehook';
}

/** ドラッグ量に依存するブラシ（静止時は何もしない） */
export function usesDelta(id) {
  return id === 'move' || id === 'nudge' || id === 'snakehook';
}

/** カーソル位置をレイと平面の交点で求めるブラシ（表面が逃げていくため） */
export function usesGrabPlane(id) {
  return id === 'move' || id === 'snakehook';
}

/**
 * 減衰カーブ。focal は ZBrush の Focal Shift 相当で -1..1。
 *   focal > 0 : 中心に平らな部分ができてエッジが立つ（硬い当たり）
 *   focal < 0 : 中心から緩やかに落ちる（柔らかい当たり）
 */
export function falloff(t, focal = 0) {
  if (t >= 1) return 0;
  if (t <= 0) t = 0;
  if (focal > 0) {
    const p = focal * 0.92;
    if (t <= p) return 1;
    const u = (t - p) / (1 - p);
    const f = 1 - u * u;
    return f * f;
  }
  const f = 1 - t * t;
  const base = f * f;
  return focal < 0 ? Math.pow(base, 1 - focal * 2.2) : base;
}

export class BrushEngine {
  constructor() {
    this.w = new Float32Array(1024);        // 減衰重み
    this.tmp = new Float32Array(1024 * 3);  // スムーズ用の一時座標
    this.avgN = V3.create();
    this.centroid = V3.create();

    // レイヤーブラシのストローク内累積（同じ場所を何度なでても一定の高さで止まる）
    this.layerAcc = new Float32Array(0);
    this.layerStamp = new Int32Array(0);
    this.strokeId = 0;
  }

  _ensure(n) {
    if (this.w.length < n) {
      const cap = Math.ceil(n * 1.5);
      this.w = new Float32Array(cap);
      this.tmp = new Float32Array(cap * 3);
    }
  }

  _ensureLayer(capV) {
    if (this.layerAcc.length < capV) {
      // 中身を引き継ぐこと。レイヤーブラシは「ストローク中に一度盛った高さで止まる」
      // 挙動を layerAcc / layerStamp の蓄積で表しているので、作り直すだけだと
      // 動的トポロジで容量が伸びた瞬間に蓄積が消え、同じ場所が二度盛られて段差になる。
      const acc = new Float32Array(capV);
      acc.set(this.layerAcc);
      this.layerAcc = acc;
      const st = new Int32Array(capV);
      st.set(this.layerStamp);
      this.layerStamp = st;
    }
  }

  beginStroke() { this.strokeId++; }

  /**
   * @param {SculptMesh} mesh
   * @param {object} c コンテキスト
   *   type       : ブラシ id
   *   verts      : 領域頂点（配列 / Int32Array）
   *   count      : 有効頂点数
   *   center     : Float32Array(3) ブラシ中心 (world)
   *   radius     : number ブラシ半径 (world)
   *   strength   : 0..1
   *   dir        : +1 / -1
   *   delta      : Float32Array(3) 今回のダブでのドラッグベクトル (world)
   *   color      : [r,g,b] paint 用
   *   focal      : -1..1 減衰カーブ
   *   toCamera   : Float32Array(3)|null 視線の逆方向（バックフェイスマスク用）
   *   backface   : bool 裏を向いた面を無視するか
   *   ignoreMask : bool
   *   alpha      : string|null ブラシアルファの id（null で無効）
   *   tangent    : Float32Array(3) ダブ接平面の U 軸
   *   bitangent  : Float32Array(3) ダブ接平面の V 軸
   *   alphaRotation : number アルファの回転（ラジアン）
   */
  apply(mesh, c) {
    const n = c.count;
    if (n <= 0) return;
    this._ensure(n);

    const P = mesh.positions, N = mesh.normals, MK = mesh.mask;
    const verts = c.verts;
    const w = this.w;
    const cx = c.center[0], cy = c.center[1], cz = c.center[2];
    const R = c.radius, invR = 1 / Math.max(1e-8, R);
    const useMask = !c.ignoreMask;
    const focal = clamp(c.focal || 0, -1, 1);
    const bf = c.backface && c.toCamera ? c.toCamera : null;
    // ブラシアルファ（断面形状）。ダブの接平面上の (u,v) で 0..1 を引いて
    // 通常の距離減衰に掛ける。接平面の基底は呼び出し側（sculptor）が作る。
    const alpha = c.alpha || null;
    const at = c.tangent, bt = c.bitangent, arot = c.alphaRotation || 0;
    const useAlpha = !!(alpha && at && bt);

    // --- 減衰重み + 面積加重平均法線 + 加重重心 --------------------------
    let anx = 0, any = 0, anz = 0;
    let ccx = 0, ccy = 0, ccz = 0, wsum = 0;
    for (let k = 0; k < n; k++) {
      const v = verts[k];
      const i = v * 3;
      const dx = P[i] - cx, dy = P[i + 1] - cy, dz = P[i + 2] - cz;
      let t = Math.sqrt(dx * dx + dy * dy + dz * dz) * invR;
      if (t > 1) t = 1;
      let f = falloff(t, focal);
      if (useAlpha && f > 0) f *= alphaWeightAt(alpha, P[i], P[i + 1], P[i + 2], c.center, at, bt, R, arot);
      if (useMask) f *= (1 - clamp(MK[v], 0, 1));
      if (bf && f > 0) {
        // 視点から見て裏を向いている頂点を落とす（ZBrush の BackfaceMask）
        const d = N[i] * bf[0] + N[i + 1] * bf[1] + N[i + 2] * bf[2];
        if (d <= 0) f = 0;
        else if (d < 0.25) f *= d / 0.25;
      }
      w[k] = f;
      if (f > 0) {
        anx += N[i] * f; any += N[i + 1] * f; anz += N[i + 2] * f;
        ccx += P[i] * f; ccy += P[i + 1] * f; ccz += P[i + 2] * f;
        wsum += f;
      }
    }
    if (wsum < 1e-8) return;
    {
      const l = Math.hypot(anx, any, anz);
      if (l < 1e-12) return;
      this.avgN[0] = anx / l; this.avgN[1] = any / l; this.avgN[2] = anz / l;
      this.centroid[0] = ccx / wsum; this.centroid[1] = ccy / wsum; this.centroid[2] = ccz / wsum;
    }

    const nx = this.avgN[0], ny = this.avgN[1], nz = this.avgN[2];
    const s = clamp(c.strength, 0, 2);
    const dir = c.dir >= 0 ? 1 : -1;

    switch (c.type) {
      // ---------------------------------------------------------------
      case 'draw': {
        const amp = R * s * 0.22 * dir;
        for (let k = 0; k < n; k++) {
          const f = w[k]; if (f <= 0) continue;
          const i = verts[k] * 3;
          P[i] += nx * amp * f; P[i + 1] += ny * amp * f; P[i + 2] += nz * amp * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'clay': {
        // 平均平面をブラシ方向に少しオフセットし、その面まで「埋める」
        const offset = R * s * 0.16 * dir;
        const ox = this.centroid[0], oy = this.centroid[1], oz = this.centroid[2];
        for (let k = 0; k < n; k++) {
          const f = w[k]; if (f <= 0) continue;
          const i = verts[k] * 3;
          const d = (P[i] - ox) * nx + (P[i + 1] - oy) * ny + (P[i + 2] - oz) * nz;
          let move = offset - d;
          if (dir > 0) { if (move < 0) move = 0; } else { if (move > 0) move = 0; }
          move *= f * 0.85;
          P[i] += nx * move; P[i + 1] += ny * move; P[i + 2] += nz * move;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'inflate': {
        const amp = R * s * 0.18 * dir;
        for (let k = 0; k < n; k++) {
          const f = w[k]; if (f <= 0) continue;
          const i = verts[k] * 3;
          P[i] += N[i] * amp * f;
          P[i + 1] += N[i + 1] * amp * f;
          P[i + 2] += N[i + 2] * amp * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'layer': {
        // ストローク中の累積を持ち、目標高さを超えないようにする。
        // 何度なでても厚みが一定になるので、段差やリボン状の形が作れる。
        this._ensureLayer(mesh.capV);
        const acc = this.layerAcc, stamp = this.layerStamp, sid = this.strokeId;
        const height = R * s * 0.20 * dir;
        for (let k = 0; k < n; k++) {
          const f = w[k]; if (f <= 0) continue;
          const v = verts[k];
          if (stamp[v] !== sid) { stamp[v] = sid; acc[v] = 0; }
          const target = height * f;
          const move = target - acc[v];
          if (dir > 0 ? move <= 0 : move >= 0) continue;
          acc[v] = target;
          const i = v * 3;
          P[i] += nx * move; P[i + 1] += ny * move; P[i + 2] += nz * move;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'smooth': {
        // ヤコビ法：全頂点の 1-ring 平均を先に求めてから一括で移動
        const tmp = this.tmp;
        const T = mesh.tris;
        const RC = mesh.ringCount, RD = mesh.ringData;
        for (let k = 0; k < n; k++) {
          const v = verts[k];
          const rc = RC[v];
          const rb = rc <= RING_STRIDE ? v * RING_STRIDE : -1;
          const rex = rb < 0 ? mesh.ringExt[v] : null;
          let sx = 0, sy = 0, sz = 0, cnt = 0;
          {
            for (let j = 0; j < rc; j++) {
              const ti = (rex ? rex[j] : RD[rb + j]) * 3;
              for (let e = 0; e < 3; e++) {
                const u = T[ti + e];
                if (u === v) continue;
                const iu = u * 3;
                sx += P[iu]; sy += P[iu + 1]; sz += P[iu + 2]; cnt++;
              }
            }
          }
          if (cnt === 0) { tmp[k * 3] = P[v * 3]; tmp[k * 3 + 1] = P[v * 3 + 1]; tmp[k * 3 + 2] = P[v * 3 + 2]; continue; }
          tmp[k * 3] = sx / cnt; tmp[k * 3 + 1] = sy / cnt; tmp[k * 3 + 2] = sz / cnt;
        }
        const amt = clamp(s * 0.85, 0, 1);
        for (let k = 0; k < n; k++) {
          const f = w[k] * amt; if (f <= 0) continue;
          const i = verts[k] * 3;
          P[i] += (tmp[k * 3] - P[i]) * f;
          P[i + 1] += (tmp[k * 3 + 1] - P[i + 1]) * f;
          P[i + 2] += (tmp[k * 3 + 2] - P[i + 2]) * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'relax': {
        // 接線方向のみのラプラシアン。形（体積）を保ったまま三角形の分布を整える
        const tmp = this.tmp;
        const T = mesh.tris;
        const RC = mesh.ringCount, RD = mesh.ringData;
        for (let k = 0; k < n; k++) {
          const v = verts[k];
          const rc = RC[v];
          const rb = rc <= RING_STRIDE ? v * RING_STRIDE : -1;
          const rex = rb < 0 ? mesh.ringExt[v] : null;
          let sx = 0, sy = 0, sz = 0, cnt = 0;
          {
            for (let j = 0; j < rc; j++) {
              const ti = (rex ? rex[j] : RD[rb + j]) * 3;
              for (let e = 0; e < 3; e++) {
                const u = T[ti + e];
                if (u === v) continue;
                const iu = u * 3;
                sx += P[iu]; sy += P[iu + 1]; sz += P[iu + 2]; cnt++;
              }
            }
          }
          const i = v * 3;
          if (cnt === 0) { tmp[k * 3] = 0; tmp[k * 3 + 1] = 0; tmp[k * 3 + 2] = 0; continue; }
          let dx = sx / cnt - P[i], dy = sy / cnt - P[i + 1], dz = sz / cnt - P[i + 2];
          const d = dx * N[i] + dy * N[i + 1] + dz * N[i + 2];
          tmp[k * 3] = dx - N[i] * d;
          tmp[k * 3 + 1] = dy - N[i + 1] * d;
          tmp[k * 3 + 2] = dz - N[i + 2] * d;
        }
        const amt = clamp(s * 0.9, 0, 1);
        for (let k = 0; k < n; k++) {
          const f = w[k] * amt; if (f <= 0) continue;
          const i = verts[k] * 3;
          P[i] += tmp[k * 3] * f;
          P[i + 1] += tmp[k * 3 + 1] * f;
          P[i + 2] += tmp[k * 3 + 2] * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'flatten': {
        const ox = this.centroid[0], oy = this.centroid[1], oz = this.centroid[2];
        const amt = clamp(s * 0.8, 0, 1);
        for (let k = 0; k < n; k++) {
          const f = w[k] * amt; if (f <= 0) continue;
          const i = verts[k] * 3;
          const d = (P[i] - ox) * nx + (P[i + 1] - oy) * ny + (P[i + 2] - oz) * nz;
          P[i] -= nx * d * f; P[i + 1] -= ny * d * f; P[i + 2] -= nz * d * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'hpolish': {
        // 平面より出ている側だけを削る。彫刻を崩さずに硬い面が作れる
        const ox = this.centroid[0], oy = this.centroid[1], oz = this.centroid[2];
        const amt = clamp(s * 0.95, 0, 1);
        const sgn = dir;
        for (let k = 0; k < n; k++) {
          const f = w[k] * amt; if (f <= 0) continue;
          const i = verts[k] * 3;
          const d = (P[i] - ox) * nx + (P[i + 1] - oy) * ny + (P[i + 2] - oz) * nz;
          if (d * sgn <= 0) continue;             // 凹んでいる側は触らない
          P[i] -= nx * d * f; P[i + 1] -= ny * d * f; P[i + 2] -= nz * d * f;
          // わずかに中心へ寄せてエッジを立てる
          let vx = cx - P[i], vy = cy - P[i + 1], vz = cz - P[i + 2];
          const dn = vx * nx + vy * ny + vz * nz;
          vx -= nx * dn; vy -= ny * dn; vz -= nz * dn;
          const pf = f * 0.12;
          P[i] += vx * pf; P[i + 1] += vy * pf; P[i + 2] += vz * pf;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'pinch': {
        const amt = clamp(s * 0.5, 0, 1) * dir;
        for (let k = 0; k < n; k++) {
          const f = w[k] * amt; if (f === 0) continue;
          const i = verts[k] * 3;
          let vx = cx - P[i], vy = cy - P[i + 1], vz = cz - P[i + 2];
          const d = vx * nx + vy * ny + vz * nz;   // 法線成分を落として接線方向だけ
          vx -= nx * d; vy -= ny * d; vz -= nz * d;
          P[i] += vx * f; P[i + 1] += vy * f; P[i + 2] += vz * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'crease': {
        const amt = clamp(s * 0.55, 0, 1);
        const amp = R * s * 0.14 * dir;
        for (let k = 0; k < n; k++) {
          const f = w[k]; if (f <= 0) continue;
          const i = verts[k] * 3;
          let vx = cx - P[i], vy = cy - P[i + 1], vz = cz - P[i + 2];
          const d = vx * nx + vy * ny + vz * nz;
          vx -= nx * d; vy -= ny * d; vz -= nz * d;
          const ff = f * amt;
          P[i] += vx * ff - nx * amp * f;
          P[i + 1] += vy * ff - ny * amp * f;
          P[i + 2] += vz * ff - nz * amp * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'move': {
        const dxw = c.delta[0], dyw = c.delta[1], dzw = c.delta[2];
        const amt = clamp(s * 1.6, 0, 3);
        for (let k = 0; k < n; k++) {
          const f = w[k] * amt; if (f <= 0) continue;
          const i = verts[k] * 3;
          P[i] += dxw * f; P[i + 1] += dyw * f; P[i + 2] += dzw * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'snakehook': {
        // Move より鋭い減衰で強く引く。dyntopo と組み合わせて伸ばし続けられる
        const dxw = c.delta[0], dyw = c.delta[1], dzw = c.delta[2];
        const amt = clamp(s * 3.2, 0, 6);
        for (let k = 0; k < n; k++) {
          let f = w[k]; if (f <= 0) continue;
          f = f * f * amt;
          const i = verts[k] * 3;
          P[i] += dxw * f; P[i + 1] += dyw * f; P[i + 2] += dzw * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'nudge': {
        let dxw = c.delta[0], dyw = c.delta[1], dzw = c.delta[2];
        const d = dxw * nx + dyw * ny + dzw * nz;
        dxw -= nx * d; dyw -= ny * d; dzw -= nz * d;
        const amt = clamp(s * 1.6, 0, 3);
        for (let k = 0; k < n; k++) {
          const f = w[k] * amt; if (f <= 0) continue;
          const i = verts[k] * 3;
          P[i] += dxw * f; P[i + 1] += dyw * f; P[i + 2] += dzw * f;
        }
        break;
      }
      // ---------------------------------------------------------------
      case 'paint': {
        const C = mesh.colors;
        const cr = c.color[0], cg = c.color[1], cb = c.color[2];
        const amt = clamp(s * 0.6, 0, 1);
        for (let k = 0; k < n; k++) {
          const f = w[k] * amt; if (f <= 0) continue;
          const v = verts[k], i = v * 3;
          C[i] += (cr - C[i]) * f;
          C[i + 1] += (cg - C[i + 1]) * f;
          C[i + 2] += (cb - C[i + 2]) * f;
          mesh.markVert(v);
        }
        return;  // 座標は動かない
      }
      // ---------------------------------------------------------------
      case 'mask': {
        const amt = clamp(s * 0.5, 0, 1) * dir;
        for (let k = 0; k < n; k++) {
          const f = w[k]; if (f <= 0) continue;
          const v = verts[k];
          MK[v] = clamp(MK[v] + f * amt, 0, 1);
          mesh.markVert(v);
        }
        return;
      }
      default:
        return;
    }

    for (let k = 0; k < n; k++) mesh.markVert(verts[k]);
  }
}
