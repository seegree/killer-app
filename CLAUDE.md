# Killer: working notes for Claude sessions

Killer is a scorekeeper for a pool game, built in plain HTML, CSS and JavaScript with no build step. It's hosted on GitHub Pages at https://seegree.github.io/killer-app/ and served straight from `main`.

## Before you change anything
- Run `git pull` first. Work happens both on the owner's Mac and in cloud sessions, so `main` may have moved.

## Workflow
- Commit and push only when the owner asks (for example "push" or "ship it"). They review changes on their phone first.
- Build big features on a branch, and merge into `main` only once the owner approves.
- Before every push to `main`, run `./bump-version.sh`. It sets the version in `version.json`, in `APP_VERSION` in `app.js` and in the `?v=` links in `index.html`, which is how open phones pick up the update. Never edit these by hand.
- Before pushing, run `git fetch`. If `origin/main` moved, merge it in first.

## Files
- `index.html`, `app.js` (the app), `styles.css` and `live.js` (the Firebase bridge for live sharing).
- `README.md` is user-facing. Keep it accurate when behaviour changes.
- The ignore rules live in `.git/info/exclude` (git's local-only ignore file), not in a published `.gitignore`, so the owner's private folder names stay off GitHub. Don't add a `.gitignore`, and never commit personal or planning files.

## Firebase (live sharing)
- Data lives under `games/$code` (the scorekeeper's game) and `watchers/$code/$uid` (who's watching).
- The database rules are pasted into the Firebase console by the owner. You can't change them. If a feature needs new rules, write out the complete rules text for the owner to paste, and don't test the feature as if the rules were already live.

## Testing
- Serve the folder with a no-cache server (for example on port 5179), or browsers will run stale files.
- Check phone sizes (375×812, 360, 320), sideways phones (874×402, 667×300), a laptop (1440×900) and TVs (1920×1080, 1280×720).
- Check each role:
  - The scorekeeper.
  - A watcher (`?watch=CODE`).
  - The TV display (`?watch=CODE&tv`).
  - A one-tap takeover (`?watch=CODE&operator`).
- Tabs on the same origin share one Firebase identity. To act as separate devices, use separate origins (`localhost`, `127.0.0.1`, `0.0.0.0`).

## Public repo
- Everything committed is public, including commit messages and code comments. Some features are deliberately hidden. Never describe how they are unlocked in commits, comments or docs.
- Write user-facing text plainly, and match the surrounding code's style and comment density.
