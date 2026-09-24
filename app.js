/* Killer — pool scorekeeper.
 * One state object (S) drives everything: every action snapshots it for Undo,
 * saves it to localStorage, then re-renders the screen from scratch. */
(() => {
  'use strict';

  const START_LIVES = 3;
  const GAME_KEY = 'killer.game.v1';
  const ROSTER_KEY = 'killer.roster.v1';
  const HISTORY_CAP = 400;

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const sheet = $('#sheet');
  const flash = $('#flash');
  const toastEl = $('#toast');

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // TV mode hides the tap buttons and relies on the keyboard, so only offer it
  // on devices with a mouse or trackpad (laptops/desktops), not phones or tablets.
  const canTV = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  // The TV display (a watch link with &tv) uses the big-screen layout whenever it's landscape,
  // so a phone or tablet turned sideways works as well as a laptop.
  const landscape = () => window.matchMedia('(orientation: landscape)').matches;
  const tvOn = () => S.phase === 'playing' && (WATCH_TV ? landscape() : !!S.tv && canTV());
  const UNDO_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘Z' : 'Ctrl+Z';

  // ---------------------------------------------------------------- live sharing (setup)

  // ?watch=CODE opens a read-only live view of someone else's game. It never touches this
  // browser's own saved game.
  const WATCH = (new URLSearchParams(location.search).get('watch') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || null;
  const WATCH_TV = !!WATCH && new URLSearchParams(location.search).has('tv');
  const SHARE_KEY = 'killer.share.v1';
  // Where room sound plays while sharing: the operator's phone, or the TV display.
  const ROOM_KEY = 'killer.room.v1';
  let roomSound = (() => { try { return localStorage.getItem(ROOM_KEY) === 'tv' ? 'tv' : 'phone'; } catch (_) { return 'phone'; } })();
  let remoteSound = { on: false, target: 'phone' }; // TV display: the operator's sound settings
  let tvSoundEnabled = false; // TV display: someone clicked to allow sound
  let tvSetupOpen = false;
  let share = WATCH ? null : (() => {
    try {
      const v = JSON.parse(localStorage.getItem(SHARE_KEY));
      return v && v.code ? v : null;
    } catch (_) { return null; }
  })(); // { code } while this phone is sharing its game
  let shareStatus = 'connecting'; // connecting | live | offline
  const remote = { status: 'connecting' }; // watch mode: connecting | live | missing | unreachable

  // ---------------------------------------------------------------- state

  let history = [];
  let S = load() || freshState();

  // Transient UI state — never persisted.
  const prevLives = new Map();
  let prevCurrentId = null;
  let lastPhase = S.phase;
  let dragId = null;
  let shuffling = false;
  let sheetMode = null; // { type: 'menu' } | { type: 'player', id }
  let confirmKey = null;
  let setupNotice = ''; // duplicate-name warning shown under the name box
  let view = 'main'; // 'main' | 'recap' on a finished game
  // Brief result shown on the chalkboard. For Made/Miss the board holds on the shooter
  // (fb.id) before moving on; any new tap ends it early and still scores the right player.
  let fb = null; // { id, kind: 'safe' | 'miss' | 'out' | 'extra' | 'time', timer }

  // Shot clock: settings are remembered per device; the running clock is never saved.
  const CLOCK_KEY = 'killer.clock.v1';
  const CLOCK_MIN = 10;
  const CLOCK_MAX = 120;
  const CLOCK_STEP = 5;
  let clockPrefs = WATCH ? { on: false, secs: 30 } : (() => {
    try {
      const c = JSON.parse(localStorage.getItem(CLOCK_KEY));
      if (c && typeof c.secs === 'number') return { on: !!c.on, secs: c.secs };
    } catch (_) { /* ignore */ }
    return { on: false, secs: 30 };
  })();
  let clk = null; // { id, start, pausedAt, expired, ticked } for the player on the board
  let clockRaf = 0; // interval id while the clock is running
  let recapTab = 'awards';

  function freshState() {
    return { phase: 'setup', roster: [], players: [], current: 0, turnBonus: 0, outOrder: [], last: null, winner: null, log: [], tv: false };
  }

  function load() {
    if (WATCH) return null;
    try {
      const data = JSON.parse(localStorage.getItem(GAME_KEY));
      if (data && data.state && data.state.phase) {
        history = Array.isArray(data.history) ? data.history : [];
        return { ...freshState(), ...data.state };
      }
    } catch (_) { /* corrupted or blocked storage: start fresh */ }
    return null;
  }

  function save() {
    if (WATCH) return;
    try { localStorage.setItem(GAME_KEY, JSON.stringify({ state: S, history })); } catch (_) { /* storage unavailable */ }
    queuePublish();
  }

  function loadRoster() {
    try {
      const r = JSON.parse(localStorage.getItem(ROSTER_KEY));
      return Array.isArray(r) ? r.filter((n) => typeof n === 'string' && n) : [];
    } catch (_) { return []; }
  }

  function saveRoster(names) {
    try { localStorage.setItem(ROSTER_KEY, JSON.stringify(names)); } catch (_) { /* ignore */ }
  }

  // TV mode is a view preference, so Undo never flips it.
  // The shot log only ever grows, so snapshots store its length rather than a copy.
  function snapshot() {
    const { tv, log, ...rest } = S;
    return JSON.stringify({ ...rest, logLen: log.length });
  }

  function commit(fn) {
    history.push(snapshot());
    if (history.length > HISTORY_CAP) history.shift();
    fn();
    save();
    render();
  }

  function undo() {
    if (!history.length) return;
    clearResult(false);
    clk = null;
    sfx.stop();
    const { tv, log } = S;
    const { logLen = 0, ...prev } = JSON.parse(history.pop());
    S = { ...prev, log: log.slice(0, logLen), tv };
    save();
    render();
    toast('↶ Undone');
    buzz(15);
  }

  // ---------------------------------------------------------------- game helpers

  const isAlive = (p) => !!p && p.lives > 0;
  const aliveCount = () => S.players.filter(isAlive).length;
  const current = () => S.players[S.current];
  const byId = (id) => S.players.find((p) => p.id === id);

  function newPlayer(name) {
    return { id: uid(), name, lives: START_LIVES, shots: 0, pots: 0, misses: 0, extras: 0 };
  }

  function nextAliveIndex(from) {
    const n = S.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (isAlive(S.players[i])) return i;
    }
    return -1;
  }

  function upcoming(count, from = S.current) {
    const list = [];
    let i = from;
    for (let k = 0; k < count; k++) {
      i = nextAliveIndex(i);
      if (i < 0 || i === from) break;
      list.push(S.players[i]);
    }
    return list;
  }

  function advance() {
    S.turnBonus = 0;
    const i = nextAliveIndex(S.current);
    if (i >= 0) S.current = i;
  }

  function markOut(p) {
    if (!S.outOrder.includes(p.id)) S.outOrder.push(p.id);
  }

  function checkFinish() {
    if (S.players.length && aliveCount() <= 1) {
      const w = S.players.find(isAlive);
      S.phase = 'finished';
      S.winner = w ? w.id : null;
      S.turnBonus = 0;
      return true;
    }
    return false;
  }

  function randInt(n) {
    if (window.crypto && crypto.getRandomValues) {
      const b = new Uint32Array(1);
      crypto.getRandomValues(b);
      return b[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function parseNames(text) {
    return String(text)
      .split(/[\n,;\t]+/)
      .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 24))
      .filter(Boolean);
  }

  // "Dave", "dave" and "DAVE" match, and so do "J.J." and "JJ"; "Dave R" is a different player.
  const nameKey = (n) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // Split new names into ones to add and ones already taken (including repeats within the batch).
  function splitDupes(names, existing) {
    const seen = new Set(existing.map(nameKey));
    const fresh = [];
    const dupes = [];
    for (const n of names) {
      const key = nameKey(n);
      if (seen.has(key)) dupes.push(n);
      else { seen.add(key); fresh.push(n); }
    }
    return { fresh, dupes };
  }

  const livesLabel = (n) => (n <= 0 ? 'out' : n === 1 ? 'last life' : `${n} lives left`);

  // ---------------------------------------------------------------- shot actions

  // ---------------------------------------------------------------- shot clock

  const clockOn = () => clockPrefs.on && S.phase === 'playing';

  function setClockPrefs(changes) {
    clockPrefs = { ...clockPrefs, ...changes };
    clockPrefs.secs = Math.min(CLOCK_MAX, Math.max(CLOCK_MIN, clockPrefs.secs));
    try { localStorage.setItem(CLOCK_KEY, JSON.stringify(clockPrefs)); } catch (_) { /* ignore */ }
    queuePublish();
  }

  function clockLeft() {
    if (!clk) return clockPrefs.secs * 1000;
    const now = clk.pausedAt || Date.now();
    return Math.max(0, clockPrefs.secs * 1000 - (now - clk.start));
  }

  function startClock(id) {
    clk = { id, start: Date.now(), pausedAt: 0, expired: false };
    queuePublish();
  }

  function pauseClock() {
    if (clk && !clk.pausedAt) { clk.pausedAt = Date.now(); queuePublish(); }
  }

  function resumeClock() {
    if (!clk || !clk.pausedAt) return;
    clk.start += Date.now() - clk.pausedAt;
    clk.pausedAt = 0;
    queuePublish();
  }

  function restartClock() {
    if (clk) startClock(clk.id);
  }

  // Updates just the clock's number and bar, without redrawing the page.
  // What the clock should look like right now. Used both when the chalkboard is drawn and on
  // every tick, so a redraw never flashes a stale (e.g. full-width) bar.
  function clockView() {
    const left = clockLeft();
    const paused = !!(clk && clk.pausedAt);
    return {
      left,
      text: paused ? 'Paused' : left ? Math.ceil(left / 1000) : 'Time',
      paused,
      warn: !paused && left > 0 && left <= 5000,
      time: !paused && left === 0,
      barWarn: left <= 5000,
      scale: left / (clockPrefs.secs * 1000),
    };
  }

  function paintClock() {
    if (!clockOn() || !clk) return;
    const num = document.getElementById('clockNum');
    const bar = document.getElementById('clockBar');
    const v = clockView();
    const left = v.left;
    if (num) {
      const chip = num.closest('.clock');
      num.textContent = v.text;
      chip.classList.toggle('paused', v.paused);
      chip.classList.toggle('warn', v.warn);
      chip.classList.toggle('time', v.time);
    }
    if (bar) {
      bar.style.transform = `scaleX(${v.scale})`;
      bar.parentElement.classList.toggle('warn', v.barWarn);
    }
    // Countdown ticks for the last 5 seconds, once per second (not while paused).
    const secs = Math.ceil(left / 1000);
    if (!clk.pausedAt && left > 0 && secs <= 5 && secs !== clk.ticked) {
      clk.ticked = secs;
      sfx.tick(secs === 1);
    }
    if (left === 0 && !clk.expired && !clk.pausedAt) {
      clk.expired = true;
      timeUp();
    }
  }

  // A light 10-per-second timer keeps the clock moving while it's on. (Unlike an
  // animation-frame loop, it keeps running when the page isn't being painted.)
  function ensureClockLoop() {
    if (clockOn() && !clockRaf) clockRaf = setInterval(paintClock, 100);
    if (!clockOn() && clockRaf) { clearInterval(clockRaf); clockRaf = 0; }
  }

  // Time's up: buzzer and a TIME! stamp. Nothing is scored; the group decides.
  function timeUp() {
    sfx.buzzer();
    if (!WATCH) buzz([200, 100, 200]);
    showResult(null, 'time', 1800);
    render();
  }

  function rerack() {
    const p = current();
    if (!p || S.phase !== 'playing') return;
    commit(() => {
      S.log.push({ p: p.id, a: 'rack' });
      S.last = { type: 'rack', id: p.id, name: p.name };
    });
    clk = null; // the break isn't timed; the next shooter gets a fresh clock
  }

  function showResult(id, kind, ms, n = 0) {
    clearResult(false);
    fb = { id, kind, n };
    fb.timer = setTimeout(() => {
      fb = null;
      flash.classList.remove('show');
      if (S.phase === 'playing') render();
    }, ms);
  }

  function clearResult(rerender = true) {
    if (!fb) return;
    clearTimeout(fb.timer);
    fb = null;
    flash.classList.remove('show');
    if (rerender && S.phase === 'playing') render();
  }

  // Bring the chalkboard and the front of the line back into view after scoring.
  // An instant jump: a smooth scroll can be cut short when the board redraws mid-scroll.
  function backToTop() {
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }

  function actMiss() {
    const p = current();
    if (S.phase !== 'playing' || !p) return;
    const goingOut = p.lives <= 1;
    showResult(p.id, goingOut ? 'out' : 'miss', goingOut ? 1900 : 950);
    let wentOut = false;
    commit(() => {
      p.shots++;
      p.misses++;
      p.lives--;
      S.last = { type: 'miss', id: p.id, name: p.name, lives: p.lives, bonus: S.turnBonus };
      S.log.push({ p: p.id, a: 'miss', l: p.lives });
      if (p.lives <= 0) { wentOut = true; markOut(p); }
      if (!checkFinish()) advance();
    });
    if (S.phase !== 'playing') clearResult(false);
    if (wentOut) {
      buzz([60, 40, 140]);
      if (S.phase === 'playing') { flashOut(p.name); sfx.out(); }
    } else {
      buzz(40);
    }
    backToTop();
  }

  function actMade() {
    const p = current();
    if (S.phase !== 'playing' || !p) return;
    showResult(p.id, 'safe', 750);
    commit(() => {
      p.shots++;
      p.pots++;
      S.last = { type: 'made', id: p.id, name: p.name, lives: p.lives, bonus: S.turnBonus };
      S.log.push({ p: p.id, a: 'made', l: p.lives });
      advance();
    });
    buzz(12);
    backToTop();
  }

  // +1 scores a made shot with an extra life and moves on. A quick second or third tap,
  // while the board is still on the shooter, adds another life for a 3- or 4-ball shot.
  const MAX_EXTRA_TAPS = 3;
  const EXTRA_HOLD_MS = 1500;

  function actExtra() {
    if (S.phase !== 'playing') return;
    if (fb && fb.kind === 'extra' && fb.id) {
      const p = byId(fb.id);
      if (!p || fb.n >= MAX_EXTRA_TAPS) return;
      const n = fb.n + 1;
      showResult(p.id, 'extra', EXTRA_HOLD_MS, n);
      commit(() => {
        p.lives++;
        p.extras++;
        S.last = { type: 'made', id: p.id, name: p.name, lives: p.lives, bonus: n };
        S.log.push({ p: p.id, a: 'extra', l: p.lives, late: true }); // belongs to the shot just scored
      });
      buzz(20);
      sfx.extra();
      return;
    }
    const p = current();
    if (!p) return;
    showResult(p.id, 'extra', EXTRA_HOLD_MS, 1);
    commit(() => {
      p.lives++;
      p.extras++;
      p.shots++;
      p.pots++;
      S.last = { type: 'made', id: p.id, name: p.name, lives: p.lives, bonus: 1 };
      S.log.push({ p: p.id, a: 'extra', l: p.lives });
      S.log.push({ p: p.id, a: 'made', l: p.lives });
      advance();
    });
    buzz(20);
    sfx.extra();
    backToTop();
  }

  const ACTIONS = { miss: actMiss, made: actMade, extra: actExtra };

  // ---------------------------------------------------------------- game management

  function startGame() {
    if (S.roster.length < 2) return;
    saveRoster(S.roster.map((r) => r.name));
    beginWith(S.roster.map((r) => r.name));
  }

  function rematch() {
    sfx.stop();
    beginWith(shuffle(S.players.map((p) => p.name)));
    toast('🔁 New order — good luck');
  }

  function beginWith(names) {
    history = [];
    prevLives.clear();
    prevCurrentId = null;
    S = { ...freshState(), tv: S.tv, roster: S.roster, phase: 'playing', players: names.map(newPlayer) };
    S.log.push({ p: S.players[0].id, a: 'rack' }); // the first shooter breaks
    clk = null;
    save();
    render();
  }

  function newGame() {
    sfx.stop();
    history = [];
    prevLives.clear();
    S = { ...freshState(), roster: S.players.map((p) => ({ id: uid(), name: p.name })) };
    exitFullscreen();
    save();
    render();
  }

  function addLate(text) {
    const names = parseNames(text);
    if (!names.length || S.phase !== 'playing') return;
    const { fresh, dupes } = splitDupes(names, S.players.map((p) => p.name));
    if (fresh.length) {
      commit(() => {
        fresh.forEach((n) => S.players.push(newPlayer(n)));
        S.last = { type: 'add', name: fresh.join(', ') };
      });
    }
    if (dupes.length) {
      toast(`${dupes.join(', ')} ${dupes.length === 1 ? 'is' : 'are'} already in the game. Add a last initial.`, 3200);
      buzz([30, 40, 30]);
    } else {
      toast(`Added ${fresh.join(', ')}`);
    }
  }

  function setLives(p, value) {
    const v = Math.max(0, value);
    if (!p || v === p.lives) return;
    commit(() => {
      p.lives = v;
      if (v <= 0) markOut(p);
      else S.outOrder = S.outOrder.filter((id) => id !== p.id);
      S.last = { type: 'edit', id: p.id, name: p.name, lives: v };
      if (!checkFinish() && !isAlive(current())) advance();
    });
  }

  function makeShooter(p) {
    if (!isAlive(p)) return;
    commit(() => {
      S.current = S.players.indexOf(p);
      S.turnBonus = 0;
      S.last = { type: 'shoot', id: p.id, name: p.name };
    });
  }

  function removePlayer(p) {
    if (!p || S.players.length <= 2) return;
    commit(() => {
      const i = S.players.indexOf(p);
      S.players.splice(i, 1);
      S.outOrder = S.outOrder.filter((id) => id !== p.id);
      if (i < S.current) {
        S.current--;
      } else if (i === S.current) {
        S.turnBonus = 0;
        if (S.current >= S.players.length) S.current = 0;
        if (!isAlive(current())) {
          const j = nextAliveIndex(S.current);
          if (j >= 0) S.current = j;
        }
      }
      S.last = { type: 'remove', name: p.name };
      checkFinish();
    });
  }

  function toggleTV() {
    S.tv = !S.tv;
    save();
    render();
    if (S.tv) {
      const el = document.documentElement;
      if (el.requestFullscreen && window.matchMedia('(pointer: fine)').matches) el.requestFullscreen().catch(() => {});
      toast('TV mode · T or Esc to exit');
    } else {
      exitFullscreen();
    }
  }

  function exitFullscreen() {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }

  // ---------------------------------------------------------------- setup actions

  // Returns the names that were skipped as duplicates.
  function addNames(text) {
    const names = parseNames(text);
    if (!names.length) return [];
    const { fresh, dupes } = splitDupes(names, S.roster.map((r) => r.name));
    S.roster.push(...fresh.map((name) => ({ id: uid(), name })));
    setupNotice = dupes.length === 1
      ? `<b>${esc(dupes[0])}</b> is already on the list. Add a last initial, like “${esc(dupes[0])} R”.`
      : dupes.length
        ? `Skipped <b>${esc(dupes.join(', '))}</b>, already on the list. Add last initials to tell them apart.`
        : '';
    if (dupes.length) buzz([30, 40, 30]);
    save();
    render();
    return dupes;
  }

  function shuffleRoster() {
    if (S.roster.length < 2 || shuffling) return;
    shuffling = true;
    let n = 0;
    const steps = reducedMotion() ? 1 : 9;
    const tick = () => {
      S.roster = shuffle(S.roster);
      if (++n < steps) {
        render();
        setTimeout(tick, 40 + n * 14);
      } else {
        shuffling = false;
        save();
        render();
        buzz(20);
        toast('🎲 Shuffled');
      }
    };
    tick();
  }

  // Two-tap confirmation for destructive buttons, instead of a native confirm().
  function confirmTap(btn, key) {
    if (confirmKey === key) { confirmKey = null; return true; }
    confirmKey = key;
    const original = btn.innerHTML;
    btn.innerHTML = 'Tap again to confirm';
    btn.classList.add('confirming');
    clearTimeout(confirmTap.timer);
    confirmTap.timer = setTimeout(() => {
      confirmKey = null;
      if (btn.isConnected) { btn.innerHTML = original; btn.classList.remove('confirming'); }
    }, 2500);
    return false;
  }

  // ---------------------------------------------------------------- rendering pieces

  const LOGO = '<img class="logo" src="logo.svg" alt="">';

  // Whiteboard strokes: 1st strike "/", 2nd makes an "X", 3rd circles it (OUT).
  function stroke(i, draw) {
    const cls = [i === 2 ? 'ring' : '', draw ? 'draw' : ''].filter(Boolean).join(' ');
    const c = cls ? ` class="${cls}"` : '';
    if (i === 0) return `<path d="M11 29 L29 11" pathLength="1"${c}/>`;
    if (i === 1) return `<path d="M11 11 L29 29" pathLength="1"${c}/>`;
    return `<circle cx="20" cy="20" r="16" pathLength="1" transform="rotate(-110 20 20)"${c}/>`;
  }

  function marks(p, size = '') {
    const lost = Math.max(0, Math.min(START_LIVES, START_LIVES - p.lives));
    const bonus = Math.max(0, p.lives - START_LIVES);
    const prev = prevLives.get(p.id);
    const fresh = prev !== undefined && p.lives < prev && lost > 0 ? lost - 1 : -1;
    let strokes = '';
    for (let i = 0; i < lost; i++) strokes += stroke(i, i === fresh);
    const title = p.lives <= 0 ? 'Out' : `${p.lives} ${p.lives === 1 ? 'life' : 'lives'}`;
    return `<span class="mk ${size}${bonus ? ' bonus' : ''}" title="${title}" aria-label="${title}">` +
      `<svg class="chalk" viewBox="0 0 40 40" aria-hidden="true"><g filter="url(#chalk)">${strokes}</g></svg>` +
      (bonus ? `<span class="chip">+${bonus}</span>` : '') +
      `</span>`;
  }

  // Scale names so short ones fill the card and long ones still fit on one line.
  const fit = (name) => Math.max(0.4, Math.min(1.2, 10 / Math.max(1, name.length))).toFixed(3);
  const cardFit = (name) => Math.max(0.68, Math.min(1, 8 / Math.max(1, name.length))).toFixed(3);

  function lastText() {
    // Right after +1, offer the quick extra tap for a bigger shot.
    if (fb && fb.kind === 'extra' && fb.id) {
      const who = byId(fb.id);
      const more = fb.n < MAX_EXTRA_TAPS ? ` · ${fb.n + 2} balls? Tap again` : '';
      if (who) return `<b>${esc(who.name)}</b> <span class="t-gold">+${fb.n}</span>${more}`;
    }
    const p = current();
    if (S.turnBonus > 0 && p) {
      return `<b>${esc(p.name)}</b> <span class="t-gold">+${S.turnBonus}</span> · now tap <em>Made</em>`;
    }
    const L = S.last;
    if (!L) return p ? `<b>${esc(p.name)}</b> to break — good luck` : '';
    const n = `<b>${esc(L.name)}</b>`;
    switch (L.type) {
      case 'miss': return L.lives <= 0 ? `${n} is <span class="t-red">OUT</span>` : `${n} missed · ${livesLabel(L.lives)}`;
      case 'made': return L.bonus ? `${n} potted &amp; earned <span class="t-gold">+${L.bonus}</span>` : `${n} is safe`;
      case 'edit': return `${n} set to ${L.lives <= 0 ? '<span class="t-red">OUT</span>' : livesLabel(L.lives).replace(' left', '')}`;
      case 'shoot': return `${n} moved up to shoot`;
      case 'add': return `${n} joined the game`;
      case 'remove': return `${n} left the game`;
      case 'rack': return `Re-rack · ${n} breaks`;
      default: return '';
    }
  }

  // ---------------------------------------------------------------- screens

  function render() {
    document.body.classList.toggle('watch', !!WATCH);
    if (WATCH && (remote.status !== 'live' || S.phase === 'setup')) {
      document.body.classList.remove('tv', 'win');
      renderWatchStatus();
      return;
    }
    document.body.classList.toggle('tv', tvOn());
    document.body.classList.toggle('tv-display', WATCH_TV);
    document.body.classList.toggle('win', S.phase === 'finished');
    const justWon = S.phase === 'finished' && lastPhase === 'playing';
    if (S.phase !== 'finished') view = 'main';
    if (justWon) sfx.win();
    if (S.phase === 'setup') renderSetup();
    else if (S.phase === 'playing') renderGame();
    else if (view === 'recap') renderRecap();
    else renderWinner();

    if (tvNeedsSoundClick()) app.insertAdjacentHTML('beforeend', '<button class="sound-banner" data-do="enableSound">🔊 Click to turn on sound for the room</button>');
    if (S.phase !== 'playing') flash.classList.remove('show');
    if (justWon) confetti();
    lastPhase = S.phase;

    S.players.forEach((p) => prevLives.set(p.id, p.lives));
    if (sheet.open) renderSheet();
    updateWakeLock();
    ensureClockLoop();
  }

  function renderSetup() {
    const hadFocus = document.activeElement && document.activeElement.id === 'nameInput';
    const r = S.roster;
    const saved = loadRoster();

    const list = r.length
      ? `<ol class="roster ${shuffling ? 'shuffling' : ''}" id="roster">${r.map((p, i) => `
          <li data-id="${p.id}" class="${dragId === p.id ? 'dragging' : ''}">
            <span class="grip" data-grip title="Drag to reorder" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="rnum">${i + 1}</span>
            <span class="rname">${esc(p.name)}</span>
            <button class="rdel" data-del="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>
          </li>`).join('')}</ol>`
      : `<div class="empty">
          <div class="empty-rack" aria-hidden="true">${[1, 2, 3].map((n) => `<span>${'<i></i>'.repeat(n)}</span>`).join('')}</div>
          <p>No players yet. Add names above.</p>
          ${saved.length ? `<button class="btn btn-brass" data-do="lastRoster">Use last roster · ${saved.length} players</button>` : ''}
        </div>`;

    app.innerHTML = `
      <section class="setup">
        <header class="hero">
          <h1 class="wordmark"><img src="wordmark.svg" alt="Killer"></h1>
          <p class="tagline">${START_LIVES} lives each · last one standing wins</p>
          <button class="watch-entry" data-do="watchEntry">👀 Watch a game</button>
        </header>

        <form class="add" id="addForm" autocomplete="off">
          <input id="nameInput" type="text" data-multi placeholder="Name or initials"
                 enterkeyhint="enter" autocapitalize="words" autocorrect="off" spellcheck="false" aria-label="Player name">
          <button class="btn btn-brass" type="submit">Add</button>
        </form>
        <p class="hint${setupNotice ? ' notice' : ''}" aria-live="polite">${setupNotice || 'Tip: paste a whole list — one per line, or separated by commas.'}</p>

        <div class="roster-head">
          <h2>Players <span class="count">${r.length}</span></h2>
          <div class="roster-tools">
            <button class="btn btn-ghost" data-do="shuffle" ${r.length < 2 ? 'disabled' : ''}>🎲 Shuffle</button>
            <button class="btn btn-ghost" data-do="clear" ${r.length ? '' : 'disabled'}>Clear</button>
          </div>
        </div>

        ${list}

        <div class="setup-foot">
          <div class="clock-setting">
            <button class="switch${clockPrefs.on ? ' on' : ''}" data-do="clockToggle" role="switch" aria-checked="${clockPrefs.on}" aria-label="Shot clock"><i></i></button>
            <span class="cs-label">⏱ Shot clock</span>
            <div class="cs-stepper${clockPrefs.on ? '' : ' off'}">
              <button data-do="clockLess" aria-label="Less time" ${clockPrefs.secs <= CLOCK_MIN ? 'disabled' : ''}>−</button>
              <b>${clockPrefs.secs} sec</b>
              <button data-do="clockMore" aria-label="More time" ${clockPrefs.secs >= CLOCK_MAX ? 'disabled' : ''}>+</button>
            </div>
          </div>
          <button class="btn btn-start" data-do="start" ${r.length < 2 ? 'disabled' : ''}>
            ${r.length < 2 ? 'Add at least 2 players' : `Rack ’em · ${r.length} players`}
          </button>
        </div>
      </section>`;

    if (hadFocus) $('#nameInput').focus();
  }

  function renderGame() {
    // While a result is showing, the board stays on the player who just shot.
    const heldIdx = fb && fb.id ? S.players.findIndex((x) => x.id === fb.id) : -1;
    const curIdx = heldIdx >= 0 ? heldIdx : S.current;
    const p = S.players[curIdx];
    const alive = aliveCount();
    const outCount = S.players.length - alive;
    const next = upcoming(2, curIdx);
    const nextId = next[0] && next[0].id;
    const entering = p.id !== prevCurrentId;
    prevCurrentId = p.id;

    // The list is the line: the shooter first, then everyone in turn order; players who are out go last.
    const outRank = (x) => S.outOrder.indexOf(x.id);
    const line = [];
    const gone = [];
    for (let k = 0; k < S.players.length; k++) {
      const x = S.players[(curIdx + k) % S.players.length];
      (k === 0 || isAlive(x) ? line : gone).push(x);
    }
    const board = line.concat(gone.sort((a, b) => outRank(a) - outRank(b)));

    const stampText = fb && {
      safe: '✓ Safe',
      miss: 'Miss',
      extra: `+${fb.n} ${fb.n > 1 ? 'lives' : 'life'}`,
      time: 'Time!',
    }[fb.kind];
    const stamp = stampText ? `<div class="now-stamp ${fb.kind}" aria-hidden="true">${stampText}</div>` : '';
    const livesText = p.lives <= 0 ? 'Out' : p.lives === 1 ? 'Last life' : `${p.lives} lives left`;

    // The clock starts once the board has moved on to the new shooter. Breaks aren't timed:
    // the opening break, and the break after a re-rack, until that shot is scored.
    const lastEvent = [...S.log].reverse().find((e) => e.a === 'rack' || e.a === 'miss' || e.a === 'made');
    const breakShot = !lastEvent || lastEvent.a === 'rack';
    const showClock = clockOn() && heldIdx < 0 && !breakShot && (!WATCH || (clk && clk.id === p.id));
    if (!WATCH && showClock && (!clk || clk.id !== p.id)) startClock(p.id);
    const paused = showClock && clk && clk.pausedAt;
    const cv = clockView();
    const clockHtml = showClock ? `
      <button class="clock${cv.paused ? ' paused' : ''}${cv.warn ? ' warn' : ''}${cv.time ? ' time' : ''}" data-do="clock" aria-label="${paused ? 'Resume shot clock' : 'Pause shot clock'}"><span id="clockNum">${cv.text}</span></button>
      ${paused && !WATCH ? `<div class="clock-actions">
        <button data-do="clockResume" class="ca-go">▶ Resume</button>
        <button data-do="clockRerack">🎱 Re-rack</button>
        <button data-do="clockRestart">↺ Back to ${clockPrefs.secs}</button>
      </div>` : ''}
      <div class="clock-bar${cv.barWarn ? ' warn' : ''}" aria-hidden="true"><i id="clockBar" style="transform:scaleX(${cv.scale})"></i></div>`
      : clockOn() && heldIdx < 0 ? '<div class="clock idle" aria-label="No shot clock on the break">Break</div>' : '';

    const cards = board.map((x) => {
      const isCur = x.id === p.id;
      const isNext = x.id === nextId;
      const out = !isAlive(x);
      return `<button class="pc${isCur ? ' cur' : ''}${isNext ? ' nxt' : ''}${out ? ' out' : ''}" data-player="${x.id}" aria-label="${esc(x.name)}, ${out ? 'out' : livesLabel(x.lives)}">
          <span class="pc-name" style="--nfit:${cardFit(x.name)}">${esc(x.name)}</span>
          ${marks(x)}
          ${isCur ? '<span class="tag">Up</span>' : isNext ? '<span class="tag tag-next">Next</span>' : ''}
        </button>`;
    }).join('');

    // Small raised labels, big names, and each player's marks inline.
    const nextLine = next.map((x, i) => `
      <span class="nx">
        <span class="nx-label">${i ? 'Then' : 'Next'}</span>
        <span class="nx-name">${esc(x.name)}</span>${marks(x, 'xs')}
      </span>`).join('<span class="nx-sep" aria-hidden="true"></span>');

    app.innerHTML = `
      <section class="game">
        <header class="topbar">
          <div class="brand-sm">${LOGO}<span>Killer</span></div>
          <div class="pill"><b>${alive}</b> left<i aria-hidden="true">·</i><b>${outCount}</b> out</div>
          ${tvOn()
            ? WATCH_TV
              ? `<div class="tv-join">${qrSvg(watchLink(WATCH, false))}<span>Scan to watch<b>${esc(WATCH)}</b></span></div>`
              : '<button class="btn btn-ghost btn-sm" data-do="tv">Exit TV</button>'
            : WATCH
              ? `<span class="live-badge" title="Watching game ${WATCH}">● Live</span>${canTV() && !WATCH_TV ? '<button class="btn btn-ghost btn-sm" data-do="tv">TV</button>' : ''}<button class="icon-btn" data-do="leaveWatch" aria-label="Leave and go back to my game">✕</button>`
              : `<button class="icon-btn${share ? ' is-live' : ''}" data-do="menu" aria-label="Menu"><span class="burger"><i></i><i></i><i></i></span></button>`}
        </header>

        <div class="stage">
          <div class="left">
            <section class="now${entering ? ' enter' : ''}${stamp && fb.id ? ' holding' : ''}${paused && !WATCH ? ' clock-paused' : ''}" aria-live="polite">
              <div class="now-felt">
                ${stamp}${clockHtml}
                <div class="now-label">${breakShot && heldIdx < 0 ? 'Now breaking' : 'Now shooting'}</div>
                <div class="now-name" style="--fit:${fit(p.name)}">${esc(p.name)}</div>
                <div class="now-status">${marks(p, 'lg')}<span class="now-lives${p.lives <= 1 ? ' last' : ''}">${livesText}</span></div>
                <div class="now-next">${nextLine}</div>
              </div>
            </section>

            ${WATCH ? `<section class="controls watching"><div class="lastline"><span class="last-text">${lastText()}</span></div></section>` : `            <section class="controls">
              <div class="lastline">
                <span class="last-text">${lastText()}</span>
                <button class="undo" data-do="undo" ${history.length ? '' : 'disabled'}>↶ Undo</button>
              </div>
              <div class="actions">
                <button class="act act-miss" data-act="miss">
                  <span class="act-glyph">✕</span><span class="act-label">Miss</span><span class="act-sub">or scratch</span><kbd>X</kbd>
                </button>
                <button class="act act-made" data-act="made">
                  <span class="act-glyph">✓</span><span class="act-label">Made</span><span class="act-sub">safe</span><kbd>Space</kbd>
                </button>
                <button class="act act-extra" data-act="extra">
                  <span class="act-glyph">+1</span><span class="act-label">Extra life</span><span class="act-sub">2 balls in</span><kbd>E</kbd>
                  ${S.turnBonus ? `<span class="badge">+${S.turnBonus}</span>` : ''}
                </button>
              </div>
            </section>`}
          </div>

          <section class="board" aria-label="Scoreboard">
            <div class="board-grid">${cards}</div>
          </section>
        </div>

        ${tvOn() && !WATCH_TV ? `<footer class="tv-keys">${WATCH ? '' : `<span><kbd>X</kbd> Miss</span><span><kbd>Space</kbd> Made</span><span><kbd>E</kbd> Extra life</span><span><kbd>${UNDO_KEY}</kbd> Undo</span>`}${clockOn() ? `<span><kbd>P</kbd> Pause clock</span><span><kbd>R</kbd> Clock back to ${clockPrefs.secs}</span><span><kbd>B</kbd> Re-rack</span>` : ''}<span><kbd>T</kbd> Exit TV</span></footer>` : ''}
      </section>`;
  }

  function renderWinner() {
    const w = byId(S.winner) || S.players.find(isAlive);
    const podium = S.outOrder.slice().reverse().slice(0, 2).map(byId).filter(Boolean);
    app.innerHTML = `
      <section class="winner">
        ${fanfare ? '<button class="mute-fanfare" data-do="muteFanfare" aria-label="Mute fanfare">🔇 Mute fanfare</button>' : ''}
        <div class="win-layout">
          <img class="win-poster" src="poster.svg" alt="Killer">
          <div class="win-info">
            <div class="win-label">Last one standing</div>
            <h1 class="win-name" style="--fit:${fit(w ? w.name : '')}">${esc(w ? w.name : 'Nobody')}</h1>
            ${w ? `
              <ul class="win-stats">
                <li><b>${w.shots}</b><span>shots</span></li>
                <li><b>${w.pots}</b><span>potted</span></li>
                <li><b>${w.extras}</b><span>extra lives</span></li>
                <li><b>${w.lives}</b><span>lives left</span></li>
              </ul>` : ''}
            ${podium.length ? `<ol class="podium">${podium.map((x, i) => `<li><span class="place">${i === 0 ? '2nd' : '3rd'}</span><span class="pname">${esc(x.name)}</span></li>`).join('')}</ol>` : ''}
            ${WATCH ? '<div class="win-actions watching"><button class="btn btn-ghost btn-recap" data-do="recap">🏅 Recap</button></div>' : `<div class="win-actions">
              <button class="btn btn-start" data-do="rematch">Rematch</button>
              <button class="btn btn-ghost" data-do="undo" ${history.length ? '' : 'disabled'}>↶ Undo</button>
              <button class="btn btn-ghost btn-recap" data-do="recap">🏅 Recap</button>
              <button class="btn btn-ghost" data-do="newgame">New game</button>
            </div>
            <button class="watch-entry" data-do="watchEntry">👀 Watch a game</button>`}
          </div>
        </div>
      </section>`;
  }

  // Watchers: connecting, between games, or a code that isn't live.
  function renderWatchStatus() {
    const msg = {
      connecting: `Connecting to game <b>${esc(WATCH)}</b>…`,
      live: 'The next game is being set up. Hang tight.',
      missing: `Game <b>${esc(WATCH)}</b> isn't live right now. Check the code with your scorekeeper.`,
      unreachable: 'Can’t reach the live game. Check your internet connection.',
    }[remote.status];
    app.innerHTML = `
      <section class="watch-status">
        <h1 class="wordmark"><img src="wordmark.svg" alt="Killer"></h1>
        <p class="ws-msg">${msg}</p>
        ${remote.status === 'connecting' ? '<div class="ws-spinner" aria-hidden="true"></div>' : ''}
        <p class="ws-note">Live view · you can’t change anything</p>
        <button class="btn btn-ghost" data-do="leaveWatch">← Back to my game</button>
      </section>`;
  }

  // ---------------------------------------------------------------- recap

  // Walk the shot log once and collect per-player numbers for awards and standings.
  function gameStats() {
    const stats = new Map(S.players.map((p) => [p.id, {
      p, turns: 0, streak: 0, best: 0, opening: 0, openingLive: true,
      edgeTurns: 0, comeback: false, hatTrick: false, outRound: null, leaves: 0, results: [], breaks: 0,
    }]));
    let prevTurn = null; // the last shot that ended a turn
    let extras = 0; // extra lives earned so far this turn
    let lastExtras = 0; // extra lives in the turn that just ended (for quick extra taps)
    for (const e of S.log || []) {
      const st = stats.get(e.p);
      if (e.a === 'rack') {
        if (st) st.breaks++;
        continue;
      }
      if (e.a === 'extra') {
        if (st && e.l === 2) st.comeback = true; // went from last life back to two
        if (e.late) {
          lastExtras++;
          if (st && lastExtras >= 2) st.hatTrick = true;
        } else {
          extras++;
        }
        continue;
      }
      if (st) {
        const startLives = (e.a === 'miss' ? e.l + 1 : e.l) - extras;
        st.turns++;
        st.results.push(e.a);
        if (startLives === 1) st.edgeTurns++;
        if (extras >= 2) st.hatTrick = true;
        if (e.a === 'made') {
          st.streak++;
          st.best = Math.max(st.best, st.streak);
          if (st.openingLive) st.opening++;
        } else {
          st.streak = 0;
          st.openingLive = false;
          if (e.l <= 0) {
            st.outRound = st.turns;
            // Toughest Leave: the previous shooter potted and left this.
            const leaver = prevTurn && prevTurn.a === 'made' && prevTurn.p !== e.p && stats.get(prevTurn.p);
            if (leaver) leaver.leaves++;
          }
        }
      }
      prevTurn = e;
      lastExtras = extras;
      extras = 0;
    }
    return stats;
  }

  // Minimums for the awards that need to be earned. Tune these after real games.
  const AWARD_MIN = {
    onFire: 4, // made in a row
    ironMan: 3, // made from the start of the game
    sharpshooterShots: 4, // shots taken to qualify for best pot %
    nineLives: 2, // extra lives earned
    edge: 4, // turns survived on the last life
    toughestLeave: 3, // players out right after your turn
    breaks: 2, // racks broken (the opening break plus re-racks)
    meltdownPots: 3, // potted this many before collapsing
  };

  // How a knocked-out player collapsed: missed their last 3 turns, or 3 of their last 4.
  function meltdown(st) {
    if (st.p.lives > 0) return null;
    const r = st.results;
    const last3 = r.slice(-3);
    const last4 = r.slice(-4);
    let window = 0;
    if (last3.length === 3 && last3.every((a) => a === 'miss')) window = 3;
    else if (last4.length === 4 && last4.filter((a) => a === 'miss').length === 3) window = 4;
    if (!window) return null;
    const before = r.slice(0, -window).filter((a) => a === 'made').length;
    return before >= AWARD_MIN.meltdownPots ? { before, window } : null;
  }

  function computeAwards(stats) {
    const all = [...stats.values()];
    const list = [];
    // Everyone tied for the top value, if it clears the minimum.
    const top = (value, min) => {
      const best = Math.max(...all.map(value));
      return best >= min ? all.filter((st) => value(st) === best) : [];
    };
    const add = (icon, title, winners, detail) => {
      if (winners.length) list.push({ icon, title, names: winners.map((st) => st.p.name), detail: detail(winners[0], winners.length > 1) });
    };
    const out = (id) => stats.get(id);
    const round = (st) => (st.outRound ? `Out in round ${st.outRound}` : 'First one out');

    const first = out(S.outOrder[0]);
    if (first) add('🩸', 'First Blood', [first], round);
    const runnerUp = S.outOrder.length > 1 && out(S.outOrder[S.outOrder.length - 1]);
    if (runnerUp) add('🥈', 'So Close', [runnerUp], () => 'Last one knocked out');
    const champ = S.winner && out(S.winner);
    if (champ && champ.p.lives === 1) add('⚰️', 'Dead Man Walking', [champ], () => 'Won it on their last life');

    const fire = top((st) => st.best, AWARD_MIN.onFire);
    add('🔥', 'On Fire', fire, (st) => `${st.best} made in a row`);
    const iron = top((st) => st.opening, AWARD_MIN.ironMan);
    const sameAsFire = iron.length && iron.every((st) => fire.includes(st)) && iron[0].opening === fire[0].best;
    if (!sameAsFire) add('🛡️', 'Iron Man', iron, (st) => `Potted their first ${st.opening} shots`);

    const pct = (st) => (st.p.shots >= AWARD_MIN.sharpshooterShots ? st.p.pots / st.p.shots : 0);
    // Tied players share a percentage but not necessarily the same counts.
    add('🎯', 'Sharpshooter', top(pct, 0.01), (st, shared) => (shared
      ? `${Math.round(pct(st) * 100)}% potted`
      : `${st.p.pots} of ${st.p.shots} potted (${Math.round(pct(st) * 100)}%)`));
    add('🐈‍⬛', 'Nine Lives', top((st) => st.p.extras, AWARD_MIN.nineLives), (st) => `${st.p.extras} extra lives`);
    add('🎩', 'Hat Trick', all.filter((st) => st.hatTrick), () => 'Potted 3 in one shot');
    add('🧟', 'Comeback Kid', all.filter((st) => st.comeback), () => 'Earned a life back while on their last');
    add('😰', 'Living on the Edge', top((st) => st.edgeTurns, AWARD_MIN.edge), (st) => `${st.edgeTurns} turns on their last life`);
    add('😈', 'Toughest Leave', top((st) => st.leaves, AWARD_MIN.toughestLeave), (st) => `${st.leaves} players out right after their turn`);
    // Meltdown: the best run that ended in a collapse.
    const melted = all.map((st) => ({ st, m: meltdown(st) })).filter((x) => x.m);
    const bestRun = Math.max(0, ...melted.map((x) => x.m.before));
    add('📉', 'Meltdown', melted.filter((x) => x.m.before === bestRun).map((x) => x.st), (st) => {
      const m = meltdown(st);
      return `Potted ${m.before}, then missed ${m.window === 3 ? 'their last 3' : '3 of their last 4'}`;
    });
    add('🎱', 'Dems da Breaks', top((st) => st.breaks, AWARD_MIN.breaks), (st) => `Broke ${st.breaks} racks`);
    add('🥶', 'Ice Cold', all.filter((st) => st.p.lives <= 0 && st.p.pots === 0), () => 'Out without potting a ball');
    return list;
  }

  function renderRecap() {
    const stats = gameStats();
    const w = byId(S.winner) || S.players.find(isAlive);
    const shots = S.players.reduce((n, p) => n + p.shots, 0);
    const names = (list) => (list.length > 1
      ? `${list.slice(0, -1).map(esc).join(', ')} &amp; ${esc(list[list.length - 1])}`
      : esc(list[0]));

    const awards = computeAwards(stats).map((a, i) => `
      <article class="award" style="--i:${i}">
        <div class="aw-icon" aria-hidden="true">${a.icon}</div>
        <div class="aw-body">
          <div class="aw-title">${a.title}</div>
          <div class="aw-name${a.names.length > 2 ? ' many' : ''}">${names(a.names)}</div>
          <div class="aw-detail">${a.detail}</div>
        </div>
      </article>`).join('');

    // Finishing order: winner, then last out to first out.
    const order = [w, ...S.outOrder.slice().reverse().map(byId)].filter(Boolean);
    const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    const rows = order.map((p, i) => {
      const st = stats.get(p.id);
      return `<tr class="${i === 0 ? 'is-winner' : ''}">
          <td class="st-place">${i === 0 ? '🏆' : ordinal(i + 1)}</td>
          <td class="st-name">${esc(p.name)}</td>
          <td class="st-num">${p.pots}<span>/${p.shots}</span></td>
          <td class="st-num">${p.extras ? `+${p.extras}` : '–'}</td>
          <td class="st-num st-wide">${st && st.best ? st.best : '–'}</td>
          <td class="st-num">${i === 0 ? '–' : st && st.outRound ? `R${st.outRound}` : '–'}</td>
        </tr>`;
    }).join('');

    app.innerHTML = `
      <section class="recap">
        ${fanfare ? '<button class="mute-fanfare" data-do="muteFanfare" aria-label="Mute fanfare">🔇 Mute fanfare</button>' : ''}
        <header class="recap-head">
          <button class="btn btn-ghost btn-sm" data-do="recapBack">← Back</button>
          <div class="recap-title">
            <h1>Recap</h1>
            <p>${S.players.length} players · ${shots} shots · won by <b>${esc(w ? w.name : '—')}</b></p>
          </div>
        </header>
        <div class="seg" role="tablist">
          <button role="tab" class="${recapTab === 'awards' ? 'on' : ''}" aria-selected="${recapTab === 'awards'}" data-do="tabAwards">Awards</button>
          <button role="tab" class="${recapTab === 'standings' ? 'on' : ''}" aria-selected="${recapTab === 'standings'}" data-do="tabStandings">Standings</button>
        </div>
        ${recapTab === 'awards'
          ? `<div class="awards">${awards}</div>`
          : `<table class="standings">
              <thead><tr><th></th><th class="st-name">Player</th><th>Potted</th><th>Extra</th><th class="st-wide">Streak</th><th>Out Rd</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`}
      </section>`;
  }

  // ---------------------------------------------------------------- sheet (dialog)

  function openSheet(mode) {
    sheetMode = mode;
    confirmKey = null;
    renderSheet();
    if (sheetMode && !sheet.open) sheet.showModal();
  }

  function closeSheet() {
    sheetMode = null;
    if (sheet.open) sheet.close();
  }

  const onOff = (on) => `<span class="state ${on ? 'on' : 'off'}">${on ? 'ON' : 'OFF'}</span>`;
  const watchLink = (code, tv) => `${location.origin}${location.pathname}?watch=${code}${tv ? '&tv' : ''}`;
  const shareLink = () => share && watchLink(share.code, false);

  // QR code as an inline SVG (black on white, so any camera can read it).
  function qrSvg(text) {
    if (!window.qrcode) return '';
    try {
      const q = window.qrcode(0, 'M');
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch (_) { return ''; }
  }

  function renderSheet() {
    if (!sheetMode) return closeSheet();

    if (sheetMode.type === 'watch') {
      sheet.innerHTML = `
        <div class="sheet-body">
          <div class="sheet-head">
            <h3 class="sheet-title">Watch a game</h3>
            <button class="icon-btn" data-sheet="close" aria-label="Close">✕</button>
          </div>
          <p class="sheet-note">Enter the 5-letter code from the scorekeeper. Your own saved game stays exactly as it is.</p>
          <form id="watchForm" class="watch-form" autocomplete="off">
            <input type="text" id="watchCode" maxlength="5" placeholder="CODE" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-label="Game code">
            <button class="btn btn-start" type="submit">Watch</button>
          </form>
          ${sheetMode.error ? `<p class="watch-error">${sheetMode.error}</p>` : ''}
          <button class="link-btn" data-sheet="watchTv">Setting up the TV screen? Open it as the TV display</button>
        </div>`;
      setTimeout(() => { const box = $('#watchCode'); if (box) box.focus(); }, 50);
      return;
    }

    if (sheetMode.type === 'share') {
      const status = {
        connecting: '<span class="dot"></span> Connecting…',
        live: '<span class="dot"></span> Live: viewers see every tap',
        offline: '<span class="dot"></span> Offline: scoring still works, viewers will catch up',
      }[shareStatus];
      sheet.innerHTML = `
        <div class="sheet-body">
          <div class="sheet-head">
            <h3 class="sheet-title">Share live</h3>
            <button class="icon-btn" data-sheet="close" aria-label="Close">✕</button>
          </div>
          ${share ? `
            <div class="share-qr">${qrSvg(shareLink())}</div>
            <div class="share-code" aria-label="Game code">${esc(share.code)}</div>
            <p class="share-status ${shareStatus}">${status}</p>
            <div class="share-actions">
              <button class="btn btn-brass" data-sheet="copyLink">Copy link</button>
              ${navigator.share ? '<button class="btn btn-ghost" data-sheet="sendLink">📤 Send…</button>' : ''}
            </div>
            <p class="sheet-note">Everyone scans this to watch on their phone. It’s view-only and always silent.</p>

            <button class="tv-setup-toggle${tvSetupOpen ? ' open' : ''}" data-sheet="tvSetup" aria-expanded="${tvSetupOpen}">📺 Set up a TV screen <span aria-hidden="true">⌄</span></button>
            ${tvSetupOpen ? `
              <div class="tv-setup">
                <div class="share-qr small">${qrSvg(watchLink(share.code, true))}</div>
                <p class="sheet-note">Scan this with the device for the TV: a laptop, a tablet, or a phone turned sideways. It shows the big-screen board, with its own QR code so people can join.</p>
                <div class="share-actions"><button class="btn btn-ghost" data-sheet="copyTvLink">Copy TV link</button></div>
                <div class="cs-row">
                  <span>Room sound plays on</span>
                  <div class="seg seg-sm" role="radiogroup" aria-label="Room sound plays on">
                    <button role="radio" class="${roomSound === 'phone' ? 'on' : ''}" aria-checked="${roomSound === 'phone'}" data-sheet="roomPhone">This phone</button>
                    <button role="radio" class="${roomSound === 'tv' ? 'on' : ''}" aria-checked="${roomSound === 'tv'}" data-sheet="roomTv">TV screen</button>
                  </div>
                </div>
                ${roomSound === 'tv' ? '<p class="sheet-note">This phone stays quiet. Click the TV screen once to allow sound.</p>' : ''}
              </div>` : ''}

            <button class="sheet-btn danger" data-sheet="stopShare">Stop sharing<small>The links stop working</small></button>`
          : `
            <p class="sheet-note">Show this game live on everyone’s phones, or on a TV. Viewers get a link and can’t change anything.</p>
            <button class="sheet-btn primary" data-sheet="startShare">📡 Start sharing</button>`}
        </div>`;
      return;
    }

    if (sheetMode.type === 'clock') {
      sheet.innerHTML = `
        <div class="sheet-body">
          <div class="sheet-head">
            <h3 class="sheet-title">Shot clock</h3>
            <button class="icon-btn" data-sheet="close" aria-label="Close">✕</button>
          </div>
          <p class="sheet-note">${clockPrefs.on ? 'Tap the clock on the chalkboard to pause it, re-rack or restart.' : 'A countdown for each shot, with a buzzer at zero. It never scores anything.'}</p>
          <div class="cs-row">
            <span>Time per shot</span>
            <div class="cs-stepper">
              <button data-sheet="clockLess" aria-label="Less time" ${clockPrefs.secs <= CLOCK_MIN ? 'disabled' : ''}>−</button>
              <b>${clockPrefs.secs} sec</b>
              <button data-sheet="clockMore" aria-label="More time" ${clockPrefs.secs >= CLOCK_MAX ? 'disabled' : ''}>+</button>
            </div>
          </div>
          <button class="sheet-btn${clockPrefs.on ? ' danger' : ' primary'}" data-sheet="clockToggle">${clockPrefs.on ? 'Turn shot clock off' : '⏱ Turn shot clock on'}</button>
        </div>`;
      return;
    }

    if (sheetMode.type === 'player') {
      const p = byId(sheetMode.id);
      if (!p || S.phase !== 'playing') return closeSheet();
      const isCur = current() && current().id === p.id;
      sheet.innerHTML = `
        <div class="sheet-body">
          <div class="sheet-head">
            <h3 class="sheet-title">${esc(p.name)}</h3>
            <button class="icon-btn" data-sheet="close" aria-label="Close">✕</button>
          </div>
          <div class="stepper">
            <button class="step" data-sheet="dec" ${p.lives <= 0 ? 'disabled' : ''} aria-label="Take a life">−</button>
            <div class="step-val">${marks(p, 'lg')}<div><b>${p.lives}</b><span>${p.lives <= 0 ? 'out' : p.lives === 1 ? 'life' : 'lives'}</span></div></div>
            <button class="step" data-sheet="inc" aria-label="Give a life">+</button>
          </div>
          <p class="sheet-note">${p.shots} shots · ${p.pots} potted · ${p.misses} missed · ${p.extras} extra lives</p>
          <button class="sheet-btn" data-sheet="shoot" ${isCur || !isAlive(p) ? 'disabled' : ''}>
            🎱 ${isCur ? 'Shooting now' : 'Make them the shooter'}<small>Fix the turn order if someone jumped in</small>
          </button>
          <button class="sheet-btn danger" data-sheet="remove" ${S.players.length <= 2 ? 'disabled' : ''}>
            Remove from game<small>They left early</small>
          </button>
        </div>`;
    } else {
      sheet.innerHTML = `
        <div class="sheet-body">
          <div class="sheet-head">
            <h3 class="sheet-title">Menu</h3>
            <button class="icon-btn" data-sheet="close" aria-label="Close">✕</button>
          </div>
          <form class="add add-sm" id="lateForm" autocomplete="off">
            <input type="text" data-multi placeholder="Add a late player" autocapitalize="words" autocorrect="off" spellcheck="false" aria-label="Late player name">
            <button class="btn btn-brass" type="submit">Add</button>
          </form>
          ${canTV() ? `<button class="sheet-btn" data-sheet="tv">📺 TV mode<small>Big board for a TV or laptop — drive it with the keyboard</small></button>` : ''}
          <button class="sheet-btn" data-sheet="watch">👀 Watch another game<small>Enter a code to watch someone else’s game live</small></button>
          <button class="sheet-btn" data-sheet="share">📡 Share live ${onOff(!!share)}${share ? ` <span class="state-note">${esc(share.code)}</span>` : ''}<small>A live view for everyone’s phones or a TV</small></button>
          <button class="sheet-btn" data-sheet="rerack">🎱 Re-rack<small>${esc(current() ? current().name : '')} breaks the new rack</small></button>
          <button class="sheet-btn" data-sheet="clockPanel">⏱ Shot clock ${onOff(clockPrefs.on)}${clockPrefs.on ? ` <span class="state-note">${clockPrefs.secs} sec</span>` : ''}<small>Turn it on or off, or change the time</small></button>
          <button class="sheet-btn" data-sheet="sound">${soundOn ? '🔊 Sound' : '🔇 Sound'} ${onOff(soundOn)}<small>${share && roomSound === 'tv' && soundOn ? 'Playing on the TV screen (change in Share live)' : 'Arcade effects for extra lives, knockouts and the winner'}</small></button>
          <button class="sheet-btn" data-sheet="rematch">🔁 Rematch<small>Same players, fresh lives, new random order</small></button>
          <button class="sheet-btn danger" data-sheet="newgame">New game<small>Back to the player list</small></button>
          <div class="keys">
            <span><kbd>X</kbd> Miss</span><span><kbd>Space</kbd> Made</span><span><kbd>E</kbd> Extra life</span><span><kbd>${UNDO_KEY}</kbd> Undo</span><span><kbd>T</kbd> TV mode</span>
          </div>
          <p class="sheet-note">Tip: tap any player on the board to fix their lives.</p>
        </div>`;
    }
  }

  sheet.addEventListener('close', () => { sheetMode = null; });

  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) return closeSheet(); // backdrop
    const b = e.target.closest('button[data-sheet]');
    if (!b) return;
    const p = sheetMode && sheetMode.id ? byId(sheetMode.id) : null;
    switch (b.dataset.sheet) {
      case 'close': closeSheet(); break;
      case 'inc': if (p) setLives(p, p.lives + 1); break;
      case 'dec': if (p) setLives(p, p.lives - 1); break;
      case 'shoot': if (p) { makeShooter(p); closeSheet(); } break;
      case 'remove': if (p && confirmTap(b, 'remove')) { removePlayer(p); closeSheet(); } break;
      case 'tv': closeSheet(); toggleTV(); break;
      case 'sound': setSound(!soundOn); renderSheet(); sfx.extra(); break;
      case 'rerack': closeSheet(); rerack(); break;
      case 'clockPanel': openSheet({ type: 'clock' }); break;
      case 'share': openSheet({ type: 'share' }); break;
      case 'watch': openSheet({ type: 'watch' }); break;
      case 'startShare': startSharing(); break;
      case 'stopShare': if (confirmTap(b, 'stopShare')) stopSharing(); break;
      case 'copyLink': copyLink(shareLink()); break;
      case 'watchTv': goWatch($('#watchCode') ? $('#watchCode').value : '', true); break;
      case 'copyTvLink': copyLink(watchLink(share.code, true)); break;
      case 'tvSetup': tvSetupOpen = !tvSetupOpen; renderSheet(); break;
      case 'roomPhone': case 'roomTv':
        roomSound = b.dataset.sheet === 'roomTv' ? 'tv' : 'phone';
        try { localStorage.setItem(ROOM_KEY, roomSound); } catch (_) { /* ignore */ }
        queuePublish();
        renderSheet();
        break;
      case 'sendLink': navigator.share({ title: 'Killer: live game', url: shareLink() }).catch(() => {}); break;
      case 'clockLess': setClockPrefs({ secs: clockPrefs.secs - CLOCK_STEP }); restartClock(); renderSheet(); break;
      case 'clockMore': setClockPrefs({ secs: clockPrefs.secs + CLOCK_STEP }); restartClock(); renderSheet(); break;
      case 'clockToggle': setClockPrefs({ on: !clockPrefs.on }); clk = null; closeSheet(); render(); break;
      case 'rematch': if (confirmTap(b, 'rematch')) { closeSheet(); rematch(); } break;
      case 'newgame': if (confirmTap(b, 'newgame')) { closeSheet(); newGame(); } break;
    }
  });

  // ---------------------------------------------------------------- sound
  // Retro arcade effects synthesized with Web Audio — no audio files.
  const SOUND_KEY = 'killer.sound.v1';
  let soundOn = WATCH ? false : (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch (_) { return true; } })();
  let actx = null;
  let master = null;

  function setSound(on) {
    soundOn = on;
    try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (_) { /* ignore */ }
    queuePublish();
  }

  // Only one device plays room sound. Viewers' phones never do; the TV display does only
  // when the operator sends sound there (and someone has clicked to allow it).
  function soundHere() {
    if (WATCH) return WATCH_TV && tvSoundEnabled && remoteSound.on && remoteSound.target === 'tv';
    return soundOn && !(share && roomSound === 'tv');
  }
  const tvNeedsSoundClick = () => WATCH_TV && remoteSound.on && remoteSound.target === 'tv'
    && !(tvSoundEnabled && actx && actx.state === 'running');

  // Browsers only allow audio after a tap, which every sound here follows.
  function audio() {
    if (!soundHere()) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (actx && (actx.state === 'closed' || actx.state === 'interrupted')) {
      try { actx.close(); } catch (_) { /* already closed */ }
      actx = null;
    }
    if (!actx) {
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.55;
      const limiter = actx.createDynamicsCompressor();
      master.connect(limiter);
      limiter.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }

  // iPhones only allow page audio to start from a completed tap (finger lifted) or a key press,
  // not a touch-down. Wake it on those, with a silent blip that fully unlocks it. This also
  // readies the audio for sounds fired by a timer (shot clock ticks and buzzer).
  function unlockAudio() {
    if (!soundHere()) return;
    const ac = audio();
    if (!ac || ac.unlocked) return;
    try {
      const blip = ac.createBufferSource();
      blip.buffer = ac.createBuffer(1, 1, 22050);
      blip.connect(ac.destination);
      blip.start(0);
      if (ac.state === 'running') ac.unlocked = true;
    } catch (_) { /* try again on the next tap */ }
  }
  ['touchend', 'click', 'keydown'].forEach((type) => document.addEventListener(type, unlockAudio, true));

  // iOS can leave page audio silently dead after switching apps. Drop it when the app is
  // hidden; the next sound (always after a tap) builds a fresh one.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !actx) return;
    stopFanfare();
    try { actx.close(); } catch (_) { /* ignore */ }
    actx = null;
    master = null;
  });

  // One note. `hold` sustains then releases (brass, fanfare); otherwise it decays like a bell.
  function note(ac, { f, t = 0, d = 0.15, type = 'square', vol = 0.1, to, hold = false, vib, lowpass, dest = master, track }) {
    const start = ac.currentTime + t;
    const end = start + d;
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f, start);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, end);
    if (vib) {
      const lfo = ac.createOscillator();
      const depth = ac.createGain();
      lfo.frequency.value = vib.rate;
      depth.gain.setValueAtTime(0, start);
      depth.gain.linearRampToValueAtTime(vib.depth, start + d * 0.4); // vibrato swells in
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(start);
      lfo.stop(end + 0.05);
      if (track) track.push(lfo);
    }
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(vol, start + 0.012);
    if (hold) env.gain.setValueAtTime(vol, Math.max(start + 0.012, end - 0.07));
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env);
    let out = env;
    if (lowpass) {
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lowpass;
      env.connect(lp);
      out = lp;
    }
    out.connect(dest);
    osc.start(start);
    osc.stop(end + 0.05);
    if (track) track.push(osc);
  }

  const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

  // William Tell Overture finale (Rossini, 1829; public domain): the trumpet call, bars 226–242,
  // transcribed from the full score (IMSLP #22579). Instruments in E/G are converted to sounding
  // pitch in E major and raised an octave to carry on phone speakers. Entries: [bar, pattern, notes].
  const WT_TEMPO = 152; // ♩ = 152, 2/4
  const WT_RHYTHM = {
    call: [[0, 1], [1.5, 0.25], [1.75, 0.25]], // ta … ta-ta
    eighths: [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5]],
    gallop: [[0, 0.5], [0.5, 0.25], [0.75, 0.25], [1, 0.5], [1.5, 0.5]],
    hold: [[0, 4.5]], // held through bars 240–241, released on the downbeat of 242
  };
  const WT = {
    trumpet: [
      [0, 'call', 71], [1, 'call', 71],
      [2, 'eighths', [71, 68, 64, 68]], [3, 'eighths', [71, 68, 71, 76]],
      [4, 'eighths', [71, 68, 64, 68]], [5, 'eighths', [71, 68, 71, 76]],
      [6, 'call', 71], [7, 'call', 71], [8, 'call', 71], [9, 'call', 71],
      [10, 'gallop', 71], [11, 'gallop', 71], [12, 'gallop', 71], [13, 'gallop', 71],
      [14, 'hold', 71],
    ],
    hornE: [
      [4, 'call', [76, 80]], [5, 'call', [76, 80]],
      [6, 'eighths', [[76, 80], [71, 78], [68, 76], [71, 78]]],
      [7, 'eighths', [[76, 80], [80, 83], [78, 81], [76, 80]]],
      [8, 'eighths', [[71, 78], [76, 80], [71, 78], [78, 81]]],
      [9, 'eighths', [[76, 80], [71, 78], [68, 76], [76, 80]]],
      [10, 'gallop', [75, 78]], [11, 'gallop', [75, 78]], [12, 'gallop', [75, 78]], [13, 'gallop', [75, 78]],
      [14, 'hold', [75, 78]],
    ],
    hornG: [
      [8, 'call', [71, 83]], [9, 'call', [71, 83]],
      [10, 'gallop', [71, 83]], [11, 'gallop', [71, 83]], [12, 'gallop', [71, 83]], [13, 'gallop', [71, 83]],
      [14, 'hold', [71, 83]],
    ],
    bass: [
      [10, 'gallop', 47], [11, 'gallop', 47], [12, 'gallop', 47], [13, 'gallop', 47],
      [14, 'hold', 47],
    ],
  };

  // Expand [bar, pattern, notes] entries into { t, d, notes[] } events in seconds.
  function wtEvents(part) {
    const beat = 60 / WT_TEMPO;
    const out = [];
    for (const [bar, pattern, notes] of part) {
      WT_RHYTHM[pattern].forEach(([at, len], i) => {
        const n = Array.isArray(notes) && pattern !== 'call' && pattern !== 'gallop' && pattern !== 'hold' ? notes[i] : notes;
        out.push({ t: (bar * 2 + at) * beat, d: len * beat, held: pattern === 'hold', notes: [].concat(n) });
      });
    }
    return out;
  }

  let fanfare = null; // { bus, nodes } while the winner fanfare is playing

  function stopFanfare() {
    if (!fanfare || !actx) return;
    const now = actx.currentTime;
    fanfare.bus.gain.setTargetAtTime(0, now, 0.04);
    fanfare.nodes.forEach((n) => { try { n.stop(now + 0.25); } catch (_) { /* already stopped */ } });
    fanfare = null;
  }

  const sfx = {
    // Coin pickup: two quick bright notes.
    extra() {
      const ac = audio();
      if (!ac) return;
      note(ac, { f: 988, d: 0.08, hold: true });
      note(ac, { f: 1319, t: 0.08, d: 0.42 });
    },
    // Knocked out: a single low tone that sinks, like an arcade "life lost".
    out() {
      const ac = audio();
      if (!ac) return;
      note(ac, { f: 330, to: 82, d: 0.85, type: 'square', vol: 0.12, hold: true, lowpass: 900 });
      note(ac, { f: 165, to: 41, d: 0.85, type: 'triangle', vol: 0.14, hold: true });
    },
    // Shot clock countdown: soft ticks, with a brighter pip on the final second.
    tick(final) {
      const ac = audio();
      if (!ac) return;
      note(ac, { f: final ? 2093 : 1760, d: final ? 0.22 : 0.08, type: 'square', vol: final ? 0.2 : 0.15, lowpass: 5000 });
    },
    // Shot clock buzzer: a short, low, slightly detuned blast.
    buzzer() {
      const ac = audio();
      if (!ac) return;
      note(ac, { f: 110, d: 0.7, type: 'sawtooth', vol: 0.16, hold: true, lowpass: 900 });
      note(ac, { f: 116.5, d: 0.7, type: 'square', vol: 0.07, hold: true, lowpass: 700 });
    },
    // Victory: the William Tell trumpet call, trumpets over horns, ending on a held B major chord.
    win() {
      const ac = audio();
      if (!ac) return;
      stopFanfare();
      const bus = ac.createGain();
      bus.connect(master);
      const nodes = [];
      const cue = { bus, nodes };
      fanfare = cue;
      // Hide the mute button once the fanfare has finished on its own.
      setTimeout(() => {
        if (fanfare !== cue) return;
        fanfare = null;
        const btn = document.querySelector('.mute-fanfare');
        if (btn) btn.remove();
      }, 13200);
      const play = (part, voice) => wtEvents(part).forEach((e) => {
        // Short notes are slightly detached; the final chord swells with vibrato.
        const d = e.held ? e.d : e.d * 0.82;
        e.notes.forEach((m) => voice({ f: midiHz(m), t: e.t + 0.05, d, hold: true, dest: bus, track: nodes, ...(e.held ? { vib: { rate: 5.5, depth: 5 } } : {}) }));
      });
      play(WT.trumpet, (o) => note(ac, { ...o, type: 'square', vol: 0.085, lowpass: 3800 }));
      const horn = (o) => {
        note(ac, { ...o, type: 'triangle', vol: 0.055 });
        note(ac, { ...o, type: 'sawtooth', vol: 0.022, lowpass: 1100, vib: undefined });
      };
      play(WT.hornE, horn);
      play(WT.hornG, horn);
      play(WT.bass, (o) => note(ac, { ...o, type: 'triangle', vol: 0.13, vib: undefined }));
    },
    stop: stopFanfare,
  };

  // ---------------------------------------------------------------- feedback

  function flashOut(name) {
    if (reducedMotion()) { toast(`${name} is OUT`); return; }
    flash.innerHTML = `
      <div class="stamp">
        <svg class="stamp-x" viewBox="0 0 40 40" aria-hidden="true"><g filter="url(#chalk)">${stroke(0, true)}${stroke(1, true)}${stroke(2, true)}</g></svg>
        <div class="stamp-name">${esc(name)}</div>
        <div class="stamp-out">Out</div>
      </div>`;
    flash.classList.remove('show');
    void flash.offsetWidth; // restart the animation
    flash.classList.add('show');
    clearTimeout(flashOut.timer);
    flashOut.timer = setTimeout(() => flash.classList.remove('show'), 1800);
  }

  function toast(msg, ms = 1600) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* unsupported */ }
  }

  function confetti() {
    if (reducedMotion()) return;
    const c = $('#confetti');
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = (c.width = window.innerWidth * dpr);
    const H = (c.height = window.innerHeight * dpr);
    const colors = ['#f5c542', '#e5484d', '#2f7de1', '#7b3fa0', '#f08a24', '#2fb56a', '#8b1e2d', '#f4f1e8'];
    const parts = Array.from({ length: 170 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.35,
      y: H * 0.38,
      vx: (Math.random() - 0.5) * 15 * dpr,
      vy: (-Math.random() * 17 - 5) * dpr,
      r: (4 + Math.random() * 6) * dpr,
      c: colors[randInt(colors.length)],
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.3,
      ball: Math.random() < 0.35,
    }));
    const t0 = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.38 * dpr;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        if (p.ball) { ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.r, -p.r / 2.5, p.r * 2, p.r / 1.25);
        ctx.restore();
      }
      if (t - t0 < 4200) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    })(t0);
  }

  // Keep the screen on while a game is running.
  let wakeLock = null;
  let wakePending = false;
  async function updateWakeLock() {
    const want = S.phase === 'playing' && document.visibilityState === 'visible';
    if (wakePending || !('wakeLock' in navigator)) return;
    wakePending = true;
    try {
      if (want && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (_) {
      wakeLock = null;
    } finally {
      wakePending = false;
    }
  }
  document.addEventListener('visibilitychange', updateWakeLock);

  // ---------------------------------------------------------------- events

  const WATCH_ALLOWED = ['recap', 'recapBack', 'tabAwards', 'tabStandings', 'tv', 'muteFanfare', 'enableSound', 'leaveWatch'];

  app.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (WATCH && !WATCH_ALLOWED.includes(t.dataset.do)) return;

    if (t.dataset.act) {
      t.blur();
      ACTIONS[t.dataset.act]();
      return;
    }
    if (t.dataset.player) { openSheet({ type: 'player', id: t.dataset.player }); return; }
    if (t.dataset.del) {
      S.roster = S.roster.filter((r) => r.id !== t.dataset.del);
      setupNotice = '';
      save();
      render();
      return;
    }

    switch (t.dataset.do) {
      case 'shuffle': shuffleRoster(); break;
      case 'clear':
        if (confirmTap(t, 'clear')) { S.roster = []; save(); render(); }
        break;
      case 'lastRoster':
        S.roster = loadRoster().map((name) => ({ id: uid(), name }));
        save();
        render();
        break;
      case 'start': startGame(); break;
      case 'undo': undo(); break;
      case 'muteFanfare': sfx.stop(); t.remove(); break;
      case 'enableSound': tvSoundEnabled = true; unlockAudio(); sfx.extra(); render(); break;
      case 'watchEntry': openSheet({ type: 'watch' }); break;
      case 'leaveWatch': location.href = location.pathname; break;
      // Tapping the clock resumes it when paused; otherwise it opens the clock panel.
      case 'clock':
        if (clk && clk.pausedAt) resumeClock(); else pauseClock();
        render();
        break;
      case 'clockResume': resumeClock(); render(); break;
      case 'clockRestart': restartClock(); render(); break;
      case 'clockRerack': rerack(); break;
      case 'clockToggle': setClockPrefs({ on: !clockPrefs.on }); render(); break;
      case 'clockLess': setClockPrefs({ secs: clockPrefs.secs - CLOCK_STEP }); render(); break;
      case 'clockMore': setClockPrefs({ secs: clockPrefs.secs + CLOCK_STEP }); render(); break;
      case 'menu': openSheet({ type: 'menu' }); break;
      case 'tv': toggleTV(); break;
      case 'rematch': rematch(); break;
      case 'newgame': newGame(); break;
      case 'recap': view = 'recap'; recapTab = 'awards'; render(); window.scrollTo(0, 0); break;
      case 'recapBack': view = 'main'; render(); window.scrollTo(0, 0); break;
      case 'tabAwards': recapTab = 'awards'; render(); break;
      case 'tabStandings': recapTab = 'standings'; render(); break;
    }
  });

  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const input = form.querySelector('input');
    const text = input.value;
    input.value = '';
    if (form.id === 'addForm') {
      const dupes = addNames(text);
      if (dupes.length === 1 && parseNames(text).length === 1) {
        const box = $('#nameInput');
        box.value = `${dupes[0]} `;
        box.focus();
      }
    } else if (form.id === 'lateForm') { addLate(text); closeSheet(); }
    else if (form.id === 'watchForm') goWatch(text, false);
  });

  // Open a shared game by its code (same page, so it stays inside the Home Screen app).
  function goWatch(text, tv) {
    const code = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) {
      sheetMode = { type: 'watch', error: 'Codes are 5 letters and numbers, like KXQ7R.' };
      renderSheet();
      return;
    }
    location.href = watchLink(code, tv);
  }

  // Pasting a list (newlines/commas) adds everyone at once.
  document.addEventListener('paste', (e) => {
    const input = e.target.closest && e.target.closest('input[data-multi]');
    if (!input) return;
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (!/[\n,;\t]/.test(text)) return;
    e.preventDefault();
    input.value = '';
    if (input.form && input.form.id === 'lateForm') { addLate(text); closeSheet(); }
    else addNames(text);
  });

  // Drag-to-reorder on the setup list (works with mouse and touch).
  app.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip) return;
    e.preventDefault();
    dragId = grip.closest('li').dataset.id;
    render();
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
    window.addEventListener('pointercancel', onDragEnd, { once: true });
  });

  function onDragMove(e) {
    if (!dragId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const li = el && el.closest('#roster li');
    if (!li || li.dataset.id === dragId) return;
    const from = S.roster.findIndex((r) => r.id === dragId);
    const to = S.roster.findIndex((r) => r.id === li.dataset.id);
    if (from < 0 || to < 0) return;
    const [moved] = S.roster.splice(from, 1);
    S.roster.splice(to, 0, moved);
    render();
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    dragId = null;
    save();
    render();
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat || sheet.open) return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const k = e.key.toLowerCase();

    // Undo is ⌘Z / Ctrl+Z only, so it can't be hit by accident next to X (Miss).
    if (k === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (S.phase !== 'setup') { e.preventDefault(); undo(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (WATCH) {
      if (S.phase === 'playing' && canTV() && (k === 't' || (k === 'escape' && S.tv))) { e.preventDefault(); toggleTV(); }
      return;
    }

    if (S.phase === 'playing') {
      if (k === 'x' || k === 'arrowleft') actMiss();
      else if (k === ' ' || k === 'arrowright' || k === 'enter') actMade();
      else if (k === 'e' || k === 'arrowup' || k === '+' || k === '=') actExtra();
      else if (canTV() && (k === 't' || (k === 'escape' && S.tv))) toggleTV();
      else if (k === 'p' && clockOn()) { if (clk && clk.pausedAt) resumeClock(); else pauseClock(); render(); }
      else if (k === 'r' && clockOn()) { restartClock(); render(); }
      else if (k === 'b') rerack();
      else return;
      e.preventDefault();
    }
  });

  // ---------------------------------------------------------------- live sharing

  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L mix-ups
  const newCode = () => Array.from({ length: 5 }, () => CODE_CHARS[randInt(CODE_CHARS.length)]).join('');

  function saveShare() {
    try {
      if (share) localStorage.setItem(SHARE_KEY, JSON.stringify(share));
      else localStorage.removeItem(SHARE_KEY);
    } catch (_) { /* ignore */ }
  }

  function setShareStatus(status) {
    if (status === shareStatus) return;
    shareStatus = status;
    if (sheet.open && sheetMode && sheetMode.type === 'share') renderSheet();
  }

  // Watchers see the game, not this device's view settings or the setup list.
  function publicState() {
    const { tv, roster, ...rest } = S;
    rest.room = { sound: soundOn, target: roomSound };
    const off = serverOffset();
    rest.clock = {
      on: clockPrefs.on,
      secs: clockPrefs.secs,
      id: clk ? clk.id : null,
      startedAt: clk ? clk.start + off : 0,
      pausedAt: clk && clk.pausedAt ? clk.pausedAt + off : 0,
    };
    return rest;
  }

  // Milliseconds between this device's clock and Firebase's (0 until known).
  const serverOffset = () => (window.killerLive ? window.killerLive.serverOffset() : 0);

  // Viewers: rebuild the running clock from the shared one, in this device's time.
  function applyRemoteClock(c) {
    if (!c) { clockPrefs = { on: false, secs: 30 }; clk = null; return; }
    clockPrefs = { on: !!c.on, secs: c.secs || 30 };
    if (!c.id) { clk = null; return; }
    const off = serverOffset();
    const start = c.startedAt - off;
    const same = clk && clk.id === c.id && Math.abs(clk.start - start) < 50;
    clk = {
      id: c.id,
      start,
      pausedAt: c.pausedAt ? c.pausedAt - off : 0,
      expired: same ? clk.expired : false,
      ticked: same ? clk.ticked : undefined,
    };
  }

  // Bundle rapid taps into one update.
  let publishTimer = 0;
  function queuePublish() {
    if (!share) return;
    clearTimeout(publishTimer);
    publishTimer = setTimeout(publishNow, 150);
  }

  async function publishNow() {
    const live = window.killerLive;
    if (!share || !live) return;
    const code = share.code;
    try {
      await live.publish(code, publicState());
      setShareStatus('live');
    } catch (err) {
      if (String(err && (err.code || err.message)).toUpperCase().includes('PERMISSION')) {
        // The code belongs to another game (or this phone's ID changed): switch to a fresh code.
        share = { code: newCode() };
        saveShare();
        toast('Sharing moved to a new code');
        if (sheet.open) renderSheet();
        return publishNow();
      }
      setShareStatus('offline');
    }
  }

  function startSharing() {
    share = { code: newCode() };
    shareStatus = 'connecting';
    saveShare();
    renderSheet();
    render();
    if (!window.killerLive) setShareStatus('offline');
    publishNow();
  }

  function stopSharing() {
    const live = window.killerLive;
    if (share && live) live.stop(share.code).catch(() => {});
    share = null;
    saveShare();
    closeSheet();
    render();
    toast('Stopped sharing');
  }

  function copyLink(link) {
    const done = () => toast('Link copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => selectLink());
    else selectLink();
  }

  function selectLink() {
    const input = sheet.querySelector('.share-link input');
    if (input) { input.focus(); input.select(); }
  }

  // Watchers: show the same result stamps the scorekeeper sees, worked out from the new shots.
  function stampFromRemote(added) {
    if (S.phase !== 'playing' || !added.length) return;
    const lastShot = [...added].reverse().find((e) => e.a !== 'rack');
    if (!lastShot) return;
    const p = byId(lastShot.p);
    if (!p) return;
    const knockedOut = added.find((e) => e.a === 'miss' && e.l <= 0);
    if (knockedOut) {
      const out = byId(knockedOut.p);
      showResult(knockedOut.p, 'out', 1900);
      if (out) flashOut(out.name);
      if (S.phase === 'playing') sfx.out();
    } else if (lastShot.a === 'miss') {
      showResult(p.id, 'miss', 950);
    } else if (lastShot.a === 'extra' && lastShot.late) {
      showResult(p.id, 'extra', 1500, (S.last && S.last.bonus) || 1);
      sfx.extra();
    } else if (lastShot.a === 'made') {
      const extras = added.filter((e) => e.a === 'extra' && !e.late && e.p === p.id).length;
      if (extras) { showResult(p.id, 'extra', 1500, extras); sfx.extra(); }
      else showResult(p.id, 'safe', 750);
    }
  }

  function applyRemote(state) {
    const wasLive = remote.status === 'live';
    const prevLog = S.log || [];
    const { clock, room, ...game } = state;
    S = { ...freshState(), ...game, tv: S.tv };
    applyRemoteClock(clock);
    remoteSound = room ? { on: !!room.sound, target: room.target === 'tv' ? 'tv' : 'phone' } : { on: false, target: 'phone' };
    remote.status = 'live';
    if (!Array.isArray(S.log)) S.log = [];
    if (S.log.length < prevLog.length) clearResult(false); // the scorekeeper pressed Undo
    else if (wasLive) stampFromRemote(S.log.slice(prevLog.length));
    render();
  }

  function startWatching() {
    window.killerLive.watch(WATCH, applyRemote, () => {
      remote.status = 'missing';
      render();
    });
  }

  function onLiveReady() {
    if (WATCH) startWatching();
    else if (share) publishNow();
  }
  if (window.killerLive) onLiveReady();
  else window.addEventListener('killer:live-ready', onLiveReady, { once: true });
  // If Firebase can't be loaded at all (offline, blocked), say so instead of spinning forever.
  setTimeout(() => {
    if (window.killerLive) return;
    if (WATCH && remote.status === 'connecting') { remote.status = 'unreachable'; render(); }
    if (share) setShareStatus('offline');
  }, 10000);

  window.matchMedia('(orientation: landscape)').addEventListener('change', () => render());

  // The QR library loads in the background; draw any QR codes that were waiting for it.
  window.addEventListener('killer:qr-ready', () => {
    if (sheet.open) renderSheet();
    if (WATCH_TV) render();
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && S.tv && S.phase === 'playing') { S.tv = false; save(); render(); }
  });

  render();
})();
