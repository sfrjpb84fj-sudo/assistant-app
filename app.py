"""
Personal Assistant
Chat (Claude), memory, to-do lists, reminders, push notifications, morning brief,
weekly review, photo/PDF reading, expense log, routines, and a Siri Shortcut endpoint.

Runs as a small web app. Your iPhone opens it like an app from the home screen.
All your data lives in one file on your own server: <DATA_DIR>/assistant.db
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

log = logging.getLogger("assistant")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ================================================================ settings
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "assistant.db"
VAPID_KEY_PATH = DATA_DIR / "vapid_private.pem"
STATIC_DIR = BASE_DIR / "static"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
APP_PASSCODE = os.environ.get("APP_PASSCODE", "")
MODEL = os.environ.get("MODEL", "claude-sonnet-5-5")
USER_NAME = os.environ.get("USER_NAME", "the user")
ASSISTANT_NAME = os.environ.get("ASSISTANT_NAME", "Jarvis")
TIMEZONE = os.environ.get("TIMEZONE", "America/Los_Angeles")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:assistant@example.com")
SECURE_COOKIE = os.environ.get("SECURE_COOKIE", "true").lower() != "false"
RUN_SCHEDULER = os.environ.get("RUN_SCHEDULER", "true").lower() != "false"

HISTORY_LIMIT = 40
MAX_TOOL_ROUNDS = 10
SESSION_DAYS = 180
LISTS = ("work", "personal")
MAX_ATTACH_BYTES = 10 * 1024 * 1024
IMAGE_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp")
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

DEFAULT_SETTINGS = {
    "brief_time": "07:30",
    "brief_days": "weekdays",     # weekdays | daily | off
    "review_day": "mon",          # mon..sun | off
    "review_time": "08:00",
    "weather_city": "",           # e.g. "Irvine, California"
}

DATA_DIR.mkdir(parents=True, exist_ok=True)

# ================================================================ database
SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list TEXT NOT NULL CHECK (list IN ('work','personal')),
    title TEXT NOT NULL, notes TEXT DEFAULT '', due TEXT DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fact TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, fire_at TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, merchant TEXT NOT NULL,
    amount REAL NOT NULL, category TEXT NOT NULL DEFAULT 'Other', note TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    list TEXT NOT NULL CHECK (list IN ('work','personal')),
    items TEXT NOT NULL,              -- JSON list of task titles
    schedule TEXT NOT NULL DEFAULT 'none',   -- none | monthly:DAY | weekly:mon..sun
    due_days INTEGER NOT NULL DEFAULT 0,     -- tasks are due this many days after they're added
    last_run TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")


def tz():
    return ZoneInfo(TIMEZONE)


def now_local() -> datetime:
    return datetime.now(tz())


def now_str() -> str:
    return now_local().strftime("%Y-%m-%d %H:%M")


def get_setting(key: str) -> str:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else DEFAULT_SETTINGS.get(key, "")


def set_setting(key: str, value: str):
    with db() as conn:
        conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (key, value))


def shortcut_token() -> str:
    tok = get_setting("shortcut_token")
    if not tok:
        tok = secrets.token_urlsafe(24)
        set_setting("shortcut_token", tok)
    return tok


init_db()


# ================================================================ push notifications
def vapid_public_key() -> str:
    """Creates this server's notification keys the first time, then reuses them."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    if not VAPID_KEY_PATH.exists():
        key = ec.generate_private_key(ec.SECP256R1())
        VAPID_KEY_PATH.write_bytes(key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        os.chmod(VAPID_KEY_PATH, 0o600)
    key = serialization.load_pem_private_key(VAPID_KEY_PATH.read_bytes(), None)
    raw = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def send_push(title: str, body: str, tag: str = "") -> int:
    """Sends a notification to every phone that turned notifications on. Returns how many got it."""
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        log.warning("pywebpush not installed; skipping notification")
        return 0
    vapid_public_key()  # make sure keys exist
    payload = json.dumps({"title": title, "body": body[:300], "tag": tag})
    with db() as conn:
        subs = conn.execute("SELECT * FROM push_subs").fetchall()
    sent = 0
    for s in subs:
        try:
            webpush(
                subscription_info={"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                data=payload, vapid_private_key=str(VAPID_KEY_PATH),
                vapid_claims={"sub": VAPID_SUBJECT}, ttl=3600,
            )
            sent += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            log.warning("push failed (%s): %s", status, e)
            if status in (404, 410):  # phone unsubscribed; forget it
                with db() as conn:
                    conn.execute("DELETE FROM push_subs WHERE endpoint=?", (s["endpoint"],))
        except Exception as e:  # never let a notification problem crash anything
            log.warning("push error: %s", e)
    return sent


# ================================================================ app + security headers
@asynccontextmanager
async def lifespan(_app):
    if RUN_SCHEDULER:
        threading.Thread(target=scheduler_loop, daemon=True, name="scheduler").start()
    yield


app = FastAPI(title="Personal Assistant", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; "
        "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ================================================================ sign-in
_failed_logins: list[float] = []
LOCKOUT_WINDOW, LOCKOUT_MAX = 15 * 60, 5


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _too_many_failures() -> bool:
    cutoff = time.time() - LOCKOUT_WINDOW
    _failed_logins[:] = [t for t in _failed_logins if t > cutoff]
    return len(_failed_logins) >= LOCKOUT_MAX


def require_auth(request: Request):
    token = request.cookies.get("sid")
    if not token:
        raise HTTPException(401, "Not signed in")
    with db() as conn:
        row = conn.execute("SELECT created_at FROM sessions WHERE token_hash=?", (_hash(token),)).fetchone()
    if not row or time.time() - row["created_at"] > SESSION_DAYS * 86400:
        raise HTTPException(401, "Not signed in")
    return True


class LoginIn(BaseModel):
    passcode: str = Field(max_length=200)


@app.post("/api/login")
def login(body: LoginIn, response: Response):
    if not APP_PASSCODE:
        raise HTTPException(500, "APP_PASSCODE is not set on the server")
    if _too_many_failures():
        raise HTTPException(429, "Too many wrong tries. Wait 15 minutes.")
    if not hmac.compare_digest(body.passcode.encode(), APP_PASSCODE.encode()):
        _failed_logins.append(time.time())
        time.sleep(1)
        raise HTTPException(401, "Wrong passcode")
    token = secrets.token_urlsafe(32)
    with db() as conn:
        conn.execute("INSERT INTO sessions VALUES (?, ?)", (_hash(token), time.time()))
    response.set_cookie("sid", token, max_age=SESSION_DAYS * 86400, httponly=True,
                        secure=SECURE_COOKIE, samesite="strict", path="/")
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get("sid")
    if token:
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (_hash(token),))
    response.delete_cookie("sid", path="/")
    return {"ok": True}


@app.get("/api/me")
def me(_=Depends(require_auth)):
    return {"name": USER_NAME, "assistant": ASSISTANT_NAME, "configured": bool(ANTHROPIC_API_KEY)}


# ================================================================ tasks
def task_dict(r) -> dict:
    return {k: r[k] for k in r.keys()} | {"done": bool(r["done"])}


def add_task(list_name: str, title: str, notes: str = "", due: str = "") -> dict:
    if list_name not in LISTS:
        raise ValueError("list must be 'work' or 'personal'")
    title = title.strip()[:300]
    if not title:
        raise ValueError("title is empty")
    with db() as conn:
        cur = conn.execute("INSERT INTO tasks (list,title,notes,due,created_at) VALUES (?,?,?,?,?)",
                           (list_name, title, notes.strip()[:2000], due.strip()[:40], now_str()))
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (cur.lastrowid,)).fetchone()
    return task_dict(row)


def get_tasks(list_name: str | None = None, include_done: bool = False) -> list[dict]:
    q, args = "SELECT * FROM tasks WHERE 1=1", []
    if list_name:
        q += " AND list=?"
        args.append(list_name)
    if not include_done:
        q += " AND done=0"
    q += " ORDER BY done, CASE WHEN due='' THEN 1 ELSE 0 END, due, id"
    with db() as conn:
        return [task_dict(r) for r in conn.execute(q, args).fetchall()]


def update_task(task_id: int, **fields) -> dict:
    allowed = {k: v for k, v in fields.items() if k in ("title", "notes", "due", "list", "done") and v is not None}
    if "list" in allowed and allowed["list"] not in LISTS:
        raise ValueError("list must be 'work' or 'personal'")
    with db() as conn:
        if not conn.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
            raise ValueError(f"No task with id {task_id}")
        if "done" in allowed:
            allowed["done"] = 1 if allowed["done"] else 0
            allowed["done_at"] = now_str() if allowed["done"] else ""
        for k, v in allowed.items():
            conn.execute(f"UPDATE tasks SET {k}=? WHERE id=?", (v, task_id))
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    return task_dict(row)


class TaskIn(BaseModel):
    list: str
    title: str = Field(max_length=300)
    notes: str = Field("", max_length=2000)
    due: str = Field("", max_length=40)


class TaskPatch(BaseModel):
    title: str | None = Field(None, max_length=300)
    notes: str | None = Field(None, max_length=2000)
    due: str | None = Field(None, max_length=40)
    list: str | None = None
    done: bool | None = None


@app.get("/api/tasks")
def api_tasks(list: str | None = None, include_done: bool = True, _=Depends(require_auth)):
    return get_tasks(list, include_done)


@app.post("/api/tasks")
def api_add_task(body: TaskIn, _=Depends(require_auth)):
    try:
        return add_task(body.list, body.title, body.notes, body.due)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/tasks/{task_id}")
def api_update_task(task_id: int, body: TaskPatch, _=Depends(require_auth)):
    try:
        return update_task(task_id, **body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/tasks/{task_id}")
def api_delete_task(task_id: int, _=Depends(require_auth)):
    with db() as conn:
        conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    return {"ok": True}


# ================================================================ memory
def get_memories() -> list[dict]:
    with db() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM memories ORDER BY id").fetchall()]


def add_memory(fact: str) -> dict:
    fact = fact.strip()[:500]
    if not fact:
        raise ValueError("fact is empty")
    with db() as conn:
        cur = conn.execute("INSERT INTO memories (fact, created_at) VALUES (?,?)", (fact, now_str()))
    return {"id": cur.lastrowid, "fact": fact}


def delete_memory(mem_id: int) -> bool:
    with db() as conn:
        return conn.execute("DELETE FROM memories WHERE id=?", (mem_id,)).rowcount > 0


class MemoryIn(BaseModel):
    fact: str = Field(max_length=500)


@app.get("/api/memories")
def api_memories(_=Depends(require_auth)):
    return get_memories()


@app.post("/api/memories")
def api_add_memory(body: MemoryIn, _=Depends(require_auth)):
    try:
        return add_memory(body.fact)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/memories/{mem_id}")
def api_delete_memory(mem_id: int, _=Depends(require_auth)):
    delete_memory(mem_id)
    return {"ok": True}


# ================================================================ reminders
def parse_when(when: str) -> str:
    when = when.strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(when, fmt).strftime("%Y-%m-%d %H:%M")
        except ValueError:
            pass
    raise ValueError("when must look like 2026-10-27 15:00")


def add_reminder(text: str, when: str) -> dict:
    text = text.strip()[:300]
    if not text:
        raise ValueError("text is empty")
    fire_at = parse_when(when)
    if fire_at < now_str():
        raise ValueError(f"{fire_at} is already in the past (it is now {now_str()})")
    with db() as conn:
        cur = conn.execute("INSERT INTO reminders (text, fire_at, created_at) VALUES (?,?,?)",
                           (text, fire_at, now_str()))
    return {"id": cur.lastrowid, "text": text, "fire_at": fire_at}


def get_reminders(include_sent: bool = False) -> list[dict]:
    q = "SELECT * FROM reminders" + ("" if include_sent else " WHERE sent=0") + " ORDER BY fire_at"
    with db() as conn:
        return [dict(r) for r in conn.execute(q).fetchall()]


def cancel_reminder(rid: int) -> bool:
    with db() as conn:
        return conn.execute("DELETE FROM reminders WHERE id=? AND sent=0", (rid,)).rowcount > 0


@app.get("/api/reminders")
def api_reminders(_=Depends(require_auth)):
    return get_reminders()


@app.delete("/api/reminders/{rid}")
def api_cancel_reminder(rid: int, _=Depends(require_auth)):
    cancel_reminder(rid)
    return {"ok": True}


# ================================================================ expenses
def log_expense(date: str, merchant: str, amount: float, category: str = "Other", note: str = "") -> dict:
    datetime.strptime(date, "%Y-%m-%d")  # validates
    amount = round(float(amount), 2)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO expenses (date,merchant,amount,category,note,created_at) VALUES (?,?,?,?,?,?)",
            (date, merchant.strip()[:120], amount, (category or "Other").strip()[:40], note.strip()[:500], now_str()))
    return {"id": cur.lastrowid, "date": date, "merchant": merchant, "amount": amount, "category": category}


def list_expenses(start: str = "", end: str = "", category: str = "") -> dict:
    q, args = "SELECT * FROM expenses WHERE 1=1", []
    if start:
        q += " AND date>=?"; args.append(start)
    if end:
        q += " AND date<=?"; args.append(end)
    if category:
        q += " AND lower(category)=lower(?)"; args.append(category)
    q += " ORDER BY date DESC, id DESC"
    with db() as conn:
        rows = [dict(r) for r in conn.execute(q, args).fetchall()]
    by_cat: dict[str, float] = {}
    for r in rows:
        by_cat[r["category"]] = round(by_cat.get(r["category"], 0) + r["amount"], 2)
    return {"count": len(rows), "total": round(sum(r["amount"] for r in rows), 2),
            "by_category": by_cat, "items": rows[:100]}


def delete_expense(eid: int) -> bool:
    with db() as conn:
        return conn.execute("DELETE FROM expenses WHERE id=?", (eid,)).rowcount > 0


@app.get("/api/expenses")
def api_expenses(start: str = "", end: str = "", _=Depends(require_auth)):
    return list_expenses(start, end)


@app.delete("/api/expenses/{eid}")
def api_delete_expense(eid: int, _=Depends(require_auth)):
    delete_expense(eid)
    return {"ok": True}


# ================================================================ routines (repeatable checklists)
def check_schedule(schedule: str) -> str:
    schedule = (schedule or "none").strip().lower()
    if schedule == "none":
        return schedule
    kind, _, val = schedule.partition(":")
    if kind == "monthly" and val.isdigit() and 1 <= int(val) <= 28:
        return schedule
    if kind == "weekly" and val in WEEKDAYS:
        return schedule
    raise ValueError("schedule must be 'none', 'monthly:1'..'monthly:28', or 'weekly:mon'..'weekly:sun'")


def create_routine(name: str, list_name: str, items: list[str], schedule: str = "none", due_days: int = 0) -> dict:
    if list_name not in LISTS:
        raise ValueError("list must be 'work' or 'personal'")
    items = [i.strip()[:300] for i in items if i and i.strip()][:40]
    if not items:
        raise ValueError("a routine needs at least one item")
    schedule = check_schedule(schedule)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO routines (name,list,items,schedule,due_days,created_at) VALUES (?,?,?,?,?,?)",
            (name.strip()[:120], list_name, json.dumps(items), schedule, max(0, int(due_days)), now_str()))
    return {"id": cur.lastrowid, "name": name, "items": items, "schedule": schedule}


def get_routines() -> list[dict]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM routines ORDER BY name").fetchall()
    return [dict(r) | {"items": json.loads(r["items"])} for r in rows]


def run_routine(rid: int, today=None) -> list[dict]:
    with db() as conn:
        r = conn.execute("SELECT * FROM routines WHERE id=?", (rid,)).fetchone()
    if not r:
        raise ValueError(f"No routine with id {rid}")
    today = today or now_local().date()
    due = (today + timedelta(days=r["due_days"])).isoformat()
    added = [add_task(r["list"], f"{t}", f"From routine: {r['name']}", due) for t in json.loads(r["items"])]
    with db() as conn:
        conn.execute("UPDATE routines SET last_run=? WHERE id=?", (today.isoformat(), rid))
    return added


def delete_routine(rid: int) -> bool:
    with db() as conn:
        return conn.execute("DELETE FROM routines WHERE id=?", (rid,)).rowcount > 0


@app.get("/api/routines")
def api_routines(_=Depends(require_auth)):
    return get_routines()


@app.post("/api/routines/{rid}/run")
def api_run_routine(rid: int, _=Depends(require_auth)):
    try:
        return {"added": len(run_routine(rid))}
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.delete("/api/routines/{rid}")
def api_delete_routine(rid: int, _=Depends(require_auth)):
    delete_routine(rid)
    return {"ok": True}


# ================================================================ settings + notifications API
def update_settings(**kw) -> dict:
    if kw.get("brief_time") is not None:
        datetime.strptime(kw["brief_time"], "%H:%M")
        set_setting("brief_time", kw["brief_time"])
    if kw.get("brief_days") is not None:
        if kw["brief_days"] not in ("weekdays", "daily", "off"):
            raise ValueError("brief_days must be weekdays, daily, or off")
        set_setting("brief_days", kw["brief_days"])
    if kw.get("review_day") is not None:
        if kw["review_day"] not in WEEKDAYS + ("off",):
            raise ValueError("review_day must be mon..sun or off")
        set_setting("review_day", kw["review_day"])
    if kw.get("review_time") is not None:
        datetime.strptime(kw["review_time"], "%H:%M")
        set_setting("review_time", kw["review_time"])
    if kw.get("weather_city") is not None:
        city = kw["weather_city"].strip()[:80]
        if city and not find_place(city):
            raise ValueError(f"Couldn't find a place called '{city}'. Try 'City, State' or 'City, Country'.")
        set_setting("weather_city", city)
        _weather_cache.clear()
    return current_settings()


def current_settings() -> dict:
    return {k: get_setting(k) for k in DEFAULT_SETTINGS}


class SettingsIn(BaseModel):
    brief_time: str | None = None
    brief_days: str | None = None
    review_day: str | None = None
    review_time: str | None = None
    weather_city: str | None = None


@app.get("/api/settings")
def api_settings(_=Depends(require_auth)):
    with db() as conn:
        subs = conn.execute("SELECT COUNT(*) c FROM push_subs").fetchone()["c"]
    return current_settings() | {"push_devices": subs, "shortcut_token": shortcut_token(),
                                 "assistant": ASSISTANT_NAME}


@app.post("/api/settings")
def api_update_settings(body: SettingsIn, _=Depends(require_auth)):
    try:
        return update_settings(**body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/settings/new-shortcut-token")
def api_new_token(_=Depends(require_auth)):
    set_setting("shortcut_token", secrets.token_urlsafe(24))
    return {"shortcut_token": shortcut_token()}


@app.get("/api/push/key")
def api_push_key(_=Depends(require_auth)):
    return {"key": vapid_public_key()}


class SubIn(BaseModel):
    endpoint: str = Field(max_length=1000)
    keys: dict


@app.post("/api/push/subscribe")
def api_push_subscribe(body: SubIn, _=Depends(require_auth)):
    if not body.endpoint.startswith("https://"):
        raise HTTPException(400, "bad subscription")
    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO push_subs VALUES (?,?,?,?)",
                     (body.endpoint, body.keys.get("p256dh", ""), body.keys.get("auth", ""), now_str()))
    return {"ok": True}


@app.post("/api/push/test")
def api_push_test(_=Depends(require_auth)):
    n = send_push(ASSISTANT_NAME, "Notifications are working. 👍", "test")
    if not n:
        raise HTTPException(400, "No phone is set up for notifications yet, or sending failed.")
    return {"sent": n}


# ================================================================ weather (Open-Meteo: free, no account or key)
_weather_cache: dict = {}
WEATHER_TTL = 20 * 60
WMO = {0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog",
       51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
       66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow",
       80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
       95: "Thunderstorms", 96: "Thunderstorms", 99: "Thunderstorms"}
US_STATES = {"AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
             "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
             "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
             "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
             "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
             "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
             "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
             "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
             "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
             "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia"}


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "personal-assistant/1.0"})
    with urllib.request.urlopen(req, timeout=6) as r:
        return json.loads(r.read().decode())


def find_place(city: str) -> dict | None:
    """'Irvine, CA' -> {'name','region','lat','lon'} using Open-Meteo geocoding."""
    name, _, region = (p.strip() for p in city.partition(","))
    region = US_STATES.get(region.upper(), region)
    try:
        data = _get_json("https://geocoding-api.open-meteo.com/v1/search?" +
                         urllib.parse.urlencode({"name": name, "count": 10, "language": "en"}))
    except Exception as e:
        log.warning("geocoding failed: %r", e)
        return None
    results = data.get("results") or []
    if region:
        rl = region.lower()
        match = [r for r in results if rl in (r.get("admin1", "") + " " + r.get("country", "") + " " +
                                              r.get("country_code", "")).lower()]
        results = match or results
    if not results:
        return None
    r = results[0]
    return {"name": r["name"], "region": r.get("admin1") or r.get("country", ""),
            "lat": r["latitude"], "lon": r["longitude"]}


def get_weather() -> dict | None:
    city = get_setting("weather_city")
    if not city:
        return None
    hit = _weather_cache.get(city)
    if hit and time.time() - hit[0] < (WEATHER_TTL if hit[1] else 120):
        return hit[1]
    result = None
    place = find_place(city)
    if place:
        try:
            d = _get_json("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode({
                "latitude": place["lat"], "longitude": place["lon"], "timezone": "auto",
                "current": "temperature_2m,weather_code", "daily": "temperature_2m_max,temperature_2m_min",
                "temperature_unit": "fahrenheit", "forecast_days": 1}))
            result = {
                "place": place["name"], "region": place["region"],
                "temp": round(d["current"]["temperature_2m"]), "condition": WMO.get(d["current"]["weather_code"], "—"),
                "code": d["current"]["weather_code"],
                "high": round(d["daily"]["temperature_2m_max"][0]), "low": round(d["daily"]["temperature_2m_min"][0]),
            }
        except Exception as e:
            log.warning("weather failed: %r", e)
    _weather_cache[city] = (time.time(), result)
    return result


@app.get("/api/weather")
def api_weather(_=Depends(require_auth)):
    if not get_setting("weather_city"):
        return {"set": False}
    w = get_weather()
    return {"set": True, "ok": bool(w)} | (w or {})


# ================================================================ Claude: tools
TOOLS = [
    {"name": "add_task", "description": "Add a to-do item to the work or personal list.",
     "input_schema": {"type": "object", "properties": {
         "list": {"type": "string", "enum": ["work", "personal"]},
         "title": {"type": "string"}, "notes": {"type": "string"},
         "due": {"type": "string", "description": "YYYY-MM-DD (optionally with HH:MM)"}},
         "required": ["list", "title"]}},
    {"name": "list_tasks", "description": "List to-do items with their ids.",
     "input_schema": {"type": "object", "properties": {
         "list": {"type": "string", "enum": ["work", "personal"]},
         "include_done": {"type": "boolean"}}}},
    {"name": "update_task", "description": "Mark a task done/undone, rename it, change its due date or notes, or move it.",
     "input_schema": {"type": "object", "properties": {
         "id": {"type": "integer"}, "done": {"type": "boolean"}, "title": {"type": "string"},
         "notes": {"type": "string"}, "due": {"type": "string"},
         "list": {"type": "string", "enum": ["work", "personal"]}}, "required": ["id"]}},
    {"name": "remember", "description": (
        "Save a lasting fact about the user (preferences, people, routines, projects). Use when asked to remember "
        "something or when a clearly lasting fact is stated. Never save passwords, account/card numbers, or ID numbers."),
     "input_schema": {"type": "object", "properties": {"fact": {"type": "string"}}, "required": ["fact"]}},
    {"name": "forget", "description": "Delete a saved memory by id.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
    {"name": "set_reminder", "description": "Send a push notification to the user's phone at a specific time.",
     "input_schema": {"type": "object", "properties": {
         "text": {"type": "string", "description": "What to remind them about"},
         "when": {"type": "string", "description": "Local time as YYYY-MM-DD HH:MM"}}, "required": ["text", "when"]}},
    {"name": "list_reminders", "description": "List upcoming reminders with ids.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "cancel_reminder", "description": "Cancel an upcoming reminder by id.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
    {"name": "log_expense", "description": (
        "Log a purchase (e.g. from a receipt photo). Categories: Groceries, Dining, Transport, Gas, Shopping, "
        "Bills, Health, Entertainment, Travel, Work, Other."),
     "input_schema": {"type": "object", "properties": {
         "date": {"type": "string", "description": "YYYY-MM-DD"}, "merchant": {"type": "string"},
         "amount": {"type": "number", "description": "Total paid, in dollars"},
         "category": {"type": "string"}, "note": {"type": "string"}},
         "required": ["date", "merchant", "amount"]}},
    {"name": "list_expenses", "description": "Get logged expenses with totals by category for a date range.",
     "input_schema": {"type": "object", "properties": {
         "start": {"type": "string", "description": "YYYY-MM-DD"}, "end": {"type": "string"},
         "category": {"type": "string"}}}},
    {"name": "delete_expense", "description": "Delete a logged expense by id (only if the user asks).",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
    {"name": "create_routine", "description": (
        "Save a reusable checklist. When run (by hand or on its schedule) each item is added as a to-do. "
        "schedule: 'none', 'monthly:N' (day 1-28), or 'weekly:mon'..'weekly:sun'."),
     "input_schema": {"type": "object", "properties": {
         "name": {"type": "string"}, "list": {"type": "string", "enum": ["work", "personal"]},
         "items": {"type": "array", "items": {"type": "string"}},
         "schedule": {"type": "string"},
         "due_days": {"type": "integer", "description": "Tasks are due this many days after being added (default 0)"}},
         "required": ["name", "list", "items"]}},
    {"name": "list_routines", "description": "List saved routines.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "run_routine", "description": "Add a routine's items to the to-do list now.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
    {"name": "delete_routine", "description": "Delete a routine (only if the user asks).",
     "input_schema": {"type": "object", "properties": {"id": {"type": "integer"}}, "required": ["id"]}},
    {"name": "update_settings", "description": (
        "Change the scheduled check-ins. brief_time HH:MM (24h), brief_days weekdays|daily|off; "
        "review_day mon..sun|off, review_time HH:MM."),
     "input_schema": {"type": "object", "properties": {
         "brief_time": {"type": "string"}, "brief_days": {"type": "string"},
         "review_day": {"type": "string"}, "review_time": {"type": "string"},
         "weather_city": {"type": "string", "description": "City for the weather panel, e.g. 'Irvine, California'"}}}},
    {"name": "get_weather", "description": "Current weather and today's high/low for the user's saved city.",
     "input_schema": {"type": "object", "properties": {}}},
]

READ_ONLY_TOOLS = {"list_tasks", "list_reminders", "list_expenses", "list_routines", "get_weather"}


def run_tool(name: str, args: dict) -> str:
    try:
        a = dict(args)
        if name == "add_task":
            return json.dumps({"added": add_task(a["list"], a["title"], a.get("notes", ""), a.get("due", ""))})
        if name == "list_tasks":
            return json.dumps(get_tasks(a.get("list"), bool(a.get("include_done", False))))
        if name == "update_task":
            tid = int(a.pop("id"))
            return json.dumps({"updated": update_task(tid, **a)})
        if name == "remember":
            return json.dumps({"saved": add_memory(a["fact"])})
        if name == "forget":
            return json.dumps({"deleted": delete_memory(int(a["id"]))})
        if name == "set_reminder":
            return json.dumps({"scheduled": add_reminder(a["text"], a["when"])})
        if name == "list_reminders":
            return json.dumps(get_reminders())
        if name == "cancel_reminder":
            return json.dumps({"cancelled": cancel_reminder(int(a["id"]))})
        if name == "log_expense":
            return json.dumps({"logged": log_expense(a["date"], a["merchant"], a["amount"],
                                                     a.get("category", "Other"), a.get("note", ""))})
        if name == "list_expenses":
            return json.dumps(list_expenses(a.get("start", ""), a.get("end", ""), a.get("category", "")))
        if name == "delete_expense":
            return json.dumps({"deleted": delete_expense(int(a["id"]))})
        if name == "create_routine":
            return json.dumps({"created": create_routine(a["name"], a["list"], a["items"],
                                                         a.get("schedule", "none"), a.get("due_days", 0))})
        if name == "list_routines":
            return json.dumps(get_routines())
        if name == "run_routine":
            return json.dumps({"added_tasks": len(run_routine(int(a["id"])))})
        if name == "delete_routine":
            return json.dumps({"deleted": delete_routine(int(a["id"]))})
        if name == "update_settings":
            return json.dumps({"settings": update_settings(**a)})
        if name == "get_weather":
            return json.dumps(get_weather() or {"error": "No weather city set, or weather is unavailable right now."})
        return json.dumps({"error": f"unknown tool {name}"})
    except (ValueError, KeyError, TypeError) as e:
        return json.dumps({"error": str(e)})


def context_block() -> str:
    n = now_local()
    mems = get_memories()
    mem_text = "\n".join(f"- [{m['id']}] {m['fact']}" for m in mems) or "(nothing saved yet)"
    open_tasks = get_tasks()
    task_text = "\n".join(
        f"- [{t['id']}] ({t['list']}) {t['title']}" + (f" — due {t['due']}" if t["due"] else "")
        for t in open_tasks[:60]) or "(no open tasks)"
    rem = get_reminders()
    rem_text = "\n".join(f"- [{r['id']}] {r['fire_at']}: {r['text']}" for r in rem[:20]) or "(none)"
    return f"""Right now it is {n.strftime('%A, %B %-d, %Y, %-I:%M %p')} ({TIMEZONE}).

Things you remember about {USER_NAME} (id in brackets):
{mem_text}

Open tasks:
{task_text}

Upcoming reminders:
{rem_text}"""


def system_prompt(voice: bool = False) -> str:
    style = ("This reply will be SPOKEN aloud by Siri, so answer in one to three natural sentences, "
             "no lists, no markdown, no emoji.") if voice else (
             "Keep replies short and easy to read on a phone. Use short lists only when they help.")
    return f"""You are {ASSISTANT_NAME}, {USER_NAME}'s private personal assistant. You are calm, capable and quietly \
proactive, with a light touch of dry wit — never at the expense of being useful. {style}

You manage {USER_NAME}'s to-do lists (work and personal), memories, reminders (push notifications to their \
phone), an expense log, routines (repeatable checklists) and the schedule of the morning brief and weekly review. \
Use your tools to act, then confirm briefly what you did. Never claim you did something unless a tool result \
confirms it. Turn relative times ("tomorrow at 3", "Friday") into exact local dates/times using the current time.

When {USER_NAME} sends a receipt, log it as an expense (date, merchant, total, a sensible category) and confirm the \
amount. For other photos or PDFs, read them and help with whatever they ask. If something looks overdue or \
important, mention it briefly when relevant.

You cannot yet read email or calendars; if asked, say that's coming in a future update. If asked about the \
weather and no city is saved, ask which city and save it with update_settings.

{context_block()}
"""


def load_history() -> list[dict]:
    with db() as conn:
        rows = conn.execute("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?", (HISTORY_LIMIT,)).fetchall()
    msgs = []
    for r in reversed(rows):
        if msgs and msgs[-1]["role"] == r["role"]:   # merge back-to-back messages from the same side
            msgs[-1]["content"] += "\n\n" + r["content"]
        else:
            msgs.append({"role": r["role"], "content": r["content"]})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


def save_message(role: str, content: str):
    with db() as conn:
        conn.execute("INSERT INTO messages (role, content, created_at) VALUES (?,?,?)", (role, content, now_str()))


_client = None


def get_client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    return _client


def chat_with_claude(user_content, voice: bool = False) -> tuple[str, bool]:
    """user_content is a string or a list of content blocks. Returns (reply, whether anything changed)."""
    history = load_history()
    if history and history[-1]["role"] == "user":    # e.g. a reminder message came last; keep turns alternating
        history.append({"role": "assistant", "content": "(noted)"})
    messages = history + [{"role": "user", "content": user_content}]
    changed = False
    client = get_client()
    for _ in range(MAX_TOOL_ROUNDS):
        resp = client.messages.create(model=MODEL, max_tokens=2048, system=system_prompt(voice),
                                      tools=TOOLS, messages=messages)
        if resp.stop_reason != "tool_use":
            reply = "".join(b.text for b in resp.content if b.type == "text").strip()
            return reply or "(no reply)", changed
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for b in resp.content:
            if b.type == "tool_use":
                if b.name not in READ_ONLY_TOOLS:
                    changed = True
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": run_tool(b.name, dict(b.input))})
        messages.append({"role": "user", "content": results})
    return "Sorry, that took too many steps. Could you ask a simpler way?", changed


def friendly_error(e: Exception) -> str:
    return {
        "AuthenticationError": "The API key was rejected. Check ANTHROPIC_API_KEY on the server.",
        "RateLimitError": "Too many requests right now. Try again in a minute.",
        "APIConnectionError": "Couldn't reach Claude. Try again shortly.",
        "PermissionDeniedError": "The API key doesn't have access. Check your Anthropic account billing.",
        "BadRequestError": "Claude couldn't read that. If you attached a file, try a smaller or clearer one.",
    }.get(type(e).__name__, f"Something went wrong ({type(e).__name__}). Try again.")


class Attachment(BaseModel):
    name: str = Field("file", max_length=200)
    type: str = Field(max_length=100)
    data: str  # base64


class ChatIn(BaseModel):
    message: str = Field("", max_length=8000)
    attachments: list[Attachment] = Field(default_factory=list, max_length=4)


def build_content(text: str, attachments: list[Attachment]):
    if not attachments:
        return text, text
    blocks, labels, total = [], [], 0
    for a in attachments:
        try:
            raw = base64.b64decode(a.data, validate=True)
        except Exception:
            raise HTTPException(400, f"{a.name} couldn't be read")
        total += len(raw)
        if total > MAX_ATTACH_BYTES:
            raise HTTPException(400, "Attachments are too big (10 MB max).")
        if a.type in IMAGE_TYPES:
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": a.type, "data": a.data}})
            labels.append(f"[photo: {a.name}]")
        elif a.type == "application/pdf":
            blocks.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                          "data": a.data}})
            labels.append(f"[PDF: {a.name}]")
        else:
            raise HTTPException(400, f"{a.name}: only photos and PDFs are supported")
    blocks.append({"type": "text", "text": text or "Please look at this."})
    saved_text = " ".join(labels) + (f"\n{text}" if text else "")
    return blocks, saved_text


@app.post("/api/chat")
def api_chat(body: ChatIn, _=Depends(require_auth)):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY is not set on the server")
    text = body.message.strip()
    if not text and not body.attachments:
        raise HTTPException(400, "Say something first")
    content, saved_text = build_content(text, body.attachments)
    try:
        reply, changed = chat_with_claude(content)
    except Exception as e:
        log.warning("chat failed: %r", e)
        raise HTTPException(502, friendly_error(e))
    save_message("user", saved_text)
    save_message("assistant", reply)
    return {"reply": reply, "changed": changed}


# ---- Siri Shortcut: "Hey Siri, Jarvis" -> dictate -> this endpoint -> Siri speaks the reply
class ShortcutIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


@app.post("/api/shortcut", response_class=PlainTextResponse)
def api_shortcut(body: ShortcutIn, request: Request):
    auth = request.headers.get("authorization", "")
    given = auth.removeprefix("Bearer ").strip()
    if _too_many_failures():
        raise HTTPException(429, "Too many wrong tries. Wait 15 minutes.")
    if not given or not hmac.compare_digest(given.encode(), shortcut_token().encode()):
        _failed_logins.append(time.time())
        raise HTTPException(401, "Wrong shortcut key")
    text = body.message.strip()
    try:
        reply, _ = chat_with_claude(text, voice=True)
    except Exception as e:
        log.warning("shortcut chat failed: %r", e)
        return PlainTextResponse(friendly_error(e))
    save_message("user", f"🎙 {text}")
    save_message("assistant", reply)
    return PlainTextResponse(reply)


@app.get("/api/messages")
def api_messages(_=Depends(require_auth)):
    with db() as conn:
        rows = conn.execute("SELECT role, content, created_at FROM messages ORDER BY id DESC LIMIT 60").fetchall()
    return [dict(r) for r in reversed(rows)]


@app.post("/api/messages/clear")
def api_clear_messages(_=Depends(require_auth)):
    with db() as conn:
        conn.execute("DELETE FROM messages")
    return {"ok": True}


# ================================================================ scheduled check-ins
def make_brief(kind: str) -> str:
    """kind = 'morning' or 'weekly'. Written by Claude; falls back to a plain list if Claude is unreachable."""
    today = now_local().date()
    if kind == "morning":
        w = get_weather()
        wx = (f" Today's weather in {w['place']}: {w['condition'].lower()}, {w['temp']}°F now, "
              f"high {w['high']}° / low {w['low']}°. Mention it in a few words.") if w else ""
        ask = (f"Write {USER_NAME}'s morning brief for today.{wx} Lead with a one-line greeting, then what's overdue, "
               "what's due today, and today's reminders. Mention the next few days only if notable. Keep it under "
               "120 words. If there's nothing, say so cheerfully.")
    else:
        week_ago = (today - timedelta(days=7)).isoformat()
        with db() as conn:
            done = conn.execute("SELECT title FROM tasks WHERE done=1 AND done_at>=?", (week_ago,)).fetchall()
        spent = list_expenses(week_ago, today.isoformat())
        ask = (f"Write {USER_NAME}'s weekly review. Cover: what got done last week ({len(done)} tasks: "
               f"{', '.join(r['title'] for r in done[:15]) or 'none'}), what's overdue, what's coming up this week, "
               f"and spending last week (total ${spent['total']}, by category {spent['by_category']}). End with one "
               "suggestion for the week. Keep it under 180 words.")
    try:
        resp = get_client().messages.create(model=MODEL, max_tokens=800, system=system_prompt(),
                                            messages=[{"role": "user", "content": ask}])
        return "".join(b.text for b in resp.content if b.type == "text").strip()
    except Exception as e:
        log.warning("brief via Claude failed (%r); using plain version", e)
        tasks = get_tasks()
        t = today.isoformat()
        overdue = [x["title"] for x in tasks if x["due"] and x["due"][:10] < t]
        due_today = [x["title"] for x in tasks if x["due"][:10] == t]
        lines = ["Good morning!" if kind == "morning" else "Your weekly review:"]
        if overdue:
            lines.append("Overdue: " + "; ".join(overdue))
        if due_today:
            lines.append("Due today: " + "; ".join(due_today))
        if len(lines) == 1:
            lines.append("Nothing due. Enjoy the day.")
        return "\n".join(lines)


def deliver(title: str, text: str, tag: str):
    save_message("assistant", text)
    first_line = text.split("\n", 1)[0]
    send_push(title, text if len(text) < 180 else first_line + " …", tag)


def scheduler_tick(now: datetime | None = None):
    """Runs every 30 seconds. Each job remembers when it last ran, so nothing fires twice."""
    now = now or now_local()
    stamp = now.strftime("%Y-%m-%d %H:%M")
    today = now.date().isoformat()
    dow = WEEKDAYS[now.weekday()]
    hm = now.strftime("%H:%M")

    # 1) reminders that are due
    with db() as conn:
        due = conn.execute("SELECT * FROM reminders WHERE sent=0 AND fire_at<=?", (stamp,)).fetchall()
        for r in due:
            conn.execute("UPDATE reminders SET sent=1 WHERE id=?", (r["id"],))
    for r in due:
        deliver(f"⏰ {ASSISTANT_NAME}", f"Reminder: {r['text']}", f"rem-{r['id']}")

    # 2) morning brief
    days = get_setting("brief_days")
    if days != "off" and (days == "daily" or dow not in ("sat", "sun")):
        if hm >= get_setting("brief_time") and get_setting("last_brief") != today:
            set_setting("last_brief", today)
            deliver(f"☀️ {ASSISTANT_NAME}", make_brief("morning"), "brief")

    # 3) weekly review
    rday = get_setting("review_day")
    if rday != "off" and dow == rday and hm >= get_setting("review_time") and get_setting("last_review") != today:
        set_setting("last_review", today)
        deliver(f"🗓 {ASSISTANT_NAME}", make_brief("weekly"), "review")

    # 4) routines on a schedule (added early morning so they're there for the brief)
    if hm >= "06:00":
        for r in get_routines():
            kind, _, val = r["schedule"].partition(":")
            hit = (kind == "monthly" and int(val) == now.day) or (kind == "weekly" and val == dow)
            if hit and r["last_run"] != today:
                run_routine(r["id"], now.date())
                log.info("ran routine %s", r["name"])


def scheduler_loop():
    # On first start, don't send a brief for a time that already passed today.
    first = now_local()
    for key, tkey in (("last_brief", "brief_time"), ("last_review", "review_time")):
        if not get_setting(key) and first.strftime("%H:%M") >= get_setting(tkey):
            set_setting(key, first.date().isoformat())
    while True:
        try:
            scheduler_tick()
        except Exception:
            log.exception("scheduler tick failed")
        time.sleep(30)


# ================================================================ the phone app (static files)
@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/sw.js")
def service_worker():
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
