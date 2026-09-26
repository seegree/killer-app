// Live sharing bridge: sends the scorekeeper's game to Firebase and streams it to watchers.
// Loaded as a module next to app.js; app.js talks to it through window.killerLive.
// Firebase web settings are public by design; the database rules decide who may write.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getDatabase, ref, set, get, remove, onValue, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';

const firebaseApp = initializeApp({
  apiKey: 'AIzaSyA-qlfDzz8rTKS6tKBIGlFn68hoc2Kn60Q',
  authDomain: 'killer-596b6.firebaseapp.com',
  databaseURL: 'https://killer-596b6-default-rtdb.firebaseio.com',
  projectId: 'killer-596b6',
  storageBucket: 'killer-596b6.firebasestorage.app',
  messagingSenderId: '872157491766',
  appId: '1:872157491766:web:89587c4ffb01f48982de97',
});
const auth = getAuth(firebaseApp);
const db = getDatabase(firebaseApp);

// The scorekeeper's phone gets an invisible anonymous ID; only that ID may write its game.
async function uid() {
  if (auth.currentUser) return auth.currentUser.uid;
  const cred = await signInAnonymously(auth);
  return cred.user.uid;
}

const gameRef = (code) => ref(db, `games/${code}`);

// How far this device's clock is from Firebase's, so shot clocks line up on every screen.
let offset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => { offset = snap.val() || 0; });

// Whether this device can reach Firebase right now (writes wait quietly while it can't).
let connected = false;
const connectionWatchers = new Set();
onValue(ref(db, '.info/connected'), (snap) => {
  connected = !!snap.val();
  connectionWatchers.forEach((f) => f(connected));
});

window.killerLive = {
  serverOffset: () => offset,
  onConnected(f) { connectionWatchers.add(f); f(connected); },
  myId: () => (auth.currentUser ? auth.currentUser.uid : null),

  // The state is stored as one JSON string: simpler than mapping it onto Firebase's key rules.
  // `alive` is the scorekeeper's "still here" time. After a takeover, every update carries `scorer`
  // ({ name, id }) so the room and the old scorekeeper's phone know who is scoring now. Only the
  // takeover itself carries `claim`, the one thing the database rules accept from a new device.
  async publish(code, state, scorer, takeover = false) {
    const owner = await uid();
    const rec = { owner, updated: serverTimestamp(), alive: serverTimestamp(), state: JSON.stringify(state) };
    if (scorer) rec.scorer = { name: scorer.name || '', id: scorer.id, at: serverTimestamp() };
    if (takeover) rec.claim = true;
    await set(gameRef(code), rec);
  },

  // The scorekeeper's app, every few seconds while it's actually running.
  async beat(code) {
    await uid();
    await set(ref(db, `games/${code}/alive`), serverTimestamp());
  },

  // The latest copy of a game, straight from the server (for taking over scoring).
  async fetch(code) {
    const v = (await get(gameRef(code))).val();
    if (!v || typeof v.state !== 'string') return null;
    return { ...v, state: JSON.parse(v.state) };
  },

  async stop(code) {
    await uid();
    await remove(gameRef(code));
  },

  // Calls onMeta({ alive, scorer }) on every change, onState(state) when the game itself changed
  // (not on the scorekeeper's heartbeats), and onMissing() if the game doesn't exist or can't be read.
  watch(code, onState, onMissing, onMeta = () => {}) {
    let last = null;
    return onValue(
      gameRef(code),
      (snap) => {
        const v = snap.val();
        if (!v || typeof v.state !== 'string') return onMissing();
        onMeta({ alive: v.alive || 0, scorer: v.scorer || null });
        if (v.state === last) return;
        last = v.state;
        try { onState(JSON.parse(v.state)); } catch (_) { onMissing(); }
      },
      () => onMissing(),
    );
  },
};

window.dispatchEvent(new Event('killer:live-ready'));
