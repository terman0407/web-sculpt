// ---------------------------------------------------------------------------
// help.js
// 「使い方」ページ（全画面オーバーレイ）。
//
// 設計上のポイント:
//  * **ツールの一覧と説明は書き写さない。** BRUSHES / DEFORMS / MASK_OPS /
//    GROUP_METHODS / STROKES / ALPHAS をそのまま読んで並べる。パレットに項目を
//    足したときヘルプだけ古くなる、という一番ありがちな腐り方を構造で防ぐ。
//    キー操作も同じ理由で main.js の SHORTCUTS を受け取って表示する。
//  * 手で書くのは「どれをいつ使うか」の話だけ。個々のツールが何をするかは
//    hint に書いてあるので重複させない。
//  * 単一ファイル版でも動くように、外部ファイルも fetch も使わない。
// ---------------------------------------------------------------------------

import { BRUSHES } from './brushes.js';
import { DEFORMS } from './deform.js';
import { MASK_OPS, MASK_MODES } from './masktools.js';
import { GROUP_METHODS } from './polygroups.js';
import { ALPHAS, STROKES } from './alpha.js';

const el = (tag, cls, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
};

// --- 手で書く部分（「どれをいつ使うか」） -----------------------------------

/**
 * 節の定義。
 *   title  左のもくじに出る見出し
 *   intro  節の最初に出す説明（配列は段落）
 *   steps  番号つきの手順
 *   items  { name, desc, key?, tag? } の一覧。表から作るものは from で指定する
 *   table  { head: [...], rows: [[...]] } の比較表
 *   notes  最後に出す注意書き
 */
function sections(shortcuts) {
  return [
    {
      id: 'start', title: 'はじめに',
      intro: [
        'ブラウザだけで動く 3D スカルプトツールです。粘土のかたまりを削ったり盛ったりして形を作ります。ZBrush の操作と考え方に寄せてあります。',
        'インストールも保存先の指定も要りません。触った形はブラウザの中に自動保存されます。',
      ],
      steps: [
        '右のパネルの〔メッシュ〕で土台の形（球・箱・円柱など）を選びます。',
        '左の並びからブラシを選んで、形の上をドラッグします。数字キーでも選べます。',
        '細かく彫りたくなったら <b>G</b> で〔動的トポロジ〕を入れます。ポリゴンが自動で増えます。',
        '<b>X</b> を押すと左右対称になります。顔や生き物はこれを入れてから始めると早いです。',
        '形が崩れてきたら <b>D</b> で〔ダイナメッシュ〕。伸びきったポリゴンが作り直されます。',
      ],
      notes: [
        '失敗しても <b>Ctrl+Z</b> で戻せます（24 回ぶん）。',
        '視点を見失ったら <b>F</b> で全体が入る位置に戻ります。',
      ],
    },
    {
      id: 'view', title: '視点とマウス操作',
      items: [
        { name: '左ドラッグ', desc: '彫る（選んでいるブラシを使う）' },
        { name: '右ドラッグ', desc: '視点を回す' },
        { name: 'ホイール', desc: '寄る / 引く' },
        { name: '中ドラッグ / Space+ドラッグ', desc: '平行移動（パン）' },
        { name: 'Shift+ドラッグ', desc: 'そのときだけスムーズブラシになる。どのブラシを選んでいても使える' },
        { name: 'Ctrl+ドラッグ', desc: 'そのときだけマスクを塗る' },
        { name: 'Alt+ドラッグ', desc: 'ブラシの向きが逆になる（盛る ↔ 削る）' },
        { name: '形の外で左ドラッグ', desc: '視点を回す（空振りしても彫れない）' },
      ],
      notes: [
        'ペンタブレットの筆圧に対応しています。〔筆圧〕を入れると強さと大きさに効きます。',
        '線が震えるときは <b>L</b> で〔レイジーマウス〕。カーソルを紐で引っぱるように追従して、なめらかな線になります。',
      ],
    },
    {
      id: 'brush', title: 'ブラシ',
      intro: [
        '左の並びから選びます。数字キー <b>1</b>〜<b>9</b>, <b>0</b> が並び順の先頭 10 個に対応します'
        + '（それ以降は左の並びから選んでください）。',
      ],
      from: 'brushes',
      notes: [
        '<b>[</b> <b>]</b> で大きさ、<b>,</b> <b>.</b> で強さを変えられます。',
        '〔フォールオフ〕は「中心と縁でどれだけ効き方を変えるか」です。上げると縁が急になり、輪郭のはっきりした跡になります。',
        '〔バックフェイスマスク〕（<b>B</b>）を入れると、手前の面だけが彫れます。薄い形の裏側をうっかり凹ませなくなります。',
      ],
    },
    {
      id: 'alpha', title: 'アルファとストローク',
      intro: ['ブラシの「跡の形」と「跡の並べ方」を変えます。ZBrush の Alpha / Stroke に相当します。'],
      subs: [
        { title: 'アルファ（跡の形）', from: 'alphas' },
        { title: 'ストローク（跡の並べ方）', from: 'strokes' },
      ],
      notes: ['アルファは彫るブラシにも塗るブラシにも効きます。革のシワや布目のような細かい模様は〔ノイズ〕系のアルファが早いです。'],
    },
    {
      id: 'detail', title: 'ディテールを増やす 4 つの方法',
      intro: [
        'ポリゴンを増やす手段が 4 つあり、使いどころが違います。迷ったらこの表を見てください。',
      ],
      table: {
        head: ['やり方', 'いつ使うか', '形は変わる？', '注意'],
        rows: [
          ['<b>動的トポロジ</b>（G）', '彫りながら必要な所だけ細かくしたい', '変わらない', '分割レベル・レイヤー・モーフは使えなくなる'],
          ['<b>Divide</b>（分割レベル）', '全体を一様に 4 倍細かくしたい。粗いレベルに戻って大きな形を直したい', '変わらない', '一気に 4 倍になるのでメモリを食う'],
          ['<b>ダイナメッシュ</b>（D）', 'ポリゴンが伸びきった / 形をくっつけたい', '<b>作り直される</b>', '解像度より薄い部分はつぶれる'],
          ['<b>リメッシュ</b>', '形はそのままでポリゴンの配置だけ整えたい。目標面数に落としたい', '保たれる', '数百万面だと数秒かかる（別スレッドで走るので操作は止まりません）'],
        ],
      },
      notes: [
        '<b>分割レベル</b>は <b>PageUp</b> / <b>PageDown</b> で上下します。粗いレベルで大きく曲げても、細部はついてきます。',
        '動的トポロジやダイナメッシュで接続が変わると、分割レベルは破棄されます（ZBrush の Sculptris Pro と同じ制約です）。',
      ],
    },
    {
      id: 'symmetry', title: 'シンメトリ（対称）',
      intro: ['左右対称に彫れます。<b>X</b> で X ミラーが入ります。'],
      items: [
        { name: '平面ミラー（X / Y / Z）', desc: '軸をまたいだ反対側にも同じように彫る。組み合わせられる' },
        { name: 'ラジアルシンメトリ', desc: '軸まわりに回転コピーする（最大 32 分割）。歯車や花のような形に。平面ミラーと掛け合わせられる' },
        { name: 'ローカルシンメトリ', desc: '原点ではなく、いまの形の中心を対称の基準にする。原点から離れた位置にある形に使う' },
      ],
      notes: ['どの組み合わせでも誤差ゼロで対称になります（対称面上の頂点も含みます）。'],
    },
    {
      id: 'deform', title: 'デフォーム（全体を変形）',
      intro: ['形全体をまとめて曲げたり伸ばしたりします。マスクした所は守られます。'],
      from: 'deforms',
      notes: ['軸が要る変形は、パレットの X / Y / Z で向きを選びます。'],
    },
    {
      id: 'mask', title: 'マスク（彫らない場所を作る）',
      intro: [
        'マスクを塗った所は彫れなくなります。<b>Ctrl+ドラッグ</b>でいつでも塗れます。',
        'モードで「置き換える / 足す / 引く」を選べます: ' + MASK_MODES.map(m => `<b>${m.jp}</b>（${m.hint}）`).join('、'),
      ],
      from: 'maskops',
      notes: [
        'マスクは半端な値も持てます。ぼかしたマスクを使うと、境目がなだらかになります。',
        'マスクした所だけを別のサブツールに切り出せます（〔サブツール〕→〔マスクで分ける〕）。',
      ],
    },
    {
      id: 'group', title: 'ポリグループ（面を分けて隠す）',
      intro: ['面をグループに分けて、一部だけ表示できます。裏側や内側を彫るときに使います。'],
      from: 'groups',
      notes: ['表示を切っているグループは彫れません。マスクと違って完全に見えなくなります。'],
    },
    {
      id: 'layer', title: 'スカルプトレイヤー',
      intro: [
        '彫った内容を層に分けて記録します。あとから強さを 0〜1 で調整したり、一時的に切ったりできます。表情やしわのバリエーションを作るのに向きます。',
      ],
      steps: [
        '〔レイヤー〕で新しい層を作り、録画状態にします。',
        'その状態で彫ります。動いたぶんが層に記録されます。',
        'スライダーで強さを変えると、彫った量が比例して増減します。',
      ],
      notes: ['トポロジが変わる操作（ダイナメッシュ・リメッシュ・動的トポロジ）をすると層は破棄されます。'],
    },
    {
      id: 'morph', title: 'モーフターゲット',
      intro: ['いまの形を覚えておいて、あとで部分的に戻せます。「彫りすぎた所だけ元に戻す」のに使います。'],
      steps: [
        '〔モーフ〕で〔記憶〕を押します。',
        '好きなように彫ります。',
        'モーフブラシで塗った所だけが記憶した形に戻ります。全体を戻す・入れ替える・差を強調することもできます。',
      ],
    },
    {
      id: 'transpose', title: 'トランスポーズ（掴んで動かす）',
      intro: ['<b>W</b> で入ります。マスクされていない範囲を、移動・回転・拡大縮小できます。腕や指の位置を直すときに使います。'],
      steps: [
        '動かしたくない所をマスクで塗ります（Ctrl+ドラッグ）。',
        '<b>W</b> を押すとギズモが立ちます。',
        'ハンドルを掴んでドラッグします。マスクの半端な値がそのまま「動きの減衰」になります。',
      ],
    },
    {
      id: 'clip', title: '平面カット',
      intro: ['<b>C</b> でモードを切り替え、画面上をドラッグして切る線を引きます。'],
      items: [
        { name: 'クリップ', desc: '平面の向こう側を平面上へ押しつける（潰す）。切り口が平らになる' },
        { name: 'トリム', desc: '平面の向こう側を切り落として、切り口に蓋をする' },
        { name: 'スライス', desc: '切らずに、平面のところに辺を入れる（あとでポリグループに分けられる）' },
        { name: 'ミラー&ウェルド', desc: '片側を捨てて反対側の鏡像に置き換え、中心で接合する。左右を完全に揃えたいときに' },
      ],
    },
    {
      id: 'subtool', title: 'サブツール（複数のパーツ）',
      intro: [
        '別々のメッシュを 1 つの作品として扱えます。頭・胴・手を分けて作るような使い方です。彫れるのは選んでいるサブツールだけです。',
      ],
      items: [
        { name: '追加 / 複製', desc: 'パーツを増やす' },
        { name: '表示 / ソロ', desc: '見せる・隠す。隠したものは彫れない' },
        { name: 'まとめる', desc: '表示中のものを 1 つのメッシュに統合する。そのあとダイナメッシュをかけると本当に融合する' },
        { name: 'バラす', desc: 'つながっていない部分ごとに分ける' },
        { name: 'マスクで分ける', desc: 'マスクした範囲を切り出して別のサブツールにする' },
      ],
    },
    {
      id: 'polymodel', title: 'ポリゴンモデリング（編集モード）',
      intro: [
        '頂点・辺・面を直接選んで編集します。Blender の編集モードに相当します。',
        '入るときに<b>四角化</b>し、出るときに三角形化して戻します。'
        + '立方体・円柱・トーラスは 100% 四角、球は 90% ほどが四角になります。',
      ],
      steps: [
        '〔ポリゴンモデリング〕→〔編集モード〕を入れます。ワイヤフレームが出ます。',
        '選択の単位（頂点 / 辺 / 面）を選びます。',
        'ビューポートを<b>クリック</b>で選択、<b>ドラッグ</b>で矩形選択。Shift で追加します。',
        '〔選択を動かす（ギズモ）〕でハンドルを掴んで移動・回転・拡大縮小します。',
        '終わったら〔編集モード〕を切ると、三角形化して彫刻メッシュへ戻ります。',
      ],
      items: [
        { name: 'すべて / 解除 / 反転', desc: '選択の基本操作' },
        { name: '広げる / 縮める', desc: '選択を隣へ 1 段ぶん広げる・縁を 1 段ぶん外す' },
        { name: '繋がり', desc: '選択に繋がっている塊を全部選ぶ（Blender の Select Linked）' },
        { name: 'エッジループ', sub: 'Alt+クリック相当',
          desc: '選択した辺から、頂点を跨いで一列に伸びる辺を選ぶ。辺が 4 本集まる頂点で繋がっていく' },
        { name: 'エッジリング', desc: '選択した辺から、四角を跨いで向かい側へ渡る辺を選ぶ。ループカットが入る場所' },
        { name: 'ループカット', sub: 'Ctrl+R 相当',
          desc: 'エッジリングに沿って四角を割る。本数を指定できる（1 本なら中点）' },
        { name: 'ベベル（面取り）', sub: 'Ctrl+B 相当',
          desc: '選択した辺の角を落として帯を張る。辺が 3 本以上集まる頂点には角の面も張るので閉じたまま' },
        { name: '押し出し', sub: 'E 相当',
          desc: '選択した面を複製して、領域の縁に側面を張る。動かす向きは頂点ごとの法線' },
        { name: 'インセット', sub: 'Shift+I 相当',
          desc: '面の内側に一段小さい面を作る。面ごとに処理するので、隣り合う面を同時に選ぶと境目に帯ができる' },
        { name: '面を細分化', desc: '選択した面を 4 分割する。隣の面にも中点を差し込むので割れ目ができない' },
        { name: '面を削除', desc: '選択した面を消す。使われなくなった頂点も一緒に消える' },
        { name: '辺を溶解', desc: '選択した辺を消して、両側の 2 面を 1 面にまとめる。四角 2 枚なら六角形になる' },
        { name: '面の向きを反転', desc: '選択した面の裏表を入れ替える' },
      ],
      notes: [
        '押し出しとインセットのあとは<b>新しくできた面が選択されたまま</b>なので、続けて押せます。'
        + '「インセット → 内側へ押し出し」で凹み、「押し出しを繰り返す」で腕や角が伸びます。',
        '<b>四角は彫刻すると消えます。</b>動的トポロジもダイナメッシュもリメッシュも三角形化するので、'
        + '「編集モードで土台を組む → 彫刻へ移る」の順で使ってください'
        + '（ZBrush の ZModeler と DynaMesh の関係と同じです）。',
        '編集モードとトランスポーズ・平面カットは同時に使えません（どれも左ドラッグを使うので）。',
        '選択している辺は橙、形の縁（穴の境界）は赤で出ます。'
        + '赤が出ていたら閉じていない場所があるという意味です。',
        'ループカットは<b>1 回に 1 リングまで</b>です。直交する 2 リングは同じ四角を共有するので、'
        + '同時に切ると分割点が浮いて穴が開きます（Blender の Ctrl+R も 1 リングずつです）。',
        'ベベルは辺が<b>「通り抜ける」選択</b>でだけ通ります。閉じたエッジループや'
        + '立方体の全辺のように、どの頂点にもベベル辺が 2 本以上集まっている選択が条件です。'
        + '端が途切れる選択は帯の両側に別々の頂点を割り当てられないので、'
        + '黙って壊さずに理由を出して断ります。',
        'ベベルのあとは<b>張った帯が選択されたまま</b>なので、続けて押し出すと'
        + '角に沿ったリブ（畝）になります。',
      ],
    },
    {
      id: 'io', title: '保存と書き出し',
      intro: ['触った内容はブラウザの中に自動保存されます。他のソフトへ持ち出すには書き出します。'],
      items: [
        { name: 'OBJ', desc: '形 + 頂点カラー。〔四角優勢で書き出す〕を入れると、隣り合う三角形を対にして四角として出します（ZRemesher の出力に近い見た目になります）' },
        { name: 'STL', desc: '形だけ。3D プリント向け' },
        { name: 'PLY', desc: '形 + 頂点カラー（バイナリ）' },
      ],
      notes: [
        'ブラウザ内の保存は端末・ブラウザごとに独立しています。別の環境へ移すには書き出してください。',
        '分割レベルは保存されません（いま表示しているレベルのメッシュだけが保存されます）。',
      ],
    },
    {
      id: 'keys', title: 'キー操作',
      from: 'shortcuts', shortcuts,
    },
    {
      id: 'trouble', title: '困ったとき',
      items: [
        {
          name: '重い / カクつく',
          desc: '右上に頂点数が出ています。数十万頂点を超えたら〔ディテール〕を下げるか、〔最大頂点数〕で上限を決めてください。'
            + '〔描画スケール〕を下げるのも効きます。',
        },
        {
          name: '「WebGPU が使えません」と出る',
          desc: 'Chrome / Edge 113 以降、Safari 18 以降で開いてください。Firefox は WebGPU を有効化する必要があります。'
            + '<code>chrome://gpu</code> で状態を確認できます。',
        },
        {
          name: '形が崩れた / トゲが出た',
          desc: '<b>Ctrl+Z</b> で戻してください。強さを上げすぎたときは〔スムーズ〕（Shift+ドラッグ）で整えられます。'
            + 'ポリゴンが伸びきっている場合は <b>D</b> でダイナメッシュをかけ直します。',
        },
        {
          name: '彫れない',
          desc: 'マスクが残っていませんか（〔マスク〕→〔クリア〕）。ポリグループの表示を切っていませんか。'
            + 'サブツールを使っているときは、選んでいるものしか彫れません。',
        },
        {
          name: '対称にならない',
          desc: '<b>X</b> が入っているか確認してください。形が原点から離れている場合は〔ローカルシンメトリ〕を入れます。',
        },
      ],
    },
  ];
}

// --- 表から一覧を作る ------------------------------------------------------

/** ブラシは数字キーの対応も出す（左の並び順 = キーの順） */
function brushItems() {
  return BRUSHES.map((b, i) => ({
    name: b.jp,
    sub: b.name,
    icon: b.icon,
    key: i < 10 ? String((i + 1) % 10) : '',
    desc: b.hint || '',
  }));
}

function fromTable(list) {
  return list.map(d => ({
    name: d.jp,
    sub: d.name || '',
    desc: d.hint || '',
    // params の形はパレットによって違う。DEFORMS / MASK_OPS は {key, jp, …} の
    // 配列、STROKES は文字列（キー名）の配列。どちらでも読めるようにする。
    params: d.params && d.params.length
      ? d.params.map(p => (typeof p === 'string' ? p : p.jp)).join(' / ')
      : '',
  }));
}

function shortcutRows(shortcuts) {
  const groups = new Map();
  for (const s of shortcuts || []) {
    if (s.hidden || !s.group) continue;
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push({ keys: s.keys, jp: s.jp });
  }
  // 表に無いがマウス側で処理しているもの。ここだけは手で足す
  groups.set('視点', [
    { keys: '右ドラッグ', jp: '視点を回す' },
    { keys: 'ホイール', jp: '寄る / 引く' },
    { keys: '中ドラッグ / Space+ドラッグ', jp: '平行移動' },
    ...(groups.get('視点') || []).filter(r => !/Space/.test(r.keys)),
  ]);
  groups.set('押している間だけ', [
    { keys: 'Shift+ドラッグ', jp: 'スムーズ' },
    { keys: 'Ctrl+ドラッグ', jp: 'マスクを塗る' },
    { keys: 'Alt+ドラッグ', jp: 'ブラシの向きを反転' },
  ]);
  return [...groups.entries()].map(([name, rows]) => ({ name, rows }));
}

const TABLES = {
  brushes: brushItems,
  deforms: () => fromTable(DEFORMS),
  maskops: () => fromTable(MASK_OPS),
  groups: () => fromTable(GROUP_METHODS),
  strokes: () => fromTable(STROKES),
  alphas: () => ALPHAS.map(a => ({ name: a.jp, sub: a.id, desc: a.hint || '' })),
};

/**
 * このページが元にしている定義そのもの。
 * 「一覧を書き写す形に戻っていないか」を test/help.mjs が突き合わせるのに使う。
 */
export const HELP_SOURCES = {
  ブラシ: BRUSHES,
  デフォーム: DEFORMS,
  マスクツール: MASK_OPS,
  ポリグループ: GROUP_METHODS,
  アルファ: ALPHAS,
  ストローク: STROKES,
};

// --- 描画 -------------------------------------------------------------------

function renderItems(parent, items) {
  const list = el('div', 'help-items', parent);
  for (const it of items) {
    const row = el('div', 'help-item', list);
    row.dataset.search = `${it.name} ${it.sub || ''} ${it.desc}`.toLowerCase();
    const head = el('div', 'help-item-head', row);
    if (it.icon) el('span', 'help-ico', head).textContent = it.icon;
    el('span', 'help-name', head).textContent = it.name;
    if (it.sub) el('span', 'help-sub', head).textContent = it.sub;
    if (it.key) el('span', 'help-key', head).textContent = it.key;
    if (it.desc) el('p', 'help-desc', row).innerHTML = it.desc;
    if (it.params) el('p', 'help-params', row).textContent = '設定: ' + it.params;
  }
  return list;
}

function renderTable(parent, t) {
  const wrap = el('div', 'help-tablewrap', parent);
  const tb = el('table', 'help-table', wrap);
  const tr = el('tr', null, el('thead', null, tb));
  for (const h of t.head) el('th', null, tr).innerHTML = h;
  const body = el('tbody', null, tb);
  for (const r of t.rows) {
    const row = el('tr', null, body);
    row.dataset.search = r.join(' ').toLowerCase().replace(/<[^>]+>/g, '');
    for (const c of r) el('td', null, row).innerHTML = c;
  }
}

function renderShortcuts(parent, shortcuts) {
  for (const g of shortcutRows(shortcuts)) {
    el('h3', null, parent).textContent = g.name;
    const wrap = el('div', 'help-tablewrap', parent);
    const tb = el('table', 'help-table keys', wrap);
    const body = el('tbody', null, tb);
    for (const r of g.rows) {
      const row = el('tr', null, body);
      row.dataset.search = `${r.keys} ${r.jp}`.toLowerCase();
      el('td', 'kcell', row).innerHTML = r.keys.split(' / ')
        .map(k => `<kbd>${k}</kbd>`).join(' / ');
      el('td', null, row).textContent = r.jp;
    }
  }
}

function renderSection(parent, s) {
  const sec = el('section', 'help-sec', parent);
  sec.id = 'help-' + s.id;
  el('h2', null, sec).textContent = s.title;
  for (const p of s.intro || []) el('p', 'help-p', sec).innerHTML = p;
  if (s.steps) {
    const ol = el('ol', 'help-steps', sec);
    for (const st of s.steps) el('li', null, ol).innerHTML = st;
  }
  if (s.table) renderTable(sec, s.table);
  if (s.items) renderItems(sec, s.items);
  if (s.from === 'shortcuts') renderShortcuts(sec, s.shortcuts);
  else if (s.from && TABLES[s.from]) renderItems(sec, TABLES[s.from]());
  for (const sub of s.subs || []) {
    el('h3', null, sec).textContent = sub.title;
    if (sub.from && TABLES[sub.from]) renderItems(sec, TABLES[sub.from]());
  }
  if (s.notes) {
    const ul = el('ul', 'help-notes', sec);
    for (const n of s.notes) el('li', null, ul).innerHTML = n;
  }
  return sec;
}

/**
 * 使い方ページを組み立てる。
 * @param {HTMLElement} root  #help（index.html にある空の入れ物）
 * @param {object} opt  { shortcuts } main.js の SHORTCUTS
 * @returns {{ open, close, toggle, isOpen }}
 */
export function buildHelp(root, opt = {}) {
  const secs = sections(opt.shortcuts || []);
  root.textContent = '';
  const card = el('div', 'help-card', root);

  const head = el('div', 'help-head', card);
  el('div', 'help-title', head).innerHTML = '使い方<span class="help-hint">Esc で閉じる</span>';
  const search = el('input', 'help-search', head);
  search.type = 'search';
  search.placeholder = 'ツール名で絞り込む…';
  search.setAttribute('aria-label', 'ツール名で絞り込む');
  const close = el('button', 'help-close', head);
  close.textContent = '✕';
  close.title = '閉じる (Esc)';

  const body = el('div', 'help-body', card);
  const nav = el('nav', 'help-nav', body);
  const main = el('div', 'help-main', body);

  const links = [];
  for (const s of secs) {
    const a = el('button', 'help-navlink', nav);
    a.textContent = s.title;
    a.onclick = () => {
      const t = document.getElementById('help-' + s.id);
      if (t) t.scrollIntoView({ block: 'start' });
    };
    links.push(a);
    renderSection(main, s);
  }

  // --- 絞り込み ---
  // 一致した項目だけを残し、1 つも残らない節は見出しごと隠す。
  // もくじも一緒に隠さないと「押しても何も無い」リンクが残る。
  const apply = () => {
    const q = search.value.trim().toLowerCase();
    secs.forEach((s, i) => {
      const sec = document.getElementById('help-' + s.id);
      if (!sec) return;
      const rows = sec.querySelectorAll('[data-search]');
      if (!q) {
        rows.forEach(r => r.classList.remove('hide'));
        sec.classList.remove('hide');
        links[i].classList.remove('hide');
        return;
      }
      let shown = 0;
      rows.forEach(r => {
        const hit = r.dataset.search.includes(q);
        r.classList.toggle('hide', !hit);
        if (hit) shown++;
      });
      // 節の見出し自体が一致していれば、中身を全部見せる
      const titleHit = s.title.toLowerCase().includes(q);
      if (titleHit) { rows.forEach(r => r.classList.remove('hide')); shown = rows.length || 1; }
      sec.classList.toggle('hide', shown === 0);
      links[i].classList.toggle('hide', shown === 0);
    });
    card.classList.toggle('filtering', !!q);
  };
  search.addEventListener('input', apply);

  const api = {
    isOpen: () => root.classList.contains('show'),
    open() {
      root.classList.add('show');
      main.scrollTop = 0;
      // 検索欄に自動で入れない。開いた直後にキー操作（数字でブラシ切り替えなど）
      // を試す人がいて、そのまま検索欄に文字が入ってしまう。
      close.focus();
    },
    close() {
      root.classList.remove('show');
      search.value = '';
      apply();
    },
    toggle() { if (api.isOpen()) api.close(); else api.open(); },
  };
  close.onclick = () => api.close();
  // カード外（背景）を押したら閉じる
  root.addEventListener('pointerdown', (e) => { if (e.target === root) api.close(); });
  return api;
}
