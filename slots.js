/*
 * slots.js — the slot-finding engine.
 *
 * This file has NO dependency on Outlook. It receives a list of busy periods
 * and a set of rules, and returns the best free slots. Because it is pure
 * logic, it can be tested on its own (see test/slots.test.js).
 *
 * Core idea: every time is handled as a single universal instant (UTC
 * milliseconds). Each time zone's local clock is only "looked at" through the
 * browser's built-in Intl time-zone database, which already knows daylight
 * saving changes (e.g. Paris moving from UTC+2 to UTC+1 on 25 Oct 2026).
 */
(function (root) {
  "use strict";

  var MIN = 60 * 1000;
  var formatterCache = {};

  // Read the local calendar date, clock time and weekday of an instant in a zone.
  function localParts(utcMs, tz) {
    var f = formatterCache[tz];
    if (!f) {
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, hourCycle: "h23", weekday: "short",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
      });
      formatterCache[tz] = f;
    }
    var p = {};
    f.formatToParts(new Date(utcMs)).forEach(function (x) { p[x.type] = x.value; });
    var weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return {
      dateKey: p.year + "-" + p.month + "-" + p.day,
      minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
      weekday: weekdays[p.weekday]
    };
  }

  // "09:30" -> 570 minutes after midnight
  function toMinutes(hhmm) {
    var a = String(hhmm).split(":");
    return parseInt(a[0], 10) * 60 + parseInt(a[1] || "0", 10);
  }

  /*
   * findSlots(options) — returns { slots, candidatesIgnoringBusy, candidates }
   *
   * options:
   *   busy           [{ startMs, endMs }]  periods that cannot be used
   *   startMs, endMs search window (UTC ms)
   *   durationMin    meeting length
   *   stepMin        granularity of start times (default 30)
   *   bufferMin      free time required before and after existing meetings
   *   zones          [{ tz, label, start:"09:00", end:"18:00", workDays:[1..5] }]
   *                  zones[0] is the organiser (you)
   *   lunch          { start:"12:00", end:"13:00" } in the organiser's zone, or null
   *   blockedDates   ["2026-10-23", ...] organiser-zone dates to skip (holidays)
   *   count          number of slots wanted
   *   maxPerDay      maximum slots proposed on one day (spreads the options)
   */
  function findSlots(o) {
    var step = (o.stepMin || 30) * MIN;
    var dur = o.durationMin * MIN;
    var buffer = (o.bufferMin || 0) * MIN;
    var me = o.zones[0];
    var blocked = {};
    (o.blockedDates || []).forEach(function (d) { blocked[d] = true; });
    var busy = (o.busy || []).slice().sort(function (a, b) { return a.startMs - b.startMs; });

    // Start on a clean step boundary (e.g. 10:00 or 10:30, never 10:07).
    var t0 = Math.ceil(o.startMs / step) * step;
    var byDay = {};       // organiser date -> candidate slots
    var dayOrder = [];
    var ignoringBusy = 0;
    var total = 0;

    for (var t = t0; t + dur <= o.endMs; t += step) {
      var end = t + dur;
      var ok = true;
      var comfort = Infinity; // distance (minutes) to the nearest working-hour edge
      var myDay = null;

      // Rule 1 — inside working hours and working days for EVERY party.
      for (var z = 0; z < o.zones.length && ok; z++) {
        var zone = o.zones[z];
        var s = localParts(t, zone.tz);
        var e = localParts(end - 1, zone.tz); // last minute of the meeting
        var startMin = s.minutes;
        var endMin = startMin + o.durationMin;
        var days = zone.workDays || [1, 2, 3, 4, 5];
        if (s.dateKey !== e.dateKey) ok = false;                 // crosses midnight
        else if (days.indexOf(s.weekday) < 0) ok = false;        // weekend for them
        else if (startMin < toMinutes(zone.start) || endMin > toMinutes(zone.end)) ok = false;
        if (ok) comfort = Math.min(comfort, startMin - toMinutes(zone.start), toMinutes(zone.end) - endMin);
        if (z === 0) myDay = s;
      }
      if (!ok) continue;

      // Rule 2 — organiser's lunch break and blocked dates (public holidays).
      if (o.lunch) {
        var ls = toMinutes(o.lunch.start), le = toMinutes(o.lunch.end);
        var ms = myDay.minutes, me2 = myDay.minutes + o.durationMin;
        if (ms < le && me2 > ls) continue;
      }
      if (blocked[myDay.dateKey]) continue;

      ignoringBusy++;

      // Rule 3 — no clash with any busy period, keeping a buffer either side.
      var clash = false;
      for (var i = 0; i < busy.length; i++) {
        if (busy[i].startMs >= end + buffer) break; // sorted: later items cannot clash
        if (busy[i].endMs > t - buffer) { clash = true; break; }
      }
      if (clash) continue;

      total++;
      if (!byDay[myDay.dateKey]) { byDay[myDay.dateKey] = []; dayOrder.push(myDay.dateKey); }
      byDay[myDay.dateKey].push({ startMs: t, endMs: end, comfort: comfort });
    }

    // Pick: earliest days first; within a day, the most comfortable time for
    // everyone (furthest from anyone's start/end of day), ties -> earlier time.
    var maxPerDay = o.maxPerDay || 1;
    var slots = [];
    for (var d = 0; d < dayOrder.length && slots.length < o.count; d++) {
      var list = byDay[dayOrder[d]].slice().sort(function (a, b) {
        return b.comfort - a.comfort || a.startMs - b.startMs;
      });
      var picked = [];
      for (var k = 0; k < list.length && picked.length < maxPerDay && slots.length < o.count; k++) {
        var c = list[k];
        var overlaps = picked.some(function (p) { return c.startMs < p.endMs && c.endMs > p.startMs; });
        if (!overlaps) { picked.push(c); slots.push(c); }
      }
    }
    slots.sort(function (a, b) { return a.startMs - b.startMs; });
    return { slots: slots, candidatesIgnoringBusy: ignoringBusy, candidates: total };
  }

  // Search window: from now + notice, until the end of the Nth working day.
  function searchWindow(nowMs, noticeHours, workingDays, tz) {
    var start = nowMs + noticeHours * 60 * MIN;
    var t = start, counted = 0, lastKey = null;
    while (counted < workingDays) {
      var p = localParts(t, tz);
      if (p.dateKey !== lastKey) {
        lastKey = p.dateKey;
        if (p.weekday <= 5) counted++;
      }
      if (counted < workingDays) t += 60 * MIN;
    }
    // run to the end of that local day
    var endKey = localParts(t, tz).dateKey;
    while (localParts(t, tz).dateKey === endKey) t += 30 * MIN;
    return { startMs: start, endMs: t };
  }

  // ---------- Text formatting ----------

  function fmt(utcMs, tz, opts) {
    var o = { timeZone: tz };
    for (var k in opts) o[k] = opts[k];
    return new Intl.DateTimeFormat("en-GB", o).format(new Date(utcMs));
  }

  function zoneAbbrev(utcMs, tz) {
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date(utcMs));
    for (var i = 0; i < parts.length; i++) if (parts[i].type === "timeZoneName") return parts[i].value;
    return "";
  }

  // One line per slot, e.g.
  // "Tuesday 13 October 2026: 15:00–15:30 Bangkok (GMT+7) | 10:00–10:30 Paris (CEST)"
  function formatSlot(slot, zones) {
    var hm = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    // Build "Tuesday 13 October 2026" from parts so the punctuation is identical in every browser.
    var dp = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: zones[0].tz, weekday: "long", day: "numeric", month: "long", year: "numeric" })
      .formatToParts(new Date(slot.startMs)).forEach(function (x) { dp[x.type] = x.value; });
    var head = dp.weekday + " " + dp.day + " " + dp.month + " " + dp.year;
    var headKey = localParts(slot.startMs, zones[0].tz).dateKey;
    var pieces = zones.map(function (z) {
      var piece = fmt(slot.startMs, z.tz, hm) + "–" + fmt(slot.endMs, z.tz, hm) +
        " " + z.label + " (" + zoneAbbrev(slot.startMs, z.tz) + ")";
      if (localParts(slot.startMs, z.tz).dateKey !== headKey) {
        var sp = {};
        new Intl.DateTimeFormat("en-GB", { timeZone: z.tz, weekday: "short", day: "numeric", month: "short" })
          .formatToParts(new Date(slot.startMs)).forEach(function (x) { sp[x.type] = x.value; });
        piece = sp.weekday + " " + sp.day + " " + sp.month + ", " + piece;
      }
      return piece;
    });
    return head + ": " + pieces.join(" | ");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fill(template, durationMin) {
    return String(template).replace(/\{duration\}/g, durationMin + "-minute");
  }

  function buildEmail(slots, zones, durationMin, intro, outro) {
    var lines = slots.map(function (s) { return formatSlot(s, zones); });
    var html = "<p>" + escapeHtml(fill(intro, durationMin)) + "</p><ul>" +
      lines.map(function (l) { return "<li>" + escapeHtml(l) + "</li>"; }).join("") +
      "</ul><p>" + escapeHtml(fill(outro, durationMin)) + "</p>";
    var text = fill(intro, durationMin) + "\n" +
      lines.map(function (l) { return "  - " + l; }).join("\n") + "\n" + fill(outro, durationMin) + "\n";
    return { html: html, text: text, lines: lines };
  }

  var api = {
    localParts: localParts, toMinutes: toMinutes, findSlots: findSlots,
    searchWindow: searchWindow, formatSlot: formatSlot, buildEmail: buildEmail
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SlotEngine = api;
})(this);
