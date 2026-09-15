# LINE → AI 分類 → Notion

傳連結給 LINE Bot，背後自動抓取內文、AI 分類打標籤、存進 Notion 資料庫，並回覆分類結果與 Notion 連結。之後也能用 LINE 搜尋、修改、刪除已存的筆記。

全程使用免費額度：Cloudflare Workers、LINE Messaging API（Reply 不計費）、OpenRouter 免費模型（三層 fallback）、Notion API、Jina Reader（帶專屬 API Key）。

---

## 功能一覽

### 存筆記
傳一則含網址的訊息即可：

```
https://example.com/article 這篇之後可以引用
```

網址以外的文字會當作備註一併餵給 AI。AI 會判斷分類、產生 2-4 個標籤、寫 2-3 句摘要，存進 Notion。**重複網址不會產生重複資料**——會更新既有頁面而不是新增一筆。

### 搜尋
傳關鍵字（分類名稱、標籤、標題片段皆可）即可搜尋：

```
投資理財
```

其他關鍵字指令：

| 傳送內容 | 效果 |
|---|---|
| `說明` / `help` | 顯示使用說明與目前分類清單 |
| `最近存的` | 列出最新 5 筆（不限分類） |
| `待辦清單` | 列出所有標記待辦的筆記 |
| `依分類搜尋` | 跳出分類按鈕（Quick Reply），點選後直接查詢 |

### 對已存筆記的操作
把 bot 回覆的 Notion 連結（或原始文章網址）貼回來，前面加上指令：

| 指令 | 效果 |
|---|---|
| `刪除 <連結>` | 移進 Notion 垃圾桶（30 天內可救回，非永久刪除） |
| `註記 <連結> 你的文字` | 把備註加到 Notion 頁面內容，可重複加不覆蓋 |
| `分類 <連結> 分類名稱` | 手動覆蓋分類，**不限於固定清單**，可自訂 |
| `待辦 <連結>` / `取消待辦 <連結>` | 標記／取消待辦 |

### 圖文選單
六格版面：說明、待辦清單、最近存的、依分類搜尋、開啟 Notion、（品牌裝飾格）。點擊即傳送對應指令，設定方式見下方「LINE 設定」。

### 其他體驗細節
- 處理期間會顯示 LINE 輸入中動畫（僅手機版支援，電腦版 LINE 不會顯示，屬平台限制非 bug）。
- 只服務指定的 `OWNER_USER_ID`，其他人傳訊息會被靜默忽略，避免好友連結外流導致額度或資料被濫用。
- AI 產生標籤前會先讀取資料庫既有標籤，優先重複使用相同概念的詞，減少「AI」「AI應用」「AI工具」這類同義詞發散。
- 抓不到網頁內文的網站（Facebook、Instagram 等擋爬蟲平台）會優雅降級：只憑網址與備註分類，仍會存檔而不是整段失敗。

---

## 專案結構

```
line-notion-bot/
├── src/
│   └── index.js       # 全部邏輯：webhook、AI 分類、Notion 讀寫、LINE 回覆
├── wrangler.toml       # Cloudflare Workers 設定（AI_MODELS 等非機密變數）
└── README.md
```

---

## 部署

### 一、建立 Notion 資料庫

Database（Table view）欄位，**名稱要與 `src/index.js` 開頭 `PROP` 物件一字不差**：

| 欄位名稱 | 型態 |
|---|---|
| 標題 | Title |
| 分類 | Select |
| 標籤 | Multi-select |
| 連結 | URL |
| 摘要 | Text |
| 待辦 | Checkbox |

到 [Notion Integrations](https://www.notion.so/my-integrations) 建立 Personal Access Token，取得 Secret（`ntn_...`）與 Database ID（資料庫網址中 32 碼那段）。Personal Access Token 不需要額外做「Connections」設定，會自動繼承你帳號能存取的所有內容。

### 二、建立 LINE Messaging API Channel

現行流程（LINE 已不能直接在 Developers Console 建立 Messaging API channel）：

1. 到 [LINE Official Account Manager](https://manager.line.biz) 建立官方帳號
2. 在該帳號「設定 → Messaging API」啟用 Messaging API，選擇/建立 Provider
3. 啟用後即可在此頁拿到 **Channel ID**、**Channel secret**
4. 回到 [LINE Developers Console](https://developers.line.biz/console/)，找到剛才的 channel → Messaging API 分頁 → 簽發 **Channel access token（long-lived）**
5. 同一頁把 **Auto-reply messages** 和 **Greeting messages** 關閉（在 Official Account Manager 的「回應設定」頁），避免 LINE 制式回覆蓋過 bot 的回覆

### 三、取得 OpenRouter API Key

[openrouter.ai/keys](https://openrouter.ai/keys) 註冊後建立。免費模型清單參考 [openrouter.ai/models?max_price=0](https://openrouter.ai/models?max_price=0)。

### 四、取得 Jina Reader API Key

[jina.ai/reader](https://jina.ai/reader) 登入後在 dashboard 取得。不帶 Key 的話額度是每分鐘 20 次且**跟全世界共用 Cloudflare Workers 出口 IP**，非常容易被打滿；帶 Key 後是每分鐘 100 次的專屬額度。

### 五、部署到 Cloudflare Workers

```bash
npm install -g wrangler
wrangler login

cd line-notion-bot

wrangler secret put LINE_CHANNEL_SECRET
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
wrangler secret put OPENROUTER_API_KEY
wrangler secret put MISTRAL_API_KEY  # 選填，有設定的話 AI 分類會優先打 Mistral，失敗才退回 OpenRouter
wrangler secret put JINA_API_KEY
wrangler secret put NOTION_TOKEN
wrangler secret put NOTION_DATABASE_ID
wrangler secret put OWNER_USER_ID   # 你自己的 LINE userId，見下方說明

wrangler deploy
```

部署完會拿到網址，例如 `https://line-notion-bot.<你的帳號>.workers.dev`。

**取得 `OWNER_USER_ID`：** 先不設定這個 secret，部署後跑 `wrangler tail`，等畫面顯示「Connected!」後用手機傳一則訊息給 bot，log 會印出 `userId: U開頭一串英數字`，複製後再補設定這個 secret 並重新 deploy。

### 六、設定 Webhook

回 LINE Developers Console 的 Messaging API 分頁，把 Worker 網址貼到 Webhook URL，按 **Verify** 確認成功，再打開 **Use webhook** 開關。

若剛註冊的 `workers.dev` 子網域顯示 SSL 連線錯誤，通常是 DNS 剛生效需要幾分鐘傳播，稍等後重試 Verify 即可。

### 七、（選用）設定圖文選單

LINE Official Account Manager →「圖文選單」→ 建立，六格動作類型設定：

| 格子 | 類型 | 內容 |
|---|---|---|
| 說明 | 文字 | `說明` |
| 待辦清單 | 文字 | `待辦清單` |
| 最近存的 | 文字 | `最近存的` |
| 依分類搜尋 | 文字 | `依分類搜尋` |
| 開啟 Notion | 連結 | 你的 Notion 資料庫網址 |
| （裝飾格） | 不設定 | — |

---

## 環境變數 / Secrets 總覽

| 名稱 | 類型 | 說明 |
|---|---|---|
| `AI_MODELS` | `[vars]`（非機密） | OpenRouter fallback 模型陣列，上限 3 個 |
| `LINE_CHANNEL_SECRET` | secret | LINE webhook 簽章驗證用 |
| `LINE_CHANNEL_ACCESS_TOKEN` | secret | LINE Reply / 輸入動畫 API 用 |
| `OPENROUTER_API_KEY` | secret | AI 分類（fallback，Mistral 沒設定或失敗時使用） |
| `MISTRAL_API_KEY` | secret（選填） | AI 分類，設定後優先使用（`mistral-medium-latest`） |
| `JINA_API_KEY` | secret | 網頁內文抓取，未設定則退化為共用限流 |
| `NOTION_TOKEN` | secret | Notion Personal Access Token |
| `NOTION_DATABASE_ID` | secret | 目標資料庫 ID |
| `OWNER_USER_ID` | secret | 你的 LINE userId，未設定則不限制任何人使用 |

---

## 自訂

- **分類清單**：改 `src/index.js` 開頭的 `CATEGORIES` 陣列。加新分類不影響舊資料，Notion Select 欄位會自動新增選項。
- **Notion 欄位名稱**：改 `PROP` 物件，要跟 Notion 資料庫實際欄位名稱一致。
- **AI 模型**：改 `wrangler.toml` 的 `AI_MODELS` 陣列（最多 3 個，OpenRouter 限制）。
- **除錯**：`wrangler tail` 可即時看執行 log。

## 已知限制

- LINE 電腦版不支援輸入中動畫，僅手機版會顯示。
- 圖文選單裡「連結」類型動作在 LINE 內建瀏覽器開啟，不會自動跳轉到對應 App（如 Notion App）；使用者需要手動點內建瀏覽器選單裡的「在瀏覽器中開啟」才會觸發系統瀏覽器的跳轉機制，這是 LINE／各家 App 內建瀏覽器的通用限制，非本專案問題。
- 搜尋類指令目前抓最近 100 筆資料做比對，資料量成長到數千筆後可能需要改用分頁查詢。
- Facebook / Instagram / Threads 等平台會擋外部爬蟲，抓不到內文時僅能憑網址與備註分類，摘要品質有限。
