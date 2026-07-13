'use strict';

const MONITORS_KEY = 'openStill.monitors.v2';
const SETTINGS_KEY = 'openStill.settings.v1';
const PENDING_PICKERS_KEY = 'openStill.pending-pickers.v1';
const LIVE_CONTROLLED_TABS_KEY = 'openStill.live-controlled-tabs.v1';
const ALARM_NAME = 'openStill.next-check';

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 14 * 24;
// The local reference scheduler accepts five-second schedules. Chrome alarms
// cannot reliably wake an MV3 worker that often, so short schedules use an
// in-worker precision timer plus a durable alarm fallback (see
// scheduleNextAlarm).
const MIN_SCHEDULE_SECONDS = 5;
const MIN_CHROME_ALARM_DELAY_MS = 30_000;
// The reference scheduler treats a 30-day-or-longer duration as an
// intentionally unscheduled (effectively infinite) interval.  Keep that
// value representable for imports, but never arm an alarm for it.
const INFINITE_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
const MAX_SCHEDULE_SECONDS = INFINITE_SCHEDULE_SECONDS;
const SCHEDULE_MODE_MANUAL = 'manual';
const SCHEDULE_MODE_INTERVAL = 'interval';
const SCHEDULE_MODE_RANDOM = 'random';
const SCHEDULE_MODE_CRON = 'cron';
const SCHEDULE_MODE_LIVE = 'live';
const SCHEDULE_MODES = new Set([
  SCHEDULE_MODE_MANUAL,
  SCHEDULE_MODE_INTERVAL,
  SCHEDULE_MODE_RANDOM,
  SCHEDULE_MODE_CRON,
  SCHEDULE_MODE_LIVE
]);
// unlimitedStorage prevents a few large snapshots from blocking a legitimate
// import of hundreds of user-configured trackers.
const MAX_MONITORS = 1_000;
const MAX_SELECTORS_PER_MONITOR = 20;
const MAX_COLLECTION_ITEMS = 10_000;
// Storage is explicitly unlimited. Keep the canonical comparison payload much
// larger than the dashboard preview so a change after the first few cards is
// not silently invisible. Presentation code is responsible for clipping what
// it renders, never the comparison engine.
const MAX_SNAPSHOT_CHARS = 1_000_000;
const MAX_CHANGE_HISTORY = 20;
const MAX_RUN_HISTORY = 40;
const PARSE_TIMEOUT_MS = 12_000;
const SOUND_DEBOUNCE_MS = 3_000;
const MAX_CHECKS_PER_SWEEP = 6;
const MAX_BATCH_CHECKS = 1_000;
const MAX_CONCURRENT_BATCH_CHECKS = 3;
const PENDING_PICKER_TTL_MS = 2 * 60 * 60 * 1000;
const RENDER_LOAD_TIMEOUT_MS = 30_000;
// Picker interaction deliberately waits for a settled page. Scheduled capture
// follows the Reference runner's DOMContentLoaded + fixed two-second gate,
// then applies the monitor's explicit delay.
const PICKER_READY_DELAY_MS = 2_500;
const CHECK_EXECUTION_TIMEOUT_MS = 60_000;
const MIN_CHECK_EXECUTION_TIMEOUT_MS = 10_000;
const MAX_CHECK_EXECUTION_TIMEOUT_MS = 300_000;
// Match the reference runner's empty-selection behavior: after the initial
// rendered capture it retries every five seconds through retryCount 5.
const RENDER_EMPTY_RETRY_COUNT = 4;
const RENDER_EMPTY_RETRY_DELAY_MS = 5_000;

const DEFAULT_SETTINGS = Object.freeze({ soundEnabled: true });
const VALID_STATUSES = new Set([
  'ok',
  'changed',
  'needs-review',
  'error',
  'permission-needed',
  'needs-baseline'
]);
const LOCATOR_TYPES = new Set(['css', 'xcss', 'xpath']);
const LOCATOR_OPERATIONS = new Set(['include', 'exclude']);
const LOCATOR_FIELD_TYPES = new Set(['text', 'attribute', 'property']);

const ELEMENT_NOT_FOUND_MESSAGE = '선택한 요소를 찾지 못했습니다. 로그인 상태나 페이지 구성, CSS 선택자를 확인해 주세요.';

let storageQueue = Promise.resolve();
let offscreenCreation;
let sweepRunning = false;
let lastSoundAt = 0;
const checksInProgress = new Set();
let alarmQueue = Promise.resolve();
let precisionScheduleTimer = null;
// Service-worker memory only tracks active page observer installations. The
// durable monitor configuration remains in storage and is restored on startup.
const liveSessions = new Map();
const liveDirtyByMonitor = new Map();
let liveOwnershipQueue = Promise.resolve();

function cleanText(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// Snapshot text has a different job from labels and error messages: line boundaries
// give the change view enough structure to show a newly inserted list item without
// highlighting every item that merely shifted down.
function cleanSnapshotText(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function cleanSnapshotHtml(value, maxLength = MAX_SNAPSHOT_CHARS) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, maxLength);
}

// A compact deterministic fingerprint lets the monitor detect a change beyond
// the stored dashboard preview cap without silently treating two truncated
// payloads as equal. It is not used as a security primitive.
function snapshotFingerprint(value) {
  const text = String(value ?? '');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${text.length.toString(36)}:${first.toString(36)}:${second.toString(36)}`;
}

// The reference comparison does not use literal-string equality when the
// user elects to keep whitespace significant. It separates words and runs of
// whitespace, which preserves punctuation and word boundaries while avoiding
// noisy line-wrap differences from independently rendered pages.
function comparisonTokens(value) {
  return String(value ?? '').split(/\s+|\b/g);
}

function comparisonTokenFingerprint(value) {
  // NUL cannot survive cleanSnapshotHtml and makes an unambiguous separator
  // for the otherwise variable-width tokens.
  return snapshotFingerprint(comparisonTokens(value).join('\u0000'));
}

function comparisonTokensEqual(left, right) {
  const leftTokens = comparisonTokens(left);
  const rightTokens = comparisonTokens(right);
  return leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => token === rightTokens[index]);
}

function cleanShortText(value, maxLength = 180) {
  return cleanText(value, maxLength);
}

function cleanLabels(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  const labels = [];
  const seen = new Set();

  for (const item of values) {
    const label = cleanText(item, 48);
    const key = label.toLocaleLowerCase('ko-KR');
    if (label && !seen.has(key) && labels.length < 20) {
      labels.push(label);
      seen.add(key);
    }
  }

  return labels;
}

function asIso(value, fallback = null) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function addHours(iso, hours) {
  const from = Date.parse(iso ?? '') || Date.now();
  return new Date(from + hours * 60 * 60 * 1000).toISOString();
}

function clampInterval(value) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_HOURS || parsed > MAX_INTERVAL_HOURS) {
    return null;
  }
  return parsed;
}

function normalizeScheduleMode(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  // Reference exports use AUTO for a no-op/unscheduled webpage descriptor.
  // OpenStill has no background crawler mode, so retain it as manual rather
  // than dropping the imported HTML monitor or inventing an interval.
  if (mode === 'auto') return SCHEDULE_MODE_MANUAL;
  return SCHEDULE_MODES.has(mode) ? mode : null;
}

function scheduleSeconds(value) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) && parsed >= MIN_SCHEDULE_SECONDS && parsed <= MAX_SCHEDULE_SECONDS
    ? parsed
    : null;
}

function parseScheduleObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cronNumber(value, names, minimum, maximum) {
  const text = String(value ?? '').trim().toUpperCase();
  const named = names?.[text];
  const numeric = named ?? (/^\d+$/.test(text) ? Number(text) : Number.NaN);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : null;
}

function parseCronField(value, minimum, maximum, names = null) {
  const source = String(value ?? '').trim();
  if (!source) throw new Error('A cron field is empty.');
  const all = new Set();
  for (let number = minimum; number <= maximum; number += 1) all.add(number);
  // The bundled Reference cron parser is deliberately a five-field dialect:
  // it accepts `*`, ranges, lists, and steps, but not Quartz's `?` marker.
  // Rejecting it here keeps an imported expression from silently changing its
  // DOM/DOW matching semantics.
  if (source === '?') throw new Error('Question-mark cron fields are not supported.');
  if (source === '*') return { values: all, wildcard: true };

  const values = new Set();
  let wildcard = false;
  for (const segment of source.split(',')) {
    const match = segment.trim().match(/^(.+?)(?:\/(\d+))?$/);
    if (!match) throw new Error('Invalid cron field.');
    const range = match[1];
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step <= 0 || step > maximum - minimum + 1) throw new Error('Invalid cron step.');
    let start;
    let end;
    if (range === '?') throw new Error('Question-mark cron fields are not supported.');
    if (range === '*') {
      // Distill's cron parser records a star when any list segment is based
      // on `*`, including `*/n`; that changes DOM/DOW from OR to its wildcard
      // branch. Preserve that less-obvious compatibility rule.
      wildcard = true;
      start = minimum;
      end = maximum;
    } else if (range.includes('-')) {
      const [from, to, ...extra] = range.split('-');
      if (extra.length) throw new Error('Invalid cron range.');
      start = cronNumber(from, names, minimum, maximum);
      end = cronNumber(to, names, minimum, maximum);
      if (start === null || end === null || start > end) throw new Error('Invalid cron range.');
    } else {
      start = cronNumber(range, names, minimum, maximum);
      if (start === null) throw new Error('Invalid cron value.');
      // Cron's scalar-step form (`5/15`, `MON/2`) is a stepped range from
      // that scalar through the field maximum, not a one-value expression.
      // This is distinct from a bare scalar, which remains exact.
      end = match[2] === undefined ? start : maximum;
    }
    for (let number = start; number <= end; number += step) values.add(number);
  }
  if (!values.size) throw new Error('A cron field has no values.');
  return { values, wildcard };
}

function parseCronExpression(value) {
  const fields = String(value ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron requires five fields: minute hour day month weekday.');
  const months = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const weekdays = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dayOfMonth: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12, months),
    // The reference parser uses Sunday=0 through Saturday=6. It intentionally
    // does not treat `7` as an alias for Sunday.
    dayOfWeek: parseCronField(fields[4], 0, 6, weekdays)
  };
}

function cronDateParts(timestamp, formatter) {
  const values = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    dayOfMonth: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    dayOfWeek: weekdays[values.weekday]
  };
}

function normalizeCronTimezone(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[+-]?\d{1,4}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  // Distill's persisted CRON schedule stores Date#getTimezoneOffset(), for
  // example -540 for Korea.  Accept that wire format as well as an IANA zone
  // name for newly created monitors.
  if (Number.isInteger(numeric)) {
    return numeric >= -14 * 60 && numeric <= 14 * 60 ? numeric : undefined;
  }
  const timezone = String(value).trim();
  if (!timezone || timezone.length > 80) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return undefined;
  }
}

function cronDatePartsForTimezone(timestamp, timezone, formatter) {
  if (Number.isInteger(timezone)) {
    // getTimezoneOffset() is UTC minus local time.  Shift into that local
    // wall-clock time, then read UTC fields to avoid the machine timezone.
    const local = new Date(timestamp - timezone * 60_000);
    return {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      dayOfMonth: local.getUTCDate(),
      hour: local.getUTCHours(),
      minute: local.getUTCMinutes(),
      dayOfWeek: local.getUTCDay()
    };
  }
  return cronDateParts(timestamp, formatter);
}

function sortedCronValues(field) {
  return [...field.values].sort((left, right) => left - right);
}

// The Reference cron dialect uses JavaScript Date construction for its logical
// month/day candidates. As a result, a syntactically valid but calendar-invalid
// value such as `31 FEB` rolls into March. Calculate those overflow candidates
// separately from the efficient real-calendar scan, then choose whichever is
// earlier. This matters even when a normal candidate exists: `28-31 * *` after
// November 30 reaches logical November 31 (December 1) before December 28.
function nextRolledCalendarCronOccurrence(fields, timezone, afterTimestamp, deadline, formatter) {
  // Reference persistence uses a numeric Date#getTimezoneOffset. Preserve its
  // Date rollover behavior exactly for that format. IANA zones are an OpenStill
  // extension; their DST wall-time conversion is left to the regular scan.
  if (typeof timezone === 'string') return null;

  const afterParts = cronDatePartsForTimezone(afterTimestamp, timezone, formatter);
  if (!Number.isInteger(afterParts.year)) return null;
  const months = sortedCronValues(fields.month);
  const days = sortedCronValues(fields.dayOfMonth);
  const hours = sortedCronValues(fields.hour);
  const minutes = sortedCronValues(fields.minute);
  const cutoff = Number(afterTimestamp);
  let next = Number.POSITIVE_INFINITY;

  // Include the preceding logical year because DEC 32 can roll into the first
  // days of the current year. The absolute deadline retains the normal two-year
  // search bound and prevents malformed imports from causing unbounded work.
  for (let year = afterParts.year - 1; year <= afterParts.year + 2; year += 1) {
    for (const month of months) {
      for (const day of days) {
        const wallMidnight = new Date(Number.isInteger(timezone)
          ? Date.UTC(year, month - 1, day)
          : new Date(year, month - 1, day).valueOf());
        const rolledYear = Number.isInteger(timezone) ? wallMidnight.getUTCFullYear() : wallMidnight.getFullYear();
        const rolledMonth = (Number.isInteger(timezone) ? wallMidnight.getUTCMonth() : wallMidnight.getMonth()) + 1;
        const rolledDay = Number.isInteger(timezone) ? wallMidnight.getUTCDate() : wallMidnight.getDate();
        if (rolledYear === year && rolledMonth === month && rolledDay === day) continue;
        const dayOfWeek = Number.isInteger(timezone) ? wallMidnight.getUTCDay() : wallMidnight.getDay();
        // With a star-based DOM or DOW segment, the reference requires both
        // logical DOM and the rolled calendar weekday. Otherwise a selected DOM
        // candidate is one of the ordinary DOM-or-DOW routes.
        if ((fields.dayOfMonth.wildcard || fields.dayOfWeek.wildcard)
          && !fields.dayOfWeek.values.has(dayOfWeek)) continue;

        for (const hour of hours) {
          for (const minute of minutes) {
            const candidate = Number.isInteger(timezone)
              ? Date.UTC(year, month - 1, day, hour, minute) + timezone * 60_000
              : new Date(year, month - 1, day, hour, minute).valueOf();
            if (candidate > cutoff && candidate <= deadline && candidate < next) next = candidate;
          }
        }
      }
    }
  }
  return Number.isFinite(next) ? next : null;
}

function nextCronOccurrence(expression, timezone, afterTimestamp = Date.now()) {
  const fields = parseCronExpression(expression);
  const normalizedTimezone = normalizeCronTimezone(timezone);
  if (normalizedTimezone === undefined) throw new Error('Invalid cron timezone.');
  // Constructing one formatter validates IANA names before the minute search
  // and avoids allocating hundreds of thousands of formatters for a sparse
  // monthly expression. Fixed UTC offsets intentionally use UTC accessors.
  const formatter = Number.isInteger(normalizedTimezone) ? null : new Intl.DateTimeFormat('en-US', {
    ...(normalizedTimezone ? { timeZone: normalizedTimezone } : {}),
    year: 'numeric',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  });
  let after = Number(afterTimestamp);
  if (!Number.isFinite(after)) after = Date.now();
  // Preserve the reference's late-minute guard: an execution after :40 must
  // not immediately consume the next nominal cron minute.
  if (new Date(after).getSeconds() > 40) after += 20_000;
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  const deadline = after + 2 * 366 * 24 * 60 * 60 * 1_000;
  const rolledCalendarCandidate = nextRolledCalendarCronOccurrence(
    fields,
    normalizedTimezone,
    after,
    deadline,
    formatter
  );
  // Do not linearly format every minute of a sparse schedule.  A rejected
  // month/day can advance one UTC day safely (the local date always moves at
  // least one day across normal DST changes); only a matching day needs an
  // hour/minute scan. This keeps yearly and impossible expressions bounded by
  // a few thousand timezone conversions instead of more than one million.
  for (let attempt = 0; candidate <= deadline && attempt < 200_000; attempt += 1) {
    const parts = cronDatePartsForTimezone(candidate, normalizedTimezone, formatter);
    const advanceToNextLocalDate = () => {
      // Re-anchor the daily skip at the next local midnight. Carrying the
      // current wall-clock hour across a month boundary would skip e.g.
      // `0 0 1 * *` when the scan enters day 1 at noon.
      const remainingMinutes = Math.max(1, (24 - parts.hour) * 60 - parts.minute);
      candidate += remainingMinutes * 60_000;
    };
    if (!fields.month.values.has(parts.month)) {
      advanceToNextLocalDate();
      continue;
    }
    const domMatches = fields.dayOfMonth.values.has(parts.dayOfMonth);
    const dowMatches = fields.dayOfWeek.values.has(parts.dayOfWeek);
    // Match the reference parser's Vixie-style split: a star-based segment
    // (`*`, `*/n`, or a list containing one) in either day field makes the
    // two fields conjunctive. With neither star marker, DOM and DOW are an
    // alternative route to the date.
    const dayMatches = fields.dayOfMonth.wildcard || fields.dayOfWeek.wildcard
      ? domMatches && dowMatches
      : domMatches || dowMatches;
    if (!dayMatches) {
      advanceToNextLocalDate();
      continue;
    }
    if (!fields.hour.values.has(parts.hour)) {
      // Keep the minute walk aligned to real local clock candidates. Adding
      // one hour while retaining an arbitrary minute (e.g. :02 after the
      // late-minute guard) skips valid `0 0 * * *` midnight occurrences.
      // Matching days have at most 1,440 minute probes, while nonmatching
      // days still use the fast day skip above.
      candidate += 60_000;
      continue;
    }
    if (!fields.minute.values.has(parts.minute)) {
      candidate += 60_000;
      continue;
    }
    return rolledCalendarCandidate !== null && rolledCalendarCandidate < candidate
      ? rolledCalendarCandidate
      : candidate;
  }
  if (rolledCalendarCandidate !== null) return rolledCalendarCandidate;
  throw new Error('Cron has no occurrence in the next two years.');
}

function normalizeScheduleDescriptor(input, fallbackMode = SCHEDULE_MODE_MANUAL, fallbackDescriptor = null) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : { scheduleMode: input };
  const embedded = parseScheduleObject(source.schedule);
  const fallback = fallbackDescriptor && typeof fallbackDescriptor === 'object' ? fallbackDescriptor : null;
  const type = normalizeScheduleMode(
    embedded?.type ?? source.scheduleMode,
    fallback?.type ?? fallbackMode
  );
  if (!type) return null;
  const params = embedded?.params && typeof embedded.params === 'object' ? embedded.params : {};
  const fallbackParams = fallback?.type === type && fallback.params && typeof fallback.params === 'object'
    ? fallback.params
    : {};
  if (type === SCHEDULE_MODE_MANUAL || type === SCHEDULE_MODE_LIVE) return { type, params: {} };

  if (type === SCHEDULE_MODE_INTERVAL) {
    const fromHours = source.intervalHours === undefined || source.intervalHours === null
      ? null
      : Math.round(Number(source.intervalHours) * 60 * 60);
    const interval = scheduleSeconds(
      params.interval ?? source.intervalSeconds ?? source.interval ?? fromHours ?? fallbackParams.interval
    );
    return interval ? { type, params: { interval } } : null;
  }

  if (type === SCHEDULE_MODE_RANDOM) {
    const min = scheduleSeconds(params.min ?? source.randomMinSeconds ?? source.min ?? fallbackParams.min);
    const max = scheduleSeconds(params.max ?? source.randomMaxSeconds ?? source.max ?? fallbackParams.max);
    return min && max && min <= max ? { type, params: { min, max } } : null;
  }

  const expr = String(params.expr ?? source.cronExpression ?? source.cron ?? source.expr ?? fallbackParams.expr ?? '').trim();
  const rawTimezone = params.tz ?? source.cronTimezone ?? source.timezone ?? fallbackParams.tz;
  const tz = normalizeCronTimezone(rawTimezone);
  if (!expr || expr.length > 160 || tz === undefined) return null;
  // Keep an imported malformed expression as an unscheduled CRON monitor.
  // The reference defers parsing to next-run calculation and simply returns
  // no due time on failure; rejecting it here would drop the monitor while
  // normalizing stored state.
  return { type, params: { expr, ...(tz !== null ? { tz } : {}) } };
}

function scheduleDescriptorOf(monitor) {
  return normalizeScheduleDescriptor(monitor, monitor?.scheduleMode ?? SCHEDULE_MODE_MANUAL, monitor?.schedule ?? null);
}

function isAutomaticSchedule(monitor) {
  const schedule = scheduleDescriptorOf(monitor);
  if (!schedule) return false;
  if (schedule.type === SCHEDULE_MODE_INTERVAL) return schedule.params.interval < INFINITE_SCHEDULE_SECONDS;
  if (schedule.type === SCHEDULE_MODE_RANDOM) {
    return schedule.params.min < INFINITE_SCHEDULE_SECONDS && schedule.params.max < INFINITE_SCHEDULE_SECONDS;
  }
  return schedule.type === SCHEDULE_MODE_CRON;
}

function nextCheckForSchedule(scheduleOrMode, lastCheckedAt, intervalHours, requestedNextCheck = null) {
  const descriptor = scheduleOrMode && typeof scheduleOrMode === 'object'
    ? (scheduleOrMode.type ? normalizeScheduleDescriptor({ schedule: scheduleOrMode }) : scheduleDescriptorOf(scheduleOrMode))
    : normalizeScheduleDescriptor({ scheduleMode: scheduleOrMode, intervalHours }, scheduleOrMode ?? SCHEDULE_MODE_MANUAL);
  if (!descriptor || !isAutomaticSchedule({ schedule: descriptor }) || ![SCHEDULE_MODE_INTERVAL, SCHEDULE_MODE_RANDOM, SCHEDULE_MODE_CRON].includes(descriptor.type)) return null;
  const requested = asIso(requestedNextCheck, null);
  if (requested) return requested;

  const now = Date.now();
  const last = Date.parse(lastCheckedAt ?? '');
  let due;
  if (descriptor.type === SCHEDULE_MODE_INTERVAL) {
    due = Number.isFinite(last) ? Math.max(now, last + descriptor.params.interval * 1_000) + 1_000 : now;
  } else if (descriptor.type === SCHEDULE_MODE_RANDOM) {
    const span = descriptor.params.max - descriptor.params.min;
    const delay = descriptor.params.min + Math.random() * span;
    due = Number.isFinite(last) ? Math.max(now, last + delay * 1_000) + 1_000 : now;
  } else {
    // The reference still parses a CRON expression before using its epoch
    // sentinel for a first baseline. A malformed import is therefore
    // unscheduled rather than treated as immediately due.
    try {
      parseCronExpression(descriptor.params.expr);
    } catch {
      return null;
    }
    // With no run history the reference scheduler uses its epoch sentinel,
    // whose calculated cron time is already in the past; establish the first
    // baseline immediately rather than waiting for the next calendar slot.
    if (!Number.isFinite(last)) {
      due = now;
    } else {
      try {
        due = Math.max(now, nextCronOccurrence(descriptor.params.expr, descriptor.params.tz, last));
      } catch {
        // Reference scheduling treats an unresolvable CRON expression as
        // unscheduled. Do not let one imported monitor prevent the entire
        // storage state from normalizing or force a hot immediate-alarm loop.
        return null;
      }
    }
  }
  return new Date(due).toISOString();
}

function createId() {
  return crypto.randomUUID();
}

function createRevision() {
  return crypto.randomUUID();
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

// A monitor's URL is its page identity, so retain the fragment for hash-routed
// applications.  A frame location is different: browser frame documents are
// re-created independently of a fragment-only navigation, and the Reference
// frame descriptor matches the document URL rather than a client-side route.
function normalizeFrameUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

// A site-address migration deliberately operates on the URL host rather than
// doing a string replacement. That preserves every monitored path and query
// while ensuring `old.example` cannot accidentally change a path, label, or
// similarly named subdomain.
function normalizeSiteHost(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 255) {
    return null;
  }

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (
      !['https:', 'http:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.host ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function siteHostOfUrl(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function replaceUrlHost(urlValue, sourceHost, targetHost) {
  try {
    const url = new URL(urlValue);
    if (url.host.toLowerCase() !== sourceHost) {
      return null;
    }
    url.host = targetHost;
    return normalizeUrl(url.href);
  } catch {
    return null;
  }
}

function originPattern(urlValue) {
  const url = new URL(urlValue);
  return `${url.protocol}//${url.host}/*`;
}

function cleanSelector(value) {
  const selector = String(value ?? '').trim();
  return selector && selector.length <= 2_000 ? selector : null;
}

function cleanSelectors(value) {
  const source = Array.isArray(value) ? value : [value];
  if (!source.length || source.length > MAX_SELECTORS_PER_MONITOR) {
    return null;
  }

  const selectors = [];
  const seen = new Set();
  for (const item of source) {
    const selector = cleanSelector(typeof item === 'string' ? item : item?.selector);
    if (!selector) {
      return null;
    }
    if (!seen.has(selector)) {
      selectors.push(selector);
      seen.add(selector);
    }
  }
  return selectors.length ? selectors : null;
}

function cleanLocatorField(value) {
  const raw = typeof value === 'string'
    ? { type: value === 'text' ? 'text' : 'attribute', name: value }
    : value && typeof value === 'object'
      ? value
      : null;
  if (!raw) return null;
  let type = String(raw.type ?? raw.kind ?? '').trim().toLowerCase();
  let name = String(raw.name ?? raw.value ?? '').trim();
  if (typeof value === 'string') {
    if (value.startsWith('attr:')) {
      type = 'attribute';
      name = value.slice('attr:'.length).trim();
    } else if (value.startsWith('property:')) {
      type = 'property';
      name = value.slice('property:'.length).trim();
    }
  }
  if (type === 'builtin') type = name === 'text' ? 'text' : '';
  if (!LOCATOR_FIELD_TYPES.has(type)) return null;
  if (type === 'text') return { type: 'text' };
  // Attributes are surfaced by the reference picker verbatim, including
  // XML/SVG names such as `xlink:href` and non-ASCII names.  Property access
  // is also bracket-based, so it does not require a JavaScript identifier.
  // Retain the user-visible name and only reject control/markup separators
  // that cannot be an attribute/property field selection.
  if (!name || name.length > 256 || /[\u0000-\u001F\u007F\s]/.test(name)) return null;
  if (type === 'attribute' && /["'<>\/=]/.test(name)) return null;
  return { type, name };
}

function cleanLocatorFields(value) {
  const explicitlyConfigured = value !== undefined && value !== null;
  const source = Array.isArray(value) ? value : explicitlyConfigured ? [value] : [];
  const fields = [];
  // Field order is the extraction order.  In particular, text may appear
  // before/between/after several attributes, and a repeated field remains a
  // deliberate separator in the reference field payload.  Do not dedupe it.
  for (const item of source.slice(0, 256)) {
    const field = cleanLocatorField(item);
    if (field) fields.push(field);
  }
  // Omitted fields mean the familiar text monitor. An explicit empty list is
  // different: it keeps filtered HTML/data while deliberately contributing no
  // text, which is useful for a data-mode structural monitor.
  return fields.length || explicitlyConfigured ? fields : [{ type: 'text' }];
}

function cleanFramePath(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) return null;
  const path = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const url = normalizeFrameUrl(entry.url);
    const indexValue = entry.index ?? entry.siblingIndex;
    const index = Number.isInteger(indexValue)
      ? indexValue
      : typeof indexValue === 'string' && /^\d+$/.test(indexValue.trim())
        ? Number(indexValue)
        : Number.NaN;
    if (!url || !Number.isInteger(index) || index < 0 || index > 10_000) return null;
    path.push({ url, index });
  }
  return path;
}

function cleanLocator(value, defaults = {}) {
  const raw = typeof value === 'string' ? { expr: value } : value;
  if (!raw || typeof raw !== 'object') return null;
  const typeAlias = String(raw.type ?? defaults.type ?? 'css').trim().toLowerCase();
  const type = typeAlias === 'extended-css' || typeAlias === 'extendedcss' ? 'xcss' : typeAlias;
  if (!LOCATOR_TYPES.has(type)) return null;
  const expr = cleanSelector(raw.expr ?? raw.selector ?? raw.value);
  if (!expr) return null;
  const operationAlias = String(raw.op ?? raw.operation ?? defaults.op ?? 'include').trim().toLowerCase();
  const op = operationAlias === 'exclude' ? 'exclude' : operationAlias === 'include' ? 'include' : '';
  if (!LOCATOR_OPERATIONS.has(op)) return null;
  const frameValue = raw.frameId ?? raw.frame ?? defaults.frameId ?? 0;
  const frameId = Number.isInteger(frameValue)
    ? frameValue
    : typeof frameValue === 'string' && /^\d+$/.test(frameValue.trim())
      ? Number(frameValue)
      : Number.NaN;
  if (!Number.isInteger(frameId) || frameId < 0 || frameId > 1_000_000) return null;
  // Reference frame configurations have a stable `index` used to process
  // innermost/high-index frames first. Chrome frame IDs are reassigned after
  // navigation, so retain a distinct saved ordering key when a locator has
  // one; legacy locators fall back to their originally saved frame ID.
  const frameOrderValue = raw.frameOrder ?? raw.frameIndex ?? defaults.frameOrder;
  const frameOrder = frameOrderValue === undefined || frameOrderValue === null || frameOrderValue === ''
    ? null
    : Number.isInteger(frameOrderValue)
      ? frameOrderValue
      : typeof frameOrderValue === 'string' && /^\d+$/.test(frameOrderValue.trim())
        ? Number(frameOrderValue)
        : Number.NaN;
  if (frameOrder !== null && (!Number.isInteger(frameOrder) || frameOrder < 0 || frameOrder > 1_000_000)) return null;
  const framePath = cleanFramePath(raw.framePath ?? raw.frameDescriptor);
  if (framePath === null) return null;
  // A Reference nested-frame export can carry only a durable frame URL. Keep
  // it as a deferred descriptor; resolution below accepts it only when exactly
  // one current subframe matches, never by flattening into the top document.
  const frameUrlSource = raw.frameUrl ?? raw.frameUri ?? defaults.frameUrl;
  const frameUrl = frameUrlSource === undefined || frameUrlSource === null || frameUrlSource === ''
    ? null
    : normalizeFrameUrl(frameUrlSource);
  if (frameUrlSource !== undefined && frameUrlSource !== null && frameUrlSource !== '' && !frameUrl) return null;
  // The field list and the fact that it was explicitly supplied are distinct
  // capture instructions. `[]` disables inherited text, while an omitted
  // list lets the selected subtree inherit normal text mode. Preserve that
  // bit through storage instead of flattening both into a default text field.
  const rawDefaultTextOnly = Array.isArray(raw.fields)
    && raw.fields.length === 1
    && String(raw.fields[0]?.type ?? '').toLowerCase() === 'text';
  const fieldsSpecified = raw.fieldsSpecified === true
    // `fields: null` is the same as an omitted field configuration in the
    // locator protocol.  It must inherit its parent's text mode instead of
    // silently becoming an explicit empty override after a save/reload.
    || (raw.fieldsSpecified !== false && Object.hasOwn(raw, 'fields') && raw.fields != null && !rawDefaultTextOnly);
  return {
    type,
    expr,
    op,
    frameId,
    framePath,
    ...(frameOrder !== null ? { frameOrder } : {}),
    ...(frameUrl ? { frameUrl } : {}),
    fields: cleanLocatorFields(raw.fields),
    ...(fieldsSpecified ? { fieldsSpecified: true } : {})
  };
}

function locatorKey(locator) {
  return [
    locator.type,
    locator.op,
    locator.frameId,
    locator.frameOrder ?? '',
    JSON.stringify(locator.framePath ?? []),
    locator.frameUrl ?? '',
    locator.expr,
    locator.fieldsSpecified === true ? 'fields:explicit' : 'fields:inherited',
    ...locator.fields.map((field) => `${field.type}:${field.name ?? ''}`)
  ].join('\u0001');
}

function cleanLocators(value) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  // A Reference selection with no frames is a full-page capture.  Materialize
  // that implicit frame here so stored/imported records, the picker API, and
  // the editor all execute the same explicit CSS `body` include.
  if (!source.length) {
    return [cleanLocator({ type: 'css', expr: 'body', op: 'include' })];
  }
  if (source.length > MAX_SELECTORS_PER_MONITOR) return null;
  const locators = [];
  const seen = new Set();
  for (const item of source) {
    const locator = cleanLocator(item);
    if (!locator) return null;
    const key = locatorKey(locator);
    if (seen.has(key)) continue;
    seen.add(key);
    locators.push(locator);
  }
  return locators.some((locator) => locator.op === 'include') ? locators : null;
}

function parseReferenceConfig(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function integerFrameValue(value) {
  if (Number.isInteger(value)) return value;
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null;
}

// Distill Reference records save HTML selection state separately from their
// feed metadata: `config.selections[0].frames[{ index, includes, excludes }]`.
// Its bare nonzero `index` is a transient browser-frame number, not a durable
// frame identity.  Only translate top-frame selections by default; a nested
// frame needs an explicit OpenStill-compatible id *and* stable path. Rejecting
// the whole record in that case is safer than silently running it in frame 0.
function referenceLocatorsFromConfig(config) {
  const selections = config?.selections;
  if (selections === undefined || selections === null || (Array.isArray(selections) && !selections.length)) {
    return { ok: true, locators: [] };
  }
  if (!Array.isArray(selections) || !selections[0] || typeof selections[0] !== 'object') {
    return { ok: false };
  }

  const frames = selections[0].frames;
  if (frames === undefined || frames === null || (Array.isArray(frames) && !frames.length)) {
    return { ok: true, locators: [] };
  }
  if (!Array.isArray(frames)) return { ok: false };

  const locators = [];
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') return { ok: false };
    const index = integerFrameValue(frame.index ?? 0);
    if (index === null || index < 0) return { ok: false };

    let defaults;
    if (index === 0) {
      defaults = { frameId: 0 };
    } else {
      const frameId = integerFrameValue(frame.frameId ?? frame.id);
      const framePath = frame.framePath ?? frame.frameDescriptor ?? frame.path;
      if (frameId && Array.isArray(framePath) && framePath.length) {
        defaults = { frameId, frameOrder: index, framePath };
      } else {
        const frameUrl = normalizeFrameUrl(frame.uri ?? frame.url);
        if (!frameUrl) return { ok: false };
        // `index` is retained only for Reference frame ordering.  The runtime
        // resolves this descriptor by its unique frame URL and rejects an
        // ambiguous duplicate rather than treating it as frame zero.
        defaults = { frameId: index, frameOrder: index, frameUrl };
      }
    }

    const includes = frame.includes ?? [];
    const excludes = frame.excludes ?? [];
    if (!Array.isArray(includes) || !Array.isArray(excludes)) return { ok: false };
    // A body default applies only when the frame list itself is absent/empty.
    // For a present frame with no includes, the Reference runner still appends
    // its automatic `base` include; represent that narrow, text-empty capture
    // rather than silently promoting it to the full document body.
    const effectiveIncludes = includes.length
      ? includes
      : [{ type: 'css', expr: 'base' }];
    for (const selector of effectiveIncludes) {
      locators.push(typeof selector === 'string'
        ? { ...defaults, type: 'css', expr: selector, op: 'include' }
        : { ...selector, ...defaults, op: 'include' });
    }
    for (const selector of excludes) {
      locators.push(typeof selector === 'string'
        ? { ...defaults, type: 'css', expr: selector, op: 'exclude' }
        : { ...selector, ...defaults, op: 'exclude' });
    }
  }
  return { ok: true, locators };
}

function referenceTrackingFromConfig(config) {
  const selection = Array.isArray(config?.selections) ? config.selections[0] : null;
  return {
    ...(config && typeof config === 'object' ? config : {}),
    ...(selection && typeof selection === 'object' && selection.delay !== undefined
      ? { delay: selection.delay }
      : {})
  };
}

function isReferenceHtmlRecord(value) {
  const contentType = value?.content_type ?? value?.contentType;
  if (contentType === undefined || contentType === null || contentType === '') return true;
  if (contentType === 2) return true; // Reference C.TYPE_HTML
  const normalized = String(contentType).trim().toLowerCase();
  return normalized === '2' || normalized === 'html' || normalized === 'type_html';
}

function referenceSelectionUri(config) {
  const selection = Array.isArray(config?.selections) ? config.selections[0] : null;
  return selection && typeof selection === 'object' ? selection.uri : null;
}

function displaySelectorsForLocators(locators) {
  return locators
    .filter((locator) => locator.op === 'include')
    .map((locator) => locator.expr);
}

function framePathForFrame(frameId, frames) {
  if (frameId === 0) return [];
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const path = [];
  let current = byId.get(frameId);
  while (current && current.parentFrameId >= 0) {
    const url = normalizeFrameUrl(current.url);
    if (!url) return null;
    // Frame ids are assigned afresh on every load.  Counting every sibling
    // makes a saved route drift merely because an unrelated ad or widget was
    // inserted before it, so disambiguate only among siblings with the same
    // normalized document URL.
    const siblings = frames
      .filter((frame) => frame.parentFrameId === current.parentFrameId && normalizeFrameUrl(frame.url) === url)
      .sort((left, right) => left.frameId - right.frameId);
    const index = siblings.findIndex((frame) => frame.frameId === current.frameId);
    if (index < 0) return null;
    path.unshift({ url, index });
    current = byId.get(current.parentFrameId);
  }
  return current ? path : null;
}

function stableFrameLocation(value) {
  const normalized = normalizeFrameUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    // Session/query tokens on embed URLs commonly change on every reload.
    // They are useful for an exact match first, but origin+path is the safe
    // secondary identity when it identifies one and only one frame route.
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

function sameFramePath(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => part.url === right[index]?.url && part.index === right[index]?.index);
}

function sameRelaxedFramePath(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((part, index) => (
      part.index === right[index]?.index
      && stableFrameLocation(part.url) === stableFrameLocation(right[index]?.url)
    ));
}

function resolveLocatorFrame(locator, frames) {
  if (locator.framePath?.length) {
    const exact = frames.filter((frame) => sameFramePath(locator.framePath, framePathForFrame(frame.frameId, frames)));
    if (exact.length === 1) return exact[0].frameId;
    const relaxed = frames.filter((frame) => sameRelaxedFramePath(locator.framePath, framePathForFrame(frame.frameId, frames)));
    if (relaxed.length === 1) return relaxed[0].frameId;
    // A saved path is stronger evidence than Chrome's transient frame id.  Do
    // not silently run a selector in a possibly unrelated frame after a
    // reload: callers turn this sentinel into a clear configuration error.
    return -1;
  }
  if (locator.frameUrl) {
    const exact = frames.filter((frame) => frame.frameId !== 0 && normalizeFrameUrl(frame.url) === locator.frameUrl);
    if (exact.length === 1) return exact[0].frameId;
    const stable = stableFrameLocation(locator.frameUrl);
    const relaxed = frames.filter((frame) => (
      frame.frameId !== 0 && stableFrameLocation(frame.url) === stable
    ));
    // A URL-only Reference descriptor is safe only if it names exactly one
    // current subframe. Duplicate embeds remain a visible selection failure.
    return relaxed.length === 1 ? relaxed[0].frameId : -1;
  }
  return Number.isInteger(locator.frameId) ? locator.frameId : 0;
}

function cleanRegularExpression(value) {
  const source = typeof value === 'string'
    // Legacy string configuration follows the reference default flags rather
    // than silently becoming case-sensitive and single-line only.
    ? { expr: value, flags: 'gim' }
    : value && typeof value === 'object' ? value : null;
  if (!source) return null;
  const expr = String(source.expr ?? source.pattern ?? source.value ?? '').trim();
  const flags = String(source.flags ?? '').trim();
  if (!expr) return null;
  if (expr.length > 1_000 || flags.length > 12 || !/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) {
    return null;
  }
  try {
    // Validate in the same JavaScript regexp engine used for a later capture.
    // `u` and `v` are mutually exclusive even in engines that support both.
    if (flags.includes('u') && flags.includes('v')) return null;
    new RegExp(expr, flags);
    return { expr, flags };
  } catch {
    return null;
  }
}

function hasInvalidConfiguredRegularExpression(value) {
  const source = value && typeof value === 'object' ? value : {};
  const candidate = source.regexp ?? source.regex ?? source.textFilter;
  if (candidate === undefined || candidate === null || candidate === '') return false;
  if (typeof candidate === 'object' && !String(candidate.expr ?? candidate.pattern ?? candidate.value ?? '').trim()) return false;
  return !cleanRegularExpression(candidate);
}

function normalizeTracking(value) {
  const input = value && typeof value === 'object' ? value : {};
  const requestedDataAttr = String(input.dataAttr ?? input.compare ?? input.comparison ?? 'text').toLowerCase();
  const dataAttr = requestedDataAttr === 'data' || requestedDataAttr === 'html' ? 'data' : 'text';
  const delayMilliseconds = Object.hasOwn(input, 'delayMilliseconds')
    ? Number(input.delayMilliseconds)
    : Number(input.delay ?? 0) * 1_000;
  const timeoutMilliseconds = Object.hasOwn(input, 'timeoutMilliseconds')
    ? Number(input.timeoutMilliseconds)
    : Object.hasOwn(input, 'timeout')
      ? Number(input.timeout) * 1_000
      : CHECK_EXECUTION_TIMEOUT_MS;
  return {
    dataAttr,
    ignoreWhitespace: input.ignoreWhitespace !== false,
    allowEmpty: input.allowEmpty === true || input.ignoreEmptyText === false,
    regexp: cleanRegularExpression(input.regexp ?? input.regex ?? input.textFilter),
    includeScript: input.includeScript === true || input.includeScripts === true,
    includeStyle: input.includeStyle === true || input.includeStyles === true,
    keepComments: input.keepComments === true,
    live: input.live === true || input.liveMonitoring === true,
    delayMilliseconds: Number.isFinite(delayMilliseconds)
      ? Math.max(0, Math.min(60_000, Math.round(delayMilliseconds)))
      : 0,
    timeoutMilliseconds: Number.isFinite(timeoutMilliseconds)
      ? Math.max(MIN_CHECK_EXECUTION_TIMEOUT_MS, Math.min(MAX_CHECK_EXECUTION_TIMEOUT_MS, Math.round(timeoutMilliseconds)))
      : CHECK_EXECUTION_TIMEOUT_MS
  };
}

function filterCapturedText(text, tracking) {
  const regexp = normalizeTracking(tracking).regexp;
  const source = String(text ?? '');
  if (!regexp) return source;
  try {
    const matches = source.match(new RegExp(regexp.expr, regexp.flags));
    return matches?.length ? matches.join(' ') : '';
  } catch {
    // Stored monitors are normalized before use, but preserve a deterministic
    // empty result if a browser later rejects a previously valid regexp flag.
    return '';
  }
}

function snapshotTextFromItems(items) {
  return items.map((item) => item.text).join('\n\n');
}

function snapshotHtmlFromItems(items) {
  return items.map((item) => item.html).filter(Boolean).join('\n');
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || typeof value.exists !== 'boolean') {
    return null;
  }

  const matchCount = typeof value.matchCount === 'number'
    ? value.matchCount
    : typeof value.matchCount === 'string' && /^\d+$/.test(value.matchCount.trim())
      ? Number(value.matchCount)
      : Number.NaN;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const fullItemTexts = rawItems.map((item) => cleanSnapshotText(item?.text, Number.MAX_SAFE_INTEGER));
  const fullText = rawItems.length
    ? fullItemTexts.join('\n\n')
    : cleanSnapshotText(value.text, Number.MAX_SAFE_INTEGER);
  const itemCount = Math.min(rawItems.length, MAX_COLLECTION_ITEMS);
  const separatorLength = Math.max(0, itemCount - 1) * 2;
  const perItemLimit = itemCount
    ? Math.max(0, Math.floor(Math.max(0, MAX_SNAPSHOT_CHARS - separatorLength) / itemCount))
    : 0;
  const items = rawItems.slice(0, MAX_COLLECTION_ITEMS).map((item) => ({
    text: cleanSnapshotText(item?.text, perItemLimit)
  }));
  if (!items.length && fullText) items.push({ text: fullText.slice(0, MAX_SNAPSHOT_CHARS) });
  const fullHtml = cleanSnapshotHtml(
    typeof value.html === 'string' ? value.html : snapshotHtmlFromItems(rawItems),
    Number.MAX_SAFE_INTEGER
  );
  const fullData = cleanSnapshotHtml(
    typeof value.data === 'string' ? value.data : fullHtml,
    Number.MAX_SAFE_INTEGER
  );
  const html = fullHtml.slice(0, MAX_SNAPSHOT_CHARS);
  const data = fullData.slice(0, MAX_SNAPSHOT_CHARS);
  const evidenceHtml = cleanSnapshotHtml(value.evidenceHtml, MAX_SNAPSHOT_CHARS);
  const safeMatchCount = Number.isInteger(matchCount) && matchCount >= 0
    ? matchCount
    : items.length;
  // `exists` records whether the extractor found a meaningful selected root;
  // it is deliberately independent from whether there is textual content.
  // An allow-empty monitor must retain its filtered HTML/data even at zero
  // matches so a later structural reappearance can be compared faithfully.
  const exists = Boolean(value.exists);
  const retainPayload = exists
    || rawItems.length > 0
    || Boolean(fullText)
    || Boolean(fullHtml)
    || Boolean(fullData);

  return {
    exists,
    matchCount: safeMatchCount,
    text: retainPayload ? snapshotTextFromItems(items) : '',
    html: retainPayload ? html : '',
    data: retainPayload ? data : '',
    evidenceHtml,
    items: retainPayload ? items : [],
    textFingerprint: snapshotFingerprint(fullText),
    compactTextFingerprint: snapshotFingerprint(fullText.replace(/\s/g, '')),
    tokenTextFingerprint: comparisonTokenFingerprint(fullText),
    dataFingerprint: snapshotFingerprint(fullData),
    compactDataFingerprint: snapshotFingerprint(fullData.replace(/\s/g, '')),
    tokenDataFingerprint: comparisonTokenFingerprint(fullData),
    textTruncated: fullText.length > MAX_SNAPSHOT_CHARS || rawItems.length > MAX_COLLECTION_ITEMS,
    dataTruncated: fullData.length > MAX_SNAPSHOT_CHARS,
    capturedAt: asIso(value.capturedAt, null)
  };
}

function snapshotsEqual(left, right, tracking = null) {
  // Match count and individual-root boundaries are presentation metadata, not
  // a change by themselves. The selected representation is explicit, though:
  // `text` preserves the familiar whitespace-insensitive monitor behaviour,
  // while `data` compares the filtered HTML so a changed href/src is visible.
  const options = normalizeTracking(tracking);
  const field = options.dataAttr === 'data' ? 'data' : 'text';
  const fingerprintField = field === 'data'
    ? options.ignoreWhitespace ? 'compactDataFingerprint' : 'tokenDataFingerprint'
    : options.ignoreWhitespace ? 'compactTextFingerprint' : 'tokenTextFingerprint';
  const truncatedField = field === 'data' ? 'dataTruncated' : 'textTruncated';
  const fingerprintComparable = left?.[fingerprintField] && right?.[fingerprintField]
    && (left?.[truncatedField] || right?.[truncatedField])
    ? left[fingerprintField] === right[fingerprintField]
    : null;
  const comparable = options.ignoreWhitespace
    ? String(left?.[field] ?? '').replace(/\s/g, '') === String(right?.[field] ?? '').replace(/\s/g, '')
    : comparisonTokensEqual(left?.[field], right?.[field]);
  // `exists` is extraction/control-flow metadata. Once allow-empty mode has
  // admitted an empty result, the reference comparison is still solely the
  // configured text/data payload; a matched empty element and a missing
  // element with the same payload are not a synthetic content change.
  return Boolean(left && right) && (fingerprintComparable ?? comparable);
}

function normalizeMonitor(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const hasExplicitLocators = Object.hasOwn(value, 'locators') || Object.hasOwn(value, 'selectors');
  const rawReferenceConfig = value.config;
  const referenceConfig = parseReferenceConfig(rawReferenceConfig);
  const isReferenceRecord = Object.hasOwn(value, 'uri') && (
    !Object.hasOwn(value, 'url')
    || Object.hasOwn(value, 'config')
    || Object.hasOwn(value, 'content_type')
    || Object.hasOwn(value, 'state')
  );
  const usesReferenceSelection = !hasExplicitLocators && (
    isReferenceRecord
    || Boolean(referenceConfig && Object.hasOwn(referenceConfig, 'selections'))
  );
  const referenceSelection = usesReferenceSelection
    ? (rawReferenceConfig === undefined || rawReferenceConfig === null || rawReferenceConfig === ''
      ? { ok: true, locators: [] }
      : referenceConfig
        ? referenceLocatorsFromConfig(referenceConfig)
        : { ok: false })
    : null;
  if (isReferenceRecord && !isReferenceHtmlRecord(value)) return null;
  const url = isReferenceRecord
    ? normalizeUrl(referenceSelectionUri(referenceConfig)) ?? normalizeUrl(value.uri ?? value.url)
    : normalizeUrl(value.url);
  const locators = usesReferenceSelection
    ? referenceSelection?.ok ? cleanLocators(referenceSelection.locators) : null
    : cleanLocators(value.locators ?? value.selectors);
  const selectors = locators ? displaySelectorsForLocators(locators) : null;
  // Pre-manual-mode monitors always used an interval. Newer records retain a
  // reference-style descriptor so RANDOM, CRON, and LIVE survive export and
  // worker restarts without being flattened into an hour count.
  const schedule = normalizeScheduleDescriptor(
    value,
    isReferenceRecord ? SCHEDULE_MODE_MANUAL : SCHEDULE_MODE_INTERVAL
  );
  const scheduleMode = schedule?.type;
  const intervalHours = scheduleMode === SCHEDULE_MODE_INTERVAL
    ? schedule.params.interval / 3_600
    : clampInterval(value.intervalHours) ?? MIN_INTERVAL_HOURS;
  if (!url || !locators || !selectors || !schedule) {
    return null;
  }
  const createdAt = asIso(value.createdAt ?? (isReferenceRecord ? value.ts : undefined), nowIso());
  // A Reference backup does not carry its complete run log. `ts_data` is the
  // last persisted data change, so use it as the best durable lower bound for
  // both the comparison/change timestamp and the next scheduler calculation.
  const lastCheckedAt = asIso(value.lastCheckedAt ?? (isReferenceRecord ? value.ts_data : undefined), null);
  const lastChangedAt = asIso(value.lastChangedAt ?? (isReferenceRecord ? value.ts_data : undefined), null);
  const lastViewedAt = asIso(value.lastViewedAt ?? value.lastReadAt ?? (isReferenceRecord ? value.ts_view : undefined), null);
  const status = VALID_STATUSES.has(value.status) ? value.status : 'ok';
  const trackingSource = value.tracking
    ?? (isReferenceRecord && referenceConfig ? referenceTrackingFromConfig(referenceConfig) : value);
  const tracking = normalizeTracking(scheduleMode === SCHEDULE_MODE_LIVE
    ? { ...(trackingSource && typeof trackingSource === 'object' ? trackingSource : {}), live: true }
    : trackingSource);
  const normalizedSnapshot = normalizeSnapshot(value.snapshot);
  // A no-match result is never a baseline. Keeping it here would make the
  // next successful render look like an element deletion/reappearance change.
  const snapshot = normalizedSnapshot && (normalizedSnapshot.exists || tracking.allowEmpty)
    ? normalizedSnapshot
    : null;
  const lastChange = value.lastChange && typeof value.lastChange === 'object'
    ? {
        previous: normalizeSnapshot(value.lastChange.previous),
        current: normalizeSnapshot(value.lastChange.current),
        detectedAt: asIso(value.lastChange.detectedAt, null)
      }
    : null;
  const lastErrorSnapshot = normalizeSnapshot(value.lastErrorSnapshot);
  const history = Array.isArray(value.history)
    ? value.history.slice(0, MAX_CHANGE_HISTORY).map((entry) => {
        const snapshot = normalizeSnapshot(entry?.snapshot ?? entry);
        return snapshot && (snapshot.exists || tracking.allowEmpty)
          ? {
              snapshot,
              capturedAt: asIso(entry?.capturedAt ?? snapshot.capturedAt, null),
              kind: entry?.kind === 'baseline' ? 'baseline' : 'change'
            }
          : null;
      }).filter(Boolean)
    : [];
  const runs = Array.isArray(value.runs)
    ? value.runs.slice(0, MAX_RUN_HISTORY).map((entry) => ({
        at: asIso(entry?.at ?? entry?.checkedAt, null),
        status: VALID_STATUSES.has(entry?.status) ? entry.status : 'error',
        code: cleanShortText(entry?.code, 80) || null,
        message: cleanShortText(entry?.message ?? entry?.error, 300) || null,
        changed: Boolean(entry?.changed),
        matchCount: Number.isInteger(entry?.matchCount) && entry.matchCount >= 0 ? entry.matchCount : null
      })).filter((entry) => entry.at)
    : [];

  const rawId = value.id ?? value.uuid;
  const id = (typeof rawId === 'string' || typeof rawId === 'number') && String(rawId)
    ? String(rawId).slice(0, 100)
    : createId();
  const revision = typeof value.revision === 'string' && value.revision.length <= 100
    ? value.revision
    : createRevision();

  return {
    id,
    revision,
    name: cleanText(value.name, 120) || cleanText(value.pageTitle ?? value.title, 120) || new URL(url).hostname,
    url,
    pageTitle: cleanText(value.pageTitle ?? value.title, 180),
    selectors,
    locators,
    tracking,
    labels: cleanLabels(value.labels ?? value.tags),
    schedule,
    scheduleMode,
    intervalHours,
    ...(scheduleMode === SCHEDULE_MODE_INTERVAL ? { intervalSeconds: schedule.params.interval } : {}),
    enabled: isReferenceRecord
      ? Number(value.state) === 40 // Reference C.STATE_READY
      : value.enabled !== false,
    createdAt,
    updatedAt: asIso(value.updatedAt ?? (isReferenceRecord ? value.ts_mod ?? value.ts : undefined), createdAt),
    lastCheckedAt,
    lastChangedAt,
    nextCheckAt: nextCheckForSchedule(schedule, lastCheckedAt, intervalHours, value.nextCheckAt),
    snapshot,
    lastChange,
    lastErrorSnapshot,
    history,
    runs,
    lastReviewAt: asIso(value.lastReviewAt, null),
    lastViewedAt,
    lastError: cleanText(value.lastError, 300) || null,
    status,
    unread: lastChangedAt && (!lastViewedAt || Date.parse(lastViewedAt) < Date.parse(lastChangedAt))
      ? true
      : Boolean(value.unread)
  };
}

function normalizeSettings(value) {
  return {
    ...DEFAULT_SETTINGS,
    ...(value && typeof value === 'object' ? { soundEnabled: value.soundEnabled !== false } : {})
  };
}

async function getState() {
  const stored = await chrome.storage.local.get([MONITORS_KEY, SETTINGS_KEY]);
  const rawMonitors = Array.isArray(stored[MONITORS_KEY]) ? stored[MONITORS_KEY] : [];
  const normalizedMonitors = rawMonitors.map(normalizeMonitor);
  const monitors = normalizedMonitors.filter(Boolean);
  // A pre-descriptor/imported automatic monitor can legitimately have no
  // durable nextCheckAt. Normalize it once and persist the calculated value.
  // Without this, every service-worker wake recalculates "now + 1 second",
  // so a due sweep observes it just before due forever.
  const needsSchedulePersistence = rawMonitors.some((raw, index) => {
    const monitor = normalizedMonitors[index];
    return Boolean(
      monitor
      && monitor.enabled
      && isAutomaticSchedule(monitor)
      && !asIso(raw?.nextCheckAt, null)
      && monitor.nextCheckAt
    );
  });
  if (needsSchedulePersistence) {
    await chrome.storage.local.set({ [MONITORS_KEY]: monitors });
  }

  return {
    monitors,
    settings: normalizeSettings(stored[SETTINGS_KEY])
  };
}

async function getMonitors() {
  return (await getState()).monitors;
}

function mutateMonitors(mutator) {
  const operation = storageQueue.catch(() => undefined).then(async () => {
    const state = await getState();
    const result = await mutator(state.monitors);
    await chrome.storage.local.set({ [MONITORS_KEY]: state.monitors });
    return result;
  });

  storageQueue = operation.catch(() => undefined);
  return operation;
}

function migrateLegacyScheduleModes() {
  const operation = storageQueue.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.local.get(MONITORS_KEY);
    const rawMonitors = stored[MONITORS_KEY];
    if (!Array.isArray(rawMonitors) || !rawMonitors.some((monitor) => (
      monitor && typeof monitor === 'object' && !Object.hasOwn(monitor, 'scheduleMode')
    ))) {
      return false;
    }

    // Older releases only had intervalHours, which meant automatic scheduling.
    // Persist that explicit meaning once so the new default applies only to new
    // trackers rather than silently stopping existing schedules.
    const monitors = rawMonitors.map(normalizeMonitor).filter(Boolean);
    await chrome.storage.local.set({ [MONITORS_KEY]: monitors });
    return true;
  });

  storageQueue = operation.catch(() => undefined);
  return operation;
}

async function updateSettings(settingsPatch) {
  const state = await getState();
  const settings = normalizeSettings({ ...state.settings, ...settingsPatch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function hasSitePermission(url) {
  // HTTP/HTTPS host access is a required install-time permission. Keep this
  // guard so every caller still rejects unsupported schemes, but do not make
  // users approve hundreds of imported origins one at a time.
  return Boolean(normalizeUrl(url));
}

async function getPendingPickers() {
  const stored = await chrome.storage.session.get(PENDING_PICKERS_KEY);
  const pending = stored[PENDING_PICKERS_KEY];
  return pending && typeof pending === 'object' ? pending : {};
}

async function rememberPendingPicker(tabId, url) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  pending[String(tabId)] = { origin: originPattern(url), createdAt: nowIso() };
  await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
}

async function forgetPendingPicker(tabId) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  if (Object.hasOwn(pending, String(tabId))) {
    delete pending[String(tabId)];
    await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
  }
}

async function releaseUnusedOriginPermission(pattern) {
  // Host access is now declared in manifest.json, so Chrome does not allow it
  // to be removed per origin at runtime. The picker bookkeeping still calls
  // this helper when a user cancels selection; making it a no-op keeps that
  // lifecycle explicit without attempting to mutate required permissions.
  void pattern;
}

async function releaseUnusedSitePermission(url) {
  await releaseUnusedOriginPermission(originPattern(url));
}

async function releasePendingPicker(tabId) {
  if (!Number.isInteger(tabId)) return;
  const pending = await getPendingPickers();
  const entry = pending[String(tabId)];
  if (!entry?.origin) return;
  delete pending[String(tabId)];
  await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
  await releaseUnusedOriginPermission(entry.origin);
}

async function clearExpiredPendingPickers() {
  const pending = await getPendingPickers();
  const cutoff = Date.now() - PENDING_PICKER_TTL_MS;
  const expiredOrigins = new Set();
  let changed = false;

  for (const [tabId, entry] of Object.entries(pending)) {
    if (!entry?.origin || (Date.parse(entry.createdAt ?? '') || 0) < cutoff) {
      if (entry?.origin) expiredOrigins.add(entry.origin);
      delete pending[tabId];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.session.set({ [PENDING_PICKERS_KEY]: pending });
    await Promise.all([...expiredOrigins].map((origin) => releaseUnusedOriginPermission(origin)));
  }
}

async function cleanupUnusedSitePermissions() {
  // See releaseUnusedOriginPermission: broad HTTP/HTTPS access is required at
  // installation time for batch imports and scheduled checks.
}

function responseError(error) {
  return error instanceof Error ? error.message : String(error ?? '알 수 없는 오류');
}

function timeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.some((context) => context.documentUrl === offscreenUrl)) {
    return;
  }

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER', 'AUDIO_PLAYBACK'],
      justification: 'OpenStill validates CSS selectors and plays a local alert tone.'
    }).catch(async (error) => {
      const contextsAfterFailure = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contextsAfterFailure.some((context) => context.documentUrl === offscreenUrl)) {
        throw error;
      }
    }).finally(() => {
      offscreenCreation = undefined;
    });
  }

  await offscreenCreation;
}

async function parseMonitoredHtml(html, selector, selectorType = 'css') {
  await ensureOffscreenDocument();
  const result = await timeout(
    chrome.runtime.sendMessage({ type: 'parse-monitor-html', html, selector, selectorType }),
    PARSE_TIMEOUT_MS,
    '페이지 HTML을 분석하는 데 시간이 너무 오래 걸렸습니다.'
  );

  if (!result?.ok) {
    throw new Error(result?.error || '선택자 분석 결과를 받지 못했습니다.');
  }

  return {
    exists: Boolean(result.exists),
    matchCount: Number.isInteger(result.matchCount) ? result.matchCount : 0,
    text: cleanText(result.text),
    capturedAt: nowIso()
  };
}

async function validateSelectorSyntax(selector, selectorType = 'css') {
  await parseMonitoredHtml('', selector, selectorType);
}

function waitForRenderedTab(tabId) {
  let cancel = () => undefined;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error('렌더링된 페이지를 여는 데 30초가 넘게 걸렸습니다.')));
    }, RENDER_LOAD_TIMEOUT_MS);
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        finish(resolve);
      }
    };
    const domContentLoaded = (details) => {
      if (details?.tabId === tabId && details.frameId === 0) finish(resolve);
    };
    const domReadyEvents = chrome.webNavigation?.onDOMContentLoaded;
    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      domReadyEvents?.removeListener?.(domContentLoaded);
    };
    cancel = cleanup;
    chrome.tabs.onUpdated.addListener(listener);
    // Reference loader signals readiness at DOMContentLoaded.  A full-load
    // tab-status event is retained only as a compatibility fallback for
    // browsers/test environments without webNavigation's DOM-ready event.
    domReadyEvents?.addListener?.(domContentLoaded);

    // A fast cached page can finish before the listener above is attached.
    // We only create this tab for the target URL, so an already-complete state
    // is a valid full-load signal as well.
    if (typeof chrome.tabs.get === 'function') {
      void chrome.tabs.get(tabId).then((tab) => {
        if (tab?.status === 'complete') finish(resolve);
      }).catch(() => undefined);
    }
  });
  return { promise, cancel };
}

async function waitForPageLoadAndPickerDelay(tabId) {
  const execution = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (delayMilliseconds) => {
      if (document.readyState !== 'complete') {
        await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
      return document.readyState;
    },
    args: [PICKER_READY_DELAY_MS]
  });

  if (execution[0]?.result !== 'complete') {
    throw new Error('페이지가 완전히 로드되기 전에 선택기를 시작할 수 없습니다.');
  }
}

// Typed capture entry point. Its implementation is kept separate from the
// legacy collector below so existing stored CSS-only monitors can migrate
// without a behavior gap while richer locators are introduced.
async function captureReferenceRenderedDocumentCollection(...args) {
  const [rawLocators, minimumWaitMilliseconds, quietMilliseconds, settleTimeoutMilliseconds,
    emptyRetryCount = 4, emptyRetryDelayMilliseconds = 5_000, captureOptions = {}] = args;
  const includeMark = 'data-openstill-capture-include';
  const excludeMark = 'data-openstill-capture-exclude';
  const automaticIncludeMark = 'data-openstill-capture-automatic';
  const includeInlineScripts = captureOptions?.includeScript === true || captureOptions?.includeScripts === true;
  const includeStyles = captureOptions?.includeStyle === true || captureOptions?.includeStyles === true;
  const keepComments = captureOptions?.keepComments === true;
  const liveObserverRecord = (() => {
    if (!captureOptions?.live || typeof captureOptions?.liveMonitorId !== 'string') return null;
    try {
      return globalThis.__openStillLiveMutationObservers?.get(captureOptions.liveMonitorId) || null;
    } catch {
      return null;
    }
  })();
  const adblockerSelectors = () => {
    // The reference locator receives cosmetic-filter rules through a DOM
    // event, stores their selector text, and treats those nodes as ordinary
    // excludes for future captures. Keep that page-local registry in the
    // isolated world without depending on the reference implementation.
    const key = '__openStillCaptureAdblockerSelectors';
    let state = globalThis[key];
    if (!state) {
      const selectors = new Set();
      const addStylesheet = (stylesheet) => {
        if (typeof stylesheet !== 'string' || !stylesheet.trim()) return;
        try {
          const sheet = new CSSStyleSheet();
          sheet.insertRule(stylesheet, 0);
          const selector = String(sheet.cssRules[0]?.selectorText || '').trim();
          if (selector) selectors.add(selector);
        } catch {
          // A malformed cosmetic rule must not break the monitored capture.
        }
      };
      // The locator integration can already have collected rules before this
      // isolated capture entry point first runs.  Reference capture reads the
      // shared cache every time, rather than relying solely on future events.
      const absorbCachedSelectors = () => {
        const cached = globalThis.adblockerStyleSheets;
        if (!Array.isArray(cached)) return;
        for (const entry of cached) {
          if (typeof entry === 'string') {
            addStylesheet(entry);
            continue;
          }
          const selector = String(entry?.selector ?? '').trim();
          if (selector) selectors.add(selector);
        }
      };
      state = { selectors, addStylesheet, absorbCachedSelectors };
      globalThis[key] = state;
      addEventListener('bbx:adblocker:stylesheet-update', (event) => {
        addStylesheet(event?.detail?.stylesheet);
      });
      try {
        dispatchEvent(new CustomEvent('adblocker:locator:cached-stylesheets'));
      } catch {
        // Custom events are optional on restricted/opaque documents.
      }
    }
    state.absorbCachedSelectors?.();
    return [...state.selectors];
  };
  const isIgnoredElement = (node, insideShadow = false) => {
    if (node?.nodeType !== Node.ELEMENT_NODE) return true;
    const localName = String(node.localName || node.tagName || '').toLowerCase();
    // Do not reserve a tag name or generic accessibility state owned by a
    // page. Only the extension's private picker marker denotes internal UI.
    if (String(node.localName || '').toLowerCase() === 'openstill-picker-root'
      && node.getAttribute?.('data-openstill-picker-ui') === 'true') return true;
    // Automatic CSS/XPath exclusions run against the cloned document's
    // light DOM. They do not enter shadow roots, whose retained markup must
    // therefore stay intact unless the user explicitly excludes it.
    if (insideShadow) return false;
    if (['noscript', 'frame', 'iframe'].includes(localName)) return true;
    // When code capture is disabled, scripts and script-preload links are
    // excluded. When it is enabled, inline scripts are added automatically,
    // while an external script remains visible if it belongs to a broader
    // user-selected subtree (the page's own markup is still meaningful data).
    if (localName === 'script') return !includeInlineScripts;
    if (localName === 'link' && String(node.getAttribute('as') || '').toLowerCase() === 'script') return !includeInlineScripts;
    if (localName === 'style') return !includeStyles;
    if (localName === 'link' && String(node.getAttribute('rel') || '').toLowerCase() === 'stylesheet') return !includeStyles;
    return false;
  };
  // Keep these deliberately narrow lists in lockstep with the reference
  // extractor. The clone lives in a detached HTMLDocument, where browser
  // defaults such as P/ASIDE display are not reliably resolved; treating
  // extra semantic elements as blocks here would manufacture line breaks
  // that the reference text payload does not contain.
  const blockTags = new Set([
    'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'CODE', 'DD', 'DIV', 'FIELDSET', 'FOOTER', 'FORM',
    'HEADER', 'LI', 'OL', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR',
    'UL', 'IMG', 'BR'
  ]);
  const spacedTags = new Set(['A', 'ABBR', 'ACRONYM', 'ADDRESS', 'BUTTON', 'TD']);

  const fieldOf = (value) => {
    const raw = typeof value === 'string'
      ? { type: value === 'text' ? 'text' : 'attribute', name: value }
      : value && typeof value === 'object' ? value : null;
    if (!raw) return null;
    let type = String(raw.type ?? raw.kind ?? '').toLowerCase();
    let name = String(raw.name ?? raw.value ?? '').trim();
    if (typeof value === 'string' && value.startsWith('attr:')) {
      type = 'attribute';
      name = value.slice(5).trim();
    }
    if (typeof value === 'string' && value.startsWith('property:')) {
      type = 'property';
      name = value.slice(9).trim();
    }
    if (type === 'builtin') type = name === 'text' ? 'text' : '';
    if (type === 'text') return { type: 'text' };
    if (!['attribute', 'property'].includes(type)
      || !name
      || name.length > 256
      || /[\u0000-\u001F\u007F\s]/.test(name)
      || (type === 'attribute' && /["'<>\/=]/.test(name))) return null;
    return { type, name };
  };

  const locatorOf = (value) => {
    const raw = typeof value === 'string' ? { expr: value } : value;
    if (!raw || typeof raw !== 'object') return null;
    const inputType = String(raw.type ?? 'css').trim().toLowerCase();
    const type = inputType === 'extendedcss' || inputType === 'extended-css' ? 'xcss' : inputType;
    const expr = String(raw.expr ?? raw.selector ?? raw.value ?? '').trim();
    const op = String(raw.op ?? raw.operation ?? 'include').trim().toLowerCase();
    if (!['css', 'xcss', 'xpath'].includes(type) || !expr || !['include', 'exclude'].includes(op)) return null;
    const rawDefaultTextOnly = Array.isArray(raw.fields)
      && raw.fields.length === 1
      && String(raw.fields[0]?.type ?? '').toLowerCase() === 'text';
    const hasExplicitFields = raw.fieldsSpecified === true
      || (raw.fieldsSpecified !== false && Object.hasOwn(raw, 'fields') && raw.fields != null && !rawDefaultTextOnly);
    const values = Array.isArray(raw.fields) ? raw.fields : raw.fields == null ? [] : [raw.fields];
    const fields = [];
    for (const value of values.slice(0, 256)) {
      const field = fieldOf(value);
      if (field) fields.push(field);
    }
    return {
      type,
      expr,
      op,
      fields: fields.length || hasExplicitFields ? fields : [{ type: 'text' }],
      fieldsSpecified: hasExplicitFields,
      legacy: typeof value === 'string'
    };
  };

  const locators = (Array.isArray(rawLocators) ? rawLocators : []).map(locatorOf).filter(Boolean);
  const includeLocators = locators.filter((locator) => locator.op === 'include');
  // The reference content-world locator keeps this flag after the first
  // successfully evaluated XCSS expression. Subsequent CSS/XPath captures in
  // that same frame keep declarative shadow serialization as well; resetting
  // it per call makes data-mode snapshots depend on monitor order.
  const xcssSerializerStateKey = '__openStillCaptureUsesExtendedCss';
  let usesExtendedCss = globalThis[xcssSerializerStateKey] === true;
  const unique = (items) => [...new Set(items)];
  const shadowFor = (element) => {
    if (element?.nodeType !== Node.ELEMENT_NODE) return null;
    const read = (getter) => {
      try { return getter() || null; } catch { return null; }
    };
    // A page-owned compatibility getter must not abort the complete
    // clone/filter transaction. Continue with another accessible root source,
    // or retain this host's normal light DOM when none is available.
    const usable = (root) => root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      && typeof root.querySelectorAll === 'function'
      ? root
      : null;
    return usable(read(() => element.shadowRoot))
      || usable(read(() => element._shadowRoot))
      || usable(read(() => element.__openStillCaptureShadow))
      || usable(read(() => globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element)));
  };
  const isInsidePickerUi = (element) => {
    const visited = new Set();
    for (let current = element; current && !visited.has(current); current = current.parentElement || current.getRootNode?.().host || null) {
      visited.add(current);
      if (String(current.localName || '').toLowerCase() === 'openstill-picker-root'
        && current.getAttribute?.('data-openstill-picker-ui') === 'true') return true;
    }
    return false;
  };

  const splitUnion = (source) => {
    const parts = [];
    let value = '', quote = '', escaped = false, square = 0, round = 0;
    for (const character of String(source || '')) {
      if (escaped) { value += character; escaped = false; continue; }
      if (character === '\\') { value += character; escaped = true; continue; }
      if (quote) { value += character; if (character === quote) quote = ''; continue; }
      if (character === "'" || character === '"') { value += character; quote = character; continue; }
      if (character === '[') square += 1;
      if (character === ']') square = Math.max(0, square - 1);
      if (character === '(') round += 1;
      if (character === ')') round = Math.max(0, round - 1);
      if (character === ',' && !square && !round) { if (value.trim()) parts.push(value.trim()); value = ''; }
      else value += character;
    }
    if (value.trim()) parts.push(value.trim());
    return parts;
  };

  const splitSteps = (source) => {
    const parts = [];
    let value = '', quote = '', escaped = false, escapedHexDigits = 0, square = 0, round = 0;
    const flush = () => { if (value.trim()) parts.push(value.trim()); value = ''; };
    for (const character of String(source || '').trim()) {
      if (escaped) {
        value += character;
        escaped = false;
        escapedHexDigits = /[0-9a-f]/i.test(character) ? 1 : 0;
        continue;
      }
      if (escapedHexDigits) {
        if (/[0-9a-f]/i.test(character) && escapedHexDigits < 6) {
          value += character;
          escapedHexDigits += 1;
          continue;
        }
        if (/\s/.test(character)) {
          value += character;
          escapedHexDigits = 0;
          continue;
        }
        escapedHexDigits = 0;
      }
      if (character === '\\') { value += character; escaped = true; continue; }
      if (quote) { value += character; if (character === quote) quote = ''; continue; }
      if (character === "'" || character === '"') { value += character; quote = character; continue; }
      if (character === '[') square += 1;
      if (character === ']') square = Math.max(0, square - 1);
      if (character === '(') round += 1;
      if (character === ')') round = Math.max(0, round - 1);
      if (/\s/.test(character) && !square && !round) flush(); else value += character;
    }
    flush();
    for (let index = 0; index < parts.length; index += 1) {
      if (/^[>+~]$/.test(parts[index]) && index > 0 && index < parts.length - 1) {
        parts[index - 1] += parts[index] + parts[index + 1];
        parts.splice(index, 2); index -= 1;
      } else if (/[>+~]$/.test(parts[index]) && index < parts.length - 1) {
        parts[index] += parts[index + 1]; parts.splice(index + 1, 1); index -= 1;
      } else if (/^[>+~]/.test(parts[index]) && index > 0) {
        parts[index - 1] += parts[index]; parts.splice(index, 1); index -= 1;
      }
    }
    return parts.filter(Boolean);
  };

  const queryShadowAware = (selector, root) => {
    const matches = [], visited = new Set();
    const visit = (scope) => {
      if (!scope || visited.has(scope) || typeof scope.querySelectorAll !== 'function') return;
      visited.add(scope);
      matches.push(...[...scope.querySelectorAll(selector)].filter((element) => !isInsidePickerUi(element)));
      const descendants = [...scope.querySelectorAll('*')];
      const candidates = scope.nodeType === Node.ELEMENT_NODE ? [scope, ...descendants] : descendants;
      for (const element of candidates) {
        if (isInsidePickerUi(element)) continue;
        const shadow = shadowFor(element);
        if (shadow) visit(shadow);
      }
    };
    visit(root);
    return unique(matches);
  };

  // Non-JavaScript locators are intentionally evaluated against the cloned
  // capture document.  Apart from making filtering self-contained, this keeps
  // transient page state (`:focus`, `:hover`, form validity, etc.) out of a
  // saved monitor result, which is how the reference capture pipeline works.
  const queryXcss = (selector, rootDocument = document) => {
    const result = [];
    for (const branch of splitUnion(selector)) {
      let roots = [rootDocument];
      for (const step of splitSteps(branch)) {
        roots = unique(roots.flatMap((root) => queryShadowAware(step, root)));
        if (!roots.length) break;
      }
      result.push(...roots);
    }
    return unique(result);
  };

  const select = (locator, rootDocument = document) => {
    if (locator.type === 'css') return [...rootDocument.querySelectorAll(locator.expr)]
      .filter((element) => !isInsidePickerUi(element))
      .map((element) => ({ element }));
    if (locator.type === 'xcss') return queryXcss(locator.expr, rootDocument).map((element) => ({ element }));
    // The current Reference locator evaluates XPath relative to the cloned
    // document's first element (<html>), not the Document node itself. This
    // only changes relative expressions such as `.` and `./body`; CSS/XCSS
    // intentionally remain Document-scoped above.
    const xpathContext = rootDocument.firstElementChild || rootDocument;
    const iterator = rootDocument.evaluate(
      locator.expr,
      xpathContext,
      (prefix) => prefix === 'xhtml' ? 'http://www.w3.org/1999/xhtml' : null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE,
      null
    );
    const matches = [];
    for (let node = iterator.iterateNext(); node; node = iterator.iterateNext()) {
      if (node.nodeType === Node.ATTRIBUTE_NODE && node.ownerElement) {
        // Attribute nodes are only promoted to their owner for an XPath
        // *exclude* below.  An XPath include operates on the raw node in the
        // reference filter and therefore cannot turn `//@href` into a whole
        // element include.
        matches.push({ element: node.ownerElement, attributeName: node.name, attributeNode: true });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        matches.push({ element: node });
      } else {
        // Preserve the locator's raw match count for text/comment/document
        // XPath results, while correctly leaving them without an element
        // marker. jQuery marker operations in the reference are element-only.
        matches.push({ element: null, nonElementNode: true });
      }
    }
    const seen = new Map();
    return matches.filter((match) => {
      if (!match.element) return true;
      if (isInsidePickerUi(match.element)) return false;
      const names = seen.get(match.element) || new Set();
      const key = match.attributeName || '';
      if (names.has(key)) return false;
      names.add(key);
      seen.set(match.element, names);
      return true;
    });
  };

  const parentAcrossShadow = (element) => element.parentElement || element.getRootNode?.().host || null;
  const containsAcrossShadow = (ancestor, element) => {
    for (let current = element; current; current = parentAcrossShadow(current)) if (current === ancestor) return true;
    return false;
  };
  const outerHost = (element) => {
    let current = element;
    for (let root = current.getRootNode?.(); root?.host; root = current.getRootNode?.()) current = root.host;
    return current;
  };
  const compare = (left, right) => {
    if (left === right) return 0;
    if (containsAcrossShadow(left, right)) return -1;
    if (containsAcrossShadow(right, left)) return 1;
    const position = outerHost(left).compareDocumentPosition(outerHost(right));
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  };

  const fieldValues = (element, fields) => fields.filter((field) => field.type !== 'text').map((field) => {
    try {
      return field.type === 'attribute'
        ? element.hasAttribute(field.name) ? element.getAttribute(field.name) || '' : 'undefined'
        : element[field.name] || '';
    } catch { return ''; }
  }).map(String);

  const fieldPayloadKey = '__openStillCaptureFieldPayload__';
  const writeText = (root) => {
    const out = [];
    // Text and HTML are both read from the same already-filtered clone. This
    // prevents a removed inline style or excluded subtree from influencing the
    // text-only comparison through the original live DOM.
    const children = (node) => {
      const result = node?.localName === 'template'
        ? [...node.content.childNodes]
        : [...(node?.childNodes || [])];
      if (node?.shadowRoot) result.push(...node.shadowRoot.childNodes);
      if (node?.__openStillCaptureShadow) result.push(...node.__openStillCaptureShadow.childNodes);
      return result;
    };
    const visit = (node, parentTextMode = true) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (parentTextMode) out.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const payload = node[fieldPayloadKey] || null;
      // Script/style/noscript content is structural data unless a caller
      // explicitly selected fields on that exact element. Frame elements are
      // normally pruned, but their explicit attribute/property fields remain
      // readable when deliberately included.
      if (['noscript', 'script', 'style'].includes(String(node.localName || node.tagName || '').toLowerCase()) && !payload) return;

      const selectedFields = payload?.fields || [];
      const textMode = payload
        ? selectedFields.some((field) => field.type === 'text')
        : parentTextMode;
      const nonTextValues = payload?.values || [];
      // `getFieldValues()` in the reference always writes its joined value
      // followed by a newline, including an explicit empty/text-only field
      // list. That separator is observable when a field-mode child sits
      // between inherited text runs.
      if (payload) out.push(nonTextValues.join('\n'), '\n');

      if (textMode) {
        // The reference obtains display from its detached cloned document.
        // Do not leak computed styles or inline display values from the live
        // page into this normalized payload: Chromium normally reports an
        // empty display for that detached clone, leaving only the reference's
        // explicit breaking-element list as a stable fallback.
        let computedDisplay = '';
        try { computedDisplay = String(globalThis.getComputedStyle?.(node)?.display || '').toLowerCase(); } catch { /* detached style lookup is optional */ }
        const block = computedDisplay === 'block' || blockTags.has(node.tagName);
        out.push(block ? '\n' : spacedTags.has(node.tagName) ? ' ' : '');
      }
      // The clone writes light DOM children first and serializes shadow trees
      // as an ordinary following template. Do not follow slot assignments:
      // that would turn the filtered document tree into a composed graph and
      // change both ordering and duplication semantics.
      children(node).forEach((child) => visit(child, textMode));
    };
    visit(root, true);
    // Preserve the reference trim/compact order exactly: form-feed and
    // vertical-tab are not silently rewritten before a regexp filter sees
    // the extracted text.
    return out.join('').trim().replace(/\s*\n+(\s*\n+)*/g, '\n').replace(/[ \t]+/g, ' ');
  };

  const cloneCaptureDocument = () => {
    const targetDocument = document.implementation.createHTMLDocument('');
    const copy = (node, insideShadow = false) => {
      if (node.nodeType === Node.TEXT_NODE) return targetDocument.createTextNode(node.nodeValue || '');
      // Keep comments through selector evaluation even for an XCSS capture:
      // XPath predicates can rely on them. Filtering/serialization decides
      // later whether they are retained or emitted.
      if (node.nodeType === Node.COMMENT_NODE) return targetDocument.createComment(node.nodeValue || '');
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const clone = targetDocument.importNode(node, false);
      if (insideShadow) clone.__openStillCaptureShadowContext = true;
      [...node.childNodes].forEach((child) => { const next = copy(child, insideShadow); if (next) clone.append(next); });
      // The clone must retain a real, open shadow tree. CSS/XPath never cross
      // it, while XCSS can query it exactly as it would the source's closed or
      // open tree. Serialization decides separately whether to emit it.
      const shadow = shadowFor(node);
      if (shadow?.childNodes) {
        let shadowClone;
        try { shadowClone = clone.shadowRoot || clone.attachShadow({ mode: 'open' }); } catch {
          shadowClone = targetDocument.createDocumentFragment();
          clone.__openStillCaptureShadow = shadowClone;
        }
        Array.from(shadow.childNodes ?? []).forEach((child) => { const next = copy(child, true); if (next) shadowClone.append(next); });
      }
      return clone;
    };
    const rootCopy = copy(document.documentElement);
    if (!rootCopy) return null;
    targetDocument.replaceChild(rootCopy, targetDocument.documentElement);
    return { targetDocument, rootCopy };
  };

  const makeHtml = (captureClone, included, excluded, automaticallyIncluded, excludedAttributes, fields = new Map(), structuralContext = new Set()) => {
    const { targetDocument, rootCopy } = captureClone || {};
    if (!targetDocument || !rootCopy) return { html: '', text: '' };
    // The reference filter marks the cloned <html> as structural before
    // removing unmatched descendants. Retain that shell even on data:/about:
    // documents where no automatic <base> can provide a retained child.
    const structuralNodes = new Set(structuralContext);
    structuralNodes.add(rootCopy);
    included.forEach((node) => node?.setAttribute?.(includeMark, '1'));
    excluded.forEach((node) => node?.setAttribute?.(excludeMark, '1'));
    automaticallyIncluded.forEach((node) => node?.setAttribute?.(automaticIncludeMark, '1'));
    const children = (node) => {
      const result = node.localName === 'template' ? [...node.content.childNodes] : [...node.childNodes];
      if (node.shadowRoot) result.push(...node.shadowRoot.childNodes);
      if (node.__openStillCaptureShadow) result.push(...node.__openStillCaptureShadow.childNodes);
      return result;
    };
    const prune = (node, active = false, parentStructural = false) => {
      if (node.nodeType === Node.TEXT_NODE) { if (!active) node.remove(); return active; }
      // `filterDoc` removes text from a has-include context but leaves its
      // direct comments when requested. A true include keeps all descendants;
      // a structural context only keeps comments directly attached to it.
      if (node.nodeType === Node.COMMENT_NODE) {
        const retainComment = keepComments && (active || parentStructural);
        if (!retainComment) node.remove();
        return retainComment;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); return false; }
      // Explicit and automatic includes both win over the global script/style
      // exclusion. Automatic base/style/script locators are ordinary include
      // rules in the reference pipeline, so a matching exclude must not erase
      // them after they were added for structural context.
      if (isIgnoredElement(node, node.__openStillCaptureShadowContext === true)
        && !node.hasAttribute(includeMark)
        && !node.hasAttribute(automaticIncludeMark)) { node.remove(); return false; }
      let enabled = active;
      if (node.hasAttribute(includeMark) || node.hasAttribute(automaticIncludeMark)) enabled = true;
      else if (node.hasAttribute(excludeMark)) enabled = false;
      const retained = children(node).map((child) => prune(child, enabled, structuralNodes.has(node))).some(Boolean);
      // An XCSS result needs hosts, shadow ancestors, and slot paths as
      // structure, but those nodes are not text inclusions in their own
      // right. Keeping the context lets a slotted include survive without
      // accidentally turning surrounding fallback text into tracked text.
      if (!enabled && !retained && !structuralNodes.has(node)) { node.remove(); return false; }
      return true;
    };
    prune(rootCopy);
    // Attribute excludes are represented as xdel-* markers in the reference
    // pipeline and removed only after element filtering. Removing `as`/`rel`
    // earlier can disguise a script-preload or stylesheet from the automatic
    // exclusion rules and accidentally retain its whole element.
    excludedAttributes.forEach((names, node) => {
      if (!node) return;
      names.forEach((name) => node.removeAttribute(name));
    });
    // Reference excludes only data: documents. An about:blank document can
    // still carry an explicit <base>, whose href/src properties must be made
    // absolute in the captured clone.
    const canNormalizeLinks = !/^data:/i.test(String(location?.protocol || document.baseURI || ''));
    const absolute = (value) => { try { return new URL(value ?? '', document.baseURI).href; } catch { return String(value ?? ''); } };
    const normalizeUrlAttribute = (node, name) => {
      // HTML URL properties return an empty string when the corresponding
      // attribute is absent. Do not invent a page-URL link for `<a>`/`<img>`
      // without href/src; reference normalization serializes that case as an
      // explicit empty attribute.
      const raw = node.getAttribute(name);
      node.setAttribute(name, raw === null ? '' : absolute(raw));
    };
    const sanitize = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const insideShadow = node.__openStillCaptureShadowContext === true;
      for (const attribute of [...node.attributes]) {
        const internalMarker = [includeMark, excludeMark, automaticIncludeMark].includes(attribute.name);
        if (internalMarker || (!insideShadow && ((/^on/i.test(attribute.name) && !includeInlineScripts)
          || (attribute.name === 'style' && !includeStyles)))) {
          node.removeAttribute(attribute.name);
        }
      }
      if (!insideShadow && canNormalizeLinks && node.matches('a')) normalizeUrlAttribute(node, 'href');
      if (!insideShadow && canNormalizeLinks && node.matches('img,audio,video')) normalizeUrlAttribute(node, 'src');
      children(node).forEach(sanitize);
    };
    sanitize(rootCopy);
    // Field extraction occurs after the clone has had automatic/user
    // attribute exclusions and URL normalization applied. In particular,
    // `style` and `on*` fields must not leak through when their corresponding
    // structural capture option is disabled.
    fields.forEach((payload, node) => {
      if (!node) return;
      const selectedFields = payload.fields.map((field) => ({ ...field }));
      node[fieldPayloadKey] = {
        fields: selectedFields,
        values: fieldValues(node, selectedFields)
      };
    });
    const text = writeText(rootCopy);
    const serializeWithShadow = (node) => {
      // The declarative-shadow serializer has an element/text-only contract.
      // Comments remain available to CSS/XPath filtering above, but never
      // appear in an XCSS HTML snapshot.
      if (node.nodeType === Node.COMMENT_NODE) return '';
      if (node.nodeType !== Node.ELEMENT_NODE) {
        const holder = targetDocument.createElement('div');
        holder.append(node.cloneNode(true));
        return holder.innerHTML;
      }
      // Let the platform serialize the opening/closing tag so namespaces and
      // escaped attributes stay browser-correct, then place a declarative
      // shadow template before the element's light-DOM children. This is the
      // XCSS snapshot order; text keeps its separate light-then-shadow walk.
      const shell = node.cloneNode(false).outerHTML;
      const openingEnd = shell.indexOf('>') + 1;
      const closingStart = shell.lastIndexOf('</');
      if (!openingEnd || closingStart < openingEnd) return shell;
      const shadow = node.shadowRoot || node.__openStillCaptureShadow || null;
      const shadowHtml = shadow
        ? `<template shadowrootmode="open">${[...shadow.childNodes].map(serializeWithShadow).join('')}</template>`
        : '';
      const lightChildren = node.localName === 'template'
        ? [...node.content.childNodes]
        : [...node.childNodes];
      return shell.slice(0, openingEnd)
        + shadowHtml
        + lightChildren.map(serializeWithShadow).join('')
        + shell.slice(closingStart);
    };
    return {
      html: (usesExtendedCss ? serializeWithShadow(rootCopy) : rootCopy.outerHTML).trim().replace(/\s*\n+(\s*\n+)*/g, '\n'),
      text
    };
  };

  const ensureCaptureBase = () => {
    if (/^(?:data|about):/i.test(String(document.baseURI || location?.protocol || ''))) return null;
    let base = document.getElementsByTagName('base')[0] || null;
    if (!base) {
      base = document.createElement('base');
      const head = document.getElementsByTagName('head')[0];
      if (head) head.prepend(base);
    }
    try {
      const href = String(document.baseURI || '');
      // Rewriting an identical attribute still emits a MutationObserver
      // record in Chromium. Capture may run under a live observer, so keep
      // the reference base normalization idempotent after its first write.
      if (base.getAttribute('href') !== href) base.setAttribute('href', href);
    } catch { /* preserve the page's original base on malformed URLs */ }
    return base;
  };

  const makeErrorEvidence = () => {
    const targetDocument = document.implementation.createHTMLDocument('');
    const rootCopy = targetDocument.importNode(document.documentElement, true);
    targetDocument.replaceChild(rootCopy, targetDocument.documentElement);
    const selfAndDescendants = (selector) => {
      const nodes = [...rootCopy.querySelectorAll(selector)];
      try { if (rootCopy.matches(selector)) nodes.push(rootCopy); } catch { /* selector is internal and fixed */ }
      return nodes;
    };
    selfAndDescendants('script,noscript').forEach((node) => {
      node.textContent = '';
      node.removeAttribute('src');
    });
    selfAndDescendants('link[as="script"]').forEach((node) => node.removeAttribute('href'));
    selfAndDescendants('[integrity]').forEach((node) => node.removeAttribute('integrity'));
    selfAndDescendants('head iframe,head frame').forEach((node) => {
      node.replaceWith(targetDocument.createElement('script'));
    });
    selfAndDescendants('iframe,frame').forEach((node) => {
      node.setAttribute('src', 'about:blank');
      node.removeAttribute('srcdoc');
    });
    selfAndDescendants('a').forEach((node) => {
      node.removeAttribute('target');
      node.setAttribute('target', '_blank');
    });
    const stripEvents = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      [...node.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      });
      [...node.childNodes].forEach(stripEvents);
    };
    stripEvents(rootCopy);
    return rootCopy.outerHTML.trim().replace(/\s*\n+(\s*\n+)*/g, '\n');
  };

  const waitForStable = async () => {
    const root = document.documentElement;
    if (!root) return;
    const min = Math.max(0, Number(minimumWaitMilliseconds) || 0);
    const quiet = Math.max(0, Number(quietMilliseconds) || 0);
    const limit = Math.max(min, Number(settleTimeoutMilliseconds) || min);
    if (!min && !quiet && !limit) return;
    await new Promise((resolve) => {
      const started = performance.now(); let changed = started;
      const observer = new MutationObserver(() => { changed = performance.now(); });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const check = () => {
        const now = performance.now();
        if ((now - started >= min && now - changed >= quiet) || now - started >= limit) { observer.disconnect(); resolve(); }
        else setTimeout(check, Math.max(25, Math.min(100, quiet || 80)));
      };
      setTimeout(check, Math.max(25, Math.min(100, quiet || 80)));
    });
  };

  const capture = () => {
    // The base is part of the source document before selectors run, so a
    // locator targeting `base` observes the same document shape as the saved
    // filtered snapshot.
    ensureCaptureBase();
    const captureClone = cloneCaptureDocument();
    if (!captureClone) return { roots: [], matchCount: 0, items: [], text: '', html: '', selectorMatches: [] };
    const { targetDocument } = captureClone;
    const included = new Set();
    const excluded = new Set();
    const automaticallyIncluded = new Set();
    const excludedAttributes = new Map();
    const fields = new Map();
    const structuralContext = new Set();
    const markLightStructuralContext = (element) => {
      // CSS/XPath `markInclude()` marks every light-DOM parent with
      // hasinclude__. That marker removes direct text but intentionally keeps
      // direct comments when keepComments is enabled.
      for (let current = element?.parentElement || null; current; current = current.parentElement) {
        structuralContext.add(current);
      }
    };
    const markSlotsForHost = (host) => {
      const shadow = shadowFor(host);
      if (!shadow?.querySelectorAll) return;
      for (const slot of shadow.querySelectorAll('slot')) {
        for (let current = slot; current?.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
          structuralContext.add(current);
        }
      }
    };
    const markXcssStructuralContext = (element) => {
      let parent = element?.parentNode || null;
      let currentRoot = element?.getRootNode?.() || targetDocument;
      const visited = new Set();
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        if (parent.nodeType === Node.ELEMENT_NODE) {
          structuralContext.add(parent);
          markSlotsForHost(parent);
        }
        if (parent === currentRoot && currentRoot !== targetDocument) {
          const host = currentRoot.host;
          if (host) {
            structuralContext.add(host);
            markSlotsForHost(host);
            parent = host.parentNode;
            currentRoot = host.getRootNode?.() || targetDocument;
            continue;
          }
        }
        parent = parent.parentNode;
      }
    };
    const selectorMatches = [];
    for (const locator of locators) {
      const matches = select(locator, targetDocument);
      if (locator.type === 'xcss') {
        usesExtendedCss = true;
        globalThis[xcssSerializerStateKey] = true;
      }
      selectorMatches.push(locator.legacy
        ? { selector: locator.expr, matchCount: matches.length }
        : { type: locator.type, expr: locator.expr, op: locator.op, matchCount: matches.length });
      matches.forEach(({ element, attributeName }) => {
        if (!element) return;
        if (attributeName) {
          if (locator.op === 'exclude') {
            const names = excludedAttributes.get(element) || new Set();
            names.add(attributeName);
            excludedAttributes.set(element, names);
          }
          // XPath attribute includes do not make the owner an include. This
          // distinction is what lets XPath attribute exclusions work without
          // giving the attribute form a different CSS/XCSS selection reach.
          return;
        }
        (locator.op === 'include' ? included : excluded).add(element);
        if (locator.op === 'include') {
          if (locator.type === 'xcss') markXcssStructuralContext(element);
          else markLightStructuralContext(element);
        }
        if (locator.op === 'include' && locator.fieldsSpecified) {
          // An explicit field list is a per-node mode override. A later
          // omitted list deliberately leaves a preceding explicit [] or text
          // mode intact instead of flattening it back to default text.
          const copiedFields = locator.fields.map((field) => ({ ...field }));
          fields.set(element, {
            fields: copiedFields
          });
        }
      });
    }
    for (const selector of adblockerSelectors()) {
      try {
        targetDocument.querySelectorAll(selector).forEach((element) => excluded.add(element));
      } catch {
        // Cosmetic filters can use browser-specific selector syntax. Ignore an
        // incompatible rule while preserving the user's explicit locators.
      }
    }
    if (includeInlineScripts) {
      // Reference adds this automatic include with the XPath
      // `//script[not(@src)]`. In an HTML document that selects HTML script
      // elements, not SVG's namesake element. Detached clone documents may
      // expose imported HTML nodes with a nonstandard/null namespace in some
      // Chromium paths, so exclude SVG explicitly rather than requiring the
      // XHTML namespace literal.
      [...targetDocument.querySelectorAll('script:not([src])')]
        .filter((element) => element.namespaceURI !== 'http://www.w3.org/2000/svg')
        .forEach((element) => {
          automaticallyIncluded.add(element);
          markLightStructuralContext(element);
        });
    }
    if (includeStyles) {
      targetDocument.querySelectorAll('style, link[rel="stylesheet"]').forEach((element) => {
        automaticallyIncluded.add(element);
        markLightStructuralContext(element);
      });
    }
    // A captured fragment still needs its document base to keep relative
    // resources and links meaningful when it is rendered later.
    targetDocument.querySelectorAll('base').forEach((element) => {
      automaticallyIncluded.add(element);
      markLightStructuralContext(element);
    });
    const rootCandidates = [...included, ...automaticallyIncluded];
    const roots = rootCandidates
      .filter((element) => !rootCandidates.some((candidate) => candidate !== element && containsAcrossShadow(candidate, element)))
      .sort(compare);
    // Automatic base/style/script retention is structural context, not a user
    // selector match. Keep its markup without turning a zero-match locator
    // into a false successful match count.
    const matchedRoots = [...included]
      .filter((element) => ![...included].some((candidate) => candidate !== element && containsAcrossShadow(candidate, element)))
      .sort(compare);
    // Text is produced by one traversal of the filtered document. Joining
    // per-root strings invents blank boundaries that do not exist in the DOM
    // and turns harmless wrapper/list changes into alerts.
    const filtered = makeHtml(captureClone, included, excluded, automaticallyIncluded, excludedAttributes, fields, structuralContext);
    const text = filtered.text;
    const items = text ? [{ text }] : [];
    const html = filtered.html;
    return { roots, matchCount: matchedRoots.length, items, text, html, selectorMatches };
  };

  // Reference live.js disconnects its observer before calling the filter. The
  // clone pipeline can normalize the source <base>, so do the same around the
  // complete live capture transaction to avoid feeding that write back in.
  liveObserverRecord?.pause?.();
  try {
    if (!includeLocators.length) return { ok: true, exists: false, matchCount: 0, items: [], html: '', data: '', selectorMatches: [] };
    // Live content checks run immediately on the mutation callback; page
    // settling is a scheduled-render concern only.
    if (!captureOptions?.live) await waitForStable();
    const configuredDelay = Math.max(0, Math.min(60_000, Number(captureOptions?.delayMilliseconds) || 0));
    if (configuredDelay) await new Promise((resolve) => setTimeout(resolve, configuredDelay));
    let result = capture();
    // The reference frame filter appends HTML before deciding whether an
    // empty-text retry is needed. Preserve every attempt in data mode rather
    // than silently replacing an earlier structural snapshot with the final
    // retry's markup.
    let capturedData = result.html;
    // HTML/data comparison still needs a nonempty selected text result to
    // distinguish a real page from a broken selection, but the reference
    // runner limits that mode to two delayed retries rather than waiting the
    // full text-monitor retry budget.
    const retryLimit = captureOptions?.dataAttr === 'data'
      ? Math.min(1, Math.max(0, Number(emptyRetryCount) || 0))
      : Math.max(0, Number(emptyRetryCount) || 0);
    for (let attempt = 0; !captureOptions?.live && !result.text && attempt <= retryLimit; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(emptyRetryDelayMilliseconds) || 0)));
      result = capture();
      capturedData += result.html;
    }
    const exists = captureOptions?.allowEmpty ? result.matchCount > 0 : Boolean(result.text);
    // Empty selection evidence must show the whole rendered page, not merely
    // the matched-but-textless fragment. That makes login walls, redirects,
    // and page-layout changes diagnosable without overwriting the baseline.
    // A regexp can turn an otherwise successful selection into an empty
    // tracking result later in the worker. Request the same sanitized page
    // evidence up front for that case, then retain it only if filtering really
    // produces a selection-empty outcome.
    const errorHtml = !exists || captureOptions?.captureErrorEvidence === true ? makeErrorEvidence() : '';
    return {
      ok: true,
      exists,
      matchCount: result.matchCount,
      items: result.items,
      text: result.text,
      html: result.html,
      data: capturedData,
      errorHtml,
      selectorMatches: result.selectorMatches
    };
  } catch (error) {
    return { ok: false, error: 'Selector capture could not be evaluated: ' + error.message };
  } finally {
    liveObserverRecord?.resume?.();
  }
}

// Reference-compatible CSS monitor capture. All scheduled captures use this
// clone/filter/text pipeline rather than the old root-innerText collector.
async function captureLegacyRenderedDocumentCollection(
  selectors,
  minimumWaitMilliseconds,
  quietMilliseconds,
  settleTimeoutMilliseconds,
  emptyRetryCount = 4,
  emptyRetryDelayMilliseconds = 5_000
) {
  const selectorList = Array.isArray(selectors)
    ? selectors.filter((selector) => typeof selector === 'string' && selector.trim())
    : [];
  const root = document.documentElement;
  if (root) {
    await new Promise((resolve) => {
      const startedAt = performance.now();
      let lastMutationAt = startedAt;
      const observer = new MutationObserver(() => {
        lastMutationAt = performance.now();
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const tick = () => {
        const now = performance.now();
        const elapsed = now - startedAt;
        if ((elapsed >= minimumWaitMilliseconds && now - lastMutationAt >= quietMilliseconds) || elapsed >= settleTimeoutMilliseconds) {
          observer.disconnect();
          resolve();
          return;
        }
        setTimeout(tick, Math.min(100, quietMilliseconds));
      };
      setTimeout(tick, Math.min(100, quietMilliseconds));
    });
  }

  const blockElements = new Set([
    'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'CODE', 'DD', 'DIV', 'FIELDSET', 'FOOTER', 'FORM',
    'HEADER', 'LI', 'OL', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR',
    'UL', 'IMG', 'BR'
  ]);
  const spacedElements = new Set(['A', 'ABBR', 'ACRONYM', 'ADDRESS', 'BUTTON', 'TD']);
  const excludedElements = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'FRAME', 'IFRAME']);
  const markerInclude = 'data-openstill-reference-include';
  const markerAncestor = 'data-openstill-reference-ancestor';

  const compareDocumentOrder = (left, right) => {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  };

  const rootsFor = (elements) => [...elements].filter((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (elements.has(parent)) return false;
    }
    return true;
  }).sort(compareDocumentOrder);

  // This mirrors the reference extractor rather than using innerText:
  // preserve block boundaries, retain CSS-hidden text, and ignore only the
  // same non-content elements filtered by the monitor.
  const textForElement = (element) => {
    const buffer = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || excludedElements.has(node.tagName)) return;
      let isBlock = blockElements.has(node.tagName);
      try {
        isBlock = isBlock || getComputedStyle(node).display === 'block';
      } catch {
        // The semantic block list covers detached or transient elements.
      }
      if (isBlock) buffer.push('\n');
      else if (spacedElements.has(node.tagName)) buffer.push(' ');
      for (const child of node.childNodes) visit(child);
    };
    visit(element);
    return buffer.join('')
      .trim()
      .replace(/\s*\n+(\s*\n+)*/g, '\n')
      .replace(/[ \t]+/g, ' ');
  };

  const pathFromDocumentRoot = (element) => {
    const path = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const parent = current.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return current === document.documentElement ? path : null;
  };

  const nodeAtPath = (cloneRoot, path) => {
    let current = cloneRoot;
    for (const index of path ?? []) {
      current = current?.childNodes[index];
      if (!current) return null;
    }
    return current;
  };

  const cleanClone = (cloneRoot) => {
    const walker = cloneRoot.ownerDocument.createTreeWalker(cloneRoot, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((comment) => comment.remove());
    cloneRoot.querySelectorAll('script, style, noscript, frame, iframe, link[as="script"], link[rel="stylesheet"]').forEach((node) => node.remove());
    cloneRoot.querySelectorAll('*').forEach((node) => {
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name) || attribute.name === 'style' || attribute.name === 'integrity') {
          node.removeAttribute(attribute.name);
        }
      }
    });
    const absoluteUrl = (value) => {
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return value;
      }
    };
    cloneRoot.querySelectorAll('a[href]').forEach((node) => node.setAttribute('href', absoluteUrl(node.getAttribute('href'))));
    cloneRoot.querySelectorAll('audio[src], img[src], video[src]').forEach((node) => node.setAttribute('src', absoluteUrl(node.getAttribute('src'))));
  };

  // Build the same filtered HTML shape as the reference: retain selected
  // subtrees and the minimum ancestor path, discard all unrelated page churn.
  const filteredHtmlForRoots = (roots) => {
    if (!roots.length || !document.documentElement) return '';
    const clonedDocument = document.implementation.createHTMLDocument('');
    const cloneRoot = document.documentElement.cloneNode(true);
    clonedDocument.replaceChild(cloneRoot, clonedDocument.documentElement);
    for (const rootElement of roots) {
      const clone = nodeAtPath(cloneRoot, pathFromDocumentRoot(rootElement));
      if (!clone || clone.nodeType !== Node.ELEMENT_NODE) continue;
      clone.setAttribute(markerInclude, '1');
      for (let parent = clone.parentElement; parent; parent = parent.parentElement) {
        parent.setAttribute(markerAncestor, '1');
      }
    }
    const prune = (node, insideIncluded = false) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!insideIncluded) node.remove();
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node.remove();
        return;
      }
      if (excludedElements.has(node.tagName)) {
        node.remove();
        return;
      }
      const included = insideIncluded || node.hasAttribute(markerInclude);
      if (!included && !node.hasAttribute(markerAncestor)) {
        node.remove();
        return;
      }
      for (const child of [...node.childNodes]) prune(child, included);
    };
    prune(cloneRoot);
    cleanClone(cloneRoot);
    cloneRoot.removeAttribute(markerInclude);
    cloneRoot.removeAttribute(markerAncestor);
    cloneRoot.querySelectorAll(`[${markerInclude}], [${markerAncestor}]`).forEach((node) => {
      node.removeAttribute(markerInclude);
      node.removeAttribute(markerAncestor);
    });
    return cloneRoot.outerHTML;
  };

  const capture = () => {
    const selected = new Set();
    const selectorMatches = [];
    for (const selector of selectorList) {
      const matches = [...document.querySelectorAll(selector)];
      selectorMatches.push({ selector, matchCount: matches.length });
      matches.forEach((element) => selected.add(element));
    }
    const roots = rootsFor(selected);
    const items = roots.map((element) => ({ text: textForElement(element) }));
    const filteredHtml = filteredHtmlForRoots(roots);
    const text = items.map((item) => item.text).filter(Boolean).join('\n\n');
    return { roots, items, text, html: filteredHtml, selectorMatches };
  };

  try {
    if (!selectorList.length) {
      return { ok: true, exists: false, matchCount: 0, items: [], selectorMatches: [] };
    }
    let result = capture();
    // Reference runner begins at retryCount 0 and retries while it is <= 4,
    // giving six total attempts and five 5-second waits for an empty selection.
    for (let retryCount = 0; !result.text && retryCount <= emptyRetryCount; retryCount += 1) {
      await new Promise((resolve) => setTimeout(resolve, emptyRetryDelayMilliseconds));
      result = capture();
    }
    return {
      ok: true,
      exists: Boolean(result.text),
      matchCount: result.roots.length,
      items: result.items,
      html: result.html,
      selectorMatches: result.selectorMatches
    };
  } catch (error) {
    return { ok: false, error: 'CSS selector could not be evaluated: ' + error.message };
  }
}

async function inspectLegacyRenderedDocumentCollection(selectors, minimumWaitMilliseconds, quietMilliseconds, settleTimeoutMilliseconds) {
  const selectorList = Array.isArray(selectors) ? selectors : [];
  const root = document.documentElement;
  if (root) {
    await new Promise((resolve) => {
      const startedAt = performance.now();
      let lastMutationAt = startedAt;
      const observer = new MutationObserver(() => {
        lastMutationAt = performance.now();
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      const tick = () => {
        const now = performance.now();
        const elapsed = now - startedAt;
        if ((elapsed >= minimumWaitMilliseconds && now - lastMutationAt >= quietMilliseconds) || elapsed >= settleTimeoutMilliseconds) {
          observer.disconnect();
          resolve();
          return;
        }
        setTimeout(tick, Math.min(100, quietMilliseconds));
      };
      setTimeout(tick, Math.min(100, quietMilliseconds));
    });
  }

  try {
    const selected = new Set();
    for (const selector of selectorList) {
      document.querySelectorAll(selector).forEach((element) => selected.add(element));
    }

    const roots = [...selected].filter((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (selected.has(parent)) return false;
      }
      return true;
    }).sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return {
      ok: true,
      exists: roots.length > 0,
      matchCount: roots.length,
      items: roots.map((element) => ({
        text: String(element.innerText || element.textContent || '').slice(0, 10_000)
      }))
    };
  } catch (error) {
    return { ok: false, error: 'CSS 선택자를 해석할 수 없습니다: ' + error.message };
  }
}

// This is intentionally self-contained because chrome.scripting serializes a
// `func` into the target frame without its lexical scope.  It mirrors the
// reference runner's page-level `getSanitizedDoc` call, which is used as
// selection-empty evidence regardless of which configured subframe failed.
function captureSanitizedErrorEvidenceDocument() {
  try {
    const baseURI = String(document.baseURI || '');
    if (!/^(?:data:|about:)/.test(baseURI)) {
      let base = document.getElementsByTagName('base')[0] || null;
      if (!base) {
        base = document.createElement('base');
        const head = document.getElementsByTagName('head')[0];
        if (head) head.prepend(base);
      }
      base?.setAttribute('href', baseURI);
    }

    const clonedDocument = document.cloneNode(true);
    const root = clonedDocument.documentElement;
    if (!root) return { ok: true, html: '' };
    const selfAndDescendants = (selector) => {
      const matches = [...root.querySelectorAll(selector)];
      try { if (root.matches(selector)) matches.push(root); } catch { /* fixed internal selector */ }
      return matches;
    };
    selfAndDescendants('script,noscript').forEach((node) => {
      node.textContent = '';
      node.removeAttribute('src');
    });
    selfAndDescendants('link[as="script"]').forEach((node) => node.removeAttribute('href'));
    selfAndDescendants('[integrity]').forEach((node) => node.removeAttribute('integrity'));
    selfAndDescendants('head iframe,head frame').forEach((node) => {
      node.replaceWith(clonedDocument.createElement('script'));
    });
    selfAndDescendants('iframe,frame').forEach((node) => {
      node.setAttribute('src', 'about:blank');
      node.removeAttribute('srcdoc');
    });
    selfAndDescendants('a').forEach((node) => {
      node.removeAttribute('target');
      node.setAttribute('target', '_blank');
    });
    const stripEventAttributes = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      [...node.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      });
      [...node.childNodes].forEach(stripEventAttributes);
    };
    stripEventAttributes(root);
    return {
      ok: true,
      html: root.outerHTML.trim().replace(/\s*\n+(\s*\n+)*/g, '\n')
    };
  } catch (error) {
    return { ok: false, error: 'Could not sanitize page evidence: ' + (error?.message || String(error)) };
  }
}

async function captureRenderedSnapshot(monitor, existingTabId = null, { live = false, frameId: liveFrameId = null } = {}) {
  // Pinned tabs are Chrome's favicon-only, leftmost tab UI. They make a
  // scheduled check visible without taking focus or leaving a titled tab in
  // the strip; a live watcher passes its extension-owned tab, which this
  // function deliberately leaves open after reusing the same capture path.
  const ownsTab = !Number.isInteger(existingTabId);
  const tab = ownsTab ? await chrome.tabs.create({
    url: monitor.url,
    active: false,
    pinned: true,
    index: 0
  }) : { id: existingTabId };
  if (!Number.isInteger(tab?.id)) {
    throw new Error('Could not create a background tab for checking.');
  }

  let ready;
  try {
    if (ownsTab) {
      ready = waitForRenderedTab(tab.id);
      await ready.promise;
    }
    const requestedLiveFrame = live && Number.isInteger(liveFrameId) ? liveFrameId : null;
    let frames = [{ frameId: 0, parentFrameId: -1 }];
    if (monitor.locators.some((locator) => locator.frameId !== 0 || locator.framePath?.length)
      || (requestedLiveFrame !== null && requestedLiveFrame !== 0)) {
      if (typeof chrome.webNavigation?.getAllFrames !== 'function') throw new Error('Subframe selector capture is unavailable.');
      frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    }
    const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
    const frameGroups = new Map();
    const savedFrameOrder = new Map();
    for (const locator of monitor.locators) {
      const frameId = resolveLocatorFrame(locator, frames);
      // Reference live_init places one independent watcher in every selected
      // frame. A frame mutation filters only that frame rather than rebuilding
      // a cross-frame aggregate for every event.
      if (requestedLiveFrame !== null && frameId !== requestedLiveFrame) continue;
      if (!frameGroups.has(frameId)) frameGroups.set(frameId, []);
      frameGroups.get(frameId).push(locator);
      // Reference Runner orders selected frame configurations by their saved
      // `frame.index`, descending.  A stored `frameOrder` preserves that key
      // across Chrome frame-ID reassignment; legacy records use the original
      // frameId, which is the closest equivalent ordering key they retained.
      const order = Number.isInteger(locator.frameOrder) ? locator.frameOrder : locator.frameId;
      const prior = savedFrameOrder.get(frameId);
      if (!Number.isInteger(prior) || order > prior) savedFrameOrder.set(frameId, order);
    }
    const requestedFrameIds = [...frameGroups.keys()];
    for (const frameId of requestedFrameIds) {
      if (!frameById.has(frameId)) throw new Error(`The configured frame (${frameId}) is not available on this page.`);
    }
    const captures = [];
    const orderedFrames = frames
      .filter((frame) => frameGroups.has(frame.frameId))
      .sort((left, right) => (
        (savedFrameOrder.get(right.frameId) ?? right.frameId)
        - (savedFrameOrder.get(left.frameId) ?? left.frameId)
      ) || right.frameId - left.frameId);
    for (let frameIndex = 0; frameIndex < orderedFrames.length; frameIndex += 1) {
      const frame = orderedFrames[frameIndex];
      // Page settling and a configured delay apply once to the complete
      // capture transaction, before the innermost configured frame. Repeating
      // them for every frame makes a multi-frame monitor wait N times longer
      // and can capture each frame at a different logical page moment.
      const firstFrame = frameIndex === 0;
      let execution;
      try {
        execution = await chrome.scripting.executeScript({
          target: frame.frameId === 0 ? { tabId: tab.id } : { tabId: tab.id, frameIds: [frame.frameId] },
          func: captureReferenceRenderedDocumentCollection,
          args: [frameGroups.get(frame.frameId), firstFrame && !live ? 2_000 : 0, 0, firstFrame && !live ? 2_000 : 0,
            live ? 0 : RENDER_EMPTY_RETRY_COUNT, live ? 0 : RENDER_EMPTY_RETRY_DELAY_MS, {
              allowEmpty: monitor.tracking?.allowEmpty === true,
              delayMilliseconds: firstFrame && !live ? monitor.tracking?.delayMilliseconds ?? 0 : 0,
              includeScript: monitor.tracking?.includeScript === true,
              includeStyle: monitor.tracking?.includeStyle === true,
              keepComments: monitor.tracking?.keepComments === true,
              captureErrorEvidence: Boolean(normalizeTracking(monitor.tracking).regexp),
              dataAttr: monitor.tracking?.dataAttr === 'data' ? 'data' : 'text',
              live: Boolean(live),
              liveMonitorId: live ? monitor.id : null
            }]
        });
      } catch (error) {
        throw new Error(`Could not inspect frame ${frame.frameId}: ${responseError(error)}`);
      }
      const frameResult = execution[0]?.result;
      if (!frameResult?.ok) throw new Error(frameResult?.error || `Could not inspect frame ${frame.frameId}.`);
      captures.push({ frameId: frame.frameId, result: frameResult });
    }
    const result = {
      ok: true,
      selectorMatches: captures.flatMap(({ frameId, result }) => (result.selectorMatches || []).map((match) => ({ ...match, frameId })))
    };
    // The reference runner appends each configured frame's filtered document
    // text in capture order. Keep one aggregate item so snapshot normalization
    // cannot introduce a synthetic separator between frame results.
    const rawText = captures.map(({ result: frameResult }) => {
      // New rendered collectors return their already-normalized aggregate in
      // `text`.  Older persisted/background capture adapters only returned
      // `items`, though, so preserve that real payload instead of converting a
      // successful selection into an empty result during migration.
      if (typeof frameResult.text === 'string') return frameResult.text;
      return Array.isArray(frameResult.items)
        ? frameResult.items.map((item) => String(item?.text ?? '')).join('\n\n')
        : '';
    }).join('');
    result.text = rawText;
    result.items = result.text ? [{ text: result.text }] : [];
    // The reference runner appends each filtered frame document directly to
    // `result.data` (`result.data += html`).  Preserve that byte order rather
    // than wrapping nested <html> documents in dashboard-only markup: wrapper
    // nodes become part of a data-mode comparison and make an unchanged page
    // appear different from the reference result.
    const frameHtml = (frameResult) => typeof frameResult.html === 'string'
      ? frameResult.html
      : typeof frameResult.data === 'string' ? frameResult.data : '';
    const frameData = (frameResult) => typeof frameResult.data === 'string'
      ? frameResult.data
      : frameHtml(frameResult);
    result.data = captures.map(({ result: frameResult }) => frameData(frameResult)).join('');
    result.html = result.data;
    result.matchCount = captures.reduce((total, { result: frameResult }) => (
      total + (Number.isInteger(frameResult.matchCount) ? frameResult.matchCount : Array.isArray(frameResult.items) ? frameResult.items.length : 0)
    ), 0);
    const filteredText = filterCapturedText(rawText, monitor.tracking);
    if (normalizeTracking(monitor.tracking).regexp) {
      // A regular-expression monitor observes the matched aggregate, not each
      // original DOM root.  Keep one ordered item so snapshot normalization
      // cannot reconstruct the unfiltered text from the old root list.
      result.items = [{ text: filteredText }];
    }
    result.text = filteredText;
    // The reference content observer performs its nonempty gate before the
    // live runner applies regexp filtering. Thus a raw selection with no
    // regexp matches is an ordinary empty comparison, not selector failure.
    result.exists = live
      ? Boolean(rawText)
      : monitor.tracking?.allowEmpty ? result.matchCount > 0 : Boolean(result.text);
    if (result.exists) {
      result.errorHtml = '';
    } else if (live) {
      // Suppressed live-empty observations never generate full-page evidence.
      result.errorHtml = '';
    } else {
      // Selection-empty snapshots always come from the top-level document in
      // the reference runner, even if the configured selector lives only in a
      // nested frame.  Do not combine subframe evidence: it would be a
      // different document and cannot explain the page-level load state.
      try {
        const evidenceExecution = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: captureSanitizedErrorEvidenceDocument
        });
        const evidence = evidenceExecution[0]?.result;
        result.errorHtml = evidence?.ok && typeof evidence.html === 'string'
          ? evidence.html
          : captures.find(({ frameId }) => frameId === 0)?.result?.errorHtml || '';
      } catch {
        // Keep the top-frame collector evidence as a narrow compatibility
        // fallback when an environment forbids a second script injection. A
        // subframe result is deliberately never substituted here.
        result.errorHtml = captures.find(({ frameId }) => frameId === 0)?.result?.errorHtml || '';
      }
    }

    const snapshot = normalizeSnapshot({
      exists: Boolean(result.exists),
      matchCount: Number.isInteger(result.matchCount) ? result.matchCount : 0,
      items: result.items,
      text: Array.isArray(result.items) ? result.items.map((item) => item.text).join('\n\n') : '',
      html: result.html,
      data: result.data ?? result.html,
      evidenceHtml: result.errorHtml,
      capturedAt: nowIso()
    });
    if (!snapshot) {
      throw new Error('선택자 목록 결과를 정리하지 못했습니다.');
    }
    if (live) {
      // The value is deliberately non-enumerable: it is needed to reproduce
      // content-side live dedupe, but it is not part of the persisted
      // comparison snapshot (which contains regexp-filtered `text`).
      Object.defineProperty(snapshot, 'liveRawText', {
        value: rawText,
        enumerable: false,
        configurable: true
      });
    }
    return snapshot;
  } finally {
    ready?.cancel();
    if (ownsTab) {
      await chrome.tabs.remove(tab.id).catch(async () => {
        // A browser can occasionally reject removal while a pinned tab is being
        // animated into the strip. Unpin and make one final best-effort removal.
        await chrome.tabs.update(tab.id, { pinned: false }).catch(() => undefined);
        await chrome.tabs.remove(tab.id).catch(() => undefined);
      });
    }
  }
}

// This function is deliberately self-contained because Chrome serializes it
// into the monitored page.  It observes only; the service worker always makes
// the actual typed-locator capture, so live and scheduled checks share one
// filtering, frame, retry, and comparison implementation.
function installLiveMutationObserver(monitorId, revision) {
  const registryKey = '__openStillLiveMutationObservers';
  const registry = globalThis[registryKey] || (globalThis[registryKey] = new Map());
  const existing = registry.get(monitorId);
  if (existing?.revision === revision) {
    return { ok: true, reused: true };
  }
  existing?.observer?.disconnect();
  if (existing?.shadowRescanTimer) clearInterval(existing.shadowRescanTimer);

  const notify = () => {
    try {
      const sent = chrome.runtime.sendMessage({
        type: 'live-monitor-mutated',
        id: monitorId,
        revision,
        observedAt: Date.now()
      });
      sent?.catch?.(() => undefined);
    } catch {
      // A page can be unloading while the isolated world still has an observer.
    }
  };
  const observedRoots = new Set();
  let paused = false;
  const observerOptions = {
    attributes: true,
    attributeFilter: ['class', 'id', 'name', 'value', 'src', 'href'],
    childList: true,
    characterData: true,
    subtree: true
  };
  // The picker is extension UI hosted in a closed shadow tree.  We deliberately
  // pierce page shadow trees for live monitoring, but enrolling our own UI
  // would turn ordinary editor/highlight updates into monitor captures.  A
  // native document observer cannot see into that closed root, so preserve
  // the same boundary when using chrome.dom.openOrClosedShadowRoot().
  const isPickerHost = (element) => String(element?.localName || '').toLowerCase() === 'openstill-picker-root'
    && element.getAttribute?.('data-openstill-picker-ui') === 'true';
  const shadowFor = (element) => {
    const read = (getter) => {
      try { return getter() || null; } catch { return null; }
    };
    const usable = (root) => root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      && typeof root.querySelectorAll === 'function'
      ? root
      : null;
    return usable(read(() => element?.shadowRoot))
      || usable(read(() => element?._shadowRoot))
      || usable(read(() => chrome?.dom?.openOrClosedShadowRoot?.(element)));
  };
  const discoverShadowRoots = (node) => {
    if (!(node instanceof Element)) return;
    if (isPickerHost(node)) return;
    const candidates = [node, ...node.querySelectorAll('*')];
    for (const element of candidates) {
      if (!isPickerHost(element)) observeRoot(shadowFor(element));
    }
  };
  const observer = new MutationObserver((records) => {
    if (paused) return;
    for (const record of records) {
      record.addedNodes.forEach(discoverShadowRoots);
    }
    // Reference Live immediately starts its filter for each delivered batch.
    // In-flight worker capture is coalesced separately by requestLiveCapture;
    // delaying here would make a short-lived DOM value invisible.
    notify();
  });
  const observeRoot = (root) => {
    if (!(root instanceof Node) || observedRoots.has(root)) return;
    observedRoots.add(root);
    if (!paused) observer.observe(root, observerOptions);
    if (typeof root.querySelectorAll === 'function') {
      root.querySelectorAll('*').forEach((element) => {
        if (!isPickerHost(element)) observeRoot(shadowFor(element));
      });
    }
  };
  const pause = () => {
    if (paused) return;
    paused = true;
    observer.disconnect();
  };
  const resume = () => {
    if (!paused) return;
    paused = false;
    observedRoots.forEach((observedRoot) => observer.observe(observedRoot, observerOptions));
  };
  const root = document.documentElement;
  if (!root) return { ok: false, error: 'The page has no document root.' };
  observeRoot(root);
  // Attaching a shadow root itself is not a MutationObserver record. Rescan
  // hosts at a modest cadence so a component which creates a *closed* root
  // after live monitoring starts is enrolled before its next internal change.
  const shadowRescanTimer = setInterval(() => discoverShadowRoots(document.documentElement), 1_500);
  const record = {
    revision,
    observer,
    observedRoots,
    shadowRescanTimer,
    pause,
    resume
  };
  registry.set(monitorId, record);
  addEventListener('pagehide', () => {
    if (registry.get(monitorId) !== record) return;
    observer.disconnect();
    clearInterval(shadowRescanTimer);
    registry.delete(monitorId);
  }, { once: true });
  return { ok: true, reused: false };
}

function removeLiveMutationObserver(monitorId) {
  const registry = globalThis.__openStillLiveMutationObservers;
  const record = registry?.get(monitorId);
  record?.observer?.disconnect();
  if (record?.timer) clearTimeout(record.timer);
  if (record?.shadowRescanTimer) clearInterval(record.shadowRescanTimer);
  registry?.delete(monitorId);
  return { ok: true };
}

async function refreshBadge(monitors = null) {
  const list = monitors ?? await getMonitors();
  const unreadCount = list.filter((monitor) => monitor.unread).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#EF6A5B' });
  await chrome.action.setBadgeText({ text: unreadCount ? String(unreadCount) : '' });
}

async function playAlertSound() {
  const { settings } = await getState();
  if (!settings.soundEnabled || Date.now() - lastSoundAt < SOUND_DEBOUNCE_MS) {
    return;
  }

  lastSoundAt = Date.now();
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ type: 'play-alert-sound' }).catch(() => undefined);
}

async function announceChange(monitor) {
  const notificationId = `openstill-change:${monitor.id}`;
  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'OpenStill · 변경 감지',
      message: `${monitor.name}에서 변경을 확인했습니다.`,
      priority: 1
    });
  } catch (error) {
    console.warn('OpenStill could not show a change notification.', error);
  }
  await playAlertSound().catch((error) => console.warn('OpenStill could not play a change sound.', error));
}

function dueTimestamp(monitor) {
  const timestamp = Date.parse(monitor.nextCheckAt ?? '');
  // A malformed/imported CRON expression can be retained but deliberately
  // unscheduled. Treat its absent due time as infinity rather than "now" so
  // it cannot wake the service worker in a tight loop.
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

async function scheduleNextAlarm() {
  const operation = alarmQueue.catch(() => undefined).then(async () => {
    const monitors = await getMonitors();
    const enabled = monitors
      .filter((monitor) => monitor.enabled && isAutomaticSchedule(monitor))
      .map((monitor) => ({ monitor, due: dueTimestamp(monitor) }))
      .filter(({ due }) => Number.isFinite(due));
    if (precisionScheduleTimer !== null) {
      clearTimeout(precisionScheduleTimer);
      precisionScheduleTimer = null;
    }
    await chrome.alarms.clear(ALARM_NAME);

    if (!enabled.length) {
      return;
    }

    const nextDue = Math.min(...enabled.map(({ due }) => due));
    const now = Date.now();
    const delay = Math.max(0, nextDue - now);
    if (delay < MIN_CHROME_ALARM_DELAY_MS) {
      // Chrome alarms may defer sub-30-second wakeups, but a live service
      // worker can honor the five-second Reference cadence precisely. Keep an
      // alarm at Chrome's reliable floor as a recovery fallback if MV3 tears
      // down this worker before the in-memory timer fires.
      let timer;
      timer = setTimeout(() => {
        if (precisionScheduleTimer !== timer) return;
        precisionScheduleTimer = null;
        void runDueChecks();
      }, delay);
      // Node-based tests should not be held open by a future precision timer;
      // browser timeout ids are numeric and simply do not expose unref().
      timer?.unref?.();
      precisionScheduleTimer = timer;
      await chrome.alarms.create(ALARM_NAME, { when: now + MIN_CHROME_ALARM_DELAY_MS });
      return;
    }
    await chrome.alarms.create(ALARM_NAME, { when: Math.max(now + 1_000, nextDue) });
  });
  alarmQueue = operation.catch(() => undefined);
  return operation;
}

function appendRunHistory(monitor, entry) {
  const prior = Array.isArray(monitor.runs) ? monitor.runs : [];
  monitor.runs = [{
    at: asIso(entry?.at, nowIso()),
    status: VALID_STATUSES.has(entry?.status) ? entry.status : 'error',
    code: cleanShortText(entry?.code, 80) || null,
    message: cleanShortText(entry?.message, 300) || null,
    changed: Boolean(entry?.changed),
    matchCount: Number.isInteger(entry?.matchCount) && entry.matchCount >= 0 ? entry.matchCount : null
  }, ...prior].slice(0, MAX_RUN_HISTORY);
}

function hasSuccessfulRun(monitor, { pendingFailure = false } = {}) {
  // The reference scheduler queries the newest ten work logs *after* the
  // current failed run is recorded.  Failure scheduling here happens just
  // before appendRunHistory(), so reserve one of those ten slots to avoid
  // granting a quick retry based on an eleventh-old success.
  const limit = pendingFailure ? 9 : 10;
  const runs = Array.isArray(monitor?.runs) ? monitor.runs.slice(0, limit) : [];
  if (runs.length) return runs.some((run) => run?.status === 'ok' || run?.status === 'changed');
  // Legacy/imported monitors can have a baseline before run-history support.
  const snapshot = monitor?.snapshot;
  return Boolean(snapshot && (snapshot.exists || normalizeTracking(monitor?.tracking).allowEmpty));
}

function retryDelayForSchedule(monitor) {
  const schedule = scheduleDescriptorOf(monitor);
  if (!schedule) return null;
  if (schedule.type === SCHEDULE_MODE_INTERVAL) return Math.min(120_000, schedule.params.interval * 1_000);
  if (schedule.type === SCHEDULE_MODE_RANDOM) return Math.min(120_000, schedule.params.max * 1_000);
  if (schedule.type === SCHEDULE_MODE_CRON) return 60_000;
  return null;
}

async function setCheckFailure(id, expectedRevision, status, errorMessage, source = 'manual') {
  const checkedAt = nowIso();
  await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor || !monitor.enabled || monitor.revision !== expectedRevision) {
      return null;
    }
    const advancesSchedule = source !== 'live' || scheduleDescriptorOf(monitor)?.type === SCHEDULE_MODE_LIVE;
    if (advancesSchedule) monitor.lastCheckedAt = checkedAt;
    const retryDelay = isAutomaticSchedule(monitor) && hasSuccessfulRun(monitor, { pendingFailure: true })
      ? retryDelayForSchedule(monitor)
      : null;
    if (advancesSchedule) {
      monitor.nextCheckAt = retryDelay
        ? new Date(Date.now() + retryDelay).toISOString()
        : nextCheckForSchedule(monitor.schedule, checkedAt, monitor.intervalHours);
    }
    monitor.status = status;
    monitor.lastReviewAt = null;
    monitor.lastError = cleanText(errorMessage, 300);
    monitor.updatedAt = checkedAt;
    appendRunHistory(monitor, {
      at: checkedAt,
      status,
      code: status,
      message: monitor.lastError,
      changed: false
    });
    return monitor;
  });
}

function statusForStoredSnapshot(snapshot, tracking = null) {
  if (!snapshot) return 'needs-baseline';
  return snapshot.exists || normalizeTracking(tracking).allowEmpty ? 'ok' : 'needs-review';
}

function appendSnapshotHistory(monitor, snapshot, kind) {
  if (!snapshot) return;
  const entry = {
    snapshot,
    capturedAt: snapshot.capturedAt ?? nowIso(),
    kind: kind === 'baseline' ? 'baseline' : 'change'
  };
  const prior = Array.isArray(monitor.history) ? monitor.history : [];
  monitor.history = [entry, ...prior].slice(0, MAX_CHANGE_HISTORY);
}

function applySnapshotOutcome(monitor, nextSnapshot, checkedAt) {
  // A missing match is deliberately not a comparison result. A session can have
  // expired, the page can be behind a login wall, or a temporary error page can
  // be rendered. Keep the last successful snapshot so a later reappearance is
  // compared against real content instead of producing a false change.
  const tracking = normalizeTracking(monitor.tracking);
  if (!nextSnapshot.exists && !tracking.allowEmpty) {
    monitor.status = 'needs-review';
    monitor.lastReviewAt = checkedAt;
    monitor.lastError = ELEMENT_NOT_FOUND_MESSAGE;
    monitor.lastErrorSnapshot = nextSnapshot.evidenceHtml ? nextSnapshot : null;
    return { changed: false, needsReview: true };
  }

  const previous = monitor.snapshot;
  const changed = Boolean(previous) && !snapshotsEqual(previous, nextSnapshot, tracking);
  // The reference runner only persists a baseline on the first successful
  // capture or a real filtered-text change. An equal re-render must not churn
  // the saved HTML/text history merely because its capture timestamp changed.
  if (!previous || changed) {
    monitor.snapshot = nextSnapshot;
    appendSnapshotHistory(monitor, nextSnapshot, previous ? 'change' : 'baseline');
  }
  monitor.lastError = null;
  monitor.lastErrorSnapshot = null;
  monitor.lastReviewAt = null;

  if (changed) {
    monitor.lastChangedAt = checkedAt;
    monitor.lastChange = {
      previous,
      current: nextSnapshot,
      detectedAt: checkedAt
    };
    monitor.unread = true;
    monitor.status = 'changed';
  } else {
    if (!previous) {
      monitor.lastViewedAt = checkedAt;
      monitor.unread = false;
    }
    // An unread change remains actionable after a later successful re-check.
    monitor.status = monitor.unread ? 'changed' : statusForStoredSnapshot(monitor.snapshot, tracking);
  }

  return { changed, needsReview: false };
}

function liveRawTextOf(snapshot) {
  // Normal live captures place this field on the snapshot as non-enumerable
  // metadata. `rawText` keeps the function useful with older/adapted capture
  // implementations and test doubles.
  return String(snapshot?.liveRawText ?? snapshot?.rawText ?? snapshot?.text ?? '');
}

async function checkMonitorWithCapture(id, capture, {
  reschedule = true,
  source = 'manual',
  liveFrameId = 0,
  liveTabId = null
} = {}) {
  if (checksInProgress.has(id)) {
    return { ok: false, reason: 'checking', error: '이미 확인 중입니다.' };
  }

  checksInProgress.add(id);
  try {
    const monitor = (await getMonitors()).find((item) => item.id === id);
    if (!monitor) {
      return { ok: false, error: '모니터를 찾을 수 없습니다.' };
    }
    if (!monitor.enabled) {
      return { ok: false, reason: 'disabled', error: '일시정지된 모니터입니다.' };
    }
    if (!await hasSitePermission(monitor.url)) {
      await setCheckFailure(id, monitor.revision, 'permission-needed', '이 사이트의 접근 권한이 필요합니다.', source);
      return { ok: false, reason: 'permission', error: '이 사이트의 접근 권한이 필요합니다.' };
    }

    let nextSnapshot;
    try {
      // The reference live runner gives page loading a timeout, but mutation
      // callbacks themselves filter immediately. Do not impose scheduled
      // capture delay/timeout semantics on a live event.
      if (source === 'live') {
        nextSnapshot = await capture(monitor);
      } else {
        const captureTimeout = monitor.tracking?.timeoutMilliseconds ?? CHECK_EXECUTION_TIMEOUT_MS;
        nextSnapshot = await timeout(
          capture(monitor),
          captureTimeout,
          'The page capture exceeded its allowed time.'
        );
      }
    } catch (error) {
      const message = responseError(error);
      await setCheckFailure(id, monitor.revision, 'error', message, source);
      return { ok: false, error: message };
    }

    if (source === 'live') {
      // The reference live content observer deliberately suppresses empty
      // filter results and uses filtered text—not HTML/data mode—as its
      // deduplication key. A transient disappearance therefore waits for a
      // later nonempty mutation instead of rewriting the saved baseline.
      const rawText = liveRawTextOf(nextSnapshot);
      if (!rawText) {
        return { ok: true, liveNoop: true, empty: true };
      }
      const session = liveSessions.get(id);
      const expectedSession = session
        && session.revision === monitor.revision
        && (!Number.isInteger(liveTabId) || session.tabId === liveTabId);
      const frameId = Number.isInteger(liveFrameId) ? liveFrameId : 0;
      if (expectedSession) {
        session.rawTextByFrame || (session.rawTextByFrame = new Map());
        if (session.rawTextByFrame.get(frameId) === rawText) {
          return { ok: true, liveNoop: true, unchanged: true };
        }
        // Content advances lastResult before the runner applies regexp or
        // persists its comparison result, so cache this raw frame value now.
        session.rawTextByFrame.set(frameId, rawText);
      }
      // A raw nonempty regexp miss is a successful empty comparison in live
      // mode, not the scheduled selection-empty/review condition.
      if (nextSnapshot && !nextSnapshot.exists) nextSnapshot.exists = true;
    }

    const checkedAt = nowIso();
    const result = await mutateMonitors((monitors) => {
      const current = monitors.find((item) => item.id === id);
      if (!current || !current.enabled || current.revision !== monitor.revision) {
        return { ok: false, reason: 'outdated', error: '확인 중 모니터 설정이 변경되었습니다.' };
      }

      // A live mutation is an additional signal, not a new periodic cadence.
      // Keep interval/random/cron due times intact so busy pages cannot defer
      // their scheduled verification forever. A pure LIVE schedule still
      // records its most recent check because it has no alarm cadence to move.
      const advancesSchedule = source !== 'live' || scheduleDescriptorOf(current)?.type === SCHEDULE_MODE_LIVE;
      if (advancesSchedule) {
        current.lastCheckedAt = checkedAt;
        current.nextCheckAt = nextCheckForSchedule(current.schedule, checkedAt, current.intervalHours);
      }
      const previousStatus = current.status;
      const previousError = current.lastError;
      const previousReviewAt = current.lastReviewAt;
      const hadErrorSnapshot = Boolean(current.lastErrorSnapshot);
      const hadSnapshot = Boolean(current.snapshot);
      const applied = applySnapshotOutcome(current, nextSnapshot, checkedAt);
      // A nonempty baseline followed by an empty selection is an execution
      // error in the reference scheduler. Keep the baseline/evidence, but
      // perform its bounded quick retry instead of waiting a full interval.
      if (applied.needsReview && advancesSchedule) {
        const retryDelay = isAutomaticSchedule(current) && hasSuccessfulRun(current, { pendingFailure: true })
          ? retryDelayForSchedule(current)
          : null;
        if (retryDelay) current.nextCheckAt = new Date(Date.now() + retryDelay).toISOString();
      }
      // The reference live observer emits an initial nonempty result and then
      // only filtered-text changes. Preserve recovery/error evidence, but do
      // not add a run or churn updatedAt for an equal live mutation.
      const recordOutcome = source !== 'live'
        || !hadSnapshot
        || applied.changed
        || applied.needsReview
        || previousStatus !== current.status
        || previousError !== current.lastError
        || previousReviewAt !== current.lastReviewAt
        || hadErrorSnapshot !== Boolean(current.lastErrorSnapshot);
      if (recordOutcome) {
        current.updatedAt = checkedAt;
        appendRunHistory(current, {
          at: checkedAt,
          status: applied.needsReview ? 'needs-review' : applied.changed ? 'changed' : 'ok',
          code: applied.needsReview ? 'selection-empty' : null,
          message: applied.needsReview ? current.lastError : null,
          changed: applied.changed,
          matchCount: nextSnapshot.matchCount
        });
      }

      return { ok: true, ...applied, liveNoop: source === 'live' && !recordOutcome, monitor: { ...current } };
    });

    if (result?.changed) {
      await announceChange(result.monitor);
    }
    await refreshBadge();
    return result;
  } catch (error) {
    return { ok: false, error: responseError(error) };
  } finally {
    checksInProgress.delete(id);
    if (reschedule) {
      await scheduleNextAlarm().catch((error) => console.warn('OpenStill could not reschedule checks.', error));
    }
  }
}

async function checkMonitor(id, options = {}) {
  return checkMonitorWithCapture(id, (monitor) => captureRenderedSnapshot(monitor), options);
}

async function checkMonitorInOpenTab(id, tabId, options = {}) {
  return checkMonitorWithCapture(
    id,
    (monitor) => captureRenderedSnapshot(monitor, tabId, {
      live: options.source === 'live',
      frameId: options.liveFrameId
    }),
    { ...options, liveTabId: tabId }
  );
}

function tabMatchesMonitor(tab, monitor) {
  return Number.isInteger(tab?.id) && normalizeUrl(tab.url) === monitor.url;
}

function normalizeLiveOwnedTabs(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [monitorId, entry] of Object.entries(source)) {
    const id = String(monitorId || '').trim();
    const rawTabId = entry?.tabId;
    const tabId = typeof rawTabId === 'number'
      ? rawTabId
      : typeof rawTabId === 'string' && /^\d+$/.test(rawTabId) ? Number(rawTabId) : Number.NaN;
    const revision = String(entry?.revision || '').trim();
    const url = normalizeUrl(entry?.url);
    if (id && Number.isInteger(tabId) && tabId >= 0 && revision && url) {
      result[id] = { tabId, revision, url };
    }
  }
  return result;
}

async function mutateLiveOwnedTabs(mutator) {
  const operation = liveOwnershipQueue.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.session.get(LIVE_CONTROLLED_TABS_KEY);
    const owned = normalizeLiveOwnedTabs(stored?.[LIVE_CONTROLLED_TABS_KEY]);
    const value = await mutator(owned);
    await chrome.storage.session.set({ [LIVE_CONTROLLED_TABS_KEY]: owned });
    return value;
  });
  liveOwnershipQueue = operation.catch(() => undefined);
  return operation;
}

async function getLiveOwnedTabs() {
  await liveOwnershipQueue.catch(() => undefined);
  const stored = await chrome.storage.session.get(LIVE_CONTROLLED_TABS_KEY);
  return normalizeLiveOwnedTabs(stored?.[LIVE_CONTROLLED_TABS_KEY]);
}

async function rememberLiveControlledTab(monitor, tabId) {
  return mutateLiveOwnedTabs((owned) => {
    owned[monitor.id] = { tabId, revision: monitor.revision, url: monitor.url };
  });
}

async function forgetLiveControlledTab(monitorId, expectedTabId = null) {
  return mutateLiveOwnedTabs((owned) => {
    const entry = owned[monitorId];
    if (entry && (!Number.isInteger(expectedTabId) || entry.tabId === expectedTabId)) {
      delete owned[monitorId];
    }
  });
}

async function forgetLiveControlledTabByTabId(tabId) {
  if (!Number.isInteger(tabId)) return;
  return mutateLiveOwnedTabs((owned) => {
    for (const [monitorId, entry] of Object.entries(owned)) {
      if (entry.tabId === tabId) delete owned[monitorId];
    }
  });
}

async function tabById(tabId) {
  if (!Number.isInteger(tabId)) return null;
  if (typeof chrome.tabs?.get === 'function') return chrome.tabs.get(tabId).catch(() => null);
  if (typeof chrome.tabs?.query === 'function') {
    return (await chrome.tabs.query({})).find((tab) => tab.id === tabId) || null;
  }
  return null;
}

async function adoptLiveControlledSession(monitor) {
  const current = liveSessions.get(monitor.id);
  if (current) return current;
  const owned = await getLiveOwnedTabs();
  const entry = owned[monitor.id];
  if (!entry) return null;

  // The stored tab id is only a candidate. Require the exact monitor
  // revision and normalized URL before treating it as extension-owned again.
  if (entry.revision !== monitor.revision || entry.url !== monitor.url) {
    await removeLiveControlledTab(entry.tabId);
    await forgetLiveControlledTab(monitor.id, entry.tabId);
    return null;
  }
  const tab = await tabById(entry.tabId);
  if (!tab || !tabMatchesMonitor(tab, monitor)) {
    if (tab) await removeLiveControlledTab(entry.tabId);
    await forgetLiveControlledTab(monitor.id, entry.tabId);
    return null;
  }
  const session = {
    tabId: entry.tabId,
    revision: entry.revision,
    frameIds: new Set(),
    rawTextByFrame: new Map(),
    ownedTab: true,
    // The old worker's isolated observer may still exist, but this worker has
    // no reliable registration state. Re-run live_init against the verified
    // controlled tab before accepting mutations.
    navigating: true
  };
  liveSessions.set(monitor.id, session);
  return session;
}

async function reconcileLiveControlledTabs(monitors) {
  const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
  const owned = await getLiveOwnedTabs();
  let adopted = 0;
  for (const [monitorId, entry] of Object.entries(owned)) {
    const monitor = byId.get(monitorId);
    const validMonitor = monitor
      && monitor.enabled
      && isLiveTracking(monitor)
      && monitor.revision === entry.revision
      && monitor.url === entry.url;
    if (!validMonitor) {
      await removeLiveControlledTab(entry.tabId);
      await forgetLiveControlledTab(monitorId, entry.tabId);
      continue;
    }
    if (!liveSessions.has(monitorId) && await adoptLiveControlledSession(monitor)) adopted += 1;
  }
  return { adopted };
}

async function removeLiveControlledTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  await chrome.tabs.remove(tabId).catch(async () => {
    // Keep the same best-effort unpin fallback used by one-shot captures.
    await chrome.tabs.update(tabId, { pinned: false }).catch(() => undefined);
    await chrome.tabs.remove(tabId).catch(() => undefined);
  });
}

async function createLiveControlledTab(monitor) {
  if (typeof chrome.tabs?.create !== 'function') {
    throw new Error('This browser cannot create a controlled live-monitor tab.');
  }
  // LiveRunner always creates its own pinned, background loader. Reusing a
  // user tab would make the extension observe and mutate a page the runner
  // does not own, and differs from the reference lifecycle.
  const tab = await chrome.tabs.create({
    url: monitor.url,
    active: false,
    pinned: true,
    index: 0
  });
  if (!Number.isInteger(tab?.id)) {
    throw new Error('Could not create a controlled tab for live monitoring.');
  }
  const ready = waitForRenderedTab(tab.id);
  try {
    await ready.promise;
    return tab;
  } catch (error) {
    await removeLiveControlledTab(tab.id);
    throw error;
  } finally {
    ready.cancel();
  }
}

async function liveFrameIdsForMonitor(monitor, tabId) {
  const needsFrames = monitor.locators.some((locator) => locator.frameId !== 0 || locator.framePath?.length);
  if (!needsFrames) return [0];
  if (typeof chrome.webNavigation?.getAllFrames !== 'function') {
    throw new Error('Subframe live monitoring is unavailable in this browser.');
  }
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const ids = [...new Set(monitor.locators.map((locator) => resolveLocatorFrame(locator, frames)))];
  if (ids.some((frameId) => !Number.isInteger(frameId) || frameId < 0)) {
    throw new Error('A saved live-monitor frame is no longer available on this page.');
  }
  return ids;
}

function liveTarget(tabId, frameIds) {
  // Supplying frameIds (rather than allFrames) keeps unrelated ads/widgets
  // from waking the monitor. Chrome accepts frame 0 in this explicit list.
  return { tabId, frameIds: [...new Set(frameIds)] };
}

async function detachLiveSession(monitorId) {
  const session = liveSessions.get(monitorId);
  if (!session) {
    liveDirtyByMonitor.delete(monitorId);
    return { ok: true, stopped: false };
  }
  const frameIds = [...(session.frameIds || [])];
  const ownsTab = session.ownedTab === true;
  try {
    if (frameIds.length) {
      await chrome.scripting.executeScript({
        target: liveTarget(session.tabId, frameIds),
        func: removeLiveMutationObserver,
        args: [monitorId]
      });
    }
    return { ok: true, stopped: true, tabId: session.tabId };
  } catch (error) {
    // A navigated/closed frame can reject an otherwise successful teardown.
    // Always discard the worker-side session so a new revision can recover.
    return { ok: false, stopped: false, tabId: session.tabId, error: responseError(error) };
  } finally {
    liveSessions.delete(monitorId);
    liveDirtyByMonitor.delete(monitorId);
    if (ownsTab) {
      await removeLiveControlledTab(session.tabId);
      await forgetLiveControlledTab(monitorId, session.tabId);
    }
  }
}

function queueLiveDirtyFrame(monitorId, tabId, revision, frameId) {
  const normalizedFrameId = Number.isInteger(frameId) && frameId >= 0 ? frameId : 0;
  const existing = liveDirtyByMonitor.get(monitorId);
  if (existing?.revision === revision && existing.tabId === tabId) {
    existing.frameIds.add(normalizedFrameId);
    return existing;
  }
  const dirty = { tabId, revision, frameIds: new Set([normalizedFrameId]) };
  liveDirtyByMonitor.set(monitorId, dirty);
  return dirty;
}

function takeLiveDirtyFrames(monitorId, tabId, revision) {
  const dirty = liveDirtyByMonitor.get(monitorId);
  if (!dirty || dirty.revision !== revision || dirty.tabId !== tabId) return [];
  liveDirtyByMonitor.delete(monitorId);
  return [...dirty.frameIds];
}

async function requestLiveCapture(monitor, tabId, frameId = 0) {
  if (checksInProgress.has(monitor.id)) {
    queueLiveDirtyFrame(monitor.id, tabId, monitor.revision, frameId);
    return { ok: true, pending: true };
  }

  let result;
  let rounds = 0;
  let frameIds = [Number.isInteger(frameId) ? frameId : 0];
  // Process the full first concurrent batch, rather than retaining only the
  // latest frame event. A busy page can continue to mutate forever, so leave
  // a later batch to the normal asynchronous requeue after two bounded rounds.
  while (frameIds.length && rounds < 2) {
    for (const currentFrameId of frameIds) {
      result = await checkMonitorInOpenTab(monitor.id, tabId, {
        reschedule: false,
        source: 'live',
        liveFrameId: currentFrameId
      });
    }
    rounds += 1;
    frameIds = takeLiveDirtyFrames(monitor.id, tabId, monitor.revision);
  }

  // `frameIds` already holds a batch taken at the end of the final bounded
  // round; include it before taking any newer events so it cannot be dropped.
  const remaining = [...new Set([
    ...frameIds,
    ...takeLiveDirtyFrames(monitor.id, tabId, monitor.revision)
  ])];
  if (remaining.length) {
    setTimeout(() => {
      for (const remainingFrameId of remaining) {
        void handleLiveMonitorMutation(
          { id: monitor.id, revision: monitor.revision },
          { tab: { id: tabId, url: monitor.url }, frameId: remainingFrameId }
        );
      }
    }, 0);
  }
  return result;
}


async function initializeLiveSession(monitor, session) {
  const frameIds = await liveFrameIdsForMonitor(monitor, session.tabId);
  session.frameIds = new Set(frameIds);
  session.rawTextByFrame = new Map();

  // Content live_init performs its first filter before attaching its mutation
  // observer. Doing the same prevents capture-owned source writes (notably the
  // capture base element) from scheduling a self-feedback check.
  const initialResults = [];
  for (const frameId of frameIds) {
    initialResults.push(await requestLiveCapture(monitor, session.tabId, frameId));
  }

  const installed = await chrome.scripting.executeScript({
    target: liveTarget(session.tabId, frameIds),
    func: installLiveMutationObserver,
    args: [monitor.id, monitor.revision]
  });
  return {
    installedFrames: installed.length,
    initial: initialResults.length === 1 ? initialResults[0] : initialResults
  };
}

async function startLiveMonitor(message) {
  const monitor = (await getMonitors()).find((item) => item.id === message?.id);
  if (!monitor) return { ok: false, error: 'Live monitor was not found.' };
  if (!monitor.enabled) return { ok: false, error: 'Live monitor is disabled.' };
  if (!normalizeTracking(monitor.tracking).live) {
    return { ok: false, error: 'Live monitoring is not enabled for this monitor.' };
  }
  if (!await hasSitePermission(monitor.url)) {
    return { ok: false, reason: 'permission', error: 'Site access is required for live monitoring.' };
  }

  let existing = liveSessions.get(monitor.id);
  if (!existing) existing = await adoptLiveControlledSession(monitor);
  if (existing?.revision === monitor.revision && !existing.navigating) {
    return {
      ok: true,
      tabId: existing.tabId,
      reused: true,
      installedFrames: existing.frameIds?.size ?? 0
    };
  }

  let session;
  try {
    if (existing?.revision === monitor.revision && existing.navigating) {
      // A navigation destroys the isolated observer but the controlled tab is
      // still ours. Reuse only that known tab after the new document finishes.
      session = existing;
      session.navigating = false;
    } else {
      if (existing) await detachLiveSession(monitor.id);
      const tab = await createLiveControlledTab(monitor);
      session = {
        tabId: tab.id,
        revision: monitor.revision,
        frameIds: new Set(),
        rawTextByFrame: new Map(),
        ownedTab: true,
        navigating: false
      };
      liveSessions.set(monitor.id, session);
      await rememberLiveControlledTab(monitor, tab.id);
    }
    const initialized = await initializeLiveSession(monitor, session);
    return { ok: true, tabId: session.tabId, ...initialized };
  } catch (error) {
    if (session && liveSessions.get(monitor.id) === session) {
      await detachLiveSession(monitor.id).catch(() => undefined);
    }
    return { ok: false, error: responseError(error) };
  }
}

async function stopLiveMonitor(message) {
  const monitor = (await getMonitors()).find((item) => item.id === message?.id);
  if (!monitor) return { ok: false, error: 'Live monitor was not found.' };
  // There is intentionally no matching-tab fallback: reference LiveRunner
  // owns the page it observes, so stop must never inject into a user tab.
  if (!liveSessions.has(monitor.id)) await adoptLiveControlledSession(monitor);
  return detachLiveSession(monitor.id);
}

async function handleLiveMonitorMutation(message, sender) {
  const id = typeof message?.id === 'string' ? message.id : '';
  const tabId = sender?.tab?.id;
  if (!id || !Number.isInteger(tabId)) return { ok: false, ignored: true };
  const monitor = (await getMonitors()).find((item) => item.id === id);
  if (!monitor || !monitor.enabled || monitor.revision !== message?.revision || !normalizeTracking(monitor.tracking).live) {
    return { ok: false, ignored: true };
  }
  if (!tabMatchesMonitor(sender.tab, monitor)) return { ok: false, ignored: true };
  const session = liveSessions.get(id);
  if (!session || session.revision !== monitor.revision || session.tabId !== tabId) {
    return { ok: false, ignored: true };
  }
  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  if (!session.frameIds.has(frameId)) return { ok: false, ignored: true };
  return requestLiveCapture(monitor, tabId, frameId);
}

function isLiveTracking(monitor) {
  return normalizeTracking(monitor?.tracking).live || scheduleDescriptorOf(monitor)?.type === SCHEDULE_MODE_LIVE;
}

async function restoreLiveForTab(tabId, knownTab = null) {
  let tab = knownTab;
  if (!tab && typeof chrome.tabs?.get === 'function') {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!tab && typeof chrome.tabs?.query === 'function') {
    tab = (await chrome.tabs.query({})).find((candidate) => candidate.id === tabId) || null;
  }
  if (!tab) return { restored: 0 };
  const monitors = new Map((await getMonitors()).map((monitor) => [monitor.id, monitor]));
  // A tab update must only ever restore a session we already own. Do not turn
  // a user navigating to the same URL into a new live injection.
  const matching = [...liveSessions.entries()].flatMap(([id, session]) => {
    const monitor = monitors.get(id);
    return monitor
      && session.tabId === tabId
      && session.navigating
      && session.revision === monitor.revision
      && monitor.enabled
      && isLiveTracking(monitor)
      && tabMatchesMonitor(tab, monitor)
      ? [monitor]
      : [];
  });
  const outcomes = await Promise.allSettled(matching.map((monitor) => startLiveMonitor({ id: monitor.id })));
  return { restored: outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value?.ok).length };
}

async function restoreLiveMonitoring() {
  const monitors = (await getMonitors()).filter((monitor) => monitor.enabled && isLiveTracking(monitor));
  await reconcileLiveControlledTabs(monitors);
  let restored = 0;
  for (const monitor of monitors) {
    const session = liveSessions.get(monitor.id);
    if (session?.revision === monitor.revision && !session.navigating) continue;
    const outcome = await startLiveMonitor({ id: monitor.id }).catch(() => null);
    if (outcome?.ok) restored += 1;
  }
  return { restored };
}

// Every mutation path (save, import, URL replacement, deletion, enable) can
// change the eligibility or revision of a live monitor. Reconcile the
// in-memory observers centrally so an old isolated-world observer never
// survives merely because its monitor was edited through a different UI.
async function reconcileLiveSessions() {
  const monitors = await getMonitors();
  await reconcileLiveControlledTabs(monitors);
  const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
  for (const [id, session] of [...liveSessions]) {
    const monitor = byId.get(id);
    if (!monitor || !monitor.enabled || !isLiveTracking(monitor) || monitor.revision !== session.revision) {
      await detachLiveSession(id);
    }
  }
  let restored = 0;
  for (const monitor of monitors) {
    if (!monitor.enabled || !isLiveTracking(monitor)) continue;
    const session = liveSessions.get(monitor.id);
    if (session?.revision === monitor.revision && !session.navigating) continue;
    const result = await startLiveMonitor({ id: monitor.id }).catch(() => null);
    if (result?.ok) restored += 1;
  }
  return { restored };
}

async function reinstallLiveFrame(tabId, frameId) {
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || frameId < 0) return { reinstalled: 0 };
  let tab = null;
  if (typeof chrome.tabs?.get === 'function') tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab && typeof chrome.tabs?.query === 'function') {
    tab = (await chrome.tabs.query({})).find((candidate) => candidate.id === tabId) || null;
  }
  if (!tab) return { reinstalled: 0 };
  const monitors = new Map((await getMonitors()).map((monitor) => [monitor.id, monitor]));
  let reinstalled = 0;
  for (const [id, session] of [...liveSessions]) {
    if (session.tabId !== tabId) continue;
    const monitor = monitors.get(id);
    if (!monitor || !monitor.enabled || !isLiveTracking(monitor) || monitor.revision !== session.revision || !tabMatchesMonitor(tab, monitor)) {
      await detachLiveSession(id);
      continue;
    }
    let frameIds;
    try {
      frameIds = await liveFrameIdsForMonitor(monitor, tabId);
    } catch {
      continue;
    }
    session.frameIds = new Set(frameIds);
    if (!session.frameIds.has(frameId)) continue;
    try {
      // A new frame document has no content-side lastResult. Reset only this
      // frame's raw key and perform its live_init-equivalent capture before
      // listening for subsequent mutations.
      session.rawTextByFrame?.delete(frameId);
      await requestLiveCapture(monitor, tabId, frameId);
      await chrome.scripting.executeScript({
        target: liveTarget(tabId, [frameId]),
        func: installLiveMutationObserver,
        args: [monitor.id, monitor.revision]
      });
      reinstalled += 1;
    } catch {
      // The frame may still be tearing down; its next completed navigation
      // event will attempt installation again.
    }
  }
  return { reinstalled };
}

async function checkPage(urlValue) {
  const url = normalizeUrl(urlValue);
  if (!url) {
    return { ok: false, error: '확인할 페이지 주소가 올바르지 않습니다.' };
  }

  const matching = (await getMonitors()).filter((item) => item.url === url);
  const monitors = matching.filter((item) => item.enabled);
  if (!monitors.length) {
    return { ok: false, reason: 'disabled', error: '이 페이지에서 활성화된 추적을 찾을 수 없습니다.' };
  }

  const result = await checkMonitors({ ids: monitors.map((monitor) => monitor.id) });
  if (!result?.ok) return result;
  return {
    ...result,
    // Preserve the page-action shape while reporting all independently
    // configured monitors that were actually checked.
    checked: result.completed,
    changed: Boolean(result.changed),
    needsReview: Boolean(result.needsReview),
    matched: matching.length,
    skipped: matching.length - monitors.length
  };
}

function batchMonitorIds(value) {
  const ids = Array.isArray(value) ? value : [];
  const unique = [];
  const seen = new Set();
  for (const valueId of ids) {
    const id = typeof valueId === 'string' ? valueId.trim().slice(0, 100) : '';
    if (id && !seen.has(id)) {
      seen.add(id);
      unique.push(id);
      if (unique.length >= MAX_BATCH_CHECKS) break;
    }
  }
  return unique;
}

async function checkMonitors(message) {
  const requestedIds = batchMonitorIds(message?.ids);
  if (!requestedIds.length) {
    return { ok: false, error: '확인할 추적을 하나 이상 선택해 주세요.' };
  }

  const knownIds = new Set((await getMonitors()).map((monitor) => monitor.id));
  const ids = requestedIds.filter((id) => knownIds.has(id));
  if (!ids.length) {
    return { ok: false, error: '선택한 추적을 찾을 수 없습니다.' };
  }

  const outcomes = new Array(ids.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      try {
        outcomes[index] = await checkMonitor(id, { reschedule: false });
      } catch (error) {
        outcomes[index] = { ok: false, error: responseError(error) };
      }
    }
  };

  try {
    await Promise.all(Array.from(
      { length: Math.min(MAX_CONCURRENT_BATCH_CHECKS, ids.length) },
      () => worker()
    ));
  } finally {
    await scheduleNextAlarm().catch((error) => console.warn('OpenStill could not reschedule checks.', error));
  }

  const completed = outcomes.filter((outcome) => outcome?.ok).length;
  const changed = outcomes.filter((outcome) => outcome?.ok && outcome.changed).length;
  const needsReview = outcomes.filter((outcome) => outcome?.ok && outcome.needsReview).length;
  const failed = outcomes.filter((outcome) => !outcome?.ok).length;
  return {
    ok: true,
    requested: requestedIds.length,
    found: ids.length,
    completed,
    changed,
    needsReview,
    failed,
    missing: requestedIds.length - ids.length
  };
}

async function runDueChecks() {
  if (sweepRunning) {
    return;
  }

  sweepRunning = true;
  try {
    const now = Date.now();
    const due = (await getMonitors())
      .filter((monitor) => monitor.enabled && isAutomaticSchedule(monitor) && dueTimestamp(monitor) <= now)
      .sort((left, right) => dueTimestamp(left) - dueTimestamp(right));

    // Configurations that watch one page remain independent.  In particular,
    // do not collapse due work by URL: they may have different locators,
    // fields, schedules, or comparison filters.
    const scheduled = due.slice(0, MAX_CHECKS_PER_SWEEP);

    await Promise.allSettled(scheduled.map((monitor) => checkMonitor(monitor.id, { reschedule: false })));
  } finally {
    sweepRunning = false;
    await scheduleNextAlarm();
  }
}

function selectorsEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((selector, index) => selector === right[index]);
}

function locatorsEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((locator, index) => locatorKey(locator) === locatorKey(right[index]));
}

function schedulesEqual(left, right) {
  const normalizedLeft = left && typeof left === 'object' ? left : null;
  const normalizedRight = right && typeof right === 'object' ? right : null;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function trackingEqual(left, right) {
  return JSON.stringify(normalizeTracking(left)) === JSON.stringify(normalizeTracking(right));
}

function pickerItemsFromMessage(message, defaultFrameId = 0) {
  const rawItems = Array.isArray(message.items)
    ? message.items
    : Array.isArray(message.locators)
      ? message.locators
      : Array.isArray(message.selectors)
        ? message.selectors.map((selector) => ({ selector }))
        : Object.hasOwn(message, 'selector')
          ? [{ selector: message.selector }]
          : [];

  if (!rawItems.length) {
    return [cleanLocator({
      type: 'css',
      expr: 'body',
      op: 'include'
    }, {
      frameId: defaultFrameId,
      ...(defaultFrameId > 0 ? { frameOrder: defaultFrameId } : {})
    })];
  }
  if (rawItems.length > MAX_SELECTORS_PER_MONITOR) return null;

  const items = [];
  const seenLocators = new Set();
  for (const rawItem of rawItems) {
    const locator = cleanLocator(rawItem, {
      frameId: defaultFrameId,
      ...(defaultFrameId > 0 ? { frameOrder: defaultFrameId } : {})
    });
    if (!locator) return null;
    const key = locatorKey(locator);
    if (seenLocators.has(key)) continue;
    seenLocators.add(key);
    items.push(locator);
  }
  return items.some((item) => item.op === 'include') ? items : null;
}

async function validateLocatorList(locators) {
  for (const locator of locators) {
    await validateSelectorSyntax(locator.expr, locator.type);
  }
}

async function createMonitors(message, sender) {
  const url = normalizeUrl(sender?.tab?.url ?? message.url);
  const schedule = normalizeScheduleDescriptor(message, SCHEDULE_MODE_MANUAL);
  const scheduleMode = schedule?.type;
  const intervalHours = scheduleMode === SCHEDULE_MODE_INTERVAL
    ? schedule.params.interval / 3_600
    : MIN_INTERVAL_HOURS;
  const trackingInput = message.tracking ?? message;
  const pickerItems = pickerItemsFromMessage(
    message,
    Number.isInteger(sender?.frameId) ? sender.frameId : 0
  );
  if (!url || !schedule || !pickerItems) {
    return { ok: false, error: 'URL, 확인 방식과 간격, 그리고 하나 이상의 CSS 선택자를 확인해 주세요.' };
  }
  if (hasInvalidConfiguredRegularExpression(trackingInput)) {
    return { ok: false, error: '변경 내용을 거를 정규식 또는 플래그가 올바르지 않습니다.' };
  }

  try {
    await validateLocatorList(pickerItems);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }
  if (pickerItems.some((locator) => locator.frameId !== 0) && Number.isInteger(sender?.tab?.id)) {
    if (typeof chrome.webNavigation?.getAllFrames !== 'function') {
      return { ok: false, error: 'This browser cannot save subframe selections.' };
    }
    let frames;
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
    } catch (error) {
      return { ok: false, error: `Could not identify the selected frame: ${responseError(error)}` };
    }
    for (const locator of pickerItems) {
      const framePath = framePathForFrame(locator.frameId, frames);
      if (framePath === null) {
        return { ok: false, error: `The selected frame (${locator.frameId}) cannot be stably identified.` };
      }
      locator.framePath = framePath;
    }
  }
  if (!await hasSitePermission(url)) {
    return { ok: false, error: '저장하기 전에 이 사이트의 접근 권한을 허용해 주세요.' };
  }

  const timestamp = nowIso();
  const pageTitle = cleanText(message.pageTitle, 180);
  const baseName = cleanText(message.name, 120) || pageTitle || new URL(url).hostname;
  const labels = cleanLabels(message.labels);
  const result = await mutateMonitors((monitors) => {
    if (monitors.length >= MAX_MONITORS) {
      throw new Error('추적은 최대 개수에 도달했습니다.');
    }

    // A URL identifies a page, not a monitor. Each save is an independent
    // configuration with its own locators, schedule, filtering, and history.
    const monitor = {
      id: createId(),
      revision: createRevision(),
      name: baseName,
      url,
      pageTitle,
      locators: pickerItems,
      selectors: displaySelectorsForLocators(pickerItems),
      tracking: normalizeTracking(scheduleMode === SCHEDULE_MODE_LIVE
        ? { ...(trackingInput && typeof trackingInput === 'object' ? trackingInput : {}), live: true }
        : trackingInput),
      labels,
      schedule,
      scheduleMode,
      intervalHours,
      ...(scheduleMode === SCHEDULE_MODE_INTERVAL ? { intervalSeconds: schedule.params.interval } : {}),
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastCheckedAt: null,
      lastChangedAt: null,
      // A manual tracker has no due time. Its first baseline is established
      // only by an explicit user check.
      nextCheckAt: nextCheckForSchedule(schedule, null, intervalHours, timestamp),
      snapshot: null,
      lastChange: null,
      history: [],
      runs: [],
      lastReviewAt: null,
      lastViewedAt: null,
      lastError: null,
      lastErrorSnapshot: null,
      status: 'needs-baseline',
      unread: false
    };
    monitors.push(monitor);
    return { ok: true, monitor: { ...monitor } };
  });

  if (!result?.ok) return result;
  await forgetPendingPicker(sender?.tab?.id);
  await scheduleNextAlarm();
  if (isLiveTracking(result.monitor)) {
    await startLiveMonitor({ id: result.monitor.id, tabId: sender?.tab?.id }).catch(() => undefined);
  }
  return { ok: true, monitor: result.monitor, monitors: [result.monitor], count: 1 };
}

async function createMonitor(message, sender) {
  return createMonitors({
    ...message,
    items: [{
      selector: message.selector
    }]
  }, sender);
}

async function saveMonitor(message) {
  const url = normalizeUrl(message.url);
  const locators = cleanLocators(
    Object.hasOwn(message, 'locators')
      ? message.locators
      : Object.hasOwn(message, 'selectors')
        ? message.selectors
        : message.selector
  );
  if (!message.id || !url || !locators) {
    return { ok: false, error: 'URL과 CSS 선택자를 확인해 주세요.' };
  }
  const trackingInput = message.tracking ?? null;
  if (trackingInput && hasInvalidConfiguredRegularExpression(trackingInput)) {
    return { ok: false, error: '변경 내용을 거를 정규식 또는 플래그가 올바르지 않습니다.' };
  }

  const existing = (await getMonitors()).find((item) => item.id === message.id);
  if (!existing) {
    return { ok: false, error: '추적을 찾을 수 없습니다.' };
  }
  const schedule = normalizeScheduleDescriptor(message, existing.scheduleMode, existing.schedule);
  const scheduleMode = schedule?.type;
  const intervalHours = scheduleMode === SCHEDULE_MODE_INTERVAL
    ? schedule.params.interval / 3_600
    : existing.intervalHours ?? MIN_INTERVAL_HOURS;
  if (!schedule) {
    return { ok: false, error: '확인 방식과 간격을 확인해 주세요.' };
  }

  try {
    await validateLocatorList(locators);
  } catch (error) {
    return { ok: false, error: responseError(error) };
  }

  const previousUrl = existing.url;
  const previousTracking = normalizeTracking(existing.tracking);
  const permissionGranted = await hasSitePermission(url);
  const result = await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === message.id);
    if (!monitor) {
      return { ok: false, error: '추적을 찾을 수 없습니다.' };
    }
    const nextTracking = normalizeTracking(scheduleMode === SCHEDULE_MODE_LIVE
      ? { ...((trackingInput ?? monitor.tracking) && typeof (trackingInput ?? monitor.tracking) === 'object' ? (trackingInput ?? monitor.tracking) : {}), live: true }
      : trackingInput ?? monitor.tracking);
    monitor.name = cleanText(message.name, 120) || monitor.name;
    monitor.revision = createRevision();
    monitor.url = url;
    monitor.locators = [...locators];
    monitor.selectors = displaySelectorsForLocators(locators);
    monitor.tracking = nextTracking;
    monitor.labels = cleanLabels(message.labels);
    monitor.schedule = schedule;
    monitor.scheduleMode = scheduleMode;
    monitor.intervalHours = intervalHours;
    if (scheduleMode === SCHEDULE_MODE_INTERVAL) monitor.intervalSeconds = schedule.params.interval;
    else delete monitor.intervalSeconds;
    const requestedEnabled = message.enabled !== false;
    monitor.enabled = requestedEnabled && permissionGranted;
    monitor.updatedAt = nowIso();
    monitor.nextCheckAt = isAutomaticSchedule(monitor)
      ? nextCheckForSchedule(monitor.schedule, monitor.lastCheckedAt, intervalHours)
      : null;

    // A selector/filter edit changes the next extraction, not the identity of
    // the monitored history. Keep the previous successful capture as the
    // comparison baseline, then make an automatic monitor due immediately.
    // Resetting here would silently turn a real post-edit difference into a
    // new baseline rather than reporting it.
    if (requestedEnabled && !permissionGranted) {
      monitor.status = 'permission-needed';
      monitor.lastError = '이 사이트의 접근 권한이 필요합니다.';
    } else if (!requestedEnabled && monitor.status === 'permission-needed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot, monitor.tracking);
      monitor.lastError = null;
    }

    return { ok: true, monitor: { ...monitor }, permissionGranted };
  });

  if (result?.ok) {
    const updatedTracking = normalizeTracking(result.monitor?.tracking);
    const previousLive = isLiveTracking(existing);
    const updatedLive = isLiveTracking(result.monitor);
    const liveConfigurationChanged = existing.url !== url
      || !locatorsEqual(existing.locators, result.monitor?.locators)
      || !trackingEqual(previousTracking, updatedTracking)
      || !schedulesEqual(existing.schedule, result.monitor?.schedule);
    if (previousLive && (!updatedLive || !result.monitor.enabled || liveConfigurationChanged)) {
      await detachLiveSession(existing.id);
    }
    if (updatedLive && result.monitor.enabled && (!previousLive || liveConfigurationChanged)) {
      // A saved selector or tracking edit creates a new revision. Reinstall on
      // any matching open page so an older isolated-world observer cannot keep
      // sending ignored revision messages forever.
      await startLiveMonitor({ id: existing.id }).catch(() => undefined);
    }
  }
  await reconcileLiveSessions().catch(() => undefined);
  await refreshBadge();
  await scheduleNextAlarm();
  if (previousUrl !== url) {
    await releaseUnusedSitePermission(previousUrl);
  }
  return result;
}

async function setMonitorEnabled(message) {
  const enabled = Boolean(message.enabled);
  const monitor = (await getMonitors()).find((item) => item.id === message.id);
  if (!monitor) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }

  const permissionGranted = !enabled || await hasSitePermission(monitor.url);
  if (enabled && !permissionGranted) {
    return { ok: false, reason: 'permission', error: '이 사이트의 접근 권한이 필요합니다.' };
  }
  if (!enabled && isLiveTracking(monitor)) {
    await stopLiveMonitor({ id: monitor.id }).catch(() => undefined);
  }

  await mutateMonitors((monitors) => {
    const current = monitors.find((item) => item.id === message.id);
    if (!current) {
      return;
    }
    current.enabled = enabled;
    current.revision = createRevision();
    current.updatedAt = nowIso();
    current.nextCheckAt = isAutomaticSchedule(current) && enabled
      ? nextCheckForSchedule(current.schedule, current.lastCheckedAt, current.intervalHours)
      : null;
    if (enabled && current.status === 'permission-needed') {
      current.status = statusForStoredSnapshot(current.snapshot, current.tracking);
      current.lastError = null;
    } else if (!enabled && current.status === 'permission-needed') {
      current.status = statusForStoredSnapshot(current.snapshot, current.tracking);
      current.lastError = null;
    }
  });
  if (enabled && isLiveTracking(monitor)) {
    await startLiveMonitor({ id: monitor.id }).catch(() => undefined);
  }
  await reconcileLiveSessions().catch(() => undefined);
  await scheduleNextAlarm();
  return { ok: true };
}

async function deleteMonitor(id) {
  const existing = (await getMonitors()).find((item) => item.id === id);
  if (existing && isLiveTracking(existing)) {
    await stopLiveMonitor({ id: existing.id }).catch(() => undefined);
  }
  let deleted;
  await mutateMonitors((monitors) => {
    const index = monitors.findIndex((item) => item.id === id);
    if (index >= 0) {
      deleted = monitors.splice(index, 1)[0];
    }
  });

  if (!deleted) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }
  await releaseUnusedSitePermission(deleted.url);
  await refreshBadge();
  await scheduleNextAlarm();
  return { ok: true };
}

function resetMonitorForPageUrl(monitor, url, timestamp, { copy = false } = {}) {
  return {
    ...monitor,
    id: copy ? createId() : monitor.id,
    revision: createRevision(),
    url,
    locators: monitor.locators.map((locator) => ({
      ...locator,
      framePath: locator.framePath.map((part) => ({ ...part })),
      fields: locator.fields.map((field) => ({ ...field }))
    })),
    selectors: [...monitor.selectors],
    ...(copy ? { createdAt: timestamp } : {}),
    updatedAt: timestamp,
    lastCheckedAt: null,
    lastChangedAt: null,
    nextCheckAt: nextCheckForSchedule(monitor.schedule, null, monitor.intervalHours, timestamp),
    snapshot: null,
    lastChange: null,
    history: [],
    runs: [],
    lastReviewAt: null,
    lastViewedAt: null,
    lastError: null,
    lastErrorSnapshot: null,
    status: 'needs-baseline',
    unread: false
  };
}

async function reusePageUrl(message, { copy = false } = {}) {
  const sourceUrl = normalizeUrl(message.sourceUrl);
  const targetUrl = normalizeUrl(message.targetUrl);
  if (!sourceUrl || !targetUrl) {
    return { ok: false, error: '기존 주소와 새 주소를 모두 확인해 주세요.' };
  }
  if (sourceUrl === targetUrl) {
    return { ok: false, error: '새 주소가 기존 주소와 같습니다.' };
  }

  const monitors = await getMonitors();
  const sourceMonitors = monitors.filter((monitor) => monitor.url === sourceUrl);
  if (!sourceMonitors.length) {
    return { ok: false, error: '주소를 재사용할 추적 페이지를 찾을 수 없습니다.' };
  }
  if (copy && monitors.length + sourceMonitors.length > MAX_MONITORS) {
    return { ok: false, error: '추적은 최대 개수에 도달했습니다.' };
  }
  if (sourceMonitors.some((monitor) => monitor.enabled) && !await hasSitePermission(targetUrl)) {
    return { ok: false, reason: 'permission', error: '새 사이트의 접근 권한이 필요합니다.' };
  }

  const timestamp = nowIso();
  const result = await mutateMonitors((currentMonitors) => {
    // Resolve all matching records inside the serialized mutation.  A page
    // action applies to the page group, while each affected monitor preserves
    // its own configuration and reset baseline.
    const currentSources = currentMonitors.filter((monitor) => monitor.url === sourceUrl);
    if (!currentSources.length) {
      return { ok: false, error: '주소를 재사용할 추적 페이지를 찾을 수 없습니다.' };
    }
    if (copy) {
      if (currentMonitors.length + currentSources.length > MAX_MONITORS) {
        return { ok: false, error: '추적은 최대 개수에 도달했습니다.' };
      }
      const affected = currentSources.map((monitor) => resetMonitorForPageUrl(monitor, targetUrl, timestamp, { copy: true }));
      currentMonitors.push(...affected);
      return { ok: true, monitor: { ...affected[0] }, monitors: affected.map((monitor) => ({ ...monitor })), count: affected.length };
    } else {
      const affectedById = new Map(currentSources.map((monitor) => [
        monitor.id,
        resetMonitorForPageUrl(monitor, targetUrl, timestamp)
      ]));
      for (let index = 0; index < currentMonitors.length; index += 1) {
        const affected = affectedById.get(currentMonitors[index].id);
        if (affected) currentMonitors[index] = affected;
      }
      const affected = [...affectedById.values()];
      return { ok: true, monitor: { ...affected[0] }, monitors: affected.map((monitor) => ({ ...monitor })), count: affected.length };
    }
  });

  if (!result?.ok) return result;
  if (!copy) {
    await releaseUnusedSitePermission(sourceUrl);
  }
  await reconcileLiveSessions().catch(() => undefined);
  await refreshBadge();
  await scheduleNextAlarm();
  return result;
}

function planSiteHostReplacement(monitors, sourceHost, targetHost) {
  const replacements = [];

  for (const monitor of monitors) {
    if (siteHostOfUrl(monitor.url) !== sourceHost) {
      continue;
    }

    const targetUrl = replaceUrlHost(monitor.url, sourceHost, targetHost);
    if (!targetUrl) {
      return { ok: false, error: '일괄 변경할 주소를 준비하지 못했습니다.' };
    }
    replacements.push({ id: monitor.id, sourceUrl: monitor.url, targetUrl, enabled: monitor.enabled });
  }

  if (!replacements.length) {
    return { ok: false, error: '기존 사이트 주소에 해당하는 추적을 찾지 못했습니다.' };
  }

  return { ok: true, replacements };
}

async function replaceSiteHost(message) {
  const sourceHost = normalizeSiteHost(message?.sourceHost);
  const targetHost = normalizeSiteHost(message?.targetHost);
  if (!sourceHost || !targetHost) {
    return { ok: false, error: '기존 및 새 사이트 주소에는 도메인(필요하면 포트)만 입력해 주세요.' };
  }
  if (sourceHost === targetHost) {
    return { ok: false, error: '새 사이트 주소가 기존 주소와 같습니다.' };
  }

  const before = await getMonitors();
  const planned = planSiteHostReplacement(before, sourceHost, targetHost);
  if (!planned.ok) {
    return planned;
  }

  const enabledTargetUrls = [...new Set(planned.replacements
    .filter((replacement) => replacement.enabled)
    .map((replacement) => replacement.targetUrl))];
  for (const targetUrl of enabledTargetUrls) {
    if (!await hasSitePermission(targetUrl)) {
      return { ok: false, reason: 'permission', error: '새 사이트의 접근 권한이 필요합니다.' };
    }
  }

  const timestamp = nowIso();
  const result = await mutateMonitors((monitors) => {
    // Recreate the plan inside the serialized mutation. A concurrent edit must
    // not turn a safe preview into a partial host migration.
    const currentPlan = planSiteHostReplacement(monitors, sourceHost, targetHost);
    if (!currentPlan.ok) {
      return currentPlan;
    }

    const replacementsById = new Map(currentPlan.replacements.map((replacement) => [replacement.id, replacement]));
    for (let index = 0; index < monitors.length; index += 1) {
      const replacement = replacementsById.get(monitors[index].id);
      if (replacement) {
        monitors[index] = resetMonitorForPageUrl(monitors[index], replacement.targetUrl, timestamp);
      }
    }
    return {
      ok: true,
      count: currentPlan.replacements.length,
      sourceUrls: currentPlan.replacements.map((replacement) => replacement.sourceUrl)
    };
  });

  if (!result?.ok) {
    return result;
  }

  await Promise.all([...new Set(result.sourceUrls)].map((sourceUrl) => releaseUnusedSitePermission(sourceUrl)));
  await reconcileLiveSessions().catch(() => undefined);
  await refreshBadge();
  await scheduleNextAlarm();
  return { ok: true, count: result.count };
}

async function deletePage(urlValue) {
  const url = normalizeUrl(urlValue);
  if (!url) return { ok: false, error: '삭제할 페이지 주소가 올바르지 않습니다.' };

  const existing = (await getMonitors()).filter((monitor) => monitor.url === url);
  await Promise.all(existing
    .filter((monitor) => isLiveTracking(monitor))
    .map((monitor) => detachLiveSession(monitor.id)));
  let deleted = [];
  await mutateMonitors((monitors) => {
    const kept = [];
    for (const monitor of monitors) {
      if (monitor.url === url) deleted.push(monitor);
      else kept.push(monitor);
    }
    monitors.splice(0, monitors.length, ...kept);
  });
  if (!deleted.length) return { ok: false, error: '삭제할 추적 페이지를 찾을 수 없습니다.' };

  await releaseUnusedSitePermission(url);
  await reconcileLiveSessions().catch(() => undefined);
  await refreshBadge();
  await scheduleNextAlarm();
  return { ok: true, deletedCount: deleted.length };
}

async function acknowledgeMonitor(id) {
  const viewedAt = nowIso();
  await mutateMonitors((monitors) => {
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor) {
      return;
    }
    monitor.unread = false;
    monitor.lastViewedAt = viewedAt;
    if (monitor.status === 'changed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot, monitor.tracking);
    }
    monitor.updatedAt = viewedAt;
  });
  await refreshBadge();
  return { ok: true };
}

async function openMonitorWindow(id) {
  const monitor = (await getMonitors()).find((item) => item.id === id);
  if (!monitor) {
    return { ok: false, error: '모니터를 찾을 수 없습니다.' };
  }

  await chrome.windows.create({
    url: monitor.url,
    type: 'popup',
    width: 520,
    height: 680,
    focused: true
  });
  await acknowledgeMonitor(id);
  return { ok: true };
}

async function importMonitors(message) {
  const beforeImport = await getMonitors();
  const sourceMonitors = Array.isArray(message.monitors) ? message.monitors : [];
  const rawMonitors = sourceMonitors.slice(0, MAX_MONITORS);
  const prepared = [];
  const usedIds = new Set();
  let rejected = Math.max(0, sourceMonitors.length - MAX_MONITORS);
  let imported = 0;
  let disabledForPermission = 0;

  for (const raw of rawMonitors) {
    if (!raw || typeof raw !== 'object') {
      rejected += 1;
      continue;
    }

    const monitor = normalizeMonitor(raw);
    if (!monitor) {
      rejected += 1;
      continue;
    }
    try {
      await validateLocatorList(monitor.locators);
    } catch {
      rejected += 1;
      continue;
    }

    while (usedIds.has(monitor.id)) {
      monitor.id = createId();
    }
    usedIds.add(monitor.id);
    monitor.revision = createRevision();

    if (!monitor.snapshot && monitor.status === 'ok') {
      monitor.status = 'needs-baseline';
    }
    if (monitor.enabled && !await hasSitePermission(monitor.url)) {
      monitor.enabled = false;
      monitor.status = 'permission-needed';
      monitor.lastError = '가져온 추적에 이 사이트의 접근 권한이 필요합니다.';
      disabledForPermission += 1;
    } else if (!monitor.enabled && monitor.status === 'permission-needed') {
      monitor.status = statusForStoredSnapshot(monitor.snapshot, monitor.tracking);
      monitor.lastError = null;
    }
    prepared.push(monitor);
  }

  const result = await mutateMonitors((monitors) => {
    if (message.mode === 'replace') {
      monitors.splice(0, monitors.length);
    }

    for (const preparedMonitor of prepared) {
      const monitor = {
        ...preparedMonitor,
        selectors: [...preparedMonitor.selectors],
        locators: preparedMonitor.locators.map((locator) => ({
          ...locator,
          framePath: locator.framePath.map((part) => ({ ...part })),
          fields: locator.fields.map((field) => ({ ...field }))
        }))
      };
      // Importing is additive in merge mode. URLs are intentionally not a
      // uniqueness key; only the persistent monitor id must be unique.
      while (monitors.some((item) => item.id === monitor.id)) {
        monitor.id = createId();
      }

      if (monitors.length < MAX_MONITORS) {
        monitors.push(monitor);
        imported += 1;
      } else {
        rejected += 1;
      }
    }
    return { ok: true, imported, rejected, disabledForPermission };
  });

  await reconcileLiveSessions().catch(() => undefined);
  await refreshBadge();
  await scheduleNextAlarm();
  await Promise.all(beforeImport.map((monitor) => releaseUnusedSitePermission(monitor.url)));
  return result;
}

async function openDashboard() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  return { ok: true };
}

async function releaseUnclaimedOrigin(message, sender) {
  const url = normalizeUrl(message.url);
  await releasePendingPicker(message.tabId ?? sender?.tab?.id);
  if (url) {
    await releaseUnusedSitePermission(url);
  }
  return { ok: true };
}

async function startPicker(tabId, url) {
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: '현재 탭을 찾을 수 없습니다.' };
  }
  const normalizedUrl = normalizeUrl(url);
  if (normalizedUrl) {
    await rememberPendingPicker(tabId, normalizedUrl);
  }
  try {
    // picker.js reads getBoundingClientRect() to position its highlights. Wait
    // until the document has finished loading, then keep the requested 2.5 s
    // settling window before asking it for any element coordinates.
    await waitForPageLoadAndPickerDelay(tabId);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['selector-engine.js', 'picker.js']
    });
  } catch (error) {
    await forgetPendingPicker(tabId);
    throw error;
  }
  return { ok: true };
}

const messageHandlers = {
  'get-state': async () => ({ ok: true, ...(await getState()) }),
  'start-picker': (message) => startPicker(message.tabId, message.url),
  'create-monitor': (message, sender) => createMonitor(message, sender),
  'create-monitors': (message, sender) => createMonitors(message, sender),
  'save-monitor': (message) => saveMonitor(message),
  'set-monitor-enabled': (message) => setMonitorEnabled(message),
  'delete-monitor': (message) => deleteMonitor(message.id),
  'check-monitor': (message) => checkMonitor(message.id),
  'start-live-monitor': (message) => startLiveMonitor(message),
  'stop-live-monitor': (message) => stopLiveMonitor(message),
  'live-monitor-mutated': (message, sender) => handleLiveMonitorMutation(message, sender),
  'check-monitors': (message) => checkMonitors(message),
  'check-page': (message) => checkPage(message.url),
  'move-page-url': (message) => reusePageUrl(message),
  'copy-page-url': (message) => reusePageUrl(message, { copy: true }),
  'replace-site-host': (message) => replaceSiteHost(message),
  'delete-page': (message) => deletePage(message.url),
  'acknowledge-monitor': (message) => acknowledgeMonitor(message.id),
  'open-monitor-window': (message) => openMonitorWindow(message.id),
  'import-monitors': (message) => importMonitors(message),
  'open-dashboard': () => openDashboard(),
  'release-unclaimed-origin': (message, sender) => releaseUnclaimedOrigin(message, sender),
  'save-settings': async (message) => ({ ok: true, settings: await updateSettings(message.settings) })
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = messageHandlers[message?.type];
  if (!handler) {
    return;
  }

  Promise.resolve(handler(message, _sender)).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: responseError(error) });
  });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void runDueChecks();
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith('openstill-change:')) {
    void openMonitorWindow(notificationId.slice('openstill-change:'.length));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void releasePendingPicker(tabId);
  void forgetLiveControlledTabByTabId(tabId);
  for (const [monitorId, session] of liveSessions) {
    if (session.tabId === tabId) {
      liveSessions.delete(monitorId);
      liveDirtyByMonitor.delete(monitorId);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    void releasePendingPicker(tabId);
    for (const [monitorId, session] of liveSessions) {
      if (session.tabId === tabId) {
        // Keep ownership through a controlled-tab reload. The old isolated
        // observer is destroyed by navigation; completion reuses this exact
        // tab and installs a fresh one without ever falling back to a user tab.
        session.navigating = true;
        session.frameIds = new Set();
        session.rawTextByFrame = new Map();
        liveDirtyByMonitor.delete(monitorId);
      }
    }
  } else if (changeInfo.status === 'complete') {
    void restoreLiveForTab(tabId, changeInfo.url ? { id: tabId, url: changeInfo.url } : null).catch(() => undefined);
  }
  if (changeInfo.url && changeInfo.status !== 'loading') {
    void (async () => {
      const url = normalizeUrl(changeInfo.url);
      if (!url) return;
      const monitors = new Map((await getMonitors()).map((monitor) => [monitor.id, monitor]));
      for (const [monitorId, session] of [...liveSessions]) {
        if (session.tabId !== tabId) continue;
        const monitor = monitors.get(monitorId);
        if (!monitor || monitor.url !== url) await detachLiveSession(monitorId);
      }
      await restoreLiveForTab(tabId, { id: tabId, url });
    })().catch(() => undefined);
  }
});

if (chrome.webNavigation?.onCompleted) {
  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0) {
      void restoreLiveForTab(details.tabId).catch(() => undefined);
    } else {
      void reinstallLiveFrame(details.tabId, details.frameId).catch(() => undefined);
    }
  });
}

if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) {
      void restoreLiveForTab(details.tabId).catch(() => undefined);
    } else {
      void reinstallLiveFrame(details.tabId, details.frameId).catch(() => undefined);
    }
  });
}

async function initialize({ cleanupPermissions = false } = {}) {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  await migrateLegacyScheduleModes();
  await refreshBadge();
  await clearExpiredPendingPickers();
  if (cleanupPermissions) {
    await cleanupUnusedSitePermissions();
  }
  await scheduleNextAlarm();
  await restoreLiveMonitoring().catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize({ cleanupPermissions: true });
});

chrome.runtime.onStartup.addListener(() => {
  void initialize({ cleanupPermissions: true });
});

void initialize();
