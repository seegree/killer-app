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
  const tvOn = () => !!S.tv && S.phase === 'playing' && canTV();
  const UNDO_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘Z' : 'Ctrl+Z';

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

  function freshState() {
    return { phase: 'setup', roster: [], players: [], current: 0, turnBonus: 0, outOrder: [], last: null, winner: null, tv: false };
  }

  function load() {
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
    try { localStorage.setItem(GAME_KEY, JSON.stringify({ state: S, history })); } catch (_) { /* storage unavailable */ }
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
  function snapshot() {
    const { tv, ...rest } = S;
    return JSON.stringify(rest);
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
    sfx.stop();
    const tv = S.tv;
    S = { ...JSON.parse(history.pop()), tv };
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

  function upcoming(count) {
    const list = [];
    let i = S.current;
    for (let k = 0; k < count; k++) {
      i = nextAliveIndex(i);
      if (i < 0 || i === S.current) break;
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

  function actMiss() {
    const p = current();
    if (S.phase !== 'playing' || !p) return;
    let wentOut = false;
    commit(() => {
      p.shots++;
      p.misses++;
      p.lives--;
      S.last = { type: 'miss', id: p.id, name: p.name, lives: p.lives, bonus: S.turnBonus };
      if (p.lives <= 0) { wentOut = true; markOut(p); }
      if (!checkFinish()) advance();
    });
    if (wentOut) {
      buzz([60, 40, 140]);
      if (S.phase === 'playing') { flashOut(p.name); sfx.out(); }
    } else {
      buzz(40);
    }
  }

  function actMade() {
    const p = current();
    if (S.phase !== 'playing' || !p) return;
    commit(() => {
      p.shots++;
      p.pots++;
      S.last = { type: 'made', id: p.id, name: p.name, lives: p.lives, bonus: S.turnBonus };
      advance();
    });
    buzz(12);
  }

  // Doesn't end the turn: tap once per extra ball, then Made/Safe to move on.
  function actExtra() {
    const p = current();
    if (S.phase !== 'playing' || !p) return;
    commit(() => {
      p.lives++;
      p.extras++;
      S.turnBonus++;
      S.last = { type: 'extra', id: p.id, name: p.name, lives: p.lives, bonus: S.turnBonus };
    });
    buzz(20);
    sfx.extra();
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
    const p = current();
    if (S.turnBonus > 0 && p) {
      return `<b>${esc(p.name)}</b> earned <span class="t-gold">+${S.turnBonus}</span> · tap <em>Made</em> to end turn`;
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
      default: return '';
    }
  }

  // ---------------------------------------------------------------- screens

  function render() {
    document.body.classList.toggle('tv', tvOn());
    document.body.classList.toggle('win', S.phase === 'finished');
    const justWon = S.phase === 'finished' && lastPhase === 'playing';
    if (justWon) sfx.win();
    if (S.phase === 'setup') renderSetup();
    else if (S.phase === 'playing') renderGame();
    else renderWinner();

    if (S.phase !== 'playing') flash.classList.remove('show');
    if (justWon) confetti();
    lastPhase = S.phase;

    S.players.forEach((p) => prevLives.set(p.id, p.lives));
    if (sheet.open) renderSheet();
    updateWakeLock();
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
          <button class="btn btn-start" data-do="start" ${r.length < 2 ? 'disabled' : ''}>
            ${r.length < 2 ? 'Add at least 2 players' : `Rack ’em · ${r.length} players`}
          </button>
        </div>
      </section>`;

    if (hadFocus) $('#nameInput').focus();
  }

  function renderGame() {
    const p = current();
    const alive = aliveCount();
    const next = upcoming(2);
    const nextId = next[0] && next[0].id;
    const entering = p.id !== prevCurrentId;
    prevCurrentId = p.id;

    const outRank = (x) => S.outOrder.indexOf(x.id);
    const board = S.players.filter(isAlive)
      .concat(S.players.filter((x) => !isAlive(x)).sort((a, b) => outRank(a) - outRank(b)));

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
          <div class="pill"><b>${alive}</b> of ${S.players.length} alive</div>
          ${tvOn()
            ? '<button class="btn btn-ghost btn-sm" data-do="tv">Exit TV</button>'
            : '<button class="icon-btn" data-do="menu" aria-label="Menu"><span class="burger"><i></i><i></i><i></i></span></button>'}
        </header>

        <div class="stage">
          <div class="left">
            <section class="now${entering ? ' enter' : ''}" aria-live="polite">
              <div class="now-felt">
                <div class="now-label">Now shooting</div>
                <div class="now-name" style="--fit:${fit(p.name)}">${esc(p.name)}</div>
                <div class="now-status">${marks(p, 'lg')}<span class="now-lives${p.lives === 1 ? ' last' : ''}">${p.lives === 1 ? 'Last life' : `${p.lives} lives left`}</span></div>
                <div class="now-next">${nextLine}</div>
              </div>
            </section>

            <section class="controls">
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
                  <span class="act-glyph">+1</span><span class="act-label">Extra life</span><span class="act-sub">per extra ball</span><kbd>E</kbd>
                  ${S.turnBonus ? `<span class="badge">+${S.turnBonus}</span>` : ''}
                </button>
              </div>
            </section>
          </div>

          <section class="board" aria-label="Scoreboard">
            <div class="board-grid">${cards}</div>
          </section>
        </div>

        ${tvOn() ? `<footer class="tv-keys"><span><kbd>X</kbd> Miss</span><span><kbd>Space</kbd> Made</span><span><kbd>E</kbd> Extra life</span><span><kbd>${UNDO_KEY}</kbd> Undo</span><span><kbd>T</kbd> Exit TV</span></footer>` : ''}
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
            <div class="win-actions">
              <button class="btn btn-ghost" data-do="undo" ${history.length ? '' : 'disabled'}>↶ Undo last shot</button>
              <button class="btn btn-start" data-do="rematch">Rematch</button>
              <button class="btn btn-ghost" data-do="newgame">New game</button>
            </div>
          </div>
        </div>
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

  function renderSheet() {
    if (!sheetMode) return closeSheet();

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
          <div class="sound-row">
            <button class="sheet-btn" data-sheet="sound">${soundOn ? '🔊 Sound on' : '🔇 Sound off'}<small>Arcade effects for extra lives, knockouts and the winner</small></button>
            ${soundOn ? `<div class="sound-previews" aria-label="Preview sounds">
              <button class="chip-btn" data-sheet="hear" data-sfx="extra">▶ Extra life</button>
              <button class="chip-btn" data-sheet="hear" data-sfx="out">▶ Knocked out</button>
              <button class="chip-btn" data-sheet="hear" data-sfx="win">▶ Winner</button>
            </div>` : ''}
          </div>
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
      case 'hear': sfx[b.dataset.sfx](); break;
      case 'rematch': if (confirmTap(b, 'rematch')) { closeSheet(); rematch(); } break;
      case 'newgame': if (confirmTap(b, 'newgame')) { closeSheet(); newGame(); } break;
    }
  });

  // ---------------------------------------------------------------- sound
  // Retro arcade effects synthesized with Web Audio — no audio files.
  const SOUND_KEY = 'killer.sound.v1';
  let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch (_) { return true; } })();
  let actx = null;
  let master = null;

  function setSound(on) {
    soundOn = on;
    try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (_) { /* ignore */ }
  }

  // Browsers only allow audio after a tap, which every sound here follows.
  function audio() {
    if (!soundOn) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!actx) {
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.55;
      const limiter = actx.createDynamicsCompressor();
      master.connect(limiter);
      limiter.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

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

  app.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;

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
      case 'menu': openSheet({ type: 'menu' }); break;
      case 'tv': toggleTV(); break;
      case 'rematch': rematch(); break;
      case 'newgame': newGame(); break;
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
  });

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

    if (S.phase === 'playing') {
      if (k === 'x' || k === 'arrowleft') actMiss();
      else if (k === ' ' || k === 'arrowright' || k === 'enter') actMade();
      else if (k === 'e' || k === 'arrowup' || k === '+' || k === '=') actExtra();
      else if (canTV() && (k === 't' || (k === 'escape' && S.tv))) toggleTV();
      else return;
      e.preventDefault();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && S.tv && S.phase === 'playing') { S.tv = false; save(); render(); }
  });

  render();
})();
