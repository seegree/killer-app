/* Killer — pool scorekeeper.
 * One state object (S) drives everything: every action snapshots it for Undo,
 * saves it to localStorage, then re-renders the screen from scratch. */
(() => {
  'use strict';

  const START_LIVES = 3;
  // Game length: lives each player starts with. Marks always count down from 3, so a shorter game
  // simply starts everyone part-way (Blitz with a /, Sudden death with an X).
  const MODES = { 3: 'Classic', 2: 'Blitz', 1: 'Sudden death' };
  const MODE_ICON = { 2: '⚡', 1: '💀' };
  // The choice is a hidden extra, off until unlocked on this phone (see modeTap).
  const MODES_KEY = 'killer.modes.v1';
  let modesUnlocked = (() => { try { return localStorage.getItem(MODES_KEY) === 'on'; } catch (_) { return false; } })();
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
  // Bumped on every release (see bump-version.sh); must match version.json and index.html.
  const APP_VERSION = '2026.09.25.3';
  const UNDO_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘Z' : 'Ctrl+Z';

  // ---------------------------------------------------------------- live sharing (setup)

  // ?watch=CODE opens a read-only live view of someone else's game. It never touches this
  // browser's own saved game.
  const WATCH = (new URLSearchParams(location.search).get('watch') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || null;
  const WATCH_TV = !!WATCH && new URLSearchParams(location.search).has('tv');
  const SHARE_KEY = 'killer.share.v1';
  // Where room sound plays while sharing: the operator's phone, the TV display, or both.
  const ROOM_KEY = 'killer.room.v1';
  const ROOM_TARGETS = ['phone', 'tv', 'both', 'everyone'];
  const roomTarget = (t) => (ROOM_TARGETS.includes(t) ? t : 'phone');
  const tvGetsSound = (t) => t === 'tv' || t === 'both' || t === 'everyone';
  // Party mode ("Everyone": every watching phone joins in) is a hidden extra, off until
  // unlocked on this phone (see partyTap). This phone remembers.
  const PARTY_KEY = 'killer.party.v1';
  let partyUnlocked = (() => { try { return localStorage.getItem(PARTY_KEY) === 'on'; } catch (_) { return false; } })();
  let roomSound = (() => { try { return roomTarget(localStorage.getItem(ROOM_KEY)); } catch (_) { return 'phone'; } })();
  if (roomSound === 'everyone' && !partyUnlocked) roomSound = 'both';
  let partyJoined = false; // watcher: tapped to join the room sound in party mode
  let partyDeclined = false; // watcher: said no thanks (asked again next visit)
  let remoteSound = { on: false, target: 'phone' }; // TV display: the operator's sound settings
  let tvSoundEnabled = false; // TV display: someone clicked to allow sound
  let tvSetupOpen = false;

  // Viewers can pick which player they are to get their own turn alerts. Remembered by
  // name (so it carries across rematches) and per game code.
  const ME_KEY = 'killer.me.v1';
  let me = (() => {
    const base = { name: '', codes: {}, sound: true };
    if (!WATCH || WATCH_TV) return base;
    try { return { ...base, ...JSON.parse(localStorage.getItem(ME_KEY)) }; } catch (_) { return base; }
  })();
  const alerted = { deck: null, up: null }; // turn keys already alerted, so each fires once
  const dismissed = { deck: null, up: null };
  const shown = { deck: null, up: null }; // animate the banner/takeover only when they first appear
  let askedWho = false; // the "who are you?" question is asked once per visit
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
    return { phase: 'setup', roster: [], players: [], current: 0, turnBonus: 0, outOrder: [], last: null, winner: null, log: [], tv: false, startLives: START_LIVES };
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

  function newPlayer(name, lives = START_LIVES) {
    return { id: uid(), name, lives, shots: 0, pots: 0, misses: 0, extras: 0 };
  }
  // Lives for the game about to start (Classic unless a shorter game is unlocked and chosen)
  const gameLives = () => (modesUnlocked && MODES[S.startLives] ? S.startLives : START_LIVES);

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

  // ---------------------------------------------------------------- following yourself (viewers)

  const following = () => !!(WATCH && !WATCH_TV && me.codes[WATCH]);
  const mePlayer = () => (following() ? S.players.find((p) => nameKey(p.name) === nameKey(me.codes[WATCH])) : null);

  // The name this phone used last time, if that player is in this game.
  const rememberedPlayer = () => (me.name ? S.players.find((p) => nameKey(p.name) === nameKey(me.name)) : null);

  function saveMe() {
    try { localStorage.setItem(ME_KEY, JSON.stringify(me)); } catch (_) { /* ignore */ }
  }

  // Turns until this player shoots: 0 = up now, 1 = on deck, null = out or not playing.
  function turnsUntil(p) {
    if (!p || !isAlive(p) || S.phase !== 'playing') return null;
    let i = S.current;
    for (let k = 0; k <= S.players.length; k++) {
      if (S.players[i] && S.players[i].id === p.id) return k;
      i = nextAliveIndex(i);
      if (i < 0) return null;
    }
    return null;
  }

  // Identifies the current turn, so each alert fires once per turn.
  const turnKey = () => `${S.log.filter((e) => e.a === 'miss' || e.a === 'made').length}:${S.current}`;

  function choosePlayer(name) {
    me.codes[WATCH] = name;
    if (name) me.name = name;
    saveMe();
    alerted.deck = alerted.up = null;
    dismissed.deck = dismissed.up = null;
    closeSheet();
    unlockAudio();
    render();
    checkMyTurn();
  }

  // Fire the on-deck / you're-up alerts when this player's turn is coming.
  function checkMyTurn() {
    const p = mePlayer();
    const n = turnsUntil(p);
    const key = turnKey();
    if (n === 1 && alerted.deck !== key) {
      alerted.deck = key;
      buzz([120]);
      sfx.deck();
    }
    if (n === 0 && alerted.up !== key) {
      alerted.up = key;
      buzz([200, 100, 200, 100, 400]);
      sfx.up();
    }
  }

  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
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
    // The you're-up screen on a viewer's phone shows the same countdown.
    const upNum = document.getElementById('upClockNum');
    if (upNum) {
      upNum.textContent = v.text;
      const upChip = document.getElementById('upClock');
      upChip.classList.toggle('warn', v.warn);
      upChip.classList.toggle('time', v.time);
      upChip.classList.toggle('paused', v.paused);
      const upBar = document.getElementById('upClockBar');
      upBar.style.transform = `scaleX(${v.scale})`;
      upBar.parentElement.classList.toggle('warn', v.warn || v.time);
      upChip.closest('.up-takeover').classList.toggle('urgent', v.warn || v.time);
    }
    // Final seconds: a huge red countdown over the lives row, and the chalkboard frame pulses.
    const finalEl = document.getElementById('clockFinal');
    const now = finalEl && finalEl.closest('.now');
    if (finalEl && now) {
      const n = v.warn ? String(Math.ceil(v.left / 1000)) : '';
      now.classList.toggle('final', !!n);
      if (finalEl.textContent !== n) {
        finalEl.textContent = n;
        if (n) sizeFinal(finalEl);
        finalEl.classList.remove('beat');
        void finalEl.offsetWidth; // restart the punch-in for each new number
        if (n) finalEl.classList.add('beat');
      }
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

  // Final seconds take over the whole chalkboard: size the number to fill it.
  function sizeFinal(el) {
    const board = el.closest('.now-felt').getBoundingClientRect();
    el.style.setProperty('--final-size', `${Math.min(board.height * 1.15, board.width * 0.6)}px`);
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
      if (S.phase === 'playing') { flashOut(p.name); roomSfx('out'); }
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
      roomSfx('extra');
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
    roomSfx('extra');
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
    const lives = gameLives(); // Rematch keeps the game length; New game goes back to Classic
    S = { ...freshState(), tv: S.tv, roster: S.roster, phase: 'playing', startLives: lives, startedAt: Date.now(), players: names.map((n) => newPlayer(n, lives)) };
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
        fresh.forEach((n) => S.players.push(newPlayer(n, S.startLives || START_LIVES)));
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
    if (justWon) { if (!WATCH) roomSfx('win'); else if (!remoteSynced()) sfx.win(); }
    if (S.phase === 'setup') renderSetup();
    else if (S.phase === 'playing') renderGame();
    else if (view === 'recap') renderRecap();
    else renderWinner();
    if (S.phase === 'finished') prepareShareImage();

    if (S.phase === 'playing' && following()) app.insertAdjacentHTML('beforeend', turnAlerts());
    if (WATCH_TV) app.insertAdjacentHTML('beforeend', syncReadout());
    if (partyNeedsJoin()) {
      app.insertAdjacentHTML('beforeend', `
        <div class="party-banner" role="alert">
          <button class="pb-join" data-do="joinParty">🎉 Party mode! Tap to join the room sound</button>
          <button class="pb-no" data-do="declineParty" aria-label="No thanks">✕</button>
        </div>`);
    }
    if (tvNeedsSoundClick()) app.insertAdjacentHTML('beforeend', '<button class="sound-banner" data-do="enableSound">🔊 Click to turn on sound for the room</button>');
    if (S.phase !== 'playing') flash.classList.remove('show');
    if (justWon) confetti();
    lastPhase = S.phase;

    S.players.forEach((p) => prevLives.set(p.id, p.lives));
    if (sheet.open) renderSheet();
    updateWakeLock();
    ensureClockLoop();
    const finalNow = document.getElementById('clockFinal');
    if (finalNow && finalNow.textContent) sizeFinal(finalNow);
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
        </div>`;
    // The quickest way into a regular night: straight under the name box while the list is empty
    const lastRoster = !r.length && saved.length
      ? `<button class="btn btn-brass last-roster" data-do="lastRoster">Use last roster · ${saved.length} players</button>` : '';

    app.innerHTML = `
      <section class="setup">
        <header class="hero">
          <h1 class="wordmark"><img src="wordmark.svg" alt="Killer"></h1>
          <button class="watch-entry" data-do="watchEntry"><span aria-hidden="true">👀</span>Watch a game</button>
        </header>

        <form class="add" id="addForm" autocomplete="off">
          <input id="nameInput" type="text" data-multi placeholder="Name or initials"
                 enterkeyhint="enter" autocapitalize="words" autocorrect="off" spellcheck="false" aria-label="Player name">
          <button class="btn btn-brass" type="submit">Add</button>
        </form>
        <p class="hint${setupNotice ? ' notice' : ''}" aria-live="polite">${setupNotice || 'Tip: paste a whole list — one per line, or separated by commas.'}</p>
        ${lastRoster}

        <div class="roster-head">
          <h2>Players <span class="count">${r.length}</span></h2>
          <div class="roster-tools">
            <button class="btn btn-ghost" data-do="shuffle" ${r.length < 2 ? 'disabled' : ''}><span aria-hidden="true">🎲</span>Shuffle</button>
            <button class="btn btn-ghost" data-do="clear" ${r.length ? '' : 'disabled'}>Clear</button>
          </div>
        </div>

        ${list}

        <div class="setup-foot">
          ${modesUnlocked ? `
          <div class="seg seg-sm mode-seg" role="radiogroup" aria-label="Game length">
            ${[3, 2, 1].map((n) => `<button role="radio" class="${gameLives() === n ? 'on' : ''}" aria-checked="${gameLives() === n}" data-do="mode" data-n="${n}"><span>${MODE_ICON[n] ? `<i aria-hidden="true">${MODE_ICON[n]}</i>` : ''}${MODES[n]}</span><small>${n} ${n === 1 ? 'life' : 'lives'}</small></button>`).join('')}
          </div>` : ''}
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
            ${r.length < 2 ? 'Add at least 2 players' : `${MODE_ICON[gameLives()] ? `<span class="start-mode" aria-hidden="true">${MODE_ICON[gameLives()]}</span>` : ''}Rack ’em · ${r.length} players`}
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
    const meP = mePlayer();
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
      <button class="clock-final" data-do="clock" aria-label="Pause shot clock" tabindex="-1"><span class="${cv.warn ? 'beat' : ''}" id="clockFinal">${cv.warn ? Math.ceil(cv.left / 1000) : ''}</span>${WATCH ? '' : '<small>Tap to pause</small>'}</button>
      <div class="clock-bar${cv.barWarn ? ' warn' : ''}" aria-hidden="true"><i id="clockBar" style="transform:scaleX(${cv.scale})"></i></div>`
      : (clockOn() && heldIdx < 0 ? '<div class="clock idle" aria-label="No shot clock on the break">Break</div>' : '')
        // An empty bar keeps the card the same height while a stamp shows or on the break
        + (clockOn() ? '<div class="clock-bar ghost" aria-hidden="true"></div>' : '');

    const cards = board.map((x) => {
      const isCur = x.id === p.id;
      const isNext = x.id === nextId;
      const out = !isAlive(x);
      const isMe = meP && x.id === meP.id;
      return `<button class="pc${isCur ? ' cur' : ''}${isNext ? ' nxt' : ''}${out ? ' out' : ''}${isMe ? ' me' : ''}" data-player="${x.id}" aria-label="${esc(x.name)}, ${out ? 'out' : livesLabel(x.lives)}">
          ${isMe ? '<span class="tag tag-me">You</span>' : ''}
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
      </span>`).join('');

    app.innerHTML = `
      <section class="game">
        <header class="topbar">
          <div class="brand-sm">${LOGO}<span>Killer</span></div>
          <div class="pill"><b>${alive}</b> left<i aria-hidden="true">·</i><b>${outCount}</b> out${MODE_ICON[S.startLives] ? `<i aria-hidden="true">·</i><span class="mode-tag" title="${MODES[S.startLives]}: ${S.startLives} ${S.startLives === 1 ? 'life' : 'lives'} each">${MODE_ICON[S.startLives]}</span>` : ''}</div>
          ${tvOn()
            ? WATCH_TV
              ? `<div class="tv-join">${qrSvg(watchLink(WATCH, false))}<span>Scan to watch<b>${esc(WATCH)}</b></span></div>`
              : '<button class="btn btn-ghost btn-sm" data-do="tv">Exit TV</button>'
            : WATCH
              ? `<div class="top-actions">${canTV() && !WATCH_TV ? '<button class="btn btn-ghost btn-sm" data-do="tv">📺 TV</button>' : ''}<span class="live-pill" title="Watching game ${WATCH}"><span class="live-badge">● Live</span><button data-do="leaveWatch" aria-label="Leave the live game and go back to my own">✕</button></span></div>`
              : `<div class="top-actions">
                  <button class="btn btn-ghost btn-sm top-extra" data-do="rerackTop" title="Re-rack (B)">🎱 Re-rack</button>
                  ${canTV() ? '<button class="btn btn-ghost btn-sm top-extra" data-do="tv" title="TV mode (T)">📺 TV</button>' : ''}
                  <button class="icon-btn${share ? ' is-live' : ''}" data-do="menu" aria-label="Menu"><span class="burger"><i></i><i></i><i></i></span></button>
                </div>`}
        </header>

        <div class="stage">
          <div class="left">
            <section class="now${entering ? ' enter' : ''}${stamp && fb.id ? ' holding' : ''}${showClock && cv.warn ? ' final' : ''}" aria-live="polite">
              <div class="now-felt">
                ${stamp}${clockHtml}
                <div class="now-label">${breakShot && heldIdx < 0 ? 'Now breaking' : 'Now shooting'}</div>
                <div class="now-name" style="--fit:${fit(p.name)}">${esc(p.name)}</div>
                <div class="now-status">${marks(p, 'lg')}<span class="now-lives${p.lives <= 1 ? ' last' : ''}">${livesText}</span></div>
                ${paused && !WATCH
                  ? `<div class="clock-actions">
                      <button data-do="clockResume" class="ca-go">▶ Resume</button>
                      <button data-do="clockRerack">🎱 Re-rack</button>
                      <button data-do="clockRestart">↺ Back to ${clockPrefs.secs}</button>
                    </div>`
                  : `<div class="now-next">${nextLine}</div>`}
              </div>
            </section>

            ${WATCH ? `<section class="controls watching"><div class="lastline"><span class="last-text">${lastText()}</span></div>${WATCH_TV ? '' : youStrip(meP)}</section>` : `            <section class="controls">
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

        ${tvOn() && !WATCH_TV ? `<footer class="tv-keys">${WATCH ? '' : `<span><kbd>X</kbd> Miss</span><span><kbd>Space</kbd> Made</span><span><kbd>E</kbd> Extra life</span><span><kbd>${UNDO_KEY}</kbd> Undo</span>`}${clockOn() && !WATCH ? `<span><kbd>P</kbd> Pause clock</span><span><kbd>R</kbd> Clock back to ${clockPrefs.secs}</span><span><kbd>B</kbd> Re-rack</span>` : ''}<span><kbd>T</kbd> Exit TV</span></footer>` : ''}
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
            ${WATCH ? `<div class="win-actions watching"><button class="btn btn-ghost btn-recap" data-do="recap"><span aria-hidden="true">🏅</span>Recap</button>${shareButton()}</div>` : `<div class="win-actions">
              <button class="btn btn-start" data-do="rematch">Rematch</button>
              <button class="btn btn-ghost btn-recap" data-do="recap"><span aria-hidden="true">🏅</span>Recap</button>
              ${shareButton()}
              <button class="btn btn-ghost" data-do="undo" ${history.length ? '' : 'disabled'}>↶ Undo</button>
              <button class="btn btn-ghost" data-do="newgame">New game</button>
            </div>
            <button class="watch-entry" data-do="watchEntry"><span aria-hidden="true">👀</span>Watch a game</button>`}
          </div>
        </div>
      </section>`;
  }

  // Viewer's own status along the bottom: lives and how many turns until they shoot.
  function youStrip(p) {
    if (!following()) {
      return '<button class="you-strip pick" data-do="whoami">👤 Pick your name to get turn alerts</button>';
    }
    if (!p) return `<button class="you-strip pick" data-do="whoami">👤 ${esc(me.codes[WATCH])} isn’t in this game · change</button>`;
    const n = turnsUntil(p);
    const place = S.outOrder.length - S.outOrder.indexOf(p.id) + aliveCount();
    const state = n === null ? 'out' : n === 0 ? 'up' : n === 1 ? 'deck' : '';
    const turn = n === null ? `Out · ${ordinal(place)}` : n === 0 ? 'You’re up!' : n === 1 ? 'On deck' : `Up in <b>${n}</b>`;
    return `
      <button class="you-strip ${state}" data-do="whoami" aria-label="You are ${esc(p.name)}. Tap to change.">
        <span class="ys-name">${esc(p.name)}</span>
        <span class="ys-lives">${marks(p, 'xs')}${p.lives <= 0 ? '' : p.lives === 1 ? 'Last life' : `${p.lives} lives`}</span>
        <span class="ys-turn">${turn}</span>
      </button>`;
  }

  // On deck: a dismissible banner. Your turn: a full-screen takeover (tap to see the board).
  function turnAlerts() {
    const p = mePlayer();
    const n = turnsUntil(p);
    const key = turnKey();
    if (n === 1 && dismissed.deck !== key) {
      const fresh = shown.deck !== key;
      shown.deck = key;
      return `
        <div class="deck-banner${fresh ? '' : ' still'}" role="alert">
          <span>🎱 <b>${esc(p.name)}</b>, you’re on deck. Head to the table!</span>
          <button data-do="dismissDeck" aria-label="Dismiss">✕</button>
        </div>`;
    }
    if (n === 0 && dismissed.up !== key && !fb) {
      const breaking = !S.log.length || [...S.log].reverse().find((e) => e.a !== 'extra').a === 'rack';
      const fresh = shown.up !== key;
      shown.up = key;
      return `
        <button class="up-takeover${fresh ? '' : ' still'}" data-do="dismissUp" role="alert">
          <span class="ut-name" style="--fit:${fit(p.name)}">${esc(p.name)}</span>
          <span class="ut-up">${breaking ? 'You’re breaking!' : 'You’re up!'}</span>
          <span class="ut-lives">${marks(p, 'lg')}<span>${p.lives === 1 ? 'Last life' : `${p.lives} lives left`}</span></span>
          ${upClock(breaking)}
          <span class="ut-hint">Tap to see the board</span>
        </button>`;
    }
    return '';
  }

  // The shot clock on the you're-up screen: a big countdown and a draining bar.
  function upClock(breaking) {
    if (!clockOn()) return '';
    if (breaking) return '<span class="ut-clock idle">Break · no clock</span>';
    const running = clk && clk.id === (mePlayer() || {}).id;
    const v = running ? clockView() : { text: clockPrefs.secs, scale: 1, warn: false, time: false, paused: false };
    return `
      <span class="ut-clock${v.warn ? ' warn' : ''}${v.time ? ' time' : ''}${v.paused ? ' paused' : ''}" id="upClock"><span id="upClockNum">${v.text}</span></span>
      <span class="ut-bar${v.warn || v.time ? ' warn' : ''}"><i id="upClockBar" style="transform:scaleX(${v.scale})"></i></span>`;
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
        if (st && e.l === 2 && st.results.includes('miss')) st.comeback = true; // missed down to their last life, then earned one back
        if (e.late) {
          lastExtras++;
          if (st && lastExtras >= 2) st.hatTrick = true;
        } else {
          extras++;
        }
        continue;
      }
      if (st) {
        const turnStartLives = (e.a === 'miss' ? e.l + 1 : e.l) - extras;
        st.turns++;
        st.results.push(e.a);
        if (turnStartLives === 1) st.edgeTurns++;
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

  // How a knocked-out player collapsed: missed as many turns in a row as the game's starting
  // lives (their last 3 in Classic, last 2 in Blitz), or in Classic, 3 of their last 4.
  function meltdown(st, lives) {
    if (st.p.lives > 0) return null;
    const r = st.results;
    const lastRun = r.slice(-lives);
    const last4 = r.slice(-4);
    let window = 0;
    if (lastRun.length === lives && lastRun.every((a) => a === 'miss')) window = lives;
    else if (lives === 3 && last4.length === 4 && last4.filter((a) => a === 'miss').length === 3) window = 4;
    if (!window) return null;
    const before = r.slice(0, -window).filter((a) => a === 'made').length;
    return before >= AWARD_MIN.meltdownPots ? { before, window } : null;
  }

  function computeAwards(stats) {
    // The game's own starting lives (not this phone's setting, so watchers' recaps match).
    // In Sudden death (1 life) a few awards stop meaning anything, so they sit out.
    const L = S.startLives || START_LIVES;
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
    if (champ && L > 1 && champ.p.lives === 1) add('⚰️', 'Dead Man Walking', [champ], () => 'Won it on their last life');
    if (champ && L > 1 && champ.p.misses === 0) add('🧼', 'Flawless', [champ], () => 'Won without a single miss');

    const fire = top((st) => st.best, AWARD_MIN.onFire);
    add('🔥', 'On Fire', fire, (st) => `${st.best} made in a row`);
    const iron = top((st) => st.opening, AWARD_MIN.ironMan);
    const sameAsFire = iron.length && iron.every((st) => fire.includes(st)) && iron[0].opening === fire[0].best;
    if (!sameAsFire) add('🛡️', 'Iron Man', iron, (st) => `Potted their first ${st.opening} shots`);

    const pct = (st) => (st.p.shots >= AWARD_MIN.sharpshooterShots ? st.p.pots / st.p.shots : 0);
    // Tied players share a percentage but not necessarily the same counts.
    if (L > 1) add('🎯', 'Sharpshooter', top(pct, 0.01), (st, shared) => (shared
      ? `${Math.round(pct(st) * 100)}% potted`
      : `${st.p.pots} of ${st.p.shots} potted (${Math.round(pct(st) * 100)}%)`));
    add('🐈‍⬛', 'Nine Lives', top((st) => st.p.extras, AWARD_MIN.nineLives), (st) => `${st.p.extras} extra lives`);
    add('🎩', 'Hat Trick', all.filter((st) => st.hatTrick), () => 'Potted 3 in one shot');
    add('🧟', 'Comeback Kid', all.filter((st) => st.comeback), () => 'Earned a life back while on their last');
    if (L > 1) add('😰', 'Living on the Edge', top((st) => st.edgeTurns, AWARD_MIN.edge), (st) => `${st.edgeTurns} turns on their last life`);
    add('😈', 'Toughest Leave', top((st) => st.leaves, AWARD_MIN.toughestLeave), (st) => `${st.leaves} players out right after their turn`);
    // Meltdown: the best run that ended in a collapse.
    if (L > 1) {
      const melted = all.map((st) => ({ st, m: meltdown(st, L) })).filter((x) => x.m);
      const bestRun = Math.max(0, ...melted.map((x) => x.m.before));
      add('📉', 'Meltdown', melted.filter((x) => x.m.before === bestRun).map((x) => x.st), (st) => {
        const m = meltdown(st, L);
        return `Potted ${m.before}, then missed ${m.window === 4 ? '3 of their last 4' : `their last ${m.window}`}`;
      });
    }
    add('🎱', 'Dems da Breaks', top((st) => st.breaks, AWARD_MIN.breaks), (st) => `Broke ${st.breaks} racks`);
    if (L > 1) add('🥶', 'Ice Cold', all.filter((st) => st.p.lives <= 0 && st.p.pots === 0), () => 'Out without potting a ball');
    return list;
  }

  // ---------------------------------------------------------------- share image
  // One tall picture of the night: winner, runners-up, awards and final standings. It's drawn on a
  // canvas (screenshot-style tools are unreliable on iPhones) as soon as the winner or recap screen
  // shows, so a tap can open the share menu straight away: iPhones only allow that right after a tap.
  const SHARE_W = 1080;
  const SHARE_PAD = 64;
  const SC = { bg: '#07100c', card: '#10211a', line: 'rgba(244, 241, 232, 0.12)', chalk: '#f4f1e8', dim: 'rgba(244, 241, 232, 0.62)', faint: 'rgba(244, 241, 232, 0.4)', gold: '#f5c542', brass: '#e0b25a', feltHi: '#24774f', felt: '#17563b', feltLo: '#0e3a27', woodHi: '#6b4527', woodLo: '#2a180c' };
  let shareImg = { key: null, blob: null, busy: null };

  const shareButton = (label = 'Share') => `<button class="btn btn-ghost btn-share" data-do="shareResults"><span aria-hidden="true">📤</span>${label}</button>`;
  const shareKey = () => `${S.winner}|${(S.log || []).length}|${S.players.length}|${S.startedAt || ''}`;

  function prepareShareImage() {
    if (S.phase !== 'finished') return Promise.resolve(null);
    const key = shareKey();
    if (shareImg.key === key) return shareImg.blob ? Promise.resolve(shareImg.blob) : shareImg.busy;
    shareImg = { key, blob: null, busy: null };
    shareImg.busy = drawShareImage()
      .then((blob) => { if (shareImg.key === key) shareImg.blob = blob; return blob; })
      .catch(() => { if (shareImg.key === key) shareImg.key = null; return null; });
    return shareImg.busy;
  }

  async function shareResults(btn) {
    const blob = shareImg.key === shareKey() && shareImg.blob ? shareImg.blob : await prepareShareImage();
    if (!blob) { toast('Couldn’t make the image. Try again.'); return; }
    const day = new Date(S.startedAt || Date.now());
    const name = `killer-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Killer results' }); } catch (_) { /* closed the share menu */ }
      return;
    }
    // No share menu (most laptops): download it instead.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (btn) { btn.textContent = '✓ Saved'; setTimeout(() => render(), 1600); }
  }

  // The wordmark has no set size, which some browsers won't draw: load it with one.
  async function loadWordmark() {
    const svg = await (await fetch('wordmark.svg')).text();
    const sized = svg.replace('<svg ', '<svg width="1142" height="440" ');
    const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  async function drawShareImage() {
    await Promise.all(['400 100px "Bebas Neue"', '500 30px Inter', '700 30px Inter'].map((f) => document.fonts.load(f))).catch(() => {});
    const logo = await loadWordmark().catch(() => null);
    const stats = gameStats();
    const w = byId(S.winner) || S.players.find(isAlive);
    const data = {
      w,
      order: [w, ...S.outOrder.slice().reverse().map(byId)].filter(Boolean),
      awards: computeAwards(stats),
      day: new Date(S.startedAt || Date.now()),
    };
    // Measure first, then draw at the height that needs.
    const probe = document.createElement('canvas').getContext('2d');
    const height = paintShare(probe, data, logo, false);
    const canvas = document.createElement('canvas');
    canvas.width = SHARE_W;
    canvas.height = height;
    paintShare(canvas.getContext('2d'), data, logo, true);
    return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('no image'))), 'image/png'));
  }

  // Lays out the whole picture top to bottom and returns its height. With draw off it only measures.
  function paintShare(ctx, { w, order, awards, day }, logo, draw) {
    const M = SHARE_PAD;
    const CW = SHARE_W - M * 2;
    const font = (size, weight = 500, family = 'Inter') => `${weight} ${size}px ${family === 'Inter' ? 'Inter, system-ui, sans-serif' : '"Bebas Neue", Impact, sans-serif'}`;
    const text = (str, x, y, { size, weight, family, color = SC.chalk, align = 'left' }) => {
      ctx.font = font(size, weight, family);
      if (!draw) return;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(str, x, y);
    };
    const width = (str, size, weight, family) => { ctx.font = font(size, weight, family); return ctx.measureText(str).width; };
    const wrap = (str, maxW, size, weight, family) => {
      const words = String(str).split(' ');
      const lines = [];
      let line = '';
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (line && width(next, size, weight, family) > maxW) { lines.push(line); line = word; } else line = next;
      }
      if (line) lines.push(line);
      return lines;
    };
    const clip = (str, maxW, size, weight, family) => {
      if (width(str, size, weight, family) <= maxW) return str;
      let s2 = str;
      while (s2.length > 1 && width(`${s2}…`, size, weight, family) > maxW) s2 = s2.slice(0, -1);
      return `${s2}…`;
    };
    const box = (x, y, bw, bh, r, fill) => {
      if (!draw) return;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, r);
      else ctx.rect(x, y, bw, bh); // older iPhones: square corners
      ctx.fillStyle = fill;
      ctx.fill();
    };
    const heading = (label, y) => {
      text(label, M, y + 46, { size: 54, weight: 400, family: 'display', color: SC.chalk });
      const lw = width(label, 54, 400, 'display');
      box(M + lw + 20, y + 26, CW - lw - 20, 2, 1, SC.line);
      return y + 76;
    };

    if (draw) {
      const bg = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
      bg.addColorStop(0, '#0d1d16');
      bg.addColorStop(1, SC.bg);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, SHARE_W, ctx.canvas.height);
    }

    // Wordmark, date and game details
    let y = 56;
    if (logo) {
      const lh = 170;
      const lw = lh * (1142 / 440);
      if (draw) ctx.drawImage(logo, (SHARE_W - lw) / 2, y, lw, lh);
      y += lh + 14;
    } else {
      text('KILLER', SHARE_W / 2, y + 120, { size: 140, weight: 400, family: 'display', align: 'center' });
      y += 150;
    }
    const dateLine = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const bits = [dateLine, MODE_ICON[S.startLives] ? `${MODE_ICON[S.startLives]} ${MODES[S.startLives]}` : null, `${S.players.length} players`].filter(Boolean);
    text(bits.join('  ·  '), SHARE_W / 2, y + 34, { size: 30, weight: 500, color: SC.dim, align: 'center' });
    y += 76;

    // Winner: a chalkboard in a wooden frame
    if (w) {
      const frame = 18;
      const inner = CW - frame * 2;
      let nameSize = 190;
      while (nameSize > 80 && width(w.name.toUpperCase(), nameSize, 400, 'display') > inner - 80) nameSize -= 6;
      const panelH = frame * 2 + 44 + 30 + nameSize * 0.9 + 34 + 128 + 44;
      if (draw) {
        const wood = ctx.createLinearGradient(M, y, M + CW, y + panelH);
        wood.addColorStop(0, SC.woodHi);
        wood.addColorStop(1, SC.woodLo);
        box(M, y, CW, panelH, 34, wood);
        const felt = ctx.createRadialGradient(SHARE_W / 2, y, 40, SHARE_W / 2, y + panelH / 2, CW * 0.75);
        felt.addColorStop(0, SC.feltHi);
        felt.addColorStop(0.55, SC.felt);
        felt.addColorStop(1, SC.feltLo);
        box(M + frame, y + frame, inner, panelH - frame * 2, 22, felt);
      }
      let py = y + frame + 44;
      text('🏆  LAST ONE STANDING', SHARE_W / 2, py + 22, { size: 28, weight: 700, color: SC.gold, align: 'center' });
      py += 30 + nameSize * 0.9;
      text(w.name.toUpperCase(), SHARE_W / 2, py + 6, { size: nameSize, weight: 400, family: 'display', align: 'center' });
      py += 34;
      const tiles = [[w.shots, 'shots'], [w.pots, 'potted'], [w.extras, 'extra lives'], [w.lives, 'lives left']];
      const gap = 14;
      const tw = (inner - 48 - gap * 3) / 4;
      tiles.forEach(([n, label], i) => {
        const tx = M + frame + 24 + i * (tw + gap);
        box(tx, py, tw, 128, 18, 'rgba(0, 0, 0, 0.28)');
        text(String(n), tx + tw / 2, py + 72, { size: 70, weight: 400, family: 'display', align: 'center' });
        text(label, tx + tw / 2, py + 106, { size: 22, weight: 500, color: SC.dim, align: 'center' });
      });
      y += panelH + 26;
    }

    // Runners-up
    const podium = order.slice(1, 3);
    if (podium.length) {
      const pw = (CW - 20) / 2;
      podium.forEach((p, i) => {
        const px = M + i * (pw + 20);
        box(px, y, pw, 96, 20, SC.card);
        text(i === 0 ? '2ND' : '3RD', px + 28, y + 60, { size: 26, weight: 700, color: SC.brass });
        text(clip(p.name.toUpperCase(), pw - 120, 50, 400, 'display'), px + 96, y + 66, { size: 50, weight: 400, family: 'display' });
      });
      y += 96 + 40;
    }

    // Awards, two to a row
    if (awards.length) {
      y = heading('AWARDS', y);
      const aw = (CW - 20) / 2;
      const textW = aw - 104 - 24;
      const cards = awards.map((a) => {
        const who = a.names.length > 1 ? `${a.names.slice(0, -1).join(', ')} & ${a.names[a.names.length - 1]}` : a.names[0];
        const nameLines = wrap(who.toUpperCase(), textW, 42, 400, 'display');
        const detailLines = wrap(a.detail, textW, 23, 500);
        return { a, nameLines, detailLines, h: 28 + 30 + nameLines.length * 42 + 8 + detailLines.length * 30 + 22 };
      });
      for (let i = 0; i < cards.length; i += 2) {
        const pair = cards.slice(i, i + 2);
        const rowH = Math.max(...pair.map((c) => c.h));
        pair.forEach((c, j) => {
          const cx = M + j * (aw + 20);
          box(cx, y, aw, rowH, 22, SC.card);
          text(c.a.icon, cx + 52, y + 74, { size: 56, weight: 500, align: 'center' });
          let cy = y + 28;
          text(c.a.title, cx + 104, cy + 22, { size: 24, weight: 700, color: SC.gold });
          cy += 30;
          c.nameLines.forEach((line) => { cy += 42; text(line, cx + 104, cy, { size: 42, weight: 400, family: 'display' }); });
          cy += 8;
          c.detailLines.forEach((line) => { cy += 30; text(line, cx + 104, cy - 4, { size: 23, weight: 500, color: SC.dim }); });
        });
        y += rowH + 16;
      }
      y += 24;
    }

    // Final standings: everyone, reading down two columns
    y = heading('FINAL STANDINGS', y);
    const colW = (CW - 24) / 2;
    const perCol = Math.ceil(order.length / 2);
    const rowH = 58;
    text('POTTED / SHOTS', M + CW, y - 10, { size: 18, weight: 700, color: SC.faint, align: 'right' });
    order.forEach((p, i) => {
      const col = i < perCol ? 0 : 1;
      const row = col ? i - perCol : i;
      const rx = M + col * (colW + 24);
      const ry = y + row * rowH;
      const win = i === 0;
      box(rx, ry, colW, rowH - 8, 14, win ? 'rgba(245, 197, 66, 0.16)' : SC.card);
      text(win ? '🏆' : ordinal(i + 1), rx + 44, ry + 35, { size: 22, weight: 700, color: win ? SC.gold : SC.dim, align: 'center' });
      const score = `${p.pots}/${p.shots}`;
      const sw = width(score, 24, 600);
      text(clip(p.name.toUpperCase(), colW - 100 - sw - 20, 36, 400, 'display'), rx + 86, ry + 38, { size: 36, weight: 400, family: 'display', color: win ? SC.gold : SC.chalk });
      text(score, rx + colW - 20, ry + 35, { size: 24, weight: 600, color: SC.dim, align: 'right' });
    });
    y += perCol * rowH + 36;

    // Footer
    const home = `${location.host}${location.pathname.replace(/\/(index\.html)?$/, '')}`;
    text(`Scored with Killer  ·  ${home}`, SHARE_W / 2, y + 26, { size: 24, weight: 500, color: SC.faint, align: 'center' });
    return Math.ceil(y + 72);
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
            <p>${MODE_ICON[S.startLives] ? `${MODE_ICON[S.startLives]} ${MODES[S.startLives]} · ` : ''}${S.players.length} players · ${shots} shots · won by <b>${esc(w ? w.name : '—')}</b></p>
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
        <div class="recap-share">${shareButton('Share results')}<p>One image with the winner, awards and standings</p></div>
      </section>`;
  }

  // ---------------------------------------------------------------- sheet (dialog)

  function openSheet(mode) {
    sheetMode = mode;
    confirmKey = null;
    renderSheet();
    if (sheetMode && !sheet.open) {
      lockPage();
      sheet.showModal();
      sheet.scrollTop = 0;
    }
  }

  // While a panel is open, pin the page behind it so a scroll can only move the panel
  // (iPhones otherwise pass scrolls through to the game underneath).
  let lockedY = null;
  function lockPage() {
    if (lockedY !== null) return;
    lockedY = window.scrollY;
    document.body.style.top = `${-lockedY}px`;
    document.body.classList.add('page-locked');
  }
  function unlockPage() {
    if (lockedY === null) return;
    document.body.classList.remove('page-locked');
    document.body.style.top = '';
    window.scrollTo(0, lockedY);
    lockedY = null;
  }

  function closeSheet() {
    sheetMode = null;
    if (sheet.open) sheet.close();
    unlockPage();
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

    if (sheetMode.type === 'still') {
      const p = rememberedPlayer();
      if (!p) { sheetMode = { type: 'who' }; return renderSheet(); }
      sheet.innerHTML = `
        <div class="sheet-body">
          <div class="sheet-head">
            <h3 class="sheet-title">Still ${esc(p.name)}?</h3>
            <button class="icon-btn" data-sheet="close" aria-label="Close">✕</button>
          </div>
          <p class="sheet-note">You’ll get a heads-up when you’re on deck, and a big alert when it’s your turn.</p>
          <button class="sheet-btn primary still-yes" data-sheet="pickMe" data-name="${esc(p.name)}">Yes, I’m ${esc(p.name)}</button>
          <button class="sheet-btn" data-sheet="someoneElse">Someone else<small>Pick from the player list</small></button>
          <button class="link-btn" data-sheet="pickMe" data-name="">I’m just watching</button>
        </div>`;
      return;
    }

    if (sheetMode.type === 'who') {
      const q = (sheetMode.q || '').trim();
      const names = S.players.map((p) => p.name).sort((a, b) => a.localeCompare(b));
      const shown = q ? names.filter((n) => nameKey(n).includes(nameKey(q))) : names;
      sheet.innerHTML = `
        <div class="sheet-body">
          <div class="sheet-head">
            <h3 class="sheet-title">Who are you?</h3>
            <button class="icon-btn" data-sheet="close" aria-label="Close">✕</button>
          </div>
          <p class="sheet-note">Get a heads-up when you’re on deck, and a big alert when it’s your turn.</p>
          <input type="search" class="who-search" data-who-search placeholder="Search names" value="${esc(q)}" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Search names">
          <div class="who-grid">
            ${shown.map((n) => `<button class="who-name${me.codes[WATCH] && nameKey(n) === nameKey(me.codes[WATCH]) ? ' on' : ''}" data-sheet="pickMe" data-name="${esc(n)}">${esc(n)}</button>`).join('') || '<p class="sheet-note">No matching names.</p>'}
          </div>
          <button class="sheet-btn" data-sheet="toggleAlertSound">${me.sound ? '🔔 Alert sound' : '🔕 Alert sound'} ${onOff(me.sound)}<small>A ping when you’re on deck and when it’s your turn (only on this phone)</small></button>
          ${partyOn() ? `<button class="sheet-btn" data-sheet="toggleParty">🎉 Room sound ${onOff(partyJoined)}<small>Party mode: play the room’s sounds on this phone, in time with everyone else</small></button>` : ''}
          <button class="link-btn" data-sheet="pickMe" data-name="">I’m just watching</button>
        </div>`;
      return;
    }

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
            <h3 class="sheet-title share-title">Share live</h3>
            <button class="icon-btn" data-sheet="close" aria-label="Close">✕</button>
          </div>
          ${share ? `
            <div class="share-grid">
            <div class="share-left">
            <div class="share-qr${tvSetupOpen ? ' mini' : ''}">${qrSvg(shareLink())}</div>
            <div class="share-code" aria-label="Game code">${esc(share.code)}</div>
            <p class="share-status ${shareStatus}">${status}</p>
            </div>
            <div class="share-right">
            <div class="share-actions">
              <button class="btn btn-brass${copied === 'link' ? ' copied' : ''}" data-sheet="copyLink">${copied === 'link' ? '✓ Copied' : 'Copy link'}</button>
              ${navigator.share ? '<button class="btn btn-ghost" data-sheet="sendLink">📤 Send…</button>' : ''}
            </div>
            <p class="sheet-note">Everyone scans this to watch on their phone. It’s view-only${roomSound === 'everyone' ? '. Party mode is on, so they can tap to join the room sound.' : ' and silent (apart from their own turn alerts).'}</p>

            <button class="tv-setup-toggle${tvSetupOpen ? ' open' : ''}" data-sheet="tvSetup" aria-expanded="${tvSetupOpen}">📺 Set up a TV screen <span aria-hidden="true">⌄</span></button>
            ${tvSetupOpen ? `
              <div class="tv-setup">
                <div class="share-qr small">${qrSvg(watchLink(share.code, true))}</div>
                <p class="sheet-note">Scan this with the device for the TV: a laptop, a tablet, or a phone turned sideways. It shows the big-screen board, with its own QR code so people can join.</p>
                <div class="share-actions"><button class="btn btn-ghost${copied === 'tv' ? ' copied' : ''}" data-sheet="copyTvLink">${copied === 'tv' ? '✓ Copied' : 'Copy TV link'}</button></div>
                <div class="cs-row">
                  <span>Room sound plays on</span>
                  <div class="seg seg-sm" role="radiogroup" aria-label="Room sound plays on">
                    <button role="radio" class="${roomSound === 'phone' ? 'on' : ''}" aria-checked="${roomSound === 'phone'}" data-sheet="roomPhone">This phone</button>
                    <button role="radio" class="${roomSound === 'tv' ? 'on' : ''}" aria-checked="${roomSound === 'tv'}" data-sheet="roomTv">TV screen</button>
                    <button role="radio" class="${roomSound === 'both' ? 'on' : ''}" aria-checked="${roomSound === 'both'}" data-sheet="roomBoth">Both</button>
                    ${partyUnlocked ? `<button role="radio" class="${roomSound === 'everyone' ? 'on' : ''}" aria-checked="${roomSound === 'everyone'}" data-sheet="roomEveryone">Everyone 🎉</button>` : ''}
                  </div>
                </div>
                ${roomSound === 'tv' ? '<p class="sheet-note">This phone stays quiet. Click the TV screen once to allow sound.</p>' : ''}
                ${roomSound === 'both' || roomSound === 'everyone' ? `
                  <div class="cs-row">
                    <span>Sync delay</span>
                    <div class="cs-stepper">
                      <button data-sheet="leadLess" aria-label="Shorter delay" ${syncLead <= LEAD_MIN ? 'disabled' : ''}>−</button>
                      <b>${(syncLead / 1000).toFixed(1)} s</b>
                      <button data-sheet="leadMore" aria-label="Longer delay" ${syncLead >= LEAD_MAX ? 'disabled' : ''}>+</button>
                    </div>
                  </div>
                  <p class="sheet-note">${roomSound === 'everyone'
                    ? 'Party mode: plays on this phone, the TV screen and every watching phone that joins in, all together, this long after each tap. Watchers get a “Join the room sound” button.'
                    : 'Plays on this phone and the TV screen together, this long after each tap, so both play at once. Click the TV screen once to allow sound there.'}</p>` : ''}
              </div>` : ''}

            <button class="sheet-btn danger" data-sheet="stopShare">Stop sharing<small>The links stop working</small></button>
            </div>
            </div>`
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
        <div class="sheet-body menu-body">
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
          <button class="sheet-btn" data-sheet="sound">${soundOn ? '🔊 Sound' : '🔇 Sound'} ${onOff(soundOn)}<small>${share && soundOn && roomSound !== 'phone' ? ({ tv: 'Playing on the TV screen', both: 'Playing here and on the TV screen', everyone: 'Party mode: playing on every device' })[roomSound] + ' (change in Share live)' : 'Arcade effects for extra lives, knockouts and the winner'}</small></button>
          <button class="sheet-btn" data-sheet="rematch">🔁 Rematch<small>Same players, fresh lives, new random order</small></button>
          <button class="sheet-btn danger" data-sheet="newgame">New game<small>Back to the player list</small></button>
          <div class="keys">
            <span><kbd>X</kbd> Miss</span><span><kbd>Space</kbd> Made</span><span><kbd>E</kbd> Extra life</span><span><kbd>${UNDO_KEY}</kbd> Undo</span><span><kbd>T</kbd> TV mode</span>
          </div>
          <p class="sheet-note">Tip: tap any player on the board to fix their lives.</p>
        </div>`;
    }
  }

  sheet.addEventListener('close', () => { sheetMode = null; unlockPage(); });
  sheet.addEventListener('cancel', unlockPage);
  sheet.addEventListener('input', (e) => {
    if (!e.target.matches('[data-who-search]') || !sheetMode) return;
    sheetMode.q = e.target.value;
    const pos = e.target.selectionStart;
    renderSheet();
    const box = sheet.querySelector('[data-who-search]');
    if (box) { box.focus(); box.setSelectionRange(pos, pos); }
  }); // Esc closes the panel; unlock right away

  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) return closeSheet(); // backdrop
    if (e.target.closest('.share-title')) { partyTap(); return; }
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
      case 'copyLink': copyLink(shareLink(), 'link'); break;
      case 'pickMe': choosePlayer(b.dataset.name || ''); break;
      case 'someoneElse': sheetMode = { type: 'who' }; renderSheet(); break;
      case 'toggleParty':
        partyJoined = !partyJoined;
        if (partyJoined) { partyDeclined = false; unlockAudio(); sfx.extra(); }
        renderSheet();
        render();
        break;
      case 'toggleAlertSound': me.sound = !me.sound; saveMe(); renderSheet(); if (me.sound) { unlockAudio(); sfx.deck(); } break;
      case 'watchTv': goWatch($('#watchCode') ? $('#watchCode').value : '', true); break;
      case 'copyTvLink': copyLink(watchLink(share.code, true), 'tv'); break;
      case 'tvSetup': tvSetupOpen = !tvSetupOpen; renderSheet(); break;
      case 'leadLess': case 'leadMore':
        setSyncLead(syncLead + (b.dataset.sheet === 'leadMore' ? LEAD_STEP : -LEAD_STEP));
        renderSheet();
        break;
      case 'roomPhone': case 'roomTv': case 'roomBoth': case 'roomEveryone':
        roomSound = { roomPhone: 'phone', roomTv: 'tv', roomBoth: 'both', roomEveryone: 'everyone' }[b.dataset.sheet];
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

  // ---------------------------------------------------------------- synced room sound
  // With room sound on "Both", the phone and the TV play each event sound together: the phone
  // stamps it with the shared server time plus a short delay, and every device plays it at that
  // moment. A device that hears about it too late skips it rather than playing out of step.
  // (Shot clock ticks and the buzzer already line up: every device works them out from the shared clock.)
  const LEAD_KEY = 'killer.lead.v1';
  const LEAD_MIN = 100;
  const LEAD_MAX = 1500;
  const LEAD_STEP = 100;
  const SYNC_GRACE_MS = 40; // this late still sounds together to the ear
  let syncLead = (() => { try { const v = Number(localStorage.getItem(LEAD_KEY)); return v >= LEAD_MIN && v <= LEAD_MAX ? v : 500; } catch (_) { return 500; } })();
  let sfxQueue = []; // operator: recent stamped sounds, { k: kind, at: server time to play, lead: the delay used }
  const syncedSound = () => !WATCH && !!share && (roomSound === 'both' || roomSound === 'everyone');
  // Watching devices that play room sound in step with the phone: the TV on Both or Everyone,
  // and (party mode) every watching phone that joined in.
  const remoteSynced = () => WATCH && (remoteSound.target === 'everyone' || (WATCH_TV && remoteSound.target === 'both'));
  const partyOn = () => WATCH && !WATCH_TV && remoteSound.on && remoteSound.target === 'everyone';
  const partyNeedsJoin = () => partyOn() && !partyJoined && !partyDeclined;

  // Shows or hides the game length choice on the start screen.
  let modeTaps = [];
  function modeTap() {
    const now = Date.now();
    modeTaps = modeTaps.filter((t) => now - t < 3000).concat(now);
    if (modeTaps.length < 7) return;
    modeTaps = [];
    modesUnlocked = !modesUnlocked;
    try { localStorage.setItem(MODES_KEY, modesUnlocked ? 'on' : 'off'); } catch (_) { /* ignore */ }
    if (!modesUnlocked) S.startLives = START_LIVES;
    save();
    render();
    toast(modesUnlocked ? '⚡ Blitz unlocked' : 'Blitz hidden');
  }

  // Shows or hides the party mode option.
  let partyTaps = [];
  function partyTap() {
    const now = Date.now();
    partyTaps = partyTaps.filter((t) => now - t < 3000).concat(now);
    if (partyTaps.length < 7) return;
    partyTaps = [];
    partyUnlocked = !partyUnlocked;
    try { localStorage.setItem(PARTY_KEY, partyUnlocked ? 'on' : 'off'); } catch (_) { /* ignore */ }
    if (partyUnlocked) tvSetupOpen = true; // show where the new option lives
    else if (roomSound === 'everyone') {
      roomSound = 'both';
      try { localStorage.setItem(ROOM_KEY, roomSound); } catch (_) { /* ignore */ }
      queuePublish();
    }
    toast(partyUnlocked ? '🎉 Party mode unlocked' : 'Party mode hidden');
    renderSheet();
  }

  function setSyncLead(ms) {
    syncLead = Math.min(LEAD_MAX, Math.max(LEAD_MIN, ms));
    try { localStorage.setItem(LEAD_KEY, String(syncLead)); } catch (_) { /* ignore */ }
  }

  // Operator: an event sound (out, extra, win). Plays now, or when synced, at the stamped moment.
  function roomSfx(kind) {
    if (!syncedSound()) { sfx[kind](); return; }
    const at = Date.now() + serverOffset() + syncLead;
    sfxQueue = sfxQueue.filter((e) => e.at > at - 10000).slice(-4).concat({ k: kind, at, lead: syncLead });
    clearTimeout(publishTimer); // send it now, not after the usual short batching wait
    publishNow();
    setTimeout(() => sfx[kind](), syncLead);
  }

  // TV display: play each new stamped sound on time. The readout keeps score for the sync test:
  // each sound's trip (phone to TV) doesn't depend on the delay setting, and the slowest trip
  // is the shortest delay that never skips.
  let lastSfxAt = null; // newest stamp already handled (null until the first update)
  let syncStats = { played: 0, skipped: 0, trip: null, slowest: null, lead: null };
  function scheduleRemoteSfx(list) {
    const newest = list.reduce((m, e) => Math.max(m, e.at || 0), 0);
    if (lastSfxAt === null) { lastSfxAt = newest; return; } // joining: don't replay old sounds
    const fresh = list.filter((e) => e.at > lastSfxAt && typeof sfx[e.k] === 'function').sort((a, b) => a.at - b.at);
    lastSfxAt = Math.max(lastSfxAt, newest);
    const off = serverOffset();
    for (const e of fresh) {
      const spare = Math.round(e.at - off - Date.now()); // how early it arrived, in ms
      if (e.lead) {
        const trip = e.lead - spare;
        syncStats.trip = trip;
        syncStats.slowest = syncStats.slowest === null ? trip : Math.max(syncStats.slowest, trip);
        syncStats.lead = e.lead;
      }
      if (spare < -SYNC_GRACE_MS) { syncStats.skipped++; continue; }
      syncStats.played++;
      setTimeout(() => sfx[e.k](), Math.max(0, spare));
    }
  }
  function syncReadout() {
    if (!WATCH_TV || !remoteSynced()) return '';
    const { played, skipped, trip, slowest, lead } = syncStats;
    const ms = (v) => (v === null ? '–' : `${v} ms`);
    return `<div class="sync-readout" aria-hidden="true">Sync test · ${played} played · ${skipped} skipped · trip ${ms(trip)} · slowest ${ms(slowest)} · delay ${lead === null ? '–' : (lead / 1000).toFixed(1) + ' s'}</div>`;
  }

  // Room sound plays on the operator's phone, the TV display, or both. Viewers' phones never
  // play it; the TV display does only when the operator sends sound there (and someone has
  // clicked to allow it).
  function soundHere() {
    if (WATCH) {
      if (!remoteSound.on) return false;
      if (WATCH_TV) return tvSoundEnabled && tvGetsSound(remoteSound.target);
      return remoteSound.target === 'everyone' && partyJoined; // party mode, and they joined in
    }
    return soundOn && !(share && roomSound === 'tv');
  }
  const tvNeedsSoundClick = () => WATCH_TV && remoteSound.on && tvGetsSound(remoteSound.target)
    && !(tvSoundEnabled && actx && actx.state === 'running');

  // Browsers only allow audio after a tap, which every sound here follows.
  // Personal turn alerts on a viewer's own phone (on by default, can be switched off).
  const personalSound = () => following() && me.sound;

  function audio(personal = false) {
    if (!(personal ? personalSound() : soundHere())) return null;
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
    if (!soundHere() && !personalSound()) return;
    const ac = audio(soundHere() ? false : true);
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
    // Viewer's own phone: you're on deck (next). A friendly two-note ding.
    deck() {
      const ac = audio(true);
      if (!ac) return;
      note(ac, { f: 1175, d: 0.16, type: 'triangle', vol: 0.18 });
      note(ac, { f: 1568, t: 0.16, d: 0.4, type: 'triangle', vol: 0.18 });
    },
    // Viewer's own phone: you're up. A bright rising call, repeated once.
    up() {
      const ac = audio(true);
      if (!ac) return;
      [0, 0.7].forEach((t0) => [1047, 1319, 1568, 2093].forEach((f, i) => note(ac, { f, t: t0 + i * 0.09, d: 0.12, type: 'square', vol: 0.12, hold: true, lowpass: 5000 })));
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

  const WATCH_ALLOWED = ['recap', 'recapBack', 'tabAwards', 'tabStandings', 'tv', 'muteFanfare', 'enableSound', 'leaveWatch', 'whoami', 'dismissDeck', 'dismissUp', 'joinParty', 'declineParty', 'shareResults'];

  app.addEventListener('click', (e) => {
    if (!WATCH && e.target.closest('.setup .wordmark')) { modeTap(); return; }
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
      case 'mode': S.startLives = Number(t.dataset.n); save(); render(); break;
      case 'undo': undo(); break;
      case 'muteFanfare': sfx.stop(); t.remove(); break;
      case 'rerackTop': rerack(); toast(`🎱 Re-rack · ${current() ? current().name : ''} breaks`); break;
      case 'enableSound': tvSoundEnabled = true; unlockAudio(); sfx.extra(); render(); break;
      case 'watchEntry': openSheet({ type: 'watch' }); break;
      case 'whoami': openSheet({ type: 'who' }); break;
      case 'joinParty': partyJoined = true; unlockAudio(); sfx.extra(); render(); break;
      case 'declineParty': partyDeclined = true; render(); break;
      case 'dismissDeck': dismissed.deck = turnKey(); render(); break;
      case 'dismissUp': dismissed.up = turnKey(); render(); break;
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
      case 'shareResults': shareResults(t); break;
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
    rest.sfx = syncedSound() ? sfxQueue : [];
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

  // The Copy button itself says "✓ Copied" for a moment (a toast would sit behind the open panel).
  // Pages that can't use the clipboard API (like the local test server) copy through a hidden
  // text box instead; if even that fails, the link pops up to copy by hand.
  let copied = null; // which Copy button just worked: 'link' or 'tv'
  function copyLink(link, key) {
    const done = () => {
      copied = key;
      const b = sheet.querySelector(`[data-sheet="${key === 'tv' ? 'copyTvLink' : 'copyLink'}"]`);
      if (b) { b.textContent = '✓ Copied'; b.classList.add('copied'); }
      clearTimeout(copyLink.timer);
      copyLink.timer = setTimeout(() => { copied = null; if (sheet.open) renderSheet(); }, 1600);
    };
    const fallback = () => (copyWithSelection(link) ? done() : window.prompt('Copy this link:', link));
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, fallback);
    else fallback();
  }

  function copyWithSelection(text) {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    (sheet.open ? sheet : document.body).appendChild(box); // inside the open panel, so it can take the selection
    box.select();
    box.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* not supported */ }
    box.remove();
    return ok;
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
      if (S.phase === 'playing' && !remoteSynced()) sfx.out();
    } else if (lastShot.a === 'miss') {
      showResult(p.id, 'miss', 950);
    } else if (lastShot.a === 'extra' && lastShot.late) {
      showResult(p.id, 'extra', 1500, (S.last && S.last.bonus) || 1);
      if (!remoteSynced()) sfx.extra();
    } else if (lastShot.a === 'made') {
      const extras = added.filter((e) => e.a === 'extra' && !e.late && e.p === p.id).length;
      if (extras) { showResult(p.id, 'extra', 1500, extras); if (!remoteSynced()) sfx.extra(); }
      else showResult(p.id, 'safe', 750);
    }
  }

  function applyRemote(state) {
    const wasLive = remote.status === 'live';
    const prevLog = S.log || [];
    const { clock, room, sfx: stamped, ...game } = state;
    S = { ...freshState(), ...game, tv: S.tv };
    applyRemoteClock(clock);
    remoteSound = room ? { on: !!room.sound, target: roomTarget(room.target) } : { on: false, target: 'phone' };
    scheduleRemoteSfx(Array.isArray(stamped) ? stamped : []);
    remote.status = 'live';
    if (!Array.isArray(S.log)) S.log = [];
    if (S.log.length < prevLog.length) clearResult(false); // the scorekeeper pressed Undo
    else if (wasLive) stampFromRemote(S.log.slice(prevLog.length));
    render();
    // First time in this game: ask which player they are (skipped on the TV display).
    if (!WATCH_TV && !askedWho && !(WATCH in me.codes) && S.players.length && !sheet.open) {
      askedWho = true;
      openSheet({ type: rememberedPlayer() ? 'still' : 'who' });
    }
    checkMyTurn();
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

  // ---------------------------------------------------------------- updates

  // Home Screen apps can keep running an old copy for a long time. Ask the site for the
  // latest version (skipping the cache) and reload onto it when it's safe to. The saved
  // game lives in browser storage, so it's unaffected.
  let pendingVersion = null;

  async function checkForUpdate() {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { version } = await res.json();
      if (!version || version === APP_VERSION) return;
      // Don't loop if a reload already tried this version and the site still served an old copy.
      try { if (sessionStorage.getItem('killer.updateTried') === version) return; } catch (_) { /* ignore */ }
      pendingVersion = version;
      applyUpdateWhenIdle();
    } catch (_) { /* offline: try again later */ }
  }

  function applyUpdateWhenIdle() {
    if (!pendingVersion) return;
    const busy = fb || fanfare || sheet.open || dragId || shuffling;
    if (busy) { setTimeout(applyUpdateWhenIdle, 3000); return; }
    try { sessionStorage.setItem('killer.updateTried', pendingVersion); } catch (_) { /* ignore */ }
    const url = new URL(location.href);
    url.searchParams.set('v', pendingVersion); // a new address, so the page and its files are fetched fresh
    location.replace(url.toString());
  }

  setTimeout(checkForUpdate, 2000);
  setInterval(checkForUpdate, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });

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
