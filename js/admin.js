import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
  collection, doc, getDocs, onSnapshot, setDoc, updateDoc,
  writeBatch, serverTimestamp, getCountFromServer, arrayUnion, arrayRemove
} from './firebase-sdk.js';
import {
  auth, db, configMissing, renderSeatMap, buildSeatList, parseNumberList,
  normalizeName, normalizePhone, isValidPhone, studentKey, takeSeat, releaseSeat,
  escapeHtml, classSort, classMeta, seatOrder, toast
} from './common.js';
import { ADMIN_EMAILS, BRANCHES } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-login', 'view-denied', 'view-list', 'view-editor', 'view-detail', 'view-import', 'view-batch', 'view-rooms', 'view-room-editor'];

const state = {
  classes: [],
  listUnsub: null,
  detailUnsubs: [],
  cid: null,                 // 目前管理中的班級
  detail: null,
  roster: new Map(),         // key -> { name, phone }
  holders: new Map(),        // key -> { bid, seatId }
  seats: new Map(),          // seatId -> { bid }
  editingId: null,           // null = 新增
  dupFrom: null,             // 複製來源班級 ID
  disabled: new Set(),
  assignSeat: null,
  rooms: [],                 // 教室座位範本
  roomsUnsub: null,
  editingRoomId: null,
  roomDisabled: new Set(),
  rosters: null,             // 整份匯入用：cid -> Map(key -> { name, phone })
  plan: null                 // 整份匯入的比對結果
};

function show(view) {
  VIEWS.forEach((v) => $(v).classList.toggle('hidden', v !== view));
  window.scrollTo(0, 0);
}

function showNotice(msg, type = 'info') {
  const n = $('notice');
  n.textContent = msg;
  n.className = `notice ${type}`;
}

// 一次最多寫 500 筆，分批送出
async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((fn) => fn(batch));
    await batch.commit();
  }
}

// ---------- 登入 ----------
if (configMissing) {
  showNotice('尚未設定 Firebase：請依照 README 第 4 步，把設定貼到 js/firebase-config.js。', 'error');
} else {
  onAuthStateChanged(auth, (user) => {
    if (!user || user.isAnonymous) {
      $('user-box').classList.add('hidden');
      stopListening();
      show('view-login');
      return;
    }
    $('user-email').textContent = user.email;
    $('user-box').classList.remove('hidden');
    const allowed = ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(String(user.email).toLowerCase());
    if (!allowed) {
      $('denied-email').textContent = user.email;
      stopListening();
      show('view-denied');
      return;
    }
    startListening();
    show('view-list');
  });
}

$('btn-login').addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    console.error(err);
    if (err.code === 'auth/unauthorized-domain') {
      showNotice('這個網域尚未授權：請依照 README 第 6 步，把網址加入 Authentication → 設定 → 授權網域。', 'error');
    } else if (err.code === 'auth/operation-not-allowed') {
      showNotice('尚未啟用 Google 登入：請依照 README 第 2 步開啟。', 'error');
    } else if (err.code !== 'auth/popup-closed-by-user') {
      showNotice('登入失敗：' + err.code, 'error');
    }
  }
});
$('btn-logout').addEventListener('click', () => signOut(auth));
$('btn-logout2').addEventListener('click', () => signOut(auth));
document.querySelectorAll('.js-back').forEach((b) => b.addEventListener('click', backToList));

function backToList() {
  stopDetail();
  show('view-list');
}

// ---------- 班級列表 ----------
$('f-branch').innerHTML = ['<option value="">全部分校</option>']
  .concat(BRANCHES.map((b) => `<option>${escapeHtml(b)}</option>`)).join('');
$('f-branch').addEventListener('change', renderList);

function startListening() {
  if (state.listUnsub) return;
  state.roomsUnsub = onSnapshot(collection(db, 'rooms'), (snap) => {
    state.rooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.branch || '').localeCompare(String(b.branch || '')) || String(a.name).localeCompare(String(b.name), 'zh-Hant', { numeric: true }));
    if (!$('view-rooms').classList.contains('hidden')) renderRooms();
  }, (err) => {
    console.error(err);
    showNotice('讀取教室範本失敗：請到 Firebase 重新貼上最新的 firestore.rules（記得改管理員 email）並發布。', 'error');
  });
  state.listUnsub = onSnapshot(collection(db, 'classes'), (snap) => {
    state.classes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(classSort);
    renderList();
  }, (err) => {
    console.error(err);
    showNotice('讀取失敗：請確認 firestore.rules 裡的管理員 email 與登入帳號一致，且規則已發布。', 'error');
  });
}

function stopListening() {
  if (state.listUnsub) state.listUnsub();
  state.listUnsub = null;
  if (state.roomsUnsub) state.roomsUnsub();
  state.roomsUnsub = null;
  stopDetail();
}

function renderList() {
  const box = $('admin-class-list');
  const branch = $('f-branch').value;
  const list = state.classes.filter((c) => !branch || c.branch === branch);
  if (!list.length) {
    box.innerHTML = state.classes.length
      ? '<p class="muted">這個分校還沒有班級。</p>'
      : '<p class="muted">還沒有班級，按右上角「新增班級」開始。</p>';
    return;
  }
  box.innerHTML = list.map((c) => `
    <div class="card admin-card">
      <div class="card-main">
        <div class="card-title">
          ${escapeHtml(c.title)}
          <span class="badge ${c.open ? 'on' : 'off'}">${c.open ? '開放劃位中' : '未開放'}</span>
        </div>
        <div class="muted small">${escapeHtml(classMeta(c))}</div>
        <div class="small">學生 <b class="cnt-roster" data-cid="${c.id}">…</b> 人・已劃位 <b class="cnt-held" data-cid="${c.id}">…</b>・座位 ${c.seats?.length || 0}</div>
      </div>
      <div class="btn-group">
        <button type="button" class="btn small primary" data-act="detail" data-id="${c.id}">管理名單／座位</button>
        <button type="button" class="btn small" data-act="toggle" data-id="${c.id}">${c.open ? '關閉劃位' : '開放劃位'}</button>
        <button type="button" class="btn small" data-act="edit" data-id="${c.id}">編輯</button>
        <button type="button" class="btn small" data-act="dup" data-id="${c.id}">複製</button>
        <button type="button" class="btn small danger" data-act="del" data-id="${c.id}">刪除</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
    const c = state.classes.find((x) => x.id === b.dataset.id);
    if (!c) return;
    ({ detail: (x) => openDetail(x.id), toggle: toggleOpen, edit: (x) => openEditor(x, false),
       dup: (x) => openEditor(x, true), del: deleteClass })[b.dataset.act](c);
  }));

  list.forEach(async (c) => {
    try {
      const [r, h] = await Promise.all([
        getCountFromServer(collection(db, 'classes', c.id, 'roster')),
        getCountFromServer(collection(db, 'classes', c.id, 'holders'))
      ]);
      const er = box.querySelector(`.cnt-roster[data-cid="${c.id}"]`);
      const eh = box.querySelector(`.cnt-held[data-cid="${c.id}"]`);
      if (er) er.textContent = r.data().count;
      if (eh) eh.textContent = h.data().count;
    } catch (e) { console.warn(e); }
  });
}

async function toggleOpen(c) {
  try {
    await updateDoc(doc(db, 'classes', c.id), { open: !c.open, updatedAt: serverTimestamp() });
    toast(c.open ? '已關閉劃位' : '已開放劃位', 'success');
  } catch (err) {
    console.error(err);
    toast('更新失敗：' + err.code, 'error');
  }
}

$('btn-copy-site').addEventListener('click', async () => {
  const url = location.href.replace(/admin\.html.*$/, '').replace(/#.*$/, '');
  try {
    await navigator.clipboard.writeText(url);
    toast('已複製家長劃位網址', 'success');
  } catch (e) {
    prompt('請複製以下網址：', url);
  }
});

async function deleteClass(c) {
  if (!confirm(`確定要刪除「${c.title}」？\n學生名單和所有座位都會一起刪除，無法復原。`)) return;
  try {
    const roster = await getDocs(collection(db, 'classes', c.id, 'roster'));
    const ops = roster.docs.map((d) => (b) => b.set(doc(db, 'students', d.id), { classes: arrayRemove(c.id) }, { merge: true }));
    for (const sub of ['seats', 'bookings', 'holders', 'roster']) {
      const snap = sub === 'roster' ? roster : await getDocs(collection(db, 'classes', c.id, sub));
      snap.docs.forEach((d) => ops.push((b) => b.delete(d.ref)));
    }
    ops.push((b) => b.delete(doc(db, 'classes', c.id)));
    await commitInChunks(ops);
    toast('已刪除班級', 'success');
  } catch (err) {
    console.error(err);
    toast('刪除失敗：' + err.code, 'error');
  }
}

// ---------- 新增 / 編輯 ----------
$('e-branch').innerHTML = ['<option value="">（不指定）</option>']
  .concat(BRANCHES.map((b) => `<option>${escapeHtml(b)}</option>`)).join('');

$('btn-new').addEventListener('click', () => openEditor(null, false));

function openEditor(c, duplicate) {
  state.editingId = c && !duplicate ? c.id : null;
  state.dupFrom = c && duplicate ? c.id : null;
  $('editor-title').textContent = !c ? '新增班級' : duplicate ? '複製班級（另存為新班級）' : '編輯班級';
  $('e-title').value = c ? c.title + (duplicate ? '（複製）' : '') : '';
  $('e-term').value = c?.term || '';
  $('e-schedule').value = c?.schedule || '';
  $('e-branch').value = c?.branch || $('f-branch').value || '';
  $('e-room').value = c?.room || '';
  $('e-note').value = c?.note || '';
  $('e-rows').value = c?.rows || 6;
  $('e-cols').value = c?.cols || 8;
  $('e-aisles').value = (c?.aisles || []).join(', ');
  $('e-open').checked = c && !duplicate ? !!c.open : false;
  state.disabled = new Set(c?.disabled || []);
  fillRoomTemplateOptions();
  renderPreview();
  show('view-editor');
}

function fillRoomTemplateOptions() {
  const branch = $('e-branch').value;
  const rooms = state.rooms.filter((r) => !branch || r.branch === branch);
  $('e-room-template').innerHTML = [`<option value="">${rooms.length ? '（不套用，自己設定）' : branch ? '這個分校還沒有教室範本' : '還沒有教室範本'}</option>`]
    .concat(rooms.map((r) => `<option value="${r.id}">${escapeHtml(branch ? r.name : `${r.branch}｜${r.name}`)}（${r.rows}×${r.cols}，${r.seats?.length || 0} 位）</option>`))
    .join('');
}

$('e-branch').addEventListener('change', fillRoomTemplateOptions);
$('e-room-template').addEventListener('change', () => {
  const r = state.rooms.find((x) => x.id === $('e-room-template').value);
  if (!r) return;
  if (!$('e-branch').value) $('e-branch').value = r.branch || '';
  $('e-room').value = r.name;
  $('e-rows').value = r.rows;
  $('e-cols').value = r.cols;
  $('e-aisles').value = (r.aisles || []).join(', ');
  state.disabled = new Set(r.disabled || []);
  renderPreview();
  toast(`已套用「${r.name}」的座位`, 'success');
});

function readLayout() {
  const rows = Math.min(26, Math.max(1, parseInt($('e-rows').value, 10) || 1));
  const cols = Math.min(30, Math.max(1, parseInt($('e-cols').value, 10) || 1));
  const aisles = parseNumberList($('e-aisles').value).filter((n) => n < cols);
  const all = new Set(buildSeatList(rows, cols));
  const disabled = [...state.disabled].filter((id) => all.has(id));
  const seats = buildSeatList(rows, cols, disabled);
  return { rows, cols, aisles, disabled, seats };
}

function renderPreview() {
  const layout = readLayout();
  renderSeatMap($('editor-preview'), layout, (id) => (
    state.disabled.has(id) ? { state: 'disabled', label: '' } : { state: 'available' }
  ), (id) => {
    if (state.disabled.has(id)) state.disabled.delete(id); else state.disabled.add(id);
    renderPreview();
  }, { allCells: true });
  $('editor-count').textContent = `共 ${layout.seats.length} 個座位`;
}

['e-rows', 'e-cols', 'e-aisles'].forEach((id) => $(id).addEventListener('input', renderPreview));

$('editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const layout = readLayout();
  if (!layout.seats.length) return toast('至少要有一個座位', 'error');

  const data = {
    title: $('e-title').value.trim(),
    term: $('e-term').value.trim(),
    schedule: $('e-schedule').value.trim(),
    branch: $('e-branch').value,
    room: $('e-room').value.trim(),
    note: $('e-note').value.trim(),
    ...layout,
    open: $('e-open').checked,
    updatedAt: serverTimestamp()
  };
  if (!data.title) return toast('請填寫班級名稱', 'error');

  const btn = $('e-submit');
  btn.disabled = true;
  try {
    if (state.editingId) {
      // 已被劃走的座位不能被刪掉
      const snap = await getDocs(collection(db, 'classes', state.editingId, 'seats'));
      const valid = new Set(layout.seats);
      const lost = snap.docs.map((d) => d.id).filter((id) => !valid.has(id));
      if (lost.length) {
        toast(`以下座位已有學生，不能移除：${lost.sort(seatOrder).join('、')}`, 'error');
        return;
      }
      await updateDoc(doc(db, 'classes', state.editingId), data);
      toast('已儲存', 'success');
      show('view-list');
    } else {
      const ref = doc(collection(db, 'classes'));
      await setDoc(ref, { ...data, createdAt: serverTimestamp() });
      // 複製班級時，可選擇一起複製學生名單（例如下學期續班）
      if (state.dupFrom && confirm('要一起複製原班級的學生名單嗎？\n（只複製名單，不複製座位）')) {
        const roster = await getDocs(collection(db, 'classes', state.dupFrom, 'roster'));
        await commitInChunks(roster.docs.flatMap((d) => addStudentOps(ref.id, d.data().name, d.data().phone)));
      }
      toast('已建立班級，接著加入學生名單', 'success');
      openDetail(ref.id);
    }
  } catch (err) {
    console.error(err);
    toast('儲存失敗：' + err.code, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- 班級管理（名單＋座位） ----------
function openDetail(cid) {
  stopDetail();
  state.cid = cid;
  state.detail = state.classes.find((c) => c.id === cid) || null;
  state.roster = new Map();
  state.holders = new Map();
  state.seats = new Map();
  $('d-import').value = '';
  updateImportPreview();
  show('view-detail');

  const sub = (name) => collection(db, 'classes', cid, name);
  state.detailUnsubs.push(onSnapshot(doc(db, 'classes', cid), (snap) => {
    if (!snap.exists()) return backToList();
    state.detail = { id: snap.id, ...snap.data() };
    renderDetail();
  }));
  state.detailUnsubs.push(onSnapshot(sub('roster'), (snap) => {
    state.roster = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderDetail();
  }));
  state.detailUnsubs.push(onSnapshot(sub('holders'), (snap) => {
    state.holders = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderDetail();
  }));
  state.detailUnsubs.push(onSnapshot(sub('seats'), (snap) => {
    state.seats = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderDetail();
  }));
}

function stopDetail() {
  state.detailUnsubs.forEach((u) => u());
  state.detailUnsubs = [];
  state.cid = null;
  state.detail = null;
}

function renderDetail() {
  const c = state.detail;
  if (!c) return;
  $('d-title').textContent = c.title;
  $('d-meta').textContent = classMeta(c);
  $('d-toggle').textContent = c.open ? '關閉劃位' : '開放劃位';

  const total = state.roster.size;
  const held = [...state.holders.keys()].filter((k) => state.roster.has(k)).length;
  $('d-stat').innerHTML = `<span class="badge ${c.open ? 'on' : 'off'}">${c.open ? '開放劃位中' : '未開放'}</span>
    學生 <b>${total}</b> 人・已劃位 <b>${held}</b>・<span class="${total - held ? 'warn' : ''}">未劃位 <b>${total - held}</b></span>
    ・座位 ${c.seats?.length || 0}`;

  // 座位圖：座位 -> 學生
  const seatToKey = new Map([...state.holders].map(([k, h]) => [h.seatId, k]));
  renderSeatMap($('d-map'), c, (id) => {
    if (!state.seats.has(id)) return { state: 'available' };
    const key = seatToKey.get(id);
    const s = key && state.roster.get(key);
    return { state: 'taken', label: s ? s.name.slice(0, 3) : '?', title: s ? `${id} ${s.name} ${s.phone}` : `${id}（無對應學生）` };
  }, (id, seatState) => {
    if (seatState === 'available') return openAssign(id);
    if (seatState !== 'taken') return;
    const key = seatToKey.get(id);
    if (key) cancelStudentSeat(key);
    else releaseOrphanSeat(id);
  });

  // 名單
  $('d-roster-count').textContent = `（${total} 人）`;
  const onlyTodo = $('d-only-todo').checked;
  const rows = [...state.roster]
    .map(([key, s]) => ({ key, ...s, holder: state.holders.get(key) }))
    .filter((r) => !onlyTodo || !r.holder)
    .sort((a, b) => (a.holder ? 1 : 0) - (b.holder ? 1 : 0) || a.name.localeCompare(b.name, 'zh-Hant'));
  $('d-rows').innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${r.holder ? `<span class="seat-tag">${escapeHtml(r.holder.seatId)}</span>` : '<span class="status todo">未劃位</span>'}</td>
      <td class="nowrap">
        ${r.holder ? `<button type="button" class="btn small" data-cancel="${escapeHtml(r.key)}">取消座位</button>` : ''}
        <button type="button" class="btn small danger" data-remove="${escapeHtml(r.key)}">移出</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="4" class="muted center">${total ? '全部學生都劃好位了 🎉' : '還沒有學生，請在右邊加入名單'}</td></tr>`;

  $('d-rows').querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => cancelStudentSeat(b.dataset.cancel)));
  $('d-rows').querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeStudent(b.dataset.remove)));
}

$('d-only-todo').addEventListener('change', renderDetail);
$('d-toggle').addEventListener('click', () => state.detail && toggleOpen(state.detail));
$('d-export').addEventListener('click', exportCsv);
$('d-print').addEventListener('click', () => $('print-modal').classList.remove('hidden'));
$('p-cancel').addEventListener('click', () => $('print-modal').classList.add('hidden'));
$('print-modal').addEventListener('click', (e) => { if (e.target.id === 'print-modal') $('print-modal').classList.add('hidden'); });
$('print-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('print-modal').classList.add('hidden');
  printSeatChart({ view: $('p-view').value, withList: $('p-list').checked, withPhone: $('p-phone').checked });
});

async function cancelStudentSeat(key) {
  const s = state.roster.get(key);
  const h = state.holders.get(key);
  if (!h) return;
  if (!confirm(`確定取消 ${s ? s.name : ''} 的座位 ${h.seatId}？`)) return;
  try {
    await releaseSeat(state.cid, key, h);
    toast('已取消座位', 'success');
  } catch (err) {
    console.error(err);
    toast('取消失敗：' + err.code, 'error');
  }
}

// 座位被佔用但找不到對應學生時，讓管理員直接釋放
async function releaseOrphanSeat(seatId) {
  if (!confirm(`${seatId} 找不到對應的學生，要直接釋放這個座位嗎？`)) return;
  try {
    const seat = state.seats.get(seatId);
    const batch = writeBatch(db);
    batch.delete(doc(db, 'classes', state.cid, 'seats', seatId));
    if (seat?.bid) batch.delete(doc(db, 'classes', state.cid, 'bookings', seat.bid));
    await batch.commit();
    toast('已釋放座位', 'success');
  } catch (err) {
    console.error(err);
    toast('釋放失敗：' + err.code, 'error');
  }
}

async function removeStudent(key) {
  const s = state.roster.get(key);
  if (!s) return;
  const h = state.holders.get(key);
  if (!confirm(`確定把 ${s.name} 移出這個班級？${h ? `\n他的座位 ${h.seatId} 也會一起釋放。` : ''}`)) return;
  try {
    if (h) await releaseSeat(state.cid, key, h);
    const batch = writeBatch(db);
    batch.delete(doc(db, 'classes', state.cid, 'roster', key));
    batch.set(doc(db, 'students', key), { classes: arrayRemove(state.cid) }, { merge: true });
    await batch.commit();
    toast(`已移出 ${s.name}`, 'success');
  } catch (err) {
    console.error(err);
    toast('移出失敗：' + err.code, 'error');
  }
}

// ---------- 加入學生 ----------
function parseRoster(text) {
  const ok = [];
  const bad = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((line) => {
    const raw = line.trim();
    if (!raw) return;
    const tokens = raw.split(/[\t,，、;；]+|\s{2,}|\s+(?=0?9[\d-]{7,})/).map((t) => t.trim()).filter(Boolean);
    let phone = '';
    const rest = [];
    tokens.forEach((t) => {
      const digits = normalizePhone(t);
      if (!phone && /^9\d{8}$/.test(digits)) phone = '0' + digits;        // 試算表吃掉開頭 0 的情況
      else if (!phone && isValidPhone(digits)) phone = digits;
      else rest.push(t);
    });
    const name = normalizeName(rest.join(''));
    if (!name || !phone || name.length > 20 || /\d/.test(name)) { bad.push(raw); return; }
    const key = studentKey(name, phone);
    if (seen.has(key)) return;
    seen.add(key);
    ok.push({ key, name, phone });
  });
  return { ok, bad };
}

function updateImportPreview() {
  const { ok, bad } = parseRoster($('d-import').value);
  const fresh = ok.filter((s) => !state.roster.has(s.key));
  const dup = ok.length - fresh.length;
  const parts = [];
  if (fresh.length) parts.push(`將加入 <b>${fresh.length}</b> 位`);
  if (dup) parts.push(`${dup} 位已在名單中（略過）`);
  if (bad.length) parts.push(`<span class="warn">無法辨識 ${bad.length} 行：${bad.slice(0, 3).map(escapeHtml).join('／')}${bad.length > 3 ? '…' : ''}</span>`);
  $('d-import-preview').innerHTML = parts.join('・');
  return fresh;
}

$('d-import').addEventListener('input', updateImportPreview);

function addStudentOps(cid, name, phone) {
  const key = studentKey(name, phone);
  return [
    (b) => b.set(doc(db, 'classes', cid, 'roster', key), { name, phone, addedAt: serverTimestamp() }),
    (b) => b.set(doc(db, 'students', key), { name, phone, classes: arrayUnion(cid) }, { merge: true })
  ];
}

$('d-import-btn').addEventListener('click', async () => {
  const fresh = updateImportPreview();
  if (!fresh.length) return toast('沒有可以加入的學生', 'error');
  const btn = $('d-import-btn');
  btn.disabled = true;
  try {
    await commitInChunks(fresh.flatMap((s) => addStudentOps(state.cid, s.name, s.phone)));
    toast(`已加入 ${fresh.length} 位學生`, 'success');
    $('d-import').value = '';
    updateImportPreview();
  } catch (err) {
    console.error(err);
    toast('加入失敗：' + err.code, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- 後台指定座位 ----------
function openAssign(seatId) {
  if (!state.roster.size) return toast('請先加入學生名單', 'error');
  state.assignSeat = seatId;
  $('a-seat').textContent = seatId;
  const list = [...state.roster]
    .map(([key, s]) => ({ key, ...s, holder: state.holders.get(key) }))
    .sort((a, b) => (a.holder ? 1 : 0) - (b.holder ? 1 : 0) || a.name.localeCompare(b.name, 'zh-Hant'));
  $('a-student').innerHTML = list.map((s) => `
    <option value="${escapeHtml(s.key)}">${escapeHtml(s.name)}（${s.holder ? '目前 ' + escapeHtml(s.holder.seatId) : '未劃位'}）</option>`).join('');
  $('assign-modal').classList.remove('hidden');
}

function closeAssign() {
  $('assign-modal').classList.add('hidden');
  state.assignSeat = null;
}

$('a-cancel').addEventListener('click', closeAssign);
$('assign-modal').addEventListener('click', (e) => { if (e.target.id === 'assign-modal') closeAssign(); });

$('assign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('a-student').value;
  const s = state.roster.get(key);
  const seatId = state.assignSeat;
  if (!s || !seatId) return;
  try {
    await takeSeat(state.cid, { key, name: s.name, phone: s.phone }, seatId);
    toast(`已把 ${s.name} 排到 ${seatId}`, 'success');
    closeAssign();
  } catch (err) {
    console.error(err);
    toast(err.message === 'SEAT_TAKEN' ? '這個位子剛被劃走了' : '指定失敗：' + (err.code || err.message), 'error');
  }
});

// ---------- 匯出 ----------
function exportCsv() {
  const c = state.detail;
  if (!c) return;
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [...state.roster]
    .map(([key, s]) => ({ ...s, seat: state.holders.get(key)?.seatId || '' }))
    .sort((a, b) => (!a.seat - !b.seat) || (a.seat && b.seat ? seatOrder(a.seat, b.seat) : a.name.localeCompare(b.name, 'zh-Hant')));
  const lines = [['座位', '姓名', '家長手機'].map(cell).join(',')]
    // 手機用 ="09..." 格式，避免 Excel / Google 試算表吃掉開頭的 0
    .concat(rows.map((r) => [cell(r.seat || '未劃位'), cell(r.name), `="${r.phone}"`].join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${c.term ? c.term + '_' : ''}${c.title}_座位表.csv`.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 整份名冊匯入 ----------
const normTitle = (t) => String(t || '').replace(/[\s　]/g, '').toLowerCase();

$('btn-import').addEventListener('click', openImport);
$('i-text').addEventListener('input', analyzeImport);
$('i-term').addEventListener('change', analyzeImport);
$('i-branch').addEventListener('change', analyzeImport);
$('i-submit').addEventListener('click', runImport);
$('btn-export-all').addEventListener('click', exportAllRosters);

async function openImport() {
  const terms = [...new Set(state.classes.map((c) => c.term).filter(Boolean))].sort().reverse();
  $('i-term').innerHTML = ['<option value="">全部學期</option>']
    .concat(terms.map((t) => `<option>${escapeHtml(t)}</option>`)).join('');
  if (terms.length) $('i-term').value = terms[0];
  $('i-branch').innerHTML = ['<option value="">全部分校</option>']
    .concat(BRANCHES.map((b) => `<option>${escapeHtml(b)}</option>`)).join('');
  $('i-branch').value = $('f-branch').value;
  $('i-preview').classList.add('hidden');
  show('view-import');
  await loadAllRosters();
  analyzeImport();
}

async function loadAllRosters() {
  $('i-status').textContent = '讀取各班目前的名單中…';
  const entries = await Promise.all(state.classes.map(async (c) => {
    const snap = await getDocs(collection(db, 'classes', c.id, 'roster'));
    return [c.id, new Map(snap.docs.map((d) => [d.id, d.data()]))];
  }));
  state.rosters = new Map(entries);
  $('i-status').textContent = '';
}

function importCandidates() {
  const term = $('i-term').value;
  const branch = $('i-branch').value;
  return state.classes.filter((c) => (!term || c.term === term) && (!branch || c.branch === branch));
}

// 解析貼上的名冊：每列 姓名、手機、班級（班級可用「、」分隔多個）
function parseBulk(text) {
  const rows = [];
  const bad = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const raw = line.trim();
    if (!raw) return;
    const useTab = line.includes('\t');
    const fields = (useTab ? line.split('\t') : line.split(/[,，]/)).map((f) => f.trim()).filter(Boolean);
    if (fields.some((f) => /^(學生)?姓名$|^(家長)?手機$|^班級$/.test(f))) return;   // 標題列
    let phone = '';
    const others = [];
    fields.forEach((f) => {
      const digits = normalizePhone(f);
      if (!phone && /^\d[\d\s-]*$/.test(f) && /^9\d{8}$/.test(digits)) phone = '0' + digits;
      else if (!phone && /^[\d\s-]+$/.test(f) && isValidPhone(digits)) phone = digits;
      else others.push(f);
    });
    const name = normalizeName(others.shift() || '');
    const classNames = others.join('、').split(useTab ? /[、;；\/,，]/ : /[、;；\/]/)
      .map((t) => t.trim()).filter(Boolean);
    if (!name || !phone || !classNames.length || name.length > 20 || /\d/.test(name)) { bad.push(raw); return; }
    rows.push({ name, phone, key: studentKey(name, phone), classNames });
  });
  return { rows, bad };
}

function analyzeImport() {
  if (!state.rosters) return;
  const { rows, bad } = parseBulk($('i-text').value);
  if (!rows.length && !bad.length) {
    $('i-preview').classList.add('hidden');
    state.plan = null;
    return;
  }

  const byTitle = new Map();
  importCandidates().forEach((c) => {
    const k = normTitle(c.title);
    byTitle.set(k, [...(byTitle.get(k) || []), c]);
  });

  const unknown = new Map();     // 班級名稱 -> 筆數
  const ambiguous = new Map();   // 班級名稱 -> 符合的班級
  const sheet = new Map();       // cid -> Map(key -> { name, phone })
  rows.forEach((r) => r.classNames.forEach((title) => {
    const matches = byTitle.get(normTitle(title)) || [];
    if (!matches.length) unknown.set(title, (unknown.get(title) || 0) + 1);
    else if (matches.length > 1) ambiguous.set(title, matches);
    else {
      const cid = matches[0].id;
      if (!sheet.has(cid)) sheet.set(cid, new Map());
      sheet.get(cid).set(r.key, { name: r.name, phone: r.phone });
    }
  }));

  const plan = [...sheet].map(([cid, students]) => {
    const c = state.classes.find((x) => x.id === cid);
    const roster = state.rosters.get(cid) || new Map();
    const adds = [...students].filter(([k]) => !roster.has(k)).map(([key, s]) => ({ key, ...s }));
    const existing = [...students.keys()].filter((k) => roster.has(k)).length;
    const missing = [...roster].filter(([k]) => !students.has(k)).map(([key, s]) => ({ key, ...s }));
    return { cid, c, total: students.size, adds, existing, missing };
  }).sort((a, b) => classSort(a.c, b.c));
  state.plan = plan;

  // 問題列表
  const problems = [];
  if (bad.length) problems.push(`<li>無法辨識 ${bad.length} 列（需要姓名、09 開頭的手機、班級）：${bad.slice(0, 5).map(escapeHtml).join('／')}${bad.length > 5 ? '…' : ''}</li>`);
  unknown.forEach((n, title) => problems.push(`<li>找不到班級「${escapeHtml(title)}」（${n} 筆）：請確認名稱和後台一樣，或檢查上面選的學期／分校</li>`));
  ambiguous.forEach((list, title) => problems.push(`<li>「${escapeHtml(title)}」對應到 ${list.length} 個班（${list.map((c) => escapeHtml(classMeta(c) || c.title)).join('；')}），請先選學期或分校</li>`));
  $('i-problems').innerHTML = problems.length
    ? `<div class="notice error"><b>這些資料不會匯入：</b><ul class="tight">${problems.join('')}</ul></div>` : '';

  $('i-rows').innerHTML = plan.length ? plan.map((p) => `
    <tr>
      <td><b>${escapeHtml(p.c.title)}</b><div class="muted small">${escapeHtml(classMeta(p.c))}</div></td>
      <td>${p.total}</td>
      <td>${p.adds.length ? `<b class="ok-text">+${p.adds.length}</b>` : '0'}</td>
      <td>${p.existing}</td>
      <td>${p.missing.length ? `<span class="warn">${p.missing.length}</span>` : '0'}</td>
    </tr>`).join('')
    : '<tr><td colspan="5" class="muted center">沒有可以對應的班級</td></tr>';

  // 名冊上沒有的學生
  const missingTotal = plan.reduce((n, p) => n + p.missing.length, 0);
  const rm = $('i-removals');
  if (missingTotal) {
    rm.innerHTML = `
      <label class="check"><input id="i-remove" type="checkbox"> 把名冊上沒有的 <b>${missingTotal}</b> 位學生移出班級（有座位的會一起釋放）</label>
      ${plan.filter((p) => p.missing.length).map((p) => `
        <div class="small"><b>${escapeHtml(p.c.title)}</b>：${p.missing.map((s) => escapeHtml(s.name)).join('、')}</div>`).join('')}
      <p class="muted small">不勾的話，這些學生會留在班上。名冊裡沒出現的班級不會有任何變動。</p>`;
    rm.classList.remove('hidden');
  } else {
    rm.innerHTML = '';
    rm.classList.add('hidden');
  }

  const addTotal = plan.reduce((n, p) => n + p.adds.length, 0);
  $('i-status').innerHTML = `共 ${rows.length} 位學生、對應到 ${plan.length} 個班，將新加入 <b>${addTotal}</b> 筆。`;
  $('i-preview').classList.remove('hidden');
}

async function runImport() {
  const plan = state.plan || [];
  const doRemove = $('i-remove')?.checked;
  const addTotal = plan.reduce((n, p) => n + p.adds.length, 0);
  const rmTotal = doRemove ? plan.reduce((n, p) => n + p.missing.length, 0) : 0;
  if (!addTotal && !rmTotal) return toast('沒有需要變動的資料', 'error');
  if (!confirm(`確定匯入？\n新加入 ${addTotal} 筆${rmTotal ? `\n移出 ${rmTotal} 筆（座位一起釋放）` : ''}`)) return;

  const btn = $('i-submit');
  btn.disabled = true;
  btn.textContent = '匯入中…';
  try {
    const ops = [];
    for (const p of plan) {
      p.adds.forEach((s) => ops.push(...addStudentOps(p.cid, s.name, s.phone)));
      if (doRemove && p.missing.length) {
        const holders = await getDocs(collection(db, 'classes', p.cid, 'holders'));
        const held = new Map(holders.docs.map((d) => [d.id, d.data()]));
        p.missing.forEach((s) => {
          const h = held.get(s.key);
          if (h) {
            ops.push((b) => b.delete(doc(db, 'classes', p.cid, 'seats', h.seatId)));
            ops.push((b) => b.delete(doc(db, 'classes', p.cid, 'bookings', h.bid)));
            ops.push((b) => b.delete(doc(db, 'classes', p.cid, 'holders', s.key)));
          }
          ops.push((b) => b.delete(doc(db, 'classes', p.cid, 'roster', s.key)));
          ops.push((b) => b.set(doc(db, 'students', s.key), { classes: arrayRemove(p.cid) }, { merge: true }));
        });
      }
    }
    await commitInChunks(ops);
    toast(`匯入完成：新加入 ${addTotal} 筆${rmTotal ? `、移出 ${rmTotal} 筆` : ''}`, 'success');
    await loadAllRosters();
    analyzeImport();
  } catch (err) {
    console.error(err);
    toast('匯入失敗：' + (err.code || err.message) + '。可以重新匯入一次，已加入的會自動略過。', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '確認匯入';
  }
}

// 把系統目前的名單匯出成「學生姓名、家長手機、班級」三欄，可以直接貼回名冊
async function exportAllRosters() {
  const classes = importCandidates();
  if (!classes.length) return toast('沒有符合的班級', 'error');
  if (!state.rosters) await loadAllRosters();
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [];
  classes.forEach((c) => (state.rosters.get(c.id) || new Map()).forEach((s) => rows.push([s.name, s.phone, c.title])));
  rows.sort((a, b) => a[2].localeCompare(b[2], 'zh-Hant') || a[0].localeCompare(b[0], 'zh-Hant'));
  const lines = [['學生姓名', '家長手機', '班級'].map(cell).join(',')]
    .concat(rows.map((r) => [cell(r[0]), `="${r[1]}"`, cell(r[2])].join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const tag = [$('i-term').value, $('i-branch').value].filter(Boolean).join('_') || '全部';
  a.download = `學生名冊_${tag}.csv`.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`已匯出 ${rows.length} 筆`, 'success');
}

// ---------- 批次建立班級 ----------
$('btn-batch').addEventListener('click', openBatch);
$('b-text').addEventListener('input', analyzeBatch);
['b-rows', 'b-cols', 'b-aisles'].forEach((id) => $(id).addEventListener('input', analyzeBatch));
$('b-template').addEventListener('change', () => { syncTemplateInputs(); analyzeBatch(); });
$('b-submit').addEventListener('click', runBatch);

let batchPlan = [];

function openBatch() {
  const roomOpts = state.rooms.map((r) => `<option value="room:${r.id}">教室範本：${escapeHtml(r.branch || '')}｜${escapeHtml(r.name)}（${r.rows}×${r.cols}，${r.seats?.length || 0} 位）</option>`).join('');
  const classOpts = state.classes.map((c) => `<option value="class:${c.id}">「${escapeHtml(c.title)}」的座位（${escapeHtml(classMeta(c) || '')}｜${c.rows}×${c.cols}，${c.seats?.length || 0} 位）</option>`).join('');
  $('b-template').innerHTML = '<option value="">使用下面的排數、每排座位數、走道</option>'
    + (roomOpts ? `<optgroup label="套用教室範本">${roomOpts}</optgroup>` : '')
    + (classOpts ? `<optgroup label="套用現有班級的座位">${classOpts}</optgroup>` : '');
  syncTemplateInputs();
  $('b-preview').classList.add('hidden');
  $('b-status').textContent = '';
  show('view-batch');
  analyzeBatch();
}

function batchTemplate() {
  const [kind, id] = String($('b-template').value).split(':');
  if (kind === 'room') {
    const r = state.rooms.find((x) => x.id === id);
    return r ? { ...r, label: `教室範本「${r.branch ? r.branch + ' ' : ''}${r.name}」` } : null;
  }
  if (kind === 'class') {
    const c = state.classes.find((x) => x.id === id);
    return c ? { ...c, label: `套用「${c.title}」` } : null;
  }
  return null;
}

function syncTemplateInputs() {
  const t = batchTemplate();
  ['b-rows', 'b-cols', 'b-aisles'].forEach((id) => { $(id).disabled = !!t; });
  if (t) {
    $('b-rows').value = t.rows;
    $('b-cols').value = t.cols;
    $('b-aisles').value = (t.aisles || []).join(', ');
  }
}

function layoutFrom(t, label) {
  return { rows: t.rows, cols: t.cols, aisles: [...(t.aisles || [])], disabled: [...(t.disabled || [])], seats: [...(t.seats || [])], from: label };
}

function defaultLayout() {
  const t = batchTemplate();
  if (t) return layoutFrom(t, t.label);
  const rows = parseInt($('b-rows').value, 10);
  const cols = parseInt($('b-cols').value, 10);
  return makeLayout(rows, cols, parseNumberList($('b-aisles').value));
}

function makeLayout(rows, cols, aisles) {
  if (!(rows >= 1 && rows <= 26 && cols >= 1 && cols <= 30)) return null;
  const a = aisles.filter((n) => n < cols);
  return { rows, cols, aisles: a, disabled: [], seats: buildSeatList(rows, cols), from: '' };
}

function parseBatch(text) {
  const rows = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    const f = (line.includes('\t') ? line.split('\t') : line.split(/[,，]/)).map((x) => x.trim());
    if (f[0] === '班級名稱') return;   // 標題列
    rows.push({
      raw: line.trim(),
      title: f[0] || '', term: f[1] || '', schedule: f[2] || '', branch: f[3] || '', room: f[4] || '',
      rowsText: f[5] || '', colsText: f[6] || '', aislesText: f[7] || ''
    });
  });
  return rows;
}

function analyzeBatch() {
  const parsed = parseBatch($('b-text').value);
  if (!parsed.length) {
    $('b-preview').classList.add('hidden');
    $('b-status').textContent = '';
    batchPlan = [];
    return;
  }
  const keyOf = (title, term, branch) => `${normTitle(title)}|${String(term).trim()}|${String(branch).trim()}`;
  const existing = new Set(state.classes.map((c) => keyOf(c.title, c.term || '', c.branch || '')));
  const seen = new Set();
  const base = defaultLayout();
  const unknownBranches = new Set();

  batchPlan = parsed.map((r) => {
    const item = { ...r, status: 'ok', note: '' };
    if (!r.title) { item.status = 'skip'; item.note = '缺少班級名稱'; return item; }
    if (r.title.length > 60) { item.status = 'skip'; item.note = '班級名稱太長'; return item; }
    const k = keyOf(r.title, r.term, r.branch);
    if (existing.has(k)) { item.status = 'skip'; item.note = '已經有這個班級，略過'; return item; }
    if (seen.has(k)) { item.status = 'skip'; item.note = '清單裡重複，略過'; return item; }
    seen.add(k);

    const override = r.rowsText || r.colsText || r.aislesText;
    let layout;
    if (override) {
      const rowsN = r.rowsText ? parseInt(r.rowsText, 10) : parseInt($('b-rows').value, 10);
      const colsN = r.colsText ? parseInt(r.colsText, 10) : parseInt($('b-cols').value, 10);
      layout = makeLayout(rowsN, colsN, r.aislesText ? parseNumberList(r.aislesText) : parseNumberList($('b-aisles').value));
      if (!layout) { item.status = 'skip'; item.note = '排數要 1～26、每排座位數要 1～30'; return item; }
    } else {
      // 分校＋教室對得上教室範本的，優先用範本
      const room = r.room && state.rooms.find((x) => normTitle(x.name) === normTitle(r.room) && (!r.branch || x.branch === r.branch));
      layout = room ? layoutFrom(room, `教室範本「${room.branch ? room.branch + ' ' : ''}${room.name}」`) : base;
      if (!layout) { item.status = 'skip'; item.note = '預設座位的排數或座位數不正確'; return item; }
    }
    item.layout = layout;
    if (r.branch && !BRANCHES.includes(r.branch)) {
      unknownBranches.add(r.branch);
      item.note = '分校名稱不在清單中（仍會建立）';
    }
    return item;
  });

  const okCount = batchPlan.filter((x) => x.status === 'ok').length;
  const problems = [];
  if (unknownBranches.size) {
    problems.push(`<li>分校名稱「${[...unknownBranches].map(escapeHtml).join('」「')}」不在分校清單裡。班級仍會建立，但用分校篩選時會找不到，建議改成清單裡的名稱：${BRANCHES.map(escapeHtml).join('、')}</li>`);
  }
  $('b-problems').innerHTML = problems.length ? `<div class="notice error"><ul class="tight">${problems.join('')}</ul></div>` : '';

  $('b-rows-preview').innerHTML = batchPlan.map((x) => `
    <tr class="${x.status === 'skip' ? 'muted' : ''}">
      <td><b>${escapeHtml(x.title || '（空白）')}</b></td>
      <td>${escapeHtml(x.term)}</td>
      <td>${escapeHtml(x.schedule)}</td>
      <td>${escapeHtml(x.branch)}</td>
      <td>${escapeHtml(x.room)}</td>
      <td class="nowrap">${x.layout ? `${x.layout.rows}×${x.layout.cols}，${x.layout.seats.length} 位${x.layout.aisles.length ? `<div class="muted small">走道：${x.layout.aisles.join(', ')}</div>` : ''}${x.layout.from ? `<div class="muted small">${escapeHtml(x.layout.from)}</div>` : ''}` : ''}</td>
      <td>${x.status === 'ok'
        ? `<span class="status ok">將建立</span>${x.note ? `<div class="warn small">${escapeHtml(x.note)}</div>` : ''}`
        : `<span class="status off">${escapeHtml(x.note)}</span>`}</td>
    </tr>`).join('');

  $('b-status').innerHTML = `共 ${batchPlan.length} 列，將建立 <b>${okCount}</b> 個班級。`;
  $('b-submit').disabled = !okCount;
  $('b-preview').classList.remove('hidden');
}

async function runBatch() {
  const items = batchPlan.filter((x) => x.status === 'ok');
  if (!items.length) return toast('沒有可以建立的班級', 'error');
  if (!confirm(`確定建立 ${items.length} 個班級？\n（建立後都是「未開放」，加好學生名單再開放劃位）`)) return;
  const btn = $('b-submit');
  btn.disabled = true;
  btn.textContent = '建立中…';
  try {
    await commitInChunks(items.map((x) => (b) => {
      const { rows, cols, aisles, disabled, seats } = x.layout;
      b.set(doc(collection(db, 'classes')), {
        title: x.title, term: x.term, schedule: x.schedule, branch: x.branch, room: x.room, note: '',
        rows, cols, aisles, disabled, seats, open: false,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    }));
    toast(`已建立 ${items.length} 個班級，接著可以用「整份名冊匯入」加入學生`, 'success');
    $('b-text').value = '';
    show('view-list');
  } catch (err) {
    console.error(err);
    toast('建立失敗：' + (err.code || err.message) + '。可以再按一次，已建立的會自動略過。', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '確認建立';
  }
}

// ---------- 教室座位範本 ----------
$('btn-rooms').addEventListener('click', openRooms);
$('btn-new-room').addEventListener('click', () => openRoomEditor(null, false));
document.querySelectorAll('.js-back-rooms').forEach((b) => b.addEventListener('click', openRooms));
$('r-branch-filter').addEventListener('change', renderRooms);
['r-rows', 'r-cols', 'r-aisles'].forEach((id) => $(id).addEventListener('input', renderRoomPreview));

function openRooms() {
  if (!$('r-branch-filter').options.length) {
    $('r-branch-filter').innerHTML = ['<option value="">全部分校</option>']
      .concat(BRANCHES.map((b) => `<option>${escapeHtml(b)}</option>`)).join('');
    $('r-branch-filter').value = $('f-branch').value;
  }
  renderRooms();
  show('view-rooms');
}

function renderRooms() {
  const branch = $('r-branch-filter').value;
  const list = state.rooms.filter((r) => !branch || r.branch === branch);
  const box = $('room-list');
  if (!list.length) {
    box.innerHTML = `<p class="muted">${state.rooms.length ? '這個分校還沒有教室範本。' : '還沒有教室範本，按「新增教室」開始。'}</p>`;
    return;
  }
  box.innerHTML = list.map((r) => {
    const used = state.classes.filter((c) => c.branch === r.branch && normTitle(c.room) === normTitle(r.name)).length;
    return `
    <div class="card admin-card">
      <div class="card-main">
        <div class="card-title">${escapeHtml(r.name)} <span class="muted small">${escapeHtml(r.branch || '')}</span></div>
        <div class="small">${r.rows} 排 × ${r.cols} 位・共 ${r.seats?.length || 0} 個座位${r.aisles?.length ? `・走道 ${r.aisles.join(', ')}` : ''}</div>
        <div class="muted small">${used ? `目前有 ${used} 個班級在這間教室上課` : '還沒有班級使用'}</div>
      </div>
      <div class="btn-group">
        <button type="button" class="btn small" data-ract="edit" data-id="${r.id}">編輯</button>
        <button type="button" class="btn small" data-ract="dup" data-id="${r.id}">複製</button>
        <button type="button" class="btn small danger" data-ract="del" data-id="${r.id}">刪除</button>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-ract]').forEach((b) => b.addEventListener('click', () => {
    const r = state.rooms.find((x) => x.id === b.dataset.id);
    if (!r) return;
    if (b.dataset.ract === 'edit') openRoomEditor(r, false);
    else if (b.dataset.ract === 'dup') openRoomEditor(r, true);
    else deleteRoom(r);
  }));
}

function openRoomEditor(r, duplicate) {
  state.editingRoomId = r && !duplicate ? r.id : null;
  $('room-editor-title').textContent = !r ? '新增教室' : duplicate ? '複製教室（另存為新教室）' : '編輯教室';
  $('r-branch').innerHTML = BRANCHES.map((b) => `<option>${escapeHtml(b)}</option>`).join('');
  $('r-branch').value = r?.branch || $('r-branch-filter').value || BRANCHES[0] || '';
  $('r-name').value = r ? r.name + (duplicate ? '（複製）' : '') : '';
  $('r-rows').value = r?.rows || 6;
  $('r-cols').value = r?.cols || 8;
  $('r-aisles').value = (r?.aisles || []).join(', ');
  state.roomDisabled = new Set(r?.disabled || []);
  renderRoomPreview();
  show('view-room-editor');
}

function readRoomLayout() {
  const rows = Math.min(26, Math.max(1, parseInt($('r-rows').value, 10) || 1));
  const cols = Math.min(30, Math.max(1, parseInt($('r-cols').value, 10) || 1));
  const aisles = parseNumberList($('r-aisles').value).filter((n) => n < cols);
  const all = new Set(buildSeatList(rows, cols));
  const disabled = [...state.roomDisabled].filter((id) => all.has(id));
  return { rows, cols, aisles, disabled, seats: buildSeatList(rows, cols, disabled) };
}

function renderRoomPreview() {
  const layout = readRoomLayout();
  renderSeatMap($('room-preview'), layout, (id) => (
    state.roomDisabled.has(id) ? { state: 'disabled', label: '' } : { state: 'available' }
  ), (id) => {
    if (state.roomDisabled.has(id)) state.roomDisabled.delete(id); else state.roomDisabled.add(id);
    renderRoomPreview();
  }, { allCells: true });
  $('room-count').textContent = `共 ${layout.seats.length} 個座位`;
}

$('room-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const layout = readRoomLayout();
  const name = $('r-name').value.trim();
  const branch = $('r-branch').value;
  if (!name) return toast('請填寫教室名稱', 'error');
  if (!layout.seats.length) return toast('至少要有一個座位', 'error');
  const dup = state.rooms.find((r) => r.id !== state.editingRoomId && r.branch === branch && normTitle(r.name) === normTitle(name));
  if (dup) return toast(`${branch} 已經有「${dup.name}」了`, 'error');
  const btn = $('r-submit');
  btn.disabled = true;
  try {
    const data = { branch, name, ...layout, updatedAt: serverTimestamp() };
    if (state.editingRoomId) await updateDoc(doc(db, 'rooms', state.editingRoomId), data);
    else await setDoc(doc(collection(db, 'rooms')), { ...data, createdAt: serverTimestamp() });
    toast('已儲存教室範本', 'success');
    openRooms();
  } catch (err) {
    console.error(err);
    toast(err.code === 'permission-denied'
      ? '儲存失敗：請到 Firebase 重新貼上最新的 firestore.rules（記得改管理員 email）並發布'
      : '儲存失敗：' + (err.code || err.message), 'error');
  } finally {
    btn.disabled = false;
  }
});

async function deleteRoom(r) {
  if (!confirm(`確定刪除教室範本「${r.branch} ${r.name}」？\n已經建好的班級不受影響。`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'rooms', r.id));
    await batch.commit();
    toast('已刪除教室範本', 'success');
  } catch (err) {
    console.error(err);
    toast('刪除失敗：' + (err.code || err.message), 'error');
  }
}

// ---------- 列印座位表 ----------
function printSeatChart({ view, withList, withPhone }) {
  const c = state.detail;
  if (!c) return;
  const teacher = view === 'teacher';
  const seatToKey = new Map([...state.holders].map(([k, h]) => [h.seatId, k]));
  const nameOf = (seatId) => {
    const k = seatToKey.get(seatId);
    return k && state.roster.get(k) ? state.roster.get(k).name : '';
  };
  const valid = new Set(c.seats || []);
  const aisles = new Set(c.aisles || []);
  const rowIdx = [...Array(c.rows).keys()];
  const colIdx = [...Array(c.cols).keys()].map((i) => i + 1);
  if (teacher) { rowIdx.reverse(); colIdx.reverse(); }
  const rowLabel = (i) => String.fromCharCode(65 + i);
  const seatW = Math.max(46, Math.min(110, Math.floor(1000 / (c.cols + aisles.size * 0.35))));

  let grid = '';
  rowIdx.forEach((r) => {
    grid += `<div class="row"><span class="rl">${rowLabel(r)}</span>`;
    colIdx.forEach((col, i) => {
      const id = rowLabel(r) + col;
      if (!valid.has(id)) grid += '<span class="seat none"></span>';
      else {
        const n = nameOf(id);
        grid += `<span class="seat ${n ? '' : 'empty'}"><small>${id}</small><b>${escapeHtml(n)}</b></span>`;
      }
      // 走道在「第 col 號座位右邊」；老師視角左右相反，所以走道出現在該座位的左邊
      const next = colIdx[i + 1];
      if (next !== undefined && (teacher ? aisles.has(next) : aisles.has(col))) grid += '<span class="aisle"></span>';
    });
    grid += `<span class="rl">${rowLabel(r)}</span></div>`;
  });
  const stage = '<div class="stage">講 台</div>';

  let list = '';
  if (withList) {
    const seated = [...state.roster]
      .map(([key, s]) => ({ ...s, seat: state.holders.get(key)?.seatId || '' }))
      .sort((a, b) => (!a.seat - !b.seat) || (a.seat && b.seat ? seatOrder(a.seat, b.seat) : a.name.localeCompare(b.name, 'zh-Hant')));
    list = `<h2>座位名單（${seated.length} 人）</h2><table><thead><tr><th>座位</th><th>姓名</th>${withPhone ? '<th>家長手機</th>' : ''}<th>簽到</th></tr></thead><tbody>`
      + seated.map((s) => `<tr><td>${s.seat || '<i>未劃位</i>'}</td><td>${escapeHtml(s.name)}</td>${withPhone ? `<td>${escapeHtml(s.phone)}</td>` : ''}<td></td></tr>`).join('')
      + '</tbody></table>';
  }

  const now = new Date();
  const printed = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>${escapeHtml(c.title)} 座位表</title>
<style>
@page { size: A4 landscape; margin: 10mm; }
* { box-sizing: border-box; }
body { font-family: "PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif; color: #111; margin: 0; padding: 16px; }
h1 { font-size: 20px; margin: 0 0 2px; }
.meta { color: #555; font-size: 13px; margin-bottom: 4px; }
.view { color: #555; font-size: 12px; margin-bottom: 12px; }
.chart { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.stage { width: 50%; text-align: center; border: 1.5px solid #333; border-radius: 4px; padding: 4px; letter-spacing: .4em; font-size: 13px; margin: 6px 0; }
.row { display: flex; gap: 4px; align-items: stretch; }
.rl { width: 16px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #666; }
.seat { width: ${seatW}px; min-height: 44px; border: 1.2px solid #333; border-radius: 5px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2px; overflow: hidden; }
.seat small { font-size: 9px; color: #777; line-height: 1; }
.seat b { font-size: ${seatW < 60 ? 11 : 14}px; font-weight: 600; line-height: 1.25; text-align: center; word-break: break-all; }
.seat.empty { border-style: dashed; border-color: #aaa; }
.seat.none { border: 0; }
.aisle { width: 14px; }
h2 { font-size: 15px; margin: 18px 0 6px; page-break-before: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; }
th { background: #eee; }
td:last-child { width: 80px; }
.list { columns: 1; }
@media print { .noprint { display: none; } }
.noprint { margin-bottom: 12px; }
.noprint button { font-size: 14px; padding: 6px 14px; }
</style></head><body>
<div class="noprint"><button onclick="window.print()">列印</button></div>
<h1>${escapeHtml(c.title)}　座位表</h1>
<div class="meta">${escapeHtml(classMeta(c))}</div>
<div class="view">${teacher ? '老師視角：從講台往台下看' : '學生視角：面向講台'}・列印日期 ${printed}・已劃位 ${state.holders.size} / 學生 ${state.roster.size} 人</div>
<div class="chart">${teacher ? '' : stage}${grid}${teacher ? stage : ''}</div>
${list}
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));<\/script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) return toast('瀏覽器擋住了新分頁，請允許這個網站開啟彈出式視窗後再試一次', 'error');
  w.document.open();
  w.document.write(html);
  w.document.close();
}
