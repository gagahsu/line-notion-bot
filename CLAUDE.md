# CLAUDE.md

給 Claude Code（或其他 AI coding agent）快速掌握這個專案的架構、慣例、易踩的坑。人類使用者請看 README.md。

## 專案是什麼

單一 Cloudflare Worker（`src/index.js`，無框架、無建置流程），接收 LINE Messaging API 的 webhook，依訊息內容分流到「存筆記」「搜尋」「對筆記的指令操作」三種流程，寫入/讀取 Notion 資料庫，並用 LINE Reply API 回覆。沒有資料庫、沒有 KV、沒有任何持久化狀態——每個 request 都是無狀態的，所有「記憶」都存在 Notion 裡。

## 核心資料流

```
LINE webhook (POST /)
  → 驗證簽章 (verifySignature)
  → ctx.waitUntil(handleEvents) 立刻回 200，背景處理
  → handleTextMessage 依內容分流：
      有「指令關鍵字 + 網址」→ handleCommand（刪除/註記/分類/待辦）
      無網址 → handleSearch（搜尋 / 說明 / 最近存的 / 待辦清單 / 依分類搜尋）
      有網址（且非指令）→ 存筆記流程：fetchReadable → classify → createNotionPage
```

## 檔案結構

只有一個檔案：`src/index.js`。目前分成這些區塊（用 `// ---------- 區塊名 ----------` 分隔）：

1. 可自訂區（`CATEGORIES`、`PROP`、`MAX_CONTENT_CHARS`）
2. 入口（`fetch` handler）
3. LINE 簽章驗證
4. 事件處理（`handleEvents`、`handleTextMessage`）
5. 搜尋（`handleSearch`、`searchNotion`、`handleRecent`、`handleTodoList`）
6. 指令：刪除/註記/分類/待辦（`parseCommand`、`handleCommand`、`resolvePageId` + 各動作函式）
7. 抓取網頁內容（`fetchReadable`）
8. AI 分類（`getExistingTags`、`classify`）
9. 寫入 Notion（`createNotionPage`、`findPageByUrl`）
10. 輸入中動畫（`showLoadingAnimation`）
11. 回覆 LINE（`reply`）

改動時盡量維持這個順序與分區風格，方便之後用區塊註解快速定位。

## 關鍵設計決策（改動前務必知道）

- **Notion select/multi_select 篩選有雷**：`filter` 用 `select.equals` 或 `multi_select.contains` 時，若給的值不是資料庫裡「已存在的選項」，Notion API 直接回 400（即使包在 `or` 裡也一樣不會跳過）。所以 `searchNotion` 刻意不用 API 篩選，改成抓一批資料（`page_size: 100`，依 `created_time` 排序）回來後在 JS 裡用 `.includes()` 做部分符合比對。`handleTodoList` 例外，因為 checkbox 的 `equals: true/false` 不受此限制，可以放心用 API filter。

- **指令解析要求「關鍵字 + 網址」同時出現**：`parseCommand` 只有在文字裡抓得到 URL 才會判定為指令（見 `COMMANDS` 陣列），沒有 URL 就會落到 `handleSearch`。這代表「待辦」單獨傳送 → 觸發「列出待辦清單」；「待辦 <url>」→ 觸發「標記這篇待辦」。兩者關鍵字重複但語意不同是刻意設計，不是 bug。`COMMANDS` 陣列裡 `取消待辦` 必須排在 `待辦` 前面，因為判斷用 `startsWith`。

- **`resolvePageId` 支援兩種輸入**：Notion 頁面連結（從網址尾端 32 碼 hex 直接取 page ID，正則 `/([a-f0-9]{32})(?:[?#]|$)/i`）或原始文章網址（查 `連結` 欄位 `url.equals`，這個篩選類型不受上面提到的 select 限制影響，可以放心用 API filter）。

- **`createNotionPage` 會先查重**：寫入前呼叫 `findPageByUrl`（跟 `resolvePageId` 邏輯重複但獨立實作，因為輸入只會是原始網址不是 Notion 連結，未來如果要重構可以合併）。查到既有頁面就 PATCH 更新 properties + 額外 append 一段「（重新分類更新）」的 block，查不到才 POST 新建。回傳值是 `{ url, updated }` 物件，不是純字串，呼叫端要注意。

- **AI 分類呼叫分兩層：Mistral 直連優先，OpenRouter 陣列保底**（`callAI`／`callMistral`／`callOpenRouter`，`src/index.js` 分類區塊）。有設定 `MISTRAL_API_KEY` 就先打 Mistral 官方 API（`model: 'mistral-medium-latest'`，用自己帳號的免費額度），失敗（含未設定 Key）才退回 OpenRouter。這是因為免費 Llama 模型偶爾會不照指示輸出 JSON，回傳類似安全審查標記的字串（例如 `User Safety: safe`）導致三層 JSON 解析全失敗，換成 Mistral 能大幅降低這個機率。
- **OpenRouter 那層呼叫用 `models` 陣列而非 `model` 字串**：OpenRouter 的 fallback 機制，見 `wrangler.toml` 的 `AI_MODELS`。**硬限制是最多 3 個**，超過會 400（`'models' array must have 3 items or fewer.`）。免費模型常無預警下架，陣列最後一個固定放 `openrouter/free`（自動選型）當保底。Mistral 官方 API 不支援這種多模型 fallback 陣列，所以只能用一個 `model` 字串，且獨立於 OpenRouter 陣列之外。

- **`classify` 的 JSON 解析有三層容錯**：直接 parse → 去除 markdown fence 後 parse → 正則抓 `{...}` 片段 parse → 全部失敗就把 AI 原始回應片段（前 300 字）塞進錯誤訊息裡回給使用者，方便不查 log 也能診斷。改這段時保留這個「失敗也要給診斷資訊」的原則。

- **`getExistingTags` 抓最近 100 筆的標籤去重**，餵進 `classify` 的 system prompt 引導 AI 優先複用既有標籤、避免同義詞發散（「AI」「AI應用」「AI工具」這種）。這一步失敗（catch 內）回傳空陣列，不影響主流程——標籤複用是體驗優化，不是關鍵路徑。

- **`fetchReadable` 失敗有 call site 層級的優雅降級**：`handleTextMessage` 裡包了一層 try/catch，抓不到內文（常見於 Facebook/Instagram 等擋爬蟲網站）不會讓整個存檔流程失敗，改用一段固定文字取代 content 繼續跑分類，讓筆記至少能被存下來（僅憑網址與使用者備註分類）。

- **`OWNER_USER_ID` 是白名單機制**，在 `handleEvents` 最上層做，比對 `event.source?.userId`。**這個 secret 是選填的**——沒設定的話任何人都能用（部署後、還沒查到自己 userId 前的過渡期會是這個狀態，要提醒使用者盡快補設定）。

- **`reply` 支援可選的 Quick Reply**：第四參數 `quickReplyLabels`（字串陣列，上限 13 個，LINE API 限制）。目前只有「依分類搜尋」用到，動態帶入 `CATEGORIES` 陣列。

- **`showLoadingAnimation` 只在手機版 LINE 生效**，這是 LINE 平台限制不是程式邏輯問題，失敗會被靜默吞掉（不影響主流程），別因為看到這個函式沒處理錯誤就當成疏漏。

## 已知的技術債 / 未來可能要處理

- `searchNotion` / `handleRecent` / `handleTodoList` / `getExistingTags` 都是各自獨立查詢 Notion API、各自 100 筆上限，資料量大了之後（幾千筆等級）需要改分頁或换用更精準的 API filter 策略（但要避開上面提到的 select 篩選雷）。
- `findPageByUrl` 和 `resolvePageId` 有邏輯重複，可考慮合併。
- 沒有任何自動化測試。改動後建議至少手動測：存新連結、存重複連結（應更新非新增）、搜尋、四種指令（刪除/註記/分類/待辦）、Facebook 類網站降級路徑。
- LINE 圖文選單的動作內容（六格文字/連結）是在 LINE Official Account Manager 後台手動設定的，**不在這個 repo 的版控範圍內**，改 `CATEGORIES` 或指令關鍵字時要記得圖文選單那邊沒有連動，需要另外手動確認。

## 部署 / 除錯

沒有 CI，純手動 `wrangler deploy`。改完程式碼務必提醒使用者這一步，不會自動生效。即時 log 用 `wrangler tail`（一定要等它顯示 `Connected!` 之後的訊息才抓得到）。

Secrets 用 `wrangler secret put <NAME>`，不要寫進 `wrangler.toml`（那個檔案只放非機密的 `[vars]`，目前只有 `AI_MODELS`）。
