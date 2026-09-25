# Ideas

Feature requests from pool nights, parked until we decide to build them.

## Shot clock ⭐ (favourite) — shipped
*Requested at the first live game (27 players), September 2026.*

An optional timer to keep the game moving.
- Turned on when setting up a game, with a default of **30 seconds** that can be changed.
- Starts counting when a player comes up to shoot, and resets on every Miss, Made or Extra life.
- When time runs out: a buzzer sound and a big "TIME!" on the chalkboard. It doesn't score anything automatically; the group decides what happens.
- Needs to be easy to read across the room: a draining bar or countdown on the chalkboard, turning red for the last few seconds.
- Decided: never scores automatically. Undo resets the clock. Tap the clock to **pause** (for a re-rack) or **restart** it.
- Starts automatically when the next name appears on the chalkboard.
- Bonus: log each re-rack pause to feed a new Recap award, **"Dems da Breaks"**, for the player who broke the most racks (minimum 2).

## Live watch page 🚧 (in progress on the `live-share` branch)
*Planned September 2026.*

A read-only live copy of the current game that anyone can open, on their own phone or on the TV.
- **Scorekeeper:** a **📡 Share live** menu item creates a short random game code and shows a QR code and link (`…/killer-app/?watch=CODE`). It's opt-in: nothing changes unless someone shares, and scoring keeps working if the relay is unreachable.
- **Viewers:** a read-only board with the chalkboard (now shooting / next / then), the list in turn order, "left · out", the last action and the shot clock. No controls. At the end they see the winner and the Recap awards.
- **TV:** open the watch link on the laptop in TV mode. It's a pure display, and the scorekeeper runs the game from their phone, so no keyboard is needed.
- **Relay:** Firebase Realtime Database (free tier, up to 100 viewers at once). The app stays on GitHub Pages; only game updates go through Firebase. Only the phone that started sharing can write to a game; old games are cleaned up.
- **Roles:** operator (runs the game), viewers (the everyone link: view-only and always silent), and the TV display (a separate `&tv` link, on a laptop, tablet or sideways phone, with the only room sound when the operator chooses "Room sound plays on: TV screen").
- **Done on the branch:** sharing and the watch page; the shot clock synced to server time; the TV link with big-screen and sideways-phone layouts; room sound routing; QR codes on the Share screen and a join QR on the TV.
- **Still to do:** optional "follow me" alerts when you're next (a sound and screen flash; vibration on Android only).

## "Everyone" room sound: party mode 🎉 (built, a hidden extra)
*Suggested September 2026, while building live sharing.*

**Built September 2026.** Room sound gained **Both** (phone + TV) and, once unlocked, **Everyone**. Event sounds are stamped with the shared server time plus a sync delay (default 0.5 s, adjustable in Share live) and play together everywhere; late arrivals are skipped. Watchers join with one tap. The TV shows a sync-test readout (trip times) on Both/Everyone. First home-wifi test: trips 77–141 ms, 21 played, 0 skipped, “pretty tight”.

*The original plan:*

A third choice in Share live: **Room sound plays on: This phone | TV screen | Everyone**. Every phone watching the game plays the sounds together, as a fun "nuclear option" to get the room's attention.
- **Sync, not cacophony:** every screen already shares Firebase's clock. Shot clock ticks and the buzzer are calculated from it, so they'd already play together. For events (knockout, coin, William Tell fanfare), the operator stamps each one with the server time, and every device (operator, TV and phones) plays it about 1 second later, all at once. A device that receives it too late skips the sound rather than playing out of step.
- **Opt-in per phone:** browsers require one tap before a page can play sound, so viewers see a "🔊 Join the room sound" banner, plus a way to turn it off again.
- **Limits:** iPhones with the silent switch on stay silent. Sync should be within a few hundredths of a second.
- **Bonus:** the TV screen mode could use the same scheduling, so the TV plays exactly in time too.

## Operator's phone in landscape (built)
*Noted September 2026.*

The operator's view is designed for a phone held upright. Turned sideways it works, but it scrolls a lot. A landscape layout could put the chalkboard on the left and the buttons on the right. (A display phone turned sideways already has its own layout via the TV link.)

## Buzz players' phones when it's their turn (parked)
*Requested at the first live game.*

Each player enters a phone number and gets a text or buzz when they're next, or two away.
- Parked because it needs a server, phone numbers, a texting service with running costs, and privacy handling. That's a big step away from the app's no-setup simplicity.
- A lighter version to consider later: players open the same link on their own phones and watch a live copy of the board, which could buzz when their name is next. That still needs the phone-to-TV sync from the original plan.
