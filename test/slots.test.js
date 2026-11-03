// Run with:  node --test test/
// These tests check the slot engine without Outlook, using made-up calendars.
const test = require("node:test");
const assert = require("node:assert");
const E = require("../web/slots.js");

const BKK = { tz: "Asia/Bangkok", label: "Bangkok", start: "09:00", end: "18:00" };
const PAR = { tz: "Europe/Paris", label: "Paris", start: "09:00", end: "18:00" };
const NYC = { tz: "America/New_York", label: "New York", start: "09:00", end: "18:00" };

// Helper: a Bangkok wall-clock time -> UTC ms (Bangkok is UTC+7 all year, no daylight saving)
const bkk = (iso) => Date.parse(iso + "+07:00");
const bkkClock = (ms) => E.localParts(ms, "Asia/Bangkok");
const base = { durationMin: 30, stepMin: 30, bufferMin: 0, count: 3, maxPerDay: 1 };

test("Bangkok + Paris before 25 Oct: only 14:00-18:00 Bangkok is shared; picks mid-overlap", () => {
  const r = E.findSlots({ ...base, zones: [BKK, PAR], startMs: bkk("2026-10-13T00:00"), endMs: bkk("2026-10-16T00:00") });
  assert.strictEqual(r.slots.length, 3);
  for (const s of r.slots) {
    const p = bkkClock(s.startMs);
    assert.ok(p.minutes >= 14 * 60 && p.minutes + 30 <= 18 * 60, "outside shared hours");
  }
  assert.strictEqual(bkkClock(r.slots[0].startMs).minutes, 15 * 60 + 30); // 15:30 Bangkok = 10:30 Paris
});

test("After Paris daylight saving ends (26 Oct): shared window moves to 15:00-18:00 Bangkok", () => {
  const r = E.findSlots({ ...base, count: 5, zones: [BKK, PAR], startMs: bkk("2026-10-26T00:00"), endMs: bkk("2026-10-31T00:00") });
  assert.ok(r.slots.length > 0);
  for (const s of r.slots) assert.ok(bkkClock(s.startMs).minutes >= 15 * 60);
});

test("Buffer: a 15:00-16:00 meeting with 15-min buffer blocks 16:00 but allows 16:30", () => {
  const busy = [{ startMs: bkk("2026-10-13T15:00"), endMs: bkk("2026-10-13T16:00") }];
  const opts = { ...base, count: 50, maxPerDay: 50, bufferMin: 15, zones: [BKK], busy,
    startMs: bkk("2026-10-13T14:00"), endMs: bkk("2026-10-13T18:00") };
  const starts = E.findSlots(opts).slots.map((s) => bkkClock(s.startMs).minutes);
  assert.ok(!starts.includes(16 * 60), "16:00 should be blocked by the buffer");
  assert.ok(!starts.includes(14 * 60 + 30), "14:30 should be blocked by the buffer");
  assert.ok(starts.includes(16 * 60 + 30));
  assert.ok(starts.includes(14 * 60));
});

test("Weekends are never proposed", () => {
  const r = E.findSlots({ ...base, count: 10, zones: [BKK], startMs: bkk("2026-10-16T00:00"), endMs: bkk("2026-10-20T00:00") });
  for (const s of r.slots) assert.ok(bkkClock(s.startMs).weekday <= 5);
});

test("Bangkok + New York with 09:00-18:00 each: no overlap is reported, not hidden", () => {
  const r = E.findSlots({ ...base, zones: [BKK, NYC], startMs: bkk("2026-10-13T00:00"), endMs: bkk("2026-10-20T00:00") });
  assert.strictEqual(r.slots.length, 0);
  assert.strictEqual(r.candidatesIgnoringBusy, 0);
});

test("Lunch break 12:00-13:00 Bangkok is respected", () => {
  const r = E.findSlots({ ...base, count: 50, maxPerDay: 50, zones: [BKK], lunch: { start: "12:00", end: "13:00" },
    startMs: bkk("2026-10-13T11:00"), endMs: bkk("2026-10-13T14:00") });
  const starts = r.slots.map((s) => bkkClock(s.startMs).minutes);
  assert.ok(!starts.includes(12 * 60) && !starts.includes(12 * 60 + 30));
  assert.ok(starts.includes(11 * 60 + 30)); // 11:30-12:00 ends exactly at lunch: allowed
});

test("Spread: one slot per day gives three different days", () => {
  const r = E.findSlots({ ...base, zones: [BKK], startMs: bkk("2026-10-13T00:00"), endMs: bkk("2026-10-20T00:00") });
  const days = new Set(r.slots.map((s) => bkkClock(s.startMs).dateKey));
  assert.strictEqual(days.size, 3);
});

test("Blocked dates (holidays) are skipped", () => {
  const r = E.findSlots({ ...base, zones: [BKK], blockedDates: ["2026-10-13"], startMs: bkk("2026-10-13T00:00"), endMs: bkk("2026-10-16T00:00") });
  for (const s of r.slots) assert.notStrictEqual(bkkClock(s.startMs).dateKey, "2026-10-13");
});

test("Search window: Mon 23:00 + 12h notice + 5 working days ends at midnight after Mon 19 Oct", () => {
  const w = E.searchWindow(bkk("2026-10-12T23:00"), 12, 5, "Asia/Bangkok");
  assert.strictEqual(w.startMs, bkk("2026-10-13T11:00"));
  assert.strictEqual(w.endMs, bkk("2026-10-20T00:00"));
});

test("Email text shows each party's own clock and zone", () => {
  const slot = { startMs: bkk("2026-10-13T15:30"), endMs: bkk("2026-10-13T16:00") };
  const line = E.formatSlot(slot, [BKK, PAR]);
  assert.strictEqual(line, "Tuesday 13 October 2026: 15:30–16:00 Bangkok (GMT+7) | 10:30–11:00 Paris (CEST)");
  const nyLine = E.formatSlot({ startMs: bkk("2026-10-13T08:00"), endMs: bkk("2026-10-13T08:30") }, [BKK, NYC]);
  assert.ok(nyLine.includes("Mon 12 Oct, 21:00–21:30 New York (GMT-4)"), nyLine);
  const mail = E.buildEmail([slot], [BKK, PAR], 30, "Proposed times for a {duration} call:", "Thank you.");
  assert.ok(mail.html.includes("30-minute call") && mail.html.includes("<li>"));
});
