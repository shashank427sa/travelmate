# TravelMate (Python + HTML/CSS/JS edition)

A from-scratch rebuild of TravelMate using only **Flask (Python)** on the backend
and **plain HTML/CSS/JavaScript** on the frontend — no Node.js, no npm, no
database server to install, no build step.

**"Travel together. Stay connected. Stay safe — even off the grid."**

## Features
- Register / log in (JWT-style signed tokens)
- Create a trip → get a shareable join code (`TRIP-XXXX`)
- Join a trip with a code
- Trip Room: member list with role, connection status, battery
- Budget: add expenses, category breakdown, equal-split settlement ("who owes whom")
- Checklist: shared, tickable trip checklist
- Itinerary: day-by-day stops
- Chat: group chat (auto-refreshes every few seconds)
- Safety: configurable safety radius, automatic OUT_OF_RANGE / LOW_BATTERY alerts
  based on distance from the trip organizer's last known location
- SOS: one-tap Lost / Medical / Accident / Danger / General alert, notifies the group
- AI Assistant: rule-based trip advice (budget, packing, itinerary pacing, safety) —
  no API key needed
- Notifications center

## Why it looks different from the original
The original TravelMate project (in your first upload) used React + Node/Express +
PostgreSQL + Socket.IO. Since you asked for **pure HTML/CSS/JS + Python**, this is a
full rewrite:
- **Storage:** SQLite (a single `travelmate.db` file) instead of PostgreSQL — nothing
  to install or configure.
- **Realtime:** the chat/notifications refresh by polling the server every 4 seconds
  instead of using Socket.IO/websockets, so the only dependency is Flask itself.
- **Frontend:** hand-written HTML/CSS/vanilla JS (no React, no bundler) — open
  `frontend/js/app.js` and it's all plain, readable JavaScript.

## Requirements
- Python 3.9+
- One pip package: Flask (everything else — SQLite, password hashing, signed
  tokens — comes from Python's standard library or ships with Flask)

## Setup

```bash
cd travelmate-web
pip install flask
python app.py
```

Open **http://localhost:5000** in your browser. That's it — the same Flask process
serves the API and the frontend, and it creates `travelmate.db` automatically on
first run.

## Try it out
1. Register two accounts (e.g. "Admin" and "Priya") in two browser tabs/windows.
2. As Admin, create a trip — note the `TRIP-XXXX` join code shown on the trip card.
3. As Priya, click **Join with code** and enter it.
4. Explore: add an expense as each user and check the **Budget** tab's settlement;
   post a few chat messages; add checklist/itinerary items; go to **Safety**, click
   **Share my GPS location** (or enter lat/lng manually) as each user with the
   organizer's location set far away, to see an `OUT_OF_RANGE` alert appear; try the
   **SOS** button; ask the **AI Assistant** something like *"how's our budget looking?"*

## Project structure
```
travelmate-web/
  app.py                 # Entire backend: routes, SQLite schema, auth, business logic
  travelmate.db           # Created automatically on first run
  frontend/
    index.html            # Single-page app shell (all views)
    css/style.css          # Design system (dark terrain theme)
    js/api.js              # fetch() wrapper for the REST API
    js/app.js              # App state, routing, rendering, polling
```

## Notes
- Passwords are hashed with Werkzeug's `generate_password_hash` (PBKDF2).
- Auth tokens are signed (not encrypted) with `itsdangerous` and expire after 7 days.
- This is a learning/demo build — for real deployment you'd want HTTPS, a
  production WSGI server (gunicorn/waitress), and stronger secret management.

## Offline Direct Chat

TravelMate now includes browser-to-browser offline chat using **WebRTC DataChannel**.

### How to pair two phones
1. Open the same TravelMate project on both phones.
2. Go to **Chat** on the same trip.
3. On Phone A tap **Create connection** and send the generated connection code to Phone B (copy/paste works without internet).
4. On Phone B tap **Join connection**, paste the code, and tap **Create my answer**.
5. Send the generated answer back to Phone A.
6. Phone A pastes the answer and taps **Connect**.
7. When the badge says **Direct chat connected**, messages are sent directly between the two browsers.

The chat history is also stored locally in the browser so it remains visible when the device is offline.

> WebRTC pairing itself uses manual signaling so the chat does not require a signaling server. For best results, keep the phones on the same local Wi-Fi/hotspot. Completely automatic Bluetooth/Wi-Fi Direct discovery would require a native Android/iOS layer.
