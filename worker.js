// ============================================================
// СЕРВЕРНАЯ ЧАСТЬ САЙТА MARKUS ДЛЯ CLOUDFLARE WORKERS
// ============================================================
// Что это: то же самое, что раньше делали 4 файла в папке /api,
// но в формате, который понимает Cloudflare (там другой способ
// описания серверных функций, чем на Vercel).
//
// Папку /api УДАЛЯТЬ НЕ НУЖНО — она продолжает обслуживать Vercel.
// Этот файл обслуживает Cloudflare. Логика внутри одинаковая.
//
// Что обслуживает:
//   /api/news       — лента новостей из Telegram-канала
//   /api/assistant  — AI-ассистент по Налоговому кодексу
//   /api/lead       — отправка заявок с сайта в Telegram
//   /api/bot        — ответы бота на сообщения клиентов
//   всё остальное   — обычные файлы сайта (index.html, картинки и т.д.)

// ---------- вспомогательное ----------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

// Безопасно читаем тело запроса: если его нет или оно битое — вернём пустой объект,
// чтобы функция не падала с ошибкой сервера.
async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ============================================================
// 1) ЛЕНТА НОВОСТЕЙ
// ============================================================
// Берёт последние посты из публичной веб-версии Telegram-канала
// (t.me/s/<канал>) — без токенов и без входа в аккаунт.

const CHANNEL = 'MARKUS_JW';

async function handleNews() {
  try {
    const response = await fetch(`https://t.me/s/${CHANNEL}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarkusSiteBot/1.0)' },
    });

    if (!response.ok) {
      return json({ error: 'Telegram недоступен, попробуйте позже' }, 502);
    }

    const html = await response.text();
    const messageBlocks = html.split('tgme_widget_message_wrap').slice(1);

    const posts = messageBlocks
      .slice(-25)
      .reverse()
      .map((block) => {
        const textMatch = block.match(
          /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
        );
        const dateMatch = block.match(/<time datetime="([^"]+)"/);
        const linkMatch = block.match(
          /<a class="tgme_widget_message_date" href="([^"]+)"/
        );

        if (!textMatch) return null;

        const textHtml = textMatch[1]
          .replace(/<br\/?>/g, '\n')
          .replace(
            /tgme_widget_message_tag_hashtag/g,
            'text-gold font-semibold no-underline'
          )
          .trim();

        let date = '';
        if (dateMatch) {
          const d = new Date(dateMatch[1]);
          date = d.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          });
        }

        return { textHtml, date, link: linkMatch ? linkMatch[1] : null };
      })
      .filter(Boolean);

    return json({ posts });
  } catch (err) {
    return json({ error: 'Не удалось загрузить ленту: ' + err.message }, 502);
  }
}

// ============================================================
// 2) AI-АССИСТЕНТ
// ============================================================
// Пробует провайдеров по очереди: сначала все модели Gemini,
// если вся цепочка не ответила — Groq, потом OpenRouter.
// Провайдер без ключа просто тихо пропускается, сайт не падает.

const GEMINI_MODEL_CHAIN = [
  'gemini-flash-latest',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
];
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENROUTER_MODEL = 'meta-llama/llama-3.1-8b-instruct:free';

const SYSTEM_PROMPT = `Ты — ассистент бухгалтерской компании MARKUS (Ташкент, Узбекистан).
Отвечай на вопросы по Налоговому кодексу РУз, НСБУ (бухучёт), Трудовому кодексу РУз и корпоративному праву.

ФОРМАТ ОТВЕТА:
- Давай развёрнутый, полный ответ — объясняй суть, ставки, порядок применения.
- ОБЯЗАТЕЛЬНО указывай конкретные статьи нормативных актов, на которых основан ответ (например: "ст. 248 НК РУз", "ст. 246 ТК РУз", "НСБУ №21").
- В конце ответа добавь строку со ссылкой на первоисточник в формате: Источник: lex.uz — Налоговый кодекс РУз, ст. NNN
- Пиши обычным текстом, БЕЗ markdown-разметки: не используй звёздочки **, решётки #, дефисы для списков. Только связные абзацы.
- Если не уверен в номере статьи — честно скажи об этом, не выдумывай номера.

Если вопрос не по теме — вежливо скажи, что специализируешься только на налогах, бухучёте и трудовом праве Узбекистана.
Ты даёшь справочную информацию, а не юридическую консультацию — в конце сложных ответов упомяни, что для точного решения стоит обратиться к бухгалтеру Markus.`;

// Запоминаем, какая модель Gemini сейчас рабочая, пока воркер "тёплый".
let cachedModel = null;
let cachedAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function callGemini(apiKey, model, question, dateContext) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: dateContext + question }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { maxOutputTokens: 3000 },
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini ${model}: HTTP ${response.status} ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!answer) throw new Error(`Gemini ${model}: пустой ответ`);
  return answer;
}

// Groq и OpenRouter используют формат, совместимый с OpenAI —
// поэтому для них одна общая функция, отличаются только адрес и ключ.
async function callOpenAiCompatible(baseUrl, apiKey, model, question, dateContext, extraHeaders) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(extraHeaders || {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: dateContext + question },
      ],
      max_tokens: 3000,
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`${model}: HTTP ${response.status} ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error(`${model}: пустой ответ`);
  return answer;
}

async function handleAssistant(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Только POST-запросы' }, 405);
  }

  const { question, today } = await readBody(request);
  if (!question || typeof question !== 'string') {
    return json({ error: 'Не передан вопрос' }, 400);
  }

  const dateContext = today
    ? `Сегодняшняя дата: ${today}. Используй только актуальное на эту дату законодательство, а не устаревшие данные из твоего обучения.\n\n`
    : '';

  const geminiKey = env.GEMINI_API_KEY;
  const groqKey = env.GROQ_API_KEY;
  const openrouterKey = env.OPENROUTER_API_KEY;

  const errors = [];

  // ---------- 1) Gemini ----------
  if (geminiKey) {
    let chain = GEMINI_MODEL_CHAIN;
    if (cachedModel && Date.now() - cachedAt < CACHE_TTL_MS) {
      chain = [cachedModel, ...GEMINI_MODEL_CHAIN.filter((m) => m !== cachedModel)];
    }
    for (const model of chain) {
      try {
        const answer = await callGemini(geminiKey, model, question, dateContext);
        cachedModel = model;
        cachedAt = Date.now();
        return json({ answer, model: `gemini/${model}` });
      } catch (err) {
        errors.push(err.message);
      }
    }
  } else {
    errors.push('GEMINI_API_KEY не настроен на сервере');
  }

  // ---------- 2) Groq: подстраховка №1 ----------
  if (groqKey) {
    try {
      const answer = await callOpenAiCompatible(
        'https://api.groq.com/openai/v1/chat/completions',
        groqKey,
        GROQ_MODEL,
        question,
        dateContext
      );
      return json({ answer, model: `groq/${GROQ_MODEL}` });
    } catch (err) {
      errors.push(err.message);
    }
  } else {
    errors.push('GROQ_API_KEY не настроен (подстраховка отключена)');
  }

  // ---------- 3) OpenRouter: подстраховка №2 ----------
  if (openrouterKey) {
    try {
      const answer = await callOpenAiCompatible(
        'https://openrouter.ai/api/v1/chat/completions',
        openrouterKey,
        OPENROUTER_MODEL,
        question,
        dateContext,
        { 'HTTP-Referer': 'https://markus.uz', 'X-Title': 'MARKUS AI Assistant' }
      );
      return json({ answer, model: `openrouter/${OPENROUTER_MODEL}` });
    } catch (err) {
      errors.push(err.message);
    }
  } else {
    errors.push('OPENROUTER_API_KEY не настроен (подстраховка отключена)');
  }

  return json(
    { error: 'Все AI-провайдеры недоступны. Подробности: ' + errors.join(' | ') },
    502
  );
}

// ============================================================
// 3) ОТПРАВКА ЗАЯВОК В TELEGRAM
// ============================================================

async function handleLead(request, env) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  // ДИАГНОСТИКА: откройте /api/lead в браузере — покажет, что не так с настройкой бота
  if (request.method === 'GET') {
    const diag = {
      TELEGRAM_BOT_TOKEN: botToken
        ? `есть (${botToken.slice(0, 10)}…, длина ${botToken.length})`
        : '❌ НЕ НАЙДЕН',
      TELEGRAM_CHAT_ID: chatId ? `есть (${chatId})` : '❌ НЕ НАЙДЕН',
    };
    if (!botToken || !chatId) {
      return json({ status: '❌ Переменные не настроены', diag });
    }
    try {
      const check = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const info = await check.json();
      if (!info.ok) {
        return json({ status: '❌ Токен бота неверный или отозван', diag, telegram: info });
      }
      const send = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✅ Проверка связи с сайтом MARKUS (Cloudflare) — всё работает!',
        }),
      });
      const sendResult = await send.json();
      if (!sendResult.ok) {
        return json({
          status: '❌ Бот найден, но не может отправить сообщение',
          подсказка:
            'Чаще всего причина: вы не нажали /start у бота, либо TELEGRAM_CHAT_ID указан неверно',
          diag,
          bot: info.result.username,
          telegram: sendResult,
        });
      }
      return json({
        status: '✅ ВСЁ РАБОТАЕТ — проверьте Telegram, туда пришло тестовое сообщение',
        diag,
        bot: info.result.username,
      });
    } catch (err) {
      return json({ status: '❌ Ошибка связи с Telegram', diag, error: err.message });
    }
  }

  if (request.method !== 'POST') {
    return json({ error: 'Только POST-запросы' }, 405);
  }

  if (!botToken || !chatId) {
    return json({ error: 'TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не настроены на сервере.' }, 500);
  }

  const { name, phone, source, message, service, contactMethod, contactValue } =
    await readBody(request);

  const isServiceQuestion =
    source === 'markus-site-service-question' || source === 'markus-site-service-card';
  const isCalcLead = source === 'markus-site-calculator';

  if (isServiceQuestion || isCalcLead) {
    if (!contactValue) {
      return json({ error: 'Не передан контакт для связи' }, 400);
    }
  } else if (!phone) {
    return json({ error: 'Не передан телефон' }, 400);
  }

  const methodLabels = {
    phone: 'Звонок / телефон',
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
    email: 'Email',
  };

  let header;
  if (isCalcLead) header = '🧮 Заявка с калькулятора MARKUS';
  else if (isServiceQuestion) header = '💬 Вопрос с сайта MARKUS';
  else header = '🆕 Новая заявка с сайта MARKUS';

  const lines = [header, ''];
  if (isCalcLead) {
    lines.push(`🏷️ ${service || '—'}`);
    lines.push(`📋 Детали расчёта:\n${message || '—'}`);
    lines.push(`☎️ Способ связи: ${methodLabels[contactMethod] || contactMethod || '—'}`);
    lines.push(`📇 Контакт: ${contactValue}`);
  } else if (isServiceQuestion) {
    lines.push(`🏷️ Услуга: ${service || '—'}`);
    lines.push(`📝 Вопрос: ${message || '—'}`);
    lines.push(`☎️ Способ связи: ${methodLabels[contactMethod] || contactMethod || '—'}`);
    lines.push(`📇 Контакт: ${contactValue}`);
  } else {
    lines.push(`👤 Имя: ${name || '—'}`);
    lines.push(`📞 Телефон: ${phone}`);
  }
  lines.push('📍 Источник: markus-site (не сарафанное радио — это сайт)');
  lines.push(`🕐 ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' })}`);

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return json(
        { error: 'Telegram отклонил сообщение: ' + (errData.description || response.status) },
        502
      );
    }

    return json({ success: true });
  } catch (err) {
    return json({ error: 'Не удалось связаться с Telegram: ' + err.message }, 502);
  }
}

// ============================================================
// 4) ВХОДЯЩИЕ СООБЩЕНИЯ БОТА
// ============================================================

async function handleBot(request, env) {
  // Telegram иногда шлёт проверочные GET — просто отвечаем ok
  if (request.method !== 'POST') return json({ ok: true });

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const adminChatId = env.TELEGRAM_CHAT_ID;
  // Молча выходим, чтобы Telegram не считал вебхук сломанным
  if (!botToken || !adminChatId) return json({ ok: true });

  const update = await readBody(request);
  const message = update.message;
  if (!message || !message.chat) return json({ ok: true });

  const clientChatId = message.chat.id;
  const text = (message.text || '').trim();

  // Если админ сам написал боту (например, тестируя) — не пересылаем самому себе
  if (String(clientChatId) === String(adminChatId)) return json({ ok: true });

  const sendMessage = (chatId, msgText) =>
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msgText }),
    });

  try {
    if (text === '/start') {
      await sendMessage(
        clientChatId,
        'Здравствуйте! Это бот компании MARKUS — бухгалтерские, налоговые и юридические услуги в Узбекистане.\n\nОпишите ваш вопрос текстом — специалист ответит в ближайшее время.\n\n📞 +998 33 080-10-70'
      );
    } else if (text) {
      const from = message.from || {};
      const senderName =
        [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Без имени';
      const username = from.username ? '@' + from.username : '—';
      await sendMessage(
        adminChatId,
        `💬 Сообщение от клиента в боте\n\n👤 ${senderName} (${username})\n🆔 chat_id: ${clientChatId}\n📝 ${text}`
      );
      await sendMessage(clientChatId, 'Спасибо! Ваше сообщение получено, мы ответим в ближайшее время.');
    }
  } catch {
    // Не даём вебхуку "падать" — Telegram при ошибках может временно отключить его
  }

  return json({ ok: true });
}

// ============================================================
// ГЛАВНЫЙ ВХОД: куда пришёл запрос — туда и направляем
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/news') return handleNews();
    if (path === '/api/assistant') return handleAssistant(request, env);
    if (path === '/api/lead') return handleLead(request, env);
    if (path === '/api/bot') return handleBot(request, env);

    // Любой другой адрес — это обычный файл сайта
    // (index.html, картинки, PDF-документы и т.д.)
    return env.ASSETS.fetch(request);
  },
};
