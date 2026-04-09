# Pinochle Card Room

A multiplayer pinochle game for 4 players with live video chat, built as a static GitHub Pages app.

## Features

- **Single deck modern rules** — 48-card deck, goal 150 points
- **Live video chat** — WebRTC peer-to-peer, no server needed
- **4 players** — Partners (NS vs EW)
- **Full modern ruleset:**
  - Minimum bid 25, bid by 1
  - Stick the dealer
  - Declarer passes 3 cards blind; partner discards 3
  - Must head the trick
  - Bidder goes out
  - Deal review after every round

## Hosting on GitHub Pages

1. Fork or clone this repo
2. Go to **Settings → Pages**
3. Source: **Deploy from a branch → main → / (root)**
4. Live at `https://YOUR-USERNAME.github.io/pinochle/`

## How to Play

1. One player clicks **Create Game** — share the room code or link
2. Others enter the code and **Join**
3. Host clicks **Start Game**
4. Allow camera/mic when prompted

## Rules Quick Reference

| Rule | Detail |
|---|---|
| Deck | Single 48-card (A 10 K Q J 9 × 4 suits) |
| Goal | 150 points |
| Min bid | 25, by 1 |
| Stick dealer | Dealer must bid if all others pass |
| Passing | Declarer passes 3 blind; partner discards 3 |
| Must head | Must beat current winning card if able |
| Bidder goes out | Bid team wins tiebreaker at 150 |
| Points | A=11, 10=10, K=4, Q=3, J=2, last trick=1 |
