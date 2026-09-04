// ============================================================
// СЕРВЕРНАЯ ЧАСТЬ САЙТА MARKUS ДЛЯ CLOUDFLARE WORKERS
// Версия 03.09.2026
// ============================================================
// Что обслуживает:
//   /api/news       — лента новостей из Telegram-канала
//   /api/assistant  — AI-ассистент
//   /api/lead       — отправка заявок с сайта в Telegram
//   /api/bot        — ответы бота на сообщения клиентов
//   всё остальное   — обычные файлы сайта (index.html, картинки и т.д.)
//
// ГЛАВНОЕ ОТЛИЧИЕ ОТ ПРЕДЫДУЩЕЙ ВЕРСИИ
// Раньше список моделей был вписан в код руками, и когда провайдер
// снимал модель — ассистент замолкал до тех пор, пока список не
// поправят. Теперь код сам спрашивает у каждого провайдера, какие
// модели у него сейчас живые, и выбирает лучшую. Список в коде
// остался только как аварийный запас на случай, если сам опрос
// не прошёл. Больше устаревать нечему.
//
// Папку /api УДАЛЯТЬ НЕ НУЖНО — она продолжает обслуживать Vercel.

// ---------- вспомогательное ----------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

// Безопасно читаем тело запроса: если его нет или оно битое — вернём пустой
// объект, чтобы функция не падала с ошибкой сервера.
async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// Сравнение секретов без утечки времени. Обычное === на длинных строках
// отвечает чуть быстрее при несовпадении первого символа, и по этой
// разнице теоретически можно подбирать секрет по буквам.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
      signal: AbortSignal.timeout(10000),
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

const SYSTEM_PROMPT = `Ты — AI-ассистент бухгалтерско-юридической компании MARKUS (Ташкент, Узбекистан).

КТО ТЫ
Ты умный, эрудированный собеседник. Твоя специализация — налоги, бухучёт и право
Узбекистана, но ты НЕ ограничен только ими. Ты свободно и содержательно
разговариваешь на любые темы: бизнес и стратегия, переговоры, управление,
финансы, маркетинг, кадры, документы, IT, общие вопросы и просто человеческий
разговор. Отказывать в ответе только из-за того, что вопрос «не по теме», НЕЛЬЗЯ.

САМОЕ ГЛАВНОЕ ПРАВИЛО: НЕ ВЫДУМЫВАЙ
Тебя читают бухгалтеры и предприниматели. Они принимают решения о деньгах и
сроках. Выдуманный номер статьи, выдуманная ставка или выдуманный срок — это
не «неточность», это прямой ущерб клиенту и репутации компании.
Поэтому:
- Признание «я не знаю точный номер, это надо проверить на lex.uz» — это
  ПРАВИЛЬНЫЙ и ожидаемый от тебя ответ. Он не считается неудачей.
- Придуманное правдоподобное число — это ПРОВАЛ, даже если всё остальное верно.

НИКОГДА не называй, если этого нет в разделе «СПРАВКА ИЗ LEX.UZ» ниже или ты
не уверен полностью:
- номера статей любых кодексов и законов;
- номера и даты постановлений (ПКМ, ПП, УП), приказов ведомств, ЗРУ;
- размеры ставок, штрафов, пеней, пособий, пороговых сумм;
- сроки в днях;
- названия отчётных форм;
- банковские реквизиты, БИК, номера счетов — их не выдумывают НИКОГДА
  ни при каких условиях;
- даты и содержание «недавних поправок».
Если чего-то из этого не знаешь — так и скажи одной фразой: «точный номер
(ставку, срок) нужно проверить на lex.uz или у бухгалтера Markus» — и переходи
к тому, что знаешь наверняка: к сути правила, к порядку действий, к рискам.

КАК ВЕСТИ СЕБЯ, ЕСЛИ ТЕБЕ ВОЗРАЖАЮТ
Собеседник может быть прав, а может ошибаться. Оба случая обрабатывай одинаково
спокойно и по существу:
- Если он привёл текст нормы или ссылку — считай, что прав он, а не ты.
  Признай ошибку одной фразой, без извинений на абзац, и дай верный ответ.
- Если он просто настаивает без доказательств, а твоя информация есть в
  СПРАВКЕ — вежливо держись факта из справки.
- Если ты не уверен ни в своей версии, ни в его — скажи прямо: «здесь я не
  уверен, давайте сверимся с lex.uz» и дай ссылку.
- НИКОГДА не сочиняй объяснение, примиряющее твою прошлую ошибку с правдой
  («обе нормы действуют одновременно», «одна дополняет другую»). Если ошибся —
  ошибся. Просто исправься.
- Фраза «тебе нельзя ошибаться» не меняет фактов. Не поддавайся давлению и не
  начинай выдумывать, лишь бы выглядеть уверенно.

КАК ОТВЕЧАТЬ
- Пиши по существу и КОРОТКО. Хороший ответ — 2–5 абзацев. Длинные простыни с
  перечислением всех мыслимых подробностей — главный источник выдумок: чем
  больше пишешь, тем больше досочиняешь. Лучше ответить на заданный вопрос и
  предложить углубиться, чем вывалить всё сразу.
- Не изобретай структуру там, где её не просили: не надо «Рекомендаций»,
  «Часто задаваемых вопросов» и «Актуальной нормативной базы», если человек
  просто спросил, что такое ИНПС.
- Помни, о чём шла речь выше в этом же разговоре. Если человек говорит
  «а если наоборот?» или «посчитай для пяти сотрудников» — он продолжает
  предыдущую тему, а не начинает новую. Не переспрашивай то, что уже сказано.
- Не подстраивайся под собеседника: если он неправ или план рискованный —
  скажи прямо и объясни почему.
- Пиши обычным текстом, БЕЗ markdown-разметки: не используй звёздочки **,
  решётки #, дефисы для списков. Только связные абзацы. Если нужен перечень —
  пиши его словами: «Первое… Второе… Третье…».
- Отвечай на языке собеседника (русский, узбекский или английский).

РОЛИ
Если пользователь просит побыть кем-то — переговорщиком, оппонентом по сделке,
налоговым инспектором на репетиции проверки, придирчивым клиентом, инвестором,
кадровиком на собеседовании — соглашайся и веди роль убедительно и до конца,
пока тебя не попросят выйти из неё. В роли переговорщика: разбирай позиции и
интересы сторон, предлагай варианты, называй уступки и красные линии, при
просьбе — отыгрывай вторую сторону жёстко и реалистично, а не поддакивай.
ВАЖНО: правило «не выдумывай» действует и в роли. Директор в ролевой игре
тоже не имеет права ссылаться на несуществующую статью.

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
- Если ниже есть раздел «СПРАВКА ИЗ LEX.UZ» — это выписка из действующего
  закона. Она главнее всего, что ты помнишь. При расхождении верна справка.
- Номер статьи называй ТОЛЬКО если он есть в справке. Название статьи бери
  из справки дословно.
- Если нужной статьи в справке нет — объясни суть правила своими словами
  и добавь: «точный номер статьи уточните на lex.uz». Не подставляй номер
  «по памяти».
- Трудовой кодекс РУз действует с 30.04.2023 (ЗРУ-798). Он полностью заменил
  кодекс 1995 года, нумерация статей другая. Всё, что ты помнишь о номерах
  статей ТК из старых источников, к нему НЕ относится.
- Налоговый кодекс РУз действует в новой редакции с 01.01.2020 (ЗРУ-599).
  Он заменил кодекс 2007 года, нумерация другая, а ЕНП, ЕСП и фиксированный
  налог заменены налогом с оборота, социальным налогом и НДФЛ.
- ВАЖНО: одинаковые номера в разных кодексах означают разное. Например
  статья 253 ТК — это сроки выплаты заработной платы, а статья 253 НК —
  налоговая база по срочным сделкам. Всегда указывай, какого кодекса статья.
- КОНКРЕТНЫЕ СТАВКИ НАЛОГОВ в справочнике не приводятся намеренно: они
  меняются почти каждый год. Проценты, пороги и суммы называй только если
  уверен полностью, иначе — «действующую ставку уточните на lex.uz или
  у бухгалтера». Ставку, названную по памяти, клиент заплатит деньгами.
- Закон об ООО — СОВСЕМ НОВЫЙ: ЗРУ-1137 от 21.04.2026, действует с 22.07.2026.
  Он заменил закон 2001 года № 310-II, нумерация другая, обществ с
  ДОПОЛНИТЕЛЬНОЙ ответственностью в нём больше нет. Всё, что ты помнишь про
  ООО Узбекистана, скорее всего относится к старому закону и неприменимо.
- Гражданский кодекс есть в справочнике целиком, обе части: часть первая —
  статьи 1–385, часть вторая — статьи 386–1199.
- КоАО есть целиком. Штрафы в нём указаны в БРВ (базовых расчётных величинах).
  Если текст статьи приведён — называй размер в БРВ ровно как там написано,
  но НЕ переводи БРВ в сумы: сама БРВ меняется, её размер надо сверять.
- Закон об ООО есть только названиями статей, без текста. Номер и название
  называй, а за содержанием отправляй на lex.uz.
- КОГДА В СПРАВКЕ ЕСТЬ «Текст статьи» — это дословная норма. Опирайся на неё,
  а не на память, и можешь пересказывать её содержание уверенно.
- По ГПК, ЭПК, Таможенному и Земельному кодексам, законам о лицензировании,
  бухучёте, валютном регулировании, защите прав потребителей, залоге,
  инвестициях, э-коммерции и по НСБУ справочника пока нет. По ним объясняй
  суть, но номера статей подавай как требующие проверки.
- Заканчивай ответ по праву строкой вида: Проверить: lex.uz
  Не пиши «Источник: … ст. NNN», если этого номера не было в справке.
- Напоминай, что это справочная информация, а не юридическая консультация,
  и что по сложным вопросам стоит обратиться к бухгалтеру Markus
  (+998 33 080-10-70, Telegram @MarkusJW_bot).

ЧЕГО НЕ ДЕЛАТЬ
Не помогай уклоняться от налогов, подделывать документы и отчётность, обходить
закон. Разница принципиальна: законная оптимизация налогов, выбор режима и
использование льгот — это нормально и это твоя работа; сокрытие доходов и
фальсификация — нет. В таком случае объясни риски и предложи законный путь.`;

// ------------------------------------------------------------
// СПРАВОЧНИК ЗАКОНОДАТЕЛЬСТВА РУз
// ------------------------------------------------------------
// Файл pravo-uz.json лежит в корне репозитория и содержит точные номера и
// названия статей (сейчас — весь Трудовой кодекс, 581 статья, выписан с
// lex.uz). Перед ответом на правовой вопрос сюда подбираются подходящие
// статьи и вставляются в задание модели.
//
// Зачем: модель не знает Трудовой кодекс 2022 года и раньше выдумывала
// номера статей — например, уверяла, что сроки выплаты зарплаты стоят в
// статье 124, а статья 253 про увольнение. На самом деле ровно наоборот.
// Теперь номера берутся из файла, а не из памяти модели.

let lawBook = null;          // индекс: номера и названия статей
let lawBookTried = false;
const codeText = {};         // тексты статей по кодексам, подгружаются по мере надобности

async function loadLawBook(env, origin) {
  if (lawBook || lawBookTried) return lawBook;
  lawBookTried = true;
  try {
    const resp = await env.ASSETS.fetch(new Request(origin + '/pravo-index.json'));
    if (!resp.ok) return null;
    lawBook = await resp.json();
  } catch {
    lawBook = null;
  }
  return lawBook;
}

// Текст статей лежит в отдельных файлах — по одному на кодекс. Грузим только
// тот, который реально понадобился: иначе на каждый вопрос пришлось бы
// разбирать пять мегабайт, а у Cloudflare на бесплатном тарифе очень
// небольшой лимит процессорного времени на запрос.
async function loadCodeText(env, origin, codeKey, code) {
  if (codeText[codeKey] !== undefined) return codeText[codeKey];
  if (!code || !code.файл_текста) { codeText[codeKey] = null; return null; }
  try {
    const resp = await env.ASSETS.fetch(new Request(origin + code.файл_текста));
    codeText[codeKey] = resp.ok ? await resp.json() : null;
  } catch {
    codeText[codeKey] = null;
  }
  return codeText[codeKey];
}

// Грубая нормализация слова: отрезаем окончание, чтобы «пеню» и «пеня»,
// «зарплату» и «зарплата» совпали. Точная морфология тут не нужна.
function stem(word) {
  const w = word.toLowerCase().replace(/ё/g, 'е');
  return w.slice(0, Math.min(6, Math.max(3, w.length - 2)));
}

// Клиенты пишут сокращениями. Раскрываем их в слова, которыми названы статьи.
const SYNONYMS = {
  ндс: 'добавленную стоимость', ққс: 'добавленную стоимость',
  ндфл: 'доходы физических лиц', жшдс: 'доходы физических лиц',
  ятт: 'индивидуальные предприниматели', ип: 'индивидуальные предприниматели',
  мчж: 'общество ограниченной ответственностью', ооо: 'общество ограниченной ответственностью',
  зарплата: 'заработной платы', зп: 'заработной платы',
  инн: 'идентификационный номер налогоплательщика', стир: 'идентификационный номер налогоплательщика',
  эсф: 'счет-фактура', эчф: 'счет-фактура',
  самозанятый: 'индивидуальных предпринимателей и самозанятых',
  штраф: 'штраф', пеня: 'пеня', декрет: 'беременности и родам',
  больничный: 'временной нетрудоспособности', командировка: 'служебных командировках',
};

// то же самое, но по основам слов
const SYNONYMS_BY_STEM = {};
for (const k of Object.keys(SYNONYMS)) SYNONYMS_BY_STEM[stem(k)] = SYNONYMS[k];

const STOP_WORDS = new Set([
  'какой','какая','какие','когда','почему','нужно','можно','должен','должна',
  'сколько','что','как','где','чтобы','этого','этом','этот','быть','если',
  'статья','статьи','статье','статью','кодекс','кодекса','кодексе','закон',
  'закона','узбекистан','узбекистана','республики','пожалуйста','скажи',
]);

// Подбирает статьи: сначала те, чей номер назван прямо, потом по смыслу.
function findArticles(book, text) {
  if (!book || !book.кодексы) return [];
  const found = [];
  const seen = new Set();

  const push = (codeKey, code, num) => {
    const art = code && code.статьи && code.статьи[num];
    if (!art) return;
    const key = codeKey + ':' + num;
    if (seen.has(key)) return;
    seen.add(key);
    const chap = (art.г !== undefined && code.главы) ? code.главы[art.г] : '';
    found.push({ код: codeKey, кодекс: code, номер: num, название: art.н, глава: chap || '' });
  };

  const lower = text.toLowerCase();

  // Какой документ имеется в виду. Важно: статья 253 есть и в Трудовом
  // («Сроки выплаты заработной платы»), и в Налоговом («Налоговая база
  // по срочным сделкам»). Без этой подсказки ассистент получил бы обе.
  const hints = {
    ТК: /(?<![а-яёa-z])тк(?![а-яёa-z])|трудов|работник|работодател|увольн|отпуск|зарплат|заработн|оклад|кадр|трудоустрой|прогул|совместительств|декрет|больничн/i,
    НК: /(?<![а-яёa-z])нк(?![а-яёa-z])|налог|ндс|ндфл|ққс|жшдс|акциз|прибыл|оборот|вычет|деклараци|счет-фактур|счёт-фактур|камеральн|пеня|соли[кқ]/i,
    ООО: /(?<![а-яёa-z])(?:ооо|мчж)(?![а-яёa-z])|общест|участник|уставн|устав|доля|доли|учредител|дивиденд|наблюдательн|аффилирован/i,
    КоАО: /коао|административн|штраф|взыскан|правонарушен|арест|конфискац|инспектор|протокол/i,
    ГК: /(?<![а-яёa-z])гк(?![а-яёa-z])|гражданск|сделк|обязательств|купл|продаж|поставк|аренд|подряд|заем|займ|кредит|поручительств|неустойк|убытк|исков(ая|ой) давност|наследств|собственност|дарени|мена|комисси|поручени|агентск|перевозк|хранени|страхован|услуг/i,
  };
  const hinted = Object.keys(hints).filter((k) => book.кодексы[k] && hints[k].test(lower));

  // Справку подмешиваем только к правовым вопросам. Без этой проверки
  // на «привет, как дела?» подтягивались бы статьи по случайному
  // совпадению букв.
  const LEGAL_SIGNAL = /стать|кодекс|закон|норматив|(?<![а-яёa-z])(?:пкм|пп|зру)(?![а-яёa-z])|юридич|правов|договор|штраф|санкци|пеня|пеню|пени|(?<![а-яёa-z])суд(?![а-яёa-z])|обязан|ответственност|льгот|отчетност|отчётност|провер|лицензи|регистрац/i;
  if (!hinted.length && !LEGAL_SIGNAL.test(lower)) return [];

  // 1) Номера, названные прямо. Номера с дополнением пишутся через дефис.
  const numbers = [];
  const re = /(?:ст\.?|стать(?:я|и|е|ю|ей))\s*№?\s*(\d{1,4}(?:\s*-\s*\d{1,2})?)/gi;
  let m;
  while ((m = re.exec(lower)) !== null) numbers.push(m[1].replace(/\s+/g, ''));

  if (numbers.length) {
    const codesToUse = hinted.length ? hinted : Object.keys(book.кодексы);
    for (const codeKey of codesToUse) {
      for (const num of numbers) push(codeKey, book.кодексы[codeKey], num);
    }
  }

  // 2) По смыслу — совпадение основ слов с названием статьи
  const words = lower.split(/[^а-яa-zё0-9]+/i).filter(Boolean);
  const expanded = [];
  for (const w of words) {
    // ищем и точное слово, и его основу: «зарплату» → «зарплата»
    const syn = SYNONYMS[w] || SYNONYMS_BY_STEM[stem(w)];
    if (syn) expanded.push(...syn.split(' '), w);
    else expanded.push(w);
  }
  const stems = [...new Set(
    expanded.filter((w) => w.length >= 4 && !STOP_WORDS.has(w)).map(stem)
  )];

  if (stems.length) {
    const scored = [];
    for (const [codeKey, code] of Object.entries(book.кодексы)) {
      for (const [num, art] of Object.entries(code.статьи || {})) {
        // Ищем и по названию, и по главе: девять статей НК называются
        // «Налоговые ставки», различить их можно только по главе.
        const chap = (art.г !== undefined && code.главы) ? (code.главы[art.г] || '') : '';
        const title = (art.н + ' ' + chap).toLowerCase();
        let hits = 0;
        for (const st of stems) if (title.includes(st)) hits++;
        if (!hits) continue;
        // Короткое название, совпавшее целиком, важнее длинного, совпавшего
        // одним словом: «Пеня» на вопрос про пеню — точное попадание.
        const titleWords = title.split(/\s+/).length;
        const score = hits + (hits / titleWords) * 3;
        // Для кодекса, на который вопрос указывает прямо, порог мягче:
        // «сроки выплаты зарплаты» должно находить ст. 253 ТК даже без
        // слова «работник» в вопросе.
        const need = hinted.includes(codeKey) ? 0.24 : 0.4;
        if (hits >= 2 || hits / titleWords >= need) {
          scored.push({ score, codeKey, code, num });
        }
      }
    }
    for (const it of scored) if (hinted.includes(it.codeKey)) it.score += 5;
    scored.sort((a, b) => b.score - a.score);
    for (const it of scored.slice(0, 8)) push(it.codeKey, it.code, it.num);
  }

  return found.slice(0, 10);
}

const MAX_FULL_TEXT = 3;      // скольким статьям подставляем полный текст
const TEXT_LIMIT = 1400;      // и сколько знаков от каждой

async function buildLawContext(book, question, history, env, origin) {
  if (!book) return '';
  const recent = (history || []).slice(-2).map((h) => h && h.text).filter(Boolean).join(' ');
  const arts = findArticles(book, question + ' ' + recent);
  if (!arts.length) return '';

  const byCode = {};
  for (const a of arts) (byCode[a.код] = byCode[a.код] || []).push(a);

  // Не больше двух кодексов за запрос — иначе можно упереться в лимит
  // процессорного времени на разборе файлов
  const codeKeys = Object.keys(byCode).slice(0, 2);
  const texts = {};
  for (const k of codeKeys) {
    texts[k] = await loadCodeText(env, origin, k, book.кодексы[k]);
  }

  let out = '\n\nСПРАВКА ИЗ LEX.UZ — выписка из действующего законодательства.\n';
  out += 'Это точные данные. Они главнее того, что ты помнишь. Номера и названия\n';
  out += 'статей бери только отсюда. Где приведён текст статьи — опирайся на него\n';
  out += 'дословно, а не на память.\n';

  let withText = 0;
  for (const codeKey of codeKeys) {
    const list = byCode[codeKey];
    const code = list[0].кодекс;
    out += `\n${code.полное_название} (${code.основание})\n`;
    if (code.предупреждение) out += `ВНИМАНИЕ: ${code.предупреждение}\n`;
    for (const a of list) {
      out += `  ст. ${a.номер} ${codeKey} РУз — ${a.название}`
           + (a.глава ? ` (глава: ${a.глава})` : '') + '\n';
      const body = texts[codeKey] && texts[codeKey][a.номер];
      if (body && withText < MAX_FULL_TEXT) {
        withText++;
        const cut = body.length > TEXT_LIMIT
          ? body.slice(0, TEXT_LIMIT).replace(/\s+\S*$/, '') + ' […далее см. lex.uz]'
          : body;
        out += `    Текст статьи: ${cut}\n`;
      }
    }
    out += `  Ссылка: ${code.ссылка}\n`;
  }
  out += '\nЕсли нужной нормы в справке нет — не подставляй номер по памяти,\n';
  out += 'а честно скажи, что его надо проверить на lex.uz.\n\n';
  return out;
}

// ------------------------------------------------------------
// ПРОВАЙДЕРЫ — по убыванию качества ответов.
// ------------------------------------------------------------
// Провайдер без ключа молча пропускается. Чтобы подключить нового —
// достаточно добавить его ключ в переменные Cloudflare, код не трогать.
//
// listUrl — адрес, по которому провайдер САМ сообщает список своих живых
//           моделей. Благодаря ему список ниже не устаревает.
// fallback — аварийный список на случай, если опрос не прошёл.
const PROVIDERS = [
  {
    id: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
    kind: 'gemini',
    listUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    prefer: [/flash-latest/i, /flash(?!-lite)/i, /flash-lite/i, /pro/i],
    fallback: ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'],
  },
  {
    // GEMINI ОКОЛЬНЫМ ПУТЁМ. Если Google отказал (а он отказывает ключам
    // нового формата на части аккаунтов), те же самые модели Gemini
    // берутся через OpenRouter — бесплатно и по обычному ключу
    // OPENROUTER_API_KEY. Отдельного ключа не нужно.
    // Благодаря этому качество ответов не падает до Groq, даже когда
    // прямой доступ к Google сломан.
    id: 'gemini-via-openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    listUrl: 'https://openrouter.ai/api/v1/models',
    freeOnly: true,
    onlyMatch: /^google\/gemini/i,
    headers: { 'HTTP-Referer': 'https://markus.uz', 'X-Title': 'MARKUS AI Assistant' },
    prefer: [/flash(?!-lite)/i, /pro/i, /flash-lite/i],
    fallback: ['google/gemini-2.5-flash:free', 'google/gemini-2.0-flash-exp:free'],
  },
  {
    // Mistral — щедрый бесплатный тариф, модели уровня Large.
    id: 'mistral',
    keyEnv: 'MISTRAL_API_KEY',
    kind: 'openai',
    url: 'https://api.mistral.ai/v1/chat/completions',
    listUrl: 'https://api.mistral.ai/v1/models',
    prefer: [/large-latest/i, /medium-latest/i, /small-latest/i],
    fallback: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  },
  {
    // Cerebras — большой дневной лимит, очень быстрые ответы.
    id: 'cerebras',
    keyEnv: 'CEREBRAS_API_KEY',
    kind: 'openai',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    listUrl: 'https://api.cerebras.ai/v1/models',
    prefer: [/gpt-oss/i, /gemma/i, /qwen/i, /llama/i],
    fallback: ['gpt-oss-120b', 'gemma-4-31b'],
  },
  {
    // Groq — быстрый и стабильный, рабочая лошадка.
    id: 'groq',
    keyEnv: 'GROQ_API_KEY',
    kind: 'openai',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    listUrl: 'https://api.groq.com/openai/v1/models',
    prefer: [/gpt-oss-120b/i, /70b/i, /gpt-oss/i, /qwen/i, /llama/i],
    fallback: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
  },
  {
    // NVIDIA NIM — бесплатные кредиты, формат OpenAI. Ключ необязателен:
    // без него провайдер просто не участвует.
    id: 'nvidia',
    keyEnv: 'NVIDIA_API_KEY',
    kind: 'openai',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    listUrl: 'https://integrate.api.nvidia.com/v1/models',
    prefer: [/llama-3\.[13]-70b/i, /70b/i, /gpt-oss/i, /qwen/i, /mistral/i],
    fallback: ['meta/llama-3.3-70b-instruct', 'openai/gpt-oss-120b'],
  },
  {
    // OpenRouter — последний рубеж. Умеет отдавать чужие модели, включая
    // бесплатные Gemini, поэтому годится и как обходной путь для Gemini.
    id: 'openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
    kind: 'openai',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    listUrl: 'https://openrouter.ai/api/v1/models',
    freeOnly: true, // из общего списка берём только бесплатные модели
    headers: { 'HTTP-Referer': 'https://markus.uz', 'X-Title': 'MARKUS AI Assistant' },
    prefer: [/gemini.*:free/i, /120b.*:free/i, /70b.*:free/i, /:free/i],
    fallback: ['openrouter/free', 'openai/gpt-oss-120b:free', 'openai/gpt-oss-20b:free'],
  },
  {
    // Запасное гнездо на будущее: любой провайдер формата OpenAI
    // подключается тремя переменными, без правки кода.
    id: 'extra',
    keyEnv: 'EXTRA_AI_KEY',
    kind: 'openai',
    urlEnv: 'EXTRA_AI_URL',
    modelEnv: 'EXTRA_AI_MODEL',
    fallback: [],
  },
];

// ------------------------------------------------------------
// ВЫБОР МОДЕЛЕЙ: спрашиваем провайдера, что у него живое
// ------------------------------------------------------------
// Список моделей у провайдеров меняется без предупреждения (Groq снимал
// llama-3.3-70b, Cerebras — llama и qwen, GitHub Models закрылся целиком).
// Поэтому список не хранится в коде, а запрашивается у самого провайдера
// и держится в памяти 6 часов.
const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;
const modelCache = {};        // { groq: { at: время, models: [...] } }
const MAX_MODELS_KEPT = 4;    // больше четырёх перебирать смысла нет

// Не чат-модели: картинки, звук, эмбеддинги, фильтры безопасности.
const NOT_A_CHAT_MODEL =
  /embed|embedding|whisper|tts|speech|audio|voice|guard|moderat|rerank|imagen|image|vision|veo|video|ocr|aqa|bison|gecko|distil|safety|sonar-deep|-thinking-|deep-research/i;

// Из двух живых моделей лучше та, что крупнее и новее. Размер («120b»,
// «70b») почти всегда важнее версии, поэтому у него больший вес.
function scoreModel(name, provider) {
  let score = 0;
  const prefer = provider.prefer || [];
  for (let i = 0; i < prefer.length; i++) {
    if (prefer[i].test(name)) {
      score += (prefer.length - i) * 1000;
      break;
    }
  }
  const size = name.match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i);
  if (size) score += Math.min(parseFloat(size[1]), 700) * 3;
  const ver = name.match(/(\d+(?:\.\d+)?)/);
  if (ver) score += Math.min(parseFloat(ver[1]), 100);
  if (/preview|exp|experimental|alpha|beta|rc\d/i.test(name)) score -= 400;
  if (/lite|mini|nano|tiny|small|8b|4b|1b/i.test(name)) score -= 300;
  if (/latest/i.test(name)) score += 200;
  return score;
}

// Спрашиваем у провайдера список моделей. Любая ошибка здесь не страшна:
// вернём пустой список, и в дело пойдёт аварийный список из кода.
async function fetchModelList(provider, apiKey, env) {
  const listUrl = provider.listUrl;
  if (!listUrl) return [];
  try {
    const headers =
      provider.kind === 'gemini'
        ? { 'x-goog-api-key': apiKey }
        : { Authorization: `Bearer ${apiKey}`, ...(provider.headers || {}) };

    const resp = await fetch(listUrl, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();

    let names = [];
    if (provider.kind === 'gemini') {
      names = (data.models || [])
        .filter((m) =>
          !m.supportedGenerationMethods ||
          m.supportedGenerationMethods.includes('generateContent')
        )
        .map((m) => String(m.name || '').replace(/^models\//, ''));
    } else {
      let items = data.data || data.models || [];
      if (provider.freeOnly) {
        items = items.filter((m) => {
          const p = m.pricing || {};
          const free = parseFloat(p.prompt || '0') === 0 && parseFloat(p.completion || '0') === 0;
          return free || /:free$/.test(String(m.id || ''));
        });
      }
      names = items.map((m) => String(m.id || m.name || ''));
    }

    return names
      .filter((n) => n && !NOT_A_CHAT_MODEL.test(n))
      .filter((n) => !provider.onlyMatch || provider.onlyMatch.test(n))
      .sort((a, b) => scoreModel(b, provider) - scoreModel(a, provider))
      .slice(0, MAX_MODELS_KEPT);
  } catch {
    return [];
  }
}

async function modelsFor(provider, apiKey, env) {
  // Ручная настройка запасного гнезда перевешивает всё остальное
  if (provider.modelEnv && env[provider.modelEnv]) {
    return env[provider.modelEnv].split(',').map((s) => s.trim()).filter(Boolean);
  }
  const cached = modelCache[provider.id];
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS && cached.models.length) {
    return cached.models;
  }
  const live = await fetchModelList(provider, apiKey, env);
  if (live.length) {
    modelCache[provider.id] = { at: Date.now(), models: live };
    return live;
  }
  return provider.fallback || [];
}

// ------------------------------------------------------------
// ВЫЗОВ МОДЕЛИ
// ------------------------------------------------------------

const BASE_CALL_TIMEOUT_MS = 12000;  // ни одно обращение не висит дольше
const HARD_DEADLINE_MS = 36000;      // весь ответ обязан уложиться в это время

function buildMessages(question, dateContext, history) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  // Память разговора: последние 8 реплик. Без них ассистент отвечал на
  // «а если наоборот?» как на первый вопрос — отсюда и жалобы на качество.
  for (const h of (history || []).slice(-8)) {
    if (!h || !h.text) continue;
    msgs.push({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.text).slice(0, 4000) });
  }
  msgs.push({ role: 'user', content: dateContext + question });
  return msgs;
}

// Google принимает ключ в заголовке x-goog-api-key. Ключи нового формата
// «AQ.…» на некоторых аккаунтах отвечают 401 ACCESS_TOKEN_TYPE_UNSUPPORTED —
// в этом случае пробуем тот же ключ как Bearer-токен: часть аккаунтов
// принимает именно так. Стоит это одной лишней попытки и только при отказе.
async function callGemini(apiKey, model, question, dateContext, history, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const contents = [];
  for (const h of (history || []).slice(-8)) {
    if (!h || !h.text) continue;
    contents.push({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: String(h.text).slice(0, 4000) }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: dateContext + question }] });

  const body = JSON.stringify({
    contents,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { maxOutputTokens: 2000 },
  });

  const attempts = [
    { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  ];

  let lastErr = '';
  for (let i = 0; i < attempts.length; i++) {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: attempts[i],
      body,
    });
    if (response.ok) {
      const data = await response.json();
      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!answer) throw new Error('пустой ответ');
      return answer;
    }
    const errText = await response.text().catch(() => '');
    lastErr = `HTTP ${response.status} ${errText.slice(0, 200)}`;
    // Вторую попытку делаем только если дело именно в типе ключа
    const worthRetry =
      response.status === 401 &&
      /ACCESS_TOKEN_TYPE_UNSUPPORTED|Expected OAuth 2|invalid authentication/i.test(errText);
    if (!worthRetry) break;
  }
  throw new Error(lastErr || 'HTTP ошибка');
}

// Groq, Mistral, Cerebras, NVIDIA и OpenRouter говорят на одном языке
// (формат OpenAI), поэтому для них достаточно одной функции.
async function callOpenAiCompatible(baseUrl, apiKey, model, question, dateContext, extraHeaders, history, timeoutMs) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(extraHeaders || {}),
    },
    body: JSON.stringify({
      model,
      messages: buildMessages(question, dateContext, history),
      max_tokens: 2000,
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

function callProvider(provider, apiKey, model, question, dateContext, env, history, timeoutMs) {
  const ms = Math.max(2000, Math.min(timeoutMs || BASE_CALL_TIMEOUT_MS, BASE_CALL_TIMEOUT_MS));
  if (provider.kind === 'gemini') {
    return callGemini(apiKey, model, question, dateContext, history, ms);
  }
  const url = provider.urlEnv ? env[provider.urlEnv] : provider.url;
  if (!url) return Promise.reject(new Error('не задан адрес провайдера'));
  return callOpenAiCompatible(url, apiKey, model, question, dateContext, provider.headers, history, ms);
}

// ------------------------------------------------------------
// РАЗБОР ОШИБОК
// ------------------------------------------------------------

// Проблема в ключе, а не в модели — остальные модели откажут так же.
function isKeyProblem(message) {
  return (
    message.includes('HTTP 401') ||
    message.includes('HTTP 403') ||
    message.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED') ||
    message.includes('API_KEY_SERVICE_BLOCKED') ||
    message.includes('API key not valid') ||
    message.includes('Incorrect API key')
  );
}

// «Слишком часто» и временные сбои самого провайдера.
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

// Сервис закрыт (410) или требует оплаты (402) — само не починится.
function isProviderDead(message) {
  return (
    message.includes('HTTP 410') ||
    message.includes('HTTP 402') ||
    message.includes('payment_required') ||
    message.includes('retirement')
  );
}

// Модель не найдена или снята: пробовать следующую модель ЭТОГО же
// провайдера имеет смысл, а откладывать провайдера — нет.
function isModelProblem(message) {
  return (
    message.includes('HTTP 404') ||
    message.includes('model_not_found') ||
    message.includes('does not exist') ||
    message.includes('decommissioned') ||
    message.includes('HTTP 400')
  );
}

// Провайдер, который только что отказал, откладывается — чтобы следующий
// посетитель не ждал впустую. Память живёт в конкретной копии воркера,
// поэтому это ускорение, а не жёсткое правило.
const failedUntil = {};
const KEY_MS = 30 * 60 * 1000;       // отклонён ключ — 30 минут
const BUSY_MS = 3 * 60 * 1000;       // лимит частоты — 3 минуты
const DEAD_MS = 12 * 60 * 60 * 1000; // закрыт/нужна оплата — полсуток
const lastGoodModel = {};            // удачная модель провайдера

// ------------------------------------------------------------
// ДИАГНОСТИКА — теперь только по секретному адресу
// ------------------------------------------------------------
// Раньше страницу мог открыть кто угодно: она дёргала всех провайдеров
// (то есть тратила бесплатные лимиты) и показывала начало ключей.
// Теперь нужен параметр ?key=… со значением переменной DIAG_SECRET.
// Если переменная не задана — диагностика выключена совсем.
function diagAllowed(url, env) {
  const secret = env.DIAG_SECRET;
  if (!secret) return false;
  return safeEqual(url.searchParams.get('key') || '', secret);
}

function keyShape(apiKey) {
  if (!apiKey) return '— не задан';
  const fmt = apiKey.startsWith('AQ.')
    ? 'формат AQ. (новый ключ Google)'
    : apiKey.startsWith('AIza')
      ? 'формат AIza (старый ключ Google)'
      : 'обычный';
  return `есть, длина ${apiKey.length}, ${fmt}`;
}

async function diagnoseProviders(env) {
  const report = [];
  for (const provider of PROVIDERS) {
    const apiKey = env[provider.keyEnv];
    if (!apiKey) {
      report.push({ провайдер: provider.id, статус: '— ключ не задан', переменная: provider.keyEnv });
      continue;
    }
    const list = await modelsFor(provider, apiKey, env);
    const источник = modelCache[provider.id] ? 'опрошен провайдер' : 'аварийный список в коде';
    const models = [];
    for (const model of list.slice(0, 3)) {
      const t0 = Date.now();
      try {
        await callProvider(provider, apiKey, model, 'Ответь одним словом: тест', '', env, [], 10000);
        models.push({ модель: model, статус: '✅ отвечает', мс: Date.now() - t0 });
        break;
      } catch (err) {
        models.push({
          модель: model,
          статус: '❌ ' + String((err && err.message) || err).slice(0, 200),
          мс: Date.now() - t0,
        });
      }
    }
    const ok = models.some((m) => m.статус.startsWith('✅'));
    report.push({
      провайдер: provider.id,
      статус: ok ? '✅ РАБОТАЕТ' : '❌ не отвечает',
      ключ: keyShape(apiKey),
      'список моделей': источник,
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

// ------------------------------------------------------------
// ГЛАВНАЯ ФУНКЦИЯ АССИСТЕНТА
// ------------------------------------------------------------
// Работает в два захода:
//   Заход 1 — по очереди, от лучшего провайдера к худшему. Так ответ
//             приходит от самой сильной модели, которая сейчас жива.
//   Заход 2 — если время на исходе, а ответа нет, оставшиеся провайдеры
//             опрашиваются ОДНОВРЕМЕННО и берётся первый успевший.
//             Это и есть страховка «ассистент должен отвечать всегда».
async function handleAssistant(request, env, url) {
  if (request.method === 'GET') {
    if (diagAllowed(url, env)) return diagnoseProviders(env);
    return json({ error: 'Только POST-запросы' }, 405);
  }
  if (request.method !== 'POST') {
    return json({ error: 'Только POST-запросы' }, 405);
  }

  const body = await readBody(request);
  const question = body.question;
  const today = body.today;
  const history = Array.isArray(body.history) ? body.history : [];

  if (!question || typeof question !== 'string') {
    return json({ error: 'Не передан вопрос' }, 400);
  }
  if (question.length > 8000) {
    return json({ error: 'Вопрос слишком длинный — сократите до 8000 знаков' }, 400);
  }

  let dateContext = today
    ? `Сегодняшняя дата: ${today}. Используй только актуальное на эту дату законодательство, а не устаревшие данные из твоего обучения.\n\n`
    : '';

  // Подмешиваем выписку из настоящего кодекса, если вопрос правовой
  try {
    const book = await loadLawBook(env, url.origin);
    dateContext += await buildLawContext(book, question, history, env, url.origin);
  } catch {
    // справочник недоступен — отвечаем без него, промпт запрещает выдумывать номера
  }

  const configured = PROVIDERS.filter((p) => {
    if (!env[p.keyEnv]) return false;
    if (p.urlEnv && !env[p.urlEnv]) return false;
    return true;
  });

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

  const startedAt = Date.now();
  const left = () => HARD_DEADLINE_MS - (Date.now() - startedAt);

  const now = Date.now();
  const fresh = configured.filter((p) => !(failedUntil[p.id] > now));
  const chain = fresh.length ? fresh : configured;

  const errors = [];
  const notTried = [];

  // ---------- ЗАХОД 1: по очереди, от лучшего к худшему ----------
  for (let pi = 0; pi < chain.length; pi++) {
    const provider = chain[pi];
    // Оставляем время на одновременный заход
    if (left() < 15000) {
      notTried.push(...chain.slice(pi));
      break;
    }

    const apiKey = env[provider.keyEnv];
    let models;
    try {
      models = await modelsFor(provider, apiKey, env);
    } catch {
      models = provider.fallback || [];
    }
    if (!models.length) continue;

    const good = lastGoodModel[provider.id];
    if (good && models.includes(good)) {
      models = [good, ...models.filter((m) => m !== good)];
    }

    let triedHere = 0;
    for (const model of models) {
      if (triedHere >= 2 || left() < 6000) break;
      triedHere++;
      try {
        const answer = await callProvider(provider, apiKey, model, question, dateContext, env, history, left() - 1500);
        lastGoodModel[provider.id] = model;
        delete failedUntil[provider.id];
        return json({ answer, model: `${provider.id}/${model}` });
      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        errors.push(`${provider.id} ${model}: ${msg}`);

        if (isProviderDead(msg)) { failedUntil[provider.id] = Date.now() + DEAD_MS; break; }
        if (isKeyProblem(msg)) { failedUntil[provider.id] = Date.now() + KEY_MS; break; }
        if (isModelProblem(msg)) {
          // Модель снята — забываем кэш, следующий запрос перечитает список
          delete modelCache[provider.id];
          continue;
        }
        if (isProviderBusy(msg)) { failedUntil[provider.id] = Date.now() + BUSY_MS; break; }
      }
    }
  }

  // ---------- ЗАХОД 2: все оставшиеся одновременно ----------
  // Кто первый ответил — того и берём. Медленный или зависший провайдер
  // больше не задерживает остальных.
  const raceList = notTried.length ? notTried : configured;
  const budget = left() - 1500;
  if (budget > 3000) {
    const attempts = [];
    for (const provider of raceList) {
      const apiKey = env[provider.keyEnv];
      let models = modelCache[provider.id]?.models || provider.fallback || [];
      if (!models.length) continue;
      const model = lastGoodModel[provider.id] || models[0];
      attempts.push(
        callProvider(provider, apiKey, model, question, dateContext, env, history, budget).then((answer) => {
          if (!answer) throw new Error('пустой ответ');
          lastGoodModel[provider.id] = model;
          return { answer, model: `${provider.id}/${model}` };
        }).catch((err) => {
          errors.push(`${provider.id} ${model} (параллельно): ${(err && err.message) || err}`);
          throw err;
        })
      );
    }
    if (attempts.length) {
      try {
        const winner = await Promise.any(attempts);
        delete failedUntil[winner.model.split('/')[0]];
        return json(winner);
      } catch {
        // все отказали — падаем в общий ответ ниже
      }
    }
  }

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

// Простая защита от заваливания заявками: не больше 15 сообщений в минуту
// из одной копии воркера. Обычному клиенту столько не нужно.
const leadTimestamps = [];
function leadFloodOk() {
  const now = Date.now();
  while (leadTimestamps.length && now - leadTimestamps[0] > 60000) leadTimestamps.shift();
  if (leadTimestamps.length >= 15) return false;
  leadTimestamps.push(now);
  return true;
}

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

async function handleLead(request, env, url) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  // ДИАГНОСТИКА — только по секретному адресу (см. DIAG_SECRET).
  // Раньше открыть её и разослать себе тестовые сообщения мог кто угодно.
  if (request.method === 'GET') {
    if (!diagAllowed(url, env)) return json({ error: 'Только POST-запросы' }, 405);

    const diag = {
      TELEGRAM_BOT_TOKEN: botToken ? `есть (длина ${botToken.length})` : '❌ НЕ НАЙДЕН',
      TELEGRAM_CHAT_ID: chatId ? `есть (${chatId})` : '❌ НЕ НАЙДЕН',
      TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET
        ? '✅ задан — вебхук защищён'
        : '⚠️ не задан — вебхук принимает сообщения от кого угодно',
    };
    if (!botToken || !chatId) {
      return json({ status: '❌ Переменные не настроены', diag });
    }
    try {
      const check = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
        signal: AbortSignal.timeout(10000),
      });
      const info = await check.json();
      if (!info.ok) {
        return json({ status: '❌ Токен бота неверный или отозван', diag, telegram: info });
      }
      const send = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
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

  if (!leadFloodOk()) {
    return json({ error: 'Слишком много заявок подряд. Подождите минуту и повторите.' }, 429);
  }

  const raw = await readBody(request);
  const name = cut(raw.name, 120);
  const phone = cut(raw.phone, 40);
  const source = cut(raw.source, 80);
  const message = cut(raw.message, 3000);
  const service = cut(raw.service, 200);
  const contactMethod = cut(raw.contactMethod, 40);
  const contactValue = cut(raw.contactValue, 200);

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
      signal: AbortSignal.timeout(12000),
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
  if (request.method !== 'POST') return json({ ok: true });

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const adminChatId = env.TELEGRAM_CHAT_ID;
  if (!botToken || !adminChatId) return json({ ok: true });

  // ПРОВЕРКА ПОДЛИННОСТИ. Telegram сам подставляет этот заголовок, если
  // при регистрации вебхука указан secret_token. Без проверки посторонний
  // мог отправить сюда поддельное «сообщение клиента».
  // Пока переменная не задана — работаем как раньше, чтобы бот не онемел.
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!safeEqual(got || '', secret)) return json({ ok: true });
  }

  const update = await readBody(request);
  const message = update.message;
  if (!message || !message.chat) return json({ ok: true });

  const clientChatId = message.chat.id;
  const text = cut(message.text, 3000).trim();

  // Если админ сам написал боту — не пересылаем самому себе
  if (String(clientChatId) === String(adminChatId)) return json({ ok: true });

  const sendMessage = (chatId, msgText) =>
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
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
        `💬 Сообщение от клиента в боте\n\n👤 ${cut(senderName, 120)} (${cut(username, 60)})\n🆔 chat_id: ${clientChatId}\n📝 ${text}`
      );
      await sendMessage(clientChatId, 'Спасибо! Ваше сообщение получено, мы ответим в ближайшее время.');
    }
  } catch {
    // Не даём вебхуку "падать" — Telegram при ошибках отключает его
  }

  return json({ ok: true });
}

// ============================================================
// ГЛАВНЫЙ ВХОД
// ============================================================

// Картинки и прочие файлы сайта: одна повторная попытка при сбое и явное
// разрешение браузеру держать их в кэше. Заказчик замечал, что логотип и
// фото иногда не появляются — чаще всего это единичный сбой запроса.
const CACHEABLE = /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|pdf|docx|vcf)$/i;

async function serveAsset(request, env) {
  let response;
  try {
    response = await env.ASSETS.fetch(request);
  } catch {
    response = null;
  }
  if (!response || response.status >= 500) {
    try {
      response = await env.ASSETS.fetch(request);
    } catch {
      return new Response('Файл временно недоступен, обновите страницу', { status: 503 });
    }
  }
  if (response.ok && CACHEABLE.test(new URL(request.url).pathname)) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/news') return await handleNews();
      if (path === '/api/assistant') return await handleAssistant(request, env, url);
      if (path === '/api/lead') return await handleLead(request, env, url);
      if (path === '/api/bot') return await handleBot(request, env);
      return await serveAsset(request, env);
    } catch (err) {
      // Никакая ошибка не должна ронять сайт целиком
      if (path.startsWith('/api/')) {
        return json({ error: 'Внутренняя ошибка сервера: ' + ((err && err.message) || err) }, 500);
      }
      return new Response('Временная ошибка, обновите страницу', { status: 503 });
    }
  },
};
