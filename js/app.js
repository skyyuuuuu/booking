import {
  signInAnonymously, onAuthStateChanged,
  collection, doc, onSnapshot, query, where, runTransaction, serverTimestamp,
  writeBatch, getCountFromServer
} from './firebase-sdk.js';
import {
  auth, db, configMissing, renderSeatMap, normalizePhone, escapeHtml,
  sessionSortKey, formatDate, toast
} from './common.js';

const $ = (id) => document.getElementById(id);

const state = {
  uid: null,
  sessions: [],
  current: null,        // 目前選擇的場次 { id, ...data }
  taken: new Map(),     // seatId -> uid
  myBooking: null,      // { seatId, name, phone }
  selectedSeat: null,
  unsubs: []            // 目前場次的即時監聽
};
let started = false;

// ---------- 啟動 ----------
if (configMissing) {
  showNotice('尚未設定 Firebase：請依照 README 第 4 步，把設定貼到 js/firebase-config.js。', 'error');
  $('session-list').innerHTML = '';
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

  // 監聽所有開放中的場次
  onSnapshot(query(collection(db, 'sessions'), where('open', '==', true)), (snap) => {
    state.sessions = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => sessionSortKey(a).localeCompare(sessionSortKey(b)));
    renderSessionList();
  }, (err) => {
    console.error(err);
    showNotice('讀取場次失敗：請確認已依 README 第 3 步建立 Firestore 並發布安全規則。', 'error');
  });

  // 網址帶有 #s=場次ID 時直接打開該場次（方便把連結貼到 LINE）
  const m = location.hash.match(/s=([\w-]+)/);
  if (m) openSession(m[1]);

  window.addEventListener('hashchange', () => {
    const mm = location.hash.match(/s=([\w-]+)/);
    if (mm) openSession(mm[1]); else closeSession();
  });
}

// ---------- 場次列表 ----------
function renderSessionList() {
  const list = $('session-list');
  if (!state.sessions.length) {
    list.innerHTML = '<p class="muted">目前沒有開放劃位的場次。</p>';
    return;
  }
  list.innerHTML = state.sessions.map((s) => `
    <a class="card session-card" href="#s=${s.id}">
      <div class="card-main">
        <div class="card-title">${escapeHtml(s.title)}</div>
        <div class="muted small">${escapeHtml(formatDate(s.date))} ${escapeHtml(s.time || '')}</div>
        <div class="muted small">${escapeHtml([s.branch, s.room].filter(Boolean).join('・'))}</div>
      </div>
      <div class="card-side"><span class="remain" data-sid="${s.id}">…</span></div>
    </a>`).join('');

  // 剩餘座位數（聚合查詢，每 1000 筆才算 1 次讀取）
  state.sessions.forEach(async (s) => {
    try {
      const snap = await getCountFromServer(collection(db, 'sessions', s.id, 'seats'));
      const left = (s.seats?.length || 0) - snap.data().count;
      const el = list.querySelector(`.remain[data-sid="${s.id}"]`);
      if (el) {
        el.textContent = left > 0 ? `剩 ${left} 位` : '已額滿';
        el.classList.toggle('full', left <= 0);
      }
    } catch (e) { console.warn(e); }
  });
}

// ---------- 單一場次 ----------
function openSession(sid) {
  clearSessionListeners();
  state.current = null;
  state.taken = new Map();
  state.myBooking = null;

  $('view-sessions').classList.add('hidden');
  $('view-seats').classList.remove('hidden');
  $('s-title').textContent = '載入中…';
  $('s-meta').textContent = '';
  $('s-note').textContent = '';
  $('seat-map').innerHTML = '';
  $('my-booking').classList.add('hidden');
  window.scrollTo(0, 0);

  state.unsubs.push(onSnapshot(doc(db, 'sessions', sid), (snap) => {
    if (!snap.exists()) {
      $('s-title').textContent = '找不到這個場次';
      $('seat-map').innerHTML = '';
      return;
    }
    state.current = { id: snap.id, ...snap.data() };
    renderSession();
  }));

  state.unsubs.push(onSnapshot(collection(db, 'sessions', sid, 'seats'), (snap) => {
    state.taken = new Map(snap.docs.map((d) => [d.id, d.data().uid]));
    renderSession();
  }));

  state.unsubs.push(onSnapshot(doc(db, 'sessions', sid, 'bookings', state.uid), (snap) => {
    state.myBooking = snap.exists() ? snap.data() : null;
    renderSession();
  }, (err) => console.warn(err)));
}

function closeSession() {
  clearSessionListeners();
  state.current = null;
  $('view-seats').classList.add('hidden');
  $('view-sessions').classList.remove('hidden');
}

function clearSessionListeners() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
}

$('btn-back').addEventListener('click', () => {
  history.pushState('', document.title, location.pathname + location.search);
  closeSession();
});

function renderSession() {
  const s = state.current;
  if (!s) return;

  $('s-title').textContent = s.title;
  $('s-meta').textContent = [formatDate(s.date) + ' ' + (s.time || ''), s.branch, s.room].filter(Boolean).join('・');
  $('s-note').textContent = s.note || '';

  const total = s.seats?.length || 0;
  const left = total - state.taken.size;

  // 我的劃位
  const box = $('my-booking');
  if (state.myBooking) {
    box.innerHTML = `
      <div>✅ 你已劃位：<span class="seat-tag">${escapeHtml(state.myBooking.seatId)}</span>
        <span class="muted small">（${escapeHtml(state.myBooking.name)}）</span></div>
      ${s.open ? '<button type="button" id="btn-cancel-booking" class="btn small danger">取消劃位</button>'
               : '<span class="muted small">劃位已截止，如需更改請聯絡櫃台</span>'}`;
    box.classList.remove('hidden');
    const btn = $('btn-cancel-booking');
    if (btn) btn.onclick = cancelBooking;
  } else if (!s.open) {
    box.innerHTML = '<div>⛔ 這個場次目前未開放劃位。</div>';
    box.classList.remove('hidden');
  } else {
    box.innerHTML = `<div>剩餘 <b>${left}</b> / ${total} 位，點選空位劃位。</div>`;
    box.classList.remove('hidden');
  }

  renderSeatMap($('seat-map'), s, (id) => {
    if (state.myBooking?.seatId === id) return { state: 'mine' };
    if (state.taken.has(id)) return { state: 'taken' };
    return { state: 'available' };
  }, onSeatClick);
}

function onSeatClick(id, seatState) {
  const s = state.current;
  if (!s) return;
  if (seatState === 'mine') return;
  if (seatState === 'taken') return toast('這個位子已經被劃走了');
  if (seatState !== 'available') return;
  if (!s.open) return toast('這個場次目前未開放劃位');
  if (state.myBooking) return toast(`你已經劃了 ${state.myBooking.seatId}，要換位請先取消劃位`);
  openModal(id);
}

// ---------- 劃位表單 ----------
function openModal(seatId) {
  state.selectedSeat = seatId;
  $('m-seat').textContent = seatId;
  $('m-session').textContent = `${state.current.title}｜${formatDate(state.current.date)} ${state.current.time || ''}`;
  try {
    $('f-name').value = localStorage.getItem('sb_name') || '';
    $('f-phone').value = localStorage.getItem('sb_phone') || '';
  } catch (e) { /* 部分瀏覽器不允許 localStorage */ }
  $('modal').classList.remove('hidden');
  setTimeout(() => $('f-name').focus(), 50);
}

function closeModal() {
  $('modal').classList.add('hidden');
  state.selectedSeat = null;
}

$('m-cancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

$('booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('f-name').value.trim();
  const phone = normalizePhone($('f-phone').value);
  if (!name) return toast('請填寫學生姓名', 'error');
  if (name.length > 20) return toast('姓名最多 20 個字', 'error');
  if (!/^09\d{8}$/.test(phone)) return toast('手機格式不正確，請輸入 09 開頭的 10 碼', 'error');

  const btn = $('m-submit');
  btn.disabled = true;
  btn.textContent = '劃位中…';
  try {
    await bookSeat(state.current.id, state.selectedSeat, name, phone);
    try {
      localStorage.setItem('sb_name', name);
      localStorage.setItem('sb_phone', phone);
    } catch (err) { /* 忽略 */ }
    toast(`劃位成功：${state.selectedSeat}`, 'success');
    closeModal();
  } catch (err) {
    console.error(err);
    toast(bookingErrorMessage(err), 'error');
    if (err.message === 'SEAT_TAKEN') closeModal();
  } finally {
    btn.disabled = false;
    btn.textContent = '確認劃位';
  }
});

async function bookSeat(sid, seatId, name, phone) {
  const uid = state.uid;
  const seatRef = doc(db, 'sessions', sid, 'seats', seatId);
  const bookingRef = doc(db, 'sessions', sid, 'bookings', uid);
  const phoneRef = doc(db, 'sessions', sid, 'phones', phone);

  // Transaction：先確認位子還空著、自己還沒劃過，再一次寫入三份文件
  await runTransaction(db, async (tx) => {
    const seatSnap = await tx.get(seatRef);
    const bookingSnap = await tx.get(bookingRef);
    if (seatSnap.exists()) throw new Error('SEAT_TAKEN');
    if (bookingSnap.exists()) throw new Error('ALREADY_BOOKED');
    tx.set(seatRef, { uid, bookedAt: serverTimestamp() });
    tx.set(bookingRef, { seatId, name, phone, bookedAt: serverTimestamp() });
    tx.set(phoneRef, { uid });
  });
}

function bookingErrorMessage(err) {
  if (err.message === 'SEAT_TAKEN') return '手腳慢了一步，這個位子剛被劃走，請選其他位子';
  if (err.message === 'ALREADY_BOOKED') return '你在這個場次已經劃過位子了';
  if (err.code === 'permission-denied') return '劃位失敗：這支手機在此場次已劃過位，或劃位已截止';
  if (err.code === 'unavailable') return '網路不穩，請稍後再試';
  return '劃位失敗，請稍後再試（' + (err.code || err.message) + '）';
}

async function cancelBooking() {
  const s = state.current;
  const b = state.myBooking;
  if (!s || !b) return;
  if (!confirm(`確定要取消 ${b.seatId} 的劃位嗎？`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'sessions', s.id, 'seats', b.seatId));
    batch.delete(doc(db, 'sessions', s.id, 'bookings', state.uid));
    batch.delete(doc(db, 'sessions', s.id, 'phones', b.phone));
    await batch.commit();
    toast('已取消劃位', 'success');
  } catch (err) {
    console.error(err);
    toast(err.code === 'permission-denied' ? '取消失敗：劃位可能已截止，請聯絡櫃台' : '取消失敗，請稍後再試', 'error');
  }
}

function showNotice(msg, type = 'info') {
  const n = $('notice');
  n.textContent = msg;
  n.className = `notice ${type}`;
}
