import {
  initializeApp, getAuth, getFirestore,
  collection, doc, runTransaction, writeBatch, serverTimestamp
} from './firebase-sdk.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const configMissing = !firebaseConfig.projectId || firebaseConfig.projectId.includes('請貼上');

// A, B, ... Z
export const rowLabel = (i) => String.fromCharCode(65 + i);

// 依排數、列數、停用座位產生合法座位清單
export function buildSeatList(rows, cols, disabled = []) {
  const off = new Set(disabled);
  const list = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const id = rowLabel(r) + c;
      if (!off.has(id)) list.push(id);
    }
  }
  return list;
}

// "4, 8" -> [4, 8]
export function parseNumberList(text) {
  return String(text || '')
    .split(/[,，\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function normalizePhone(text) {
  return String(text || '').replace(/\D/g, '');
}

// 姓名去掉所有空白（全形、半形），避免「王 小明」和「王小明」被當成兩個人
export function normalizeName(text) {
  return String(text || '').replace(/[\s\u3000]/g, '');
}

export const isValidPhone = (phone) => /^09\d{8}$/.test(phone);

// 繳費序號：全形轉半形、去掉空白、英文轉大寫，只允許英數字和 -
export function normalizeSerial(text) {
  return String(text || '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
}
export const isValidSerial = (serial) => /^[A-Z0-9-]{3,30}$/.test(serial);

// 學生代碼：繳費序號_學生姓名（和 firestore.rules 的規則一致）
export function studentKey(name, serial) {
  return `${normalizeSerial(serial)}_${normalizeName(name)}`;
}

/**
 * 幫學生劃位或換位（前台、後台共用）
 * 一次 transaction 完成：確認新位子空著 → 有舊位子就一起釋放 → 寫入新位子
 */
export async function takeSeat(cid, student, seatId) {
  const { key, name, serial } = student;
  const seatRef = doc(db, 'classes', cid, 'seats', seatId);
  const holderRef = doc(db, 'classes', cid, 'holders', key);
  const bookingRef = doc(collection(db, 'classes', cid, 'bookings'));
  const bid = bookingRef.id;

  await runTransaction(db, async (tx) => {
    const seatSnap = await tx.get(seatRef);
    const holderSnap = await tx.get(holderRef);
    const old = holderSnap.exists() ? holderSnap.data() : null;
    if (old && old.seatId === seatId) throw new Error('SAME_SEAT');
    if (seatSnap.exists()) throw new Error('SEAT_TAKEN');
    if (old) {
      tx.delete(doc(db, 'classes', cid, 'seats', old.seatId));
      tx.delete(doc(db, 'classes', cid, 'bookings', old.bid));
    }
    tx.set(seatRef, { bid, bookedAt: serverTimestamp() });
    tx.set(bookingRef, { key, seatId, name, serial, bookedAt: serverTimestamp() });
    tx.set(holderRef, { bid, seatId });
  });
}

/** 取消某個學生的座位（前台、後台共用） */
export async function releaseSeat(cid, key, holder) {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'classes', cid, 'seats', holder.seatId));
  batch.delete(doc(db, 'classes', cid, 'bookings', holder.bid));
  batch.delete(doc(db, 'classes', cid, 'holders', key));
  await batch.commit();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// 班級排序：學期新的在前，同學期依分校、名稱
export function classSort(a, b) {
  return String(b.term || '').localeCompare(String(a.term || ''))
    || String(a.branch || '').localeCompare(String(b.branch || ''))
    || String(a.title || '').localeCompare(String(b.title || ''));
}

// ---------- 課程類型與期間 ----------
export const CLASS_TYPES = [
  { value: 'regular', label: '常態班' },
  { value: 'short', label: '短期課程' },
  { value: 'exam', label: '模擬考' },
  { value: 'other', label: '其他' }
];
export const typeLabel = (t) => (CLASS_TYPES.find((x) => x.value === (t || 'regular')) || CLASS_TYPES[0]).label;

// 台灣時間的今天，格式 YYYY-MM-DD
export function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// 2027-01-20 → 1/20；跨年才顯示年份
function shortDate(d, withYear) {
  const [y, m, dd] = String(d).split('-').map(Number);
  return withYear ? `${y}/${m}/${dd}` : `${m}/${dd}`;
}
export function dateRange(c) {
  const s = c.startDate || '';
  const e = c.endDate || '';
  if (!s && !e) return '';
  const thisYear = todayStr().slice(0, 4);
  const withYear = (s && s.slice(0, 4) !== thisYear) || (e && e.slice(0, 4) !== thisYear) || (s && e && s.slice(0, 4) !== e.slice(0, 4));
  if (s && e && s === e) return shortDate(s, withYear);
  if (s && e) return `${shortDate(s, withYear)}–${shortDate(e, withYear)}`;
  return s ? `${shortDate(s, withYear)} 起` : `至 ${shortDate(e, withYear)}`;
}

// 課程狀態：upcoming 未開始 / running 進行中 / ended 已結束 / archived 已封存
export function periodStatus(c, today = todayStr()) {
  if (c.archived) return 'archived';
  if (c.endDate && today > c.endDate) return 'ended';
  if (c.startDate && today < c.startDate) return 'upcoming';
  return 'running';
}
export const PERIOD_LABEL = { upcoming: '未開始', running: '進行中', ended: '已結束', archived: '已封存' };

// 家長端是否還要顯示：封存的、或過了結束日的都不顯示
export const visibleToParents = (c) => !c.archived && !(c.endDate && todayStr() > c.endDate);

export function classMeta(c) {
  return [c.term, dateRange(c), c.schedule, c.branch, c.room].filter(Boolean).join('・');
}

// 座位代號排序：A1, A2, ..., A10, B1
export function seatOrder(a, b) {
  const ra = a.charCodeAt(0), rb = b.charCodeAt(0);
  return ra !== rb ? ra - rb : parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
}

/**
 * 畫出座位圖
 * @param {HTMLElement} el
 * @param {{rows:number, cols:number, aisles:number[], seats:string[]}} layout
 * @param {(id:string)=>{state:string, label?:string, title?:string}} seatInfo
 *        state: available | taken | mine | selected | disabled
 * @param {(id:string, state:string)=>void} onClick
 * @param {{allCells?:boolean}} opts  allCells: 每一格都交給 seatInfo 決定（後台編輯座位用）
 */
export function renderSeatMap(el, layout, seatInfo, onClick, opts = {}) {
  const valid = new Set(layout.seats || []);
  const aisles = new Set(layout.aisles || []);
  let html = '<div class="stage">講 台</div><div class="seat-grid">';
  for (let r = 0; r < layout.rows; r++) {
    html += `<div class="seat-row"><span class="row-label">${rowLabel(r)}</span>`;
    for (let c = 1; c <= layout.cols; c++) {
      const id = rowLabel(r) + c;
      const info = (opts.allCells || valid.has(id)) ? seatInfo(id) : { state: 'disabled' };
      const label = info.label ?? id;
      const title = info.title ?? id;
      html += `<button type="button" class="seat ${info.state}" data-id="${id}" data-state="${info.state}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
      if (aisles.has(c) && c < layout.cols) html += '<span class="aisle"></span>';
    }
    html += `<span class="row-label">${rowLabel(r)}</span></div>`;
  }
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('.seat').forEach((btn) => {
    btn.addEventListener('click', () => onClick && onClick(btn.dataset.id, btn.dataset.state));
  });
}

export function toast(msg, type = 'info') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.className = `show ${type}`;
  clearTimeout(box._t);
  box._t = setTimeout(() => (box.className = ''), 3200);
}
