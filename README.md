# Killer — pool scorekeeper

A mobile-first web app for scoring Killer. Everyone starts with 3 lives, and the last one standing wins.

## Run it
- **Laptop:** double-click `index.html`, or serve the folder with
  `python3 -m http.server 5178` and open http://localhost:5178.
- **Phone:** host the folder on any static host (GitHub Pages, Netlify Drop, etc.), open the link, then choose **Add to Home Screen** so it runs full-screen like an app.

There's no build step and no dependencies. The game auto-saves in the browser, so a refresh or the screen locking won't lose it.

## How it works
- **Setup:** add names (paste a whole list if you like; a name that's already on the list is flagged so you can add a last initial), press 🎲 **Shuffle**, drag ☰ to adjust the order, then **Rack 'em**.
- **Each shot:** **Miss** takes a life and passes the turn. **Made** is safe and passes the turn. **+1 Extra life** is a made shot that sank 2 balls: it adds a life and passes the turn. For 3 or 4 balls, tap it again quickly while the board still shows the shooter (up to 3 taps).
- **Marks:** 1 lost is `/`, 2 lost is `X`, and 3 lost is a circled X meaning OUT. Lives above 3 show as gold `+N` chips.
- **Shot clock (optional):** switch it on above **Rack 'em** and set the seconds (default 30). Breaks aren't timed (the opening break, or the break after a re-rack); otherwise it starts when each new shooter's name appears, turns red for the last 5 seconds, and sounds a buzzer with **TIME!** at zero. It never scores anything. Tap the clock to pause it; tap again to resume. While paused you can **Re-rack** (records who breaks; their break isn't timed) or put the clock **back to** the full time.
- **Fix mistakes:** use **Undo** (it goes back any number of steps), or tap any player to set their lives, make them the shooter, or remove them.
- **Menu:** add a late player, re-rack, shot clock, TV mode (laptops and desktops only), sound, rematch, or start a new game.
- **Keyboard:** `X` miss · `Space` made · `E` extra life · `⌘Z` / `Ctrl+Z` undo · `T` TV mode · `P` pause/resume clock · `R` clock back to full time · `B` re-rack.

## Logo and artwork
All artwork is flat SVG, with text converted to outlines.
- **`logo.svg`** is the dead-head mark. It's used in the in-game top bar and the browser tab.
- **`icon-tile.svg`** is the dead head on a dark tile. It's the source for the home-screen icons: run `./make-icons.sh` after changing it to rebuild `apple-touch-icon.png`, `icon-192.png` and `icon-512.png`.
- **`wordmark.svg`** is the dead head next to KILLER. It's the start-screen header.
- **`poster.svg`** is the full scene. It appears on the winner screen, with the page background set to ink `#07100c` so it blends in.

The design session's alternates are in `logo-alternatives/`, which is kept locally and not published.

## Releasing
1. Run `./bump-version.sh`. It sets a new version in `version.json`, `app.js` and the file links in `index.html`.
2. Commit and push. GitHub Pages rebuilds in about a minute.

Open copies of the app (including Home Screen apps) check `version.json` when opened, when brought back to the front, and every 10 minutes. They reload onto the new version as soon as they're not mid-animation or showing a panel. Saved games are unaffected.
