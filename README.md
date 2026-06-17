# Server Monitor

A production-ready **server monitoring dashboard** built with **Node.js + Express + Bootstrap 5 + SQLite**.
No Docker required. Clone, run one script, and the dashboard is live.

![status](https://img.shields.io/badge/status-production--ready-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D18-339933)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- **Dashboard** — realtime CPU, RAM, Disk, Uptime, OS info, Network traffic, Server load (auto-refresh).
- **Monitoring** — status of PM2, Node, MySQL/MariaDB, Redis, Nginx, OpenLiteSpeed, Postfix.
- **Mail** — Postfix queue (total / pending / active / failed) and SMTP listener status.
- **Logs** — view error & system logs, live search, and one-click download.
- **Alerts** — automatic alerts when CPU / RAM / Disk exceed configurable thresholds.
- **Settings** — change password, change port, adjust thresholds, logout.
- **Modern UI** — Bootstrap 5, dark mode, responsive sidebar layout, live charts.
- **Secure auth** — bcrypt password hashing, session-based login with idle auto-timeout, login rate limiting, Helmet security headers.

---

## Requirements

- Ubuntu / Debian server (the installer targets `apt`).
- Ability to run `sudo` (for installing Node.js, PM2 and opening the firewall port).
- The installer handles everything else (Node.js LTS, PM2, dependencies, DB, firewall).

---

## Quick Start

```bash
git clone <your-repo-url> server-monitor
cd server-monitor
bash install.sh
```

When it finishes you'll see:

```
==================================
 SERVER MONITOR INSTALLED

 URL:
 http://SERVER_IP:19091

 LOGIN:
 admin

 STATUS:
 RUNNING
==================================
```

Open the URL in your browser and sign in.

### Default credentials

| Field    | Value           |
|----------|-----------------|
| Username | `admin`         |
| Password | `Jakarta1412@@` |

> The password is **never hardcoded in the database**. During install it is read from
> `ADMIN_PASSWORD` in `.env`, hashed with **bcrypt**, and only the hash is stored.
> **Change it after first login** via *Settings → Change Password*.

---

## Configuration (`.env`)

`install.sh` generates `.env` from `.env.example` and injects a random `SESSION_SECRET`.

| Variable                  | Default              | Description                                    |
|---------------------------|----------------------|------------------------------------------------|
| `PORT`                    | `19091`              | HTTP port the dashboard listens on.            |
| `HOST`                    | `0.0.0.0`            | Interface to bind to.                           |
| `NODE_ENV`                | `production`         | Runtime environment.                            |
| `SESSION_SECRET`          | _(auto-generated)_   | Cookie signing secret.                          |
| `SESSION_TIMEOUT_MINUTES` | `30`                 | Idle auto-logout timeout.                       |
| `SECURE_COOKIE`           | `false`              | Set `true` when serving over HTTPS.             |
| `ADMIN_USERNAME`          | `admin`              | Admin username (seed only).                     |
| `ADMIN_PASSWORD`          | `Jakarta1412@@`      | Admin password (seed only, hashed on install).  |
| `ALERT_CPU_THRESHOLD`     | `90`                 | CPU alert threshold (%).                         |
| `ALERT_RAM_THRESHOLD`     | `90`                 | RAM alert threshold (%).                         |
| `ALERT_DISK_THRESHOLD`    | `90`                 | Disk alert threshold (%).                        |
| `SYSTEM_LOG_PATHS`        | _see file_           | `Label:/path` list of system logs.              |
| `ERROR_LOG_PATHS`         | _see file_           | `Label:/path` list of error logs.               |

### Changing the port

Edit `PORT` in `.env` (or use *Settings → Change Port*), then restart:

```bash
pm2 restart server-monitor
# or
bash start.sh
```

Remember to open the new port in your firewall: `sudo ufw allow <port>/tcp`.

---

## Scripts

| Command            | What it does                                                        |
|--------------------|---------------------------------------------------------------------|
| `bash install.sh`  | Full install: deps, Node.js, DB, admin, PM2, firewall, startup.     |
| `bash start.sh`    | Start / restart the app via PM2.                                    |
| `bash stop.sh`     | Stop the app.                                                       |
| `bash update.sh`   | `git pull`, update deps, migrate DB, restart.                       |

### PM2 cheatsheet

```bash
pm2 list                    # show processes
pm2 logs server-monitor     # tail logs
pm2 restart server-monitor  # restart
pm2 stop server-monitor     # stop
pm2 monit                   # live monitor
```

---

## Project structure

```
server-monitor/
├── install.sh              # one-shot installer
├── start.sh / stop.sh      # process control
├── update.sh               # pull + migrate + restart
├── ecosystem.config.js     # PM2 process definition
├── server.js               # Express app entrypoint
├── package.json
├── .env.example
├── config/                 # env-driven configuration
├── database/               # db connection, migrate, seed
├── repositories/           # SQL data access (users, settings, alerts)
├── services/               # system/services/mail/logs/alerts collectors
├── controllers/            # request handlers
├── routes/                 # auth, pages, api routers
├── middleware/             # auth guards, error handling
├── views/                  # EJS templates (+ partials)
├── public/                 # CSS & client JS
├── logs/                   # runtime + PM2 logs
└── storage/                # SQLite database & session store
```

---

## How it works

- **System metrics** are collected with [`systeminformation`](https://www.npmjs.com/package/systeminformation).
- **Service status** is resolved via `systemctl is-active` with a `pgrep` fallback.
- **PM2 data** comes from `pm2 jlist`.
- **Mail** is read from `postqueue -p` / `mailq` and TCP probes of ports 25/587.
- **Alerts** run on a background interval and are stored in SQLite.
- The browser polls lightweight JSON endpoints under `/api/*` for realtime updates.

---

## Security notes

- Passwords hashed with bcrypt (cost 12); plaintext never stored.
- Session cookies are `httpOnly`, `sameSite=lax`, and `secure` when `SECURE_COOKIE=true`.
- Login is rate-limited; sessions are regenerated on login to prevent fixation.
- Helmet sets a strict Content-Security-Policy.
- Log file access is restricted to the whitelisted paths in `.env`.

For internet-facing deployments, place this behind **Nginx + HTTPS** and set `SECURE_COOKIE=true`.

---

## License

MIT
