// ---------------------------------------------------------------------------
// WASM 版と JS 版の距離場カーネルを同一入力で比較する。
//   node test/bench-wasm.mjs
// 速度差と、出力がビット単位で一致するかを確認する。
// wasm/dynafield.wasm が無い場合は npm run build:wasm で生成する。
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { SculptMesh, PRIMITIVES } from '../js/mesh.js';
import { Sculptor } from '../js/sculptor.js';

// --- 計測用メッシュを用意 ---
const g = PRIMITIVES.sphere();
const mesh = new SculptMesh();
mesh.setGeometry(g.positions, g.indices);
const st = { brush:'clay', radiusPx:90, strength:0.7, paintColor:[.6,.2,.15], worldRadius:0.3,
  dynTopo:true, decimate:true, detail:0.6, maxVerts:2000000, symmetry:{x:true,y:false,z:false},
  focalShift:0, backfaceMask:false, strokeBudgetMs:0 };
const s = new Sculptor(mesh, st);
const pt = new Float32Array(3);
for (let seed=0; seed<40; seed++){
  const at=(u)=>{ const th=seed*0.7+u*1.6, ph=-0.8+Math.sin(seed+u*2.2)*0.9;
    pt[0]=Math.cos(ph)*Math.cos(th); pt[1]=Math.sin(ph); pt[2]=Math.cos(ph)*Math.sin(th); return pt; };
  s.beginStroke('clay', at(0), 1);
  for(let k=1;k<=20;k++) s.addSample(at(k/20));
  s.endStroke();
}
console.log(`  メッシュ: ${mesh.liveVerts.toLocaleString()} 頂点 / ${mesh.liveTris.toLocaleString()} 面`);

// --- グリッド設定（dynamesh.js と同じ） ---
function setupGrid(res, maxVoxels = 24e6) {
  const bb = mesh.bounds();
  const ex = bb.max[0]-bb.min[0], ey = bb.max[1]-bb.min[1], ez = bb.max[2]-bb.min[2];
  const maxExt = Math.max(ex, ey, ez, 1e-6);
  let h = maxExt / res, nx, ny, nz, ox, oy, oz;
  const JIT=[0.013717,0.021139,0.008719];
  for (let guard=0; guard<64; guard++){
    const pad=h*3;
    ox=bb.min[0]-pad+h*JIT[0]; oy=bb.min[1]-pad+h*JIT[1]; oz=bb.min[2]-pad+h*JIT[2];
    nx=Math.ceil((ex+pad*2)/h)+1; ny=Math.ceil((ey+pad*2)/h)+1; nz=Math.ceil((ez+pad*2)/h)+1;
    if (nx*ny*nz<=maxVoxels) break;
    h*=1.12;
  }
  return { nx, ny, nz, ox, oy, oz, h, band: h*2.0, total: nx*ny*nz };
}

// --- JS 版のスプラット（dynamesh.js から同じロジックを取り出したもの） ---
function pointTriDist2(px,py,pz,ax,ay,az,bx,by,bz,cx,cy,cz){
  const abx=bx-ax,aby=by-ay,abz=bz-az, acx=cx-ax,acy=cy-ay,acz=cz-az, apx=px-ax,apy=py-ay,apz=pz-az;
  const d1=abx*apx+aby*apy+abz*apz, d2=acx*apx+acy*apy+acz*apz;
  if(d1<=0&&d2<=0) return apx*apx+apy*apy+apz*apz;
  const bpx=px-bx,bpy=py-by,bpz=pz-bz;
  const d3=abx*bpx+aby*bpy+abz*bpz, d4=acx*bpx+acy*bpy+acz*bpz;
  if(d3>=0&&d4<=d3) return bpx*bpx+bpy*bpy+bpz*bpz;
  const vc=d1*d4-d3*d2;
  if(vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);const x=apx-abx*v,y=apy-aby*v,z=apz-abz*v;return x*x+y*y+z*z;}
  const cpx=px-cx,cpy=py-cy,cpz=pz-cz;
  const d5=abx*cpx+aby*cpy+abz*cpz, d6=acx*cpx+acy*cpy+acz*cpz;
  if(d6>=0&&d5<=d6) return cpx*cpx+cpy*cpy+cpz*cpz;
  const vb=d5*d2-d1*d6;
  if(vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);const x=apx-acx*w,y=apy-acy*w,z=apz-acz*w;return x*x+y*y+z*z;}
  const va=d3*d6-d5*d4;
  if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0){const w=(d4-d3)/((d4-d3)+(d5-d6));
    const x=bpx+(cpx-bpx)*w,y=bpy+(cpy-bpy)*w,z=bpz+(cpz-bpz)*w;return x*x+y*y+z*z;}
  const denom=1/(va+vb+vc), v=vb*denom, w=vc*denom;
  const x=apx-(abx*v+acx*w), y=apy-(aby*v+acy*w), z=apz-(abz*v+acz*w);
  return x*x+y*y+z*z;
}
function splatJS(G, field, closest){
  const {nx,ny,nz,ox,oy,oz,h,band}=G, sy=nx, sz=nx*ny;
  const P=mesh.positions, T=mesh.tris;
  for(let t=0;t<mesh.nt;t++){
    const ti=t*3, ia=T[ti],ib=T[ti+1],ic=T[ti+2];
    if(ia===ib&&ib===ic) continue;
    const a=ia*3,b=ib*3,c=ic*3;
    const ax=P[a],ay=P[a+1],az=P[a+2], bx=P[b],by=P[b+1],bz=P[b+2], cx=P[c],cy=P[c+1],cz=P[c+2];
    const tx0=Math.min(ax,bx,cx),tx1=Math.max(ax,bx,cx);
    const ty0=Math.min(ay,by,cy),ty1=Math.max(ay,by,cy);
    const tz0=Math.min(az,bz,cz),tz1=Math.max(az,bz,cz);
    const i0=Math.max(0,Math.ceil((tx0-band-ox)/h)), i1=Math.min(nx-1,Math.floor((tx1+band-ox)/h));
    const j0=Math.max(0,Math.ceil((ty0-band-oy)/h)), j1=Math.min(ny-1,Math.floor((ty1+band-oy)/h));
    const k0=Math.max(0,Math.ceil((tz0-band-oz)/h)), k1=Math.min(nz-1,Math.floor((tz1+band-oz)/h));
    for(let k=k0;k<=k1;k++){
      const pz=oz+k*h, ez=pz<tz0?tz0-pz:(pz>tz1?pz-tz1:0), e2z=ez*ez;
      if(e2z>=band*band) continue;
      for(let j=j0;j<=j1;j++){
        const py=oy+j*h, ey=py<ty0?ty0-py:(py>ty1?py-ty1:0), e2zy=e2z+ey*ey;
        if(e2zy>=band*band) continue;
        let idx=i0+j*sy+k*sz;
        for(let i=i0;i<=i1;i++,idx++){
          const px=ox+i*h, cur=field[idx];
          const ex=px<tx0?tx0-px:(px>tx1?px-tx1:0);
          if(e2zy+ex*ex>=cur*cur) continue;
          const d2=pointTriDist2(px,py,pz,ax,ay,az,bx,by,bz,cx,cy,cz);
          if(d2<cur*cur){ field[idx]=Math.sqrt(d2); if(closest) closest[idx]=t; }
        }
      }
    }
  }
}

// --- WASM をロード（AssemblyScript / Rust の両方を比べる）---
// wasm/dynafield.wasm が本番で使うもの（現在は Rust 版）。
// rust/target 以下と assembly 版があればそれも並べて比べる。
const CANDIDATES = [
  { name: '本番 ', url: new URL('../wasm/dynafield.wasm', import.meta.url) },
  { name: 'Rust', url: new URL('../rust/target/wasm32-unknown-unknown/release/dynafield.wasm', import.meta.url) },
];
const mods = [];
for (const c of CANDIDATES) {
  let bytes;
  try { bytes = readFileSync(c.url); } catch { console.log(`  (${c.name.trim()} は未ビルド: スキップ)`); continue; }
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { abort: () => { throw new Error('wasm abort'); } },
  });
  mods.push({ ...c, W: instance.exports, bytes: bytes.length });
  console.log(`  ${c.name.trim()}: ${bytes.length.toLocaleString()} B`);
}
if (mods.length === 0) { console.error('  WASM が 1 つも無い'); process.exit(1); }

/** WASM 側で splat を走らせて (ms, field, closest) を返す */
function runWasm(W, G, N) {
  const pPos = W.alloc(mesh.nv * 12), pTri = W.alloc(mesh.nt * 12);
  const pField = W.alloc(N * 4), pClose = W.alloc(N * 4);
  new Float32Array(W.memory.buffer, pPos, mesh.nv * 3).set(mesh.positions.subarray(0, mesh.nv * 3));
  new Int32Array(W.memory.buffer, pTri, mesh.nt * 3).set(mesh.tris.subarray(0, mesh.nt * 3));
  W.fillField(pField, N, G.band);
  W.fillClosest(pClose, N);
  const t0 = process.hrtime.bigint();
  W.splat(pPos, pTri, mesh.nt, pField, pClose,
    G.nx, G.ny, G.nz, 0, G.nz - 1, G.ox, G.oy, G.oz, G.h, G.band);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // メモリが伸びるとビューが無効になるので、必ず読み出してからコピーする
  const field = new Float32Array(new Float32Array(W.memory.buffer, pField, N));
  const close = new Int32Array(new Int32Array(W.memory.buffer, pClose, N));
  W.release(pClose); W.release(pField); W.release(pTri); W.release(pPos);
  return { ms, field, close };
}

const REPEAT = 3;
for (const res of [96, 128, 192]) {
  const G = setupGrid(res);
  const N = G.total;

  const fieldJS = new Float32Array(N).fill(G.band);
  const closeJS = new Int32Array(N).fill(-1);
  const t0 = process.hrtime.bigint();
  splatJS(G, fieldJS, closeJS);
  const msJS = Number(process.hrtime.bigint() - t0) / 1e6;

  console.log(`\n  res${res} ${G.nx}x${G.ny}x${G.nz} (${(N / 1e6).toFixed(1)}M voxel)   JS ${msJS.toFixed(0)} ms`);
  for (const m of mods) {
    let best = Infinity, r = null;
    for (let i = 0; i < REPEAT; i++) { const x = runWasm(m.W, G, N); if (x.ms < best) { best = x.ms; r = x; } }
    let dField = 0, dClose = 0, maxAbs = 0;
    for (let i = 0; i < N; i++) {
      if (fieldJS[i] !== r.field[i]) { dField++; const a = Math.abs(fieldJS[i] - r.field[i]); if (a > maxAbs) maxAbs = a; }
      if (closeJS[i] !== r.close[i]) dClose++;
    }
    console.log(`    ${m.name} ${best.toFixed(0).padStart(5)} ms  → JS 比 ${(msJS / best).toFixed(2)}x`
      + `   差分 field=${dField} closest=${dClose} maxΔ=${maxAbs.toExponential(1)}`);
  }
}
