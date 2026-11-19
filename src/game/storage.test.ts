// Persistence: versioned saves, validation, migration from older formats, and never clobbering data written
// by a newer build. Runs in Node against an in-memory localStorage. Run with `npm test`.
import assert from 'node:assert/strict';

const memory = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    setItem: (k: string, v: string) => void memory.set(k, String(v)),
    removeItem: (k: string) => void memory.delete(k),
  },
};
const storage = await import('./storage');
const { DEFAULT_SETTINGS, getRecord, loadSettings, loadSeenTips, recordRun, saveSettings, todayLabel } = storage;

let failures = 0;
function check(name: string, fn: () => void): void {
  memory.clear();
  try {
    fn();
  } catch (err) {
    failures++;
    console.error(`${name}: ${(err as Error).message}`);
  }
}
const put = (key: string, value: unknown) => memory.set(key, typeof value === 'string' ? value : JSON.stringify(value));
const get = (key: string) => JSON.parse(memory.get(key) ?? 'null');

check('defaults when nothing is stored', () => {
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

check('legacy (unversioned) settings migrate and every field is validated', () => {
  put('level0.settings.v1', { sensitivity: 99, invertY: 'yes', volume: -1, fov: null, quality: 'ultra', tips: 0 });
  assert.deepEqual(loadSettings(), {
    sensitivity: 3,
    invertY: false,
    volume: 0,
    fov: 72,
    quality: 'auto',
    tips: true,
  });
});

check('valid legacy settings survive the migration', () => {
  const mine = { sensitivity: 1.5, invertY: true, volume: 0.4, fov: 85, quality: 'low', tips: false };
  put('level0.settings.v1', mine);
  assert.deepEqual(loadSettings(), mine);
});

check('settings are saved as a versioned envelope and read back', () => {
  const mine = { ...DEFAULT_SETTINGS, fov: 90, quality: 'high' as const };
  saveSettings(mine);
  assert.deepEqual(get('level0.settings.v1'), { version: 1, data: mine });
  assert.deepEqual(loadSettings(), mine);
});

check('settings from a newer build are not used or overwritten', () => {
  const newer = { version: 99, data: { fov: 80, futureField: true } };
  put('level0.settings.v1', newer);
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  saveSettings({ ...DEFAULT_SETTINGS, fov: 60 });
  assert.deepEqual(get('level0.settings.v1'), newer);
});

check('corrupt JSON falls back to defaults', () => {
  put('level0.settings.v1', '{not json');
  put('level0.tips-seen.v1', '{"oops":1}');
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  assert.equal(loadSeenTips().size, 0);
});

check('v1 records: best times carry over, dailies (different layouts now) do not', () => {
  const today = todayLabel();
  put('level0.records.v1', {
    'all:standard': { bestTime: 100, escapes: 2, deaths: 3 },
    [`daily:${today}:standard`]: { bestTime: 90, escapes: 1, deaths: 0 },
    junk: { bestTime: 'fast' },
  });
  assert.equal(getRecord('standard', 'random').bestTime, 100);
  assert.equal(getRecord('standard', 'daily', today).bestTime, null);
  recordRun('standard', 'random', false, 50);
  const saved = get('level0.records.v2');
  assert.equal(saved.version, 2);
  assert.deepEqual(Object.keys(saved.data), ['all:standard']);
  assert.equal(saved.data['all:standard'].deaths, 4);
  assert.ok(memory.has('level0.records.v1'), 'the old key is left for older builds');
});

check('daily records older than 30 days are pruned on save', () => {
  const today = todayLabel();
  put('level0.records.v2', {
    version: 2,
    data: {
      'daily:2020-01-01:standard': { bestTime: 80, escapes: 1, deaths: 0 },
      [`daily:${today}:standard`]: { bestTime: 120, escapes: 1, deaths: 0 },
    },
  });
  const { isNewBest } = recordRun('standard', 'daily', true, 110, today);
  assert.ok(isNewBest);
  const keys = Object.keys(get('level0.records.v2').data).sort();
  assert.deepEqual(keys, ['all:standard', `daily:${today}:standard`]);
});

check('records from a newer build are not overwritten', () => {
  const newer = { version: 9, data: { 'all:standard': { bestTime: 70, escapes: 5, deaths: 1 } } };
  put('level0.records.v2', newer);
  recordRun('standard', 'random', true, 60);
  assert.deepEqual(get('level0.records.v2'), newer);
});

if (failures > 0) {
  console.error(`\n${failures} storage check(s) failed`);
  process.exit(1);
}
console.log('storage: versioning, validation and migration checks passed');
