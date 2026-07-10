/* Shared UI module: language (en/ru) + theme (light/dark) with corner
   toggles. Loads before page scripts; exposes window.KiliwUI. */

(function () {
  const I18N = {
    en: {
      'title.auth': 'Sign in',
      'title.cloud': 'Kiliw Cloud',
      'tab.signin': 'Sign In',
      'tab.signup': 'Sign Up',
      'auth.welcome': 'Welcome back.',
      'auth.subLogin': 'Sign in to continue where you left off.',
      'auth.create': 'Create yours.',
      'auth.subReg': 'One account. Less than a minute.',
      'label.email': 'Email',
      'label.password': 'Password',
      'label.totp': '2FA code from your authenticator app',
      'btn.signin': 'Sign In',
      'btn.create': 'Create Account',
      'auth.forgot': 'Forgot password?',
      'auth.terms': 'By continuing you agree to the <a class="link" href="#">Terms of Service</a>.',
      'err.emailMissing': 'Enter your email address.',
      'err.emailInvalid': 'Enter a valid email address.',
      'err.passwordMissing': 'Enter your password.',
      'err.passwordShort': 'Password must be at least 8 characters.',
      'api.invalid-credentials': 'Incorrect email or password.',
      'api.user-exists': 'An account with this email already exists. Try signing in.',
      'api.invalid-email': 'Enter a valid email address.',
      'api.invalid-password': 'Password must be at least 8 characters.',
      'api.totp-invalid': 'Wrong 2FA code. Check your authenticator app and try again.',
      'api.captcha': 'Captcha verification failed. Please try again.',
      'api.not-configured': 'Server storage is not configured yet. Contact the site owner.',
      'auth.totpPrompt': 'Enter the 6-digit code from your authenticator app.',
      'auth.serverDown': 'Server API is unavailable: the Worker is not deployed correctly (see README).',
      'auth.generic': 'Something went wrong. Please try again.',
      'auth.network': 'Network error. Check your connection and try again.',
      'cloud.logout': 'Log out',
      'drop.title': 'Drop files here',
      'drop.or': 'or',
      'drop.browse': 'browse',
      'drop.hint': 'Up to {limit} per file',
      'drop.uploadingPct': 'Uploading {name}… {pct}%',
      'drop.quota': 'not enough storage',
      'cloud.newFolder': 'New folder',
      'folder.prompt': 'Folder name',
      'folder.deleteConfirm': 'Delete folder "{name}" with everything inside?',
      'file.preview': 'Preview',
      'preview.na': 'Preview is not available for this file type.',
      'usage.text': '{used} of {total} used',
      'profile.plan.title': 'Plan',
      'plan.free': 'Free',
      'plan.freeDesc': 'Up to 1 GB per file · 10 GB storage. Upgrade to Pro for files up to 50 GB.',
      'plan.proDesc': 'Pro: up to 50 GB per file · {gb} GB storage · active until {date}.',
      'plan.gbLabel': 'Storage size (GB)',
      'plan.price': '{gb} GB — {price} ₽ / 30 days',
      'plan.buy': 'Pay with YooKassa',
      'plan.notConfigured': 'Payments are not configured yet (YooKassa keys missing).',
      'plan.success': 'Payment received — Pro is active!',
      'plan.pending': 'Payment is not confirmed yet. Try again in a minute.',
      'plan.fail': 'Payment failed or was canceled.',
      'drop.uploading': 'Uploading {name}… ({i}/{n})',
      'drop.uploaded': 'Uploaded {files}.',
      'drop.failed': 'Failed to upload: {list}',
      'drop.tooLarge': 'too large',
      'files.title': 'Your files',
      'files.empty': 'Nothing here yet. Upload your first file.',
      'files.loadError': 'Could not load files. Try refreshing the page.',
      'files.notConfigured': 'Storage is not configured yet (R2 binding missing).',
      'file.download': 'Download',
      'file.delete': 'Delete',
      'file.deleteConfirm': 'Delete "{name}"?',
      'profile.title': 'Profile',
      'profile.pw.title': 'Change password',
      'profile.pw.current': 'Current password',
      'profile.pw.next': 'New password (min 8 characters)',
      'profile.pw.submit': 'Update password',
      'profile.pw.ok': 'Password updated. Other devices were signed out.',
      'profile.pw.wrong': 'Current password is incorrect.',
      'profile.pw.fail': 'Could not update the password. Try again.',
      'profile.pw.short': 'New password must be at least 8 characters.',
      'profile.2fa.title': 'Two-factor authentication',
      'badge.on': 'On',
      'badge.off': 'Off',
      'profile.2fa.offHint': 'Protect your account with one-time codes from Google Authenticator, 1Password or any TOTP app.',
      'profile.2fa.enable': 'Enable 2FA',
      'profile.2fa.setupHint': 'Scan the QR code with your authenticator app, or enter the secret manually. Then type the 6-digit code to confirm.',
      'profile.2fa.code': '6-digit code',
      'profile.2fa.confirm': 'Confirm & enable',
      'profile.2fa.onHint': '2FA is on: signing in requires a code from your authenticator app. To turn it off, enter a current code.',
      'profile.2fa.disable': 'Disable 2FA',
      'profile.2fa.wrongCode': 'Wrong code. Check your authenticator app and try again.',
      'profile.2fa.enableFail': 'Could not enable 2FA. Try again.',
      'profile.2fa.disableFail': 'Could not disable 2FA. Try again.',
    },
    ru: {
      'title.auth': 'Вход',
      'title.cloud': 'Kiliw Cloud',
      'tab.signin': 'Вход',
      'tab.signup': 'Регистрация',
      'auth.welcome': 'С возвращением.',
      'auth.subLogin': 'Войдите, чтобы продолжить.',
      'auth.create': 'Создайте аккаунт.',
      'auth.subReg': 'Один аккаунт. Меньше минуты.',
      'label.email': 'Почта',
      'label.password': 'Пароль',
      'label.totp': 'Код 2FA из приложения-аутентификатора',
      'btn.signin': 'Войти',
      'btn.create': 'Создать аккаунт',
      'auth.forgot': 'Забыли пароль?',
      'auth.terms': 'Продолжая, вы принимаете <a class="link" href="#">условия использования</a>.',
      'err.emailMissing': 'Введите адрес почты.',
      'err.emailInvalid': 'Введите корректный адрес почты.',
      'err.passwordMissing': 'Введите пароль.',
      'err.passwordShort': 'Пароль должен быть не короче 8 символов.',
      'api.invalid-credentials': 'Неверная почта или пароль.',
      'api.user-exists': 'Аккаунт с этой почтой уже существует. Попробуйте войти.',
      'api.invalid-email': 'Введите корректный адрес почты.',
      'api.invalid-password': 'Пароль должен быть не короче 8 символов.',
      'api.totp-invalid': 'Неверный код 2FA. Проверьте приложение и попробуйте снова.',
      'api.captcha': 'Проверка капчи не пройдена. Попробуйте ещё раз.',
      'api.not-configured': 'Хранилище на сервере ещё не настроено. Свяжитесь с владельцем сайта.',
      'auth.totpPrompt': 'Введите 6-значный код из приложения-аутентификатора.',
      'auth.serverDown': 'API сервера недоступно: Worker задеплоен неправильно (см. README).',
      'auth.generic': 'Что-то пошло не так. Попробуйте ещё раз.',
      'auth.network': 'Ошибка сети. Проверьте подключение и попробуйте снова.',
      'cloud.logout': 'Выйти',
      'drop.title': 'Перетащите файлы сюда',
      'drop.or': 'или',
      'drop.browse': 'выберите',
      'drop.hint': 'До {limit} на файл',
      'drop.uploadingPct': 'Загрузка {name}… {pct}%',
      'drop.quota': 'не хватает места',
      'cloud.newFolder': 'Новая папка',
      'folder.prompt': 'Название папки',
      'folder.deleteConfirm': 'Удалить папку «{name}» со всем содержимым?',
      'file.preview': 'Предпросмотр',
      'preview.na': 'Предпросмотр недоступен для этого типа файла.',
      'usage.text': 'Использовано {used} из {total}',
      'profile.plan.title': 'Тариф',
      'plan.free': 'Бесплатный',
      'plan.freeDesc': 'До 1 ГБ на файл · 10 ГБ хранилища. С Pro — файлы до 50 ГБ.',
      'plan.proDesc': 'Pro: до 50 ГБ на файл · {gb} ГБ хранилища · активен до {date}.',
      'plan.gbLabel': 'Объём хранилища (ГБ)',
      'plan.price': '{gb} ГБ — {price} ₽ / 30 дней',
      'plan.buy': 'Оплатить через ЮKassa',
      'plan.notConfigured': 'Платежи ещё не настроены (нет ключей ЮKassa).',
      'plan.success': 'Оплата прошла — Pro активирован!',
      'plan.pending': 'Платёж ещё не подтверждён. Проверьте через минуту.',
      'plan.fail': 'Платёж не прошёл или был отменён.',
      'drop.uploading': 'Загрузка {name}… ({i}/{n})',
      'drop.uploaded': 'Загружено: {files}.',
      'drop.failed': 'Не удалось загрузить: {list}',
      'drop.tooLarge': 'слишком большой',
      'files.title': 'Ваши файлы',
      'files.empty': 'Пока пусто. Загрузите первый файл.',
      'files.loadError': 'Не удалось загрузить список файлов. Обновите страницу.',
      'files.notConfigured': 'Хранилище ещё не настроено (нет привязки R2).',
      'file.download': 'Скачать',
      'file.delete': 'Удалить',
      'file.deleteConfirm': 'Удалить «{name}»?',
      'profile.title': 'Профиль',
      'profile.pw.title': 'Смена пароля',
      'profile.pw.current': 'Текущий пароль',
      'profile.pw.next': 'Новый пароль (мин. 8 символов)',
      'profile.pw.submit': 'Обновить пароль',
      'profile.pw.ok': 'Пароль обновлён. Остальные устройства разлогинены.',
      'profile.pw.wrong': 'Текущий пароль неверный.',
      'profile.pw.fail': 'Не удалось обновить пароль. Попробуйте ещё раз.',
      'profile.pw.short': 'Новый пароль должен быть не короче 8 символов.',
      'profile.2fa.title': 'Двухфакторная аутентификация',
      'badge.on': 'Вкл',
      'badge.off': 'Выкл',
      'profile.2fa.offHint': 'Защитите аккаунт одноразовыми кодами из Google Authenticator, 1Password или любого TOTP-приложения.',
      'profile.2fa.enable': 'Включить 2FA',
      'profile.2fa.setupHint': 'Отсканируйте QR-код приложением-аутентификатором или введите секрет вручную. Затем введите 6-значный код для подтверждения.',
      'profile.2fa.code': '6-значный код',
      'profile.2fa.confirm': 'Подтвердить и включить',
      'profile.2fa.onHint': '2FA включена: для входа нужен код из приложения. Чтобы отключить, введите текущий код.',
      'profile.2fa.disable': 'Отключить 2FA',
      'profile.2fa.wrongCode': 'Неверный код. Проверьте приложение и попробуйте снова.',
      'profile.2fa.enableFail': 'Не удалось включить 2FA. Попробуйте ещё раз.',
      'profile.2fa.disableFail': 'Не удалось отключить 2FA. Попробуйте ещё раз.',
    },
  };

  let lang = localStorage.getItem('kiliw_lang')
    || ((navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en');
  if (!I18N[lang]) lang = 'en';
  let theme = localStorage.getItem('kiliw_theme') === 'dark' ? 'dark' : 'light';

  const langCbs = [];
  const themeCbs = [];

  function t(key, vars) {
    let str = I18N[lang][key] ?? I18N.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, String(v));
      }
    }
    return str;
  }

  /** "3 files" / "3 файла" with proper Russian plural forms. */
  function filesCount(n) {
    if (lang === 'ru') {
      const mod10 = n % 10;
      const mod100 = n % 100;
      let word = 'файлов';
      if (mod10 === 1 && mod100 !== 11) word = 'файл';
      else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = 'файла';
      return `${n} ${word}`;
    }
    return `${n} ${n === 1 ? 'file' : 'files'}`;
  }

  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dataset.theme = theme;

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });

    const titleKey = document.body?.dataset.titleKey;
    if (titleKey) document.title = t(titleKey);

    const langBtn = document.getElementById('lang-toggle');
    if (langBtn) langBtn.querySelector('span').textContent = lang.toUpperCase();
  }

  window.KiliwUI = {
    t,
    filesCount,
    get lang() { return lang; },
    get theme() { return theme; },
    onLang(cb) { langCbs.push(cb); },
    onTheme(cb) { themeCbs.push(cb); },
  };

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      theme = theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('kiliw_theme', theme);
      apply();
      themeCbs.forEach((cb) => cb(theme));
    });
    document.getElementById('lang-toggle')?.addEventListener('click', () => {
      lang = lang === 'en' ? 'ru' : 'en';
      localStorage.setItem('kiliw_lang', lang);
      apply();
      langCbs.forEach((cb) => cb(lang));
    });
  });
})();
