import { initializeApp, getAuth, getFirestore } from './firebase-sdk.js';
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

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

export function sessionSortKey(s) {
  return `${s.date || ''} ${s.time || ''}`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  const w = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${w}）`;
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
