# Killer — pool scorekeeper

A mobile-first web app for scoring Killer. Everyone starts with 3 lives, and the last one standing wins.

## Run it
- **Laptop:** double-click `index.html`, or serve the folder with
  `python3 -m http.server 5178` and open http://localhost:5178.
- **Phone:** host the folder on any static host (GitHub Pages, Netlify Drop, etc.), open the link, then choose **Add to Home Screen** so it runs full-screen like an app.

There's no build step and no dependencies. The game auto-saves in the browser, so a refresh or the screen locking won't lose it.

## How it works
- **Setup:** add names (paste a whole list if you like; a name that's already on the list is flagged so you can add a last initial), press 🎲 **Shuffle**, drag ☰ to adjust the order, then **Rack 'em**.
- **Game length:** choose **Classic** (3 lives), **Blitz** (2) or **Sudden death** (1) above **Rack 'em**. Games grow with the number of players, so as the list grows past 20 the app picks Blitz with a 25-second shot clock, and past 30 Sudden death with a 20-second clock. Removing players never switches it back, splitting the list re-picks for the table size, and once you set the game length or clock yourself the app leaves them alone. A line above **Rack 'em** estimates how long the game will take.
- **Two tables:** from 16 players, ✂️ **Split** shuffles the list into Table 1 (scored on this phone) and Table 2. Drag names between tables, and use Table 2's **📤 Send list** to hand its list to the other scorekeeper. When a table is down to its last few, **📤 Send finalists** in the menu shares everyone still in with their lives, like `Pete [3], Fiona [1]`. The other table pastes that into **Add a late player**, and each finalist joins with those lives. Only square brackets set lives, so a player named "Dan 2" keeps their name.
- **How to play:** the rules are on the start screen, in the menu, and in the name picker for watchers. A watcher sees them once, after picking their name.
- **Each shot:** **Miss** takes a life and passes the turn. **Made** is safe and passes the turn. **+1 Extra life** is a made shot that sank 2 balls: it adds a life and passes the turn. For 3 or 4 balls, tap it again quickly while the board still shows the shooter (up to 3 taps).
- **Marks:** 1 lost is `/`, 2 lost is `X`, and 3 lost is a circled X meaning OUT. Lives above 3 show as gold `+N` chips.
- **Shot clock (optional):** switch it on above **Rack 'em** and set the seconds (default 30). Breaks aren't timed (the opening break, or the break after a re-rack). If nothing goes in on the break, tap **Dry break** (or press `D`): the breaker shoots again, and that shot is timed. Otherwise it starts when each new shooter's name appears, turns red for the last 5 seconds, and sounds a buzzer with **TIME!** at zero. It never scores anything. Tap the clock to pause it; tap again to resume. While paused you can **Re-rack** (records who breaks; their break isn't timed) or put the clock **back to** the full time.
- **Fix mistakes:** use **Undo** (it goes back any number of steps), or tap any player to set their lives, make them the shooter, or remove them.
- **Top bar:** 🎱 re-racks (it records who breaks, so the break isn't timed and Dry break shows). The app also counts balls down (one per made shot, one more per extra life), and once all 15 are down the status line offers **🎱 New rack?** for a one-tap re-rack. On laptops and desktops there's also **Big board**: the whole game, big, driven by the keyboard.
- **Menu:** add a late player, Share live, shot clock, sound, Send finalists (once 5 or fewer are left), watch another game (your own game stays live while you look), rematch, or start a new game. How to play is at the bottom.
- **Keyboard:** `X` miss · `Space` made · `E` extra life · `⌘Z` / `Ctrl+Z` undo · `T` big board · `P` pause/resume clock · `R` clock back to full time · `B` re-rack · `D` dry break.

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
