// Minimal Telegram Bot API client: send a message, and long-poll for
// commands (/status, /help) from the one configured chat. Without a token it
// falls back to printing messages to stdout, so the monitor can be run and
// checked locally before any bot exists.

const API = 'https://api.telegram.org';

function createTelegram({ token, chatId, log = console.log }) {
  const enabled = Boolean(token && chatId);

  async function call(method, body, timeoutMs = 20000) {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
    return data.result;
  }

  async function send(html) {
    if (!enabled) {
      log(`[telegram disabled] ${html.replace(/<[^>]+>/g, '')}`);
      return;
    }
    await call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
  }

  // Long-polls getUpdates forever, calling onCommand(name) for commands sent
  // from the configured chat only; messages from anyone else who finds the
  // bot are ignored.
  async function listen(onCommand) {
    if (!enabled) return;
    let offset = 0;
    for (;;) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 60000);
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg || String(msg.chat.id) !== String(chatId) || typeof msg.text !== 'string') continue;
          const command = msg.text.trim().split(/\s+/)[0].replace(/@.*$/, '').toLowerCase();
          try {
            await send(await onCommand(command));
          } catch (err) {
            log(`command ${command} failed: ${err.message}`);
          }
        }
      } catch (err) {
        log(`telegram poll error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  return { enabled, send, listen };
}

module.exports = { createTelegram };
