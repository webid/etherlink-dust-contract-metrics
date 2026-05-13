# Dust Protocol — Contract Metrics

Indexes all transactions for the Dust Protocol contract on **Etherlink Shadownet** into a local SQLite database and serves a live dashboard.

**Contract:** `0x098ebA92E5a634A3be967E6891F905E2ABe89059`

---

## Quick start

```bash
npm install

# 1. Full initial index (run once)
npm run index:full

# 2. Start the daemon (keep running in background)
npm run daemon

# 3. Start the dashboard server (separate terminal)
npm run server
# → http://localhost:3001
```

---

## Indexer modes

| Command | What it does |
|---|---|
| `npm run index:full` | Wipes the DB and re-indexes every transaction from scratch. Run once on first setup or to rebuild. |
| `npm run daemon` | Incremental sync, then enters a polling loop — checks for new transactions every 30 s. **Normal always-on mode.** |
| `npm run index` | One-shot incremental sync: fetches only transactions newer than the last checkpoint, then exits. |
| `npm run stats` | Prints a summary to the terminal (total txs, top methods, top wallets, newest block). No DB changes. |
| `npm run server` | Starts the dashboard HTTP server on port 3001. |

---

## Resilience

- **Per-page checkpointing** — newest transaction hash is written to the DB after every API page. Killed mid-run? Resumes where it left off.
- **Exponential backoff** — rate limits, timeouts, and 5xx errors are retried automatically, backing off from 2 s up to 5 minutes.
- **Graceful shutdown** — `Ctrl+C` (SIGINT/SIGTERM) lets the current page finish, flushes the DB, then exits cleanly.
- **WAL mode SQLite** — dashboard server reads while the daemon writes; no locking conflicts.
- **Port conflict detection** — if the dashboard port is already in use, the server prints clear instructions and exits rather than crashing silently.

---

## Adding method name aliases

Raw 4-byte selectors are stored in the DB. Human-readable names are resolved at query time in `server.js`:

```js
// server.js — METHOD_ALIASES block
const METHOD_ALIASES = {
  '0x1650221f': 'buymaxcompression',
  '0xe5350791': 'buymaxall',
  // add new entries here
};
```

After editing, restart `server.js`. No re-indexing needed.

---

## Configuration

Edit these constants at the top of `indexer.js` if needed:

| Constant | Default | Description |
|---|---|---|
| `POLL_INTERVAL_S` | `30` | Seconds between daemon sync cycles |
| `PAGE_DELAY_MS` | `200` | Delay between API page requests |
| `MAX_BACKOFF_MS` | `300000` | Max retry wait (5 min) |

Dashboard port (default `3001`):

```bash
PORT=8080 npm run server
```

---

## Hosting on Ubuntu VPS (with nginx, subfolder `/dustwatch/`)

The dashboard is designed to be served under a subfolder path. Nginx strips the `/dustwatch/` prefix before proxying to the Node server, so all internal paths resolve correctly.

### 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v  # should print v20.x.x
```

### 2. Clone and install

```bash
cd /opt
sudo git clone <your-repo-url> dustwatch
sudo chown -R $USER:$USER /opt/dustwatch
cd /opt/dustwatch
npm install
```

### 4. Run the initial full index

```bash
node indexer.js --full
```

This may take several minutes depending on how many transactions are on-chain.

### 5. Start processes with pm2

```bash
sudo npm install -g pm2

# Start both processes (working directory is resolved automatically)
pm2 start ecosystem.config.js

# Save the process list and enable startup on boot
pm2 save
pm2 startup   # follow the printed command to register the init hook
```

Useful pm2 commands:

```bash
pm2 status                        # overview of all processes
pm2 logs dustwatch-indexer        # live indexer logs
pm2 logs dustwatch-server         # live server logs
pm2 restart dustwatch-server      # restart after config changes
pm2 stop all                      # stop everything
```

### 6. Configure nginx

Add this `location` block inside your existing `server {}` block:

```nginx
location /dustwatch/ {
    proxy_pass         http://127.0.0.1:3001/;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
}
```

> **Note:** The trailing slash on `proxy_pass http://127.0.0.1:3001/` is required — it tells nginx to strip the `/dustwatch/` prefix before forwarding to Node.

Reload nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The dashboard is now live at `https://yourdomain.com/dustwatch/`.

### Alternative: Apache

Steps 1–4 (Node.js, clone, install, systemd services) are identical. Only the web server config differs.

Enable the required modules:

```bash
sudo a2enmod proxy proxy_http headers
sudo systemctl restart apache2
```

Add this block inside your `<VirtualHost>` in `/etc/apache2/sites-available/your-site.conf`:

```apache
ProxyRequests     Off
ProxyPreserveHost On

<Location /dustwatch/>
    ProxyPass        http://127.0.0.1:3001/
    ProxyPassReverse http://127.0.0.1:3001/
    RequestHeader    set X-Forwarded-Proto "https"
</Location>
```

> **Note:** Unlike nginx, Apache's `ProxyPass` does the prefix stripping via explicit path-to-path mapping — `/dustwatch/` maps to `/` on the backend. `ProxyPassReverse` rewrites any `Location:` redirect headers the backend might send.

```bash
sudo apache2ctl configtest && sudo systemctl reload apache2
```

Dashboard live at `https://yourdomain.com/dustwatch/`.

---

## Files

```
indexer.js          — indexer daemon
server.js           — dashboard API + static file server
metrics/index.html  — live dashboard UI
dust_protocol.db    — SQLite database (created on first run)
package.json        — npm scripts
```
