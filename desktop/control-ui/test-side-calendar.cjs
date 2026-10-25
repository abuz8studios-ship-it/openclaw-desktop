// Unit check for the sidecar's pure calendar math.
// The sidecar references localStorage at load; stub it before require.
'use strict';
const assert = require('node:assert');
global.localStorage = { getItem: () => null, setItem: () => {} };
const { monthCells, shiftMonth, dayKey, sessionDay } = require('./opc1-side-calendar.js');

// October 2026: 31 days, Oct 1 2026 is a Thursday (4 leading blanks).
const oct = monthCells('2026-10');
assert.strictEqual(oct.filter(Boolean).length, 31);
assert.strictEqual(oct.slice(0, 4).every(c => c === null), true);
assert.strictEqual(oct[4].key, '2026-10-01');
assert.strictEqual(oct.length % 7, 0);
assert.strictEqual(oct.filter(Boolean).pop().key, '2026-10-31');

// February leap year: 2028-02 has 29 days.
const feb = monthCells('2028-02');
assert.strictEqual(feb.filter(Boolean).length, 29);
assert.strictEqual(feb.filter(Boolean).pop().key, '2028-02-29');

assert.strictEqual(shiftMonth('2026-10', 1), '2026-11');
assert.strictEqual(shiftMonth('2026-12', 1), '2027-01');
assert.strictEqual(shiftMonth('2026-01', -1), '2025-12');
assert.strictEqual(dayKey(new Date(2026, 0, 5)), '2026-01-05');

// sessionDay: upstream field priority recencyAt > updatedAt > createdAt.
const d1 = new Date(2026, 9, 19, 12).getTime();
const d2 = new Date(2026, 9, 20, 12).getTime();
assert.strictEqual(sessionDay({ recencyAt: d1, updatedAt: d2 }), '2026-10-19');
assert.strictEqual(sessionDay({ updatedAt: d2, createdAt: d1 }), '2026-10-20');
assert.strictEqual(sessionDay({ createdAt: new Date(d1).toISOString() }), '2026-10-19');
assert.strictEqual(sessionDay({}), null);
assert.strictEqual(sessionDay(null), null);
assert.strictEqual(sessionDay({ recencyAt: 'junk', createdAt: d1 }), '2026-10-19');

console.log('SIDE_CALENDAR_TEST_OK');
