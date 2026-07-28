// ---------------------------------------------------------------------------
// 追加ツール群（デフォーム / マスク / ポリグループ / レイヤー / モーフ / クリップ / トランスポーズ） の E2E テスト（実ブラウザ）。
//   node test/features.mjs
//
// Node からは Worker も WebGPU も使えないので、モジュール単体テスト
// （test/*.test.mjs）ではこの経路を通せない。UI の生成と tools.js の配線が
// 本当に効いているかはここでしか分からない。
// ---------------------------------------------------------------------------
import { launch, waitFor } from './cdp.mjs';
const h = await launch('/index.html', { width: 1400, height: 900 });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
try {
  const { cdp } = h;
  await waitFor(async () => cdp.eval('!!(window.WebSculpt && window.WebSculpt.renderer)'), 60000, 'boot');
  const fatal = await cdp.eval("document.getElementById('fatal').style.display");
  if (fatal === 'flex') throw new Error('起動エラー: ' + await cdp.eval("document.getElementById('fatalMsg').textContent"));
  console.log('  tools=' + await cdp.eval('typeof window.WebSculpt.tools'));
  await cdp.eval('new Promise(r=>setTimeout(r,500))');
  const run = async (code) => JSON.parse(await cdp.eval('JSON.stringify((() => { ' + code + ' })())'));

  await run("const W=window.WebSculpt; W.state.dynTopo=false; W.app.newMesh('sphere'); W.sculptor.divide(); W.sculptor.divide(); return 1;");

  // 1) デフォーム
  let r = await run(`const W=window.WebSculpt, m=W.mesh;
    const b0=m.bounds();
    W.state.deform.axis=1; W.state.deform.params.taper.amount=0.6;
    W.tools.applyDeform('taper');
    const b1=m.bounds();
    return { beforeX:b0.max[0]-b0.min[0], afterX:b1.max[0]-b1.min[0],
      nan:[...m.positions.slice(0,900)].some(v=>!isFinite(v)) };`);
  ok(!r.nan && r.afterX !== r.beforeX, 'デフォーム taper が効く (X 幅 ' + r.beforeX.toFixed(3) + ' → ' + r.afterX.toFixed(3) + ')');
  await run('window.WebSculpt.app.undo(); return 1;');

  // 2) マスクツール
  r = await run(`const W=window.WebSculpt, m=W.mesh;
    W.tools.applyMaskOp('all');
    let a=0; for(let v=0;v<m.nv;v++) if(m.vAlive[v]) a+=m.mask[v];
    W.tools.applyMaskOp('invert');
    let b=0; for(let v=0;v<m.nv;v++) if(m.vAlive[v]) b+=m.mask[v];
    const pt=new Float32Array([1,0,0]);
    W.sculptor.beginStroke('crease',pt,-1);
    for(let k=1;k<=8;k++){pt.set([Math.cos(k*0.07),Math.sin(k*0.07)*0.4,0.25]);W.sculptor.addSample(pt);}
    W.sculptor.endStroke(); W.sculptor.flushCurvature();
    W.state.mask.params.cavity.gain=20;
    W.tools.applyMaskOp('cavity');
    let c=0; for(let v=0;v<m.nv;v++) if(m.vAlive[v]) c+=m.mask[v];
    W.tools.applyMaskOp('clear');
    let d=0; for(let v=0;v<m.nv;v++) if(m.vAlive[v]) d+=m.mask[v];
    return { all:a, inv:b, cav:c, cleared:d, live:m.liveVerts };`);
  ok(r.all === r.live && r.inv === 0, 'マスク 全面/反転 (' + r.all + '/' + r.live + ' → ' + r.inv + ')');
  ok(r.cav > 0, 'キャビティマスクが何かをマスクする (合計 ' + r.cav.toFixed(1) + ')');
  ok(r.cleared === 0, 'クリアで 0 に戻る');

  // 3) ポリグループ + 部分表示
  r = await run(`const W=window.WebSculpt;
    W.app.newMesh('cube'); W.sculptor.divide();
    W.state.groupAngle=35; W.tools.groupAssign('byNormalAngle');
    const g2=W.tools.groups.groupCount;
    W.tools.groupVisibility('hideGroup', 0);
    const vis=W.tools.groups.visibleCount(), hid=W.tools.groups.hiddenCount();
    const gpuCount=W.renderer.visCount;
    W.tools.groupVisibility('showAll');
    return { g2, vis, hid, gpuCount, after:W.renderer.visCount };`);
  ok(r.g2 === 6, '箱が法線角で 6 グループになる (' + r.g2 + ')');
  ok(r.hid > 0 && r.gpuCount === r.vis * 3, '非表示が GPU の可視インデックスに反映される (可視 ' + r.vis + ' 面 = ' + r.gpuCount + ' idx)');
  ok(r.after === 0, '全表示に戻すとインデックス差し替えが解除される');

  // 4) スカルプトレイヤー
  r = await run(`const W=window.WebSculpt, m=W.mesh;
    W.state.dynTopo=false; W.app.newMesh('sphere'); W.sculptor.divide();
    const i=W.tools.layerAdd();
    const base=m.positions.slice(0,m.nv*3);
    const pt=new Float32Array([1,0,0]);
    W.sculptor.beginStroke('clay',pt,1);
    for(let k=1;k<=6;k++){pt.set([Math.cos(k*0.06),Math.sin(k*0.06)*0.3,0.2]);W.sculptor.addSample(pt);}
    W.sculptor.endStroke();
    const sculpted=m.positions.slice(0,m.nv*3);
    let d1=0; for(let j=0;j<base.length;j++) d1+=Math.abs(sculpted[j]-base[j]);
    W.tools.layerSetIntensity(i,0,true);
    let d0=0; for(let j=0;j<base.length;j++) d0+=Math.abs(m.positions[j]-base[j]);
    W.tools.layerSetIntensity(i,1,true);
    let d2=0; for(let j=0;j<base.length;j++) d2+=Math.abs(m.positions[j]-sculpted[j]);
    return { layers:W.tools.layers.count, sculptDiff:d1, atZero:d0, backToOne:d2,
      verts:W.tools.layers.list()[i].verts };`);
  ok(r.layers === 1 && r.verts > 0, 'レイヤーが彫刻を記録する (' + r.verts + ' 頂点)');
  ok(r.sculptDiff > 1e-3, '彫刻で形が変わった (' + r.sculptDiff.toFixed(4) + ')');
  ok(r.atZero < 1e-5, '強度 0 でベース形状に戻る (残差 ' + r.atZero.toExponential(1) + ')');
  ok(r.backToOne < 1e-5, '強度 1 で彫刻後に戻る (残差 ' + r.backToOne.toExponential(1) + ')');

  // 5) モーフターゲット
  r = await run(`const W=window.WebSculpt, m=W.mesh;
    W.app.newMesh('sphere'); W.sculptor.divide();
    W.tools.morphStore();
    const stored=m.positions.slice(0,m.nv*3);
    const pt=new Float32Array([1,0,0]);
    W.sculptor.beginStroke('clay',pt,1);
    for(let k=1;k<=6;k++){pt.set([Math.cos(k*0.06),Math.sin(k*0.06)*0.3,0.2]);W.sculptor.addSample(pt);}
    W.sculptor.endStroke();
    const d=W.tools.morphDiff();
    W.tools.morphRestore(1);
    let res=0; for(let j=0;j<stored.length;j++) res+=Math.abs(m.positions[j]-stored[j]);
    return { has:W.tools.morph.has, changed:d.changed, residual:res };`);
  ok(r.has && r.changed > 0, 'モーフが差分を検出する (' + r.changed + ' 頂点)');
  ok(r.residual < 1e-5, '完全に戻せる (残差 ' + r.residual.toExponential(1) + ')');

  // 6) トリム
  r = await run(`const W=window.WebSculpt, m=W.mesh;
    W.app.newMesh('sphere'); W.sculptor.divide();
    const t0=m.liveTris;
    W.tools.applyAxisPlane('trim',1,0,1);
    const t1=m.liveTris, v1=m.liveVerts;
    const em=new Map(); const T=m.tris;
    for(let t=0;t<m.nt;t++){const i=t*3,a=T[i],b=T[i+1],c=T[i+2];if(a===b&&b===c)continue;
      const vv=[a,b,c];
      for(let e=0;e<3;e++){const x=vv[e],y=vv[(e+1)%3];const k=x<y?x+':'+y:y+':'+x;em.set(k,(em.get(k)||0)+1);}}
    let bad=0,bnd=0; for(const [,n] of em){if(n===1)bnd++;else if(n!==2)bad++;}
    return { t0, t1, v1, bad, bnd, chi:v1-em.size+t1 };`);
  ok(r.t1 < r.t0 && r.t1 > 0, 'トリムで切れる (' + r.t0 + ' → ' + r.t1 + ' 面)');
  ok(r.bad === 0 && r.bnd === 0, 'トリム後も閉多様体 (非多様体 ' + r.bad + ' / 境界 ' + r.bnd + ' / χ=' + r.chi + ')');

  // 7) ミラー & ウェルド
  r = await run(`const W=window.WebSculpt, m=W.mesh;
    W.app.newMesh('sphere'); W.sculptor.divide();
    const pt=new Float32Array([1,0.3,0]);
    W.sculptor.beginStroke('clay',pt,1);
    for(let k=1;k<=6;k++){pt.set([Math.cos(k*0.06),0.3+k*0.01,0.3]);W.sculptor.addSample(pt);}
    W.sculptor.endStroke();
    W.tools.mirrorWeld(0,1);
    const P=m.positions; let worst=0;
    const step=Math.max(1,Math.floor(m.nv/200));
    for(let v=0;v<m.nv;v+=step){ if(!m.vAlive[v])continue; const i=v*3;
      let best=Infinity;
      for(let u=0;u<m.nv;u++){ if(!m.vAlive[u])continue; const j=u*3;
        const dd=(P[j]+P[i])**2+(P[j+1]-P[i+1])**2+(P[j+2]-P[i+2])**2;
        if(dd<best)best=dd;}
      if(best>worst)worst=best;}
    const em=new Map(); const T=m.tris;
    for(let t=0;t<m.nt;t++){const i=t*3,a=T[i],b=T[i+1],c=T[i+2];if(a===b&&b===c)continue;
      const vv=[a,b,c];
      for(let e=0;e<3;e++){const x=vv[e],y=vv[(e+1)%3];const k=x<y?x+':'+y:y+':'+x;em.set(k,(em.get(k)||0)+1);}}
    let bad=0,bnd=0; for(const [,n] of em){if(n===1)bnd++;else if(n!==2)bad++;}
    return { sym:Math.sqrt(worst), bad, bnd, verts:m.liveVerts };`);
  ok(r.sym < 1e-4, 'ミラー&ウェルドで左右対称になる (ずれ ' + r.sym.toExponential(1) + ')');
  ok(r.bad === 0 && r.bnd === 0, 'ミラー&ウェルド後も閉多様体 (非多様体 ' + r.bad + ' / 境界 ' + r.bnd + ')');

  // 8) トランスポーズ
  r = await run(`const W=window.WebSculpt, m=W.mesh;
    W.app.newMesh('sphere'); W.sculptor.divide();
    for(let v=0;v<m.nv;v++) m.mask[v] = m.positions[v*3+1] < 0 ? 1 : 0;
    m.markAllDirty();
    const okAct = W.tools.gizmoActivate();
    const piv = Array.from(W.tools.gizmo.pivot());
    const hs = W.tools.gizmo.handles(0.5);
    const before=m.positions.slice(0,m.nv*3);
    const o=new Float32Array([piv[0],piv[1],piv[2]+10]), d=new Float32Array([0,0,-1]);
    const began=W.tools.gizmo.beginDrag(m,{kind:'move',axis:1},o,d);
    const o2=new Float32Array([piv[0],piv[1]+0.4,piv[2]+10]);
    const up=W.tools.gizmo.updateDrag(m,o2,d,null);
    let maskedMoved=0, freeMoved=0;
    for(let v=0;v<m.nv;v++){ if(!m.vAlive[v])continue; const i=v*3;
      const dd=Math.abs(m.positions[i]-before[i])+Math.abs(m.positions[i+1]-before[i+1])+Math.abs(m.positions[i+2]-before[i+2]);
      if(m.mask[v]>=1){ if(dd>1e-9) maskedMoved++; } else if(dd>1e-6) freeMoved++; }
    W.tools.gizmo.cancelDrag(m);
    let residual=0; for(let j=0;j<before.length;j++) residual+=Math.abs(m.positions[j]-before[j]);
    return { okAct, handles:hs.length, began, changed:up.changed, maskedMoved, freeMoved, residual };`);
  ok(r.okAct && r.handles > 0, 'ギズモが立つ (ハンドル ' + r.handles + ' 個)');
  ok(r.began && r.changed > 0 && r.freeMoved > 0, '移動が効く (' + r.freeMoved + ' 頂点)');
  ok(r.maskedMoved === 0, 'マスクした頂点は 1 ビットも動かない (' + r.maskedMoved + ')');
  ok(r.residual < 1e-9, 'キャンセルで厳密に戻る (残差 ' + r.residual.toExponential(1) + ')');

  const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
  ok(errs === '[]', 'ページ例外なし ' + errs);
} catch (e) {
  console.error('ERR', e.message);
  fails++;
} finally {
  await h.stop();
}
console.log(fails === 0 ? '\n✅ 全機能スモークテスト通過' : '\n❌ ' + fails + ' 件失敗');
process.exit(fails === 0 ? 0 : 1);
