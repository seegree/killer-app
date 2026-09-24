// Live sharing bridge: sends the scorekeeper's game to Firebase and streams it to watchers.
// Loaded as a module next to app.js; app.js talks to it through window.killerLive.
// Firebase web settings are public by design; the database rules decide who may write.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getDatabase, ref, set, remove, onValue, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';

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

window.killerLive = {
  // The state is stored as one JSON string: simpler than mapping it onto Firebase's key rules.
  async publish(code, state) {
    const owner = await uid();
    await set(gameRef(code), { owner, updated: serverTimestamp(), state: JSON.stringify(state) });
  },

  async stop(code) {
    await uid();
    await remove(gameRef(code));
  },

  // Calls onState(state) on every change; onMissing() if the game doesn't exist (or can't be read).
  watch(code, onState, onMissing) {
    return onValue(
      gameRef(code),
      (snap) => {
        const v = snap.val();
        if (!v || typeof v.state !== 'string') return onMissing();
        try { onState(JSON.parse(v.state)); } catch (_) { onMissing(); }
      },
      () => onMissing(),
    );
  },
};

window.dispatchEvent(new Event('killer:live-ready'));
