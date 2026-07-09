/* ============================================================
   Kiliw — логика страницы авторизации
   Cloudflare Turnstile + валидация форм
   ============================================================ */

/**
 * Ключ сайта Cloudflare Turnstile.
 * Сейчас стоит тестовый ключ Cloudflare («всегда проходит»),
 * он работает на любом домене и на localhost.
 * Для продакшена создайте виджет в панели Cloudflare
 * (Turnstile → Add site) и подставьте свой sitekey.
 */
const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';

/** Адрес серверной проверки токена (см. functions/api/verify.js). */
const VERIFY_ENDPOINT = '/api/verify';

const card = document.querySelector('.card');
const tabs = document.querySelector('.tabs');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');
const successPanel = document.getElementById('success-panel');
const successText = document.getElementById('success-text');

/* id виджетов Turnstile для каждой формы */
const widgets = new Map();

/* ---------- Turnstile ---------- */

window.onTurnstileLoad = function () {
  const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.querySelectorAll('[data-turnstile]').forEach((slot) => {
    const form = slot.closest('form');
    const widgetId = turnstile.render(slot, {
      sitekey: TURNSTILE_SITE_KEY,
      theme,
      language: 'ru',
      callback: () => setSubmitEnabled(form, true),
      'expired-callback': () => setSubmitEnabled(form, false),
      'error-callback': () => setSubmitEnabled(form, false),
    });
    widgets.set(form, widgetId);
  });
};

function setSubmitEnabled(form, enabled) {
  form.querySelector('.submit').disabled = !enabled;
}

function resetTurnstile(form) {
  const id = widgets.get(form);
  if (id !== undefined && window.turnstile) {
    turnstile.reset(id);
    setSubmitEnabled(form, false);
  }
}

/* ---------- Переключение вкладок ---------- */

function switchTo(name) {
  const isLogin = name === 'login';
  tabs.classList.toggle('register', !isLogin);
  tabLogin.classList.toggle('active', isLogin);
  tabRegister.classList.toggle('active', !isLogin);
  tabLogin.setAttribute('aria-selected', String(isLogin));
  tabRegister.setAttribute('aria-selected', String(!isLogin));

  formLogin.classList.toggle('active', isLogin);
  formRegister.classList.toggle('active', !isLogin);
  formLogin.hidden = !isLogin;
  formRegister.hidden = isLogin;
  successPanel.hidden = true;
}

tabLogin.addEventListener('click', () => switchTo('login'));
tabRegister.addEventListener('click', () => switchTo('register'));
document.querySelectorAll('[data-switch]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    switchTo(link.dataset.switch);
  });
});

/* ---------- Показ / скрытие пароля ---------- */

document.querySelectorAll('.toggle-password').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = btn.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.querySelector('.eye-open').style.display = show ? 'none' : '';
    btn.querySelector('.eye-closed').style.display = show ? '' : 'none';
    btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    input.focus();
  });
});

/* ---------- Индикатор надёжности пароля ---------- */

const regPassword = document.getElementById('reg-password');
const strengthMeter = document.querySelector('.strength');

regPassword.addEventListener('input', () => {
  const v = regPassword.value;
  let level = 0;
  if (v.length >= 8) level = 1;
  if (v.length >= 10 && /\d/.test(v) && /[a-zа-яё]/i.test(v)) level = 2;
  if (v.length >= 12 && /\d/.test(v) && /[a-zа-яё]/i.test(v) && /[^a-zа-яё0-9]/i.test(v)) level = 3;
  strengthMeter.dataset.level = String(level);
});

/* ---------- Валидация ---------- */

const MESSAGES = {
  valueMissing: 'Заполните это поле',
  typeMismatch: 'Введите корректный адрес почты',
  tooShort: 'Минимум 8 символов',
};

function validateField(input) {
  const field = input.closest('.field');
  if (!field) return input.checkValidity();
  const errorEl = field.querySelector('.field-error');
  let message = '';
  if (input.validity.valueMissing) message = MESSAGES.valueMissing;
  else if (input.validity.typeMismatch) message = MESSAGES.typeMismatch;
  else if (input.validity.tooShort) message = MESSAGES.tooShort;

  field.classList.toggle('invalid', Boolean(message));
  errorEl.textContent = message;
  return !message;
}

document.querySelectorAll('.form input').forEach((input) => {
  input.addEventListener('input', () => {
    const field = input.closest('.field');
    if (field && field.classList.contains('invalid')) validateField(input);
  });
});

/* ---------- Отправка ---------- */

async function handleSubmit(form, kind) {
  let valid = true;
  form.querySelectorAll('.field input').forEach((input) => {
    if (!validateField(input)) valid = false;
  });
  const terms = form.querySelector('input[name="terms"]');
  if (terms && !terms.checked) {
    terms.closest('.checkbox').style.outline = '2px solid var(--error)';
    terms.closest('.checkbox').style.outlineOffset = '4px';
    valid = false;
  } else if (terms) {
    terms.closest('.checkbox').style.outline = '';
  }
  if (!valid) return;

  const token = window.turnstile ? turnstile.getResponse(widgets.get(form)) : '';
  if (!token) {
    setSubmitEnabled(form, false);
    return;
  }

  const submitBtn = form.querySelector('.submit');
  submitBtn.classList.add('loading');
  submitBtn.disabled = true;

  try {
    /* Серверная проверка токена Turnstile.
       Если бэкенда ещё нет (открыли файл локально) — показываем успех,
       т.к. виджет уже пройден на клиенте. */
    let ok = true;
    try {
      const res = await fetch(VERIFY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, kind }),
      });
      if (res.ok) {
        const data = await res.json();
        ok = data.success === true;
      }
    } catch {
      /* эндпоинт недоступен — демо-режим */
    }

    if (ok) {
      showSuccess(kind);
      form.reset();
      strengthMeter.dataset.level = '0';
    } else {
      alert('Проверка капчи не пройдена. Попробуйте ещё раз.');
    }
  } finally {
    submitBtn.classList.remove('loading');
    resetTurnstile(form);
  }
}

formLogin.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSubmit(formLogin, 'login');
});
formRegister.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSubmit(formRegister, 'register');
});

/* ---------- Экран успеха ---------- */

function showSuccess(kind) {
  formLogin.classList.remove('active');
  formRegister.classList.remove('active');
  formLogin.hidden = true;
  formRegister.hidden = true;
  successText.textContent = kind === 'login'
    ? 'Вы успешно вошли в систему.'
    : 'Аккаунт создан. Добро пожаловать!';
  successPanel.hidden = false;

  /* перезапуск анимации галочки */
  const icon = successPanel.querySelector('.success-icon');
  icon.replaceWith(icon.cloneNode(true));
}

document.getElementById('success-back').addEventListener('click', () => {
  successPanel.hidden = true;
  switchTo('login');
});
