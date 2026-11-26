/* ============================================================
   КАЛЬКУЛЯТОР MARKUS
   Один файл на главную (раздел «Калькулятор») и на страницу /kalkulyator.
   Подключение:
     <link rel="stylesheet" href="/calc/markus-calc.css">
     <script src="/calc/markus-calc.js"></script>
     MarkusCalc.init(document.getElementById('...'), { onLead: (text, total) => {...} });
   Если onLead не передан, калькулятор показывает своё окно заявки
   и отправляет её в Telegram через /api/lead.

   ЦЕНЫ МЕНЯТЬ ТОЛЬКО ЗДЕСЬ, в PRICES ниже. Суммы в сумах.
   Пометка «ПРЕДЛОЖЕНО» = цену предложил Claude; владелец разрешил выложить
   их 22.11.2026. Остальные цены названы владельцем или были на сайте раньше.
   ============================================================ */
(function () {
  'use strict';

  const PRICES = {
    // ---- Ежемесячно ----
    // Базовая ставка по системе налогообложения. Для ОСН — сразу полная сумма,
    // без отдельной строки «надбавка» (решение владельца 26.11.2026).
    base: { usn: 4000000, osn: 7000000 },
    // Сотрудники: опорные точки [кол-во, сумма], между ними плавно (были на сайте)
    employees: [[0, 0], [3, 300000], [10, 800000], [25, 1600000], [50, 2800000], [100, 4500000]],
    // Документооборот, ступени «до N документов — сумма».
    // «до 10 — 50 000» назвал владелец, остальные ступени ПРЕДЛОЖЕНО.
    docs: [[10, 50000], [30, 150000], [50, 250000], [100, 450000], [200, 800000], [300, 1100000], [500, 1600000]],
    docsOverPerDoc: 3000,     // ПРЕДЛОЖЕНО: за каждый документ свыше 500
    // ВЭД — за каждую операцию в месяце, оплата по факту
    ved: [
      { id: 'reg',   name: 'Регистрация нового внешнеторгового контракта', desc: 'Постановка контракта на учёт в ЕЭИСВО, проверка реквизитов и условий оплаты', price: 400000 },
      { id: 'act',   name: 'Ввод акта / документа по контракту', desc: 'Акт выполненных работ, инвойс, ГТД — внесение в ЕЭИСВО', price: 100000 },
      { id: 'pay',   name: 'Перевод денег иностранному партнёру', desc: 'Валютный платёж: платёжное поручение и пакет документов в банк', price: 150000, proposed: true },
      { id: 'inc',   name: 'Поступление валютной выручки (экспорт)', desc: 'Контроль поступления в срок, учёт курсовых разниц', price: 100000, proposed: true },
      { id: 'gtd',   name: 'Учёт импортной ГТД', desc: 'Таможенные платежи, НДС при импорте, себестоимость товара', price: 150000, proposed: true },
      { id: 'close', name: 'Закрытие (снятие с учёта) контракта', desc: 'Сверка поставок и оплат, закрытие контракта в ЕЭИСВО', price: 300000, proposed: true },
    ],
    // Доп. услуги каждый месяц (были на сайте)
    monthly: [
      { id: 'hr',      name: 'Кадровый учёт полностью', desc: 'Трудовые договоры, приказы, табели, отпуска', price: 600000 },
      { id: 'mgmt',    name: 'Управленческий учёт', desc: 'Ежемесячный отчёт для владельца: прибыль по направлениям, движение денег, план-факт', price: 1500000 },
      { id: 'consult', name: 'Пакет консультаций (6 часов)', desc: 'Устные и письменные консультации бухгалтера', price: 400000 },
    ],
    // Скидка за оплату вперёд — только на абонентскую плату (были на сайте)
    terms: [
      { v: 0, name: 'Помесячно', note: 'Без скидки' },
      { v: 0.03, name: '3 месяца вперёд', note: 'Скидка 3%' },
      { v: 0.06, name: '6 месяцев вперёд', note: 'Скидка 6%' },
      { v: 0.1, name: '12 месяцев вперёд', note: 'Скидка 10%' },
    ],

    // ---- Разово ----
    // Составление договоров: «от 500 000» и «ВЭД-контракт от 1 000 000» назвал владелец,
    // остальные уровни ПРЕДЛОЖЕНО.
    contracts: [
      { id: 'std',    name: 'Типовой договор', desc: 'Купля-продажа, поставка, оказание услуг, аренда — на основе проверенного шаблона под ваши условия', price: 500000 },
      { id: 'ind',    name: 'Договор с индивидуальными условиями', desc: 'Подряд, агентский, дистрибуция, заём; спецификации и приложения, распределение рисков', price: 1000000, proposed: true },
      { id: 'vedc',   name: 'Экспортный / импортный контракт', desc: 'Внешнеторговый контракт: Инкотермс, валюта и сроки платежей, требования валютного контроля', price: 1000000 },
      { id: 'cmplx',  name: 'Сложный договор', desc: 'Требующий индивидуального подхода под требования Заказчика', price: 3000000 },
      { id: 'review', name: 'Проверка договора контрагента', desc: 'Разбор чужого проекта: риски, правки и комментарии в тексте', price: 500000, proposed: true },
    ],
    contractBilingual: 0.3,   // ПРЕДЛОЖЕНО: +30% за второй язык (RU+UZ или RU+EN)
    contractUrgent: 0.5,      // ПРЕДЛОЖЕНО: +50% за срочность (1 рабочий день)
    ecp: 600000,              // ЭЦП и доверенности (было на сайте; раньше ошибочно считалось каждый месяц)
    restorePerMonth: 1000000, // восстановление учёта за 1 месяц (было на сайте)
  };

  // Быстрый старт: типовые клиенты
  const PRESETS = [
    { name: 'Небольшая фирма', s: { regime: 'usn', emp: 2, docs: 30 } },
    { name: 'Торговля с импортом', s: { regime: 'usn', emp: 8, docs: 150, vedOn: true, ved: { reg: 1, act: 4, pay: 4, gtd: 4 } } },
    { name: 'Экспортёр', s: { regime: 'usn', emp: 10, docs: 100, vedOn: true, ved: { reg: 1, act: 6, inc: 4, close: 1 } } },
    { name: 'ОСН, 25 сотрудников', s: { regime: 'osn', emp: 25, docs: 300, monthly: { hr: true } } },
  ];

  // ---------- вспомогательное ----------
  const fmt = (n) => Math.round(n).toLocaleString('ru-RU');
  const sum = (n) => fmt(n) + ' сум';
  const round10k = (n) => Math.round(n / 10000) * 10000;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, isFinite(v) ? v : a));
  function interpolate(x, pts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      if (x >= x0 && x <= x1) return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
    }
    return pts[pts.length - 1][1];
  }
  function docsPrice(n) {
    if (n <= 0) return { price: 0, tier: 'нет документов' };
    for (const [max, price] of PRICES.docs) if (n <= max) return { price, tier: 'до ' + max + ' документов' };
    const last = PRICES.docs[PRICES.docs.length - 1];
    return { price: last[1] + (n - last[0]) * PRICES.docsOverPerDoc, tier: 'свыше ' + last[0] + ': +' + fmt(PRICES.docsOverPerDoc) + ' за документ' };
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }

  function emptyState() {
    const s = { regime: 'usn', emp: 0, docs: 10, vedOn: false, ved: {}, monthly: {}, term: 0,
      ecp: false, restoreOn: false, restoreMonths: 1, contractsOn: false, contracts: {}, bilingual: false, urgent: false };
    PRICES.ved.forEach((x) => (s.ved[x.id] = 0));
    PRICES.monthly.forEach((x) => (s.monthly[x.id] = false));
    PRICES.contracts.forEach((x) => (s.contracts[x.id] = 0));
    return s;
  }

  // ---------- расчёт ----------
  function compute(s) {
    const r = { lines: [], once: [] };
    r.base = PRICES.base[s.regime] || PRICES.base.usn;
    r.emp = round10k(interpolate(s.emp, PRICES.employees));
    const d = docsPrice(s.docs);
    r.docs = d.price; r.docsTier = d.tier;
    r.monthly = PRICES.monthly.filter((x) => s.monthly[x.id]);
    r.monthlySum = r.monthly.reduce((a, x) => a + x.price, 0);
    r.subscription = r.base + r.emp + r.docs + r.monthlySum;
    r.discount = Math.round(r.subscription * s.term);
    r.subscriptionNet = round10k(r.subscription - r.discount);

    r.ved = s.vedOn ? PRICES.ved.filter((x) => s.ved[x.id] > 0).map((x) => ({ ...x, n: s.ved[x.id], total: x.price * s.ved[x.id] })) : [];
    r.vedSum = r.ved.reduce((a, x) => a + x.total, 0);
    r.monthTotal = r.subscriptionNet + r.vedSum;

    const mult = 1 + (s.bilingual ? PRICES.contractBilingual : 0) + (s.urgent ? PRICES.contractUrgent : 0);
    r.contractMult = mult;
    r.contracts = s.contractsOn ? PRICES.contracts.filter((x) => s.contracts[x.id] > 0).map((x) => ({ ...x, n: s.contracts[x.id], total: round10k(x.price * mult) * s.contracts[x.id] })) : [];
    r.contractsSum = r.contracts.reduce((a, x) => a + x.total, 0);
    r.ecp = s.ecp ? PRICES.ecp : 0;
    r.restore = s.restoreOn ? s.restoreMonths * PRICES.restorePerMonth : 0;
    r.onceTotal = r.contractsSum + r.ecp + r.restore;
    return r;
  }

  // ---------- ссылка на расчёт (всё в адресе после #) ----------
  function encode(s) {
    const p = new URLSearchParams();
    p.set('r', s.regime); p.set('e', s.emp); p.set('d', s.docs);
    if (s.term) p.set('t', s.term);
    if (s.vedOn) p.set('v', PRICES.ved.map((x) => s.ved[x.id] || 0).join('.'));
    const m = PRICES.monthly.filter((x) => s.monthly[x.id]).map((x) => x.id);
    if (m.length) p.set('m', m.join('-'));
    if (s.contractsOn) p.set('c', PRICES.contracts.map((x) => s.contracts[x.id] || 0).join('.'));
    const f = [];
    if (s.bilingual) f.push('bi'); if (s.urgent) f.push('ur'); if (s.ecp) f.push('ecp');
    if (f.length) p.set('f', f.join('-'));
    if (s.restoreOn) p.set('rm', s.restoreMonths);
    return p.toString();
  }
  function decode(str) {
    const s = emptyState();
    const p = new URLSearchParams(str);
    if (!p.has('r')) return null;
    s.regime = p.get('r') === 'osn' ? 'osn' : 'usn';
    s.emp = clamp(parseInt(p.get('e'), 10), 0, 100);
    s.docs = clamp(parseInt(p.get('d'), 10), 0, 1000);
    const t = parseFloat(p.get('t'));
    if (PRICES.terms.some((x) => x.v === t)) s.term = t;
    if (p.has('v')) { s.vedOn = true; p.get('v').split('.').forEach((n, i) => { if (PRICES.ved[i]) s.ved[PRICES.ved[i].id] = clamp(parseInt(n, 10), 0, 99); }); }
    (p.get('m') || '').split(/[-,]/).forEach((id) => { if (id in s.monthly) s.monthly[id] = true; });
    if (p.has('c')) { s.contractsOn = true; p.get('c').split('.').forEach((n, i) => { if (PRICES.contracts[i]) s.contracts[PRICES.contracts[i].id] = clamp(parseInt(n, 10), 0, 99); }); }
    const f = (p.get('f') || '').split(/[-,]/);
    s.bilingual = f.includes('bi'); s.urgent = f.includes('ur'); s.ecp = f.includes('ecp');
    if (p.has('rm')) { s.restoreOn = true; s.restoreMonths = clamp(parseInt(p.get('rm'), 10), 1, 36); }
    return s;
  }

  // ---------- текст расчёта (для заявки и для копирования) ----------
  function summaryText(s, r, link) {
    const L = [];
    L.push('Абонентская плата: ' + sum(r.subscriptionNet) + ' в месяц');
    L.push('— режим: ' + (s.regime === 'osn' ? 'ОСН' : 'УСН (налог с оборота 4%)'));
    L.push('— сотрудники: ' + s.emp + ', документов в месяц: ' + s.docs + ' (' + r.docsTier + ')');
    r.monthly.forEach((x) => L.push('— ' + x.name + ': ' + sum(x.price)));
    const term = PRICES.terms.find((x) => x.v === s.term);
    L.push('— оплата: ' + term.name.toLowerCase() + (s.term ? ' (скидка ' + sum(r.discount) + ')' : ''));
    if (r.ved.length) {
      L.push('ВЭД по факту операций: ' + sum(r.vedSum) + ' в месяц');
      r.ved.forEach((x) => L.push('— ' + x.name + ': ' + x.n + ' × ' + fmt(x.price) + ' = ' + sum(x.total)));
    }
    L.push('Итого в месяц: ' + sum(r.monthTotal));
    if (r.onceTotal) {
      L.push('Разово: от ' + sum(r.onceTotal));
      r.contracts.forEach((x) => L.push('— ' + x.name + ': ' + x.n + ' шт. = от ' + sum(x.total)));
      if (r.contracts.length && (s.bilingual || s.urgent)) L.push('  (' + [s.bilingual && 'два языка', s.urgent && 'срочно'].filter(Boolean).join(', ') + ')');
      if (r.ecp) L.push('— Оформление ЭЦП и доверенностей: ' + sum(r.ecp));
      if (r.restore) L.push('— Восстановление учёта: ' + s.restoreMonths + ' мес. = от ' + sum(r.restore));
    }
    if (link) L.push('Расчёт: ' + link);
    return L.join('\n');
  }

  // ---------- интерфейс ----------
  function init(root, opts) {
    opts = opts || {};
    if (!root) return;
    root.classList.add('mc');
    let s = decode((location.hash || '').replace(/^#/, '')) || emptyState();
    const pageUrl = opts.pageUrl || (location.origin + '/kalkulyator');
    const refs = {};

    // --- карточка-вариант ---
    function opt(type, name, checked, title, desc, priceText, onChange) {
      const input = h('input', { type, name, checked: checked || null });
      const lab = h('label', { class: 'mc-opt' + (checked ? ' is-on' : '') },
        h('span', { class: 'mc-opt-l' }, input, h('span', null, h('span', { class: 'mc-opt-t', text: title }), desc ? h('span', { class: 'mc-opt-d', text: desc }) : null)),
        priceText ? h('span', { class: 'mc-opt-p', text: priceText }) : null);
      input.addEventListener('change', () => { onChange(input.checked); update(); });
      return { lab, input };
    }
    // --- ползунок с числом ---
    function rangeBlock(key, min, max, step, ticks) {
      const range = h('input', { type: 'range', class: 'mc-range', min, max, step, value: s[key], 'aria-label': key });
      const num = h('input', { type: 'number', class: 'mc-num', min, max, step: 1, value: s[key], inputmode: 'numeric' });
      range.addEventListener('input', () => { s[key] = +range.value; num.value = range.value; update(); });
      num.addEventListener('input', () => { s[key] = clamp(parseInt(num.value, 10), min, max); range.value = s[key]; update(); });
      num.addEventListener('blur', () => { num.value = s[key]; });
      const tickRow = h('div', { class: 'mc-ticks' }, ticks.map((t) => h('button', { type: 'button', text: String(t), onclick: () => { s[key] = t; range.value = t; num.value = t; update(); } })));
      refs[key] = { range, num };
      return h('div', null, h('div', { class: 'mc-range-row' }, range, num), tickRow);
    }
    // --- строка со счётчиком ---
    function stepRow(group, item, unit) {
      const inp = h('input', { type: 'number', min: 0, max: 99, value: s[group][item.id] || 0, inputmode: 'numeric', 'aria-label': item.name });
      const set = (v) => { s[group][item.id] = clamp(v, 0, 99); inp.value = s[group][item.id]; update(); };
      inp.addEventListener('input', () => set(parseInt(inp.value, 10)));
      const sumEl = h('span', { class: 'mc-step-sum' });
      const priceEl = h('span', { class: 'mc-step-p' });
      refs[group + ':' + item.id] = { inp, sumEl, priceEl, item, unit };
      return h('div', { class: 'mc-step-row' },
        h('div', null, h('span', { class: 'mc-step-t', text: item.name }), h('span', { class: 'mc-step-d', text: item.desc }), priceEl),
        h('div', { class: 'mc-stepper' },
          h('button', { type: 'button', 'aria-label': 'Меньше', text: '−', onclick: () => set((s[group][item.id] || 0) - 1) }),
          inp,
          h('button', { type: 'button', 'aria-label': 'Больше', text: '+', onclick: () => set((s[group][item.id] || 0) + 1) })),
        sumEl);
    }
    // --- переключаемый блок ---
    function switchBlock(key, title, desc, priceText, panelKids) {
      const input = h('input', { type: 'checkbox', checked: s[key] || null });
      const head = h('label', { class: 'mc-switch' + (s[key] ? ' is-on' : '') },
        h('span', { class: 'mc-opt-l' }, input, h('span', null, h('span', { class: 'mc-opt-t', text: title }), h('span', { class: 'mc-opt-d', text: desc }))),
        priceText ? h('span', { class: 'mc-opt-p', text: priceText }) : null);
      const panel = h('div', { class: 'mc-panel', hidden: !s[key] || null }, panelKids);
      input.addEventListener('change', () => { s[key] = input.checked; update(); });
      refs['sw:' + key] = { input, head, panel };
      return h('div', null, head, panel);
    }

    // ---------- разметка ----------
    const main = h('div', { class: 'mc-main' });

    main.append(h('div', null,
      h('p', { class: 'mc-h' }, 'Быстрый старт', h('small', { text: 'типовые варианты, потом подправьте' })),
      h('div', { class: 'mc-presets' }, PRESETS.map((p) => h('button', { type: 'button', class: 'mc-chip', text: p.name, onclick: () => applyPreset(p.s) })),
        h('button', { type: 'button', class: 'mc-chip', text: 'Сбросить', onclick: () => applyPreset({}) }))));

    // Режим
    const regimeOpts = [
      opt('radio', 'mc-regime', s.regime === 'usn', 'УСН — налог с оборота 4%', 'ИП, ООО, ЧП, ИП ООО, СП ООО', fmt(PRICES.base.usn), (on) => on && (s.regime = 'usn')),
      opt('radio', 'mc-regime', s.regime === 'osn', 'ОСН — НДС 12%, налог на прибыль 15%', 'ИП, ООО, ЧП, ИП ООО, СП ООО', fmt(PRICES.base.osn), (on) => on && (s.regime = 'osn')),
    ];
    refs.regime = regimeOpts;
    main.append(h('div', null, h('p', { class: 'mc-h', text: 'Режим налогообложения' }),
      h('p', { class: 'mc-sub', text: 'Выберите систему налогообложения вашего бизнеса — от неё зависит базовая ставка в месяц.' }),
      h('div', { class: 'mc-opts' }, regimeOpts.map((o) => o.lab))));

    // Сотрудники
    refs.empBadge = h('span', { class: 'mc-badge' });
    main.append(h('div', null, h('p', { class: 'mc-h' }, 'Сотрудники', refs.empBadge),
      h('p', { class: 'mc-sub', text: 'Зарплата, НДФЛ, ИНПС, социальный налог и отчётность по каждому сотруднику.' }),
      rangeBlock('emp', 0, 100, 1, [0, 3, 10, 25, 50, 100])));

    // Документооборот
    refs.docsBadge = h('span', { class: 'mc-badge' });
    refs.docsNote = h('p', { class: 'mc-note' });
    main.append(h('div', null, h('p', { class: 'mc-h' }, 'Документооборот в месяц', refs.docsBadge),
      h('p', { class: 'mc-sub', text: 'Все документы за месяц: ЭСФ, накладные, ТТН, акты, доверенности, платёжные поручения.' }),
      rangeBlock('docs', 0, 1000, 5, [0, 10, 50, 100, 300, 500, 1000]), refs.docsNote,
      h('p', { class: 'mc-note', text: 'Ступени: ' + PRICES.docs.map(([m, p]) => 'до ' + m + ' — ' + fmt(p)).join(' · ') + ' · свыше ' + PRICES.docs[PRICES.docs.length - 1][0] + ' — +' + fmt(PRICES.docsOverPerDoc) + ' за документ' })));

    // ВЭД
    main.append(h('div', null, h('p', { class: 'mc-h', text: 'Внешнеэкономическая деятельность' }),
      h('p', { class: 'mc-sub', text: 'Экспорт, импорт, валютный контроль. Оплачиваются только операции, которые были в месяце.' }),
      switchBlock('vedOn', 'У компании есть экспорт или импорт', 'Укажите, сколько операций обычно бывает за месяц', null,
        PRICES.ved.map((x) => stepRow('ved', x, 'в месяц')))));

    // Доп. услуги каждый месяц
    refs.monthly = PRICES.monthly.map((x) => opt('checkbox', null, s.monthly[x.id], x.name, x.desc, '+' + fmt(x.price), (on) => (s.monthly[x.id] = on)));
    main.append(h('div', null, h('p', { class: 'mc-h' }, 'Дополнительно каждый месяц', h('small', { text: 'необязательно' })),
      h('div', { class: 'mc-opts' }, refs.monthly.map((o) => o.lab))));

    // Разовые услуги
    refs.bilingual = h('input', { type: 'checkbox', checked: s.bilingual || null });
    refs.urgent = h('input', { type: 'checkbox', checked: s.urgent || null });
    refs.bilingual.addEventListener('change', () => { s.bilingual = refs.bilingual.checked; update(); });
    refs.urgent.addEventListener('change', () => { s.urgent = refs.urgent.checked; update(); });
    const ecpOpt = opt('checkbox', null, s.ecp, 'Оформление ЭЦП и доверенностей', 'Разово, без ведения', fmt(PRICES.ecp), (on) => (s.ecp = on));
    refs.ecp = ecpOpt;
    refs.restoreTotal = h('b', { class: 'mc-mono' });
    main.append(h('div', null, h('p', { class: 'mc-h' }, 'Разовые услуги', h('small', { text: 'оплачиваются один раз' })),
      h('div', { class: 'mc-opts' },
        switchBlock('contractsOn', 'Составление договоров', 'Цена зависит от сложности. Укажите, сколько договоров нужно', 'от ' + fmt(PRICES.contracts[0].price),
          [PRICES.contracts.map((x) => stepRow('contracts', x, 'шт.')),
            h('div', { class: 'mc-sub-opts' },
              h('label', { class: 'mc-check' }, refs.bilingual, h('span', null, 'На двух языках (RU + UZ или RU + EN) ', h('span', { class: 'mc-opt-gold', text: '+' + Math.round(PRICES.contractBilingual * 100) + '% к цене договора' }))),
              h('label', { class: 'mc-check' }, refs.urgent, h('span', null, 'Срочно — за 1 рабочий день ', h('span', { class: 'mc-opt-gold', text: '+' + Math.round(PRICES.contractUrgent * 100) + '% к цене договора' })))),
            h('p', { class: 'mc-note', text: 'Окончательную цену договора юрист называет после того, как увидит задачу.' })]),
        ecpOpt.lab,
        switchBlock('restoreOn', 'Восстановление учёта', 'За прошлые периоды: ' + sum(PRICES.restorePerMonth) + ' за месяц', 'от ' + fmt(PRICES.restorePerMonth),
          [h('p', { class: 'mc-h', style: 'margin-top:10px' }, 'Сколько месяцев восстановить', refs.restoreBadge = h('span', { class: 'mc-badge' })),
            rangeBlock('restoreMonths', 1, 36, 1, [1, 6, 12, 24, 36]),
            h('p', { class: 'mc-note' }, 'Сумма: ', refs.restoreTotal, '. Точная цена — после разговора со специалистом: зависит от состояния документов, числа операций и режима налогообложения за эти месяцы.')]))));

    // Срок оплаты
    refs.terms = PRICES.terms.map((t) => opt('radio', 'mc-term', s.term === t.v, t.name, null, null, (on) => on && (s.term = t.v)));
    refs.terms.forEach((o, i) => o.lab.querySelector('.mc-opt-l > span').append(h('span', { class: PRICES.terms[i].v ? 'mc-opt-gold' : 'mc-opt-d', text: PRICES.terms[i].note })));
    main.append(h('div', null, h('p', { class: 'mc-h' }, 'Оплата абонентской платы', h('small', { text: 'скидка за оплату вперёд' })),
      h('div', { class: 'mc-opts mc-opts-2' }, refs.terms.map((o) => o.lab))));

    // ---------- итог ----------
    refs.total = h('b');
    refs.lines = h('div', { class: 'mc-lines' });
    refs.onceTotal = h('b');
    refs.onceLines = h('div', { class: 'mc-lines', style: 'border-top:0;padding-top:6px;margin-bottom:0' });
    refs.once = h('div', { class: 'mc-once' }, h('p', { class: 'mc-sum-k', text: 'Разово' }),
      h('div', { class: 'mc-total' }, h('span', { text: 'от' }), refs.onceTotal, h('span', { text: 'сум' })), refs.onceLines);
    refs.toast = h('p', { class: 'mc-toast', 'aria-live': 'polite' });
    const leadBtn = h('button', { type: 'button', class: 'mc-btn mc-btn-gold', text: 'Оставить заявку на этот расчёт', onclick: () => lead() });
    const summaryBox = h('div', { class: 'mc-sum' },
      h('p', { class: 'mc-sum-k', text: 'Предварительная стоимость' }),
      h('div', { class: 'mc-total' }, refs.total, h('span', { text: 'сум' })),
      h('p', { class: 'mc-per', text: 'в месяц' }),
      refs.lines, refs.once,
      leadBtn,
      h('button', { type: 'button', class: 'mc-btn', text: 'Скачать смету (PDF)', onclick: () => printSummary() }),
      h('div', { class: 'mc-btn-row' },
        h('button', { type: 'button', class: 'mc-btn', text: 'Ссылка на расчёт', onclick: () => copyLink() }),
        h('a', { class: 'mc-btn', target: '_blank', rel: 'noopener', text: 'В Telegram', onclick: (e) => { e.currentTarget.href = 'https://t.me/share/url?url=' + encodeURIComponent(link()) + '&text=' + encodeURIComponent('Расчёт стоимости бухгалтерии MARKUS'); } })),
      refs.toast,
      h('a', { class: 'mc-btn', href: 'tel:+998330801070', text: '+998 33 080-10-70' }),
      h('p', { class: 'mc-fine', text: 'Стоимость предварительная. Окончательную сумму называет специалист MARKUS после разговора и до подписания договора.' }));
    const aside = h('div', { class: 'mc-aside' }, summaryBox);

    refs.barTotal = h('b');
    const bar = h('div', { class: 'mc-bar' },
      h('div', null, refs.barTotal, h('small', { text: 'сум в месяц · предварительно' })),
      h('button', { type: 'button', text: 'Подробнее', onclick: () => summaryBox.scrollIntoView({ behavior: 'smooth', block: 'start' }) }));

    root.replaceChildren(h('div', { class: 'mc-grid' }, main, aside));
    // Плашка внизу на телефоне: видна, пока калькулятор на экране, а итог — нет.
    // На главной её нет (opts.bottomBar: false): там внизу свои кнопки «Разделы» и «Наверх».
    if (opts.bottomBar !== false) document.body.append(bar);
    if (opts.bottomBar !== false && 'IntersectionObserver' in window) {
      let rootIn = false, sumIn = false;
      const sync = () => bar.classList.toggle('is-show', rootIn && !sumIn);
      new IntersectionObserver((e) => { rootIn = e[0].isIntersecting; sync(); }).observe(main);
      new IntersectionObserver((e) => { sumIn = e[0].isIntersecting; sync(); }).observe(summaryBox);
    }

    // ---------- обновление ----------
    function line(label, value, cls) {
      return h('div', { class: 'mc-line' + (cls ? ' ' + cls : '') }, h('span', { text: label }), h('span', { text: value }));
    }
    function update() {
      const r = compute(s);
      // состояние элементов
      refs.regime[0].input.checked = s.regime === 'usn'; refs.regime[1].input.checked = s.regime === 'osn';
      refs.regime.forEach((o) => o.lab.classList.toggle('is-on', o.input.checked));
      PRICES.monthly.forEach((x, i) => { refs.monthly[i].input.checked = s.monthly[x.id]; refs.monthly[i].lab.classList.toggle('is-on', s.monthly[x.id]); });
      PRICES.terms.forEach((t, i) => { refs.terms[i].input.checked = s.term === t.v; refs.terms[i].lab.classList.toggle('is-on', s.term === t.v); });
      refs.ecp.input.checked = s.ecp; refs.ecp.lab.classList.toggle('is-on', s.ecp);
      refs.bilingual.checked = s.bilingual; refs.urgent.checked = s.urgent;
      ['vedOn', 'contractsOn', 'restoreOn'].forEach((k) => { const w = refs['sw:' + k]; w.input.checked = !!s[k]; w.head.classList.toggle('is-on', !!s[k]); w.panel.hidden = !s[k]; });
      ['emp', 'docs', 'restoreMonths'].forEach((k) => {
        const { range, num } = refs[k];
        if (+range.value !== s[k]) range.value = s[k];
        if (document.activeElement !== num) num.value = s[k];
        const pct = (s[k] - range.min) / (range.max - range.min) * 100;
        range.style.background = 'linear-gradient(to right,#C9A46B 0%,#C9A46B ' + pct + '%,#2A2A2E ' + pct + '%,#2A2A2E 100%)';
      });
      Object.keys(refs).filter((k) => k.includes(':') && !k.startsWith('sw:')).forEach((k) => {
        const [group, id] = k.split(':'); const ref = refs[k];
        const n = s[group][id] || 0;
        if (document.activeElement !== ref.inp) ref.inp.value = n;
        const unitPrice = group === 'contracts' ? round10k(ref.item.price * r.contractMult) : ref.item.price;
        ref.priceEl.textContent = (group === 'contracts' ? 'от ' : '') + sum(unitPrice) + (group === 'ved' ? ' за операцию' : ' за договор');
        ref.sumEl.hidden = !n;
        ref.sumEl.textContent = n + ' × ' + fmt(unitPrice) + ' = ' + (group === 'contracts' ? 'от ' : '') + sum(n * unitPrice);
      });
      refs.empBadge.textContent = s.emp + ' чел.';
      refs.docsBadge.textContent = s.docs + ' док.';
      refs.docsNote.replaceChildren('Ваша ступень: ', h('b', { text: r.docsTier + ' — ' + sum(r.docs) }));
      refs.restoreBadge.textContent = s.restoreMonths + ' мес.';
      refs.restoreTotal.textContent = 'от ' + sum(s.restoreMonths * PRICES.restorePerMonth);

      // итог
      refs.total.textContent = fmt(r.monthTotal);
      refs.barTotal.textContent = fmt(r.monthTotal);
      const L = [line('Базовая ставка', fmt(r.base))];
      L.push(line('Сотрудники (' + s.emp + ')', fmt(r.emp)));
      L.push(line('Документооборот (' + s.docs + ')', fmt(r.docs)));
      r.monthly.forEach((x) => L.push(line(x.name, fmt(x.price))));
      if (r.discount) L.push(line('Скидка за оплату вперёд', '−' + fmt(r.discount), 'is-gold'));
      if (r.ved.length) {
        L.push(line('Абонентская плата', fmt(r.subscriptionNet), 'is-head'));
        L.push(line('ВЭД, по факту операций', fmt(r.vedSum), 'is-head'));
        r.ved.forEach((x) => L.push(line(x.name + ' × ' + x.n, fmt(x.total), 'is-sub')));
      }
      refs.lines.replaceChildren(...L);

      refs.once.hidden = !r.onceTotal;
      refs.onceTotal.textContent = fmt(r.onceTotal);
      const O = [];
      r.contracts.forEach((x) => O.push(line(x.name + ' × ' + x.n, 'от ' + fmt(x.total))));
      if (r.contracts.length && r.contractMult > 1) O.push(line([s.bilingual && 'два языка', s.urgent && 'срочно'].filter(Boolean).join(', ') + ' — учтено', '', 'is-sub'));
      if (r.ecp) O.push(line('ЭЦП и доверенности', fmt(r.ecp)));
      if (r.restore) O.push(line('Восстановление учёта, ' + s.restoreMonths + ' мес.', 'от ' + fmt(r.restore)));
      refs.onceLines.replaceChildren(...O);

      // адрес страницы обновляем только на отдельной странице калькулятора
      if (opts.syncHash) { try { history.replaceState(null, '', '#' + encode(s)); } catch (e) { /* не критично */ } }
      root.__mcLast = { s, r };
    }

    function applyPreset(p) {
      const base = emptyState();
      s = Object.assign(base, JSON.parse(JSON.stringify(p)));
      s.ved = Object.assign(emptyState().ved, p.ved || {});
      s.monthly = Object.assign(emptyState().monthly, p.monthly || {});
      s.contracts = Object.assign(emptyState().contracts, p.contracts || {});
      update();
    }

    const link = () => pageUrl + '#' + encode(s);
    function toast(t) { refs.toast.textContent = t; clearTimeout(toast.t); toast.t = setTimeout(() => (refs.toast.textContent = ''), 3500); }
    function copyLink() {
      const url = link();
      const done = () => toast('Ссылка скопирована — отправьте её клиенту или коллеге');
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, () => fallback(url));
      else fallback(url);
      function fallback(u) {
        const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = u; document.body.append(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { prompt('Скопируйте ссылку:', u); }
        ta.remove();
      }
    }

    function lead() {
      const r = compute(s);
      const text = summaryText(s, r, link());
      const total = fmt(r.monthTotal);
      if (typeof opts.onLead === 'function') return opts.onLead(text, total);
      openModal(text, total);
    }

    // ---------- окно заявки (на отдельной странице) ----------
    let modal;
    function openModal(text, total) {
      if (!modal) {
        const method = h('select', null,
          h('option', { value: 'phone', text: 'Телефон' }), h('option', { value: 'telegram', text: 'Telegram' }),
          h('option', { value: 'whatsapp', text: 'WhatsApp' }), h('option', { value: 'email', text: 'Email' }));
        const contact = h('input', { type: 'text', autocomplete: 'tel', placeholder: '+998 90 123 45 67', maxlength: 120 });
        const area = h('textarea', { maxlength: 2900 });
        const msg = h('p', { class: 'mc-modal-msg', 'aria-live': 'polite' });
        const send = h('button', { type: 'button', class: 'mc-btn mc-btn-gold', text: 'Отправить' });
        const ph = { phone: '+998 90 123 45 67', telegram: '@username', whatsapp: '+998 90 123 45 67', email: 'name@example.com' };
        method.addEventListener('change', () => { contact.placeholder = ph[method.value]; contact.type = method.value === 'email' ? 'email' : 'text'; });
        send.addEventListener('click', async () => {
          const value = contact.value.trim();
          if (value.length < 4) { msg.className = 'mc-modal-msg is-err'; msg.textContent = 'Укажите, как с вами связаться.'; contact.focus(); return; }
          send.disabled = true; send.textContent = 'Отправляем…'; msg.textContent = '';
          try {
            const resp = await fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source: 'markus-site-calculator', service: 'Калькулятор — ' + modal.total + ' сум/мес', message: area.value, contactMethod: method.value, contactValue: value }) });
            if (resp.ok) { msg.className = 'mc-modal-msg is-ok'; msg.textContent = 'Заявка отправлена. Мы свяжемся с вами в ближайшее время.'; contact.value = ''; }
            else { const d = await resp.json().catch(() => ({})); msg.className = 'mc-modal-msg is-err'; msg.textContent = (d.error || 'Не удалось отправить') + '. Напишите нам: t.me/MarkusJW_bot'; }
          } catch (e) { msg.className = 'mc-modal-msg is-err'; msg.textContent = 'Нет связи с сервером. Напишите нам: t.me/MarkusJW_bot или позвоните +998 33 080-10-70'; }
          send.disabled = false; send.textContent = 'Отправить';
        });
        modal = h('div', { class: 'mc-modal mc', hidden: true, role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === modal) modal.hidden = true; } },
          h('div', { class: 'mc-modal-box' },
            h('h3', { text: 'Заявка на расчёт' }),
            h('p', { class: 'mc-sub', text: 'Специалист MARKUS свяжется с вами, уточнит детали и назовёт точную стоимость.' }),
            h('label', { class: 'mc-field' }, 'Как удобнее связаться', method),
            h('label', { class: 'mc-field' }, 'Ваш контакт', contact),
            h('label', { class: 'mc-field' }, 'Ваш расчёт (можно дописать вопрос)', area),
            msg, h('div', { style: 'height:12px' }), send,
            h('button', { type: 'button', class: 'mc-btn', text: 'Закрыть', onclick: () => (modal.hidden = true) })));
        modal.area = area; modal.contact = contact; modal.msg = msg;
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal) modal.hidden = true; });
        document.body.append(modal);
      }
      modal.total = total; modal.area.value = text; modal.msg.textContent = '';
      modal.hidden = false; modal.contact.focus();
    }

    // ---------- смета для печати / PDF ----------
    function printSummary() {
      const r = compute(s);
      const row = (a, b, sub) => '<tr style="border-bottom:1px solid #ececec"><td style="padding:7px 12px 7px ' + (sub ? '14px' : '0') + ';color:' + (sub ? '#777' : '#333') + ';vertical-align:top">' + esc(a) + '</td><td style="padding:7px 0;text-align:right;white-space:nowrap;vertical-align:top;font-variant-numeric:tabular-nums">' + esc(b) + '</td></tr>';
      const table = (rows, totalLabel, totalVal) => '<table style="width:100%;border-collapse:collapse;font:14px Arial,sans-serif"><tbody>' + rows.join('') + '</tbody><tfoot><tr style="border-top:2px solid #000"><td style="padding:9px 0;font-weight:bold">' + totalLabel + '</td><td style="padding:9px 0;font-weight:bold;text-align:right;white-space:nowrap">' + totalVal + '</td></tr></tfoot></table>';
      const head = (t, note) => '<p style="font:bold 12.5px Arial,sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#555;margin:22px 0 6px">' + t + (note ? ' <span style="font-weight:normal;text-transform:none;color:#999">' + note + '</span>' : '') + '</p>';
      const term = PRICES.terms.find((x) => x.v === s.term);
      const A = [row('Режим налогообложения', s.regime === 'osn' ? 'ОСН' : 'УСН (4%)'), row('Базовая ставка', sum(r.base))];
      A.push(row('Сотрудники: ' + s.emp, sum(r.emp)));
      A.push(row('Документооборот: ' + s.docs + ' в месяц (' + r.docsTier + ')', sum(r.docs)));
      r.monthly.forEach((x) => A.push(row(x.name, sum(x.price))));
      A.push(row('Оплата: ' + term.name.toLowerCase(), s.term ? '−' + sum(r.discount) : 'без скидки'));
      let html = '<div style="font-family:\'PT Serif\',Georgia,serif;padding:8px 4px;color:#111">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px"><div><h1 style="font-size:23px;margin:0 0 4px">MARKUS — смета на бухгалтерское сопровождение</h1>' +
        '<p style="color:#666;font-size:13px;margin:0">Сформировано: ' + new Date().toLocaleDateString('ru-RU') + ' · markus.uz</p></div>' +
        '<img src="/logo-m.png" alt="" style="height:46px;width:auto"></div>';
      html += head('Абонентская плата', '(каждый месяц)') + table(A, 'Итого абонентская плата', sum(r.subscriptionNet));
      if (r.ved.length) {
        html += head('Внешнеэкономическая деятельность', '(по факту операций месяца)') +
          table(r.ved.map((x) => row(x.name + ': ' + x.n + ' × ' + fmt(x.price), sum(x.total))), 'Итого ВЭД', sum(r.vedSum));
      }
      html += '<p style="font:bold 16px Arial,sans-serif;display:flex;justify-content:space-between;margin:16px 0 0;padding:10px 0;border-top:3px double #000"><span>Итого в месяц</span><span>' + sum(r.monthTotal) + '</span></p>';
      if (r.onceTotal) {
        const B = [];
        r.contracts.forEach((x) => B.push(row(x.name + ': ' + x.n + ' шт.', 'от ' + sum(x.total))));
        if (r.contracts.length && r.contractMult > 1) B.push(row('Учтено: ' + [s.bilingual && 'два языка', s.urgent && 'срочно'].filter(Boolean).join(', '), '', true));
        if (r.ecp) B.push(row('Оформление ЭЦП и доверенностей', sum(r.ecp)));
        if (r.restore) B.push(row('Восстановление учёта: ' + s.restoreMonths + ' мес.', 'от ' + sum(r.restore)));
        html += head('Разовые услуги', '(оплачиваются один раз)') + table(B, 'Итого разово', 'от ' + sum(r.onceTotal));
      }
      html += '<div style="position:relative;margin-top:26px"><img src="/seal-real-gold.png" alt="" style="position:absolute;right:0;top:-40px;width:104px;opacity:.72;transform:rotate(-7deg)">' +
        '<p style="font:11.5px/1.55 Arial,sans-serif;color:#8a8a8a;max-width:60%;margin:0">Стоимость предварительная. Окончательную сумму называет специалист MARKUS после разговора и до подписания договора.<br>+998 33 080-10-70 · Telegram: @MarkusJW_bot · markus.uz</p>' +
        '<p style="font:11px Arial,sans-serif;color:#aaa;margin:8px 0 0;word-break:break-all">Открыть расчёт: ' + esc(link()) + '</p></div></div>';
      let box = document.getElementById('mc-print');
      if (!box) { box = h('div', { id: 'mc-print' }); document.body.append(box); }
      box.innerHTML = html;
      document.body.classList.add('mc-printing');
      const done = () => document.body.classList.remove('mc-printing');
      window.addEventListener('afterprint', done, { once: true });
      // печать ждёт загрузки логотипа и печати, иначе на PDF их может не быть
      const imgs = Array.from(box.querySelectorAll('img'));
      Promise.all(imgs.map((im) => im.complete ? 0 : new Promise((ok) => { im.onload = im.onerror = ok; }))).then(() => { window.print(); setTimeout(done, 1000); });
    }
    function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    update();
    return { getState: () => JSON.parse(JSON.stringify(s)), summary: () => summaryText(s, compute(s), link()), link };
  }

  window.MarkusCalc = { init, PRICES, compute, encode, decode };
})();
