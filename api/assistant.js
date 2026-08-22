// ============================================================
// СЕРВЕРНАЯ ФУНКЦИЯ AI-АССИСТЕНТА
// ============================================================
// Что это: код, который выполняется НЕ в браузере пользователя, а на сервере Vercel.
// Зачем: ключ Gemini здесь в безопасности — пользователь его никогда не увидит
// (в отличие от обычного JS-кода сайта, который любой может открыть через "Инструменты разработчика").
//
// Как это работает: пробуем модели по очереди. Если Google отключил одну (ответ 404),
// тихо переходим к следующей — сайт не падает и пользователь ничего не замечает.
// Рабочую модель запоминаем на 24 часа, чтобы не тратить время на перебор при каждом запросе.

const MODEL_CHAIN = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash', // финальный запасной вариант постарше, но стабильный
];

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

// Простая память "какая модель сейчас рабочая" — живёт, пока функция "тёплая" на сервере.
// Это не настоящая база данных (для неё нужен отдельный сервис вроде Vercel KV),
// но в большинстве случаев экономит лишние попытки.
let cachedModel = null;
let cachedAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Только POST-запросы' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY не настроен на сервере. Добавьте его в Vercel → Settings → Environment Variables.'
    });
  }

  const { question, today } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Не передан вопрос' });
  }
  const dateContext = today ? `Сегодняшняя дата: ${today}. Используй только актуальное на эту дату законодательство, а не устаревшие данные из твоего обучения.\n\n` : '';

  // Если есть недавно проверенная рабочая модель — пробуем её первой
  let chain = MODEL_CHAIN;
  if (cachedModel && (Date.now() - cachedAt) < CACHE_TTL_MS) {
    chain = [cachedModel, ...MODEL_CHAIN.filter(m => m !== cachedModel)];
  }

  let lastError = null;

  for (const model of chain) {
    try {
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

      if (response.status === 404) {
        // Эта модель отключена Google — тихо пробуем следующую
        lastError = `Модель ${model} недоступна (404)`;
        continue;
      }

      if (!response.ok) {
        lastError = `Модель ${model} вернула ошибку ${response.status}`;
        continue;
      }

      const data = await response.json();
      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!answer) {
        lastError = `Модель ${model} вернула пустой ответ`;
        continue;
      }

      // Запоминаем рабочую модель на 24 часа
      cachedModel = model;
      cachedAt = Date.now();

      return res.status(200).json({ answer, model });

    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  // Все модели цепочки не сработали
  return res.status(502).json({
    error: 'Все модели Gemini недоступны. Последняя ошибка: ' + lastError
  });
}
