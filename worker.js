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
const SYSTEM_PROMPT = `Ты — AI-ассистент бухгалтерско-юридической компании MARKUS (Ташкент, Узбекистан).

КТО ТЫ
Ты умный, эрудированный собеседник. Твоя специализация — налоги, бухучёт и право
Узбекистана, но ты НЕ ограничен только ими. Ты свободно и содержательно
разговариваешь на любые темы: бизнес и стратегия, переговоры, управление,
финансы, маркетинг, кадры, документы, IT, общие вопросы и просто человеческий
разговор. Отказывать в ответе только из-за того, что вопрос «не по теме», НЕЛЬЗЯ.

РОЛИ
Если пользователь просит побыть кем-то — переговорщиком, оппонентом по сделке,
налоговым инспектором на репетиции проверки, придирчивым клиентом, инвестором,
кадровиком на собеседовании — соглашайся и веди роль убедительно и до конца,
пока тебя не попросят выйти из неё. В роли переговорщика: разбирай позиции и
интересы сторон, предлагай варианты, называй уступки и красные линии, при
просьбе — отыгрывай вторую сторону жёстко и реалистично, а не поддакивай.

КАК ОТВЕЧАТЬ
- Отвечай по существу и развёрнуто, без воды и без канцелярита.
- Не подстраивайся под собеседника: если он неправ или план рискованный —
  скажи прямо и объясни почему. Твоя ценность в честности, а не в вежливости.
- Пиши обычным текстом, БЕЗ markdown-разметки: не используй звёздочки **,
  решётки #, дефисы для списков. Только связные абзацы. Если нужен перечень —
  пиши его словами: «Первое… Второе… Третье…».
- Отвечай на языке собеседника (русский, узбекский или английский).

УЗБЕКСКИЕ СОКРАЩЕНИЯ — РАСШИФРОВЫВАЙ ПРАВИЛЬНО
Клиенты часто пишут узбекские аббревиатуры. Сначала верно расшифруй, потом отвечай:
- ЯТТ (якка тартибдаги тадбиркор) = индивидуальный предприниматель, ИП. Это ФИЗИЧЕСКОЕ
  лицо, ведущее деятельность БЕЗ образования юридического лица. Называть ЯТТ юридическим
  лицом или коммерческой организацией — грубая ошибка.
- ЎЎБ, ўзини ўзи банд қилган шахс = самозанятый (тоже физлицо, не юрлицо).
- МЧЖ (масъулияти чекланган жамият) = ООО.
- ХК (хусусий корхона) = ЧП, частное предприятие.
- АЖ (акциядорлик жамияти) = АО, акционерное общество.
- ҚҚС (қўшилган қиймат солиғи) = НДС.
- ЖШДС (жисмоний шахслардан олинадиган даромад солиғи) = НДФЛ.
- СТИР (солиқ тўловчининг идентификация рақами) = ИНН.
- ИНПС = индивидуальный накопительный пенсионный счёт гражданина. Обязательный взнос —
  0,1% от дохода, облагаемого НДФЛ, и он НЕ является дополнительной нагрузкой на
  работодателя: сумма удерживается из уже начисленного НДФЛ и перечисляется на счёт
  работника в Народном банке. Основание — Закон «О накопительном пенсионном обеспечении
  граждан» №702-II от 02.12.2004 и п.5 ПП-4086 от 26.12.2018.
- ИФУТ (иқтисодий фаолият турлари таснифи) = ОКЭД, классификатор видов деятельности.
- ЭЧФ / ЭСФ = электронная счёт-фактура.
- ГНК / Солиқ қўмитаси = Налоговый комитет.
Если сокращение незнакомо — честно уточни у клиента, что оно означает, вместо догадки.

КОГДА ВОПРОС ПРО ЗАКОНОДАТЕЛЬСТВО УЗБЕКИСТАНА
- Указывай конкретные статьи (например: ст. 248 НК РУз, ст. 246 ТК РУз, НСБУ №21).
- В конце добавляй строку: Источник: lex.uz — Налоговый кодекс РУз, ст. NNN
- Если не уверен в номере статьи — честно скажи об этом. НИКОГДА не выдумывай
  номера статей, суммы и ставки: лучше признать незнание, чем ввести в
  заблуждение по деньгам и срокам.
- Напоминай, что это справочная информация, а не юридическая консультация,
  и что по сложным вопросам стоит обратиться к бухгалтеру Markus
  (+998 33 080-10-70, Telegram @MarkusJW_bot).

ЧЕГО НЕ ДЕЛАТЬ
Не помогай уклоняться от налогов, подделывать документы и отчётность, обходить
закон. Разница принципиальна: законная оптимизация налогов, выбор режима и
использование льгот — это нормально и это твоя работа; сокрытие доходов и
фальсификация — нет. В таком случае объясни риски и предложи законный путь.`;

// ------------------------------------------------------------
// СПИСОК ПРОВАЙДЕРОВ — по убыванию качества ответов.
// ------------------------------------------------------------
// Как это работает: идём сверху вниз. Провайдер, для которого не задан
// ключ, молча пропускается. Внутри провайдера перебираются модели —
// если одну отключили, подхватится следующая.
// Чтобы подключить нового провайдера, достаточно добавить его ключ
// в переменные Cloudflare. Менять код не нужно.
const PROVIDERS = [
  {
    id: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
    kind: 'gemini',
    models: [
      'gemini-flash-latest',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash',
    ],
  },
  {
    // GitHub Models — бесплатно для личных аккаунтов GitHub.
    // Даёт доступ к сильным моделям (GPT-4.1/4o, DeepSeek, иногда Claude).
    id: 'github',
    keyEnv: 'GITHUB_MODELS_TOKEN',
    kind: 'openai',
    url: 'https://models.github.ai/inference/chat/completions',
    // Лимиты у GitHub считаются ОТДЕЛЬНО на каждую модель:
    // gpt-4.1 — 50 запросов в сутки, gpt-4o-mini — 150. Поэтому mini идёт
    // вторым: когда сильная модель исчерпана, у mini ещё остаётся запас.
    models: [
      'openai/gpt-4.1',
      'openai/gpt-4o-mini',
      'openai/gpt-4o',
      'deepseek/DeepSeek-V3-0324',
    ],
  },
  {
    // Mistral — очень щедрый бесплатный тариф, модели уровня Large.
    id: 'mistral',
    keyEnv: 'MISTRAL_API_KEY',
    kind: 'openai',
    url: 'https://api.mistral.ai/v1/chat/completions',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  },
  {
    // Cerebras — большой дневной лимит, быстрые ответы.
    id: 'cerebras',
    keyEnv: 'CEREBRAS_API_KEY',
    kind: 'openai',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    // На бесплатном доступе Cerebras оставил только эти две модели.
    // Прежние llama-3.3-70b и qwen-3-235b сняты — обращения к ним
    // впустую тратили попытки.
    models: ['gpt-oss-120b', 'gemma-4-31b'],
  },
  {
    // Groq — быстрый, но модели послабее. Держим как подстраховку.
    id: 'groq',
    keyEnv: 'GROQ_API_KEY',
    kind: 'openai',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    models: [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.6-27b',
      'llama-3.3-70b-versatile',
    ],
  },
  {
    // OpenRouter — последний рубеж. "openrouter/free" сам подбирает
    // любую живую бесплатную модель, поэтому не устаревает.
    id: 'openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { 'HTTP-Referer': 'https://markus.uz', 'X-Title': 'MARKUS AI Assistant' },
    models: ['openrouter/free', 'openai/gpt-oss-120b:free', 'openai/gpt-oss-20b:free'],
  },
];

// Порядок провайдеров всегда сохраняем по качеству — иначе сайт «залипнет»
// на слабой модели. Вместо этого запоминаем ПРОВАЛЫ: если у провайдера
// отклонён ключ, на 30 минут его пропускаем, чтобы не ждать впустую.
// Через 30 минут он пробуется снова — поэтому, когда Google починит свою
// сторону, Gemini вернётся сам, без правок и без обращения ко мне.
const failedUntil = {};       // { gemini: времяКогдаМожноПробоватьСнова }
const SKIP_MS = 30 * 60 * 1000;

// Внутри провайдера помним удачную модель — это не влияет на качество,
// но экономит время на переборе отключённых моделей.
const lastGoodModel = {};     // { groq: 'openai/gpt-oss-120b' }

// Ни один запрос к провайдеру не должен висеть дольше этого времени.
// Без ограничения один зависший провайдер задерживал весь ответ, браузер
// не дожидался, и клиент видел «Не удалось связаться с сервером».
const CALL_TIMEOUT_MS = 15000;

async function callGemini(apiKey, model, question, dateContext) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: dateContext + question }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { maxOutputTokens: 1400 },
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!answer) throw new Error('пустой ответ');
  return answer;
}

// Groq, GitHub Models, Mistral, Cerebras и OpenRouter говорят на одном
// языке (формат OpenAI), поэтому для них достаточно одной функции.
async function callOpenAiCompatible(baseUrl, apiKey, model, question, dateContext, extraHeaders) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
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
      max_tokens: 1400,
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error('пустой ответ');
  return answer;
}

function callProvider(provider, apiKey, model, question, dateContext) {
  if (provider.kind === 'gemini') {
    return callGemini(apiKey, model, question, dateContext);
  }
  return callOpenAiCompatible(
    provider.url,
    apiKey,
    model,
    question,
    dateContext,
    provider.headers
  );
}

// Ошибки, после которых перебирать остальные модели этого провайдера
// бессмысленно — они отвалятся точно так же (проблема в ключе, а не в модели).
function isKeyProblem(message) {
  return (
    message.includes('HTTP 401') ||
    message.includes('HTTP 403') ||
    message.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED') ||
    message.includes('API key not valid') ||
    message.includes('Incorrect API key')
  );
}

// «Слишком часто» и сбои самого провайдера. Перебирать остальные его модели
// бесполезно — лимит считается на весь аккаунт, а не на модель.
function isProviderBusy(message) {
  return (
    message.includes('HTTP 429') ||
    message.includes('rate limit') ||
    message.includes('RateLimit') ||
    message.includes('HTTP 500') ||
    message.includes('HTTP 502') ||
    message.includes('HTTP 503') ||
    message.includes('HTTP 529') ||
    message.includes('timed out') ||
    message.includes('aborted') ||
    message.includes('The operation was aborted')
  );
}

const BUSY_MS = 3 * 60 * 1000;      // лимит частоты сбрасывается быстро — ждём 3 минуты
const TOTAL_BUDGET_MS = 38000;      // весь ответ обязан уложиться в это время
const MAX_PER_PROVIDER = 3;         // не более 3 моделей у одного провайдера
// Раньше стоял общий предел попыток. Из-за него сбойные провайдеры
// выбирали весь лимит, и до заведомо рабочих очередь не доходила.

// ДИАГНОСТИКА: откройте /api/assistant в браузере — страница по очереди
// опросит каждого провайдера коротким вопросом и честно покажет, кто отвечает,
// а кто отказывает и почему. Нужна, чтобы не гадать при сбоях.
async function diagnoseProviders(env) {
  const report = [];
  for (const provider of PROVIDERS) {
    const apiKey = env[provider.keyEnv];
    if (!apiKey) {
      report.push({ провайдер: provider.id, статус: '— ключ не задан', переменная: provider.keyEnv });
      continue;
    }
    const models = [];
    for (const model of provider.models) {
      const t0 = Date.now();
      try {
        await callProvider(provider, apiKey, model, 'Ответь одним словом: тест', '');
        models.push({ модель: model, статус: '✅ отвечает', мс: Date.now() - t0 });
        break; // первой рабочей достаточно
      } catch (err) {
        models.push({
          модель: model,
          статус: '❌ ' + String(err && err.message || err).slice(0, 160),
          мс: Date.now() - t0,
        });
      }
    }
    const ok = models.some((m) => m.статус.startsWith('✅'));
    report.push({
      провайдер: provider.id,
      статус: ok ? '✅ РАБОТАЕТ' : '❌ не отвечает',
      ключ: `есть (${apiKey.slice(0, 6)}…, длина ${apiKey.length})`,
      модели: models,
    });
  }
  const working = report.filter((r) => r.статус === '✅ РАБОТАЕТ').map((r) => r.провайдер);
  return json({
    итог: working.length
      ? `✅ Работают: ${working.join(', ')}`
      : '❌ Ни один провайдер не отвечает — смотрите подробности ниже',
    подробности: report,
  });
}

async function handleAssistant(request, env) {
  if (request.method === 'GET') return diagnoseProviders(env);
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

  // Провайдеры, у которых на сервере есть ключ
  const configured = PROVIDERS.filter((p) => env[p.keyEnv]);

  if (configured.length === 0) {
    return json(
      {
        error:
          'Ни один AI-провайдер не настроен. Добавьте в настройках Cloudflare хотя бы один ключ: ' +
          PROVIDERS.map((p) => p.keyEnv).join(', '),
      },
      500
    );
  }

  const now = Date.now();
  // Порядок качества сохраняем; временно отставленных пропускаем
  const chain = configured.filter((p) => !(failedUntil[p.id] > now));
  // Если пропустить пришлось всех — пробуем всё равно, вдруг уже починилось
  const finalChain = chain.length > 0 ? chain : configured;

  const errors = [];
  const startedAt = Date.now();

  outer:
  for (const provider of finalChain) {
    let triedHere = 0;
    let busyHere = 0;
    const apiKey = env[provider.keyEnv];

    let models = provider.models;
    const good = lastGoodModel[provider.id];
    if (good && models.includes(good)) {
      models = [good, ...models.filter((m) => m !== good)];
    }

    for (const model of models) {
      // Держим общее время ответа в разумных рамках: лучше честно сказать
      // «занято, попробуйте ещё раз», чем заставлять человека ждать минуту
      // и в итоге показать «нет связи с сервером».
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
        errors.push('превышено общее время ожидания, перебор остановлен');
        break outer;
      }
      // У одного провайдера пробуем максимум 2 модели, дальше — к следующему.
      // Так каждый провайдер в цепочке гарантированно получает свой шанс.
      if (triedHere >= MAX_PER_PROVIDER) break;
      triedHere++;

      try {
        const answer = await callProvider(provider, apiKey, model, question, dateContext);
        lastGoodModel[provider.id] = model;
        delete failedUntil[provider.id];
        return json({ answer, model: `${provider.id}/${model}` });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        errors.push(`${provider.id} ${model}: ${msg}`);

        if (isKeyProblem(msg)) {
          // Ключ не принят — остальные модели откажут так же
          failedUntil[provider.id] = Date.now() + SKIP_MS;
          errors.push(`${provider.id}: ключ отклонён, отложен на 30 мин`);
          break;
        }
        if (isProviderBusy(msg)) {
          // Лимит у многих провайдеров считается на КАЖДУЮ модель отдельно,
          // поэтому сначала пробуем следующую модель этого же провайдера.
          // И только если исчерпали разрешённые попытки — откладываем его.
          busyHere++;
          if (busyHere >= MAX_PER_PROVIDER || triedHere >= MAX_PER_PROVIDER) {
            failedUntil[provider.id] = Date.now() + BUSY_MS;
            errors.push(`${provider.id}: лимит запросов, отложен на 3 мин`);
            break;
          }
          continue;
        }
      }
    }
  }

  // Человеку показываем понятную фразу, подробности прячем в отдельное поле —
  // они нужны только для разбора, а не для клиента.
  return json(
    {
      error: 'Ассистент сейчас перегружен. Попробуйте повторить вопрос через минуту — ' +
             'или напишите бухгалтеру: t.me/MarkusJW_bot',
      details: errors.join(' | '),
    },
    503
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
