#!/usr/bin/env node
/**
 * Dust Protocol Dashboard Server
 * Serves the live metrics UI and a JSON API backed by the SQLite DB.
 *
 * Usage:  node server.js          (default port 3001)
 *         PORT=8080 node server.js
 *
 * The indexer writes to the DB; this server reads from it (WAL mode allows
 * safe concurrent access without blocking the indexer).
 */

'use strict';

const Database = require('better-sqlite3');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');

const PORT    = parseInt(process.env.PORT ?? '3001', 10);
const DB_PATH = path.join(__dirname, 'dust_protocol.db');
const UI_PATH = path.join(__dirname, 'metrics', 'index.html');

// ─── DB (read-only, re-opened per request or kept open) ───────────────────────

let db;

function getDb() {
  if (!db || !db.open) {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: false });
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function safeQuery(fn) {
  try {
    return fn(getDb());
  } catch (err) {
    // DB may not exist yet (indexer hasn't run)
    if (err.message.includes('no such table') || err.message.includes('SQLITE_CANTOPEN')) {
      return null;
    }
    throw err;
  }
}

// ─── API helpers ──────────────────────────────────────────────────────────────

function getMeta(db, key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch (_) { return fallback; }
}

const SPAM_FEE_WEI = 100000000000000; // 0.0001 XTZ in wei

// ─── Method aliases (selector → readable name) ───────────────────────────────
// Add new mappings here as methods are identified.
const METHOD_ALIASES = {
  '0x1650221f': 'buymaxcompression',
  '0xe5350791': 'buymaxall',
};

// Reverse map: readable name → selector (for method-detail lookups)
const METHOD_ALIASES_REV = Object.fromEntries(
  Object.entries(METHOD_ALIASES).map(([k, v]) => [v, k])
);

function resolveMethod(raw) {
  return METHOD_ALIASES[raw] ?? raw;
}

// Given a display name (possibly aliased), return the raw DB value
function unresolveMethod(name) {
  return METHOD_ALIASES_REV[name] ?? name;
}

function buildApiResponse(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM transactions').get()?.n ?? 0;
  const uniq  = db.prepare('SELECT COUNT(DISTINCT from_addr) AS n FROM transactions').get()?.n ?? 0;

  // Fee aggregations — stored as TEXT, sum as REAL then divide
  const feeRow = db.prepare(`
    SELECT
      SUM(CAST(fee_wei   AS REAL)) AS total_net_wei,
      SUM(CAST(value_wei AS REAL)) AS total_spam_wei
    FROM transactions
    WHERE fee_wei IS NOT NULL
  `).get();
  const totalNetworkFeesXtz = (feeRow?.total_net_wei  ?? 0) / 1e18;
  const totalSpamXtz        = (feeRow?.total_spam_wei ?? 0) / 1e18;

  const methods = db.prepare(`
    SELECT
      COALESCE(method, '(unknown)') AS method,
      COUNT(*) AS count,
      SUM(CAST(fee_wei   AS REAL)) / 1e18 AS net_fees_xtz,
      SUM(CAST(value_wei AS REAL)) / 1e18 AS spam_xtz
    FROM transactions
    GROUP BY method
    ORDER BY count DESC
    LIMIT 15
  `).all().map(m => ({ ...m, method: resolveMethod(m.method) }));

  const wallets = db.prepare(`
    SELECT
      from_addr,
      COUNT(*) AS count,
      SUM(CAST(fee_wei   AS REAL)) / 1e18 AS net_fees_xtz,
      SUM(CAST(value_wei AS REAL)) / 1e18 AS spam_xtz
    FROM transactions
    GROUP BY from_addr
    ORDER BY count DESC
    LIMIT 20
  `).all();

  const daily = db.prepare(`
    SELECT DATE(timestamp) AS day, COUNT(*) AS count
    FROM transactions
    WHERE timestamp >= DATE('now', '-30 days')
    GROUP BY day
    ORDER BY day ASC
  `).all();

  // Hour-of-day activity (0-23), last 30 days — for heatmap
  const hourly = (() => {
    const rows = db.prepare(`
      SELECT CAST(strftime('%H', timestamp) AS INTEGER) AS hour,
             COUNT(*) AS count
      FROM transactions
      WHERE timestamp >= DATETIME('now', '-30 days')
      GROUP BY hour
      ORDER BY hour ASC
    `).all();
    // Fill all 24 hours (missing hours = 0)
    const map = Object.fromEntries(rows.map(r => [r.hour, r.count]));
    return Array.from({ length: 24 }, (_, h) => ({ hour: h, count: map[h] ?? 0 }));
  })();

  const recent = db.prepare(`
    SELECT hash, block_number, timestamp, from_addr, method, status, gas_used, fee_wei, value_wei
    FROM transactions
    ORDER BY block_number DESC, rowid DESC
    LIMIT 50
  `).all().map(tx => ({ ...tx, method: resolveMethod(tx.method) }));

  const todayCount = db.prepare(`
    SELECT COUNT(*) AS n FROM transactions WHERE DATE(timestamp) = DATE('now')
  `).get()?.n ?? 0;

  const newestBlock   = getMeta(db, 'newest_block',    null);
  const lastIndexedAt = getMeta(db, 'last_indexed_at', null);
  const fullComplete  = getMeta(db, 'full_index_complete', '0') === '1';

  return {
    summary: { total, uniq, todayCount, newestBlock, lastIndexedAt, fullComplete, totalNetworkFeesXtz, totalSpamXtz },
    methods,
    wallets,
    daily,
    hourly,
    recent,
  };
}

function buildMethodDetail(db, displayMethod) {
  // Translate aliased name back to raw selector for DB lookup
  const rawMethod = unresolveMethod(displayMethod);

  const wallers = db.prepare(`
    SELECT
      from_addr,
      COUNT(*) AS count,
      SUM(CAST(fee_wei   AS REAL)) / 1e18 AS net_fees_xtz,
      SUM(CAST(value_wei AS REAL)) / 1e18 AS spam_xtz
    FROM transactions
    WHERE COALESCE(method, '(unknown)') = ?
    GROUP BY from_addr
    ORDER BY count DESC
    LIMIT 10
  `).all(rawMethod);

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS count,
      SUM(CAST(fee_wei   AS REAL)) / 1e18 AS net_fees_xtz,
      SUM(CAST(value_wei AS REAL)) / 1e18 AS spam_xtz
    FROM transactions
    WHERE COALESCE(method, '(unknown)') = ?
  `).get(rawMethod);

  return { method: displayMethod, totals, wallets: wallers };
}

// ─── Router ───────────────────────────────────────────────────────────────────

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

function handleRequest(req, res) {
  const rawUrl = req.url;
  const url    = rawUrl.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── /api/data ──
  if (url === '/api/data') {
    res.setHeader('Content-Type', 'application/json');
    const data = safeQuery(buildApiResponse);
    if (!data) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'DB not ready — run indexer first.' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify(data));
    return;
  }

  // ── /api/method-detail?method=... ──
  if (url === '/api/method-detail') {
    res.setHeader('Content-Type', 'application/json');
    const qs     = new URLSearchParams(rawUrl.split('?')[1] ?? '');
    const method = qs.get('method');
    if (!method) { res.writeHead(400); res.end(JSON.stringify({ error: 'method param required' })); return; }
    const data = safeQuery(db => buildMethodDetail(db, method));
    if (!data) { res.writeHead(503); res.end(JSON.stringify({ error: 'DB not ready' })); return; }
    res.writeHead(200);
    res.end(JSON.stringify(data));
    return;
  }

  // ── Ping / health ──
  if (url === '/api/ping') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  // ── Static files ──
  const filePath = url === '/' ? UI_PATH : path.join(__dirname, 'metrics', url);
  const ext      = path.extname(filePath);
  const mime     = MIME[ext] ?? 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} is already in use.`);
    console.error(`    Find the process : lsof -ti:${PORT}`);
    console.error(`    Kill it          : lsof -ti:${PORT} | xargs kill -9`);
    console.error(`    Or use another port: PORT=3002 npm run server\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🌐  Dashboard server running at http://localhost:${PORT}`);
  console.log(`    API endpoint: http://localhost:${PORT}/api/data`);
  console.log('    Press Ctrl+C to stop.\n');
});

process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

