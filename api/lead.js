// ============================================================
// СЕРВЕРНАЯ ФУНКЦИЯ ОТПРАВКИ ЗАЯВОК
// ============================================================
// Что это: когда клиент нажимает "Отправить" в форме заявки на сайте,
// этот код на сервере пересылает данные в Telegram-бота — тебе на телефон.
// Зачем через сервер, а не напрямую из браузера: чтобы токен бота
// не был виден в коде сайта (иначе кто угодно сможет слать сообщения от имени бота).

export default async function handler(req, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // ДИАГНОСТИКА: открой /api/lead в браузере — покажет, что не так с настройкой бота
  if (req.method === 'GET') {
    const diag = {
      TELEGRAM_BOT_TOKEN: botToken ? `есть (${botToken.slice(0, 10)}…, длина ${botToken.length})` : '❌ НЕ НАЙДЕН',
      TELEGRAM_CHAT_ID: chatId ? `есть (${chatId})` : '❌ НЕ НАЙДЕН',
    };
    if (!botToken || !chatId) {
      return res.status(200).json({ status: '❌ Переменные не настроены', diag });
    }
    try {
      const check = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const info = await check.json();
      if (!info.ok) {
        return res.status(200).json({ status: '❌ Токен бота неверный или отозван', diag, telegram: info });
      }
      const send = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '✅ Проверка связи с сайтом MARKUS — всё работает!' }),
      });
      const sendResult = await send.json();
      if (!sendResult.ok) {
        return res.status(200).json({
          status: '❌ Бот найден, но не может отправить сообщение',
          подсказка: 'Чаще всего причина: вы не нажали /start у бота, либо TELEGRAM_CHAT_ID указан неверно',
          diag, bot: info.result.username, telegram: sendResult,
        });
      }
      return res.status(200).json({ status: '✅ ВСЁ РАБОТАЕТ — проверьте Telegram, туда пришло тестовое сообщение', diag, bot: info.result.username });
    } catch (err) {
      return res.status(200).json({ status: '❌ Ошибка связи с Telegram', diag, error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Только POST-запросы' });
  }

  if (!botToken || !chatId) {
    return res.status(500).json({
      error: 'TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не настроены на сервере.'
    });
  }

  const { name, phone, source, message, service, contactMethod, contactValue } = req.body || {};
  const isServiceQuestion = source === 'markus-site-service-question';
  const isCalcLead = source === 'markus-site-calculator';

  if (isServiceQuestion || isCalcLead) {
    if (!contactValue) {
      return res.status(400).json({ error: 'Не передан контакт для связи' });
    }
  } else if (!phone) {
    return res.status(400).json({ error: 'Не передан телефон' });
  }

  const methodLabels = { phone: 'Звонок / телефон', telegram: 'Telegram', whatsapp: 'WhatsApp', email: 'Email' };
  let header;
  if (isCalcLead) header = '🧮 Заявка с калькулятора MARKUS';
  else if (isServiceQuestion) header = '💬 Вопрос с сайта MARKUS (footer)';
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
  lines.push(`📍 Источник: markus-site (не сарафанное радио — это сайт)`);
  lines.push(`🕐 ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' })}`);
  const text = lines.join('\n');

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(502).json({ error: 'Telegram отклонил сообщение: ' + (errData.description || response.status) });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(502).json({ error: 'Не удалось связаться с Telegram: ' + err.message });
  }
}
