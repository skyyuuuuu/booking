# 線上劃位系統（Firebase 版）設定教學

前端放在 GitHub Pages，資料存在 Firebase Firestore，中間不經過 Apps Script。
劃位、取消劃位通常 0.1～0.3 秒內完成；有人劃走位子，其他人的畫面會即時變灰。

---

## 一、檔案說明

```
seat-booking/
├── index.html            前台：家長／學生劃位頁
├── admin.html            後台：新增場次、看名單、匯出
├── firestore.rules       資料庫安全規則（貼到 Firebase）
├── css/style.css         樣式
└── js/
    ├── firebase-config.js   ⚠️ 唯一需要你修改的檔案
    ├── firebase-sdk.js      Firebase 套件（已打包好，不用動）
    ├── common.js            共用功能
    ├── app.js               前台程式
    └── admin.js             後台程式
```

**需要你修改的地方只有兩個：**
1. `js/firebase-config.js`：貼上 Firebase 設定＋管理員 Gmail
2. `firestore.rules`：管理員 Gmail（貼到 Firebase 時改）

---

## 二、設定步驟（第一次大約 20 分鐘）

### 步驟 1：建立 Firebase 專案

1. 打開 <https://console.firebase.google.com>，用你平常的 Gmail 登入（不用另外註冊）。
2. 按「建立專案」（Create a project）。
3. 專案名稱自己取，例如 `seat-booking`。
4. Google Analytics 可以關掉（用不到）。
5. 按「建立專案」，等它跑完後按「繼續」。

> 全程使用免費的 **Spark 方案**，不需要綁信用卡。

### 步驟 2：開啟兩種登入方式

1. 左側選單 → **建構（Build）** → **Authentication** → 按「開始使用」。
2. 上方分頁切到 **Sign-in method（登入方式）**。
3. 點 **匿名（Anonymous）** → 打開「啟用」→ 儲存。
   - 這是給家長／學生用的，他們不用登入，系統會在背景給每台裝置一個身分。
4. 按「新增供應商」→ 選 **Google** → 打開「啟用」→「專案支援電子郵件」選你的 Gmail → 儲存。
   - 這是給你登入後台用的。

### 步驟 3：建立 Firestore 資料庫，貼上安全規則

1. 左側選單 → **建構（Build）** → **Firestore Database** → 按「建立資料庫」。
2. 如果有問版本（Edition），選 **Standard**。
3. 位置選 **asia-east1（台灣）**。⚠️ 這個之後不能改，選台灣速度最快。
4. 選「以正式版模式啟動」（Production mode）→ 建立。
5. 建立完成後，切到上方 **規則（Rules）** 分頁。
6. 把框框裡原本的內容**全部刪掉**，打開本專案的 `firestore.rules`，整份複製貼上。
7. 找到這一行，換成你的 Gmail（要和步驟 4 填的一樣）：
   ```
   'YOUR_ADMIN_EMAIL@gmail.com'
   ```
   如果有多個管理員，用逗號隔開：
   ```
   'aaa@gmail.com', 'bbb@gmail.com'
   ```
8. 按「發布」（Publish）。

### 步驟 4：取得網頁設定，貼進 `firebase-config.js`

1. 左上角「專案總覽」旁邊的 ⚙️ 齒輪 → **專案設定**。
2. 「一般」分頁往下拉到「你的應用程式」，點 **`</>`（網頁）** 圖示。
3. 應用程式暱稱隨便填（例如 `劃位網站`），**不用**勾選 Firebase Hosting → 按「註冊應用程式」。
4. 畫面會出現一段程式碼，找到 `const firebaseConfig = { ... }` 這段，裡面有 6 個值：
   `apiKey`、`authDomain`、`projectId`、`storageBucket`、`messagingSenderId`、`appId`
5. 打開 `js/firebase-config.js`，把這 6 個值逐一貼到對應的「請貼上」位置。
6. 同一個檔案裡，把 `ADMIN_EMAILS` 改成你的 Gmail。
7. 分校清單 `BRANCHES` 已經填好六間分校，要增減直接改。

> 💡 `apiKey` 會出現在公開網頁上是**正常的**，它只是用來辨識專案，不是密碼。
> 資料安全是靠步驟 3 的安全規則把關。

### 步驟 5：（可略過）先在自己電腦上測試

因為程式用了 JS 模組，**直接雙擊 html 檔是打不開的**，需要開一個本機伺服器：

```bash
cd seat-booking
python -m http.server 8000
```

然後用瀏覽器開：
- 後台：<http://localhost:8000/admin.html>
- 前台：<http://localhost:8000/index.html>

（`localhost` 預設就在 Firebase 的授權網域裡，不用另外設定。）

### 步驟 6：上傳到 GitHub Pages

1. 到 GitHub 按右上角「＋」→ **New repository**。
2. 名稱例如 `seat-booking`，選 **Public** → Create repository。
3. 按「uploading an existing file」，把 `seat-booking` 資料夾**裡面的所有東西**（包含 `js`、`css` 兩個資料夾）一起拖進去 → Commit changes。
4. 到 repository 的 **Settings → Pages**：
   - Source 選 **Deploy from a branch**
   - Branch 選 **main**、資料夾 **/ (root)** → Save
5. 等 1～2 分鐘，網址會是：
   `https://skyyuuuu.github.io/seat-booking/`
6. ⚠️ **回到 Firebase**：Authentication → **設定（Settings）** 分頁 → **授權網域（Authorized domains）** → 新增網域 → 填 `skyyuuuu.github.io` → 新增。
   - 沒做這步，後台的 Google 登入會失敗。

### 步驟 7：開第一個場次

1. 打開 `https://skyyuuuu.github.io/seat-booking/admin.html`，用 Google 登入。
2. 按「＋ 新增場次」，填名稱、日期、時間、分校、教室。
3. 設定座位：排數、每排座位數、走道位置。
4. 在預覽圖上點一下座位，可以把它設成「不設座位」（例如柱子旁邊的位置）。
5. 勾「儲存後立即開放劃位」→ 儲存。
6. 在場次列表按「連結」，網址就複製好了，可以直接貼到 LINE 群組。
   - 這個連結會直接打開該場次的座位圖。
   - 也可以只給首頁網址 `https://skyyuuuu.github.io/seat-booking/`，家長自己選場次。

### 步驟 8：驗收清單

上線前建議照著試一次：

- [ ] 兩支手機同時點同一個位子 → 只有一支成功，另一支顯示「這個位子剛被劃走」
- [ ] 同一支手機號碼，用另一台裝置再劃一次 → 被擋下
- [ ] 劃好之後再點其他空位 → 提示要先取消
- [ ] 取消劃位 → 位子馬上變回可劃位（其他手機畫面也會跟著變）
- [ ] 後台「關閉劃位」→ 前台不能劃位，也不能自己取消
- [ ] 後台按「名單」看得到姓名和電話，按「匯出 CSV」可以下載
- [ ] 用沒在名單裡的 Gmail 登入後台 → 顯示沒有權限

---

## 三、日常操作

| 想做的事 | 在哪裡做 |
|---|---|
| 開新場次 | 後台 → 新增場次 |
| 每週同一堂課 | 後台 → 該場次按「複製」，改日期就好（複製出來的場次預設不開放） |
| 開放／截止劃位 | 後台 → 「開放劃位／關閉劃位」 |
| 看誰劃了哪裡 | 後台 → 「名單」（座位圖上直接顯示姓名，滑鼠移上去看電話） |
| 幫家長取消或換位 | 後台 → 名單 → 「取消」，再請家長重新劃位 |
| 匯出到 Google 試算表 | 名單 → 匯出 CSV → 在 Google 試算表選「檔案 → 匯入」 |
| 調整教室座位 | 後台 → 編輯（已有人劃位的座位不能刪掉，要先取消那筆劃位） |

---

## 四、資料怎麼存（給之後維護用）

```
sessions/{場次ID}                場次資料（名稱、日期、座位配置、是否開放）— 公開
  ├─ seats/{座位代號}             例如 B3。文件存在＝已被劃走，只記錄 uid — 公開
  ├─ bookings/{uid}              姓名、電話、座位 — 只有本人與管理員看得到
  └─ phones/{手機號碼}            用來擋同一支手機重複劃位 — 只有管理員看得到
```

**防止重複劃位的原理：**
劃位時會用一次 transaction 同時寫入 `seats`、`bookings`、`phones` 三份文件。
安全規則規定這三份**只能新建、不能覆蓋**，所以：
- 同一個座位只會有一個人成功（座位文件已存在就失敗）
- 同一台裝置每場次只能劃一個（bookings 用 uid 當 ID）
- 同一支手機每場次只能劃一個（phones 用手機號碼當 ID）

三份文件要嘛一起成功、要嘛一起失敗，不會出現只寫了一半的狀況。

---

## 五、常見問題

**Q：前台顯示「尚未啟用匿名登入」**
→ 回步驟 2，確認 Anonymous 有打開。

**Q：前台顯示「讀取場次失敗」**
→ 回步驟 3，確認 Firestore 已建立，而且規則有按「發布」。

**Q：後台 Google 登入跳出錯誤 `auth/unauthorized-domain`**
→ 回步驟 6 第 6 點，把 `skyyuuuu.github.io` 加進授權網域。

**Q：後台登入成功，但顯示「讀取失敗」**
→ `firestore.rules` 裡的 email 跟你登入的 Gmail 不一樣，改好之後要再按一次「發布」。

**Q：家長換了手機，看不到自己的劃位、也不能取消**
→ 劃位身分是存在原本那台裝置的瀏覽器裡。請在後台幫他取消，再請他重新劃位。

**Q：免費額度夠用嗎？**
→ 免費額度是每天 5 萬次讀取、2 萬次寫入（每天下午 3～4 點，也就是太平洋時間午夜重置）。
以一個 40 人的場次估算，就算 200 人各打開一次頁面，大約也只用掉 1 萬次讀取，一般補習班的用量遠低於上限。
可以在 Firebase Console → Firestore → **用量（Usage）** 看實際數字。

**Q：會不會有人亂填假名字佔位？**
→ 不用登入就能劃位，方便但也有這個風險。同一支手機已經限制只能劃一個位子；如果真的遇到，後台可以直接取消。
之後如果需要，可以改成「必須先在名單內的學生才能劃位」。

**Q：之後要改功能怎麼更新？**
→ 只要把有改動的檔案重新上傳到 GitHub（同名檔案直接覆蓋），1～2 分鐘後就會生效。
`firebase-config.js` 已經填好的話就不要覆蓋掉。
