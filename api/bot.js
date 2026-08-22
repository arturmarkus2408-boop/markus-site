// ============================================================
// ОБРАБОТЧИК ВХОДЯЩИХ СООБЩЕНИЙ TELEGRAM-БОТА (@MarkusJW_bot)
// ============================================================
// Что это: когда клиент САМ пишет что-то боту (а не когда сайт шлёт заявку через lead.js),
// Telegram присылает это сообщение сюда. Без этого файла сообщения клиентов просто
// "зависали" бы непрочитанными — бот на них никак не реагировал.
//
// Что делает:
//   1) Если клиент только что открыл бота (нажал /start) — бот отправляет ему приветствие.
//   2) Если клиент написал вопрос текстом — бот пересылает этот вопрос ТЕБЕ (в TELEGRAM_CHAT_ID)
//      и одновременно отвечает клиенту "сообщение получено".
//
// ВАЖНО: чтобы Telegram начал присылать сюда сообщения, нужно один раз "подписать" этот адрес
// как webhook — это делается одной ссылкой в браузере, см. инструкцию, которую пришлю отдельно.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true }); // Telegram иногда шлёт проверочные GET — просто отвечаем ok
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !adminChatId) {
    return res.status(200).json({ ok: true }); // молча выходим, чтобы Telegram не считал вебхук сломанным
  }

  const update = req.body || {};
  const message = update.message;
  if (!message || !message.chat) {
    return res.status(200).json({ ok: true }); // это не текстовое сообщение (например, статус прочтения) — игнорируем
  }

  const clientChatId = message.chat.id;
  const text = (message.text || '').trim();

  // Если админ сам написал что-то в бота (например, тестируя) — не пересылаем самому себе
  if (String(clientChatId) === String(adminChatId)) {
    return res.status(200).json({ ok: true });
  }

  const sendMessage = (chatId, text) =>
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

  try {
    if (text === '/start') {
      await sendMessage(
        clientChatId,
        'Здравствуйте! Это бот компании MARKUS — бухгалтерские, налоговые и юридические услуги в Узбекистане.\n\nОпишите ваш вопрос текстом — специалист ответит в ближайшее время.\n\n📞 +998 33 080-10-70'
      );
    } else if (text) {
      const from = message.from || {};
      const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Без имени';
      const username = from.username ? '@' + from.username : '—';
      await sendMessage(
        adminChatId,
        `💬 Сообщение от клиента в боте\n\n👤 ${senderName} (${username})\n🆔 chat_id: ${clientChatId}\n📝 ${text}`
      );
      await sendMessage(clientChatId, 'Спасибо! Ваше сообщение получено, мы ответим в ближайшее время.');
    }
  } catch (err) {
    // Не даём вебхуку "падать" — Telegram при ошибках может временно отключить его
  }

  return res.status(200).json({ ok: true });
}
