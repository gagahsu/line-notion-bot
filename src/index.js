/**
 * LINE Bot → AI 分類 → Notion 稍後閱讀系統
 * 部署平台：Cloudflare Workers（免費方案）
 */

// ---------- 可自訂區 ----------

// 你的分類體系，改這裡就好（要跟 Notion 的 select 選項一致，或讓 Notion 自動建立）
const CATEGORIES = [
  '投資理財',
  '技術開發',
  '教學課程',
  '英文學習',
  '工具資源',
  '旅遊',
  '生活其他',
];

// Notion 資料庫的欄位名稱，要跟你實際建立的一字不差
const PROP = {
  title: '標題',
  category: '分類',
  tags: '標籤',
  url: '連結',
  summary: '摘要',
  todo: '待辦',
};

// 丟給 AI 的內文長度上限（避免 token 爆掉）
const MAX_CONTENT_CHARS = 6000;

// ---------- 入口 ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('LINE → Notion bot is running.');
    }

    const body = await request.text();
    const signature = request.headers.get('x-line-signature');

    if (!(await verifySignature(env.LINE_CHANNEL_SECRET, body, signature))) {
      return new Response('Unauthorized', { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // 關鍵：立刻回 200，處理丟到背景，避免 LINE webhook 超時
    ctx.waitUntil(handleEvents(payload.events || [], env));

    return new Response('OK');
  },
};

// ---------- LINE 簽章驗證 ----------

async function verifySignature(secret, body, signature) {
  if (!secret || !signature) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // 長度相同才逐字元比對，避免時序差異
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ---------- 事件處理 ----------

async function handleEvents(events, env) {
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;

    console.log('userId:', event.source?.userId);

    // 只服務你自己，避免任何加到好友的人都能用你的額度寫入你的 Notion
    if (env.OWNER_USER_ID && event.source?.userId !== env.OWNER_USER_ID) {
      continue;
    }

    await handleTextMessage(event, env);
  }
}

async function handleTextMessage(event, env) {
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // 讓使用者看到「輸入中...」動畫，處理完送出回覆時會自動消失，
  // 不會再有「已讀但不知道是在跑還是沒反應」的空窗期。
  await showLoadingAnimation(env, event.source?.userId);

  // 指令優先判斷：刪除 / 註記 / 待辦（取消待辦要先判斷，避免被「待辦」關鍵字比對截胡）
  const command = parseCommand(text);
  if (command) {
    await handleCommand(env, replyToken, command);
    return;
  }

  const match = text.match(/https?:\/\/[^\s]+/);

  // 沒有網址 → 當作搜尋關鍵字（例如傳「投資理財」或任何字詞）
  if (!match) {
    await handleSearch(env, replyToken, text);
    return;
  }

  const url = match[0];
  // 網址以外的文字視為你自己的備註，一併餵給 AI
  const userNote = text.replace(url, '').trim();

  try {
    let content = '';
    try {
      content = await fetchReadable(url, env);
    } catch (fetchErr) {
      // Facebook / Instagram / Threads 等平台常擋爬蟲，抓不到內文時退化成只憑網址與備註分類，
      // 不整段失敗，讓筆記至少能被存下來。
      content = '(此網頁無法自動讀取內文，可能為需要登入的社群平台)';
    }
    const existingTags = await getExistingTags(env);
    const result = await classify(env, { url, content, userNote, existingTags });
    const saved = await createNotionPage(env, { ...result, url });

    const lines = [
      saved.updated ? `🔄 ${result.title}（已更新既有筆記）` : `✅ ${result.title}`,
      `分類：${result.category}`,
      result.tags?.length ? `標籤：${result.tags.join('、')}` : null,
      '',
      result.summary,
      '',
      saved.url,
    ].filter((l) => l !== null);

    await reply(env, replyToken, lines.join('\n'));
  } catch (err) {
    await reply(env, replyToken, `⚠️ 處理失敗：${err.message}\n原始連結已保留：${url}`);
  }
}

// ---------- 搜尋 ----------

async function handleSearch(env, replyToken, keyword) {
  // 空字串或純指令字（例如「幫助」）給使用說明
  if (!keyword || ['help', '說明', '幫助'].includes(keyword.toLowerCase())) {
    const helpText = [
      '📌 使用說明',
      '直接傳網址：我會分類並存進 Notion。',
      '傳分類或關鍵字（例如「投資理財」）：我會列出符合的筆記。',
      '傳「最近存的」：列出最新幾筆筆記。',
      '傳「待辦清單」：列出標記待辦的筆記。',
      '傳「依分類搜尋」：列出所有分類，再輸入想查的分類名稱。',
      '',
      '對已存的筆記，把它的連結貼回來並加上指令：',
      '「刪除 <連結>」→ 移進 Notion 垃圾桶',
      '「註記 <連結> 你的備註文字」→ 加註記到頁面內容',
      '「分類 <連結> 分類名稱」→ 改分類（可自訂，不限固定清單）',
      '「待辦 <連結>」→ 標記待辦；「取消待辦 <連結>」→ 取消',
      '',
      `目前分類：${CATEGORIES.join('、')}`,
    ].join('\n');
    await reply(env, replyToken, helpText);
    return;
  }

  // 「最近存的」→ 不限分類，列出最新幾筆
  if (['最近存的', '最近', 'recent'].includes(keyword.toLowerCase())) {
    await handleRecent(env, replyToken);
    return;
  }

  // 「待辦清單」→ 列出所有標記待辦的筆記
  if (['待辦清單', '待辦', 'todo', 'todolist'].includes(keyword.toLowerCase())) {
    await handleTodoList(env, replyToken);
    return;
  }

  // 「依分類搜尋」→ 用 Quick Reply 按鈕列出全部分類，點一下就直接查詢
  if (['依分類搜尋', '分類', 'category'].includes(keyword.toLowerCase())) {
    await reply(env, replyToken, '📂 請選擇想查的分類：', CATEGORIES);
    return;
  }

  try {
    const results = await searchNotion(env, keyword);

    if (results.length === 0) {
      await reply(env, replyToken, `找不到跟「${keyword}」相關的筆記。`);
      return;
    }

    const lines = [`🔍「${keyword}」找到 ${results.length} 筆：`, ''];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}（${r.category}）`);
      lines.push(r.url);
      lines.push('');
    });

    await reply(env, replyToken, lines.join('\n').trim());
  } catch (err) {
    await reply(env, replyToken, `⚠️ 搜尋失敗：${err.message}`);
  }
}

async function searchNotion(env, keyword, limit = 5) {
  // Notion 的 select/multi_select 篩選會驗證關鍵字是否為「已存在的選項」，
  // 不存在就直接 400（即使包在 OR 裡也一樣），所以改成抓一批資料回來自己比對，
  // 這樣也能做「部分符合」而不是要求完全相等。
  const res = await fetch(
    `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 100,
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Notion 查詢失敗（${res.status}）${detail.slice(0, 120)}`);
  }

  const data = await res.json();
  const needle = keyword.toLowerCase();

  const matched = data.results
    .map((page) => {
      const props = page.properties;
      return {
        title: props[PROP.title]?.title?.[0]?.plain_text || '(無標題)',
        category: props[PROP.category]?.select?.name || '',
        tags: (props[PROP.tags]?.multi_select || []).map((t) => t.name),
        url: props[PROP.url]?.url || page.url,
      };
    })
    .filter((item) => {
      const haystack = [item.title, item.category, ...item.tags].join(' ').toLowerCase();
      return haystack.includes(needle);
    });

  return matched.slice(0, limit);
}

// 最近存的幾筆（不限分類）
async function handleRecent(env, replyToken, limit = 5) {
  try {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sorts: [{ timestamp: 'created_time', direction: 'descending' }],
          page_size: limit,
        }),
      },
    );

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Notion 查詢失敗（${res.status}）${detail.slice(0, 120)}`);
    }

    const data = await res.json();
    if (data.results.length === 0) {
      await reply(env, replyToken, '目前還沒有存過任何筆記。');
      return;
    }

    const lines = [`🕐 最近存的 ${data.results.length} 筆：`, ''];
    data.results.forEach((page, i) => {
      const props = page.properties;
      const title = props[PROP.title]?.title?.[0]?.plain_text || '(無標題)';
      const category = props[PROP.category]?.select?.name || '';
      const url = props[PROP.url]?.url || page.url;
      lines.push(`${i + 1}. ${title}（${category}）`);
      lines.push(url);
      lines.push('');
    });

    await reply(env, replyToken, lines.join('\n').trim());
  } catch (err) {
    await reply(env, replyToken, `⚠️ 查詢失敗：${err.message}`);
  }
}

// 標記待辦的所有筆記
async function handleTodoList(env, replyToken, limit = 10) {
  try {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filter: { property: PROP.todo, checkbox: { equals: true } },
          sorts: [{ timestamp: 'created_time', direction: 'descending' }],
          page_size: limit,
        }),
      },
    );

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Notion 查詢失敗（${res.status}）${detail.slice(0, 120)}`);
    }

    const data = await res.json();
    if (data.results.length === 0) {
      await reply(env, replyToken, '目前沒有標記待辦的筆記。');
      return;
    }

    const lines = [`📝 待辦清單（${data.results.length} 筆）：`, ''];
    data.results.forEach((page, i) => {
      const props = page.properties;
      const title = props[PROP.title]?.title?.[0]?.plain_text || '(無標題)';
      const category = props[PROP.category]?.select?.name || '';
      const url = props[PROP.url]?.url || page.url;
      lines.push(`${i + 1}. ${title}（${category}）`);
      lines.push(url);
      lines.push('');
    });

    await reply(env, replyToken, lines.join('\n').trim());
  } catch (err) {
    await reply(env, replyToken, `⚠️ 查詢失敗：${err.message}`);
  }
}

// ---------- 指令：刪除 / 註記 / 待辦 ----------

// 指令關鍵字對應表。順序有意義：「取消待辦」要排在「待辦」前面，
// 否則「待辦」的 startsWith 判斷會比「取消待辦」早比對到而誤判。
const COMMANDS = [
  { keys: ['取消待辦', '取消待办', 'untodo'], action: 'untodo' },
  { keys: ['待辦', '待办', 'todo'], action: 'todo' },
  { keys: ['刪除', '删除', 'delete'], action: 'delete' },
  { keys: ['註記', '注记', '備註', '备注', 'note'], action: 'note' },
  { keys: ['分類', '分类', 'category'], action: 'category' },
];

function parseCommand(text) {
  for (const cmd of COMMANDS) {
    for (const key of cmd.keys) {
      if (text.startsWith(key)) {
        const rest = text.slice(key.length).trim();
        const match = rest.match(/https?:\/\/[^\s]+/);
        if (!match) continue; // 沒帶連結就不算指令，交給後面當一般搜尋處理

        const url = match[0];
        const extra = rest.replace(url, '').trim(); // 「註記」指令用得到，其他指令忽略
        return { action: cmd.action, url, extra };
      }
    }
  }
  return null;
}

async function handleCommand(env, replyToken, command) {
  try {
    const pageId = await resolvePageId(env, command.url);
    if (!pageId) {
      await reply(env, replyToken, `找不到對應的筆記，請確認連結是否正確：\n${command.url}`);
      return;
    }

    switch (command.action) {
      case 'delete': {
        await archiveNotionPage(env, pageId);
        await reply(env, replyToken, '🗑️ 已刪除（移入 Notion 垃圾桶，30 天內都可救回）。');
        break;
      }
      case 'note': {
        if (!command.extra) {
          await reply(env, replyToken, '請在連結後面接著寫下要加的註記內容。');
          return;
        }
        await appendNote(env, pageId, command.extra);
        await reply(env, replyToken, `📝 已加上註記：\n${command.extra}`);
        break;
      }
      case 'todo': {
        await setTodo(env, pageId, true);
        await reply(env, replyToken, '☑️ 已標記為待辦。');
        break;
      }
      case 'untodo': {
        await setTodo(env, pageId, false);
        await reply(env, replyToken, '已取消待辦標記。');
        break;
      }
      case 'category': {
        if (!command.extra) {
          await reply(env, replyToken, '請在連結後面接著寫下想改成的分類名稱。');
          return;
        }
        await setCategory(env, pageId, command.extra);
        await reply(env, replyToken, `📂 已改為分類：${command.extra}`);
        break;
      }
    }
  } catch (err) {
    await reply(env, replyToken, `⚠️ 操作失敗：${err.message}`);
  }
}

// 支援兩種連結：
// 1. Notion 頁面連結本身（bot 存檔後回覆的那個）→ 網址結尾的 32 碼十六進位就是 page ID
// 2. 原始文章網址 → 去 Notion 資料庫用「連結」欄位比對
async function resolvePageId(env, url) {
  const idMatch = url.match(/([a-f0-9]{32})(?:[?#]|$)/i);
  if (idMatch && url.includes('notion')) {
    return idMatch[1];
  }

  const res = await fetch(
    `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { property: PROP.url, url: { equals: url } },
        page_size: 1,
      }),
    },
  );

  if (!res.ok) return null;
  const data = await res.json();
  return data.results[0]?.id || null;
}

async function archiveNotionPage(env, pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ archived: true }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`刪除失敗（${res.status}）${detail.slice(0, 120)}`);
  }
}

async function appendNote(env, pageId, noteText) {
  const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              { type: 'text', text: { content: `📝 [${timestamp}] ${noteText}` } },
            ],
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`加註記失敗（${res.status}）${detail.slice(0, 120)}`);
  }
}

async function setTodo(env, pageId, value) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        [PROP.todo]: { checkbox: value },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`更新待辦狀態失敗（${res.status}）${detail.slice(0, 120)}`);
  }
}

// 手動覆蓋分類，不限於固定的 CATEGORIES 清單——Notion 遇到新名稱會自動建立選項
async function setCategory(env, pageId, categoryName) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        [PROP.category]: { select: { name: categoryName.slice(0, 50) } },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`更新分類失敗（${res.status}）${detail.slice(0, 120)}`);
  }
}

// ---------- 抓取網頁內容 ----------

async function fetchReadable(url, env) {
  // Jina Reader：免費把任意網頁轉成乾淨純文字
  // 帶上 API Key 才有專屬額度（100 次/分鐘），否則跟全世界共用 Workers 出口 IP 的 20 次/分鐘額度，很容易被打光
  const headers = { 'User-Agent': 'line-notion-bot' };
  if (env.JINA_API_KEY) {
    headers['Authorization'] = `Bearer ${env.JINA_API_KEY}`;
  }

  const res = await fetch(`https://r.jina.ai/${url}`, { headers });

  if (!res.ok) throw new Error(`無法讀取網頁（${res.status}）`);

  const text = await res.text();
  return text.slice(0, MAX_CONTENT_CHARS);
}

// ---------- AI 分類 ----------

// 抓資料庫裡已經用過的標籤（去重），讓 AI 分類時優先重複使用，減少同義詞發散
async function getExistingTags(env, sampleSize = 100) {
  try {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sorts: [{ timestamp: 'created_time', direction: 'descending' }],
          page_size: sampleSize,
        }),
      },
    );

    if (!res.ok) return [];

    const data = await res.json();
    const tagSet = new Set();
    for (const page of data.results) {
      const tags = page.properties[PROP.tags]?.multi_select || [];
      for (const t of tags) tagSet.add(t.name);
    }
    return [...tagSet];
  } catch {
    return []; // 標籤參考只是輔助，抓失敗不影響主流程
  }
}

// 有設定 MISTRAL_API_KEY 就優先打自己的 Mistral 帳號（免費額度），失敗（含未設定 Key）才退回 OpenRouter 的免費模型陣列。
// Mistral 官方 API 不支援 OpenRouter 那種多模型 fallback 陣列，所以這裡分成兩個獨立的呼叫函式。
async function callAI(env, system, user) {
  if (env.MISTRAL_API_KEY) {
    try {
      return await callMistral(env, system, user);
    } catch {
      // 掉回 OpenRouter，不中斷整個分類流程
    }
  }
  return await callOpenRouter(env, system, user);
}

async function callMistral(env, system, user) {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mistral-medium-latest',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) throw new Error(`Mistral 分類失敗（${res.status}）`);

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function callOpenRouter(env, system, user) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      models: env.AI_MODELS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`AI 分類失敗（${res.status}）${detail.slice(0, 120)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function classify(env, { url, content, userNote, existingTags }) {
  const system = [
    '你是一個個人知識庫的分類助手。',
    '請閱讀使用者提供的網頁內容，輸出繁體中文的分類結果。',
    `分類（category）必須從以下選項擇一：${CATEGORIES.join('、')}`,
    '標籤（tags）請給 2-4 個精準的關鍵字，不要太籠統。',
    existingTags?.length
      ? `已經用過的標籤（優先從中挑選相同概念的詞，避免同義詞發散，例如已有「AI應用」就不要再造「AI工具」）：${existingTags.join('、')}`
      : null,
    '只有既有標籤都不貼切時，才建立新標籤。',
    '摘要（summary）請用 2-3 句話寫出這篇的重點，讓人日後掃一眼就知道值不值得回頭讀。',
    '只輸出 JSON，不要有任何前言、說明或 markdown 標記。',
    '格式：{"title": string, "category": string, "tags": string[], "summary": string}',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const user = [
    `網址：${url}`,
    userNote ? `使用者備註：${userNote}` : null,
    '',
    '網頁內容：',
    content,
  ]
    .filter((l) => l !== null)
    .join('\n');

  const raw = await callAI(env, system, user);
  const cleaned = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // 有些模型會夾帶前後文字，退而求其次抓出第一個 JSON 物件
    const m = cleaned.match(/\{[\s\S]*\}/);
    try {
      if (!m) throw new Error('no braces found');
      parsed = JSON.parse(m[0]);
    } catch {
      // 真的解析不出來時，把原始回應片段附在錯誤訊息裡，方便直接在 LINE 上看到問題出在哪
      const snippet = cleaned.slice(0, 300) || '(AI 回傳空白內容)';
      throw new Error(`AI 回傳格式無法解析。原始回應：${snippet}`);
    }
  }

  return {
    title: parsed.title || url,
    category: CATEGORIES.includes(parsed.category) ? parsed.category : '生活其他',
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 4) : [],
    summary: parsed.summary || '',
  };
}

// ---------- 寫入 Notion ----------

async function createNotionPage(env, { title, category, tags, summary, url }) {
  // 先查有沒有相同連結的既有頁面，避免重試或重傳造成重複資料
  const existingId = await findPageByUrl(env, url);

  const properties = {
    [PROP.title]: { title: [{ text: { content: title.slice(0, 200) } }] },
    [PROP.category]: { select: { name: category } },
    [PROP.tags]: { multi_select: tags.map((t) => ({ name: t.slice(0, 50) })) },
    [PROP.url]: { url },
    [PROP.summary]: { rich_text: [{ text: { content: summary.slice(0, 1900) } }] },
  };

  if (existingId) {
    const res = await fetch(`https://api.notion.com/v1/pages/${existingId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Notion 更新失敗（${res.status}）${detail.slice(0, 150)}`);
    }

    // 內容區塊也補上這次的摘要，當作更新紀錄（不動原本的區塊）
    await appendNote(env, existingId, `（重新分類更新）${summary}`);

    const page = await res.json();
    return { url: page.url, updated: true };
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: summary } }],
          },
        },
        {
          object: 'block',
          type: 'bookmark',
          bookmark: { url },
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Notion 寫入失敗（${res.status}）${detail.slice(0, 150)}`);
  }

  const page = await res.json();
  return { url: page.url, updated: false };
}

// 用「連結」欄位比對是否已存在相同網址的頁面（沿用 resolvePageId 裡同樣的查詢邏輯）
async function findPageByUrl(env, url) {
  const res = await fetch(
    `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { property: PROP.url, url: { equals: url } },
        page_size: 1,
      }),
    },
  );

  if (!res.ok) return null;
  const data = await res.json();
  return data.results[0]?.id || null;
}

// ---------- 輸入中動畫 ----------

async function showLoadingAnimation(env, userId, seconds = 30) {
  if (!userId) return; // 群組/多人聊天室沒有 userId，且群組功能本來就關閉，安全略過
  try {
    await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chatId: userId, loadingSeconds: seconds }),
    });
  } catch {
    // 動畫只是體驗優化，失敗不影響主流程，靜默略過即可
  }
}

// ---------- 回覆 LINE ----------

async function reply(env, replyToken, text, quickReplyLabels) {
  const message = { type: 'text', text: text.slice(0, 4900) };

  if (quickReplyLabels?.length) {
    message.quickReply = {
      items: quickReplyLabels.slice(0, 13).map((label) => ({
        type: 'action',
        action: { type: 'message', label: label.slice(0, 20), text: label },
      })),
    };
  }

  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      replyToken,
      messages: [message],
    }),
  });
}
