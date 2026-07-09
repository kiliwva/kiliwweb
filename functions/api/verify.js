/**
 * Cloudflare Pages Function: POST /api/verify
 * Серверная проверка токена Turnstile через siteverify.
 *
 * Секретный ключ задаётся в переменной окружения TURNSTILE_SECRET_KEY
 * (Pages → Settings → Environment variables).
 * По умолчанию используется тестовый секрет Cloudflare,
 * который всегда возвращает success — только для разработки!
 */

const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'bad-request' }, 400);
  }

  const token = body?.token;
  if (!token || typeof token !== 'string') {
    return json({ success: false, error: 'missing-token' }, 400);
  }

  const secret = env.TURNSTILE_SECRET_KEY || TEST_SECRET_KEY;
  const ip = request.headers.get('CF-Connecting-IP') || '';

  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  if (ip) formData.append('remoteip', ip);

  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });
  const outcome = await result.json();

  if (!outcome.success) {
    return json({ success: false, error: outcome['error-codes'] }, 403);
  }

  // Токен подтверждён — здесь можно выполнять вход/регистрацию.
  return json({ success: true });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
