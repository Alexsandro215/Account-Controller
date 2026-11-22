/* Bóveda · Mini App de Telegram (JavaScript sin dependencias ni build).
   Los secretos solo viven en memoria: nada se guarda en localStorage, sessionStorage ni cookies. */
(() => {
  'use strict';

  // ---------- Telegram y constantes ----------

  const tg = (window.Telegram && window.Telegram.WebApp) || null;
  const inTelegram = Boolean(tg && tg.initData);
  const tgSupports = (v) => inTelegram && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(v);

  const API_BASE = new URL('../api/', window.location.href);
  const MASK = '••••••••';
  const REVEAL_MS = 30000;
  const REQUEST_TIMEOUT_MS = 20000;
  const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  const rtf = Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat('es-MX', { numeric: 'auto' }) : null;
  const FATAL_MESSAGES = {
    unauthorized: 'Abre esta app desde el bot de Telegram.',
    not_ready: 'Primero configura tu bóveda desde el chat con el bot.',
  };

  // ---------- Estado ----------

  const state = {
    vault: { vaultReady: false, unlocked: false, unlockExpiresAt: null, lockedUntil: null },
    items: [],
    query: '',
    category: null, // null = Todas
    fatal: null, // 'unauthorized' | 'not_ready' | null
  };
  const nav = { stack: [{ name: 'list' }], cleanup: null, guard: null, guarding: false };
  const unlock = { open: false, waiters: [], timer: null };
  const wipers = new Set(); // borran los secretos visibles de la pantalla actual
  let lockEpoch = 0; // sube al cerrar la bóveda a mano: descarta secretos que aún vienen en camino
  let expiryTimer = null;
  let toastTimer = null;
  let uid = 0;

  const $ = (id) => document.getElementById(id);

  // ---------- DOM (nunca innerHTML: todo el texto entra como nodos de texto) ----------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, val] of Object.entries(props || {})) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') el.className = val;
      else if (key === 'value' || key === 'checked') el[key] = val;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), val);
      else el.setAttribute(key, val === true ? '' : String(val));
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) el.append(child);
    }
    return el;
  }

  const button = (label, cls, onclick, extra) => h('button', { type: 'button', class: cls, onclick, ...extra }, label);

  function emptyState(title, text, cta) {
    return h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, title), text && h('p', null, text), cta);
  }

  function avatar(name, cls) {
    const text = String(name || '');
    let hash = 0;
    for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    const letter = (Array.from(text.trim())[0] || '?').toUpperCase();
    return h('span', { class: `${cls} av-${hash % 7}`, 'aria-hidden': 'true' }, letter);
  }

  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('is-error', kind === 'error');
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), kind === 'error' ? 3500 : 1800);
  }

  // ---------- Formato ----------

  const pad = (n) => String(n).padStart(2, '0');
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hhmm = (time) => { const d = new Date(time); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  function timeAgo(iso) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return '';
    const secs = Math.max(0, (Date.now() - t) / 1000);
    if (secs < 60) return 'hace un momento';
    if (!rtf) return `el ${new Date(t).toLocaleDateString('es-MX')}`;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    const [unit, size] = units.find(([, s]) => secs >= s);
    return rtf.format(-Math.floor(secs / size), unit); // "hace 3 meses", "ayer", "la semana pasada"…
  }

  function formatCode(code) {
    if (/^\d{6}$/.test(code)) return `${code.slice(0, 3)} ${code.slice(3)}`;
    if (/^\d{8}$/.test(code)) return `${code.slice(0, 4)} ${code.slice(4)}`;
    return code;
  }

  // ---------- Telegram: confirmación y vibración ----------

  function confirmDialog(message) {
    return new Promise((resolve) => {
      if (tgSupports('6.2')) {
        try { tg.showConfirm(message, (ok) => resolve(Boolean(ok))); return; } catch { /* popup ocupado */ }
      }
      resolve(window.confirm(message));
    });
  }

  function haptic(type) {
    try {
      if (tgSupports('6.1') && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(type);
    } catch { /* sin vibración */ }
  }

  // ---------- Portapapeles ----------

  function legacyCopy(text) {
    const area = h('textarea', { class: 'clip-helper', readonly: true, 'aria-hidden': 'true' });
    area.value = text;
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.value = '';
    area.remove();
    return ok;
  }

  async function writeText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* probamos el método antiguo */ }
    return legacyCopy(text);
  }

  // `source` puede ser texto o una promesa (la contraseña que aún viene del servidor). Con una promesa
  // se usa ClipboardItem, que conserva el gesto del usuario aunque la respuesta tarde (iOS).
  function writeClipboard(source) {
    const cb = navigator.clipboard;
    if (typeof source !== 'string' && cb && cb.write && typeof window.ClipboardItem === 'function') {
      try {
        const blob = Promise.resolve(source).then((t) => new Blob([t], { type: 'text/plain' }));
        blob.catch(() => {}); // el error real se reporta abajo
        return cb.write([new window.ClipboardItem({ 'text/plain': blob })])
          .then(() => true, () => Promise.resolve(source).then(writeText));
      } catch { /* ClipboardItem sin soporte para promesas */ }
    }
    return Promise.resolve(source).then(writeText);
  }

  async function copyToClipboard(source) {
    if (await writeClipboard(source)) {
      haptic('success');
      toast('Copiado');
    } else {
      toast('No se pudo copiar, intenta de nuevo.', 'error');
    }
  }

  // ---------- API ----------

  class ApiError extends Error {
    constructor(code, status = 0, data = null, handled = false) {
      super(code);
      Object.assign(this, { code, status, data: data || {}, handled }); // handled: ya se avisó al usuario
    }
  }

  const cancelledError = () => new ApiError('cancelled', 0, null, true);

  async function send(method, path, body) {
    const headers = { Authorization: `tma ${tg ? tg.initData : ''}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(new URL(path, API_BASE), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
    } catch {
      throw new ApiError('network');
    } finally {
      clearTimeout(timer);
    }
  }

  // Único punto de entrada al backend: errores globales (401/409) y el flujo
  // 423 → pantalla de desbloqueo → reintento. `background` evita abrir el desbloqueo.
  async function api(method, path, body, { background = false } = {}) {
    for (;;) {
      const res = await send(method, path, body);
      const data = (await res.json().catch(() => null)) || {};
      if (res.ok) return data;
      const code = data.error || `http_${res.status}`;
      if (res.status === 401 || (res.status === 409 && code === 'vault_not_ready')) {
        showFatal(res.status === 401 ? 'unauthorized' : 'not_ready');
        throw new ApiError(code, res.status, data, true);
      }
      if (res.status !== 423) throw new ApiError(code, res.status, data);
      setLocked();
      if (background) throw new ApiError(code, 423, data, true);
      await requestUnlock(); // si el usuario cancela, rechaza con un error ya manejado
    }
  }

  function handleError(err) {
    if (err && err.handled) return;
    if (!(err instanceof ApiError)) {
      console.error(err);
      toast('Algo salió mal, intenta de nuevo.', 'error');
    } else if (err.code === 'network') {
      toast('Sin conexión, intenta de nuevo', 'error');
    } else if (err.status >= 500) {
      toast('Error del servidor, intenta de nuevo.', 'error');
    } else {
      toast(err.data.message || 'No se pudo completar, intenta de nuevo.', 'error');
    }
  }

  function handleItemError(err, id) {
    if (!(err instanceof ApiError) || err.status !== 404) return handleError(err);
    removeItem(id);
    toast('Esa cuenta ya no existe.', 'error');
    navigate({ name: 'list' }, { reset: true });
  }

  // Manejador async para un botón: lo desactiva mientras trabaja y reporta errores.
  function action(btn, fn, onError = handleError) {
    return async (ev) => {
      if (ev && ev.type === 'submit') ev.preventDefault();
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('is-busy');
      try {
        await fn();
      } catch (err) {
        onError(err);
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-busy');
      }
    };
  }

  // ---------- Datos ----------

  const findItem = (id) => state.items.find((it) => it.id === id) || null;
  const removeItem = (id) => { state.items = state.items.filter((it) => it.id !== id); };

  function upsertItem(item) {
    const i = state.items.findIndex((it) => it.id === item.id);
    if (i >= 0) state.items[i] = item;
    else state.items.push(item);
  }

  function categories() {
    const counts = new Map();
    for (const it of state.items) counts.set(it.category, (counts.get(it.category) || 0) + 1);
    return [...counts.entries()].sort((a, b) => collator.compare(a[0], b[0]));
  }

  async function loadItems() {
    const r = await api('GET', 'credentials');
    state.items = Array.isArray(r.items) ? r.items : [];
  }

  // ---------- Estado de la bóveda ----------

  function wipeSecrets() {
    for (const wipe of wipers) wipe();
  }

  function setUnlocked(expiresAt) {
    Object.assign(state.vault, { unlocked: true, unlockExpiresAt: expiresAt || null, lockedUntil: null });
    scheduleExpiry();
    updateLockUi();
  }

  function setLocked() {
    Object.assign(state.vault, { unlocked: false, unlockExpiresAt: null });
    scheduleExpiry();
    wipeSecrets();
    updateLockUi();
  }

  function applyState(s) {
    state.vault.vaultReady = Boolean(s.vaultReady);
    state.vault.lockedUntil = s.lockedUntil || null;
    if (!state.vault.vaultReady) showFatal('not_ready');
    else if (s.unlocked) setUnlocked(s.unlockExpiresAt);
    else setLocked();
  }

  // A la hora de cierre preguntamos al servidor (la sesión pudo extenderse).
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const at = Date.parse(state.vault.unlockExpiresAt || '');
    if (!state.vault.unlocked || Number.isNaN(at)) return;
    const left = at - Date.now();
    expiryTimer = setTimeout(refreshState, left > 0 ? Math.min(left + 1000, 2147483647) : 60000);
  }

  async function refreshState() {
    if (state.fatal) return;
    try {
      applyState(await api('GET', 'state', undefined, { background: true }));
    } catch (err) {
      // Sin conexión: si ya pasó la hora de cierre, la damos por cerrada.
      if (!err.handled && Date.parse(state.vault.unlockExpiresAt || '') <= Date.now()) setLocked();
    }
  }

  function updateLockUi() {
    const open = state.vault.unlocked;
    $('lockPill').classList.toggle('is-open', open);
    $('lockPill').setAttribute('aria-label', open ? 'Bóveda abierta' : 'Bóveda cerrada, toca para abrirla');
    $('lockText').textContent = open ? 'Abierta' : 'Cerrada';
    $('lockBtn').hidden = !open;
  }

  function onPillClick() {
    if (state.fatal) return;
    if (!state.vault.unlocked) return openUnlock();
    const at = Date.parse(state.vault.unlockExpiresAt || '');
    toast(Number.isNaN(at) ? 'Tu bóveda está abierta' : `Abierta hasta las ${hhmm(at)}`);
  }

  async function lockVault() {
    lockEpoch += 1;
    setLocked(); // primero borramos lo visible, luego avisamos al servidor
    try {
      await api('POST', 'lock');
      toast('Bóveda cerrada');
    } catch (err) {
      handleError(err);
      refreshState();
    }
  }

  // ---------- Pantalla de desbloqueo (se superpone a la pantalla actual) ----------

  function requestUnlock() {
    if (state.fatal) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      unlock.waiters.push({ resolve, reject });
      openUnlock();
    });
  }

  function setUnlockError(message) {
    $('unlockError').textContent = message;
    $('unlockError').hidden = !message;
  }

  function setUnlockDisabled(disabled) {
    $('unlockInput').disabled = disabled;
    $('unlockSubmit').disabled = disabled;
  }

  function openUnlock() {
    if (state.fatal || unlock.open) return;
    unlock.open = true;
    $('unlock').hidden = false;
    document.body.classList.add('has-overlay');
    setUnlockError('');
    setUnlockDisabled(false);
    const until = Date.parse(state.vault.lockedUntil || '');
    if (until > Date.now()) startLockout(until);
    else setTimeout(() => { if (unlock.open) $('unlockInput').focus(); }, 80);
    updateBackButton();
  }

  function closeUnlock(success) {
    if (!unlock.open) return;
    unlock.open = false;
    $('unlockInput').value = '';
    $('unlock').hidden = true;
    document.body.classList.remove('has-overlay');
    clearInterval(unlock.timer);
    unlock.timer = null;
    for (const w of unlock.waiters.splice(0)) {
      if (success) w.resolve();
      else w.reject(cancelledError());
    }
    updateBackButton();
  }

  function startLockout(until) {
    clearInterval(unlock.timer);
    unlock.timer = null;
    if (Number.isNaN(until)) return setUnlockError('Demasiados intentos. Intenta más tarde.');
    const tick = () => {
      const ms = until - Date.now();
      if (ms > 0) {
        const min = Math.ceil(ms / 60000);
        const left = min === 1 ? 'falta 1 minuto' : `faltan ${min} minutos`;
        return setUnlockError(`Demasiados intentos. Bloqueada hasta las ${hhmm(until)} (${left}).`);
      }
      clearInterval(unlock.timer);
      unlock.timer = null;
      state.vault.lockedUntil = null;
      setUnlockDisabled(false);
      setUnlockError('');
    };
    setUnlockDisabled(true);
    unlock.timer = setInterval(tick, 1000);
    tick();
  }

  function showUnlockError(err) {
    if (!(err instanceof ApiError)) {
      console.error(err);
      setUnlockError('Algo salió mal, intenta de nuevo.');
    } else if (err.code === 'wrong_password') {
      const n = err.data.remainingAttempts;
      const left = n === 1 ? ' Te queda 1 intento.' : n > 1 ? ` Te quedan ${n} intentos.` : '';
      setUnlockError(`Contraseña incorrecta.${left}`);
      const form = $('unlockForm');
      form.classList.remove('shake');
      void form.offsetWidth; // reinicia la animación
      form.classList.add('shake');
      haptic('error');
      $('unlockInput').focus();
    } else if (err.code === 'too_many_attempts') {
      state.vault.lockedUntil = err.data.lockedUntil || null;
      startLockout(Date.parse(err.data.lockedUntil || ''));
      haptic('error');
    } else {
      setUnlockError(err.code === 'network' ? 'Sin conexión, intenta de nuevo' : err.data.message || 'No se pudo abrir, intenta de nuevo.');
    }
  }

  async function submitUnlock(ev) {
    ev.preventDefault();
    const input = $('unlockInput');
    const submit = $('unlockSubmit');
    if (submit.disabled) return;
    const password = input.value;
    input.value = ''; // la contraseña maestra no se queda en el campo
    if (!password) {
      setUnlockError('Escribe tu contraseña maestra.');
      input.focus();
      return;
    }
    setUnlockError('');
    submit.disabled = true;
    submit.classList.add('is-busy');
    try {
      const r = await api('POST', 'unlock', { password });
      const resumesAction = unlock.waiters.length > 0;
      setUnlocked(r.unlockExpiresAt);
      closeUnlock(true); // reanuda la acción que pidió el desbloqueo
      if (!resumesAction) toast('Bóveda abierta');
    } catch (err) {
      if (!err.handled) showUnlockError(err);
    } finally {
      submit.classList.remove('is-busy');
      submit.disabled = Boolean(unlock.timer);
    }
  }

  // ---------- Avisos de pantalla completa (401 / 409) ----------

  function showFatal(kind) {
    state.fatal = kind;
    closeUnlock(false);
    leaveScreen();
    nav.stack = [{ name: 'list' }];
    $('view').textContent = '';
    clearTimeout(expiryTimer);
    lockEpoch += 1;
    wipeSecrets();
    $('fatalText').textContent = FATAL_MESSAGES[kind];
    const btn = $('fatalAction');
    btn.hidden = kind === 'unauthorized' && !inTelegram;
    btn.textContent = kind === 'not_ready' ? 'Ya la configuré, reintentar' : 'Cerrar';
    $('fatal').hidden = false;
    document.body.classList.add('has-overlay');
    updateBackButton();
  }

  function hideFatal() {
    state.fatal = null;
    $('fatal').hidden = true;
    document.body.classList.remove('has-overlay');
  }

  function onFatalAction() {
    if (state.fatal === 'not_ready') boot();
    else if (tg && typeof tg.close === 'function') tg.close();
  }

  // ---------- Navegación ----------

  const currentScreen = () => nav.stack[nav.stack.length - 1];

  function updateBackButton() {
    const show = !state.fatal && (unlock.open || nav.stack.length > 1);
    if (!tgSupports('6.1')) $('backBtn').hidden = !show; // navegador normal: botón propio
    else if (show) tg.BackButton.show();
    else tg.BackButton.hide();
  }

  function leaveScreen() {
    const top = currentScreen();
    if (top && top.name === 'list') top.scrollY = window.scrollY;
    const cleanup = nav.cleanup;
    nav.cleanup = null;
    nav.guard = null;
    if (cleanup) cleanup();
  }

  function renderScreen() {
    const view = $('view');
    view.textContent = '';
    if (currentScreen().id && !findItem(currentScreen().id)) nav.stack = [{ name: 'list' }];
    const top = currentScreen();
    const render = { list: renderList, detail: renderDetail, form: renderForm }[top.name];
    nav.cleanup = render(view, top) || null; // cada pantalla devuelve su limpieza
    updateBackButton();
    window.scrollTo(0, top.scrollY || 0);
  }

  function navigate(screen, { replace = false, reset = false } = {}) {
    leaveScreen();
    if (reset) nav.stack = [];
    else if (replace) nav.stack.pop();
    nav.stack.push(screen);
    renderScreen();
  }

  function popScreen() {
    if (nav.stack.length < 2) return;
    leaveScreen();
    nav.stack.pop();
    renderScreen();
  }

  async function goBack() {
    if (state.fatal || nav.guarding) return;
    if (unlock.open) return closeUnlock(false);
    if (nav.stack.length < 2) return;
    if (nav.guard) {
      nav.guarding = true;
      let ok = false;
      try { ok = await nav.guard(); } finally { nav.guarding = false; }
      if (!ok || state.fatal) return;
    }
    popScreen();
  }

  // ---------- Pantalla: lista ----------

  function renderList(view) {
    const add = () => navigate({ name: 'form' });
    if (!state.items.length) {
      view.append(emptyState('Tu bóveda está vacía', 'Guarda aquí tus cuentas y contraseñas.',
        button('+ Agregar la primera', 'btn btn-primary', add)));
      return null;
    }
    const search = h('input', {
      class: 'input search-input', type: 'search', value: state.query, 'aria-label': 'Buscar',
      placeholder: 'Buscar servicio, correo o categoría',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
    });
    const chips = h('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Categorías' });
    const results = h('div');
    const redraw = () => {
      drawChips(chips, redraw);
      drawResults(results);
    };
    search.addEventListener('input', () => {
      state.query = search.value;
      drawResults(results);
    });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') search.blur(); });
    view.append(h('div', { class: 'searchbar' }, search), chips, results, button('+ Nueva', 'fab', add));
    redraw();
    return null;
  }

  function drawChips(box, redraw) {
    const cats = categories();
    if (state.category !== null && !cats.some(([c]) => c === state.category)) state.category = null;
    const chip = (label, count, value) => {
      const active = state.category === value;
      const select = () => { state.category = value; redraw(); };
      return button([label, h('span', { class: 'chip-count' }, String(count))],
        active ? 'chip is-active' : 'chip', select, { 'aria-pressed': String(active) });
    };
    box.textContent = '';
    box.append(chip('Todas', state.items.length, null), ...cats.map(([c, n]) => chip(c, n, c)));
  }

  function drawResults(box) {
    box.textContent = '';
    const tokens = norm(state.query).split(/\s+/).filter(Boolean);
    const matches = state.items.filter((it) => {
      if (state.category !== null && it.category !== state.category) return false;
      const haystack = norm(`${it.service} ${it.email} ${it.category}`);
      return tokens.every((t) => haystack.includes(t));
    });
    if (!matches.length) {
      box.append(tokens.length
        ? emptyState('Sin resultados', `No encontramos nada con “${state.query.trim()}”.`)
        : emptyState('Sin cuentas', 'No hay cuentas en esta categoría.'));
      return;
    }
    const groups = new Map();
    for (const it of matches) groups.set(it.category, [...(groups.get(it.category) || []), it]);
    for (const cat of [...groups.keys()].sort(collator.compare)) {
      const items = groups.get(cat).sort((a, b) => collator.compare(a.service, b.service));
      box.append(h('section', { class: 'group' },
        h('h2', { class: 'group-title' }, h('span', null, cat), h('span', null, String(items.length))),
        h('div', { class: 'card list' }, items.map(itemRow))));
    }
  }

  function itemRow(it) {
    return button([
      avatar(it.service, 'avatar'),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, it.service), h('span', { class: 'row-sub' }, it.email)),
      it.hasTotp && h('span', { class: 'badge', title: 'Tiene verificación en dos pasos' }, '2FA'),
      h('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'),
    ], 'row', () => navigate({ name: 'detail', id: it.id }));
  }

  // ---------- Pantalla: detalle ----------

  function renderDetail(view, screen) {
    const item = findItem(screen.id);
    const id = item.id;
    const base = `credentials/${encodeURIComponent(id)}`;
    const onError = (err) => handleItemError(err, id);
    let alive = true;
    let secret = null; // { password, notes } solo mientras se muestra
    let hideTimer = null;

    const pwValue = h('span', { class: 'secret' });
    const pwHint = h('p', { class: 'field-hint' });
    const notesHint = item.hasNotes && h('p', { class: 'field-hint' }, 'Tiene notas. Toca Mostrar para verlas.');
    const notesField = h('div', { class: 'field' });
    const showBtn = button('Mostrar', 'btn btn-small');
    const copyBtn = button('Copiar', 'btn btn-small');

    function hideSecret() {
      secret = null;
      clearInterval(hideTimer);
      pwValue.textContent = MASK;
      pwValue.classList.add('is-masked');
      showBtn.textContent = 'Mostrar';
      const changed = timeAgo(item.passwordChangedAt);
      pwHint.textContent = changed ? `Cambiada ${changed}` : '';
      notesField.textContent = '';
      notesField.hidden = true;
      if (notesHint) notesHint.hidden = false;
    }

    function showSecret(data) {
      hideSecret();
      secret = { password: data.password || '', notes: data.notes || null };
      pwValue.textContent = secret.password;
      pwValue.classList.remove('is-masked');
      showBtn.textContent = 'Ocultar';
      if (notesHint) notesHint.hidden = true;
      if (secret.notes) {
        notesField.append(h('span', { class: 'field-label' }, 'Notas'), h('p', { class: 'notes' }, secret.notes));
        notesField.hidden = false;
      }
      const until = Date.now() + REVEAL_MS; // se oculta sola a los 30 s
      const tick = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left > 0) pwHint.textContent = `Se ocultará en ${left} s`;
        else hideSecret();
      };
      tick();
      hideTimer = setInterval(tick, 1000);
    }

    const reveal = () => api('POST', `${base}/reveal`);
    showBtn.addEventListener('click', action(showBtn, async () => {
      if (secret) return hideSecret();
      const epoch = lockEpoch;
      const data = await reveal();
      if (alive && epoch === lockEpoch) showSecret(data);
    }, onError));
    // Copiar no muestra la contraseña en pantalla.
    copyBtn.addEventListener('click', action(copyBtn, () =>
      copyToClipboard(secret ? secret.password : reveal().then((d) => d.password || '')), onError));

    const totp = item.hasTotp ? totpSection(item, base, onError) : null;
    const wipe = () => {
      hideSecret();
      if (totp) totp.stop();
    };
    wipers.add(wipe);

    const deleteBtn = button('Borrar', 'btn btn-danger');
    deleteBtn.addEventListener('click', action(deleteBtn, async () => {
      if (!(await confirmDialog(`¿Borrar «${item.service}»? Esta acción no se puede deshacer.`))) return;
      await api('DELETE', base);
      removeItem(id);
      haptic('success');
      toast('Cuenta borrada');
      navigate({ name: 'list' }, { reset: true });
    }, onError));

    hideSecret();
    const updated = timeAgo(item.updatedAt);
    view.append(
      h('div', { class: 'detail-head' }, avatar(item.service, 'avatar avatar-lg'),
        h('div', { class: 'detail-heading' },
          h('h2', { class: 'detail-title' }, item.service), h('span', { class: 'tag' }, item.category))),
      h('section', { class: 'card' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Usuario o correo'),
          h('div', { class: 'field-row' }, h('span', { class: 'field-value' }, item.email || '—'),
            button('Copiar', 'btn btn-small', () => copyToClipboard(item.email), { disabled: !item.email }))),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Contraseña'),
          h('div', { class: 'field-row' }, pwValue, showBtn, copyBtn), pwHint, notesHint),
        notesField),
      totp && totp.el,
      h('div', { class: 'actions' }, button('Editar', 'btn btn-secondary', () => navigate({ name: 'form', id })), deleteBtn),
      updated && h('p', { class: 'meta' }, `Actualizada ${updated}`),
    );

    return () => {
      alive = false;
      wipers.delete(wipe);
      hideSecret();
      if (totp) totp.destroy();
    };
  }

  function totpSection(item, base, onError) {
    let code = null;
    let period = 30;
    let deadline = 0;
    let timer = null;
    let loading = false;
    let alive = true;

    const codeEl = h('span', { class: 'totp-code' });
    const copyBtn = button('Copiar', 'btn btn-small', () => { if (code) copyToClipboard(code); });
    const bar = h('span');
    const progress = h('div', { class: 'progress', 'aria-hidden': 'true' }, bar);
    const countdown = h('p', { class: 'field-hint' });
    const showBtn = button('Mostrar código', 'btn btn-secondary btn-block');
    const live = h('div', { hidden: true }, h('div', { class: 'field-row' }, codeEl, copyBtn), progress, countdown);
    const el = h('section', { class: 'card' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Código de verificación (2FA)'), showBtn, live));

    function stop() {
      clearInterval(timer);
      timer = null;
      code = null;
      codeEl.textContent = '';
      live.hidden = true;
      showBtn.hidden = false;
    }

    function fail(err) {
      if (!(err instanceof ApiError) || err.code !== 'no_totp') return onError(err);
      item.hasTotp = false;
      el.hidden = true;
      toast('Esta cuenta ya no tiene 2FA.', 'error');
    }

    async function load(background) {
      const epoch = lockEpoch;
      loading = true;
      try {
        const r = await api('POST', `${base}/totp`, undefined, { background });
        if (!alive || epoch !== lockEpoch) return;
        code = String(r.code);
        period = r.period > 0 ? r.period : 30;
        deadline = Date.now() + Math.max(1, Number(r.remainingSeconds) || 0) * 1000;
        codeEl.textContent = formatCode(code);
        live.hidden = false;
        showBtn.hidden = true;
        if (!timer) timer = setInterval(tick, 1000);
        tick();
      } finally {
        loading = false;
      }
    }

    // Cada segundo: cuenta regresiva; al vencer, pide el código nuevo.
    function tick() {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      bar.style.width = `${Math.max(0, Math.min(100, (left / period) * 100))}%`;
      progress.classList.toggle('is-low', left <= 5);
      if (left > 0) {
        countdown.textContent = left === 1 ? 'Cambia en 1 segundo' : `Cambia en ${left} segundos`;
      } else {
        countdown.textContent = 'Actualizando…';
        if (!loading) load(true).catch((err) => { stop(); fail(err); });
      }
    }

    showBtn.addEventListener('click', action(showBtn, () => load(false), fail));
    return { el, stop, destroy: () => { alive = false; stop(); } };
  }

  // ---------- Pantalla: formulario (crear / editar) ----------

  function field(label, control, { input = control, hint, extra } = {}) {
    if (!input.id) input.id = `f${++uid}`;
    const error = h('p', { class: 'field-error', hidden: true });
    const wrap = h('div', { class: 'form-field' },
      h('label', { class: 'field-label', for: input.id }, label), control, hint && h('p', { class: 'field-hint' }, hint), extra, error);
    const clearError = () => {
      error.hidden = true;
      input.removeAttribute('aria-invalid');
    };
    input.addEventListener('input', clearError);
    const setError = (message) => {
      error.textContent = message;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    };
    return { wrap, input, clearError, setError };
  }

  const textInput = (value, extra) => h('input', {
    class: 'input', type: 'text', value, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...extra,
  });

  function renderForm(view, screen) {
    const item = screen.id ? findItem(screen.id) : null;
    const editing = Boolean(item);
    const listId = `cats-${++uid}`;
    let alive = true;
    let dirty = false;
    const markDirty = () => {
      if (dirty) return;
      dirty = true;
      if (tgSupports('6.2')) tg.enableClosingConfirmation();
    };

    const category = field('Categoría', textInput(item ? item.category : state.category || '',
      { list: listId, autocapitalize: 'sentences', placeholder: 'Ej. Correo, Bancos, Trabajo' }));
    const service = field('Servicio', textInput(item ? item.service : '',
      { autocapitalize: 'sentences', placeholder: 'Ej. Gmail, Netflix, Banco' }));
    const email = field('Usuario o correo', textInput(item ? item.email : '',
      { inputmode: 'email', placeholder: 'tu@correo.com o usuario' }));

    // Contraseña: mostrar/ocultar y generador (longitud 12–40, símbolos).
    const pwInput = h('input', {
      class: 'input input-secret', type: 'password', autocomplete: 'new-password', autocapitalize: 'off',
      spellcheck: 'false', placeholder: editing ? 'Nueva contraseña' : 'Escribe o genera una',
    });
    const toggleBtn = button('', 'btn btn-small', () => setPwVisible(pwInput.type === 'password'));
    const genBtn = button('Generar', 'btn btn-small');
    const lenInput = h('input', { type: 'range', min: '12', max: '40', step: '1', value: '20', 'aria-label': 'Longitud' });
    const lenValue = h('span', { class: 'gen-len-value' }, '20');
    const symInput = h('input', { type: 'checkbox', checked: true });
    const setPwVisible = (visible) => {
      pwInput.type = visible ? 'text' : 'password';
      toggleBtn.textContent = visible ? 'Ocultar' : 'Ver';
      toggleBtn.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
    };
    setPwVisible(false);
    const password = field('Contraseña', h('div', { class: 'input-group' }, pwInput, toggleBtn, genBtn), {
      input: pwInput,
      hint: editing && 'Déjalo vacío para no cambiarla.',
      extra: h('div', { class: 'gen-options' },
        h('label', { class: 'gen-len' }, 'Longitud', lenInput, lenValue),
        h('label', { class: 'check' }, symInput, 'Símbolos')),
    });
    lenInput.addEventListener('input', () => { lenValue.textContent = lenInput.value; });
    genBtn.addEventListener('click', action(genBtn, async () => {
      const r = await api('POST', 'generate', { length: Number(lenInput.value), symbols: symInput.checked });
      if (!alive) return;
      pwInput.value = r.password || '';
      setPwVisible(true);
      password.clearError();
      markDirty();
      toast('Contraseña generada');
    }));

    // Notas y 2FA. En edición, vacío = sin cambios; las casillas mandan null para borrar.
    const notesInput = h('textarea', { class: 'input', rows: '3', placeholder: 'Opcional', autocapitalize: 'sentences' });
    const clearNotes = editing && item.hasNotes && h('input', { type: 'checkbox' });
    const notes = field('Notas', notesInput, {
      hint: clearNotes && 'Déjalo vacío para no cambiarlas.',
      extra: clearNotes && h('label', { class: 'check' }, clearNotes, 'Borrar notas'),
    });
    const totpInput = textInput('', { placeholder: 'Secreto base32 u otpauth://' });
    const removeTotp = editing && item.hasTotp && h('input', { type: 'checkbox' });
    const totp = field('Verificación en dos pasos (2FA)', totpInput, {
      hint: removeTotp ? 'Déjalo vacío para no cambiarlo.' : 'Opcional.',
      extra: removeTotp && h('label', { class: 'check' }, removeTotp, 'Quitar 2FA'),
    });
    for (const [box, input] of [[clearNotes, notesInput], [removeTotp, totpInput]]) {
      if (box) box.addEventListener('change', () => { input.disabled = box.checked; if (box.checked) input.value = ''; });
    }

    const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, editing ? 'Guardar cambios' : 'Guardar');
    const form = h('form', { class: 'form', novalidate: true, autocomplete: 'off' },
      h('h2', { class: 'screen-title' }, editing ? 'Editar cuenta' : 'Nueva cuenta'),
      h('datalist', { id: listId }, categories().map(([c]) => h('option', { value: c }))),
      category.wrap, service.wrap, email.wrap, password.wrap, notes.wrap, totp.wrap, formError,
      h('div', { class: 'form-actions' }, saveBtn, button('Cancelar', 'btn btn-plain btn-block', goBack)));
    form.addEventListener('input', (e) => { if (e.target !== lenInput) markDirty(); });
    form.addEventListener('change', (e) => { if (e.target !== lenInput && e.target !== symInput) markDirty(); });

    const values = () => ({
      category: category.input.value.trim(),
      service: service.input.value.trim(),
      email: email.input.value.trim(),
      password: pwInput.value,
      notes: notesInput.value.trim(),
      totp: totpInput.value.trim(),
    });

    function validate(v) {
      const checks = [
        [category, v.category, 'Escribe una categoría.'],
        [service, v.service, 'Escribe el nombre del servicio.'],
        [email, v.email, 'Escribe el usuario o correo.'],
      ];
      if (!editing) checks.push([password, v.password, 'Escribe o genera una contraseña.']);
      const missing = checks.filter(([, val]) => !val);
      for (const [f, , message] of missing) f.setError(message);
      if (missing.length) missing[0][0].input.focus();
      return missing.length === 0;
    }

    function buildBody(v) {
      if (!editing) {
        const body = { category: v.category, service: v.service, email: v.email, password: v.password };
        if (v.notes) body.notes = v.notes;
        if (v.totp) body.totp = v.totp;
        return body;
      }
      const body = {}; // PATCH: solo lo que cambió
      for (const key of ['category', 'service', 'email']) if (v[key] !== item[key]) body[key] = v[key];
      if (v.password) body.password = v.password;
      if (clearNotes && clearNotes.checked) body.notes = null;
      else if (v.notes) body.notes = v.notes;
      if (removeTotp && removeTotp.checked) body.totp = null;
      else if (v.totp) body.totp = v.totp;
      return body;
    }

    form.addEventListener('submit', action(saveBtn, async () => {
      formError.hidden = true;
      const v = values();
      if (!validate(v)) return;
      const body = buildBody(v);
      if (editing && !Object.keys(body).length) {
        dirty = false;
        toast('No hay cambios');
        return popScreen();
      }
      let res;
      try {
        res = editing
          ? await api('PATCH', `credentials/${encodeURIComponent(item.id)}`, body)
          : await api('POST', 'credentials', body);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 400) throw err;
        formError.textContent = err.data.message || 'Revisa los datos e intenta de nuevo.';
        formError.hidden = false;
        formError.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (res.item) upsertItem(res.item);
      dirty = false;
      haptic('success');
      toast(editing ? 'Cambios guardados' : 'Cuenta guardada');
      if (!alive) return;
      if (!editing && res.item) navigate({ name: 'detail', id: res.item.id }, { replace: true });
      else popScreen();
    }, (err) => (editing ? handleItemError(err, item.id) : handleError(err))));

    // No salir mientras guarda; si hay cambios sin guardar, confirmar.
    nav.guard = () => {
      if (saveBtn.disabled) return Promise.resolve(false);
      return dirty ? confirmDialog('¿Descartar los cambios?') : Promise.resolve(true);
    };

    view.append(form);
    return () => {
      alive = false;
      pwInput.value = '';
      notesInput.value = '';
      totpInput.value = '';
      if (tgSupports('6.2')) tg.disableClosingConfirmation();
    };
  }

  // ---------- Arranque ----------

  async function boot() {
    hideFatal();
    const view = $('view');
    view.textContent = '';
    view.append(h('div', { class: 'loading', 'aria-label': 'Cargando' }, h('span', { class: 'spinner' })));
    try {
      applyState(await api('GET', 'state'));
      if (state.fatal) return;
      await loadItems();
      navigate({ name: 'list' }, { reset: true });
    } catch (err) {
      if (err && err.handled) return;
      handleError(err);
      view.textContent = '';
      view.append(emptyState('No pudimos abrir tu bóveda', 'Revisa tu conexión e intenta de nuevo.',
        button('Reintentar', 'btn btn-primary', boot)));
    }
  }

  function onVisibilityChange() {
    if (state.fatal) return;
    if (document.hidden) wipeSecrets(); // al salir de la app se ocultan contraseñas y códigos
    else if (state.vault.vaultReady) refreshState();
  }

  function applyColorScheme() {
    if (inTelegram && tg.colorScheme) document.documentElement.dataset.scheme = tg.colorScheme;
  }

  function init() {
    if (tg) {
      try {
        tg.ready();
        tg.expand();
      } catch { /* fuera de Telegram */ }
    }
    applyColorScheme();
    if (inTelegram && typeof tg.onEvent === 'function') tg.onEvent('themeChanged', applyColorScheme);
    if (tgSupports('6.1')) {
      try {
        tg.setHeaderColor('secondary_bg_color');
        tg.setBackgroundColor('secondary_bg_color');
      } catch { /* colores opcionales */ }
      tg.BackButton.onClick(goBack);
    }
    $('backBtn').addEventListener('click', goBack);
    $('lockPill').addEventListener('click', onPillClick);
    $('lockBtn').addEventListener('click', lockVault);
    $('unlockForm').addEventListener('submit', submitUnlock);
    $('unlockCancel').addEventListener('click', () => closeUnlock(false));
    $('fatalAction').addEventListener('click', onFatalAction);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && unlock.open) closeUnlock(false); });
    document.addEventListener('visibilitychange', onVisibilityChange);
    boot();
  }

  init();
})();
