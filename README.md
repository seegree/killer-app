# Killer — pool scorekeeper

A mobile-first web app for scoring Killer. Everyone starts with 3 lives, and the last one standing wins.

## Run it
- **Laptop:** double-click `index.html`, or serve the folder with
  `python3 -m http.server 5178` and open http://localhost:5178.
- **Phone:** host the folder on any static host (GitHub Pages, Netlify Drop, etc.), open the link, then choose **Add to Home Screen** so it runs full-screen like an app.

There's no build step and no dependencies. The game auto-saves in the browser, so a refresh or the screen locking won't lose it.

## How it works
- **Setup:** add names (paste a whole list if you like), press 🎲 **Shuffle**, drag ☰ to adjust the order, then **Rack 'em**.
- **Each shot:** **Miss** takes a life and passes the turn. **Made** is safe and passes the turn. **+1 Extra life** gives a life per extra ball and keeps the turn, so tap it once or twice, then **Made**.
- **Marks:** 1 lost is `/`, 2 lost is `X`, and 3 lost is a circled X meaning OUT. Lives above 3 show as gold `+N` chips.
- **Fix mistakes:** use **Undo** (it goes back any number of steps), or tap any player to set their lives, make them the shooter, or remove them.
- **Menu:** add a late player, TV mode, rematch, or start a new game.
- **Keyboard:** `M` miss · `Space` made · `E` extra life · `Z` undo · `T` TV mode.

## Logo and artwork
- **`logo.svg`** is the simple mark. The home-screen icons, the browser tab and the in-game top bar use it. It should be a square SVG with a transparent background that still reads at 28px. After changing it, run `./make-icons.sh` to rebuild `apple-touch-icon.png`, `icon-192.png` and `icon-512.png`.
- **`scene.svg`** (optional) is the full illustration, shown on the start screen and the winner screen. Any aspect ratio works, but keep the background transparent. If the file is missing, those screens show `logo.svg` instead.

Commit and push to update the live site.
