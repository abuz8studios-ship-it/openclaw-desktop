/* OPC-1 sidebar session calendar.
   Successor to the 2026.9.5 bundle patch (body/ops/calendar-grid-20261001):
   same job - month grid by the session list, per-day session counts,
   click a day to show only that day's sessions - but as one sidecar file
   that never touches upstream bundles. Dates come from the app host's
   own session rows (selectedAgentSessionRows, recencyAt ?? updatedAt ??
   createdAt - the same seam the 9.5 patch used), matched to sidebar DOM
   rows by data-session-key. Falls back to <time datetime> rows.
   Deploy/re-apply after an upstream overlay: apply-side-calendar.cjs */
(function () {
  'use strict';
  var MARK = 'data-opc1-calendar';
  var HIDDEN = 'data-opc1-calendar-hidden';
  var STORE = 'opc1.sessions.calendar.date';
  var state = loadState();
  var filtering = !!state.selected;
  var counts = new Map(); // yyyy-mm-dd -> count (loaded rows)
  var observedRoots = new WeakSet();
  var scheduled = false;

  function pad(n) { return String(n).padStart(2, '0'); }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayKey() { return dayKey(new Date()); }

  function loadState() {
    var t = todayKey();
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || '{}');
      return {
        month: /^\d{4}-\d{2}$/.test(s.month || '') ? s.month : t.slice(0, 7),
        selected: /^\d{4}-\d{2}-\d{2}$/.test(s.selected || '') ? s.selected : null
      };
    } catch (e) { return { month: t.slice(0, 7), selected: null }; }
  }
  function saveState() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
  }

  // Pure grid math (unit-tested in test-side-calendar.cjs).
  function monthCells(monthKey) {
    var parts = monthKey.split('-').map(Number);
    var year = parts[0], month = parts[1] - 1;
    var first = new Date(year, month, 1);
    var days = new Date(year, month + 1, 0).getDate();
    var cells = [];
    for (var b = 0; b < first.getDay(); b++) cells.push(null);
    for (var d = 1; d <= days; d++) cells.push({ day: d, key: dayKey(new Date(year, month, d)) });
    while (cells.length % 7) cells.push(null);
    return cells;
  }
  function shiftMonth(monthKey, delta) {
    var parts = monthKey.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1 + delta, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  // Session -> local day key, upstream's own field priority.
  function sessionDay(session) {
    if (!session) return null;
    var fields = [session.recencyAt, session.updatedAt, session.createdAt, session.startedAt];
    for (var i = 0; i < fields.length; i++) {
      var v = fields[i];
      var t = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Date.parse(v) : NaN);
      if (isFinite(t) && t > 0) return dayKey(new Date(t));
    }
    return null;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      monthCells: monthCells, shiftMonth: shiftMonth, dayKey: dayKey, sessionDay: sessionDay
    };
    return;
  }

  /* ---------- DOM location (shadow-DOM piercing) ---------- */
  function walk(node, out) {
    if (!node) return;
    if (node.nodeType === 1) out.push(node);
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i], out);
    if (node.shadowRoot) walk(node.shadowRoot, out);
  }
  function allEls() {
    var out = [];
    walk(document, out);
    return out;
  }
  function ownText(el) {
    var s = '';
    var nodes = el.childNodes || [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].nodeType === 3) s += nodes[i].textContent;
    return s.replace(/\s+/g, ' ').trim();
  }
  function isCalendar(el) { return el.closest && el.closest('[' + MARK + ']'); }

  /* ---------- session data (app-host seam, DOM fallback) ---------- */
  var appHost = null;
  function hasSessionApi(o) {
    return !!o && typeof o.selectedAgentSessionRows === 'function' &&
      typeof o.getSessionNavigationState === 'function';
  }
  // The session API may live on the element or on a controller hung off it.
  function findAppHost(fromEl) {
    if (appHost) return appHost;
    var node = fromEl;
    for (var depth = 0; node && depth < 14; depth++) {
      var root = node.getRootNode ? node.getRootNode() : null;
      var el = root && root.host ? root.host : node;
      if (hasSessionApi(el)) { appHost = el; return appHost; }
      try {
        var keys = Object.keys(el);
        for (var k = 0; k < keys.length; k++) {
          var v;
          try { v = el[keys[k]]; } catch (e) { continue; }
          if (hasSessionApi(v)) { appHost = v; return appHost; }
        }
      } catch (e) { /* opaque element, keep climbing */ }
      if (!root || !root.host || root.host === node) break;
      node = root.host;
    }
    return null;
  }
  var lastGlobalScan = 0;
  function globalHostScan() {
    var now = Date.now();
    if (now - lastGlobalScan < 5000) return null;
    lastGlobalScan = now;
    var els = allEls();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (hasSessionApi(el)) { appHost = el; return appHost; }
      try {
        var keys = Object.keys(el);
        for (var k = 0; k < keys.length; k++) {
          var v;
          try { v = el[keys[k]]; } catch (e) { continue; }
          if (hasSessionApi(v)) { appHost = v; return appHost; }
        }
      } catch (e) { /* keep scanning */ }
    }
    return null;
  }
  function hostSessions(startEls) {
    var host = null;
    for (var s = 0; s < startEls.length && !host; s++) {
      if (startEls[s]) host = findAppHost(startEls[s]);
    }
    if (!host) host = globalHostScan();
    if (!host) return null;
    try {
      var rows = host.selectedAgentSessionRows(host.getSessionNavigationState()) || [];
      var byKey = new Map();
      for (var i = 0; i < rows.length; i++) {
        var day = sessionDay(rows[i]);
        if (rows[i].key && day) byKey.set(rows[i].key, day);
      }
      return byKey;
    } catch (e) {
      appHost = null;
      return null;
    }
  }
  // DOM session rows with their day: sidebar rows matched to host data by
  // data-session-key; any <time datetime> row as fallback.
  function sessionRows() {
    var rows = [];
    var els = allEls();
    var sidebar = [];
    var timed = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (isCalendar(el)) continue;
      if (el.classList && el.classList.contains('sidebar-recent-session')) sidebar.push(el);
      else if (el.tagName === 'TIME' && el.getAttribute('datetime') &&
               !isNaN(Date.parse(el.getAttribute('datetime')))) timed.push(el);
    }
    var calEl = null;
    for (var c = 0; c < els.length; c++) {
      if (els[c].getAttribute && els[c].getAttribute(MARK) === '1') { calEl = els[c]; break; }
    }
    var byKey = hostSessions([sidebar[0], calEl]);
    lastByKey = byKey;
    for (var s = 0; s < sidebar.length; s++) {
      var row = sidebar[s];
      var key = row.getAttribute('data-session-key') || row.getAttribute('data-catalog-session-key');
      row.__opc1Day = (byKey && key && byKey.get(key)) || row.__opc1Day || null;
      rows.push(row);
    }
    for (var t = 0; t < timed.length; t++) {
      var tel = timed[t];
      var trow = tel.closest('a,button,li,[role="button"],[role="option"]') || tel.parentElement;
      if (trow && rows.indexOf(trow) === -1) {
        if (!trow.__opc1Day) trow.__opc1Day = dayKey(new Date(tel.getAttribute('datetime')));
        rows.push(trow);
      }
    }
    return rows;
  }

  function findMount() {
    var els = allEls();
    var i, el;
    // A: the SESSIONS list head (10.7) - calendar tops the list it filters.
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (el.classList && el.classList.contains('sidebar-recent-sessions__head') && el.parentElement) {
        return { host: el.parentElement, after: el };
      }
    }
    // B: the sidebar session list itself.
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (el.classList && el.classList.contains('sidebar-recent-session') && el.parentElement) {
        return { host: el.parentElement, after: null };
      }
    }
    // C: a "Sessions"/"SESSIONS" label. Anchor after the whole link/button
    // when the label lives inside one, never inside it.
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (isCalendar(el)) continue;
      if (el.closest && el.closest('openclaw-sessions-page')) continue;
      var t = ownText(el);
      if ((t === 'Sessions' || t === 'SESSIONS') && el.parentElement) {
        var anchor = el.closest('a,button,li') || el;
        return { host: anchor.parentElement || el.parentElement, after: anchor };
      }
    }
    return null;
  }

  /* ---------- rendering ---------- */
  function monthLabel(monthKey) {
    var parts = monthKey.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  var lastByKey = null;
  function refreshCounts() {
    counts = new Map();
    var rows = sessionRows();
    var days = [];
    if (lastByKey && lastByKey.size) {
      lastByKey.forEach(function (day) { days.push(day); });
    } else {
      for (var i = 0; i < rows.length; i++) if (rows[i].__opc1Day) days.push(rows[i].__opc1Day);
    }
    for (var j = 0; j < days.length; j++) counts.set(days[j], (counts.get(days[j]) || 0) + 1);
    return rows;
  }
  function applyFilter(rows) {
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var hide = filtering && state.selected && row.__opc1Day && row.__opc1Day !== state.selected;
      if (hide) {
        row.style.display = 'none';
        row.setAttribute(HIDDEN, '1');
      } else if (row.hasAttribute(HIDDEN)) {
        row.style.display = '';
        row.removeAttribute(HIDDEN);
      }
    }
  }
  function calendarEl() {
    var cal = document.createElement('div');
    cal.setAttribute(MARK, '1');
    cal.style.cssText = 'box-sizing:border-box;max-width:calc(100% - 16px);margin:8px;padding:8px 8px 6px;' +
      'border:1px solid rgba(127,140,160,.25);border-radius:10px;color:inherit;' +
      'font:12px/1.25 inherit;user-select:none;overflow:hidden';
    renderInto(cal);
    return cal;
  }
  function renderInto(cal) {
    var cells = monthCells(state.month);
    var names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    var today = todayKey();
    var h = '';
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
    h += '<button type="button" data-opc1-nav="-1" aria-label="Previous month" style="' + btnCss() + '">&#8249;</button>';
    h += '<div style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden">' + monthLabel(state.month) + '</div>';
    h += '<button type="button" data-opc1-nav="1" aria-label="Next month" style="' + btnCss() + '">&#8250;</button></div>';
    h += '<div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px;text-align:center">';
    for (var n = 0; n < 7; n++) h += '<div style="opacity:.55;font-size:10px;padding:2px 0">' + names[n] + '</div>';
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!c) { h += '<div></div>'; continue; }
      var count = counts.get(c.key) || 0;
      var isToday = c.key === today;
      var isSel = filtering && c.key === state.selected;
      var bg = isSel ? 'background:#C8A55C;color:#141414;font-weight:700;'
        : isToday ? 'box-shadow:inset 0 0 0 1.5px #C8A55C;font-weight:700;' : '';
      var dot = count ? '<span style="display:block;width:4px;height:4px;border-radius:50%;margin:1px auto 0;background:' +
        (isSel ? '#141414' : '#C8A55C') + '"></span>' : '<span style="display:block;height:5px"></span>';
      h += '<button type="button" data-opc1-day="' + c.key + '" title="' + c.key +
        (count ? ' - ' + count + ' session' + (count > 1 ? 's' : '') + ' loaded' : '') +
        '" style="min-width:0;padding:3px 0 2px;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;font:inherit;' +
        bg + '">' + c.day + dot + '</button>';
    }
    h += '</div>';
    if (filtering && state.selected) {
      var selCount = counts.get(state.selected) || 0;
      h += '<div style="display:flex;justify-content:space-between;align-items:center;gap:4px;flex-wrap:wrap;margin-top:6px;opacity:.9">';
      h += '<span>' + state.selected + ' &middot; ' + selCount + ' loaded</span>';
      h += '<button type="button" data-opc1-clear="1" style="' + btnCss() + '">Show all</button></div>';
      if (!selCount) {
        h += '<div style="margin-top:4px;opacity:.6;font-size:11px">No loaded sessions that day. Scroll the list to load more.</div>';
      }
    }
    cal.innerHTML = h;
  }
  function btnCss() {
    return 'border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:2px 7px;border-radius:6px;opacity:.85';
  }

  /* ---------- history paging (9.5 behavior: load all pages) ---------- */
  var paging = false;
  var pagingDone = false;
  var pagingPages = 0;
  var pagingLastSize = -1;
  function ensureLoaded() {
    if (paging || pagingDone || pagingPages > 60 || !appHost) return;
    var sd = appHost.sessionData;
    var result = sd && (sd.sessionsResult || (sd.state && sd.state.result));
    if (!result || result.hasMore !== true) { pagingDone = true; return; }
    if (typeof appHost.loadMoreSidebarSessions !== 'function') { pagingDone = true; return; }
    var size = lastByKey ? lastByKey.size : 0;
    if (size === pagingLastSize) { pagingDone = true; return; } // no progress
    pagingLastSize = size;
    paging = true;
    pagingPages++;
    Promise.resolve()
      .then(function () { return appHost.loadMoreSidebarSessions(); })
      .catch(function () { pagingDone = true; })
      .then(function () { paging = false; schedule(); });
  }

  /* ---------- mount + observe ---------- */
  var lastDiag = '';
  function diag(rows) {
    var d = {
      host: !!appHost,
      byKey: lastByKey ? lastByKey.size : 0,
      days: counts.size,
      domRows: rows ? rows.length : 0,
      pagingPages: pagingPages,
      pagingDone: pagingDone
    };
    window.__opc1Calendar = d;
    var key = JSON.stringify(d);
    if (key !== lastDiag) {
      lastDiag = key;
      try { console.info('[opc1-calendar]', key); } catch (e) {}
    }
  }
  function sync() {
    scheduled = false;
    var rows = refreshCounts();
    var existing = document.querySelector('[' + MARK + ']');
    // Shadow roots are not reachable from document.querySelector; scan once.
    if (!existing) {
      var els = allEls();
      for (var i = 0; i < els.length; i++) {
        if (els[i].getAttribute && els[i].getAttribute(MARK) === '1') { existing = els[i]; break; }
      }
    }
    if (existing) {
      // Relocate if a better mount has appeared since (list head > list > label).
      var better = findMount();
      if (better && existing.parentElement !== better.host) {
        if (better.after) better.after.insertAdjacentElement('afterend', existing);
        else better.host.insertAdjacentElement('afterbegin', existing);
        rows = refreshCounts();
      }
      renderInto(existing);
      applyFilter(rows);
      armObservers();
      ensureLoaded();
      diag(rows);
      return;
    }
    var mount = findMount();
    if (!mount) { armObservers(); return; }
    var cal = calendarEl();
    if (mount.after) mount.after.insertAdjacentElement('afterend', cal);
    else mount.host.insertAdjacentElement('afterbegin', cal);
    applyFilter(rows);
    armObservers();
    ensureLoaded();
    diag(rows);
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(sync, 250);
  }
  function armObservers() {
    observeRoot(document);
    var els = allEls();
    for (var i = 0; i < els.length; i++) if (els[i].shadowRoot) observeRoot(els[i].shadowRoot);
  }
  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    if (t.closest('[' + MARK + ']')) { ev.preventDefault(); ev.stopPropagation(); }
    var day = t.closest('[data-opc1-day]');
    if (day) {
      var key = day.getAttribute('data-opc1-day');
      if (filtering && state.selected === key) { filtering = false; state.selected = null; }
      else { filtering = true; state.selected = key; state.month = key.slice(0, 7); }
      saveState();
      sync();
      return;
    }
    var nav = t.closest('[data-opc1-nav]');
    if (nav) {
      state.month = shiftMonth(state.month, Number(nav.getAttribute('data-opc1-nav')));
      saveState();
      sync();
      return;
    }
    if (t.closest('[data-opc1-clear]')) {
      filtering = false;
      state.selected = null;
      saveState();
      sync();
    }
  }, true);
  document.addEventListener('openclaw-control-ui-rendered', schedule);
  if (document.readyState !== 'loading') schedule();
  else document.addEventListener('DOMContentLoaded', schedule);
})();
