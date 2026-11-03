// ---------- Create invite: pure logic ----------
// No page, no storage, no network: reads the directory file's records, searches
// people and builds the Outlook link, so it can be tested on its own
// (test/invite-core.test.html). invite.js holds the window around it.
(function (root) {
  'use strict';

  const OUTLOOK_COMPOSE_URL = 'https://outlook.office.com/calendar/deeplink/compose';
  const EMAIL_RE = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/;

  function isEmail(text) { return EMAIL_RE.test(String(text || '').trim()); }

  // Lower case, no accents, punctuation as spaces: "DOE,JANE" and
  // "Doe, Jane" must search the same.
  function fold(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').trim();
  }

  function capitaliseIfShouting(word) {
    if (word !== word.toUpperCase() || word === word.toLowerCase()) return word;
    return word.toLowerCase().replace(/(^|[-'(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }

  // The directory writes "SURNAME, Given" with varying case and spacing.
  function displayName(raw) {
    const name = String(raw || '').trim();
    const m = name.match(/^([^,]+),\s*([^()]+?)\s*(\(.*\))?$/);
    const ordered = m ? [m[2], m[1], m[3]].filter(Boolean).join(' ') : name;
    return ordered.split(/\s+/).map(capitaliseIfShouting).join(' ');
  }

  // Being in the directory is not enough: the tenant also lists external guests
  // (#EXT#). A member account counts with a company or a GreenYellow address,
  // because many real records have no company, and wrongly calling a colleague
  // external would leave their calendar unchecked.
  function isStaff(record) {
    const upn = String(record.upn || '');
    const nick = String(record.nickname || '');
    if (upn.includes('#EXT#') || nick.includes('#EXT#')) return false;
    const domain = String(record.email || '').split('@')[1] || '';
    return !!String(record.company || '').trim() || /greenyellow/i.test(domain);
  }

  // Accepts the flow's list as written. Anything without an address is dropped,
  // and only the listed fields are kept, so a phone number in a file goes no further.
  function normalizeDirectory(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.people) ? raw.people : null);
    if (!list) throw new Error('The directory file does not contain a list of people.');
    const byEmail = new Map();
    list.forEach((r) => {
      if (!r || !isEmail(r.email) || r.enabled === false) return;
      const email = String(r.email).trim();
      const key = email.toLowerCase();
      if (byEmail.has(key)) return;
      const nick = String(r.nickname || '');
      byEmail.set(key, {
        name: displayName(r.name) || email,
        email,
        // A guest's nickname is only its address in another form.
        nickname: nick.includes('#EXT#') ? '' : nick,
        title: String(r.title || ''),
        department: String(r.department || ''),
        company: String(r.company || ''),
        city: String(r.city || ''),
        country: String(r.country || ''),
        kind: isStaff(r) ? 'staff' : 'external',
      });
    });
    return [...byEmail.values()];
  }

  // nicknames: { "Nickname": "address" } from the optional file in the same folder.
  function searchPeople(query, people, nicknames, limit) {
    const words = fold(query).split(' ').filter(Boolean);
    if (!words.length) return [];
    const extra = new Map();
    Object.entries(nicknames || {}).forEach(([nick, email]) => {
      const key = String(email).trim().toLowerCase();
      extra.set(key, `${extra.get(key) || ''} ${nick}`);
    });
    const scored = [];
    people.forEach((p) => {
      const nameWords = fold(p.name).split(' ');
      const emailStart = fold(p.email.split('@')[0]);
      const otherWords = fold(`${p.nickname} ${extra.get(p.email.toLowerCase()) || ''}`).split(' ').filter(Boolean);
      let score = 0;
      // Every typed word must start a word of the name, nickname or address, in any order.
      const allMatch = words.every((w) => {
        if (nameWords.some((n) => n === w)) { score += 3; return true; }
        if (nameWords.some((n) => n.startsWith(w))) { score += 2; return true; }
        if (otherWords.some((n) => n.startsWith(w)) || emailStart.startsWith(w)) { score += 2; return true; }
        return false;
      });
      if (allMatch) scored.push({ person: p, score: score + (p.kind === 'staff' ? 1 : 0) });
    });
    return scored.sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name))
      .slice(0, limit || 8).map((s) => s.person);
  }

  // The zone's own rules give the offset, rather than a number written down here.
  function zoneOffset(dateKey, time, timeZone) {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${dateKey}T${time}:00Z`)).find((p) => p.type === 'timeZoneName');
    const m = part && part.value.match(/GMT([+-]\d{2}:\d{2})/);
    return m ? m[1] : '+00:00';
  }

  // Date and time as the zone's clock shows them, plus minutes, as a string with offset.
  function meetingTimes(dateKey, time, minutes, timeZone) {
    const offset = zoneOffset(dateKey, time, timeZone);
    const startMs = Date.parse(`${dateKey}T${time}:00${offset}`);
    const wall = new Date(Date.parse(`${dateKey}T${time}:00Z`) + minutes * 60000).toISOString().slice(0, 16);
    return { start: `${dateKey}T${time}:00${offset}`, end: `${wall}:00${zoneOffset(wall.slice(0, 10), wall.slice(11), timeZone)}`, startMs };
  }

  function outlookInviteUrl({ subject, start, end, emails, teams }) {
    const params = [
      ['subject', subject], ['startdt', start], ['enddt', end],
      // Outlook on the web separates attendees with ";", as the email links do.
      ['to', (emails || []).join(';')],
    ];
    if (teams) params.push(['online', 'true']);
    return `${OUTLOOK_COMPOSE_URL}?${params.filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  }

  // ---------- Finding a time ----------

  // Outlook gives each person's zone as a Windows name; the slot engine needs IANA.
  const WINDOWS_ZONES = {
    'SE Asia Standard Time': 'Asia/Bangkok', 'Singapore Standard Time': 'Asia/Singapore',
    'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
    'India Standard Time': 'Asia/Kolkata', 'Arabian Standard Time': 'Asia/Dubai', 'Arab Standard Time': 'Asia/Riyadh',
    'Romance Standard Time': 'Europe/Paris', 'W. Europe Standard Time': 'Europe/Berlin',
    'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
    'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Africa/Abidjan',
    'South Africa Standard Time': 'Africa/Johannesburg', 'W. Central Africa Standard Time': 'Africa/Lagos',
    'E. Africa Standard Time': 'Africa/Nairobi', 'Mauritius Standard Time': 'Indian/Mauritius',
    'E. South America Standard Time': 'America/Sao_Paulo', 'SA Pacific Standard Time': 'America/Bogota',
    'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
    'Pacific Standard Time': 'America/Los_Angeles', 'UTC': 'UTC',
  };
  const WEEKDAYS = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

  function personHours(hours) {
    const tz = hours && hours.timeZone && WINDOWS_ZONES[hours.timeZone.name];
    if (!tz || !hours.startTime || !hours.endTime) return null;
    const workDays = (hours.daysOfWeek || []).map((d) => WEEKDAYS[String(d).toLowerCase()]).filter(Boolean);
    return { tz, start: hours.startTime.slice(0, 5), end: hours.endTime.slice(0, 5), workDays: workDays.length ? workDays : [1, 2, 3, 4, 5] };
  }

  // Reads the flow's reply. Only status and times are kept, so the organiser's
  // meeting subjects and locations go no further than this function.
  function parseSchedule(reply) {
    if (!reply || reply.error || !Array.isArray(reply.value)) {
      throw new Error((reply && reply.error && (reply.error.message || reply.error)) || 'The calendar reply could not be read.');
    }
    return reply.value.map((s) => {
      if (s.error) return { email: s.scheduleId, ok: false, message: s.error.message || 'not available', items: [], hours: null };
      return {
        email: s.scheduleId,
        ok: true,
        items: (s.scheduleItems || []).map((it) => ({
          status: it.status,
          // Date.parse would read a time without a zone as local; these are UTC.
          startMs: Date.parse(`${String(it.start.dateTime).slice(0, 19)}Z`),
          endMs: Date.parse(`${String(it.end.dateTime).slice(0, 19)}Z`),
        })),
        hours: personHours(s.workingHours),
      };
    });
  }

  function personBusy(person, tentativeIsBusy) {
    const blocking = { busy: true, oof: true, tentative: !!tentativeIsBusy };
    return person.items.filter((it) => blocking[it.status]).map(({ startMs, endMs }) => ({ startMs, endMs }));
  }

  // Up to `count` slots, best first: clear of everyone within their hours, then
  // back-to-back, then outside someone's hours. Lower tiers are labelled, not hidden.
  // o: { engine, people, myEmail, me: {tz,start,end}, lunch, durationMin, startMs, endMs, bufferMin, tentativeIsBusy, count }
  function proposeSlots(o) {
    const E = o.engine;
    const count = o.count || 5;
    const readable = o.people.filter((p) => p.ok);
    const isMe = (p) => p.email.toLowerCase() === o.myEmail.toLowerCase();
    const others = readable.filter((p) => !isMe(p));
    const withHours = others.filter((p) => p.hours);
    const busyByPerson = readable.map((p) => ({ person: p, busy: personBusy(p, o.tentativeIsBusy) }));
    const busy = busyByPerson.flatMap((b) => b.busy);
    const meZone = { ...o.me, workDays: [1, 2, 3, 4, 5] };
    const allZones = [meZone, ...withHours.map((p) => p.hours)];
    const base = { busy, startMs: o.startMs, endMs: o.endMs, durationMin: o.durationMin, stepMin: 30, lunch: o.lunch };

    const outsideFor = (slot) => withHours.filter((p) => {
      const s = E.localParts(slot.startMs, p.hours.tz);
      const e = E.localParts(slot.endMs - 1, p.hours.tz);
      return s.dateKey !== e.dateKey || !p.hours.workDays.includes(s.weekday)
        || s.minutes < E.toMinutes(p.hours.start) || s.minutes + o.durationMin > E.toMinutes(p.hours.end);
    });
    const within = (slot, gap) => busy.some((b) => b.startMs < slot.endMs + gap && b.endMs > slot.startMs - gap);

    const picked = [];
    const attempts = [
      { zones: allZones, bufferMin: o.bufferMin }, { zones: allZones, bufferMin: 0 },
      { zones: [meZone], bufferMin: o.bufferMin }, { zones: [meZone], bufferMin: 0 },
    ];
    attempts.forEach((attempt) => {
      [1, 3].forEach((maxPerDay) => {
        if (picked.length >= count) return;
        E.findSlots({ ...base, ...attempt, count, maxPerDay }).slots.forEach((slot) => {
          if (picked.length >= count || picked.some((p) => slot.startMs < p.endMs && slot.endMs > p.startMs)) return;
          const outside = outsideFor(slot);
          picked.push({
            startMs: slot.startMs,
            endMs: slot.endMs,
            outside: outside.map((p) => ({ email: p.email, startMinutes: E.localParts(slot.startMs, p.hours.tz).minutes, tz: p.hours.tz })),
            backToBack: within(slot, o.bufferMin * 60000),
            elsewhere: readable.filter((p) => p.items.some((it) => it.status === 'workingElsewhere' && it.startMs < slot.endMs && it.endMs > slot.startMs)).map((p) => p.email),
          });
        });
      });
    });

    // Who stands in the way, for when nothing clean is left.
    const blockers = busyByPerson.map(({ person, busy: own }) => {
      const r = E.findSlots({ ...base, busy: own, zones: allZones, bufferMin: 0, count: 1 });
      return { email: person.email, blocked: r.candidatesIgnoringBusy - r.candidates };
    }).filter((b) => b.blocked > 0).sort((a, b) => b.blocked - a.blocked);
    const shared = E.findSlots({ ...base, busy: [], zones: allZones, bufferMin: 0, count: 1 }).candidatesIgnoringBusy;
    return {
      slots: picked,
      clear: picked.filter((s) => !s.outside.length && !s.backToBack).length,
      withinHours: picked.filter((s) => !s.outside.length).length,
      blockers,
      noSharedHours: shared === 0,
      hoursUnknown: others.filter((p) => !p.hours).map((p) => p.email),
    };
  }

  const api = { isEmail, fold, displayName, isStaff, normalizeDirectory, searchPeople, meetingTimes, outlookInviteUrl, parseSchedule, proposeSlots };
  root.InviteCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
