// ============================================================
// СЕРВЕРНАЯ ФУНКЦИЯ AI-АССИСТЕНТА
// ============================================================
// Что это: код, который выполняется НЕ в браузере пользователя, а на сервере Vercel.
// Зачем: ключи AI здесь в безопасности — пользователь их никогда не увидит
// (в отличие от обычного JS-кода сайта, который любой может открыть через "Инструменты разработчика").
//
// Как это работает: пробуем ПРОВАЙДЕРОВ по очереди — сначала все модели Gemini,
// и если ВСЯ цепочка Gemini не ответила (ключ истёк, лимит исчерпан, сервис недоступен),
// бесшовно, без ошибки на экране у клиента, переключаемся на Groq, а если и он не ответил — на OpenRouter.
// Это подстраховка на случай, если с одним провайдером что-то случится (как уже бывало с Gemini).
//
// Что нужно для каждого провайдера (переменные окружения в Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY      — обязателен для Gemini (сейчас единственный подключённый провайдер)
//   GROQ_API_KEY         — необязателен, но настоятельно рекомендуется как подстраховка.
//                          Бесплатный ключ: console.groq.com → API Keys
//   OPENROUTER_API_KEY   — необязателен, вторая линия подстраховки.
//                          Бесплатный ключ: openrouter.ai/keys
// Провайдер без ключа в переменных окружения просто тихо пропускается в цепочке — сайт не падает.

const GEMINI_MODEL_CHAIN = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash', // финальный запасной вариант постарше, но стабильный
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

// Простая память "какая модель Gemini сейчас рабочая" — живёт, пока функция "тёплая" на сервере.
// Это не настоящая база данных (для неё нужен отдельный сервис вроде Vercel KV),
// но в большинстве случаев экономит лишние попытки.
let cachedModel = null;
let cachedAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

async function callGemini(apiKey, model, question, dateContext) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

// Groq и OpenRouter оба используют формат, совместимый с OpenAI (chat/completions) —
// поэтому для них можно использовать одну и ту же функцию, отличается только адрес и ключ.
async function callOpenAiCompatible(baseUrl, apiKey, model, question, dateContext, extraHeaders) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Только POST-запросы' });
  }

  const { question, today } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Не передан вопрос' });
  }
  const dateContext = today ? `Сегодняшняя дата: ${today}. Используй только актуальное на эту дату законодательство, а не устаревшие данные из твоего обучения.\n\n` : '';

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const errors = [];

  // ---------- 1) Gemini: пробуем модели по очереди ----------
  if (geminiKey) {
    let chain = GEMINI_MODEL_CHAIN;
    if (cachedModel && (Date.now() - cachedAt) < CACHE_TTL_MS) {
      chain = [cachedModel, ...GEMINI_MODEL_CHAIN.filter(m => m !== cachedModel)];
    }
    for (const model of chain) {
      try {
        const answer = await callGemini(geminiKey, model, question, dateContext);
        cachedModel = model;
        cachedAt = Date.now();
        return res.status(200).json({ answer, model: `gemini/${model}` });
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
        groqKey, GROQ_MODEL, question, dateContext
      );
      return res.status(200).json({ answer, model: `groq/${GROQ_MODEL}` });
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
        openrouterKey, OPENROUTER_MODEL, question, dateContext,
        { 'HTTP-Referer': 'https://markus-site-three.vercel.app', 'X-Title': 'MARKUS AI Assistant' }
      );
      return res.status(200).json({ answer, model: `openrouter/${OPENROUTER_MODEL}` });
    } catch (err) {
      errors.push(err.message);
    }
  } else {
    errors.push('OPENROUTER_API_KEY не настроен (подстраховка отключена)');
  }

  // Все провайдеры не сработали — возвращаем понятную диагностику
  return res.status(502).json({
    error: 'Все AI-провайдеры недоступны. Подробности: ' + errors.join(' | '),
  });
}
