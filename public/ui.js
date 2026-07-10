/* Shared UI module: interface strings.
   Loads before page scripts; exposes window.KiliwUI. */

(function () {
  const STRINGS = {
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
    'drop.uploading': 'Uploading {name}… ({i}/{n})',
    'drop.uploadingPct': 'Uploading {name}… {pct}%',
    'drop.uploaded': 'Uploaded {files}.',
    'drop.failed': 'Failed to upload: {list}',
    'drop.tooLarge': 'too large',
    'drop.quota': 'not enough storage',
    'cloud.newFolder': 'New folder',
    'folder.prompt': 'Folder name',
    'folder.deleteConfirm': 'Delete folder "{name}" with everything inside?',
    'file.preview': 'Preview',
    'preview.na': 'Preview is not available for this file type.',
    'usage.text': '{used} of {total} used',
    'files.title': 'Your files',
    'files.empty': 'Nothing here yet. Upload your first file.',
    'files.loadError': 'Could not load files. Try refreshing the page.',
    'files.notConfigured': 'Storage is not configured yet (R2 binding missing).',
    'file.download': 'Download',
    'file.delete': 'Delete',
    'file.deleteConfirm': 'Delete "{name}"?',
    'profile.title': 'Profile',
    'profile.avatarHint': 'Tap the avatar to change it.',
    'avatar.fail': 'Could not upload the avatar. Try again.',
    'profile.plan.title': 'Plan',
    'plan.free': 'Free',
    'plan.freeDesc': 'Up to 1 GB per file · 10 GB storage. Upgrade to Pro for files up to 50 GB.',
    'plan.proDesc': 'Pro: up to 50 GB per file · {gb} GB storage · active until {date}.',
    'plan.upgrade': 'Choose a Pro plan',
    'plan.benefit1': 'Files up to 50 GB instead of 1 GB',
    'plan.benefit2': '250 GB to 1 TB of storage instead of 10 GB',
    'plan.benefit3': 'Same folders, previews and 2FA — just more room',
    'plan.compareFree': 'Free plan: 1 GB per file, 10 GB of storage.',
    'plan.perMonth': '/ 30 days',
    'plan.period': 'One-time payment, active for 30 days.',
    'plan.payYookassa': 'Pay with card (YooKassa)',
    'plan.payHeleket': 'Pay with crypto (Heleket)',
    'plan.notConfigured': 'This payment method is not configured yet.',
    'plan.success': 'Payment received — Pro is active!',
    'plan.pending': 'Payment is not confirmed yet. Try again in a minute.',
    'plan.fail': 'Payment failed or was canceled.',
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
  };

  function t(key, vars) {
    let str = STRINGS[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, String(v));
      }
    }
    return str;
  }

  function filesCount(n) {
    return `${n} ${n === 1 ? 'file' : 'files'}`;
  }

  function apply() {
    document.documentElement.lang = 'en';

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });

    const titleKey = document.body?.dataset.titleKey;
    if (titleKey) document.title = t(titleKey);
  }

  window.KiliwUI = {
    t,
    filesCount,
    lang: 'en',
  };

  document.addEventListener('DOMContentLoaded', apply);
})();
