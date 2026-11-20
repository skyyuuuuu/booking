// ============================================================
// ⚠️ 唯一需要你修改的 JS 檔
// 1. 把 Firebase Console 給你的 firebaseConfig 整段貼進來（取代下面的範例）
// 2. 把 ADMIN_EMAILS 改成管理員的 Gmail（要和 firestore.rules 裡的一致）
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDMcRzvd9lJ9FXAuDq6sPDdBeiUSYr3Qf8",
  authDomain: "booking-67def.firebaseapp.com",
  projectId: "booking-67def",
  storageBucket: "booking-67def.firebasestorage.app",
  messagingSenderId: "994106422150",
  appId: "1:994106422150:web:4f440e83a2a783c6213207"
};

// 可以進後台的帳號（只影響畫面顯示；真正的權限由 firestore.rules 把關）
export const ADMIN_EMAILS = [
  "yxl.8503@gmail.com"
];

// 後台新增場次時的分校選單
export const BRANCHES = [
  "愛學館培英校",
  "愛學館光武校",
  "拓人建功校",
  "愛學館科園校",
  "愛學館成功校",
  "愛學館東興校"
];
