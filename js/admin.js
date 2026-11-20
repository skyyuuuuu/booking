import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
  collection, doc, getDocs, onSnapshot, query, orderBy, setDoc, updateDoc,
  writeBatch, serverTimestamp, getCountFromServer
} from './firebase-sdk.js';
import {
  auth, db, configMissing, renderSeatMap, buildSeatList, parseNumberList,
  escapeHtml, formatDate, toast
} from './common.js';
import { ADMIN_EMAILS, BRANCHES } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-login', 'view-denied', 'view-list', 'view-editor', 'view-detail'];

const state = {
  sessions: [],
  listUnsub: null,
  detailUnsubs: [],
  detail: null,             // 目前查看的場次
  detailSeats: new Map(),   // seatId -> { uid, bookedAt }
  detailBookings: [],       // [{ uid, seatId, name, phone, bookedAt }]
  editingId: null,          // null = 新增
  disabled: new Set()       // 編輯中「不設座位」的格子
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

// ---------- 場次列表 ----------
function startListening() {
  if (state.listUnsub) return;
  state.listUnsub = onSnapshot(query(collection(db, 'sessions'), orderBy('date', 'desc')), (snap) => {
    state.sessions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderList();
  }, (err) => {
    console.error(err);
    showNotice('讀取失敗：請確認 firestore.rules 裡的管理員 email 與登入帳號一致，且規則已發布。', 'error');
  });
}

function stopListening() {
  if (state.listUnsub) state.listUnsub();
  state.listUnsub = null;
  stopDetail();
}

function renderList() {
  const box = $('admin-session-list');
  if (!state.sessions.length) {
    box.innerHTML = '<p class="muted">還沒有場次，按右上角「新增場次」開始。</p>';
    return;
  }
  box.innerHTML = state.sessions.map((s) => `
    <div class="card admin-card">
      <div class="card-main">
        <div class="card-title">
          ${escapeHtml(s.title)}
          <span class="badge ${s.open ? 'on' : 'off'}">${s.open ? '開放中' : '未開放'}</span>
        </div>
        <div class="muted small">${escapeHtml(formatDate(s.date))} ${escapeHtml(s.time || '')}
          ${escapeHtml([s.branch, s.room].filter(Boolean).join('・'))}</div>
        <div class="small">已劃 <b class="cnt" data-sid="${s.id}">…</b> / ${s.seats?.length || 0}</div>
      </div>
      <div class="btn-group">
        <button type="button" class="btn small" data-act="detail" data-id="${s.id}">名單</button>
        <button type="button" class="btn small" data-act="toggle" data-id="${s.id}">${s.open ? '關閉劃位' : '開放劃位'}</button>
        <button type="button" class="btn small" data-act="edit" data-id="${s.id}">編輯</button>
        <button type="button" class="btn small" data-act="dup" data-id="${s.id}">複製</button>
        <button type="button" class="btn small" data-act="link" data-id="${s.id}">連結</button>
        <button type="button" class="btn small danger" data-act="del" data-id="${s.id}">刪除</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
    const s = state.sessions.find((x) => x.id === b.dataset.id);
    if (!s) return;
    ({ detail: openDetail, toggle: toggleOpen, edit: (x) => openEditor(x, false),
       dup: (x) => openEditor(x, true), link: copyLink, del: deleteSession })[b.dataset.act](s);
  }));

  state.sessions.forEach(async (s) => {
    try {
      const snap = await getCountFromServer(collection(db, 'sessions', s.id, 'seats'));
      const el = box.querySelector(`.cnt[data-sid="${s.id}"]`);
      if (el) el.textContent = snap.data().count;
    } catch (e) { console.warn(e); }
  });
}

async function toggleOpen(s) {
  try {
    await updateDoc(doc(db, 'sessions', s.id), { open: !s.open, updatedAt: serverTimestamp() });
    toast(s.open ? '已關閉劃位' : '已開放劃位', 'success');
  } catch (err) {
    console.error(err);
    toast('更新失敗：' + err.code, 'error');
  }
}

function bookingLink(sid) {
  const base = location.href.replace(/admin\.html.*$/, '').replace(/#.*$/, '');
  return `${base}index.html#s=${sid}`;
}

async function copyLink(s) {
  const url = bookingLink(s.id);
  try {
    await navigator.clipboard.writeText(url);
    toast('已複製劃位連結', 'success');
  } catch (e) {
    prompt('請複製以下連結：', url);
  }
}

async function deleteSession(s) {
  if (!confirm(`確定要刪除「${s.title}」？\n所有劃位資料都會一起刪除，無法復原。`)) return;
  try {
    for (const sub of ['seats', 'bookings', 'phones']) {
      const snap = await getDocs(collection(db, 'sessions', s.id, sub));
      for (let i = 0; i < snap.docs.length; i += 450) {
        const batch = writeBatch(db);
        snap.docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }
    const batch = writeBatch(db);
    batch.delete(doc(db, 'sessions', s.id));
    await batch.commit();
    toast('已刪除場次', 'success');
  } catch (err) {
    console.error(err);
    toast('刪除失敗：' + err.code, 'error');
  }
}

// ---------- 新增 / 編輯 ----------
$('e-branch').innerHTML = ['<option value="">（不指定）</option>']
  .concat(BRANCHES.map((b) => `<option>${escapeHtml(b)}</option>`)).join('');

$('btn-new').addEventListener('click', () => openEditor(null, false));

function openEditor(s, duplicate) {
  state.editingId = s && !duplicate ? s.id : null;
  $('editor-title').textContent = !s ? '新增場次' : duplicate ? '複製場次（另存為新場次）' : '編輯場次';
  $('e-title').value = s ? s.title + (duplicate ? '（複製）' : '') : '';
  $('e-branch').value = s?.branch || '';
  $('e-room').value = s?.room || '';
  $('e-date').value = s?.date || '';
  $('e-time').value = s?.time || '';
  $('e-note').value = s?.note || '';
  $('e-rows').value = s?.rows || 6;
  $('e-cols').value = s?.cols || 8;
  $('e-aisles').value = (s?.aisles || []).join(', ');
  $('e-open').checked = s && !duplicate ? !!s.open : false;
  state.disabled = new Set(s?.disabled || []);
  renderPreview();
  show('view-editor');
}

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
    branch: $('e-branch').value,
    room: $('e-room').value.trim(),
    date: $('e-date').value,
    time: $('e-time').value.trim(),
    note: $('e-note').value.trim(),
    ...layout,
    open: $('e-open').checked,
    updatedAt: serverTimestamp()
  };
  if (!data.title || !data.date) return toast('請填寫場次名稱與日期', 'error');

  const btn = $('e-submit');
  btn.disabled = true;
  try {
    if (state.editingId) {
      // 已被劃走的座位不能被刪掉
      const snap = await getDocs(collection(db, 'sessions', state.editingId, 'seats'));
      const valid = new Set(layout.seats);
      const lost = snap.docs.map((d) => d.id).filter((id) => !valid.has(id));
      if (lost.length) {
        toast(`以下座位已有人劃位，不能移除：${lost.join('、')}`, 'error');
        return;
      }
      await updateDoc(doc(db, 'sessions', state.editingId), data);
    } else {
      const ref = doc(collection(db, 'sessions'));
      await setDoc(ref, { ...data, createdAt: serverTimestamp() });
    }
    toast('已儲存', 'success');
    show('view-list');
  } catch (err) {
    console.error(err);
    toast('儲存失敗：' + err.code, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- 名單 ----------
function openDetail(s) {
  stopDetail();
  state.detail = s;
  state.detailSeats = new Map();
  state.detailBookings = [];
  show('view-detail');

  state.detailUnsubs.push(onSnapshot(doc(db, 'sessions', s.id), (snap) => {
    if (!snap.exists()) return backToList();
    state.detail = { id: snap.id, ...snap.data() };
    renderDetail();
  }));
  state.detailUnsubs.push(onSnapshot(collection(db, 'sessions', s.id, 'seats'), (snap) => {
    state.detailSeats = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderDetail();
  }));
  state.detailUnsubs.push(onSnapshot(collection(db, 'sessions', s.id, 'bookings'), (snap) => {
    state.detailBookings = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    renderDetail();
  }));
}

function stopDetail() {
  state.detailUnsubs.forEach((u) => u());
  state.detailUnsubs = [];
  state.detail = null;
}

function seatOrder(a, b) {
  const ra = a.charCodeAt(0), rb = b.charCodeAt(0);
  return ra !== rb ? ra - rb : parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
}

function fmtTime(ts) {
  if (!ts?.toDate) return '';
  const d = ts.toDate();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderDetail() {
  const s = state.detail;
  if (!s) return;
  $('d-title').textContent = s.title;
  $('d-meta').textContent = [formatDate(s.date) + ' ' + (s.time || ''), s.branch, s.room].filter(Boolean).join('・');
  $('d-stat').innerHTML = `<span class="badge ${s.open ? 'on' : 'off'}">${s.open ? '開放中' : '未開放'}</span>
    已劃 <b>${state.detailSeats.size}</b> / ${s.seats?.length || 0} 位`;
  $('d-toggle').textContent = s.open ? '關閉劃位' : '開放劃位';

  const bySeat = new Map(state.detailBookings.map((b) => [b.seatId, b]));
  renderSeatMap($('d-map'), s, (id) => {
    if (!state.detailSeats.has(id)) return { state: 'available' };
    const b = bySeat.get(id);
    return { state: 'taken', label: b ? b.name.slice(0, 3) : id, title: b ? `${id} ${b.name} ${b.phone}` : id };
  }, (id, seatState) => {
    if (seatState !== 'taken') return;
    const b = bySeat.get(id);
    if (b) adminCancel(b); else releaseSeat(id);
  });

  const rows = [...state.detailBookings].sort((a, b) => seatOrder(a.seatId, b.seatId));
  $('d-rows').innerHTML = rows.length ? rows.map((b) => `
    <tr>
      <td><span class="seat-tag">${escapeHtml(b.seatId)}</span></td>
      <td>${escapeHtml(b.name)}</td>
      <td>${escapeHtml(b.phone)}</td>
      <td class="muted small">${escapeHtml(fmtTime(b.bookedAt))}</td>
      <td><button type="button" class="btn small danger" data-uid="${escapeHtml(b.uid)}">取消</button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="muted center">尚無人劃位</td></tr>';

  $('d-rows').querySelectorAll('button[data-uid]').forEach((btn) => btn.addEventListener('click', () => {
    const b = state.detailBookings.find((x) => x.uid === btn.dataset.uid);
    if (b) adminCancel(b);
  }));
}

$('d-toggle').addEventListener('click', () => state.detail && toggleOpen(state.detail));
$('d-copy').addEventListener('click', () => state.detail && copyLink(state.detail));
$('d-export').addEventListener('click', exportCsv);

async function adminCancel(b) {
  const s = state.detail;
  if (!confirm(`確定取消 ${b.seatId} ${b.name} 的劃位？`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'sessions', s.id, 'seats', b.seatId));
    batch.delete(doc(db, 'sessions', s.id, 'bookings', b.uid));
    batch.delete(doc(db, 'sessions', s.id, 'phones', b.phone));
    await batch.commit();
    toast('已取消', 'success');
  } catch (err) {
    console.error(err);
    toast('取消失敗：' + err.code, 'error');
  }
}

// 座位被佔用但沒有對應的劃位資料時（例如手動在 Console 改過資料），讓管理員可以直接釋放
async function releaseSeat(seatId) {
  const s = state.detail;
  if (!confirm(`${seatId} 沒有對應的劃位資料，要直接釋放這個座位嗎？`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'sessions', s.id, 'seats', seatId));
    await batch.commit();
    toast('已釋放座位', 'success');
  } catch (err) {
    console.error(err);
    toast('釋放失敗：' + err.code, 'error');
  }
}

function exportCsv() {
  const s = state.detail;
  if (!s) return;
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [...state.detailBookings].sort((a, b) => seatOrder(a.seatId, b.seatId));
  const lines = [['座位', '姓名', '手機', '劃位時間'].map(cell).join(',')]
    // 手機用 ="09..." 格式，避免 Excel / Google 試算表吃掉開頭的 0
    .concat(rows.map((b) => [cell(b.seatId), cell(b.name), `="${b.phone}"`, cell(fmtTime(b.bookedAt))].join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${s.date || ''}_${s.title}_劃位名單.csv`.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

