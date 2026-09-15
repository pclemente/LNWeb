import {
  LOTTERIES,
  PersistenceError,
  TicketRepository,
  ValidationError,
  createBackup,
  evaluateTicket,
  expectedDrawYear,
  formatEuro,
  normalizeDrawYear,
  parseEuroToCents,
  readApiCache,
  validateApiBundle,
  writeApiCache,
} from './app-core.js';

const API_BASE = 'https://api-loteria.pabloclementeperez.com/output/';
const API = Object.freeze({
  navidad: {
    numbers: `${API_BASE}LoteriaNavidad.json`,
    summary: `${API_BASE}LoteriaNavidadResumen.json`,
    status: `${API_BASE}LoteriaNavidadStatus.json`,
  },
  nino: {
    numbers: `${API_BASE}LoteriaElNino.json`,
    summary: `${API_BASE}LoteriaElNinoResumen.json`,
    status: `${API_BASE}LoteriaElNinoStatus.json`,
  },
});

const PRIZE_LABELS = Object.freeze({
  navidad: [
    'Premio Gordo', 'Segundo premio', 'Tercer premio', 'Primer cuarto', 'Segundo cuarto',
    'Primer quinto', 'Segundo quinto', 'Tercer quinto', 'Cuarto quinto', 'Quinto quinto',
    'Sexto quinto', 'Séptimo quinto', 'Octavo quinto',
  ],
  nino: [
    'Primer premio', 'Segundo premio', 'Tercer premio', 'Primera extracción de 4 cifras',
    'Segunda extracción de 4 cifras',
    ...Array.from({ length: 14 }, (_, index) => `Extracción de 3 cifras ${index + 1}`),
    ...Array.from({ length: 5 }, (_, index) => `Extracción de 2 cifras ${index + 1}`),
    'Primer reintegro', 'Segundo reintegro', 'Tercer reintegro',
  ],
});

const STATUS_COPY = Object.freeze({
  0: ['Todavía no ha empezado', 'La comprobación seguirá pendiente hasta que comience el sorteo.'],
  1: ['Sorteo en curso', 'Los premios se publican poco a poco; un número aún podría aparecer.'],
  2: ['Lista provisional', 'El sorteo terminó, pero la lista todavía no es oficial.'],
  3: ['Lista oficial disponible', 'El servidor indica que ya existe una lista oficial.'],
  4: ['Sorteo finalizado', 'Los resultados del servidor están basados en la lista oficial.'],
});

const state = {
  lottery: 'navidad',
  tab: 'buscar',
  yearByLottery: {
    navidad: expectedDrawYear('navidad'),
    nino: expectedDrawYear('nino'),
  },
  tickets: [],
  bundles: { navidad: null, nino: null },
  requests: { navidad: 0, nino: 0 },
  load: {
    navidad: { loading: false, error: null },
    nino: { loading: false, error: null },
  },
  editingId: null,
  drafts: {
    navidad: { number: '', stake: '20', note: '' },
    nino: { number: '', stake: '20', note: '' },
  },
};

let repository;
let localStorageHandle;
let toastTimer;
let modalFocusReturn;

const byId = (id) => document.getElementById(id);
const all = (selector, root = document) => [...root.querySelectorAll(selector)];
const selectedYear = () => state.yearByLottery[state.lottery];

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(name, String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) node.append(child);
  }
  return node;
}

function init() {
  try {
    localStorageHandle = window.localStorage;
    repository = new TicketRepository(localStorageHandle);
    const documentState = repository.load();
    state.tickets = documentState.tickets;
    if (repository.warnings.length) showMigrationWarnings(repository.warnings);
  } catch (error) {
    console.warn('Local storage unavailable', error);
    repository = null;
    state.tickets = [];
    showStorageProblem();
  }

  if (localStorageHandle) {
    for (const lottery of LOTTERIES) state.bundles[lottery] = readApiCache(localStorageHandle, lottery);
  }
  bindEvents();
  populateYearInput();
  renderAll();
  handleImportLanding();
  void Promise.allSettled(LOTTERIES.map((lottery) => loadData(lottery)));
}

function bindEvents() {
  all('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });
  const brand = document.querySelector('.brand');
  brand?.addEventListener('click', (event) => {
    event.preventDefault();
    switchTab('buscar');
  });
  all('[data-lottery]').forEach((button) => {
    button.addEventListener('click', () => switchLottery(button.dataset.lottery));
  });

  byId('searchForm')?.addEventListener('submit', handleTicketSubmit);
  byId('numberInput')?.addEventListener('input', sanitizeNumberInput);
  byId('quantityInput')?.addEventListener('input', sanitizeStakeInput);
  byId('yearInput')?.addEventListener('change', handleYearChange);
  byId('cancelEditBtn')?.addEventListener('click', cancelEdit);

  byId('refreshHistoryBtn')?.addEventListener('click', () => void loadData(state.lottery, { announce: true }));
  byId('refreshSummaryBtn')?.addEventListener('click', () => void loadData(state.lottery, { announce: true }));
  byId('checkStatusBtn')?.addEventListener('click', () => void loadData(state.lottery, { announce: true }));
  byId('deleteAllBtn')?.addEventListener('click', deleteVisibleTickets);
  byId('myNumbersList')?.addEventListener('click', handleHistoryAction);

  byId('exportBackupBtn')?.addEventListener('click', exportBackup);
  byId('importBackupBtn')?.addEventListener('click', () => byId('importBackupInput')?.click());
  byId('importBackupInput')?.addEventListener('change', handleImportFile);
  byId('shareBtn')?.addEventListener('click', sharePage);
  byId('otherAppsBtn')?.addEventListener('click', () => openExternal('https://pabloclementeperez.com'));
  all('.contact-btn').forEach((button) => button.addEventListener('click', () => showContact(button.dataset.contact)));

  byId('modalClose')?.addEventListener('click', closeModal);
  byId('modalOk')?.addEventListener('click', closeModal);
  byId('modal')?.addEventListener('click', (event) => {
    if (event.target === byId('modal')) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    const modal = byId('modal');
    if (!modal || modal.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    if (event.key === 'Tab') {
      const focusable = [...modal.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')]
        .filter(node => !node.disabled && node.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    }
  });
  window.addEventListener('online', () => void loadData(state.lottery, { announce: true }));
  window.addEventListener('storage', handleStorageChange);
}

function sanitizeNumberInput(event) {
  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 5);
}

function sanitizeStakeInput(event) {
  const normalized = event.target.value.replace(/[^\d.,]/g, '').replace('.', ',');
  const [whole = '', ...decimals] = normalized.split(',');
  event.target.value = decimals.length ? `${whole.slice(0, 7)},${decimals.join('').slice(0, 2)}` : whole.slice(0, 7);
}

function handleYearChange(event) {
  try {
    state.yearByLottery[state.lottery] = normalizeDrawYear(event.target.value);
    renderAll();
  } catch (error) {
    showModal('Año incorrecto', error.message, 'error');
    populateYearInput();
  }
}

function populateYearInput() {
  const select = byId('yearInput');
  if (!select) return;
  const expected = expectedDrawYear(state.lottery);
  const years = new Set([expected + 1, expected, expected - 1, expected - 2, selectedYear()]);
  const bundleYear = state.bundles[state.lottery]?.drawYear;
  if (bundleYear) years.add(bundleYear);
  for (const ticket of state.tickets) {
    if (ticket.lottery === state.lottery && ticket.drawYear !== null) years.add(ticket.drawYear);
  }
  const ordered = [...years].filter(Number.isInteger).sort((a, b) => b - a);
  select.replaceChildren(...ordered.map((year) => element('option', {
    text: String(year),
    attrs: { value: year },
  })));
  select.value = String(selectedYear());
}

function switchTab(tab) {
  if (!['buscar', 'historico', 'resumen', 'info'].includes(tab)) return;
  state.tab = tab;
  all('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${tab}`));
  all('.nav-item').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.removeAttribute('aria-current');
    if (active) button.setAttribute('aria-current', 'page');
  });
  renderAll();
  window.scrollTo({ top: 0, left: 0 });
}

function switchLottery(lottery) {
  if (!LOTTERIES.includes(lottery)) return;
  if (state.editingId) {
    state.editingId = null;
    setEditingUI(false);
  } else {
    captureDraft();
  }
  state.lottery = lottery;
  all('[data-lottery]').forEach((button) => {
    const active = button.dataset.lottery === lottery;
    button.classList.toggle('active', active);
    if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(active));
    if (button.getAttribute('role') === 'tab') button.setAttribute('aria-selected', String(active));
  });
  populateYearInput();
  restoreDraft();
  renderAll();
  if (!state.bundles[lottery] && !state.load[lottery].loading) void loadData(lottery);
}

async function fetchJSON(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadData(lottery = state.lottery, options = {}) {
  if (!LOTTERIES.includes(lottery)) return;
  const requestId = state.requests[lottery] + 1;
  state.requests[lottery] = requestId;
  state.load[lottery] = { loading: true, error: null };
  if (options.announce) toast('Actualizando datos…');
  renderFreshness();
  try {
    const [numbers, summary, status] = await Promise.all([
      fetchJSON(API[lottery].numbers),
      fetchJSON(API[lottery].summary),
      fetchJSON(API[lottery].status),
    ]);
    const bundle = validateApiBundle(lottery, { numbers, summary, status }, {
      source: 'network',
      receivedAt: new Date().toISOString(),
    });
    if (state.requests[lottery] !== requestId) return;
    state.bundles[lottery] = bundle;
    state.load[lottery] = { loading: false, error: null };
    if (localStorageHandle) writeApiCache(localStorageHandle, bundle);
    populateYearInput();
    renderAll();
    if (options.announce) {
      toast(bundle.drawYear === state.yearByLottery[lottery]
        ? 'Datos actualizados'
        : `El servidor todavía ofrece el sorteo de ${bundle.drawYear}`);
    }
  } catch (error) {
    if (state.requests[lottery] !== requestId) return;
    console.warn(`Could not update ${lottery}`, error);
    if (state.bundles[lottery]) state.bundles[lottery] = { ...state.bundles[lottery], source: 'cache' };
    state.load[lottery] = { loading: false, error };
    renderAll();
    if (options.announce || lottery === state.lottery) {
      toast('No se pudo actualizar. Tus décimos siguen guardados.');
    }
  }
}

function ticketInput() {
  return {
    lottery: state.lottery,
    drawYear: selectedYear(),
    number: byId('numberInput')?.value,
    stakeCents: parseEuroToCents(byId('quantityInput')?.value ?? '20'),
    note: byId('commentInput')?.value ?? '',
  };
}

function handleTicketSubmit(event) {
  event.preventDefault();
  if (!repository) return showStorageProblem();
  try {
    const input = ticketInput();
    const result = state.editingId
      ? repository.update(state.editingId, input)
      : repository.create(input);
    state.tickets = result.document.tickets;
    const ticket = result.ticket;
    const wasEditing = Boolean(state.editingId);
    state.editingId = null;
    if (wasEditing) restoreDraft(ticket.lottery);
    else resetTicketForm();
    populateYearInput();
    renderAll();
    showTicketResult(ticket);
  } catch (error) {
    handleActionError(error);
  }
}

function resetTicketForm() {
  state.drafts[state.lottery] = { number: '', stake: '20', note: '' };
  setFormValues(state.drafts[state.lottery]);
  setEditingUI(false);
}

function setFormValues(values) {
  const number = byId('numberInput');
  const amount = byId('quantityInput');
  const note = byId('commentInput');
  if (number) number.value = values.number;
  if (amount) amount.value = values.stake;
  if (note) note.value = values.note;
}

function captureDraft(lottery = state.lottery) {
  state.drafts[lottery] = {
    number: byId('numberInput')?.value ?? '',
    stake: byId('quantityInput')?.value ?? '20',
    note: byId('commentInput')?.value ?? '',
  };
}

function restoreDraft(lottery = state.lottery) {
  setFormValues(state.drafts[lottery]);
  setEditingUI(false);
}

function setEditingUI(editing) {
  const submit = byId('submitTicketBtn') || document.querySelector('#searchForm button[type="submit"]');
  const submitLabel = submit?.querySelector('span');
  if (submitLabel) submitLabel.textContent = editing ? 'Guardar cambios' : 'Comprobar y guardar';
  else if (submit) submit.textContent = editing ? 'Guardar cambios' : 'Comprobar y guardar';
  let cancel = byId('cancelEditBtn');
  if (!cancel && editing && submit?.parentNode) {
    cancel = element('button', {
      className: 'ghost-button cancel-edit',
      text: 'Cancelar edición',
      attrs: { type: 'button', id: 'cancelEditBtn' },
    });
    cancel.addEventListener('click', cancelEdit);
    submit.parentNode.insertBefore(cancel, submit.nextSibling);
  }
  if (cancel) cancel.hidden = !editing;
}

function beginEdit(id) {
  const ticket = state.tickets.find((item) => item.id === id);
  if (!ticket) return;
  if (!state.editingId) captureDraft();
  state.editingId = id;
  state.lottery = ticket.lottery;
  state.yearByLottery[ticket.lottery] = ticket.drawYear ?? expectedDrawYear(ticket.lottery);
  all('[data-lottery]').forEach((button) => {
    const active = button.dataset.lottery === ticket.lottery;
    button.classList.toggle('active', active);
    if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(active));
    if (button.getAttribute('role') === 'tab') button.setAttribute('aria-selected', String(active));
  });
  populateYearInput();
  if (byId('numberInput')) byId('numberInput').value = ticket.number;
  if (byId('quantityInput')) byId('quantityInput').value = String(ticket.stakeCents / 100).replace('.', ',');
  if (byId('commentInput')) byId('commentInput').value = ticket.note;
  setEditingUI(true);
  switchTab('buscar');
  byId('numberInput')?.focus();
  toast(ticket.drawYear === null ? 'Elige un año y guarda los cambios.' : 'Editando décimo');
}

function cancelEdit() {
  state.editingId = null;
  restoreDraft();
  renderAll();
}

function handleHistoryAction(event) {
  const edit = event.target.closest('[data-edit-ticket]');
  if (edit) return beginEdit(edit.dataset.editTicket);
  const remove = event.target.closest('[data-delete-ticket]');
  if (!remove) return;
  const ticket = state.tickets.find((item) => item.id === remove.dataset.deleteTicket);
  if (!ticket || !window.confirm(`¿Borrar el décimo ${ticket.number}${ticket.drawYear ? ` de ${ticket.drawYear}` : ''}?`)) return;
  try {
    const documentState = repository.remove(ticket.id);
    state.tickets = documentState.tickets;
    renderAll();
    toast('Décimo eliminado');
  } catch (error) {
    handleActionError(error);
  }
}

function deleteVisibleTickets() {
  const count = state.tickets.filter((ticket) => ticket.lottery === state.lottery && ticket.drawYear === selectedYear()).length;
  if (!count) return toast('No hay décimos de este año para borrar.');
  const lotteryLabel = state.lottery === 'navidad' ? 'Navidad' : 'El Niño';
  if (!window.confirm(`¿Borrar ${count} ${count === 1 ? 'décimo' : 'décimos'} de ${lotteryLabel} ${selectedYear()}?`)) return;
  try {
    const documentState = repository.removeWhere((ticket) => (
      ticket.lottery === state.lottery && ticket.drawYear === selectedYear()
    ));
    state.tickets = documentState.tickets;
    renderAll();
    toast('Décimos del año eliminados');
  } catch (error) {
    handleActionError(error);
  }
}

function showTicketResult(ticket) {
  const result = evaluateTicket(ticket, state.bundles[ticket.lottery]);
  const container = byId('searchResult');
  if (container) {
    const card = element('div', { className: `result-card ${result.kind}` }, [
      element('p', { className: 'eyebrow', text: result.kind === 'winner' ? 'Resultado' : 'Consulta guardada' }),
      element('h3', { text: `${result.title} · ${ticket.number}` }),
      element('p', { text: result.message }),
    ]);
    container.replaceChildren(card);
  }
  showModal(result.title, `El número ${ticket.number} está guardado. ${result.message}`, result.kind === 'winner' ? 'success' : 'info');
}

function renderAll() {
  renderDrawIdentity();
  updateCount();
  renderHistory();
  renderPortfolioSummary();
  renderSummary();
  renderStatus();
  renderFreshness();
}

function renderDrawIdentity() {
  const year = selectedYear();
  const isChristmas = state.lottery === 'navidad';
  const lotteryName = isChristmas ? 'Lotería de Navidad' : 'Lotería del Niño';
  const heroTitle = document.querySelector('.hero-copy h1');
  if (heroTitle) {
    heroTitle.replaceChildren(
      document.createTextNode('Tus números.'),
      element('br'),
      element('em', { text: isChristmas ? 'Tu Navidad.' : 'El Niño.' }),
    );
  }
  const ticketArt = document.querySelector('.ticket-art');
  if (ticketArt) {
    const label = ticketArt.querySelector('span');
    const yearNode = ticketArt.querySelector('strong');
    const date = ticketArt.querySelector('small');
    if (label) label.textContent = lotteryName.toLocaleUpperCase('es-ES');
    if (yearNode) yearNode.textContent = String(year);
    if (date) date.textContent = isChristmas ? '22 DE DICIEMBRE' : '6 DE ENERO';
  }
  const edition = document.querySelector('.sidebar-note small');
  if (edition) edition.textContent = `${isChristmas ? 'EDICIÓN NAVIDAD' : 'EDICIÓN EL NIÑO'} ${year}`;
  document.title = `${lotteryName} ${year} · Tus números, contigo`;
}

function updateCount() {
  const count = byId('savedCount');
  if (count) count.textContent = String(state.tickets.length);
}

function renderHistory() {
  const container = byId('myNumbersList');
  if (!container) return;
  const year = selectedYear();
  const exact = state.tickets.filter((ticket) => ticket.lottery === state.lottery && ticket.drawYear === year);
  const unknown = state.tickets.filter((ticket) => ticket.lottery === state.lottery && ticket.drawYear === null);
  const tickets = [...exact, ...unknown];
  if (!tickets.length) {
    container.replaceChildren(element('div', {
      className: 'empty-state',
      text: `Aún no tienes décimos guardados para el sorteo de ${year}.`,
    }));
    return;
  }
  container.replaceChildren(...tickets.map(renderTicket));
}

function renderTicket(ticket) {
  const result = evaluateTicket(ticket, state.bundles[ticket.lottery]);
  const main = element('div', { className: 'ticket-content' }, [
    element('div', { className: 'number-main', text: ticket.number }),
  ]);
  const metaParts = [formatEuro(ticket.stakeCents), ticket.drawYear === null ? 'Año pendiente' : String(ticket.drawYear)];
  if (ticket.note) metaParts.push(ticket.note);
  main.append(element('div', { className: 'number-meta', text: metaParts.join(' · ') }));
  main.append(element('div', { className: `result-badge ${result.kind}`, text: result.title }));
  main.append(element('p', { className: 'ticket-result-detail', text: result.message }));
  if (result.prize) {
    main.append(element('div', {
      className: 'number-prize',
      text: `Premio por décimo de 20 €: ${formatEuro(result.prize.standardPrizeCents)} · Tu estimación: ${formatEuro(result.prize.estimatedPrizeCents)}`,
    }));
  }
  if (result.cached) main.append(element('small', { className: 'cached-result', text: 'Resultado calculado con la copia local de la lista.' }));
  const actions = element('div', { className: 'ticket-actions' }, [
    element('button', {
      className: 'edit-number',
      text: ticket.stakeCents === 0 ? 'Revisar importe' : ticket.drawYear === null ? 'Asignar año' : 'Editar',
      attrs: { type: 'button', 'data-edit-ticket': ticket.id, 'aria-label': `Editar ${ticket.number}` },
    }),
    element('button', {
      className: 'delete-number',
      text: 'Eliminar',
      attrs: { type: 'button', 'data-delete-ticket': ticket.id, 'aria-label': `Eliminar ${ticket.number}` },
    }),
  ]);
  const article = element('article', { className: `number-item ${result.kind === 'winner' ? 'has-prize' : ''}` }, [main, actions]);
  if (ticket.drawYear === null || ticket.stakeCents === 0) article.classList.add('needs-review');
  return article;
}

function renderPortfolioSummary() {
  const container = byId('portfolioSummary');
  if (!container) return;
  const tickets = state.tickets.filter((ticket) => ticket.lottery === state.lottery && ticket.drawYear === selectedYear());
  const staked = tickets.reduce((sum, ticket) => sum + ticket.stakeCents, 0);
  const estimated = tickets.reduce((sum, ticket) => {
    const result = evaluateTicket(ticket, state.bundles[ticket.lottery]);
    return sum + (result.prize?.estimatedPrizeCents ?? 0);
  }, 0);
  if (!tickets.length) {
    container.replaceChildren();
    return;
  }
  const results = tickets.map((ticket) => evaluateTicket(ticket, state.bundles[ticket.lottery]));
  const winners = results.filter((result) => result.kind === 'winner').length;
  const unresolved = results.filter((result) => (
    ['unavailable', 'pending', 'provisional-none', 'needs-year', 'needs-review'].includes(result.kind)
  )).length;
  const resultValue = winners === 0 && unresolved > 0 ? 'Pendiente' : formatEuro(estimated);
  const resultLabel = unresolved > 0
    ? `${unresolved} sin resultado definitivo${winners ? ` · ${winners} premiados` : ''}`
    : `${winners} ${winners === 1 ? 'premiado' : 'premiados'} · estimación bruta`;
  container.replaceChildren(
    portfolioMetric(String(tickets.length), tickets.length === 1 ? 'décimo guardado' : 'décimos guardados'),
    portfolioMetric(formatEuro(staked), 'importe jugado'),
    portfolioMetric(resultValue, resultLabel),
  );
}

function portfolioMetric(value, label) {
  return element('div', {}, [element('strong', { text: value }), element('span', { text: label })]);
}

function renderSummary() {
  const container = byId('summaryList');
  if (!container) return;
  const bundle = state.bundles[state.lottery];
  if (!bundle) {
    container.replaceChildren(element('div', { className: 'empty-state', text: 'No hay un resumen válido disponible.' }));
    return;
  }
  if (bundle.drawYear !== selectedYear()) {
    container.replaceChildren(element('div', {
      className: 'empty-state unavailable',
      text: `No hay resumen de ${selectedYear()}. El servidor todavía ofrece el sorteo de ${bundle.drawYear}.`,
    }));
    return;
  }
  const items = bundle.summary.map((item, index) => {
    const display = item.value === -1 ? 'Pendiente' : String(item.value).padStart(item.digits, '0');
    return element('article', { className: `summary-item ${index < 3 ? 'major' : ''}` }, [
      element('span', { className: 'prize-name', text: PRIZE_LABELS[state.lottery][index] }),
      element('strong', { className: 'prize-value', text: display }),
    ]);
  });
  container.replaceChildren(...items);
}

function renderStatus() {
  const title = byId('statusTitle');
  const message = byId('statusMessage');
  const dot = byId('statusDot');
  if (!title || !message || !dot) return;
  const bundle = state.bundles[state.lottery];
  const load = state.load[state.lottery];
  dot.className = 'status-dot';
  if (!bundle) {
    title.textContent = load.loading ? 'Consultando…' : 'Servidor no disponible';
    message.textContent = load.loading
      ? 'Estamos comprobando la lista del sorteo.'
      : load.error instanceof ValidationError
        ? 'El servidor respondió con datos incoherentes y no se usarán para decidir si un décimo tiene premio.'
        : 'No se puede comprobar ningún resultado ahora. Tus décimos siguen guardados.';
    return;
  }
  if (bundle.drawYear !== selectedYear()) {
    title.textContent = `Sin datos de ${selectedYear()}`;
    message.textContent = `El servidor ofrece ${bundle.drawYear}. No mezclamos resultados de años distintos.`;
    dot.classList.add('unavailable');
    return;
  }
  const [statusTitle, statusMessage] = STATUS_COPY[bundle.status];
  title.textContent = statusTitle;
  message.textContent = `${statusMessage}${load.error ? ' Se muestra la última copia válida guardada.' : ''}`;
  if (bundle.status === 1) dot.classList.add('live');
  if (bundle.status >= 3) dot.classList.add('done');
}

function renderFreshness() {
  const target = byId('dataFreshness');
  if (!target) return;
  const bundle = state.bundles[state.lottery];
  const load = state.load[state.lottery];
  if (load.loading) {
    target.textContent = 'Actualizando resultados…';
    target.dataset.state = 'loading';
  } else if (!bundle) {
    target.textContent = load.error instanceof ValidationError
      ? `Datos rechazados · ${load.error.message}`
      : 'Servidor no disponible · tus décimos están guardados localmente';
    target.dataset.state = 'unavailable';
  } else if (bundle.drawYear !== selectedYear()) {
    target.textContent = `Datos disponibles: ${bundle.drawYear} · seleccionaste ${selectedYear()}`;
    target.dataset.state = 'stale';
  } else {
    const received = new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(bundle.receivedAt));
    target.textContent = `${bundle.source === 'cache' ? 'Copia local' : 'Actualizado'} · ${received}`;
    target.dataset.state = bundle.source === 'cache' ? 'cached' : 'fresh';
  }
}

function exportBackup() {
  try {
    const backup = createBackup(state.tickets, { source: 'web' });
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = element('a', {
      attrs: {
        href: url,
        download: `loteria-copia-${new Date().toISOString().slice(0, 10)}.json`,
      },
    });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`Copia creada con ${state.tickets.length} ${state.tickets.length === 1 ? 'décimo' : 'décimos'}.`);
  } catch (error) {
    handleActionError(error);
  }
}

async function handleImportFile(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 10_000_000) return showModal('Archivo demasiado grande', 'La copia no puede superar 10 MB.', 'error');
  if (!repository) return showStorageProblem();
  try {
    const result = repository.import(await file.text());
    state.tickets = result.document.tickets;
    populateYearInput();
    renderAll();
    const ignored = result.warnings.length ? ` ${result.warnings.length} filas antiguas no válidas se omitieron.` : '';
    showModal('Importación terminada', `${result.added} décimos añadidos y ${result.skipped} ya existentes.${ignored}`, 'success');
  } catch (error) {
    handleActionError(error, 'No se pudo importar la copia');
  }
}

function handleImportLanding() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('action') !== 'import') return;
  switchTab('historico');
  window.setTimeout(() => {
    byId('importBackupBtn')?.focus();
    showModal('Importar desde iPhone', 'Pulsa “Importar copia” y selecciona el archivo JSON que exportaste desde la app.', 'info');
  }, 0);
}

function handleStorageChange(event) {
  if (!repository || !event.key?.startsWith('loteria_tickets_v2')) return;
  try {
    state.tickets = repository.load().tickets;
    populateYearInput();
    renderAll();
    toast('Tus décimos se actualizaron desde otra pestaña.');
  } catch (error) {
    console.warn('Could not reload cross-tab data', error);
  }
}

async function sharePage() {
  const data = {
    title: 'Lotería · Comprueba tu suerte',
    text: 'Comprueba y guarda tus décimos de Navidad y El Niño.',
    url: window.location.href.split('?')[0],
  };
  try {
    if (navigator.share) await navigator.share(data);
    else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(data.url);
      toast('Enlace copiado');
    }
  } catch (error) {
    if (error?.name !== 'AbortError') toast('No se pudo compartir el enlace.');
  }
}

const CONTACTS = Object.freeze({
  pablo: {
    name: 'Pablo Clemente Pérez',
    links: [
      ['✉', 'Email', 'pabloclemente08@gmail.com', 'mailto:pabloclemente08@gmail.com?subject=Loter%C3%ADa%20Navidad'],
      ['in', 'LinkedIn', 'Perfil profesional', 'https://es.linkedin.com/in/pabloclementeperez'],
      ['𝕏', 'X / Twitter', '@pclemnte', 'https://x.com/pclemnte'],
      ['↗', 'Página web', 'pabloclementeperez.com', 'https://pabloclementeperez.com/'],
    ],
  },
  elena: {
    name: 'Elena Gordaliza Fdez',
    links: [
      ['✉', 'Email', 'ele.aliza@gmail.com', 'mailto:ele.aliza@gmail.com?subject=Loter%C3%ADa%20Navidad'],
      ['in', 'LinkedIn', 'Perfil profesional', 'https://www.linkedin.com/in/elena-gordaliza-18163a63/'],
      ['𝕏', 'X / Twitter', '@Elealiza', 'https://x.com/Elealiza'],
    ],
  },
});

function showContact(person) {
  const contact = CONTACTS[person];
  if (!contact) return;
  const modal = byId('modal');
  if (!modal) return;
  if (modal.hidden) modalFocusReturn = document.activeElement;
  modal.classList.add('contact-mode');
  if (byId('modalIcon')) byId('modalIcon').textContent = '♡';
  if (byId('modalTitle')) byId('modalTitle').textContent = `Contactar con ${contact.name}`;
  if (byId('modalMessage')) byId('modalMessage').textContent = 'Elige cómo quieres ponerte en contacto.';
  const options = byId('contactOptions');
  if (options) {
    options.replaceChildren(...contact.links.map(([glyph, label, detail, url]) => element('a', {
      className: 'contact-option',
      attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' },
    }, [
      element('span', { className: 'contact-glyph', text: glyph }),
      element('span', {}, [element('span', { text: label }), element('small', { text: detail })]),
    ])));
    options.hidden = false;
  }
  modal.hidden = false;
  byId('modalClose')?.focus();
}

function openExternal(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function toast(message) {
  const target = byId('toast');
  if (!target) return;
  target.textContent = message;
  target.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => target.classList.remove('show'), 3200);
}

function showModal(title, message, type = 'info') {
  const modal = byId('modal');
  if (!modal) return toast(`${title}: ${message}`);
  if (modal.hidden) modalFocusReturn = document.activeElement;
  modal.classList.remove('contact-mode');
  const options = byId('contactOptions');
  if (options) options.hidden = true;
  if (byId('modalTitle')) byId('modalTitle').textContent = title;
  if (byId('modalMessage')) byId('modalMessage').textContent = message;
  if (byId('modalIcon')) byId('modalIcon').textContent = type === 'success' ? '✦' : type === 'error' ? '!' : 'i';
  modal.hidden = false;
  byId('modalOk')?.focus();
}

function closeModal() {
  const modal = byId('modal');
  if (!modal) return;
  modal.classList.remove('contact-mode');
  const options = byId('contactOptions');
  if (options) options.hidden = true;
  modal.hidden = true;
  if (modalFocusReturn?.isConnected) modalFocusReturn.focus();
  modalFocusReturn = null;
}

function showStorageProblem() {
  const notice = byId('storageNotice');
  if (notice) {
    notice.textContent = 'Este navegador no permite guardar cambios. Revisa el modo privado o el espacio disponible.';
    notice.hidden = false;
  }
  showModal('No se pudo guardar', 'El navegador bloqueó el almacenamiento local. Tus campos no se han borrado.', 'error');
}

function showMigrationWarnings(warnings) {
  const notice = byId('storageNotice');
  if (!notice) return;
  notice.textContent = warnings.some((message) => message.includes('guardar'))
    ? 'Tus números antiguos siguen visibles, pero el navegador no pudo convertir todavía la copia local. Exporta una copia antes de borrar datos del navegador.'
    : `${warnings.length} registros antiguos no se pudieron convertir. El resto se conserva y los datos originales no se han borrado.`;
  notice.hidden = false;
}

function handleActionError(error, title = 'No se pudo guardar') {
  console.warn(title, error);
  if (error instanceof PersistenceError) return showStorageProblem();
  const message = error instanceof ValidationError ? error.message : 'Se produjo un error inesperado. Inténtalo de nuevo.';
  showModal(title, message, 'error');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();

export { loadData };
