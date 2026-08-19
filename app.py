"""
TravelMate — offline-friendly group travel & safety platform
Pure Python (Flask + sqlite3, standard library only) backend.
Serves the REST API and the plain HTML/CSS/JS frontend from one process.

Run:
    pip install flask
    python app.py
Then open http://localhost:5000
"""
import sqlite3
import secrets
import string
import math
import functools
from datetime import datetime, timedelta

from flask import Flask, request, jsonify, g, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

# --------------------------------------------------------------------------
# App setup
# --------------------------------------------------------------------------
app = Flask(__name__, static_folder="frontend", static_url_path="")
app.config["SECRET_KEY"] = secrets.token_hex(32)
DB_PATH = "travelmate.db"
TOKEN_MAX_AGE = 60 * 60 * 24 * 7  # 7 days

serializer = URLSafeTimedSerializer(app.config["SECRET_KEY"])

DEFAULT_SAFETY_RADIUS = 100  # meters
LOW_BATTERY_THRESHOLD = 15

ROLES = ("organizer", "co_admin", "member")
SOS_TYPES = ("lost", "medical", "accident", "danger", "general")


# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    destination TEXT,
    code TEXT NOT NULL UNIQUE,
    start_date TEXT,
    end_date TEXT,
    safety_radius INTEGER NOT NULL DEFAULT 100,
    admin_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS trip_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'connected',
    battery INTEGER NOT NULL DEFAULT 100,
    lat REAL,
    lng REAL,
    last_seen TEXT,
    joined_at TEXT NOT NULL,
    UNIQUE(trip_id, user_id),
    FOREIGN KEY (trip_id) REFERENCES trips(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    is_done INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS itinerary_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    day INTEGER NOT NULL DEFAULT 1,
    time TEXT,
    title TEXT NOT NULL,
    location TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sos_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    note TEXT,
    lat REAL,
    lng REAL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS safety_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    trip_id INTEGER,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0
);
"""


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    db.commit()
    db.close()


# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------
def now_iso():
    return datetime.utcnow().isoformat()


def new_trip_code():
    chars = string.ascii_uppercase + string.digits
    return "TRIP-" + "".join(secrets.choice(chars) for _ in range(4))


AVATAR_COLORS = ["#FF6B35", "#4FA97A", "#4E8CFF", "#C77DFF", "#FFC857", "#3AB0A2"]


def pick_color(seed):
    return AVATAR_COLORS[hash(seed) % len(AVATAR_COLORS)]


def haversine_m(lat1, lng1, lat2, lng2):
    """Distance in meters between two lat/lng points."""
    if None in (lat1, lng1, lat2, lng2):
        return None
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(r) for r in rows]


def add_notification(db, user_id, trip_id, type_, message):
    db.execute(
        "INSERT INTO notifications (user_id, trip_id, type, message, created_at) VALUES (?,?,?,?,?)",
        (user_id, trip_id, type_, message, now_iso()),
    )


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
def make_token(user_id):
    return serializer.dumps({"uid": user_id})


def verify_token(token):
    try:
        data = serializer.loads(token, max_age=TOKEN_MAX_AGE)
        return data.get("uid")
    except (BadSignature, SignatureExpired):
        return None


def require_auth(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        token = auth.split(" ", 1)[1] if auth.startswith("Bearer ") else None
        uid = verify_token(token) if token else None
        if not uid:
            return jsonify({"error": "Unauthorized"}), 401
        db = get_db()
        user = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not user:
            return jsonify({"error": "Unauthorized"}), 401
        g.user = user
        return fn(*args, **kwargs)

    return wrapper


def require_member(fn):
    """Ensures g.user is a member of trip_id (url kwarg) and sets g.membership."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        trip_id = kwargs.get("trip_id")
        db = get_db()
        m = db.execute(
            "SELECT * FROM trip_members WHERE trip_id=? AND user_id=?", (trip_id, g.user["id"])
        ).fetchone()
        if not m:
            return jsonify({"error": "Not a member of this trip"}), 403
        g.membership = m
        return fn(*args, **kwargs)

    return wrapper


def public_user(row):
    return {"id": row["id"], "name": row["name"], "email": row["email"], "color": row["color"]}


# --------------------------------------------------------------------------
# Auth routes
# --------------------------------------------------------------------------
@app.route("/api/auth/register", methods=["POST"])
def register():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not name or not email or len(password) < 6:
        return jsonify({"error": "Name, email and a password of 6+ characters are required"}), 400
    db = get_db()
    existing = db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    if existing:
        return jsonify({"error": "An account with this email already exists"}), 409
    pw_hash = generate_password_hash(password)
    cur = db.execute(
        "INSERT INTO users (name, email, password_hash, color, created_at) VALUES (?,?,?,?,?)",
        (name, email, pw_hash, pick_color(email), now_iso()),
    )
    db.commit()
    user = db.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify({"token": make_token(user["id"]), "user": public_user(user)}), 201


@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid email or password"}), 401
    return jsonify({"token": make_token(user["id"]), "user": public_user(user)})


@app.route("/api/auth/me", methods=["GET"])
@require_auth
def me():
    return jsonify({"user": public_user(g.user)})


# --------------------------------------------------------------------------
# Trips
# --------------------------------------------------------------------------
def trip_summary(db, trip_row, user_id):
    members = db.execute(
        "SELECT COUNT(*) c FROM trip_members WHERE trip_id=?", (trip_row["id"],)
    ).fetchone()["c"]
    my_role = db.execute(
        "SELECT role FROM trip_members WHERE trip_id=? AND user_id=?", (trip_row["id"], user_id)
    ).fetchone()
    d = dict(trip_row)
    d["member_count"] = members
    d["my_role"] = my_role["role"] if my_role else None
    return d


@app.route("/api/trips", methods=["GET"])
@require_auth
def list_trips():
    db = get_db()
    rows = db.execute(
        """SELECT t.* FROM trips t
           JOIN trip_members tm ON tm.trip_id = t.id
           WHERE tm.user_id = ?
           ORDER BY t.created_at DESC""",
        (g.user["id"],),
    ).fetchall()
    return jsonify({"trips": [trip_summary(db, r, g.user["id"]) for r in rows]})


@app.route("/api/trips", methods=["POST"])
@require_auth
def create_trip():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Trip name is required"}), 400
    db = get_db()
    code = new_trip_code()
    while db.execute("SELECT id FROM trips WHERE code=?", (code,)).fetchone():
        code = new_trip_code()
    cur = db.execute(
        """INSERT INTO trips (name, destination, code, start_date, end_date, safety_radius, admin_id, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            name,
            data.get("destination", ""),
            code,
            data.get("start_date"),
            data.get("end_date"),
            data.get("safety_radius") or DEFAULT_SAFETY_RADIUS,
            g.user["id"],
            now_iso(),
        ),
    )
    trip_id = cur.lastrowid
    db.execute(
        """INSERT INTO trip_members (trip_id, user_id, role, status, battery, joined_at, last_seen)
           VALUES (?,?,?,?,?,?,?)""",
        (trip_id, g.user["id"], "organizer", "connected", 100, now_iso(), now_iso()),
    )
    db.commit()
    trip = db.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    return jsonify({"trip": trip_summary(db, trip, g.user["id"])}), 201


@app.route("/api/trips/join", methods=["POST"])
@require_auth
def join_trip():
    data = request.get_json(force=True) or {}
    code = (data.get("code") or "").strip().upper()
    db = get_db()
    trip = db.execute("SELECT * FROM trips WHERE code=?", (code,)).fetchone()
    if not trip:
        return jsonify({"error": "No trip found with that code"}), 404
    already = db.execute(
        "SELECT id FROM trip_members WHERE trip_id=? AND user_id=?", (trip["id"], g.user["id"])
    ).fetchone()
    if not already:
        db.execute(
            """INSERT INTO trip_members (trip_id, user_id, role, status, battery, joined_at, last_seen)
               VALUES (?,?,?,?,?,?,?)""",
            (trip["id"], g.user["id"], "member", "connected", 100, now_iso(), now_iso()),
        )
        add_notification(
            db, trip["admin_id"], trip["id"], "member",
            f"{g.user['name']} joined {trip['name']}"
        )
        db.commit()
    return jsonify({"trip": trip_summary(db, trip, g.user["id"])})


@app.route("/api/trips/<int:trip_id>", methods=["GET"])
@require_auth
@require_member
def get_trip(trip_id):
    db = get_db()
    trip = db.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    return jsonify({"trip": trip_summary(db, trip, g.user["id"])})


@app.route("/api/trips/<int:trip_id>/members", methods=["GET"])
@require_auth
@require_member
def list_members(trip_id):
    db = get_db()
    rows = db.execute(
        """SELECT tm.*, u.name, u.email, u.color FROM trip_members tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.trip_id=? ORDER BY
             CASE tm.role WHEN 'organizer' THEN 0 WHEN 'co_admin' THEN 1 ELSE 2 END, u.name""",
        (trip_id,),
    ).fetchall()
    return jsonify({"members": rows_to_list(rows)})


@app.route("/api/trips/<int:trip_id>/location", methods=["POST"])
@require_auth
@require_member
def update_location(trip_id):
    """Update my own lat/lng/battery and recompute safety status against the organizer."""
    data = request.get_json(force=True) or {}
    lat, lng = data.get("lat"), data.get("lng")
    battery = data.get("battery")
    db = get_db()
    trip = db.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    organizer = db.execute(
        "SELECT * FROM trip_members WHERE trip_id=? AND role='organizer'", (trip_id,)
    ).fetchone()

    status = "connected"
    if organizer and organizer["user_id"] != g.user["id"] and organizer["lat"] is not None and lat is not None:
        dist = haversine_m(lat, lng, organizer["lat"], organizer["lng"])
        if dist is not None and dist > trip["safety_radius"]:
            status = "out_of_range"

    prev = db.execute(
        "SELECT status FROM trip_members WHERE trip_id=? AND user_id=?", (trip_id, g.user["id"])
    ).fetchone()

    fields, params = [], []
    if lat is not None:
        fields += ["lat=?", "lng=?"]
        params += [lat, lng]
    if battery is not None:
        fields += ["battery=?"]
        params += [battery]
    fields += ["status=?", "last_seen=?"]
    params += [status, now_iso()]
    params += [trip_id, g.user["id"]]
    db.execute(f"UPDATE trip_members SET {', '.join(fields)} WHERE trip_id=? AND user_id=?", params)

    if status == "out_of_range" and (not prev or prev["status"] != "out_of_range"):
        db.execute(
            "INSERT INTO safety_alerts (trip_id, user_id, type, message, created_at) VALUES (?,?,?,?,?)",
            (trip_id, g.user["id"], "OUT_OF_RANGE", f"{g.user['name']} moved outside the safety radius", now_iso()),
        )
        add_notification(db, trip["admin_id"], trip_id, "safety", f"{g.user['name']} is out of range")

    if battery is not None and battery <= LOW_BATTERY_THRESHOLD:
        db.execute(
            "INSERT INTO safety_alerts (trip_id, user_id, type, message, created_at) VALUES (?,?,?,?,?)",
            (trip_id, g.user["id"], "LOW_BATTERY", f"{g.user['name']}'s battery is at {battery}%", now_iso()),
        )
        add_notification(db, trip["admin_id"], trip_id, "safety", f"{g.user['name']}'s battery is low ({battery}%)")

    db.commit()
    return jsonify({"status": status})


# --------------------------------------------------------------------------
# Budget
# --------------------------------------------------------------------------
def compute_settlement(members, expenses):
    """Equal-split settlement: everyone owes an equal share of the total."""
    total = sum(e["amount"] for e in expenses)
    n = len(members) or 1
    share = total / n
    paid = {m["user_id"]: 0.0 for m in members}
    for e in expenses:
        paid[e["user_id"]] = paid.get(e["user_id"], 0.0) + e["amount"]
    balances = {uid: round(paid.get(uid, 0.0) - share, 2) for uid in paid}

    creditors = sorted([(uid, b) for uid, b in balances.items() if b > 0.01], key=lambda x: -x[1])
    debtors = sorted([(uid, -b) for uid, b in balances.items() if b < -0.01], key=lambda x: -x[1])
    settlements = []
    i = j = 0
    creditors, debtors = list(creditors), list(debtors)
    while i < len(debtors) and j < len(creditors):
        d_uid, d_amt = debtors[i]
        c_uid, c_amt = creditors[j]
        pay = round(min(d_amt, c_amt), 2)
        if pay > 0.01:
            settlements.append({"from": d_uid, "to": c_uid, "amount": pay})
        debtors[i] = (d_uid, round(d_amt - pay, 2))
        creditors[j] = (c_uid, round(c_amt - pay, 2))
        if debtors[i][1] <= 0.01:
            i += 1
        if creditors[j][1] <= 0.01:
            j += 1

    return {"total": round(total, 2), "share_per_person": round(share, 2), "balances": balances, "settlements": settlements}


@app.route("/api/trips/<int:trip_id>/budget", methods=["GET"])
@require_auth
@require_member
def get_budget(trip_id):
    db = get_db()
    expenses = rows_to_list(
        db.execute(
            """SELECT e.*, u.name as user_name, u.color as user_color FROM expenses e
               JOIN users u ON u.id = e.user_id WHERE e.trip_id=? ORDER BY e.created_at DESC""",
            (trip_id,),
        ).fetchall()
    )
    members = rows_to_list(db.execute("SELECT user_id FROM trip_members WHERE trip_id=?", (trip_id,)).fetchall())
    raw_expenses = db.execute("SELECT user_id, amount FROM expenses WHERE trip_id=?", (trip_id,)).fetchall()
    settlement = compute_settlement(members, raw_expenses)

    by_category = {}
    for e in expenses:
        by_category[e["category"]] = by_category.get(e["category"], 0) + e["amount"]

    name_lookup = {
        r["id"]: r["name"]
        for r in db.execute(
            "SELECT u.id, u.name FROM users u JOIN trip_members tm ON tm.user_id=u.id WHERE tm.trip_id=?", (trip_id,)
        ).fetchall()
    }
    settlement["settlements"] = [
        {"from_name": name_lookup.get(s["from"], "?"), "to_name": name_lookup.get(s["to"], "?"), **s}
        for s in settlement["settlements"]
    ]
    settlement["balances"] = [
        {"user_id": uid, "name": name_lookup.get(uid, "?"), "balance": bal} for uid, bal in settlement["balances"].items()
    ]

    return jsonify({"expenses": expenses, "by_category": by_category, "settlement": settlement})


@app.route("/api/trips/<int:trip_id>/budget", methods=["POST"])
@require_auth
@require_member
def add_expense(trip_id):
    data = request.get_json(force=True) or {}
    amount = data.get("amount")
    category = (data.get("category") or "Other").strip()
    if not amount or float(amount) <= 0:
        return jsonify({"error": "A positive amount is required"}), 400
    db = get_db()
    db.execute(
        "INSERT INTO expenses (trip_id, user_id, category, amount, description, created_at) VALUES (?,?,?,?,?,?)",
        (trip_id, g.user["id"], category, float(amount), data.get("description", ""), now_iso()),
    )
    db.commit()
    return jsonify({"ok": True}), 201


# --------------------------------------------------------------------------
# Checklist
# --------------------------------------------------------------------------
@app.route("/api/trips/<int:trip_id>/checklist", methods=["GET"])
@require_auth
@require_member
def get_checklist(trip_id):
    db = get_db()
    items = rows_to_list(
        db.execute("SELECT * FROM checklist_items WHERE trip_id=? ORDER BY created_at", (trip_id,)).fetchall()
    )
    return jsonify({"items": items})


@app.route("/api/trips/<int:trip_id>/checklist", methods=["POST"])
@require_auth
@require_member
def add_checklist_item(trip_id):
    data = request.get_json(force=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "Item text is required"}), 400
    db = get_db()
    db.execute(
        "INSERT INTO checklist_items (trip_id, text, is_done, created_by, created_at) VALUES (?,?,0,?,?)",
        (trip_id, text, g.user["id"], now_iso()),
    )
    db.commit()
    return jsonify({"ok": True}), 201


@app.route("/api/checklist/<int:item_id>/toggle", methods=["PATCH"])
@require_auth
def toggle_checklist_item(item_id):
    db = get_db()
    item = db.execute("SELECT * FROM checklist_items WHERE id=?", (item_id,)).fetchone()
    if not item:
        return jsonify({"error": "Not found"}), 404
    member = db.execute(
        "SELECT * FROM trip_members WHERE trip_id=? AND user_id=?", (item["trip_id"], g.user["id"])
    ).fetchone()
    if not member:
        return jsonify({"error": "Not a member of this trip"}), 403
    db.execute("UPDATE checklist_items SET is_done=? WHERE id=?", (0 if item["is_done"] else 1, item_id))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Itinerary
# --------------------------------------------------------------------------
@app.route("/api/trips/<int:trip_id>/itinerary", methods=["GET"])
@require_auth
@require_member
def get_itinerary(trip_id):
    db = get_db()
    items = rows_to_list(
        db.execute(
            "SELECT * FROM itinerary_items WHERE trip_id=? ORDER BY day, time", (trip_id,)
        ).fetchall()
    )
    return jsonify({"items": items})


@app.route("/api/trips/<int:trip_id>/itinerary", methods=["POST"])
@require_auth
@require_member
def add_itinerary_item(trip_id):
    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title is required"}), 400
    db = get_db()
    db.execute(
        "INSERT INTO itinerary_items (trip_id, day, time, title, location, notes, created_at) VALUES (?,?,?,?,?,?,?)",
        (trip_id, int(data.get("day") or 1), data.get("time", ""), title, data.get("location", ""), data.get("notes", ""), now_iso()),
    )
    db.commit()
    return jsonify({"ok": True}), 201


# --------------------------------------------------------------------------
# Chat (poll-based)
# --------------------------------------------------------------------------
@app.route("/api/trips/<int:trip_id>/messages", methods=["GET"])
@require_auth
@require_member
def get_messages(trip_id):
    after_id = request.args.get("after_id", 0, type=int)
    db = get_db()
    rows = db.execute(
        """SELECT m.*, u.name as user_name, u.color as user_color FROM messages m
           JOIN users u ON u.id = m.user_id
           WHERE m.trip_id=? AND m.id > ? ORDER BY m.id ASC""",
        (trip_id, after_id),
    ).fetchall()
    return jsonify({"messages": rows_to_list(rows)})


@app.route("/api/trips/<int:trip_id>/messages", methods=["POST"])
@require_auth
@require_member
def post_message(trip_id):
    data = request.get_json(force=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "Message text is required"}), 400
    db = get_db()
    db.execute(
        "INSERT INTO messages (trip_id, user_id, text, created_at) VALUES (?,?,?,?)",
        (trip_id, g.user["id"], text, now_iso()),
    )
    db.commit()
    return jsonify({"ok": True}), 201


# --------------------------------------------------------------------------
# Safety
# --------------------------------------------------------------------------
@app.route("/api/trips/<int:trip_id>/safety", methods=["GET"])
@require_auth
@require_member
def get_safety(trip_id):
    db = get_db()
    alerts = rows_to_list(
        db.execute(
            """SELECT sa.*, u.name as user_name FROM safety_alerts sa
               JOIN users u ON u.id = sa.user_id
               WHERE sa.trip_id=? ORDER BY sa.created_at DESC LIMIT 50""",
            (trip_id,),
        ).fetchall()
    )
    trip = db.execute("SELECT safety_radius FROM trips WHERE id=?", (trip_id,)).fetchone()
    return jsonify({"alerts": alerts, "safety_radius": trip["safety_radius"]})


@app.route("/api/trips/<int:trip_id>/safety/radius", methods=["POST"])
@require_auth
@require_member
def set_radius(trip_id):
    if g.membership["role"] not in ("organizer", "co_admin"):
        return jsonify({"error": "Only the organizer or co-admin can change this"}), 403
    data = request.get_json(force=True) or {}
    radius = int(data.get("radius") or DEFAULT_SAFETY_RADIUS)
    db = get_db()
    db.execute("UPDATE trips SET safety_radius=? WHERE id=?", (radius, trip_id))
    db.commit()
    return jsonify({"ok": True, "safety_radius": radius})


@app.route("/api/safety/<int:alert_id>/resolve", methods=["PATCH"])
@require_auth
def resolve_safety_alert(alert_id):
    db = get_db()
    alert = db.execute("SELECT * FROM safety_alerts WHERE id=?", (alert_id,)).fetchone()
    if not alert:
        return jsonify({"error": "Not found"}), 404
    member = db.execute(
        "SELECT * FROM trip_members WHERE trip_id=? AND user_id=?", (alert["trip_id"], g.user["id"])
    ).fetchone()
    if not member:
        return jsonify({"error": "Forbidden"}), 403
    db.execute("UPDATE safety_alerts SET resolved=1 WHERE id=?", (alert_id,))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# SOS
# --------------------------------------------------------------------------
@app.route("/api/trips/<int:trip_id>/sos", methods=["GET"])
@require_auth
@require_member
def get_sos(trip_id):
    db = get_db()
    alerts = rows_to_list(
        db.execute(
            """SELECT s.*, u.name as user_name, u.color as user_color FROM sos_alerts s
               JOIN users u ON u.id = s.user_id
               WHERE s.trip_id=? ORDER BY s.created_at DESC""",
            (trip_id,),
        ).fetchall()
    )
    return jsonify({"alerts": alerts})


@app.route("/api/trips/<int:trip_id>/sos", methods=["POST"])
@require_auth
@require_member
def trigger_sos(trip_id):
    data = request.get_json(force=True) or {}
    sos_type = data.get("type") if data.get("type") in SOS_TYPES else "general"
    db = get_db()
    my_loc = db.execute(
        "SELECT lat, lng FROM trip_members WHERE trip_id=? AND user_id=?", (trip_id, g.user["id"])
    ).fetchone()
    lat = data.get("lat", my_loc["lat"] if my_loc else None)
    lng = data.get("lng", my_loc["lng"] if my_loc else None)
    cur = db.execute(
        "INSERT INTO sos_alerts (trip_id, user_id, type, note, lat, lng, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (trip_id, g.user["id"], sos_type, data.get("note", ""), lat, lng, "active", now_iso()),
    )
    trip = db.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
    members = db.execute("SELECT user_id FROM trip_members WHERE trip_id=?", (trip_id,)).fetchall()
    for m in members:
        if m["user_id"] != g.user["id"]:
            add_notification(
                db, m["user_id"], trip_id, "sos",
                f"SOS: {g.user['name']} triggered a {sos_type.upper()} alert on {trip['name']}!"
            )
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid}), 201


@app.route("/api/sos/<int:alert_id>/resolve", methods=["PATCH"])
@require_auth
def resolve_sos(alert_id):
    db = get_db()
    alert = db.execute("SELECT * FROM sos_alerts WHERE id=?", (alert_id,)).fetchone()
    if not alert:
        return jsonify({"error": "Not found"}), 404
    member = db.execute(
        "SELECT * FROM trip_members WHERE trip_id=? AND user_id=?", (alert["trip_id"], g.user["id"])
    ).fetchone()
    if not member:
        return jsonify({"error": "Forbidden"}), 403
    db.execute("UPDATE sos_alerts SET status='resolved', resolved_at=? WHERE id=?", (now_iso(), alert_id))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Notifications
# --------------------------------------------------------------------------
@app.route("/api/notifications", methods=["GET"])
@require_auth
def get_notifications():
    db = get_db()
    rows = rows_to_list(
        db.execute(
            "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50", (g.user["id"],)
        ).fetchall()
    )
    return jsonify({"notifications": rows})


@app.route("/api/notifications/<int:notif_id>/read", methods=["PATCH"])
@require_auth
def read_notification(notif_id):
    db = get_db()
    db.execute("UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?", (notif_id, g.user["id"]))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# AI assistant (rule-based, no external API needed)
# --------------------------------------------------------------------------
def ai_reply(db, trip_id, message):
    msg = message.lower()

    if any(w in msg for w in ["budget", "expense", "money", "spend", "cost"]):
        expenses = db.execute("SELECT amount FROM expenses WHERE trip_id=?", (trip_id,)).fetchall()
        members = db.execute("SELECT COUNT(*) c FROM trip_members WHERE trip_id=?", (trip_id,)).fetchone()["c"]
        total = sum(e["amount"] for e in expenses)
        share = total / members if members else 0
        return (
            f"Your trip has logged ₹{total:,.0f} in expenses across {members} member(s), "
            f"about ₹{share:,.0f} per person on an equal split. Try grouping big-ticket items "
            f"(stays, transport) separately from daily spends so the pace is easier to track — "
            f"check the Budget tab for the full who-owes-whom breakdown."
        )

    if any(w in msg for w in ["pack", "packing", "bring", "carry"]):
        return (
            "For most multi-day group trips: layered clothing, a power bank, a physical map or "
            "downloaded offline maps, a basic first-aid kit, copies of ID, and a refillable water "
            "bottle. Add mountain/trek gear or monsoon gear depending on your destination and season. "
            "You can track this in the Checklist tab so everyone can tick off their own items."
        )

    if any(w in msg for w in ["itinerary", "plan", "schedule", "day"]):
        items = db.execute("SELECT COUNT(*) c FROM itinerary_items WHERE trip_id=?", (trip_id,)).fetchone()["c"]
        return (
            f"You currently have {items} itinerary item(s) planned. A good rule of thumb for group "
            f"travel: keep mornings for the must-see fixed plans and leave afternoons flexible — "
            f"groups drift apart when every hour is scheduled. Add stops in the Itinerary tab by day."
        )

    if any(w in msg for w in ["safety", "emergency", "danger", "sos", "lost"]):
        return (
            "If someone goes out of range, TravelMate raises an OUT_OF_RANGE alert automatically based "
            "on the safety radius you've set. In a real emergency, use the SOS button — it instantly "
            "notifies the whole group and the trip admin with your last known location. Set a sensible "
            "safety radius for the terrain (tighter in cities, wider in open/mountain areas)."
        )

    if any(w in msg for w in ["weather", "rain", "cold", "hot"]):
        return (
            "I don't have live weather data in this offline-first build, but as a rule: check the "
            "forecast a day ahead while you still have signal, and pack for the worst-case (rain shell, "
            "extra layer) rather than the average — mountain weather especially can flip fast."
        )

    return (
        "I can help with trip budget, packing lists, itinerary pacing, or safety planning — "
        "ask me something like \"how's our budget looking?\" or \"what should we pack?\""
    )


@app.route("/api/trips/<int:trip_id>/ai", methods=["POST"])
@require_auth
@require_member
def ask_ai(trip_id):
    data = request.get_json(force=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Message is required"}), 400
    db = get_db()
    reply = ai_reply(db, trip_id, message)
    return jsonify({"reply": reply})


# --------------------------------------------------------------------------
# Frontend
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(app.static_folder, "index.html")


# --------------------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000)
