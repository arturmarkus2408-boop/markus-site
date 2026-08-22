// ============================================================
// СЕРВЕРНАЯ ФУНКЦИЯ ЛЕНТЫ НОВОСТЕЙ
// ============================================================
// Что это: берёт последние посты из публичного Telegram-канала @MARKUS_JW
// и отдаёт их сайту в виде простого списка.
// Как: у каждого публичного канала Telegram есть бесплатная веб-версия
// (t.me/s/<канал>) — она видна без токена бота, без входа в аккаунт.
// Сервер сам "читает" эту страницу и достаёт из неё последние сообщения.
// Хештеги внутри текста уже приходят от Telegram кликабельными ссылками —
// оставляем их как есть, просто подсвечиваем бронзовым цветом через CSS-класс.

const CHANNEL = 'MARKUS_JW';

export default async function handler(req, res) {
  try {
    const response = await fetch(`https://t.me/s/${CHANNEL}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarkusSiteBot/1.0)' },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Telegram недоступен, попробуйте позже' });
    }

    const html = await response.text();

    // Ищем блоки сообщений в публичной HTML-версии канала
    const messageBlocks = html.split('tgme_widget_message_wrap').slice(1);

    const posts = messageBlocks.slice(-25).reverse().map(block => {
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      const dateMatch = block.match(/<time datetime="([^"]+)"/);
      const linkMatch = block.match(/<a class="tgme_widget_message_date" href="([^"]+)"/);

      if (!textMatch) return null;

      let textHtml = textMatch[1]
        .replace(/<br\/?>/g, '\n')
        .replace(/tgme_widget_message_tag_hashtag/g, 'text-gold font-semibold no-underline')
        .trim();

      let date = '';
      if (dateMatch) {
        const d = new Date(dateMatch[1]);
        date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      }

      return { textHtml, date, link: linkMatch ? linkMatch[1] : null };
    }).filter(Boolean);

    return res.status(200).json({ posts });
  } catch (err) {
    return res.status(502).json({ error: 'Не удалось загрузить ленту: ' + err.message });
  }
}
