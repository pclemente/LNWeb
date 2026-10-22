import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_BACKUP_BYTES,
  PersistenceError,
  STORAGE_KEYS,
  TicketRepository,
  ValidationError,
  createBackup,
  evaluateTicket,
  expectedDrawYear,
  formatEuro,
  mergeTickets,
  parseBackupPayload,
  parseEuroToCents,
  readApiCache,
  resolveDrawAvailability,
  validateApiBundle,
  validateCurrentStatus,
  writeApiCache,
} from '../app-core.js';

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.failOn = null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failOn === key) throw new Error('quota exceeded');
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

const fixedNow = new Date('2026-09-15T10:00:00.000Z');

function idFactory() {
  let next = 0;
  return () => `id-${++next}`;
}

function summaryFor(lottery, overrides = {}) {
  if (lottery === 'navidad') {
    return {
      timestamp: 1797930000,
      status: 4,
      year: 2026,
      error: 0,
      ...Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`numero${index + 1}`, 123 + index])),
      ...overrides,
    };
  }
  return {
    timestamp: 1767777412,
    status: 4,
    year: 2026,
    error: 0,
    Primer_premio: 6703,
    Segundo_Premio: 45875,
    Tercer_Premio: 32615,
    ...Object.fromEntries(Array.from({ length: 2 }, (_, index) => [`Extraccion_4_cifras_${index + 1}`, index])),
    ...Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`Extraccion_3_cifras_${index + 1}`, index])),
    ...Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`Extraccion_2_cifras_${index + 1}`, index])),
    ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`Reintegro_${index + 1}`, index])),
    ...overrides,
  };
}

function bundleInput(lottery = 'navidad', overrides = {}) {
  const status = overrides.statusCode ?? 4;
  const drawYear = overrides.drawYear ?? 2026;
  const defaultNumbers = lottery === 'navidad'
    ? Object.fromEntries(Array.from({ length: 13 }, (_, index) => [String(123 + index), String(index === 0 ? 4_000_000 : 60_000)]))
    : { '06703': '2000000', '45875': '750000', '32615': '250000' };
  return {
    numbers: {
      status: String(status), year: String(drawYear), ...defaultNumbers, '42': '200', ...(overrides.numbers || {}),
    },
    summary: summaryFor(lottery, { status, year: drawYear, ...(overrides.summary || {}) }),
    status: { status, year: drawYear, error: 0, ...(overrides.status || {}) },
  };
}

function currentStatusInput(lottery = 'navidad', overrides = {}) {
  const drawYear = overrides.year ?? (lottery === 'navidad' ? 2026 : 2027);
  return {
    year: drawYear,
    status: 0,
    state: 'not_started',
    message: 'El sorteo aún no ha comenzado.',
    drawDate: lottery === 'navidad'
      ? `${drawYear}-12-22T09:00:00+01:00`
      : `${drawYear}-01-06T12:00:00+01:00`,
    timezone: 'Europe/Madrid',
    error: 0,
    ...overrides,
  };
}

test('euro amounts are parsed exactly into cents', () => {
  assert.equal(parseEuroToCents('20,50'), 2050);
  assert.equal(parseEuroToCents('0.01'), 1);
  assert.equal(formatEuro(2050), '20,50 €');
  assert.throws(() => parseEuroToCents('20,005'), ValidationError);
  assert.throws(() => parseEuroToCents('0'), ValidationError);
  assert.throws(() => parseEuroToCents('1e3'), ValidationError);
});

test('default years follow the Spanish lottery season without hiding a just-finished draw', () => {
  assert.equal(expectedDrawYear('navidad', new Date('2026-12-30T12:00:00Z')), 2026);
  assert.equal(expectedDrawYear('navidad', new Date('2027-01-01T12:00:00Z')), 2027);
  assert.equal(expectedDrawYear('nino', new Date('2026-01-31T22:30:00Z')), 2026);
  assert.equal(expectedDrawYear('nino', new Date('2026-02-01T12:00:00Z')), 2027);
});

test('legacy web records migrate without deleting source values or inventing a year', () => {
  const legacy = JSON.stringify([
    { id: 'old', number: '7', quantity: '20,50', comment: '<img src=x onerror=alert(1)>' },
  ]);
  const storage = new MemoryStorage({ loteria_saved_navidad: legacy });
  const repository = new TicketRepository(storage, { now: () => fixedNow, idFactory: idFactory() });
  const document = repository.load();

  assert.equal(document.tickets.length, 1);
  assert.deepEqual(document.tickets[0], {
    id: 'id-1',
    lottery: 'navidad',
    drawYear: null,
    number: '00007',
    stakeCents: 2050,
    note: '<img src=x onerror=alert(1)>',
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  });
  assert.equal(storage.getItem('loteria_saved_navidad'), legacy);
  assert.ok(storage.getItem(STORAGE_KEYS.primary));
});

test('old iOS parallel arrays preserve decimal stakes and notes containing hyphens', () => {
  const imported = parseBackupPayload({
    userDefaults: {
      numberArrayStored: ['7'],
      quantityArrayStored: ['7-12,35'],
      commentsArrayStored: ['7-participación-oficina'],
      numberArrayStoredNiño: ['00000'],
    },
  }, { nowIso: fixedNow.toISOString(), idFactory: idFactory() });

  assert.equal(imported.tickets.length, 2);
  assert.deepEqual(imported.tickets[0], {
    id: 'id-1',
    lottery: 'navidad',
    drawYear: null,
    number: '00007',
    stakeCents: 1235,
    note: 'participación-oficina',
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  });
  assert.equal(imported.tickets[1].lottery, 'nino');
  assert.equal(imported.tickets[1].stakeCents, 2000);
});

test('canonical import is strict and merges idempotently without overwriting differences', () => {
  const storage = new MemoryStorage();
  const repository = new TicketRepository(storage, { now: () => fixedNow, idFactory: idFactory() });
  repository.load();
  const backup = {
    format: 'loteria-ticket-backup',
    version: 1,
    exportedAt: fixedNow.toISOString(),
    source: 'ios',
    currency: 'EUR',
    tickets: [{ lottery: 'navidad', drawYear: 2026, number: '00001', stakeCents: 1001, note: 'A' }],
  };
  const first = repository.import(backup);
  const second = repository.import(backup);
  const different = repository.import({
    ...backup,
    tickets: [{ lottery: 'navidad', drawYear: 2026, number: '00001', stakeCents: 1001, note: 'B' }],
  });

  assert.deepEqual([first.added, second.added, second.skipped, different.added], [1, 0, 1, 1]);
  assert.equal(different.document.tickets.length, 2);
  assert.throws(() => repository.import({ ...backup, tickets: [{ ...backup.tickets[0], number: '100000' }] }), ValidationError);
  assert.equal(repository.snapshot().tickets.length, 2);
});

test('backup restore preserves the multiplicity of identical tickets and stays idempotent', () => {
  const storage = new MemoryStorage();
  const repository = new TicketRepository(storage, { now: () => fixedNow, idFactory: idFactory() });
  repository.load();
  const common = {
    lottery: 'navidad', drawYear: 2026, number: '12345', stakeCents: 2000, note: 'compartido',
  };
  const backup = {
    format: 'loteria-ticket-backup',
    version: 1,
    currency: 'EUR',
    tickets: [{ ...common, id: 'ticket-a' }, { ...common, id: 'ticket-b' }],
  };

  const first = repository.import(backup);
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 0);
  assert.equal(first.document.tickets.length, 2);
  assert.deepEqual(new Set(first.document.tickets.map((ticket) => ticket.id)), new Set(['ticket-a', 'ticket-b']));

  const second = repository.import(backup);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.document.tickets.length, 2);
});

test('backup merge keeps the greater existing or imported count for each fingerprint', () => {
  const make = (id, note) => ({
    id, lottery: 'navidad', drawYear: 2026, number: '12345', stakeCents: 2000, note,
    createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString(),
  });
  const { tickets, added, skipped } = mergeTickets(
    [make('existing-a', 'same')],
    [make('import-a', 'same'), make('import-b', 'same'), make('existing-a', 'different')],
    idFactory(),
  );
  assert.deepEqual({ added, skipped }, { added: 2, skipped: 1 });
  assert.equal(tickets.filter((ticket) => ticket.note === 'same').length, 2);
  assert.equal(tickets.filter((ticket) => ticket.note === 'different').length, 1);
  assert.equal(new Set(tickets.map((ticket) => ticket.id)).size, 3);
});

test('valid backups larger than the former 2 MB cap import within the 10 MB bound', () => {
  const payload = JSON.stringify({
    format: 'loteria-ticket-backup',
    version: 1,
    currency: 'EUR',
    tickets: Array.from({ length: 430 }, (_, index) => ({
      lottery: 'navidad',
      drawYear: 2026,
      number: String(index),
      stakeCents: 2000,
      note: `${index}-${'x'.repeat(4_900)}`,
    })),
  });
  const bytes = new TextEncoder().encode(payload).byteLength;
  assert.ok(bytes > 2_000_000);
  assert.ok(bytes < MAX_BACKUP_BYTES);
  assert.equal(parseBackupPayload(payload, { nowIso: fixedNow.toISOString() }).tickets.length, 430);
});

test('migration preserves zero stakes and long notes but new saves require a positive stake', () => {
  const storage = new MemoryStorage();
  const repository = new TicketRepository(storage, { now: () => fixedNow, idFactory: idFactory() });
  repository.load();
  const longNote = 'a'.repeat(1_000);
  const result = repository.import({
    format: 'loteria-ticket-backup',
    version: 1,
    currency: 'EUR',
    tickets: [{ lottery: 'nino', drawYear: 2026, number: '7', stakeCents: 0, note: longNote }],
  });
  assert.equal(result.added, 1);
  assert.equal(result.document.tickets[0].stakeCents, 0);
  assert.equal(result.document.tickets[0].note, longNote);
  assert.equal(evaluateTicket(result.document.tickets[0], null).kind, 'needs-review');
  assert.equal(new TicketRepository(storage).load().tickets[0].note, longNote);
  assert.throws(() => repository.create({
    lottery: 'nino', drawYear: 2026, number: '8', stakeCents: 0, note: '',
  }), ValidationError);
  assert.throws(() => parseBackupPayload({
    format: 'loteria-ticket-backup', version: 1, currency: 'EUR',
    tickets: [{ lottery: 'nino', drawYear: 2026, number: '9', stakeCents: 1, note: 'x'.repeat(5_001) }],
  }), ValidationError);
});

test('a failed staged write leaves the in-memory document unchanged and is recoverable', () => {
  const storage = new MemoryStorage();
  const repository = new TicketRepository(storage, { now: () => fixedNow, idFactory: idFactory() });
  repository.load();
  repository.create({ lottery: 'navidad', drawYear: 2026, number: '1', stakeCents: 2000, note: '' });
  const before = repository.snapshot();
  storage.failOn = STORAGE_KEYS.staging;

  assert.throws(() => repository.create({ lottery: 'navidad', drawYear: 2026, number: '2', stakeCents: 2000, note: '' }), PersistenceError);
  assert.deepEqual(repository.snapshot(), before);
  storage.failOn = null;
  const reloaded = new TicketRepository(storage).load();
  assert.equal(reloaded.tickets.length, 1);
  assert.equal(reloaded.tickets[0].number, '00001');
});

test('the newest valid staging or backup copy recovers a damaged primary record', () => {
  const oldDocument = {
    version: 2,
    revision: 2,
    updatedAt: fixedNow.toISOString(),
    tickets: [{
      id: 'old', lottery: 'navidad', drawYear: 2025, number: '00001', stakeCents: 2000,
      note: '', createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString(),
    }],
  };
  const newDocument = { ...oldDocument, revision: 3, tickets: [{ ...oldDocument.tickets[0], number: '00002' }] };
  const storage = new MemoryStorage({
    [STORAGE_KEYS.primary]: '{bad json',
    [STORAGE_KEYS.backup]: JSON.stringify(oldDocument),
    [STORAGE_KEYS.staging]: JSON.stringify(newDocument),
  });
  const loaded = new TicketRepository(storage).load();
  assert.equal(loaded.revision, 3);
  assert.equal(loaded.tickets[0].number, '00002');
});

test('an unrecoverable local document is quarantined before a new one can replace it', () => {
  const storage = new MemoryStorage({ [STORAGE_KEYS.primary]: '{damaged' });
  const repository = new TicketRepository(storage, { now: () => fixedNow });
  const document = repository.load();
  assert.equal(document.tickets.length, 0);
  const quarantine = JSON.parse(storage.getItem(STORAGE_KEYS.quarantine));
  assert.equal(quarantine.values[STORAGE_KEYS.primary], '{damaged');
  assert.match(repository.warnings[0], /conservó/);
});

test('API validation accepts matching year metadata and canonicalizes unpadded number keys', () => {
  const bundle = validateApiBundle('navidad', bundleInput(), {
    source: 'network', receivedAt: fixedNow.toISOString(),
  });
  assert.equal(bundle.drawYear, 2026);
  assert.equal(bundle.prizes['00042'], 2000);
  assert.equal(bundle.prizes['00123'], 40_000_000);
  assert.equal(Object.hasOwn(bundle.prizes, '02026'), false);
  assert.throws(() => validateApiBundle('navidad', bundleInput('navidad', {
    status: { status: 1 },
  })), /misma actualización/);
});

test('API validation preserves legacy payloads but rejects partial or conflicting year metadata', () => {
  const legacy = bundleInput();
  delete legacy.numbers.year;
  delete legacy.summary.year;
  delete legacy.status.year;
  assert.equal(validateApiBundle('navidad', legacy).drawYear, 2026);

  const partial = bundleInput();
  delete partial.status.year;
  assert.throws(() => validateApiBundle('navidad', partial), /mismo año/);
  assert.throws(() => validateApiBundle('navidad', bundleInput('navidad', {
    numbers: { year: '2027' },
  })), /no corresponde a la fecha/);
  assert.throws(() => validateApiBundle('navidad', bundleInput('navidad', {
    summary: { year: 2027 },
  })), /no corresponde a la fecha/);
});

test('current status validation requires the published year, date, timezone, and error contract', () => {
  const status = validateCurrentStatus('navidad', currentStatusInput(), {
    receivedAt: fixedNow.toISOString(),
  });
  assert.equal(status.drawYear, 2026);
  assert.equal(status.status, 0);
  assert.equal(status.message, 'El sorteo aún no ha comenzado.');
  const ninoStatus = validateCurrentStatus('nino', currentStatusInput('nino'));
  assert.equal(ninoStatus.drawYear, 2027);
  assert.equal(evaluateTicket({
    id: 'nino-2027', lottery: 'nino', drawYear: 2027, number: '00001', stakeCents: 2000,
    note: '', createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString(),
  }, null, { currentStatus: ninoStatus, now: fixedNow }).kind, 'pending');
  assert.throws(() => validateCurrentStatus('navidad', currentStatusInput('navidad', {
    error: 1,
  })), /error del servidor/);
  assert.throws(() => validateCurrentStatus('navidad', currentStatusInput('navidad', {
    drawDate: '2026-12-23T09:00:00+01:00',
  })), /no corresponde/);
  assert.throws(() => validateCurrentStatus('nino', currentStatusInput('nino', {
    timezone: 'UTC',
  })), /zona horaria/);
});

test('current not-started status keeps its year pending without hiding historical or published results', () => {
  const currentStatus = validateCurrentStatus('navidad', currentStatusInput(), {
    receivedAt: fixedNow.toISOString(),
  });
  const historical = validateApiBundle('navidad', bundleInput('navidad', {
    drawYear: 2025,
    summary: { timestamp: 1766414850 },
  }), { receivedAt: fixedNow.toISOString() });
  const historicalTicket = {
    id: 'historical', lottery: 'navidad', drawYear: 2025, number: '00099', stakeCents: 2000,
    note: '', createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString(),
  };
  const currentTicket = { ...historicalTicket, id: 'current', drawYear: 2026 };

  assert.equal(evaluateTicket(historicalTicket, historical, {
    currentStatus, now: fixedNow,
  }).kind, 'not-winner');
  const pending = evaluateTicket(currentTicket, historical, { currentStatus, now: fixedNow });
  assert.equal(pending.kind, 'pending');
  assert.match(pending.message, /aún no ha comenzado/);

  const afterDraw = new Date('2026-12-22T08:00:01.000Z');
  assert.equal(evaluateTicket(currentTicket, historical, {
    currentStatus, now: afterDraw,
  }).kind, 'unavailable');

  const published = validateApiBundle('navidad', bundleInput(), {
    receivedAt: fixedNow.toISOString(),
  });
  assert.equal(evaluateTicket({ ...currentTicket, number: '00042' }, published, {
    currentStatus, now: fixedNow,
  }).kind, 'winner');
});

test('an old current-status response cannot describe a different draw as not started', () => {
  const oldStatus = validateCurrentStatus('navidad', currentStatusInput('navidad', {
    year: 2025,
    drawDate: '2025-12-22T09:00:00+01:00',
  }));
  const availability = resolveDrawAvailability('navidad', 2026, null, oldStatus, {
    now: fixedNow,
  });
  assert.equal(availability.kind, 'unavailable');
});

test('API validation rejects a summary winner missing from the detailed list', () => {
  const inconsistent = bundleInput('nino');
  delete inconsistent.numbers['06703'];
  assert.throws(() => validateApiBundle('nino', inconsistent), /06703.*falta/);
});

test('API validation rejects an empty final list even if its summary looks valid', () => {
  const empty = bundleInput('navidad');
  empty.numbers = { status: '4', year: '2026' };
  assert.throws(() => validateApiBundle('navidad', empty), /aparece en el resumen.*falta/);
});

test('API validation does not coerce booleans or empty strings into valid values', () => {
  assert.throws(() => validateApiBundle('navidad', bundleInput('navidad', {
    status: { status: '' },
  })), /estado desconocido/);
  assert.throws(() => validateApiBundle('navidad', bundleInput('navidad', {
    summary: { numero1: false },
  })), /valor inválido/);
  assert.throws(() => validateApiBundle('navidad', bundleInput('navidad', {
    numbers: { 123: true },
  })), /premio inválido/);
});

test('results distinguish year mismatch, live pending, provisional, unavailable, and final loss', () => {
  const baseTicket = {
    id: 'a', lottery: 'navidad', drawYear: 2026, number: '00099', stakeCents: 2050,
    note: '', createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString(),
  };
  const finished = validateApiBundle('navidad', bundleInput(), { receivedAt: fixedNow.toISOString() });
  assert.equal(evaluateTicket(baseTicket, null).kind, 'unavailable');
  assert.equal(evaluateTicket({ ...baseTicket, drawYear: 2025 }, finished).kind, 'unavailable');
  assert.equal(evaluateTicket(baseTicket, finished).kind, 'not-winner');

  const winner = evaluateTicket({ ...baseTicket, number: '00042' }, finished);
  assert.equal(winner.kind, 'winner');
  assert.equal(winner.prize.estimatedPrizeCents, 2050);

  const live = validateApiBundle('navidad', bundleInput('navidad', { statusCode: 1 }), { receivedAt: fixedNow.toISOString() });
  assert.equal(evaluateTicket(baseTicket, live, { now: fixedNow }).kind, 'pending');
  const staleLive = { ...live, source: 'cache', receivedAt: '2026-09-15T09:00:00.000Z' };
  assert.equal(evaluateTicket(baseTicket, staleLive, { now: fixedNow }).kind, 'unavailable');
  assert.equal(evaluateTicket({ ...baseTicket, number: '00042' }, staleLive, { now: fixedNow }).kind, 'unavailable');
  const pendingSummary = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`numero${index + 1}`, -1]));
  const notStarted = validateApiBundle('navidad', bundleInput('navidad', {
    statusCode: 0,
    summary: pendingSummary,
  }), { receivedAt: fixedNow.toISOString() });
  assert.equal(evaluateTicket({ ...baseTicket, number: '00042' }, notStarted).kind, 'pending');
  const provisional = validateApiBundle('navidad', bundleInput('navidad', { statusCode: 2 }), { receivedAt: fixedNow.toISOString() });
  assert.equal(evaluateTicket(baseTicket, provisional).kind, 'provisional-none');
});

test('validated API data survives network failure through the local cache', () => {
  const storage = new MemoryStorage();
  const bundle = validateApiBundle('nino', bundleInput('nino'), {
    receivedAt: fixedNow.toISOString(), source: 'network',
  });
  assert.equal(writeApiCache(storage, bundle), true);
  const cached = readApiCache(storage, 'nino');
  assert.equal(cached.source, 'cache');
  assert.equal(cached.drawYear, 2026);
  assert.equal(cached.summary.at(-1).value, 2);
});

test('an inconsistent cached final list is never used', () => {
  const storage = new MemoryStorage();
  const bundle = validateApiBundle('nino', bundleInput('nino'), {
    receivedAt: fixedNow.toISOString(), source: 'network',
  });
  delete bundle.prizes['06703'];
  storage.setItem('loteria_api_cache_v1_nino', JSON.stringify(bundle));
  assert.equal(readApiCache(storage, 'nino'), null);
});

test('backup roundtrip preserves all user fields including an unresolved legacy year', () => {
  const tickets = [
    {
      id: 'legacy', lottery: 'nino', drawYear: null, number: '00000', stakeCents: 1,
      note: 'céntimo', createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString(),
    },
  ];
  const backup = createBackup(tickets, { now: fixedNow });
  const imported = parseBackupPayload(JSON.stringify(backup), { nowIso: fixedNow.toISOString() });
  assert.deepEqual(imported.tickets, tickets);
});
