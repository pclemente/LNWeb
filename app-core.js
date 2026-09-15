export const LOTTERIES = Object.freeze(['navidad', 'nino']);

export const STORAGE_KEYS = Object.freeze({
  primary: 'loteria_tickets_v2',
  backup: 'loteria_tickets_v2_backup',
  staging: 'loteria_tickets_v2_staging',
  quarantine: 'loteria_tickets_v2_corrupt',
});

export const BACKUP_FORMAT = 'loteria-ticket-backup';
export const BACKUP_VERSION = 1;
export const STORAGE_VERSION = 2;
export const MAX_TICKETS = 10_000;
export const MAX_NOTE_LENGTH = 5_000;
export const MAX_STAKE_CENTS = 100_000_000;

const LEGACY_WEB_KEYS = Object.freeze({
  navidad: 'loteria_saved_navidad',
  nino: 'loteria_saved_nino',
});

const IOS_KEYS = Object.freeze({
  navidad: {
    numbers: 'numberArrayStored',
    stakes: 'quantityArrayStored',
    notes: 'commentsArrayStored',
  },
  nino: {
    numbers: 'numberArrayStoredNiño',
    stakes: 'quantityArrayStoredNiño',
    notes: 'commentsArrayStoredNiño',
  },
});

export class ValidationError extends Error {
  constructor(message, field = '') {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export class PersistenceError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PersistenceError';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asIsoDate(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `ticket-${Date.now().toString(36)}-${random}`;
}

export function normalizeLottery(value) {
  if (typeof value === 'boolean') return value ? 'navidad' : 'nino';
  const normalized = String(value ?? '')
    .trim()
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_-]/g, '');
  if (['navidad', 'loterianavidad', 'christmas'].includes(normalized)) return 'navidad';
  if (['nino', 'elnino', 'loteriaelnino'].includes(normalized)) return 'nino';
  throw new ValidationError('El sorteo debe ser Navidad o El Niño.', 'lottery');
}

export function normalizeNumber(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(raw)) {
    throw new ValidationError('El número debe contener entre 1 y 5 cifras.', 'number');
  }
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 99_999) {
    throw new ValidationError('El número debe estar entre 00000 y 99999.', 'number');
  }
  return String(numeric).padStart(5, '0');
}

export function normalizeDrawYear(value, { allowUnknown = false } = {}) {
  if ((value === null || value === undefined || value === '') && allowUnknown) return null;
  const raw = String(value ?? '').trim();
  if (!/^\d{4}$/.test(raw)) {
    throw new ValidationError('El año del sorteo debe tener cuatro cifras.', 'drawYear');
  }
  const year = Number(raw);
  if (year < 2000 || year > 2100) {
    throw new ValidationError('El año del sorteo debe estar entre 2000 y 2100.', 'drawYear');
  }
  return year;
}

export function parseEuroToCents(value, { allowZero = false } = {}) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('Introduce una cantidad válida.', 'stake');
    value = value.toFixed(2);
  }
  const raw = String(value ?? '').trim().replace(/\s/g, '');
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(raw)) {
    throw new ValidationError('La cantidad admite hasta dos decimales, por ejemplo 20,50.', 'stake');
  }
  const [eurosPart, centsPart = ''] = raw.replace(',', '.').split('.');
  const cents = Number(eurosPart) * 100 + Number(centsPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_STAKE_CENTS || (!allowZero && cents <= 0)) {
    throw new ValidationError('La cantidad jugada debe ser mayor que cero.', 'stake');
  }
  return cents;
}

export function formatEuro(cents) {
  if (!Number.isSafeInteger(cents)) return '—';
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function normalizeNote(value) {
  const note = String(value ?? '').trim();
  if (/[\u0000-\u001f\u007f]/.test(note)) {
    throw new ValidationError('La nota debe estar en una sola línea y no incluir caracteres de control.', 'note');
  }
  if (note.length > MAX_NOTE_LENGTH) {
    throw new ValidationError(`La nota no puede superar ${MAX_NOTE_LENGTH} caracteres.`, 'note');
  }
  return note;
}

export function normalizeTicket(input, options = {}) {
  if (!isPlainObject(input)) throw new ValidationError('El décimo no tiene un formato válido.');
  const nowIso = options.nowIso || new Date().toISOString();
  const drawYear = normalizeDrawYear(input.drawYear ?? input.year, {
    allowUnknown: options.allowUnknownYear === true,
  });
  let stakeCents;
  if (input.stakeCents !== undefined) {
    const raw = typeof input.stakeCents === 'string' ? input.stakeCents.trim() : input.stakeCents;
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
      throw new ValidationError('La cantidad en céntimos no es válida.', 'stake');
    }
    stakeCents = Number(raw);
    if (stakeCents < 0 || (!options.allowZeroStake && stakeCents === 0) || stakeCents > MAX_STAKE_CENTS) {
      throw new ValidationError('La cantidad jugada debe ser mayor que cero.', 'stake');
    }
  } else {
    stakeCents = parseEuroToCents(input.amount ?? input.quantity ?? input.stake ?? 20, {
      allowZero: options.allowZeroStake === true,
    });
  }
  const suppliedId = typeof input.id === 'string' ? input.id.trim() : '';
  const id = suppliedId && suppliedId.length <= 128 ? suppliedId : (options.idFactory || randomId)();
  const createdAt = asIsoDate(input.createdAt, nowIso);
  const updatedAt = asIsoDate(input.updatedAt, createdAt);
  return {
    id,
    lottery: normalizeLottery(input.lottery),
    drawYear,
    number: normalizeNumber(input.number),
    stakeCents,
    note: normalizeNote(input.note ?? input.comment),
    createdAt,
    updatedAt,
  };
}

export function expectedDrawYear(lottery, date = new Date()) {
  const normalized = normalizeLottery(lottery);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month)) throw new ValidationError('No se pudo calcular el año del sorteo.');
  if (normalized === 'navidad') return year;
  return month === 1 ? year : year + 1;
}

export function datasetYearFromTimestamp(timestamp, lottery) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  let year = date.getUTCFullYear();
  if (lottery === 'nino' && date.getUTCMonth() >= 9) year += 1;
  return year >= 2000 && year <= 2100 ? year : null;
}

function parseStatus(source, label) {
  if (!isPlainObject(source)) throw new ValidationError(`${label} no tiene un formato válido.`);
  const rawError = source.error ?? 0;
  if (!((rawError === 0) || (rawError === '0'))) throw new ValidationError(`${label} indica un error del servidor.`);
  const rawStatus = source.status;
  if (!((typeof rawStatus === 'number' && Number.isInteger(rawStatus)) || (typeof rawStatus === 'string' && /^[0-4]$/.test(rawStatus.trim())))) {
    throw new ValidationError(`${label} contiene un estado desconocido.`);
  }
  const status = Number(source.status);
  if (!Number.isInteger(status) || status < 0 || status > 4) {
    throw new ValidationError(`${label} contiene un estado desconocido.`);
  }
  return status;
}

function summaryShape(lottery) {
  if (lottery === 'navidad') {
    return Array.from({ length: 13 }, (_, index) => ({
      key: `numero${index + 1}`,
      digits: 5,
    }));
  }
  return [
    { key: 'Primer_premio', digits: 5 },
    { key: 'Segundo_Premio', digits: 5 },
    { key: 'Tercer_Premio', digits: 5 },
    ...Array.from({ length: 2 }, (_, index) => ({ key: `Extraccion_4_cifras_${index + 1}`, digits: 4 })),
    ...Array.from({ length: 14 }, (_, index) => ({ key: `Extraccion_3_cifras_${index + 1}`, digits: 3 })),
    ...Array.from({ length: 5 }, (_, index) => ({ key: `Extraccion_2_cifras_${index + 1}`, digits: 2 })),
    ...Array.from({ length: 3 }, (_, index) => ({ key: `Reintegro_${index + 1}`, digits: 1 })),
  ];
}

export function validateApiBundle(lottery, rawBundle, options = {}) {
  const normalizedLottery = normalizeLottery(lottery);
  if (!isPlainObject(rawBundle)) throw new ValidationError('La respuesta del servidor está incompleta.');
  const status = parseStatus(rawBundle.status, 'El estado');
  const numbersStatus = parseStatus(rawBundle.numbers, 'La lista de premios');
  const summaryStatus = parseStatus(rawBundle.summary, 'El resumen');
  if (status !== numbersStatus || status !== summaryStatus) {
    throw new ValidationError('Las fuentes del servidor no corresponden a la misma actualización.');
  }
  const drawYear = datasetYearFromTimestamp(rawBundle.summary.timestamp, normalizedLottery);
  if (drawYear === null) throw new ValidationError('El resumen no incluye una fecha de sorteo válida.');

  const prizes = Object.create(null);
  for (const [rawNumber, rawPrize] of Object.entries(rawBundle.numbers)) {
    if (['status', 'error', 'timestamp'].includes(rawNumber)) continue;
    let number;
    try {
      number = normalizeNumber(rawNumber);
    } catch {
      throw new ValidationError('La lista contiene un número inválido.');
    }
    if (!['string', 'number'].includes(typeof rawPrize)) {
      throw new ValidationError('La lista contiene un premio inválido.');
    }
    if (typeof rawPrize === 'string' && !/^\d+(?:[.,]\d+)?$/.test(rawPrize.trim())) {
      throw new ValidationError('La lista contiene un premio inválido.');
    }
    const numericPrize = typeof rawPrize === 'string' ? Number(rawPrize.replace(',', '.')) : rawPrize;
    if (!Number.isFinite(numericPrize) || numericPrize <= 0 || numericPrize > 100_000_000) {
      throw new ValidationError('La lista contiene un premio inválido.');
    }
    const standardPrizeCents = Math.round(numericPrize * 10);
    if (!Number.isSafeInteger(standardPrizeCents)) {
      throw new ValidationError('La lista contiene un premio fuera de rango.');
    }
    if (prizes[number] !== undefined && prizes[number] !== standardPrizeCents) {
      throw new ValidationError('La lista contiene premios contradictorios para el mismo número.');
    }
    prizes[number] = standardPrizeCents;
  }

  const summary = summaryShape(normalizedLottery).map(({ key, digits }) => {
    const rawValue = rawBundle.summary[key];
    if (!((typeof rawValue === 'number' && Number.isInteger(rawValue)) || (typeof rawValue === 'string' && /^-?\d+$/.test(rawValue.trim())))) {
      throw new ValidationError(`El resumen contiene un valor inválido en ${key}.`);
    }
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < -1 || value >= (10 ** digits)) {
      throw new ValidationError(`El resumen contiene un valor inválido en ${key}.`);
    }
    return { key, digits, value };
  });
  if (status === 0 && summary.some((item) => item.value !== -1)) {
    throw new ValidationError('El resumen publica premios aunque el sorteo figura como no iniciado.');
  }
  if (status >= 2 && summary.some((item) => item.value === -1)) {
    throw new ValidationError('La lista final todavía tiene premios pendientes.');
  }
  const fullNumberPrizes = normalizedLottery === 'navidad' ? summary : summary.slice(0, 3);
  for (const item of fullNumberPrizes) {
    if (item.value === -1) continue;
    const winningNumber = String(item.value).padStart(5, '0');
    if (prizes[winningNumber] === undefined) {
      throw new ValidationError(`El premio ${winningNumber} aparece en el resumen pero falta en la lista detallada.`);
    }
  }

  return {
    lottery: normalizedLottery,
    drawYear,
    status,
    prizes,
    summary,
    source: options.source === 'cache' ? 'cache' : 'network',
    receivedAt: asIsoDate(options.receivedAt, new Date().toISOString()),
  };
}

export function prizeForTicket(ticket, bundle) {
  if (!bundle || ticket.lottery !== bundle.lottery || ticket.drawYear !== bundle.drawYear) return null;
  const standardPrizeCents = bundle.prizes[ticket.number];
  if (!Number.isSafeInteger(standardPrizeCents)) return null;
  return {
    standardPrizeCents,
    estimatedPrizeCents: Math.round((standardPrizeCents * ticket.stakeCents) / 2000),
  };
}

export function evaluateTicket(ticket, bundle, options = {}) {
  if (ticket.stakeCents === 0) {
    return {
      kind: 'needs-review',
      title: 'Revisa el importe',
      message: 'Este décimo se importó con 0,00 €. Edita el importe antes de comprobarlo.',
    };
  }
  if (ticket.drawYear === null) {
    return {
      kind: 'needs-year',
      title: 'Falta el año',
      message: 'Asigna el año del sorteo antes de comprobar este décimo.',
    };
  }
  if (!bundle) {
    return {
      kind: 'unavailable',
      title: 'Comprobación no disponible',
      message: 'No hay una lista válida para este sorteo y año. El décimo sigue guardado.',
    };
  }
  if (bundle.lottery !== ticket.lottery || bundle.drawYear !== ticket.drawYear) {
    return {
      kind: 'unavailable',
      title: `Sin datos de ${ticket.drawYear}`,
      message: `El servidor ofrece datos de ${bundle.drawYear}; no se usarán para comprobar este décimo.`,
    };
  }
  if (bundle.status === 0) {
    return {
      kind: 'pending',
      title: 'Sorteo no comenzado',
      message: 'Todavía no se puede determinar el resultado. El décimo queda guardado.',
    };
  }
  if (bundle.status === 1) {
    const received = new Date(bundle.receivedAt).getTime();
    const age = (options.now || new Date()).getTime() - received;
    if (bundle.source === 'cache' && (!Number.isFinite(age) || age > 10 * 60 * 1000)) {
      return {
        kind: 'unavailable',
        title: 'Actualización interrumpida',
        message: 'La copia guardada es de un sorteo en curso y ya no es reciente. Inténtalo de nuevo con conexión.',
      };
    }
  }
  const prize = prizeForTicket(ticket, bundle);
  if (prize) {
    return {
      kind: 'winner',
      title: bundle.status === 2 ? 'Premiado en la lista provisional' : '¡Premiado!',
      message: `Premio estimado para tu importe: ${formatEuro(prize.estimatedPrizeCents)}.`,
      prize,
      cached: bundle.source === 'cache',
    };
  }
  if (bundle.status === 1) {
    return {
      kind: 'pending',
      title: 'Pendiente',
      message: 'El sorteo está en curso y este número aún podría aparecer.',
    };
  }
  if (bundle.status === 2) {
    return {
      kind: 'provisional-none',
      title: 'Sin premio en la lista provisional',
      message: 'El sorteo terminó, pero la lista aún no es oficial. Vuelve a comprobarlo más tarde.',
    };
  }
  return {
    kind: 'not-winner',
    title: 'Sin premio',
    message: 'Este número no figura entre los premios de la lista publicada.',
    cached: bundle.source === 'cache',
  };
}

function normalizeDocument(raw) {
  if (!isPlainObject(raw) || raw.version !== STORAGE_VERSION || !Array.isArray(raw.tickets)) {
    throw new ValidationError('La copia local no tiene un formato válido.');
  }
  if (raw.tickets.length > MAX_TICKETS) throw new ValidationError('La copia local contiene demasiados décimos.');
  const tickets = raw.tickets.map((ticket) => normalizeTicket(ticket, {
    allowUnknownYear: true,
    allowZeroStake: true,
  }));
  const revision = Number(raw.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new ValidationError('La revisión local no es válida.');
  return {
    version: STORAGE_VERSION,
    revision,
    updatedAt: asIsoDate(raw.updatedAt, new Date(0).toISOString()),
    tickets,
  };
}

function safeParse(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readValidDocument(storage, key) {
  try {
    const parsed = safeParse(storage.getItem(key));
    return parsed ? normalizeDocument(parsed) : null;
  } catch {
    return null;
  }
}

function splitIosEntry(entries, number, fallback) {
  if (!Array.isArray(entries)) return fallback;
  const canonical = String(Number(number));
  const match = entries.find((entry) => {
    const raw = String(entry ?? '');
    const separator = raw.indexOf('-');
    if (separator < 0) return false;
    try {
      return String(Number(normalizeNumber(raw.slice(0, separator)))) === canonical;
    } catch {
      return false;
    }
  });
  if (match === undefined) return fallback;
  const raw = String(match);
  return raw.slice(raw.indexOf('-') + 1);
}

export function migrateLegacyStorage(storage, options = {}) {
  const tickets = [];
  const warnings = [];
  const nowIso = options.nowIso || new Date().toISOString();
  const idFactory = options.idFactory || randomId;
  for (const lottery of LOTTERIES) {
    let parsed;
    try {
      parsed = safeParse(storage.getItem(LEGACY_WEB_KEYS[lottery]));
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) continue;
    parsed.forEach((entry, index) => {
      try {
        tickets.push(normalizeTicket({
          ...entry,
          id: undefined,
          lottery,
          drawYear: null,
          stakeCents: undefined,
          amount: entry?.quantity ?? entry?.amount ?? 20,
          note: entry?.comment ?? entry?.note ?? '',
        }, { allowUnknownYear: true, allowZeroStake: true, nowIso, idFactory }));
      } catch (error) {
        warnings.push(`${lottery} ${index + 1}: ${error.message}`);
      }
    });
  }
  return { tickets, warnings };
}

export class TicketRepository {
  constructor(storage, options = {}) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new TypeError('Se necesita un almacenamiento compatible con localStorage.');
    }
    this.storage = storage;
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || randomId;
    this.document = null;
    this.warnings = [];
  }

  load() {
    const rawDocuments = {};
    for (const key of [STORAGE_KEYS.primary, STORAGE_KEYS.staging, STORAGE_KEYS.backup]) {
      try {
        const raw = this.storage.getItem(key);
        if (raw !== null) rawDocuments[key] = raw;
      } catch {
        // Reads are attempted again through the validated path below.
      }
    }
    const candidates = [
      readValidDocument(this.storage, STORAGE_KEYS.primary),
      readValidDocument(this.storage, STORAGE_KEYS.staging),
      readValidDocument(this.storage, STORAGE_KEYS.backup),
    ].filter(Boolean).sort((a, b) => b.revision - a.revision);
    if (candidates.length) {
      this.document = candidates[0];
      return this.snapshot();
    }
    if (Object.keys(rawDocuments).length) {
      try {
        this.storage.setItem(STORAGE_KEYS.quarantine, JSON.stringify({
          capturedAt: this.now().toISOString(),
          values: rawDocuments,
        }));
        this.warnings.push('La copia local dañada se conservó para recuperación.');
      } catch (error) {
        throw new PersistenceError('La copia local está dañada y no pudo conservarse para recuperación.', error);
      }
    }
    const migrated = migrateLegacyStorage(this.storage, {
      nowIso: this.now().toISOString(),
      idFactory: this.idFactory,
    });
    this.warnings.push(...migrated.warnings);
    this.document = {
      version: STORAGE_VERSION,
      revision: 0,
      updatedAt: this.now().toISOString(),
      tickets: migrated.tickets,
    };
    if (migrated.tickets.length) {
      try {
        this.persist(this.document);
      } catch (error) {
        this.warnings.push(error.message);
      }
    }
    return this.snapshot();
  }

  snapshot() {
    if (!this.document) this.load();
    return JSON.parse(JSON.stringify(this.document));
  }

  persist(nextDocument) {
    const normalized = normalizeDocument(nextDocument);
    const serialized = JSON.stringify(normalized);
    try {
      const previous = this.storage.getItem(STORAGE_KEYS.primary);
      if (previous && readValidDocument(this.storage, STORAGE_KEYS.primary)) {
        this.storage.setItem(STORAGE_KEYS.backup, previous);
      }
      this.storage.setItem(STORAGE_KEYS.staging, serialized);
      if (this.storage.getItem(STORAGE_KEYS.staging) !== serialized) {
        throw new Error('No se pudo verificar la escritura temporal.');
      }
      this.storage.setItem(STORAGE_KEYS.primary, serialized);
      if (this.storage.getItem(STORAGE_KEYS.primary) !== serialized) {
        throw new Error('No se pudo verificar la escritura principal.');
      }
      this.storage.setItem(STORAGE_KEYS.backup, serialized);
      this.storage.removeItem?.(STORAGE_KEYS.staging);
    } catch (error) {
      throw new PersistenceError('No se pudo guardar en este navegador.', error);
    }
    this.document = normalized;
    return this.snapshot();
  }

  commitTickets(tickets) {
    if (!this.document) this.load();
    if (!Array.isArray(tickets) || tickets.length > MAX_TICKETS) {
      throw new ValidationError('Se ha superado el límite de décimos guardados.');
    }
    return this.persist({
      version: STORAGE_VERSION,
      revision: this.document.revision + 1,
      updatedAt: this.now().toISOString(),
      tickets,
    });
  }

  create(input) {
    if (!this.document) this.load();
    const ticket = normalizeTicket(input, {
      nowIso: this.now().toISOString(),
      idFactory: this.idFactory,
    });
    const duplicate = this.document.tickets.find((item) => ticketFingerprint(item) === ticketFingerprint(ticket));
    if (duplicate) return { document: this.snapshot(), ticket: duplicate, created: false };
    const document = this.commitTickets([ticket, ...this.document.tickets]);
    return { document, ticket, created: true };
  }

  update(id, changes) {
    if (!this.document) this.load();
    const index = this.document.tickets.findIndex((ticket) => ticket.id === id);
    if (index < 0) throw new ValidationError('No se encontró el décimo que quieres editar.');
    const current = this.document.tickets[index];
    const updated = normalizeTicket({
      ...current,
      ...changes,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    }, { nowIso: this.now().toISOString(), idFactory: this.idFactory });
    const tickets = [...this.document.tickets];
    tickets[index] = updated;
    return { document: this.commitTickets(tickets), ticket: updated };
  }

  remove(id) {
    if (!this.document) this.load();
    const tickets = this.document.tickets.filter((ticket) => ticket.id !== id);
    if (tickets.length === this.document.tickets.length) return this.snapshot();
    return this.commitTickets(tickets);
  }

  removeWhere(predicate) {
    if (!this.document) this.load();
    return this.commitTickets(this.document.tickets.filter((ticket) => !predicate(ticket)));
  }

  import(payload) {
    if (!this.document) this.load();
    const imported = parseBackupPayload(payload, {
      nowIso: this.now().toISOString(),
      idFactory: this.idFactory,
    });
    const merged = mergeTickets(this.document.tickets, imported.tickets, this.idFactory);
    const document = merged.added ? this.commitTickets(merged.tickets) : this.snapshot();
    return { document, added: merged.added, skipped: merged.skipped, warnings: imported.warnings };
  }
}

function ticketFingerprint(ticket) {
  return [ticket.lottery, ticket.drawYear ?? 'unknown', ticket.number, ticket.stakeCents, ticket.note].join('\u001f');
}

export function mergeTickets(existing, incoming, idFactory = randomId) {
  const tickets = existing.map((ticket) => ({ ...ticket }));
  const fingerprints = new Set(tickets.map(ticketFingerprint));
  const ids = new Set(tickets.map((ticket) => ticket.id));
  let added = 0;
  let skipped = 0;
  for (const original of incoming) {
    const fingerprint = ticketFingerprint(original);
    if (fingerprints.has(fingerprint)) {
      skipped += 1;
      continue;
    }
    const ticket = { ...original };
    if (ids.has(ticket.id)) ticket.id = idFactory();
    while (ids.has(ticket.id)) ticket.id = idFactory();
    ids.add(ticket.id);
    fingerprints.add(fingerprint);
    tickets.push(ticket);
    added += 1;
    if (tickets.length > MAX_TICKETS) throw new ValidationError('La copia supera el límite de décimos guardados.');
  }
  return { tickets, added, skipped };
}

function parseCanonicalBackup(payload, options) {
  if (payload.format !== BACKUP_FORMAT || Number(payload.version) !== BACKUP_VERSION) {
    throw new ValidationError('El archivo no es una copia compatible de Lotería.');
  }
  if (payload.currency !== undefined && payload.currency !== 'EUR') {
    throw new ValidationError('La moneda de la copia no es EUR.');
  }
  if (!Array.isArray(payload.tickets) || payload.tickets.length > MAX_TICKETS) {
    throw new ValidationError('La lista de décimos de la copia no es válida.');
  }
  return {
    tickets: payload.tickets.map((ticket) => normalizeTicket(ticket, {
      allowUnknownYear: true,
      allowZeroStake: true,
      nowIso: options.nowIso,
      idFactory: options.idFactory,
    })),
    warnings: [],
  };
}

function parseEntriesBackup(payload, options) {
  if (!Array.isArray(payload.entries) || payload.entries.length > MAX_TICKETS) {
    throw new ValidationError('La lista importada no es válida.');
  }
  return {
    tickets: payload.entries.map((entry) => normalizeTicket({
      ...entry,
      lottery: entry.lottery ?? payload.lottery,
      drawYear: entry.drawYear ?? entry.year ?? payload.drawYear ?? payload.year,
      amount: entry.amount ?? entry.quantity,
      note: entry.note ?? entry.comment,
    }, {
      allowUnknownYear: true,
      allowZeroStake: true,
      nowIso: options.nowIso,
      idFactory: options.idFactory,
    })),
    warnings: [],
  };
}

function parseIosDefaults(payload, options) {
  const source = isPlainObject(payload.userDefaults) ? payload.userDefaults : payload;
  const tickets = [];
  const warnings = [];
  for (const lottery of LOTTERIES) {
    const keys = IOS_KEYS[lottery];
    const numbers = source[keys.numbers];
    if (!Array.isArray(numbers)) continue;
    numbers.forEach((number, index) => {
      try {
        const amount = splitIosEntry(source[keys.stakes], number, '20');
        const note = splitIosEntry(source[keys.notes], number, '');
        tickets.push(normalizeTicket({ lottery, drawYear: null, number, amount, note }, {
          allowUnknownYear: true,
          allowZeroStake: true,
          nowIso: options.nowIso,
          idFactory: options.idFactory,
        }));
      } catch (error) {
        warnings.push(`${lottery} ${index + 1}: ${error.message}`);
      }
    });
  }
  if (!tickets.length && !warnings.length) throw new ValidationError('No se encontraron décimos de iOS en el archivo.');
  return { tickets, warnings };
}

function parseLegacyWebBackup(payload, options) {
  const tickets = [];
  const warnings = [];
  for (const lottery of LOTTERIES) {
    const entries = payload[lottery] ?? payload[LEGACY_WEB_KEYS[lottery]];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      try {
        tickets.push(normalizeTicket({
          ...entry,
          id: undefined,
          lottery,
          drawYear: entry?.drawYear ?? entry?.year ?? null,
          stakeCents: entry?.stakeCents,
          amount: entry?.amount ?? entry?.quantity ?? 20,
          note: entry?.note ?? entry?.comment,
        }, {
          allowUnknownYear: true,
          allowZeroStake: true,
          nowIso: options.nowIso,
          idFactory: options.idFactory,
        }));
      } catch (error) {
        warnings.push(`${lottery} ${index + 1}: ${error.message}`);
      }
    });
  }
  if (!tickets.length && !warnings.length) throw new ValidationError('No se encontraron décimos en la copia antigua.');
  return { tickets, warnings };
}

export function parseBackupPayload(rawPayload, options = {}) {
  let payload = rawPayload;
  if (typeof rawPayload === 'string') {
    if (rawPayload.length > 2_000_000) throw new ValidationError('El archivo supera el límite de 2 MB.');
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      throw new ValidationError('El archivo no contiene JSON válido.');
    }
  }
  if (!isPlainObject(payload)) throw new ValidationError('El archivo no tiene un formato válido.');
  const normalizedOptions = {
    nowIso: options.nowIso || new Date().toISOString(),
    idFactory: options.idFactory || randomId,
  };
  if (payload.format !== undefined || payload.tickets !== undefined) {
    return parseCanonicalBackup(payload, normalizedOptions);
  }
  if (payload.entries !== undefined) return parseEntriesBackup(payload, normalizedOptions);
  if (isPlainObject(payload.userDefaults) || Object.values(IOS_KEYS).some((keys) => payload[keys.numbers] !== undefined)) {
    return parseIosDefaults(payload, normalizedOptions);
  }
  return parseLegacyWebBackup(payload, normalizedOptions);
}

export function createBackup(tickets, options = {}) {
  if (!Array.isArray(tickets) || tickets.length > MAX_TICKETS) {
    throw new ValidationError('No se puede crear la copia de seguridad.');
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: (options.now || new Date()).toISOString(),
    source: options.source || 'web',
    currency: 'EUR',
    tickets: tickets.map((ticket) => normalizeTicket(ticket, {
      allowUnknownYear: true,
      allowZeroStake: true,
    })),
  };
}

export function cacheKey(lottery) {
  return `loteria_api_cache_v1_${normalizeLottery(lottery)}`;
}

export function writeApiCache(storage, bundle) {
  try {
    storage.setItem(cacheKey(bundle.lottery), JSON.stringify(bundle));
    return true;
  } catch {
    return false;
  }
}

export function readApiCache(storage, lottery) {
  try {
    const parsed = safeParse(storage.getItem(cacheKey(lottery)));
    if (!isPlainObject(parsed)) return null;
    const normalizedLottery = normalizeLottery(lottery);
    if (parsed.lottery !== normalizedLottery) return null;
    const drawYear = normalizeDrawYear(parsed.drawYear);
    const status = Number(parsed.status);
    if (!Number.isInteger(status) || status < 0 || status > 4 || !isPlainObject(parsed.prizes) || !Array.isArray(parsed.summary)) return null;
    const prizes = Object.create(null);
    for (const [number, cents] of Object.entries(parsed.prizes)) {
      const canonical = normalizeNumber(number);
      if (!Number.isSafeInteger(cents) || cents <= 0) return null;
      prizes[canonical] = cents;
    }
    const expectedSummary = summaryShape(normalizedLottery);
    if (parsed.summary.length !== expectedSummary.length) return null;
    const summary = parsed.summary.map((item, index) => {
      const expected = expectedSummary[index];
      if (
        !isPlainObject(item)
        || item.key !== expected.key
        || item.digits !== expected.digits
        || !Number.isInteger(item.value)
        || item.value < -1
        || item.value >= (10 ** item.digits)
      ) {
        throw new ValidationError('El resumen guardado no es válido.');
      }
      return { key: item.key, digits: item.digits, value: item.value };
    });
    if (status === 0 && summary.some((item) => item.value !== -1)) return null;
    if (status >= 2 && summary.some((item) => item.value === -1)) return null;
    const fullNumberPrizes = normalizedLottery === 'navidad' ? summary : summary.slice(0, 3);
    if (fullNumberPrizes.some((item) => item.value !== -1 && prizes[String(item.value).padStart(5, '0')] === undefined)) return null;
    return {
      lottery: normalizedLottery,
      drawYear,
      status,
      prizes,
      summary,
      source: 'cache',
      receivedAt: asIsoDate(parsed.receivedAt, new Date(0).toISOString()),
    };
  } catch {
    return null;
  }
}
