import {
  signInAnonymously, onAuthStateChanged,
  collection, doc, getDoc, onSnapshot
} from './firebase-sdk.js';
import {
  auth, db, configMissing, renderSeatMap, normalizeSerial, normalizeName, isValidSerial,
  studentKey, takeSeat, releaseSeat, escapeHtml, classSort, classMeta, typeLabel, visibleToParents, toast
} from './common.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-login', 'view-classes', 'view-seats'];

const state = {
  uid: null,
  student: null,          // { key, name, serial }
  classIds: [],
  classes: new Map(),     // cid -> 班級資料
  holders: new Map(),     // cid -> { bid, seatId }（這個學生在該班的座位）
  classUnsubs: new Map(), // cid -> [unsub, unsub]
  studentUnsub: null,
  currentCid: null,
  taken: new Set(),       // 目前班級已被佔用的座位
  seatsUnsub: null,
  busy: false
};
let started = false;

function show(view) {
  VIEWS.forEach((v) => $(v).classList.toggle('hidden', v !== view));
  window.scrollTo(0, 0);
}

function showNotice(msg, type = 'info') {
  const n = $('notice');
  n.textContent = msg;
  n.className = `notice ${type}`;
}

// ---------- 啟動 ----------
if (configMissing) {
  showNotice('尚未設定 Firebase：請依照 README 第 4 步，把設定貼到 js/firebase-config.js。', 'error');
} else {
  // 已有登入身分（例如同一台電腦登入過後台）就沿用，沒有才建立匿名身分
  onAuthStateChanged(auth, (user) => {
    if (user) {
      state.uid = user.uid;
      start();
    } else {
      signInAnonymously(auth).catch(onAuthError);
    }
  });
}

function onAuthError(err) {
  console.error(err);
  if (String(err.code).includes('operation-not-allowed') || String(err.code).includes('admin-restricted')) {
    showNotice('尚未啟用「匿名登入」：請依照 README 第 2 步到 Firebase Authentication 開啟 Anonymous。', 'error');
  } else {
    showNotice('連線失敗，請重新整理頁面再試一次。（' + err.code + '）', 'error');
  }
}

function start() {
  if (started) return;
  started = true;
  const last = loadSaved()[0];
  if (last) {
    lookupStudent(last.name, last.serial, true);
  } else {
    showLogin();
  }
}

// ---------- 記住查詢過的學生（方便有兩個孩子的家長切換） ----------
function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem('sb_students') || '[]').filter((s) => s && s.name && s.serial);
  } catch (e) { return []; }
}
function saveStudent(name, serial) {
  const list = loadSaved().filter((s) => !(s.name === name && s.serial === serial));
  list.unshift({ name, serial });
  try { localStorage.setItem('sb_students', JSON.stringify(list.slice(0, 5))); } catch (e) { /* 忽略 */ }
}
function forgetStudent(name, serial) {
  const list = loadSaved().filter((s) => !(s.name === name && s.serial === serial));
  try { localStorage.setItem('sb_students', JSON.stringify(list)); } catch (e) { /* 忽略 */ }
}

// ---------- 1. 查詢學生 ----------
function showLogin() {
  stopStudent();
  const saved = loadSaved();
  const box = $('saved-students');
  if (saved.length) {
    box.innerHTML = '<p class="muted small">之前查詢過：</p>' + saved.map((s, i) => `
      <span class="chip">
        <button type="button" class="chip-main" data-i="${i}">${escapeHtml(s.name)}</button>
        <button type="button" class="chip-x" data-x="${i}" aria-label="移除">×</button>
      </span>`).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
      const s = saved[b.dataset.i];
      lookupStudent(s.name, s.serial);
    }));
    box.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => {
      const s = saved[b.dataset.x];
      forgetStudent(s.name, s.serial);
      showLogin();
    }));
  } else {
    box.classList.add('hidden');
  }
  show('view-login');
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = normalizeName($('l-name').value);
  const serial = normalizeSerial($('l-serial').value);
  if (!name) return toast('請填寫學生姓名', 'error');
  if (!isValidSerial(serial)) return toast('繳費序號格式不正確，請照繳費單上的序號輸入（英文字母、數字）', 'error');
  lookupStudent(name, serial);
});

async function lookupStudent(name, serial, silent = false) {
  if (!serial) return showLogin();   // 舊版存的是手機，沒有序號就請家長重新輸入
  const key = studentKey(name, serial);
  const btn = $('l-submit');
  btn.disabled = true;
  try {
    const snap = await getDoc(doc(db, 'students', key));
    if (!snap.exists() || !(snap.data().classes || []).length) {
      if (silent) return showLogin();
      forgetStudent(name, serial);
      toast('查不到這位學生。請確認學生姓名和繳費序號都正確，或聯絡櫃台。', 'error');
      showLogin();
      return;
    }
    saveStudent(name, serial);
    state.student = { key, name, serial };
    $('l-name').value = '';
    $('l-serial').value = '';
    openStudent();
  } catch (err) {
    console.error(err);
    toast('查詢失敗，請稍後再試（' + (err.code || err.message) + '）', 'error');
    showLogin();
  } finally {
    btn.disabled = false;
  }
}

$('btn-switch').addEventListener('click', showLogin);

// ---------- 2. 班級列表 ----------
function openStudent() {
  stopStudent();
  $('c-student').textContent = state.student.name;
  $('class-list').innerHTML = '<p class="muted">載入中…</p>';
  show('view-classes');

  state.studentUnsub = onSnapshot(doc(db, 'students', state.student.key), (snap) => {
    const ids = snap.exists() ? (snap.data().classes || []) : [];
    state.classIds = ids;
    // 新增的班級開始監聽，被移除的班級停止監聽
    ids.forEach(watchClass);
    [...state.classUnsubs.keys()].filter((cid) => !ids.includes(cid)).forEach(unwatchClass);
    if (state.currentCid && !ids.includes(state.currentCid)) {
      toast('這個班級已經不在你的名單裡了');
      closeClass();
    }
    renderClassList();
  }, (err) => console.error(err));
}

function watchClass(cid) {
  if (state.classUnsubs.has(cid)) return;
  const u1 = onSnapshot(doc(db, 'classes', cid), (snap) => {
    if (snap.exists()) state.classes.set(cid, { id: cid, ...snap.data() });
    else state.classes.delete(cid);
    renderClassList();
    if (state.currentCid === cid) renderSeats();
  }, (err) => console.warn(err));
  const u2 = onSnapshot(doc(db, 'classes', cid, 'holders', state.student.key), (snap) => {
    if (snap.exists()) state.holders.set(cid, snap.data());
    else state.holders.delete(cid);
    renderClassList();
    if (state.currentCid === cid) renderSeats();
  }, (err) => console.warn(err));
  state.classUnsubs.set(cid, [u1, u2]);
}

function unwatchClass(cid) {
  (state.classUnsubs.get(cid) || []).forEach((u) => u());
  state.classUnsubs.delete(cid);
  state.classes.delete(cid);
  state.holders.delete(cid);
}

function stopStudent() {
  closeClass(true);
  if (state.studentUnsub) state.studentUnsub();
  state.studentUnsub = null;
  [...state.classUnsubs.keys()].forEach(unwatchClass);
  state.classIds = [];
}

function classStatus(c, holder) {
  if (holder) {
    return c.open
      ? `<span class="status ok">座位 ${escapeHtml(holder.seatId)}</span>`
      : `<span class="status ok">座位 ${escapeHtml(holder.seatId)}</span><div class="muted small">劃位已截止</div>`;
  }
  return c.open ? '<span class="status todo">尚未劃位</span>' : '<span class="status off">未開放劃位</span>';
}

function renderClassList() {
  if (!state.student) return;
  const list = $('class-list');
  const loaded = state.classIds.map((cid) => state.classes.get(cid)).filter(Boolean);
  // 已封存、或過了結束日的課程不顯示
  const classes = loaded.filter(visibleToParents).sort(classSort);
  if (!classes.length) {
    list.innerHTML = loaded.length < state.classIds.length ? '<p class="muted">載入中…</p>' : '<p class="muted">目前沒有需要劃位的班級。</p>';
    return;
  }
  list.innerHTML = classes.map((c) => `
    <button type="button" class="card session-card" data-cid="${c.id}">
      <div class="card-main">
        <div class="card-title"><span class="type-tag ${escapeHtml(c.type || 'regular')}">${escapeHtml(typeLabel(c.type))}</span>${escapeHtml(c.title)}</div>
        <div class="muted small">${escapeHtml(classMeta(c))}</div>
      </div>
      <div class="card-side">${classStatus(c, state.holders.get(c.id))}</div>
    </button>`).join('');
  list.querySelectorAll('[data-cid]').forEach((b) => b.addEventListener('click', () => openClass(b.dataset.cid)));
}

// ---------- 3. 座位圖 ----------
function openClass(cid) {
  closeClass(true);
  state.currentCid = cid;
  state.taken = new Set();
  $('seat-map').innerHTML = '<p class="muted center">載入中…</p>';
  show('view-seats');
  renderSeats();
  state.seatsUnsub = onSnapshot(collection(db, 'classes', cid, 'seats'), (snap) => {
    state.taken = new Set(snap.docs.map((d) => d.id));
    renderSeats();
  }, (err) => console.error(err));
}

function closeClass(silent = false) {
  if (state.seatsUnsub) state.seatsUnsub();
  state.seatsUnsub = null;
  state.currentCid = null;
  if (!silent) show('view-classes');
}

$('btn-back').addEventListener('click', () => closeClass());

function renderSeats() {
  const c = state.classes.get(state.currentCid);
  if (!c) return;
  if (!visibleToParents(c)) {
    toast('這個課程已經結束了');
    closeClass();
    return;
  }
  const holder = state.holders.get(c.id);

  $('s-title').innerHTML = `<span class="type-tag ${escapeHtml(c.type || 'regular')}">${escapeHtml(typeLabel(c.type))}</span>${escapeHtml(c.title)}`;
  $('s-meta').textContent = classMeta(c);
  $('s-note').textContent = c.note || '';

  const box = $('my-booking');
  if (holder) {
    box.innerHTML = `
      <div>✅ ${escapeHtml(state.student.name)} 的座位：<span class="seat-tag">${escapeHtml(holder.seatId)}</span>
        ${c.open ? '<div class="muted small">想換位置的話，直接點其他空位。</div>' : ''}</div>
      ${c.open ? '<button type="button" id="btn-cancel-booking" class="btn small danger">取消座位</button>'
               : '<span class="muted small">劃位已截止，如需更改請聯絡櫃台</span>'}`;
    const btn = $('btn-cancel-booking');
    if (btn) btn.onclick = cancelSeat;
  } else if (!c.open) {
    box.innerHTML = '<div>⛔ 這個班級目前未開放劃位。</div>';
  } else {
    const left = (c.seats?.length || 0) - state.taken.size;
    box.innerHTML = `<div>請為 <b>${escapeHtml(state.student.name)}</b> 選一個整學期的固定座位（剩 ${left} 位）。</div>`;
  }

  renderSeatMap($('seat-map'), c, (id) => {
    if (holder?.seatId === id) return { state: 'mine' };
    if (state.taken.has(id)) return { state: 'taken' };
    return { state: 'available' };
  }, onSeatClick);
}

async function onSeatClick(id, seatState) {
  const c = state.classes.get(state.currentCid);
  if (!c || state.busy) return;
  if (seatState === 'mine') return;
  if (seatState === 'taken') return toast('這個位子已經有人了');
  if (seatState !== 'available') return;
  if (!c.open) return toast('這個班級目前未開放劃位');

  const holder = state.holders.get(c.id);
  const msg = holder
    ? `要把 ${state.student.name} 的座位從 ${holder.seatId} 換到 ${id} 嗎？`
    : `確定幫 ${state.student.name} 劃 ${id} 這個座位嗎？\n（整學期固定坐這個位子）`;
  if (!confirm(msg)) return;

  state.busy = true;
  try {
    await takeSeat(c.id, state.student, id);
    toast(holder ? `已換到 ${id}` : `劃位成功：${id}`, 'success');
  } catch (err) {
    console.error(err);
    toast(seatErrorMessage(err), 'error');
  } finally {
    state.busy = false;
  }
}

function seatErrorMessage(err) {
  if (err.message === 'SEAT_TAKEN') return '手腳慢了一步，這個位子剛被劃走，請選其他位子';
  if (err.message === 'SAME_SEAT') return '你已經坐在這個位子了';
  if (err.code === 'permission-denied') return '劃位失敗：劃位可能已截止，或學生已不在這個班的名單中';
  if (err.code === 'unavailable') return '網路不穩，請稍後再試';
  return '劃位失敗，請稍後再試（' + (err.code || err.message) + '）';
}

async function cancelSeat() {
  const c = state.classes.get(state.currentCid);
  const holder = c && state.holders.get(c.id);
  if (!holder || state.busy) return;
  if (!confirm(`確定要取消 ${state.student.name} 的座位 ${holder.seatId} 嗎？`)) return;
  state.busy = true;
  try {
    await releaseSeat(c.id, state.student.key, holder);
    toast('已取消座位', 'success');
  } catch (err) {
    console.error(err);
    toast(err.code === 'permission-denied' ? '取消失敗：劃位可能已截止，請聯絡櫃台' : '取消失敗，請稍後再試', 'error');
  } finally {
    state.busy = false;
  }
}
