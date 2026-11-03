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

  const api = { isEmail, fold, displayName, isStaff, normalizeDirectory, searchPeople, meetingTimes, outlookInviteUrl };
  root.InviteCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
