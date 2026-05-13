#!/usr/bin/env node
/**
 * Dust Protocol Contract Indexer — Resilient Daemon
 * Contract: 0x098ebA92E5a634A3be967E6891F905E2ABe89059 (Etherlink Shadownet)
 *
 * Modes:
 *   node indexer.js               # Incremental sync once, then exit
 *   node indexer.js --daemon      # Run forever, polling every POLL_INTERVAL_S seconds
 *   node indexer.js --full        # Full re-index from scratch, then exit
 *   node indexer.js --stats       # Print DB stats and exit
 *
 * Resilience:
 *   - Exponential backoff on API errors (caps at 5 min)
 *   - newest_tx_hash checkpoint written after EVERY page (not just at end)
 *   - Graceful SIGINT/SIGTERM: finishes current page, flushes DB, exits cleanly
 *   - WAL-mode SQLite — safe for concurrent reads from the dashboard server
 */

'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const https    = require('https');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONTRACT  = '0x098ebA92E5a634A3be967E6891F905E2ABe89059';
const API_BASE  = 'https://shadownet.explorer.etherlink.com/api/v2';
const DB_PATH   = path.join(__dirname, 'dust_protocol.db');

const POLL_INTERVAL_S = 30;   // seconds between daemon cycles
const PAGE_DELAY_MS   = 200;  // delay between API pages (~300 req/min)
const MAX_BACKOFF_MS  = 5 * 60 * 1000; // 5 minutes

// ─── Graceful shutdown flag ───────────────────────────────────────────────────

let shuttingDown = false;

function setupShutdownHandlers(db) {
  const handler = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n⚡ ${signal} received — finishing current page, then exiting...`);
    // Give up to 3 seconds for in-flight work to notice the flag
    setTimeout(() => {
      try { db.close(); } catch (_) {}
      console.log('👋 Indexer stopped cleanly.');
      process.exit(0);
    }, 3000);
  };
  process.on('SIGINT',  () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

// ─── DB Setup ─────────────────────────────────────────────────────────────────

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous  = NORMAL');
  db.pragma('cache_size   = -16000'); // 16 MB page cache

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      hash         TEXT PRIMARY KEY,
      block_number INTEGER NOT NULL,
      timestamp    TEXT NOT NULL,
      from_addr    TEXT NOT NULL,
      to_addr      TEXT,
      method       TEXT,
      status       TEXT,
      gas_used     INTEGER,
      gas_price    TEXT,
      value_wei    TEXT,
      fee_wei      TEXT,
      tx_types     TEXT,
      decoded_fn   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_from_addr  ON transactions(from_addr);
    CREATE INDEX IF NOT EXISTS idx_method     ON transactions(method);
    CREATE INDEX IF NOT EXISTS idx_block      ON transactions(block_number);
    CREATE INDEX IF NOT EXISTS idx_timestamp  ON transactions(timestamp);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return db;
}

// Thin wrappers to read/write meta keys
function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function fetchJson(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'dust-indexer/2.0' },
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode === 429) { reject(Object.assign(new Error('RATE_LIMIT'), { code: 'RATE_LIMIT' })); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`HTTP_${res.statusCode}`)); return; }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON_PARSE: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    req.on('error',   reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch with exponential backoff. Retries on network/rate errors indefinitely
 * (within reason) so the daemon never gives up on transient failures.
 */
async function fetchWithBackoff(url, context = '') {
  let backoff = 2000;
  let attempt = 0;
  while (true) {
    if (shuttingDown) throw new Error('SHUTDOWN');
    try {
      return await fetchJson(url);
    } catch (err) {
      attempt++;
      const isRetryable = err.code === 'RATE_LIMIT'
        || err.message.startsWith('TIMEOUT')
        || err.message.startsWith('HTTP_5')
        || err.code === 'ECONNRESET'
        || err.code === 'ECONNREFUSED'
        || err.code === 'ETIMEDOUT';

      if (!isRetryable) throw err; // e.g. 404, JSON parse — fatal for this page

      const wait = Math.min(backoff, MAX_BACKOFF_MS);
      console.warn(`\n  ⚠️  ${context} — ${err.message}. Retry #${attempt} in ${(wait/1000).toFixed(0)}s...`);
      await sleep(wait);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

// ─── Page URL builder ─────────────────────────────────────────────────────────

function pageUrl(cursor = null) {
  const base = `${API_BASE}/addresses/${CONTRACT}/transactions`;
  if (!cursor) return base;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(cursor)) {
    if (v !== undefined && v !== null) q.set(k, v);
  }
  return `${base}?${q}`;
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

function toRow(tx) {
  return {
    hash:         tx.hash,
    block_number: tx.block_number,
    timestamp:    tx.timestamp,
    from_addr:    tx.from?.hash ?? '',
    to_addr:      tx.to?.hash   ?? null,
    method:       tx.method     ?? null,
    status:       tx.status     ?? null,
    gas_used:     tx.gas_used   != null ? parseInt(tx.gas_used, 10) : null,
    gas_price:    tx.gas_price  ?? null,
    value_wei:    tx.value      ?? null,
    fee_wei:      tx.fee?.value ?? null,
    tx_types:     tx.transaction_types ? JSON.stringify(tx.transaction_types) : null,
    decoded_fn:   tx.decoded_input?.method_call ?? null,
  };
}

// ─── Prepared insert (reused across pages) ───────────────────────────────────

function makeInserter(db) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (hash, block_number, timestamp, from_addr, to_addr, method, status,
       gas_used, gas_price, value_wei, fee_wei, tx_types, decoded_fn)
    VALUES
      (@hash, @block_number, @timestamp, @from_addr, @to_addr, @method, @status,
       @gas_used, @gas_price, @value_wei, @fee_wei, @tx_types, @decoded_fn)
  `);
  return db.transaction((rows) => { for (const r of rows) stmt.run(r); });
}

// ─── Full index ───────────────────────────────────────────────────────────────

async function runFullIndex(db) {
  console.log('🔄  Full re-index — clearing existing data...');
  db.exec('DELETE FROM transactions; DELETE FROM meta;');

  const counters = await fetchWithBackoff(`${API_BASE}/addresses/${CONTRACT}/counters`, 'counters');
  const total    = parseInt(counters.transactions_count, 10) || 0;
  console.log(`📊  On-chain total: ${total.toLocaleString()} transactions`);

  const insertMany = makeInserter(db);
  let cursor  = null;
  let fetched = 0;
  let page    = 0;

  while (!shuttingDown) {
    const resp  = await fetchWithBackoff(pageUrl(cursor), `page ${page + 1}`);
    const items = resp.items ?? [];
    if (items.length === 0) break;

    const rows = items.map(toRow);
    insertMany(rows);
    fetched += rows.length;
    page++;

    // ── Checkpoint after EVERY page ──
    // Save the newest hash (first item on page 1) and the cursor position
    if (page === 1) {
      setMeta(db, 'newest_tx_hash',  rows[0].hash);
      setMeta(db, 'newest_block',    rows[0].block_number);
    }
    setMeta(db, 'full_index_page',   page);
    setMeta(db, 'last_indexed_at',   new Date().toISOString());

    const pct = total > 0 ? ((fetched / total) * 100).toFixed(1) : '?';
    process.stdout.write(`\r  Page ${page} — ${fetched.toLocaleString()}/${total.toLocaleString()} (${pct}%)`);

    cursor = resp.next_page_params;
    if (!cursor) break;
    await sleep(PAGE_DELAY_MS);
  }

  process.stdout.write('\n');

  if (!shuttingDown) {
    setMeta(db, 'full_index_complete', '1');
    console.log(`✅  Full index done — ${fetched.toLocaleString()} transactions stored.`);
  } else {
    console.log(`⏸   Interrupted at page ${page} (${fetched.toLocaleString()} stored). Resume with --daemon or re-run --full.`);
  }
}

// ─── Incremental sync (also used by daemon) ───────────────────────────────────

async function runIncremental(db, quiet = false) {
  const newestKnown = getMeta(db, 'newest_tx_hash');

  if (!newestKnown) {
    if (!quiet) console.log('ℹ️   No index found — run with --full first.');
    return 0;
  }

  const insertMany = makeInserter(db);
  let cursor  = null;
  let fetched = 0;
  let page    = 0;
  let done    = false;

  while (!shuttingDown && !done) {
    const resp  = await fetchWithBackoff(pageUrl(cursor), `incremental page ${page + 1}`);
    const items = resp.items ?? [];
    if (items.length === 0) break;

    const newRows = [];
    for (const tx of items) {
      if (tx.hash === newestKnown) { done = true; break; }
      newRows.push(toRow(tx));
    }

    if (newRows.length > 0) {
      insertMany(newRows);
      fetched += newRows.length;
      page++;

      // ── Checkpoint: update newest_tx_hash after every page ──
      setMeta(db, 'newest_tx_hash', newRows[0].hash);        // newest in this batch
      setMeta(db, 'newest_block',   newRows[0].block_number);
      setMeta(db, 'last_indexed_at', new Date().toISOString());

      if (!quiet) process.stdout.write(`\r  +${fetched} new txs (page ${page})`);
    }

    if (done || !resp.next_page_params) break;
    cursor = resp.next_page_params;
    await sleep(PAGE_DELAY_MS);
  }

  if (!quiet && fetched > 0) process.stdout.write('\n');
  return fetched;
}

// ─── Daemon loop ──────────────────────────────────────────────────────────────

async function runDaemon(db) {
  console.log(`🚀  Daemon started — polling every ${POLL_INTERVAL_S}s`);
  console.log(`    Contract : ${CONTRACT}`);
  console.log(`    DB       : ${DB_PATH}`);
  console.log('    Press Ctrl+C to stop cleanly.\n');

  let cycle   = 0;
  let backoff = POLL_INTERVAL_S * 1000;

  while (!shuttingDown) {
    cycle++;
    const ts = new Date().toLocaleTimeString();
    process.stdout.write(`[${ts}] Cycle ${cycle} — `);

    try {
      const fetched = await runIncremental(db, true);
      if (fetched > 0) {
        const total = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
        console.log(`+${fetched} new txs (total: ${total.toLocaleString()})`);
      } else {
        console.log('up to date.');
      }
      backoff = POLL_INTERVAL_S * 1000; // reset backoff on success
    } catch (err) {
      if (err.message === 'SHUTDOWN') break;
      console.error(`\n  ❌ Cycle error: ${err.message}`);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      console.log(`  ↩️  Backing off ${(backoff / 1000).toFixed(0)}s before next cycle...`);
    }

    // Sleep in 1-second chunks so SIGINT is noticed quickly
    let slept = 0;
    while (!shuttingDown && slept < backoff) {
      await sleep(1000);
      slept += 1000;
    }
  }

  console.log('\n👋  Daemon exiting.');
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function printStats(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
  if (total === 0) { console.log('📭  DB is empty.'); return; }

  const lastIndexed = getMeta(db, 'last_indexed_at', 'unknown');
  const newestBlock = getMeta(db, 'newest_block',    'unknown');

  console.log('\n════════════════════════════════════════════════════');
  console.log('  Dust Protocol — Indexer Stats');
  console.log('════════════════════════════════════════════════════');
  console.log(`  Total transactions : ${total.toLocaleString()}`);
  console.log(`  Newest block       : ${newestBlock}`);
  console.log(`  Last indexed at    : ${lastIndexed}`);

  console.log('\n── Methods ──────────────────────────────────────────');
  db.prepare(`SELECT COALESCE(method,'(unknown)') m, COUNT(*) c FROM transactions GROUP BY m ORDER BY c DESC LIMIT 10`).all()
    .forEach(r => console.log(`  ${r.m.padEnd(30)} ${r.c.toLocaleString().padStart(8)}`));

  console.log('\n── Top Wallets ──────────────────────────────────────');
  db.prepare(`SELECT from_addr, COUNT(*) c FROM transactions GROUP BY from_addr ORDER BY c DESC LIMIT 10`).all()
    .forEach(r => console.log(`  ${r.from_addr}  ${r.c.toLocaleString().padStart(6)}`));

  const uniq = db.prepare('SELECT COUNT(DISTINCT from_addr) AS n FROM transactions').get().n;
  console.log(`\n  Unique wallets: ${uniq.toLocaleString()}`);
  console.log('════════════════════════════════════════════════════\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const mode   = args.includes('--full')   ? 'full'
               : args.includes('--daemon') ? 'daemon'
               : args.includes('--stats')  ? 'stats'
               : 'incremental';

  const db = openDb();
  setupShutdownHandlers(db);

  try {
    switch (mode) {
      case 'stats':
        printStats(db);
        break;
      case 'full':
        await runFullIndex(db);
        printStats(db);
        break;
      case 'daemon':
        await runDaemon(db);
        break;
      default: { // incremental
        const n = await runIncremental(db, false);
        const total = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
        const uniq  = db.prepare('SELECT COUNT(DISTINCT from_addr) AS n FROM transactions').get().n;
        if (n > 0) console.log(`✅  +${n} new txs stored.`);
        else       console.log('✅  Already up to date.');
        console.log(`📊  DB: ${total.toLocaleString()} txs | ${uniq.toLocaleString()} unique wallets | newest block: ${getMeta(db, 'newest_block')}`);
      }
    }
  } catch (err) {
    if (err.message !== 'SHUTDOWN') {
      console.error('❌  Fatal:', err.message);
      process.exit(1);
    }
  } finally {
    try { db.close(); } catch (_) {}
  }
}

main();
