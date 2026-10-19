# Changelog

## 0.5.0 — 2026-10-19

The first MacDoc release: a dock for your Mac on a spare Android tablet or phone.

- **Mac host.** Lists every Mac app with its real icon (including apps installed
  in folders, such as Adobe's), and opens apps or
  brings them forward.
- **Home screen.** An intro animation, a welcome screen that explains MacDoc and
  lists your apps to pin, 4 to 32 icons per page, page reordering, and a frosted
  control bar with Show Desktop, volume, Lock and power options.
- **Side pages.** Swipe in from the left for a player that follows any app;
  from the right for the shared clipboard and per-app volume. Swipe back to close.
- **Window cards.** Swipe down for every open window with a live preview; tap one
  to bring it to the front.
- **Touchpad, keyboard and signatures** for the Mac.
- **Setup page.** `localhost:8620/setup` arranges tiles, custom icons, the tablet
  layout, side pages, the PIN and paired devices from the Mac.
- **Connection.** A fixed PIN of your choice, devices that stay paired across
  restarts, Wi-Fi discovery that works on more networks, and a screen that stays
  on while MacDoc is open.
- **Updates over Wi-Fi.** `npm run android:update` publishes a new Android build;
  the tablet shows an update pop-up and installs it without a cable.

MacDoc is a fork of [WinDock](https://github.com/aliihsaad/WinDock) by Ali Saad;
WinDock's own history is in its repository. MacDoc is Mac only.
