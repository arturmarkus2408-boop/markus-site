// ============================================================
// СЕРВЕРНАЯ ФУНКЦИЯ ОТПРАВКИ ЗАЯВОК
// ============================================================
// Что это: когда клиент нажимает "Отправить" в форме заявки на сайте,
// этот код на сервере пересылает данные в Telegram-бота — тебе на телефон.
// Зачем через сервер, а не напрямую из браузера: чтобы токен бота
// не был виден в коде сайта (иначе кто угодно сможет слать сообщения от имени бота).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Только POST-запросы' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return res.status(500).json({
      error: 'TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не настроены на сервере.'
    });
  }

  const { name, phone, source, message, service } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: 'Не передан телефон' });
  }

  const isServiceQuestion = source === 'markus-site-service-question';
  const header = isServiceQuestion ? '💬 Вопрос с сайта MARKUS (footer)' : '🆕 Новая заявка с сайта MARKUS';
  const lines = [header, ''];
  if (isServiceQuestion) {
    lines.push(`🏷️ Услуга: ${service || '—'}`);
    lines.push(`📝 Вопрос: ${message || '—'}`);
  } else {
    lines.push(`👤 Имя: ${name || '—'}`);
  }
  lines.push(`📞 Телефон: ${phone}`);
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
