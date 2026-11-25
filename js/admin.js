import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
  collection, doc, getDoc, getDocs, onSnapshot, setDoc, updateDoc, query, orderBy, limit,
  writeBatch, serverTimestamp, getCountFromServer, arrayUnion, arrayRemove
} from './firebase-sdk.js';
import {
  auth, db, configMissing, renderSeatMap, buildSeatList, parseNumberList,
  normalizeName, normalizePhone, isValidPhone, normalizeSerial, isValidSerial, studentKey, takeSeat, releaseSeat,
  escapeHtml, classSort, classMeta, seatOrder, toast,
  CLASS_TYPES, typeLabel, periodStatus, PERIOD_LABEL, todayStr, dateRange
} from './common.js';
import { ADMIN_EMAILS, BRANCHES } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-login', 'view-denied', 'view-list', 'view-editor', 'view-detail', 'view-import', 'view-batch', 'view-rooms', 'view-room-editor', 'view-logs', 'view-admins', 'view-students', 'view-student-editor', 'view-profile-import'];
const STATUS_LABEL = { active: '在學', paused: '暫停', left: '退班' };
const GRADES = ['小一', '小二', '小三', '小四', '小五', '小六', '國一', '國二', '國三', '高一', '高二', '高三', '其他'];
const ROLE_LABEL = { owner: '最高管理者', manager: '主管', staff: '櫃台' };

const state = {
  classes: [],
  listUnsub: null,
  detailUnsubs: [],
  cid: null,                 // 目前管理中的班級
  detail: null,
  roster: new Map(),         // key -> { name, serial, phone }
  holders: new Map(),        // key -> { bid, seatId }
  seats: new Map(),          // seatId -> { bid }
  editingId: null,           // null = 新增
  dupFrom: null,             // 複製來源班級 ID
  disabled: new Set(),
  assignSeat: null,
  me: null,                  // { email, name, role }
  profiles: new Map(),       // 學生資料：serial -> profile
  profilesLoaded: false,
  editingSerial: null,       // 編輯中的學生（null = 新增）
  editSel: new Set(),        // 編輯中勾選的班級
  editOrig: new Set(),
  editSeats: new Map(),      // cid -> 座位代號
  adminsUnsub: null,
  logLimit: 200,
  logs: [],
  rooms: [],                 // 教室座位範本
  roomsUnsub: null,
  editingRoomId: null,
  roomDisabled: new Set(),
  rosters: null,             // 整份匯入用：cid -> Map(key -> { name, serial, phone })
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
    resolveRole(user).then((me) => {
      state.me = me;
      document.body.dataset.role = me ? me.role : '';
      $('user-role').textContent = me ? ROLE_LABEL[me.role] : '';
      if (!me) {
        $('denied-email').textContent = user.email;
        stopListening();
        show('view-denied');
        return;
      }
      startListening();
      show('view-list');
    });
  });
}

// 判斷角色：firebase-config.js 的 ADMIN_EMAILS 是最高管理者（要和安全規則一致），其他人看「管理員帳號」名單
async function resolveRole(user) {
  const email = String(user.email || '').toLowerCase();
  if (ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(email)) return { email, name: user.displayName || email, role: 'owner' };
  try {
    const snap = await getDoc(doc(db, 'admins', email));
    if (snap.exists() && ['manager', 'staff'].includes(snap.data().role)) {
      return { email, name: snap.data().name || user.displayName || email, role: snap.data().role };
    }
  } catch (err) {
    console.warn(err);
  }
  return null;
}

const can = (need) => state.me && (need === 'staff' || (need === 'manager' && state.me.role !== 'staff') || (need === 'owner' && state.me.role === 'owner'));

function denyMsg(err) {
  return err && err.code === 'permission-denied' ? '你的帳號沒有這個權限（或安全規則還沒更新）' : '';
}

// 寫入操作紀錄（失敗不影響原本的操作）
async function log(action, summary, c) {
  if (!state.me) return;
  try {
    await setDoc(doc(collection(db, 'logs')), {
      at: serverTimestamp(), by: state.me.email, byName: state.me.name, role: state.me.role,
      action, summary: String(summary).slice(0, 2000), classId: c?.id || '', classTitle: c?.title || ''
    });
  } catch (err) {
    console.warn('寫入操作紀錄失敗', err);
  }
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
$('f-type').innerHTML = ['<option value="">全部類型</option>']
  .concat(CLASS_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`)).join('');
['f-branch', 'f-type', 'f-period', 'f-archived'].forEach((id) => $(id).addEventListener('change', renderList));
$('btn-archive-ended').addEventListener('click', archiveEnded);

// 日期文字 → YYYY-MM-DD（無效回傳 null，空白回傳 ''）
function parseDateText(t) {
  const x = String(t || '').trim();
  if (!x) return '';
  const m = x.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) || d.getDate() !== Number(m[3]) ? null : iso;
}

const periodPill = (c) => {
  const st = periodStatus(c);
  return `<span class="period ${st}">${PERIOD_LABEL[st]}</span>`;
};
const dateRangeText = (c) => dateRange(c) || '';
const typeTag = (c) => `<span class="type-tag ${escapeHtml(c.type || 'regular')}">${escapeHtml(typeLabel(c.type))}</span>`;

const countCache = new Map();   // cid -> { r, h }，班級資料有變動時清掉
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
    countCache.clear();
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
  if (state.adminsUnsub) state.adminsUnsub();
  state.adminsUnsub = null;
  stopDetail();
}

function renderList() {
  const box = $('admin-class-list');
  const branch = $('f-branch').value;
  const type = $('f-type').value;
  const period = $('f-period').value;
  const showArchived = $('f-archived').checked;
  const base = state.classes.filter((c) => (!branch || c.branch === branch) && (!type || (c.type || 'regular') === type));
  const list = base.filter((c) => {
    const st = periodStatus(c);
    // 已封存的班級只有勾「顯示已封存」才列出；期間篩選看它原本的狀態
    if (st === 'archived') return showArchived && (!period || periodStatus({ ...c, archived: false }) === period);
    return !period || st === period;
  });
  const endedCount = base.filter((c) => periodStatus(c) === 'ended').length;
  $('btn-archive-ended').classList.toggle('hidden', !endedCount);
  $('btn-archive-ended').textContent = `封存已結束的課程（${endedCount}）`;
  const archivedCount = base.filter((c) => c.archived).length;
  $('f-count').textContent = `共 ${list.length} 班${!showArchived && archivedCount ? `（另有 ${archivedCount} 班已封存）` : ''}`;
  if (!list.length) {
    box.innerHTML = state.classes.length
      ? '<p class="muted">沒有符合條件的班級。</p>'
      : '<p class="muted">還沒有班級，按右上角「新增班級」開始。</p>';
    return;
  }
  box.innerHTML = list.map((c) => `
    <div class="card admin-card ${c.archived ? 'is-archived' : ''}">
      <div class="card-main">
        <div class="card-title">
          ${typeTag(c)}${escapeHtml(c.title)}
          ${periodPill(c)}
          ${c.archived ? '' : `<span class="badge ${c.open ? 'on' : 'off'}">${c.open ? '開放劃位中' : '未開放'}</span>`}
        </div>
        <div class="muted small">${escapeHtml(classMeta(c))}</div>
        <div class="small">學生 <b class="cnt-roster" data-cid="${c.id}">…</b> 人・已劃位 <b class="cnt-held" data-cid="${c.id}">…</b>・座位 ${c.seats?.length || 0}</div>
      </div>
      <div class="btn-group">
        <button type="button" class="btn small primary" data-act="detail" data-id="${c.id}">管理名單／座位</button>
        ${c.archived ? '' : `<button type="button" class="btn small" data-act="toggle" data-id="${c.id}" data-min="manager">${c.open ? '關閉劃位' : '開放劃位'}</button>`}
        <button type="button" class="btn small" data-act="archive" data-id="${c.id}" data-min="manager">${c.archived ? '取消封存' : '封存'}</button>
        <button type="button" class="btn small" data-act="edit" data-id="${c.id}" data-min="manager">編輯</button>
        <button type="button" class="btn small" data-act="dup" data-id="${c.id}" data-min="manager">複製</button>
        <button type="button" class="btn small danger" data-act="del" data-id="${c.id}" data-min="manager">刪除</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
    const c = state.classes.find((x) => x.id === b.dataset.id);
    if (!c) return;
    ({ detail: (x) => openDetail(x.id), toggle: toggleOpen, edit: (x) => openEditor(x, false),
       dup: (x) => openEditor(x, true), del: deleteClass, archive: (x) => setArchived(x, !x.archived) })[b.dataset.act](c);
  }));

  list.forEach(async (c) => {
    try {
      // 篩選切換時不重複計數，省讀取次數
      if (!countCache.has(c.id)) {
        const [r, h] = await Promise.all([
          getCountFromServer(collection(db, 'classes', c.id, 'roster')),
          getCountFromServer(collection(db, 'classes', c.id, 'holders'))
        ]);
        countCache.set(c.id, { r: r.data().count, h: h.data().count });
      }
      const n = countCache.get(c.id);
      const er = box.querySelector(`.cnt-roster[data-cid="${c.id}"]`);
      const eh = box.querySelector(`.cnt-held[data-cid="${c.id}"]`);
      if (er) er.textContent = n.r;
      if (eh) eh.textContent = n.h;
    } catch (e) { console.warn(e); }
  });
}

async function toggleOpen(c) {
  if (c.archived && !c.open) return toast('這個班級已封存，請先取消封存再開放劃位', 'error');
  try {
    await updateDoc(doc(db, 'classes', c.id), { open: !c.open, updatedAt: serverTimestamp() });
    toast(c.open ? '已關閉劃位' : '已開放劃位', 'success');
    log(c.open ? '關閉劃位' : '開放劃位', `${c.open ? '關閉' : '開放'}「${c.title}」的劃位`, c);
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '更新失敗：' + err.code, 'error');
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

async function setArchived(c, flag) {
  if (flag && !confirm(`封存「${c.title}」？\n封存後會關閉劃位，家長端不再顯示；班級、名單、座位紀錄都會保留，之後可以取消封存。`)) return;
  try {
    await updateDoc(doc(db, 'classes', c.id), flag ? { archived: true, open: false, updatedAt: serverTimestamp() } : { archived: false, updatedAt: serverTimestamp() });
    toast(flag ? '已封存' : '已取消封存', 'success');
    log(flag ? '封存班級' : '取消封存', `${flag ? '封存' : '取消封存'}「${c.title}」`, c);
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '更新失敗：' + err.code, 'error');
  }
}

async function archiveEnded() {
  const branch = $('f-branch').value;
  const type = $('f-type').value;
  const list = state.classes.filter((c) => periodStatus(c) === 'ended' && (!branch || c.branch === branch) && (!type || (c.type || 'regular') === type));
  if (!list.length) return toast('沒有已結束的課程', 'error');
  if (!confirm(`封存以下 ${list.length} 個已結束的課程？\n${list.slice(0, 15).map((c) => `・${c.title}（${classMeta(c)}）`).join('\n')}${list.length > 15 ? '\n…' : ''}\n\n班級、名單、座位紀錄都會保留，之後可以取消封存。`)) return;
  try {
    await commitInChunks(list.map((c) => (b) => b.update(doc(db, 'classes', c.id), { archived: true, open: false, updatedAt: serverTimestamp() })));
    toast(`已封存 ${list.length} 個課程`, 'success');
    log('封存班級', `一次封存 ${list.length} 個已結束的課程：${list.map((c) => c.title).join('、')}`);
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '封存失敗：' + err.code, 'error');
  }
}

async function deleteClass(c) {
  if (!confirm(`確定要刪除「${c.title}」？\n學生名單和所有座位都會一起刪除，無法復原。`)) return;
  try {
    const roster = await getDocs(collection(db, 'classes', c.id, 'roster'));
    const ops = roster.docs.map((d) => (b) => b.set(doc(db, 'students', d.id), { classes: arrayRemove(c.id) }, { merge: true }));
    roster.docs.forEach((d) => ops.push(...profileRemoveClassOp(d.data().serial, c.id)));
    for (const sub of ['seats', 'bookings', 'holders', 'roster']) {
      const snap = sub === 'roster' ? roster : await getDocs(collection(db, 'classes', c.id, sub));
      snap.docs.forEach((d) => ops.push((b) => b.delete(d.ref)));
    }
    ops.push((b) => b.delete(doc(db, 'classes', c.id)));
    await commitInChunks(ops);
    toast('已刪除班級', 'success');
    log('刪除班級', `刪除「${c.title}」（${classMeta(c)}），名單 ${roster.docs.length} 人`, c);
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
  $('e-type').innerHTML = CLASS_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');
  $('e-type').value = c?.type || $('f-type').value || 'regular';
  // 複製班級（例如下一期）時不帶日期，避免沿用舊的期間
  $('e-start').value = c && !duplicate ? (c.startDate || '') : '';
  $('e-end').value = c && !duplicate ? (c.endDate || '') : '';
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
    type: $('e-type').value || 'regular',
    startDate: $('e-start').value || '',
    endDate: $('e-end').value || '',
    branch: $('e-branch').value,
    room: $('e-room').value.trim(),
    note: $('e-note').value.trim(),
    ...layout,
    open: $('e-open').checked,
    updatedAt: serverTimestamp()
  };
  if (!data.title) return toast('請填寫班級名稱', 'error');
  if (data.startDate && data.endDate && data.endDate < data.startDate) return toast('結束日期不能早於開始日期', 'error');
  if (data.open && data.endDate && todayStr() > data.endDate && !confirm('結束日期已經過了，家長端不會顯示這個班級。確定要儲存嗎？')) return;

  const btn = $('e-submit');
  btn.disabled = true;
  try {
    if (state.editingId) {
      const cur = state.classes.find((x) => x.id === state.editingId);
      if (cur?.archived && data.open) { toast('這個班級已封存，請先取消封存再開放劃位', 'error'); return; }
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
      log('編輯班級', `編輯「${data.title}」：${classMeta(data)}，座位 ${data.rows}×${data.cols}（${data.seats.length} 位），${data.open ? '開放' : '未開放'}劃位`, { id: state.editingId, title: data.title });
      show('view-list');
    } else {
      const ref = doc(collection(db, 'classes'));
      await setDoc(ref, { ...data, archived: false, createdAt: serverTimestamp() });
      // 複製班級時，可選擇一起複製學生名單（例如下學期續班）
      let copied = 0;
      if (state.dupFrom && confirm('要一起複製原班級的學生名單嗎？\n（只複製名單，不複製座位）')) {
        const roster = await getDocs(collection(db, 'classes', state.dupFrom, 'roster'));
        const docs = roster.docs.filter((d) => d.data().serial);
        await commitInChunks(docs.flatMap((d) => addStudentOps(ref.id, d.data().name, d.data().serial, d.data().phone)));
        copied = docs.length;
      }
      toast('已建立班級，接著加入學生名單', 'success');
      const from = state.dupFrom && state.classes.find((x) => x.id === state.dupFrom);
      log('新增班級', `新增「${data.title}」：${classMeta(data)}，座位 ${data.seats.length} 位${from ? `（複製自「${from.title}」${copied ? `，含名單 ${copied} 人` : ''}）` : ''}`, { id: ref.id, title: data.title });
      openDetail(ref.id);
    }
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '儲存失敗：' + err.code, 'error');
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
  $('d-title').innerHTML = `${typeTag(c)}${escapeHtml(c.title)} ${periodPill(c)}`;
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
    return { state: 'taken', label: s ? s.name.slice(0, 3) : '?', title: s ? `${id} ${s.name} ${s.serial || ''} ${s.phone || ''}` : `${id}（無對應學生）` };
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
      <td>${r.serial ? `<button type="button" class="name-link" data-profile="${escapeHtml(r.serial)}" title="打開學生資料">${escapeHtml(r.name)}</button>` : escapeHtml(r.name)}</td>
      <td>${r.serial ? escapeHtml(r.serial) : '<span class="warn small">舊資料，請重新匯入</span>'}</td>
      <td>${escapeHtml(r.phone || '')}</td>
      <td>${r.holder ? `<span class="seat-tag">${escapeHtml(r.holder.seatId)}</span>` : '<span class="status todo">未劃位</span>'}</td>
      <td class="nowrap">
        ${r.holder ? `<button type="button" class="btn small" data-cancel="${escapeHtml(r.key)}">取消座位</button>` : ''}
        <button type="button" class="btn small danger" data-remove="${escapeHtml(r.key)}" data-min="manager">移出</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="5" class="muted center">${total ? '全部學生都劃好位了 🎉' : '還沒有學生，請在右邊加入名單'}</td></tr>`;

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
    log('取消座位', `取消 ${s ? s.name : key} 的座位 ${h.seatId}`, state.detail);
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
    log('釋放座位', `釋放沒有對應學生的座位 ${seatId}`, state.detail);
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
    profileRemoveClassOp(s.serial, state.cid).forEach((fn) => fn(batch));
    await batch.commit();
    state.profilesLoaded = false;
    toast(`已移出 ${s.name}`, 'success');
    log('移出學生', `把 ${s.name}（${s.serial || '無序號'}）移出班級${h ? `，釋放座位 ${h.seatId}` : ''}`, state.detail);
  } catch (err) {
    console.error(err);
    toast('移出失敗：' + err.code, 'error');
  }
}

// ---------- 加入學生 ----------
// 把一列拆成欄位：有 Tab 用 Tab（保留空欄位，從試算表複製時位置才不會跑掉），否則用逗號，再不然用空白
function splitFields(line) {
  if (line.includes('\t')) return line.split('\t').map((f) => f.trim());
  if (/[,，]/.test(line)) return line.split(/[,，]/).map((f) => f.trim());
  // 用空白分隔時，姓名中間可能也有空白（例如「林 小 華 A115004」）：第一個含數字的詞當作繳費序號
  const t = line.trim().split(/\s+/);
  const i = t.findIndex((x) => /\d/.test(x));
  return i > 0 ? [t.slice(0, i).join(''), t[i], ...t.slice(i + 1)] : t;
}

const isHeaderRow = (fields) => fields.some((f) => /^(學生)?姓名$|^繳費序號$|^序號$/.test(f));

// 解析一位學生：姓名、繳費序號、家長手機（手機可空白）
function parseStudentFields(name0, serial0, phone0) {
  const name = normalizeName(name0);
  const serial = normalizeSerial(serial0);
  let phone = normalizePhone(phone0);
  let phoneNote = '';
  if (/^9\d{8}$/.test(phone)) phone = '0' + phone;               // 試算表吃掉開頭 0 的情況
  if (phone && !isValidPhone(phone)) { phoneNote = `手機「${phone0}」格式不對，已略過`; phone = ''; }
  if (!name || name.length > 20 || /\d/.test(name)) return { error: '姓名空白或格式不對' };
  if (!isValidSerial(serial)) return { error: '繳費序號空白或格式不對（只能有英文字母、數字、-，3～30 字）' };
  if (/^09\d{8}$/.test(serial)) phoneNote = [phoneNote, `繳費序號「${serial}」看起來像手機號碼，請確認第二欄是繳費序號`].filter(Boolean).join('；');
  return { name, serial, phone, phoneNote, key: studentKey(name, serial) };
}

// 同一個繳費序號對到不同姓名（多半是打錯字）
function serialConflicts(students, existing = []) {
  const names = new Map();
  [...existing, ...students].forEach((x) => {
    if (!x.serial) return;
    if (!names.has(x.serial)) names.set(x.serial, new Set());
    names.get(x.serial).add(x.name);
  });
  return [...names].filter(([, set]) => set.size > 1).map(([serial, set]) => `${serial}：${[...set].join('、')}`);
}

function parseRoster(text) {
  const ok = [];
  const bad = [];
  const notes = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((line) => {
    const raw = line.trim();
    if (!raw) return;
    const f = splitFields(line);
    if (isHeaderRow(f)) return;
    const r = parseStudentFields(f[0], f[1], f[2]);
    if (r.error) { bad.push(`${raw}（${r.error}）`); return; }
    if (r.phoneNote) notes.push(`${r.name}：${r.phoneNote}`);
    if (seen.has(r.key)) return;
    seen.add(r.key);
    ok.push(r);
  });
  return { ok, bad, notes };
}

function updateImportPreview() {
  const { ok, bad, notes } = parseRoster($('d-import').value);
  const fresh = ok.filter((s) => !state.roster.has(s.key));
  const dup = ok.length - fresh.length;
  const conflicts = serialConflicts(ok, [...state.roster.values()]);
  const parts = [];
  if (fresh.length) parts.push(`將加入 <b>${fresh.length}</b> 位`);
  if (dup) parts.push(`${dup} 位已在名單中（略過）`);
  if (bad.length) parts.push(`<span class="warn">無法辨識 ${bad.length} 行：${bad.slice(0, 3).map(escapeHtml).join('／')}${bad.length > 3 ? '…' : ''}</span>`);
  if (conflicts.length) parts.push(`<span class="warn">⚠️ 同一個繳費序號對到不同姓名，只會加入第一個（或名單上原本的）姓名，請確認是否打錯字：${conflicts.map(escapeHtml).join('／')}</span>`);
  if (notes.length) parts.push(`<span class="warn">${notes.map(escapeHtml).join('／')}</span>`);
  $('d-import-preview').innerHTML = parts.join('<br>');
  return fresh;
}

$('d-import').addEventListener('input', updateImportPreview);

function addStudentOps(cid, name, serial, phone = '') {
  const key = studentKey(name, serial);
  const profile = { serial, name, classes: arrayUnion(cid), updatedAt: serverTimestamp() };
  if (phone) profile.phone = phone;
  return [
    // 家長手機只存在名單和學生資料（只有管理員看得到），不放進公開的學生索引
    (b) => b.set(doc(db, 'classes', cid, 'roster', key), { name, serial, phone: phone || '', addedAt: serverTimestamp() }),
    (b) => b.set(doc(db, 'students', key), { name, serial, classes: arrayUnion(cid) }, { merge: true }),
    (b) => b.set(doc(db, 'profiles', serial), profile, { merge: true })
  ];
}

// 從班級移出時，同步學生資料上的班級清單
function profileRemoveClassOp(serial, cid) {
  return serial ? [(b) => b.set(doc(db, 'profiles', serial), { serial, classes: arrayRemove(cid), updatedAt: serverTimestamp() }, { merge: true })] : [];
}

// 一次讀取多個繳費序號的學生資料（只讀需要的，不讀全部）
async function fetchProfiles(serials) {
  const uniq = [...new Set(serials.filter(Boolean))];
  const snaps = await Promise.all(uniq.map((sn) => getDoc(doc(db, 'profiles', sn))));
  const m = new Map();
  snaps.forEach((snap, i) => { if (snap.exists()) m.set(uniq[i], snap.data()); });
  return m;
}

$('d-import-btn').addEventListener('click', async () => {
  let fresh = updateImportPreview();
  if (!fresh.length) return toast('沒有可以加入的學生', 'error');
  const btn = $('d-import-btn');
  btn.disabled = true;
  try {
    // 繳費序號已經屬於另一個姓名的學生 → 不加入
    const profs = await fetchProfiles(fresh.map((x) => x.serial));
    // 同一次貼上裡，同一個序號出現不同姓名：以第一筆為準
    fresh.forEach((x) => { if (!profs.has(x.serial)) profs.set(x.serial, { name: x.name }); });
    const blocked = fresh.filter((x) => profs.get(x.serial).name !== x.name);
    fresh = fresh.filter((x) => !blocked.includes(x));
    if (blocked.length) {
      alert(`以下 ${blocked.length} 位沒有加入，因為繳費序號已經屬於別的學生：\n${blocked.map((x) => `${x.name}（${x.serial} 是「${profs.get(x.serial).name}」的序號）`).join('\n')}`);
    }
    if (!fresh.length) return;
    await commitInChunks(fresh.flatMap((s) => addStudentOps(state.cid, s.name, s.serial, s.phone)));
    state.profilesLoaded = false;
    toast(`已加入 ${fresh.length} 位學生`, 'success');
    log('加入學生', `加入 ${fresh.length} 位：${fresh.map((x) => `${x.name}(${x.serial})`).join('、')}`, state.detail);
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
    if (!s.serial) return toast('這是舊格式的資料（沒有繳費序號），請先用新名冊重新匯入', 'error');
    const before = state.holders.get(key)?.seatId;
    await takeSeat(state.cid, { key, name: s.name, serial: s.serial }, seatId);
    toast(`已把 ${s.name} 排到 ${seatId}`, 'success');
    log(before ? '代為換位' : '代為劃位', before ? `把 ${s.name} 從 ${before} 換到 ${seatId}` : `幫 ${s.name} 劃位 ${seatId}`, state.detail);
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
  const text = (v) => (v ? `="${String(v).replace(/"/g, '')}"` : '');   // 用 ="..." 格式，避免試算表吃掉開頭的 0
  const lines = [['座位', '姓名', '繳費序號', '家長手機'].map(cell).join(',')]
    .concat(rows.map((r) => [cell(r.seat || '未劃位'), cell(r.name), text(r.serial), text(r.phone)].join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${c.term ? c.term + '_' : ''}${c.title}_座位表.csv`.replace(/[\\/:*?"<>|]/g, '_');
  log('匯出名單', `匯出「${c.title}」座位表 CSV（${rows.length} 人）`, c);
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
  await Promise.all([loadAllRosters(), loadProfiles()]);
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
  return state.classes.filter((c) => !c.archived && (!term || c.term === term) && (!branch || c.branch === branch));
}

// 解析貼上的名冊：每列 學生姓名、繳費序號、家長手機、班級（手機可空白；班級可用「、」分隔多個）
function parseBulk(text) {
  const rows = [];
  const bad = [];
  const notes = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const raw = line.trim();
    if (!raw) return;
    const useTab = line.includes('\t');
    const f = useTab ? line.split('\t').map((x) => x.trim()) : line.split(/[,，]/).map((x) => x.trim());
    if (isHeaderRow(f)) return;   // 標題列
    const r = parseStudentFields(f[0], f[1], f[2]);
    if (r.error) { bad.push(`${raw.replace(/\t/g, ' ')}（${r.error}）`); return; }
    const classNames = f.slice(3).join('、').split(useTab ? /[、;；\/,，]/ : /[、;；\/]/)
      .map((t) => t.trim()).filter(Boolean);
    if (!classNames.length) { bad.push(`${raw.replace(/\t/g, ' ')}（沒有填班級）`); return; }
    if (r.phoneNote) notes.push(`${r.name}：${r.phoneNote}`);
    rows.push({ ...r, classNames });
  });
  return { rows, bad, notes };
}

function analyzeImport() {
  if (!state.rosters) return;
  const parsed = parseBulk($('i-text').value);
  const { bad, notes } = parsed;
  // 繳費序號已經屬於另一個姓名的學生 → 不匯入
  const firstName = new Map();
  const rows = parsed.rows.filter((r) => {
    const p = state.profiles.get(r.serial);
    if (p && p.name !== r.name) { bad.push(`${r.name} ${r.serial}（這個序號已經是「${p.name}」的）`); return false; }
    if (!firstName.has(r.serial)) firstName.set(r.serial, r.name);
    if (firstName.get(r.serial) !== r.name) { bad.push(`${r.name} ${r.serial}（名冊裡同一個序號前面寫的是「${firstName.get(r.serial)}」）`); return false; }
    return true;
  });
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
  const sheet = new Map();       // cid -> Map(key -> { name, serial, phone })
  rows.forEach((r) => r.classNames.forEach((title) => {
    const matches = byTitle.get(normTitle(title)) || [];
    if (!matches.length) unknown.set(title, (unknown.get(title) || 0) + 1);
    else if (matches.length > 1) ambiguous.set(title, matches);
    else {
      const cid = matches[0].id;
      if (!sheet.has(cid)) sheet.set(cid, new Map());
      sheet.get(cid).set(r.key, { name: r.name, serial: r.serial, phone: r.phone });
    }
  }));

  const plan = [...sheet].map(([cid, students]) => {
    const c = state.classes.find((x) => x.id === cid);
    const roster = state.rosters.get(cid) || new Map();
    const adds = [...students].filter(([k]) => !roster.has(k)).map(([key, s]) => ({ key, ...s }));
    const existing = [...students.keys()].filter((k) => roster.has(k)).length;
    // 已在名單、但名冊上的家長手機不一樣（或補填了）→ 更新手機
    const phoneUpdates = [...students].filter(([k, s]) => roster.has(k) && s.phone && s.phone !== (roster.get(k).phone || ''))
      .map(([key, s]) => ({ key, ...s }));
    const missing = [...roster].filter(([k]) => !students.has(k)).map(([key, s]) => ({ key, ...s }));
    return { cid, c, total: students.size, adds, existing, phoneUpdates, missing };
  }).sort((a, b) => classSort(a.c, b.c));
  state.plan = plan;

  // 問題列表
  const problems = [];
  if (bad.length) problems.push(`<li>無法辨識 ${bad.length} 列：${bad.slice(0, 5).map(escapeHtml).join('／')}${bad.length > 5 ? '…' : ''}</li>`);
  unknown.forEach((n, title) => problems.push(`<li>找不到班級「${escapeHtml(title)}」（${n} 筆）：請確認名稱和後台一樣，或檢查上面選的學期／分校</li>`));
  ambiguous.forEach((list, title) => problems.push(`<li>「${escapeHtml(title)}」對應到 ${list.length} 個班（${list.map((c) => escapeHtml(classMeta(c) || c.title)).join('；')}），請先選學期或分校</li>`));
  const allExisting = [...state.rosters.values()].flatMap((m) => [...m.values()]);
  const conflicts = serialConflicts(rows, allExisting);
  const warns = [];
  if (conflicts.length) warns.push(`<li>同一個繳費序號對到不同姓名，請確認是否打錯字（打錯的話，系統會當成兩位不同的學生）：${conflicts.map(escapeHtml).join('／')}</li>`);
  notes.forEach((n) => warns.push(`<li>${escapeHtml(n)}</li>`));
  $('i-problems').innerHTML = (problems.length
    ? `<div class="notice error"><b>這些資料不會匯入：</b><ul class="tight">${problems.join('')}</ul></div>` : '')
    + (warns.length ? `<div class="notice warn-box"><b>請確認：</b><ul class="tight">${warns.join('')}</ul></div>` : '');

  $('i-rows').innerHTML = plan.length ? plan.map((p) => `
    <tr>
      <td><b>${escapeHtml(p.c.title)}</b><div class="muted small">${escapeHtml(classMeta(p.c))}</div></td>
      <td>${p.total}</td>
      <td>${p.adds.length ? `<b class="ok-text">+${p.adds.length}</b>` : '0'}</td>
      <td>${p.existing}${p.phoneUpdates.length ? `<div class="muted small">更新手機 ${p.phoneUpdates.length}</div>` : ''}</td>
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
  const updTotal = plan.reduce((n, p) => n + p.phoneUpdates.length, 0);
  $('i-status').innerHTML = `共 ${rows.length} 筆、對應到 ${plan.length} 個班，將新加入 <b>${addTotal}</b> 筆${updTotal ? `、更新 ${updTotal} 筆家長手機` : ''}。`;
  $('i-preview').classList.remove('hidden');
}

async function runImport() {
  const plan = state.plan || [];
  const doRemove = $('i-remove')?.checked;
  const addTotal = plan.reduce((n, p) => n + p.adds.length, 0);
  const updTotal = plan.reduce((n, p) => n + p.phoneUpdates.length, 0);
  const rmTotal = doRemove ? plan.reduce((n, p) => n + p.missing.length, 0) : 0;
  if (!addTotal && !rmTotal && !updTotal) return toast('沒有需要變動的資料', 'error');
  if (!confirm(`確定匯入？\n新加入 ${addTotal} 筆${updTotal ? `\n更新家長手機 ${updTotal} 筆` : ''}${rmTotal ? `\n移出 ${rmTotal} 筆（座位一起釋放）` : ''}`)) return;

  const btn = $('i-submit');
  btn.disabled = true;
  btn.textContent = '匯入中…';
  try {
    const ops = [];
    for (const p of plan) {
      p.adds.forEach((s) => ops.push(...addStudentOps(p.cid, s.name, s.serial, s.phone)));
      p.phoneUpdates.forEach((s) => ops.push((b) => b.set(doc(db, 'classes', p.cid, 'roster', s.key), { phone: s.phone }, { merge: true })));
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
          ops.push(...profileRemoveClassOp(s.serial, p.cid));
        });
      }
    }
    await commitInChunks(ops);
    state.profilesLoaded = false;
    toast(`匯入完成：新加入 ${addTotal} 筆${updTotal ? `、更新手機 ${updTotal} 筆` : ''}${rmTotal ? `、移出 ${rmTotal} 筆` : ''}`, 'success');
    for (const p of plan) {
      const parts = [];
      if (p.adds.length) parts.push(`加入 ${p.adds.length} 位：${p.adds.map((x) => `${x.name}(${x.serial})`).join('、')}`);
      if (p.phoneUpdates.length) parts.push(`更新手機 ${p.phoneUpdates.length} 位：${p.phoneUpdates.map((x) => x.name).join('、')}`);
      if (doRemove && p.missing.length) parts.push(`移出 ${p.missing.length} 位：${p.missing.map((x) => x.name).join('、')}`);
      if (parts.length) await log('整份名冊匯入', parts.join('；'), p.c);
    }
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

// 把系統目前的名單匯出成「學生姓名、繳費序號、家長手機、班級」四欄，可以直接貼回名冊
async function exportAllRosters() {
  const classes = importCandidates();
  if (!classes.length) return toast('沒有符合的班級', 'error');
  if (!state.rosters) await loadAllRosters();
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [];
  classes.forEach((c) => (state.rosters.get(c.id) || new Map()).forEach((s) => rows.push([s.name, s.serial || '', s.phone || '', c.title])));
  rows.sort((a, b) => a[3].localeCompare(b[3], 'zh-Hant') || a[0].localeCompare(b[0], 'zh-Hant'));
  const text = (v) => (v ? `="${String(v).replace(/"/g, '')}"` : '');   // 用 ="..." 格式，避免試算表吃掉開頭的 0
  const lines = [['學生姓名', '繳費序號', '家長手機', '班級'].map(cell).join(',')]
    .concat(rows.map((r) => [cell(r[0]), text(r[1]), text(r[2]), cell(r[3])].join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const tag = [$('i-term').value, $('i-branch').value].filter(Boolean).join('_') || '全部';
  a.download = `學生名冊_${tag}.csv`.replace(/[\\/:*?"<>|]/g, '_');
  log('匯出名單', `匯出系統名冊 CSV（${tag}，${rows.length} 筆）`);
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
      rowsText: f[5] || '', colsText: f[6] || '', aislesText: f[7] || '',
      typeText: f[8] || '', startText: f[9] || '', endText: f[10] || ''
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
    const TYPE_FROM_TEXT = { '': 'regular', 常態班: 'regular', 常態: 'regular', 短期課程: 'short', 短期: 'short', 模擬考: 'exam', 模考: 'exam', 其他: 'other' };
    if (!(r.typeText in TYPE_FROM_TEXT)) { item.status = 'skip'; item.note = '類型只能填 常態班、短期課程、模擬考、其他'; return item; }
    item.type = TYPE_FROM_TEXT[r.typeText];
    item.startDate = parseDateText(r.startText);
    item.endDate = parseDateText(r.endText);
    if (item.startDate === null || item.endDate === null) { item.status = 'skip'; item.note = '日期格式不對（例：2027-01-20）'; return item; }
    if (item.startDate && item.endDate && item.endDate < item.startDate) { item.status = 'skip'; item.note = '結束日期早於開始日期'; return item; }
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
      <td><b>${escapeHtml(x.title || '（空白）')}</b>${x.status === 'ok' ? `<div class="small">${typeTag(x)}${escapeHtml(dateRangeText(x))}</div>` : ''}</td>
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
        type: x.type || 'regular', startDate: x.startDate || '', endDate: x.endDate || '', archived: false,
        rows, cols, aisles, disabled, seats, open: false,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    }));
    toast(`已建立 ${items.length} 個班級，接著可以用「整份名冊匯入」加入學生`, 'success');
    log('批次建立班級', `建立 ${items.length} 個班級：${items.map((x) => `${x.title}（${[x.term, x.branch, x.room].filter(Boolean).join('・')}）`).join('、')}`);
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
    log(state.editingRoomId ? '編輯教室範本' : '新增教室範本', `${branch} ${name}：${layout.rows}×${layout.cols}，${layout.seats.length} 位`);
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
    log('刪除教室範本', `${r.branch} ${r.name}`);
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
      + seated.map((s) => `<tr><td>${s.seat || '<i>未劃位</i>'}</td><td>${escapeHtml(s.name)}</td>${withPhone ? `<td>${escapeHtml(s.phone || '')}</td>` : ''}<td></td></tr>`).join('')
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
  log('列印座位表', `列印「${c.title}」座位表（${teacher ? '老師' : '學生'}視角${withList ? '，含名單' : ''}${withPhone ? '，含家長手機' : ''}）`, c);
}

// ---------- 操作紀錄 ----------
$('btn-logs').addEventListener('click', () => { state.logLimit = 200; openLogs(); });
$('l-more').addEventListener('click', () => { state.logLimit += 200; openLogs(); });
$('l-who').addEventListener('change', renderLogs);
$('l-q').addEventListener('input', renderLogs);
$('l-export').addEventListener('click', exportLogs);

async function openLogs() {
  if (!can('manager')) return;
  show('view-logs');
  $('l-rows').innerHTML = '<tr><td colspan="4" class="muted center">讀取中…</td></tr>';
  try {
    const snap = await getDocs(query(collection(db, 'logs'), orderBy('at', 'desc'), limit(state.logLimit)));
    state.logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    $('l-more').classList.toggle('hidden', state.logs.length < state.logLimit);
    const people = [...new Map(state.logs.map((x) => [x.by, x.byName || x.by])).entries()];
    const cur = $('l-who').value;
    $('l-who').innerHTML = ['<option value="">全部人員</option>']
      .concat(people.map(([email, name]) => `<option value="${escapeHtml(email)}">${escapeHtml(name)}${name !== email ? `（${escapeHtml(email)}）` : ''}</option>`)).join('');
    if (people.some(([e]) => e === cur)) $('l-who').value = cur;
    renderLogs();
  } catch (err) {
    console.error(err);
    $('l-rows').innerHTML = `<tr><td colspan="4" class="warn center">讀取失敗：${escapeHtml(denyMsg(err) || err.code || err.message)}</td></tr>`;
  }
}

function logTime(ts, full = false) {
  if (!ts?.toDate) return '';
  const d = ts.toDate();
  const p = (n) => String(n).padStart(2, '0');
  return `${full ? d.getFullYear() + '/' : ''}${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function filteredLogs() {
  const who = $('l-who').value;
  const q = $('l-q').value.trim().toLowerCase();
  return state.logs.filter((x) => (!who || x.by === who)
    && (!q || [x.action, x.summary, x.classTitle, x.byName, x.by].join(' ').toLowerCase().includes(q)));
}

function renderLogs() {
  const list = filteredLogs();
  $('l-rows').innerHTML = list.length ? list.map((x) => `
    <tr>
      <td class="small">${escapeHtml(logTime(x.at))}</td>
      <td>${escapeHtml(x.byName || x.by)}<div class="muted small">${escapeHtml(ROLE_LABEL[x.role] || '')}</div></td>
      <td class="nowrap">${escapeHtml(x.action)}</td>
      <td>${x.classTitle ? `<b>${escapeHtml(x.classTitle)}</b>　` : ''}${escapeHtml(x.summary)}</td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="muted center">沒有符合的紀錄</td></tr>';
}

function exportLogs() {
  const list = filteredLogs();
  if (!list.length) return toast('沒有可以匯出的紀錄', 'error');
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['時間', '人員', 'Gmail', '角色', '動作', '班級', '內容'].map(cell).join(',')]
    .concat(list.map((x) => [logTime(x.at, true), x.byName, x.by, ROLE_LABEL[x.role] || x.role, x.action, x.classTitle, x.summary].map(cell).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `操作紀錄_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 管理員帳號（只有最高管理者） ----------
let adminList = [];
$('btn-admins').addEventListener('click', openAdmins);

function openAdmins() {
  if (!can('owner')) return;
  show('view-admins');
  if (!state.adminsUnsub) {
    state.adminsUnsub = onSnapshot(collection(db, 'admins'), (snap) => {
      adminList = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.role === b.role ? String(a.name).localeCompare(String(b.name), 'zh-Hant') : a.role === 'manager' ? -1 : 1));
      renderAdmins();
    }, (err) => {
      console.error(err);
      $('a-rows').innerHTML = `<tr><td colspan="4" class="warn">讀取失敗：${escapeHtml(denyMsg(err) || err.code)}。請確認 Firebase 的安全規則已更新為最新版。</td></tr>`;
    });
  }
  renderAdmins();
}

function renderAdmins() {
  const owners = ADMIN_EMAILS.map((e) => `
    <tr><td>${e.toLowerCase() === state.me?.email ? escapeHtml(state.me.name) + '（你）' : '—'}</td><td>${escapeHtml(e)}</td>
      <td><span class="badge on">最高管理者</span></td><td class="muted small">寫在安全規則裡</td></tr>`).join('');
  const others = adminList.map((a) => `
    <tr>
      <td>${escapeHtml(a.name || '')}</td>
      <td>${escapeHtml(a.email || a.id)}</td>
      <td>
        <select class="inline-select" data-role-of="${escapeHtml(a.id)}">
          <option value="staff" ${a.role === 'staff' ? 'selected' : ''}>櫃台</option>
          <option value="manager" ${a.role === 'manager' ? 'selected' : ''}>主管</option>
        </select>
      </td>
      <td><button type="button" class="btn small danger" data-rm-admin="${escapeHtml(a.id)}">移除</button></td>
    </tr>`).join('');
  $('a-rows').innerHTML = owners + (others || '<tr><td colspan="4" class="muted center">還沒有其他管理員</td></tr>');
  $('a-rows').querySelectorAll('[data-role-of]').forEach((sel) => sel.addEventListener('change', () => changeAdminRole(sel.dataset.roleOf, sel.value)));
  $('a-rows').querySelectorAll('[data-rm-admin]').forEach((b) => b.addEventListener('click', () => removeAdmin(b.dataset.rmAdmin)));
}

$('admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('m-email').value.trim().toLowerCase();
  const name = $('m-name').value.trim();
  const role = $('m-role').value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Gmail 格式不正確', 'error');
  if (ADMIN_EMAILS.map((x) => x.toLowerCase()).includes(email)) return toast('這個帳號已經是最高管理者', 'error');
  const exist = adminList.find((a) => a.id === email);
  if (exist && !confirm(`${email} 已經是${ROLE_LABEL[exist.role]}，要改成「${name}／${ROLE_LABEL[role]}」嗎？`)) return;
  try {
    await setDoc(doc(db, 'admins', email), { email, name, role, addedAt: serverTimestamp(), addedBy: state.me.email });
    toast(`已新增 ${name}（${ROLE_LABEL[role]}）`, 'success');
    log(exist ? '修改管理員' : '新增管理員', `${name}（${email}）：${ROLE_LABEL[role]}`);
    $('m-email').value = '';
    $('m-name').value = '';
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '新增失敗：' + err.code, 'error');
  }
});

async function changeAdminRole(id, role) {
  const a = adminList.find((x) => x.id === id);
  if (!a || a.role === role) return;
  if (!confirm(`把 ${a.name || id} 改成「${ROLE_LABEL[role]}」？`)) { renderAdmins(); return; }
  try {
    await updateDoc(doc(db, 'admins', id), { role });
    toast('已更新角色', 'success');
    log('修改管理員', `${a.name || ''}（${id}）：${ROLE_LABEL[a.role]} → ${ROLE_LABEL[role]}`);
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '更新失敗：' + err.code, 'error');
    renderAdmins();
  }
}

async function removeAdmin(id) {
  const a = adminList.find((x) => x.id === id);
  if (!confirm(`確定移除 ${a?.name || id} 的後台權限？\n對方會立刻無法操作後台。`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'admins', id));
    await batch.commit();
    toast('已移除', 'success');
    log('移除管理員', `${a?.name || ''}（${id}，原為${ROLE_LABEL[a?.role] || ''}）`);
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '移除失敗：' + err.code, 'error');
  }
}

// ---------- 學生資料（總名單） ----------
const statusPill = (st) => `<span class="status-pill ${st || 'active'}">${STATUS_LABEL[st || 'active']}</span>`;
const fillSelect = (el, first, items, cur) => {
  el.innerHTML = (first !== null ? [`<option value="">${first}</option>`] : [])
    .concat(items.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`)).join('');
  if (cur !== undefined) {
    if (cur && !items.includes(cur)) el.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(cur)}">${escapeHtml(cur)}</option>`);
    el.value = cur || '';
  }
};

async function loadProfiles(force = false) {
  if (state.profilesLoaded && !force) return;
  const snap = await getDocs(collection(db, 'profiles'));
  state.profiles = new Map(snap.docs.map((d) => [d.id, d.data()]));
  state.profilesLoaded = true;
}

$('btn-students').addEventListener('click', openStudents);
document.querySelectorAll('.js-back-students').forEach((b) => b.addEventListener('click', openStudents));
['sf-q', 'sf-status', 'sf-branch', 'sf-grade'].forEach((id) => $(id).addEventListener('input', renderStudents));

async function openStudents() {
  if (!$('sf-branch').options.length) {
    fillSelect($('sf-branch'), '全部分校', BRANCHES);
    fillSelect($('sf-grade'), '全部年級', GRADES);
  }
  show('view-students');
  $('s-rows').innerHTML = '<tr><td colspan="7" class="muted center">讀取中…</td></tr>';
  try {
    await loadProfiles(true);
    renderStudents();
  } catch (err) {
    console.error(err);
    $('s-rows').innerHTML = `<tr><td colspan="7" class="warn center">讀取失敗：${escapeHtml(denyMsg(err) || err.code || err.message)}</td></tr>`;
  }
}

function classTitlesOf(p) {
  return (p.classes || []).map((cid) => state.classes.find((c) => c.id === cid)).filter(Boolean);
}

function filteredProfiles() {
  const q = $('sf-q').value.trim().toLowerCase();
  const st = $('sf-status').value;
  const br = $('sf-branch').value;
  const gr = $('sf-grade').value;
  return [...state.profiles.values()].filter((p) => (!st || (p.status || 'active') === st)
    && (!br || p.branch === br) && (!gr || p.grade === gr)
    && (!q || [p.name, p.serial, p.phone, p.school, p.note].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant') || String(a.serial).localeCompare(String(b.serial)));
}

function renderStudents() {
  const all = filteredProfiles();
  const list = all.slice(0, 300);
  $('s-count').textContent = `（共 ${state.profiles.size} 位${all.length !== state.profiles.size ? `，符合 ${all.length} 位` : ''}）`;
  $('s-rows').innerHTML = list.length ? list.map((p) => {
    const cls = classTitlesOf(p);
    return `
    <tr data-serial="${escapeHtml(p.serial)}">
      <td><b>${escapeHtml(p.name)}</b></td>
      <td>${escapeHtml(p.serial)}</td>
      <td class="small">${escapeHtml([p.school, p.grade].filter(Boolean).join(' '))}</td>
      <td class="small">${escapeHtml(p.branch || '')}</td>
      <td class="small">${escapeHtml(p.phone || '')}</td>
      <td class="class-list-cell">${cls.length ? `${cls.length} 班：${cls.map((c) => escapeHtml(c.title)).join('、')}` : '—'}</td>
      <td>${statusPill(p.status)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="muted center">${state.profiles.size ? '沒有符合的學生' : '還沒有學生資料。可以按「新增學生」、「匯入學生資料」，或用「從現有班級名單建立」把各班名單裡的學生建成資料。'}</td></tr>`;
  $('s-more').textContent = all.length > list.length ? `只顯示前 ${list.length} 位，請用搜尋或篩選縮小範圍。` : '';
  $('s-rows').querySelectorAll('tr[data-serial]').forEach((tr) => tr.addEventListener('click', () => openStudentEditor(tr.dataset.serial)));
}

$('btn-new-student').addEventListener('click', () => openStudentEditor(null));

async function openStudentEditor(serial) {
  if (!state.profilesLoaded) await loadProfiles();
  const p = serial ? state.profiles.get(serial) : null;
  if (serial && !p) return toast('找不到這位學生的資料', 'error');
  state.editingSerial = p ? p.serial : null;
  $('se-title').textContent = p ? `編輯學生：${p.name}` : '新增學生';
  $('se-name').value = p?.name || '';
  $('se-serial').value = p?.serial || '';
  $('se-phone').value = p?.phone || '';
  $('se-status').value = p?.status || 'active';
  $('se-school').value = p?.school || '';
  fillSelect($('se-grade'), '（未填）', GRADES, p?.grade || '');
  fillSelect($('se-branch'), '（未填）', BRANCHES, p?.branch || '');
  $('se-note').value = p?.note || '';
  const lock = !!p && !can('manager');
  $('se-name').disabled = lock;
  $('se-serial').disabled = lock;
  $('se-lock-note').classList.toggle('hidden', !lock);
  $('se-delete').classList.toggle('hidden', !p);

  const terms = [...new Set(state.classes.map((c) => c.term).filter(Boolean))].sort().reverse();
  fillSelect($('se-term'), '全部學期', terms, terms[0] || '');
  $('se-class-q').value = '';
  $('se-only-mine').checked = false;
  const valid = new Set(state.classes.map((c) => c.id));
  state.editOrig = new Set((p?.classes || []).filter((cid) => valid.has(cid)));
  state.editSel = new Set(state.editOrig);
  state.editSeats = new Map();
  renderClassPicker();
  show('view-student-editor');

  // 讀取目前各班的座位
  if (p) {
    const key = studentKey(p.name, p.serial);
    await Promise.all([...state.editOrig].map(async (cid) => {
      try {
        const h = await getDoc(doc(db, 'classes', cid, 'holders', key));
        if (h.exists()) state.editSeats.set(cid, h.data().seatId);
      } catch (e) { /* 忽略 */ }
    }));
    renderClassPicker();
  }
}

['se-term', 'se-class-q', 'se-only-mine'].forEach((id) => $(id).addEventListener('input', renderClassPicker));

function renderClassPicker() {
  const term = $('se-term').value;
  const q = normTitle($('se-class-q').value);
  const onlyMine = $('se-only-mine').checked;
  const list = state.classes.filter((c) => (state.editSel.has(c.id) || (!c.archived && (!term || c.term === term)))
    && (!q || normTitle(c.title).includes(q)) && (!onlyMine || state.editSel.has(c.id)));
  const staffLock = !can('manager');
  $('se-classes').innerHTML = list.length ? list.map((c) => {
    const on = state.editSel.has(c.id);
    const locked = staffLock && state.editOrig.has(c.id);
    const seat = state.editSeats.get(c.id);
    return `<label class="${on ? 'on' : ''} ${locked ? 'locked' : ''}" title="${locked ? '移出班級要主管操作' : ''}">
      <input type="checkbox" data-cid="${c.id}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}>
      <span>${typeTag(c)}<b>${escapeHtml(c.title)}</b>${seat ? ` <span class="seat-tag">${escapeHtml(seat)}</span>` : ''}${c.archived ? ' <span class="period archived">已封存</span>' : ''}
        <div class="meta">${escapeHtml(classMeta(c))}</div></span></label>`;
  }).join('') : '<p class="muted small">沒有符合的班級</p>';
  $('se-classes').querySelectorAll('input[data-cid]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) state.editSel.add(cb.dataset.cid); else state.editSel.delete(cb.dataset.cid);
    renderClassPicker();
  }));
  const added = [...state.editSel].filter((x) => !state.editOrig.has(x)).length;
  const removed = [...state.editOrig].filter((x) => !state.editSel.has(x)).length;
  $('se-class-note').textContent = `已勾選 ${state.editSel.size} 班${added ? `，將加入 ${added} 班` : ''}${removed ? `，將移出 ${removed} 班（有座位的會釋放）` : ''}${staffLock && state.editOrig.size ? '。移出班級要主管操作。' : ''}`;
}

$('student-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const old = state.editingSerial ? state.profiles.get(state.editingSerial) : null;
  const name = normalizeName($('se-name').value);
  const serial = normalizeSerial($('se-serial').value);
  let phone = normalizePhone($('se-phone').value);
  if (/^9\d{8}$/.test(phone)) phone = '0' + phone;
  if (!name || name.length > 20 || /\d/.test(name)) return toast('請填寫正確的學生姓名', 'error');
  if (!isValidSerial(serial)) return toast('繳費序號格式不對（只能有英文字母、數字、-，3～30 字）', 'error');
  if (phone && !isValidPhone(phone)) return toast('家長手機格式不對，請輸入 09 開頭的 10 碼，或留空', 'error');
  const status = $('se-status').value;
  const sel = new Set(state.editSel);

  // 序號不能重複
  if (!old || old.serial !== serial) {
    const taken = await getDoc(doc(db, 'profiles', serial));
    if (taken.exists()) return toast(`繳費序號 ${serial} 已經是「${taken.data().name}」的了`, 'error');
  }
  // 改成退班時，主管可以選擇一起移出所有班級
  if (status === 'left' && (old?.status || 'active') !== 'left' && sel.size && can('manager')
    && confirm(`${name} 改成「退班」，要同時把他從目前的 ${sel.size} 個班級移出嗎？\n（有座位的會一起釋放）`)) sel.clear();

  const oldKey = old ? studentKey(old.name, old.serial) : null;
  const newKey = studentKey(name, serial);
  const rekey = !!old && oldKey !== newKey;
  const added = [...sel].filter((x) => !state.editOrig.has(x));
  const removed = [...state.editOrig].filter((x) => !sel.has(x));
  const kept = [...sel].filter((x) => state.editOrig.has(x));
  if ((removed.length || rekey) && !can('manager')) return toast('移出班級、修改姓名或序號要主管操作', 'error');
  if (removed.some((cid) => state.editSeats.has(cid))
    && !confirm(`會從 ${removed.length} 個班級移出，其中有座位的會一起釋放，確定嗎？`)) return;

  const btn = $('se-submit');
  btn.disabled = true;
  try {
    const ops = [];
    // 需要讀目前座位的班級：要移出的、要改名搬移的
    const needHolder = [...removed, ...(rekey ? kept : [])];
    const holders = new Map();
    await Promise.all(needHolder.map(async (cid) => {
      const h = await getDoc(doc(db, 'classes', cid, 'holders', oldKey));
      if (h.exists()) holders.set(cid, h.data());
    }));

    removed.forEach((cid) => {
      const h = holders.get(cid);
      if (h) {
        ops.push((b) => b.delete(doc(db, 'classes', cid, 'seats', h.seatId)));
        ops.push((b) => b.delete(doc(db, 'classes', cid, 'bookings', h.bid)));
        ops.push((b) => b.delete(doc(db, 'classes', cid, 'holders', oldKey)));
      }
      ops.push((b) => b.delete(doc(db, 'classes', cid, 'roster', oldKey)));
    });
    kept.forEach((cid) => {
      if (rekey) {
        ops.push((b) => b.set(doc(db, 'classes', cid, 'roster', newKey), { name, serial, phone, addedAt: serverTimestamp() }));
        ops.push((b) => b.delete(doc(db, 'classes', cid, 'roster', oldKey)));
        const h = holders.get(cid);
        if (h) {
          ops.push((b) => b.set(doc(db, 'classes', cid, 'holders', newKey), { bid: h.bid, seatId: h.seatId }));
          ops.push((b) => b.delete(doc(db, 'classes', cid, 'holders', oldKey)));
          ops.push((b) => b.update(doc(db, 'classes', cid, 'bookings', h.bid), { key: newKey, name, serial }));
        }
      } else if ((old?.phone || '') !== phone) {
        ops.push((b) => b.set(doc(db, 'classes', cid, 'roster', oldKey), { phone }, { merge: true }));
      }
    });
    added.forEach((cid) => ops.push((b) => b.set(doc(db, 'classes', cid, 'roster', newKey), { name, serial, phone, addedAt: serverTimestamp() })));

    // 家長登入用的學生索引
    if (rekey) ops.push((b) => b.delete(doc(db, 'students', oldKey)));
    if (sel.size || rekey || added.length || removed.length) {
      ops.push((b) => b.set(doc(db, 'students', newKey), { name, serial, classes: [...sel] }, { merge: true }));
    }
    // 學生資料本身
    const data = {
      serial, name, phone, status,
      school: $('se-school').value.trim(), grade: $('se-grade').value, branch: $('se-branch').value,
      note: $('se-note').value.trim(), classes: [...sel], updatedAt: serverTimestamp(), updatedBy: state.me.email
    };
    if (!old || old.serial !== serial) data.createdAt = old?.createdAt || serverTimestamp();
    ops.push((b) => b.set(doc(db, 'profiles', serial), data, { merge: true }));
    if (old && old.serial !== serial) ops.push((b) => b.delete(doc(db, 'profiles', old.serial)));

    await commitInChunks(ops);
    toast(old ? '已儲存學生資料' : `已新增 ${name}`, 'success');

    const titles = (ids) => ids.map((cid) => state.classes.find((c) => c.id === cid)?.title || cid).join('、');
    const parts = [];
    if (!old) parts.push(`新增 ${name}（${serial}）`);
    else {
      parts.push(`${old.name}（${old.serial}）`);
      if (rekey) parts.push(`改為 ${name}（${serial}）`);
      const changed = ['phone', 'status', 'school', 'grade', 'branch', 'note'].filter((k) => String(old[k] || (k === 'status' ? 'active' : '')) !== String(data[k] || ''));
      if (changed.length) parts.push(`修改：${changed.map((k) => ({ phone: '手機', status: '狀態', school: '學校', grade: '年級', branch: '主要分校', note: '備註' })[k]).join('、')}${changed.includes('status') ? `（${STATUS_LABEL[data.status]}）` : ''}`);
    }
    if (added.length) parts.push(`加入班級：${titles(added)}`);
    if (removed.length) parts.push(`移出班級：${titles(removed)}`);
    log(old ? '編輯學生資料' : '新增學生資料', parts.join('；'));
    state.profilesLoaded = false;
    openStudents();
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '儲存失敗：' + (err.code || err.message), 'error');
  } finally {
    btn.disabled = false;
  }
});

$('se-delete').addEventListener('click', async () => {
  const p = state.profiles.get(state.editingSerial);
  if (!p || !can('manager')) return;
  const cls = classTitlesOf(p);
  if (!confirm(`確定刪除學生「${p.name}（${p.serial}）」？${cls.length ? `\n會同時從 ${cls.length} 個班級移出，座位一起釋放。` : ''}\n刪除後無法復原。`)) return;
  try {
    const key = studentKey(p.name, p.serial);
    const ops = [];
    for (const c of cls) {
      const h = await getDoc(doc(db, 'classes', c.id, 'holders', key));
      if (h.exists()) {
        const d = h.data();
        ops.push((b) => b.delete(doc(db, 'classes', c.id, 'seats', d.seatId)));
        ops.push((b) => b.delete(doc(db, 'classes', c.id, 'bookings', d.bid)));
        ops.push((b) => b.delete(doc(db, 'classes', c.id, 'holders', key)));
      }
      ops.push((b) => b.delete(doc(db, 'classes', c.id, 'roster', key)));
    }
    ops.push((b) => b.delete(doc(db, 'students', key)));
    ops.push((b) => b.delete(doc(db, 'profiles', p.serial)));
    await commitInChunks(ops);
    toast(`已刪除 ${p.name}`, 'success');
    log('刪除學生', `${p.name}（${p.serial}）${cls.length ? `，並移出：${cls.map((c) => c.title).join('、')}` : ''}`);
    state.profilesLoaded = false;
    openStudents();
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '刪除失敗：' + (err.code || err.message), 'error');
  }
});

// 班級名單上點姓名 → 打開學生資料
$('d-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-profile]');
  if (!btn) return;
  const serial = btn.dataset.profile;
  const p = (await fetchProfiles([serial])).get(serial);
  if (!p) return toast('這位學生還沒有學生資料，可以到「學生資料」頁按「從現有班級名單建立」', 'error');
  state.profiles.set(serial, p);
  state.profilesLoaded = true;
  stopDetail();
  openStudentEditor(serial);
});

// 從現有班級名單建立學生資料（第一次使用時）
$('btn-migrate').addEventListener('click', async () => {
  if (!can('manager')) return;
  const btn = $('btn-migrate');
  btn.disabled = true;
  try {
    await Promise.all([loadAllRosters(), loadProfiles(true)]);
    const bySerial = new Map();
    let legacy = 0;
    state.rosters.forEach((roster, cid) => roster.forEach((r) => {
      if (!r.serial) { legacy++; return; }
      if (!bySerial.has(r.serial)) bySerial.set(r.serial, { names: new Set(), phone: '', classes: new Set() });
      const x = bySerial.get(r.serial);
      x.names.add(r.name);
      if (!x.phone && r.phone) x.phone = r.phone;
      x.classes.add(cid);
    }));
    const conflicts = [];
    const creates = [];
    const fixes = [];
    bySerial.forEach((x, serial) => {
      const names = [...x.names];
      const p = state.profiles.get(serial);
      if (names.length > 1 || (p && !x.names.has(p.name))) { conflicts.push(`${serial}：${[...new Set([...(p ? [p.name] : []), ...names])].join('、')}`); return; }
      if (!p) creates.push({ serial, name: names[0], phone: x.phone, classes: [...x.classes] });
      else {
        const missing = [...x.classes].filter((cid) => !(p.classes || []).includes(cid));
        if (missing.length) fixes.push({ serial, missing });
      }
    });
    if (!creates.length && !fixes.length) {
      alert(`沒有需要建立的學生資料。${conflicts.length ? `\n\n以下序號在不同班級名單裡對到不同姓名，請先到各班修正：\n${conflicts.join('\n')}` : ''}${legacy ? `\n\n另有 ${legacy} 筆舊格式（沒有繳費序號）的名單被略過。` : ''}`);
      return;
    }
    if (!confirm(`將建立 ${creates.length} 位學生資料${fixes.length ? `、補上 ${fixes.length} 位學生的班級` : ''}。${conflicts.length ? `\n\n有 ${conflicts.length} 個序號對到不同姓名，不會建立：\n${conflicts.slice(0, 10).join('\n')}${conflicts.length > 10 ? '\n…' : ''}` : ''}${legacy ? `\n\n略過 ${legacy} 筆沒有繳費序號的舊資料。` : ''}\n\n確定嗎？`)) return;
    const ops = creates.map((x) => (b) => b.set(doc(db, 'profiles', x.serial), {
      serial: x.serial, name: x.name, phone: x.phone || '', status: 'active', school: '', grade: '', branch: '', note: '',
      classes: x.classes, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: state.me.email
    }));
    fixes.forEach((x) => ops.push((b) => b.set(doc(db, 'profiles', x.serial), { serial: x.serial, classes: arrayUnion(...x.missing), updatedAt: serverTimestamp() }, { merge: true })));
    await commitInChunks(ops);
    toast(`已建立 ${creates.length} 位學生資料`, 'success');
    log('從班級名單建立學生資料', `建立 ${creates.length} 位${fixes.length ? `、補上 ${fixes.length} 位的班級` : ''}${conflicts.length ? `；${conflicts.length} 個序號姓名不一致未建立` : ''}`);
    await openStudents();
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '建立失敗：' + (err.code || err.message), 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- 匯入學生資料（不含分班） ----------
let profilePlan = [];
$('btn-profile-import').addEventListener('click', async () => {
  $('pi-text').value = '';
  analyzeProfileImport();
  show('view-profile-import');
  await loadProfiles();
  analyzeProfileImport();
});
$('pi-text').addEventListener('input', analyzeProfileImport);
$('pi-submit').addEventListener('click', runProfileImport);

const STATUS_FROM_TEXT = { '': 'active', 在學: 'active', 暫停: 'paused', 退班: 'left', active: 'active', paused: 'paused', left: 'left' };

function analyzeProfileImport() {
  const bad = [];
  const notes = [];
  const seen = new Set();
  profilePlan = [];
  String($('pi-text').value || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    const f = splitFields(line);
    if (isHeaderRow(f)) return;
    const r = parseStudentFields(f[0], f[1], f[2]);
    const raw = line.trim().replace(/\t/g, ' ');
    if (r.error) { bad.push(`${raw}（${r.error}）`); return; }
    if (seen.has(r.serial)) { bad.push(`${raw}（序號在清單裡重複）`); return; }
    seen.add(r.serial);
    const statusText = (f[6] || '').trim();
    if (!(statusText in STATUS_FROM_TEXT)) { bad.push(`${raw}（狀態只能填 在學、暫停、退班）`); return; }
    const p = state.profiles.get(r.serial);
    if (p && p.name !== r.name) { bad.push(`${raw}（這個序號已經是「${p.name}」的）`); return; }
    if (r.phoneNote) notes.push(`${r.name}：${r.phoneNote}`);
    const branch = (f[5] || '').trim();
    if (branch && !BRANCHES.includes(branch)) notes.push(`${r.name}：分校「${branch}」不在分校清單中（仍會匯入）`);
    profilePlan.push({
      serial: r.serial, name: r.name, phone: r.phone, school: (f[3] || '').trim(), grade: (f[4] || '').trim(),
      branch, status: statusText ? STATUS_FROM_TEXT[statusText] : '', note: (f[7] || '').trim(), existing: p || null
    });
  });
  const nNew = profilePlan.filter((x) => !x.existing).length;
  const nUpd = profilePlan.length - nNew;
  $('pi-status').innerHTML = profilePlan.length || bad.length ? `新增 <b>${nNew}</b> 位、更新 <b>${nUpd}</b> 位${bad.length ? `、<span class="warn">${bad.length} 列不會匯入</span>` : ''}` : '';
  $('pi-problems').innerHTML = (bad.length ? `<div class="notice error"><b>這些資料不會匯入：</b><ul class="tight">${bad.slice(0, 30).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}${bad.length > 30 ? '<li>…</li>' : ''}</ul></div>` : '')
    + (notes.length ? `<div class="notice warn-box"><b>請確認：</b><ul class="tight">${notes.slice(0, 30).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '');
  $('pi-submit').disabled = !profilePlan.length;
}

async function runProfileImport() {
  if (!profilePlan.length) return;
  const nNew = profilePlan.filter((x) => !x.existing).length;
  if (!confirm(`確定匯入？新增 ${nNew} 位、更新 ${profilePlan.length - nNew} 位`)) return;
  const btn = $('pi-submit');
  btn.disabled = true;
  try {
    const ops = [];
    profilePlan.forEach((x) => {
      if (!x.existing) {
        ops.push((b) => b.set(doc(db, 'profiles', x.serial), {
          serial: x.serial, name: x.name, phone: x.phone, school: x.school, grade: x.grade, branch: x.branch,
          status: x.status || 'active', note: x.note, classes: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: state.me.email
        }));
      } else {
        // 只更新有填的欄位，空白不蓋掉原本的資料
        const upd = { serial: x.serial, updatedAt: serverTimestamp(), updatedBy: state.me.email };
        ['phone', 'school', 'grade', 'branch', 'status', 'note'].forEach((k) => { if (x[k]) upd[k] = x[k]; });
        ops.push((b) => b.set(doc(db, 'profiles', x.serial), upd, { merge: true }));
        // 手機有改：同步到各班名單
        if (x.phone && x.phone !== (x.existing.phone || '')) {
          const key = studentKey(x.name, x.serial);
          (x.existing.classes || []).forEach((cid) => ops.push((b) => b.set(doc(db, 'classes', cid, 'roster', key), { phone: x.phone }, { merge: true })));
        }
      }
    });
    await commitInChunks(ops);
    toast(`匯入完成：新增 ${nNew} 位、更新 ${profilePlan.length - nNew} 位`, 'success');
    log('匯入學生資料', `新增 ${nNew} 位、更新 ${profilePlan.length - nNew} 位：${profilePlan.slice(0, 50).map((x) => `${x.name}(${x.serial})`).join('、')}${profilePlan.length > 50 ? '…' : ''}`);
    state.profilesLoaded = false;
    openStudents();
  } catch (err) {
    console.error(err);
    toast(denyMsg(err) || '匯入失敗：' + (err.code || err.message), 'error');
  } finally {
    btn.disabled = false;
  }
}

$('btn-profile-export').addEventListener('click', () => {
  const list = filteredProfiles();
  if (!list.length) return toast('沒有可以匯出的學生', 'error');
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const text = (v) => (v ? `="${String(v).replace(/"/g, '')}"` : '');
  const lines = [['學生姓名', '繳費序號', '家長手機', '學校', '年級', '主要分校', '狀態', '備註', '上的班級'].map(cell).join(',')]
    .concat(list.map((p) => [cell(p.name), text(p.serial), text(p.phone), cell(p.school), cell(p.grade), cell(p.branch),
      cell(STATUS_LABEL[p.status || 'active']), cell(p.note), cell(classTitlesOf(p).map((c) => c.title).join('、'))].join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `學生資料_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  log('匯出名單', `匯出學生資料 CSV（${list.length} 位）`);
});
