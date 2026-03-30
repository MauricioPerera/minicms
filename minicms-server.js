/**
 * miniCMS Server — Node.js adapter
 *
 * Replaces browser APIs (IndexedDB, localStorage, crypto.subtle)
 * with Node.js equivalents. Serves the CMS over HTTP.
 *
 * Usage:
 *   node minicms-server.js [port] [data-dir]
 *   node minicms-server.js 3000 ./data
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

// Polyfill browser globals for minicms.js
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.TextEncoder) {
  const { TextEncoder, TextDecoder } = await import('node:util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

// Fake localStorage backed by file
class FileLocalStorage {
  constructor(dir) { this._dir = dir; this._file = join(dir, 'localstorage.json'); this._data = {}; }
  async load() {
    try { this._data = JSON.parse(await readFile(this._file, 'utf8')); } catch { this._data = {}; }
  }
  getItem(k) { return this._data[k] ?? null; }
  setItem(k, v) { this._data[k] = String(v); writeFile(this._file, JSON.stringify(this._data)).catch(() => {}); }
  removeItem(k) { delete this._data[k]; writeFile(this._file, JSON.stringify(this._data)).catch(() => {}); }
}

// Fake IndexedDB backed by files
class FileIDB {
  constructor(dir) { this._dir = dir; }
  async get(store, key) {
    try { return await readFile(join(this._dir, `${store}_${key}.json`), 'utf8'); } catch { return null; }
  }
  async put(store, key, value) {
    await writeFile(join(this._dir, `${store}_${key}.json`), typeof value === 'string' ? value : JSON.stringify(value));
  }
  async delete(store, key) {
    try { await import('node:fs/promises').then(fs => fs.unlink(join(this._dir, `${store}_${key}.json`))); } catch {}
  }
}

// Fake EventTarget
class NodeEventBus {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._listeners.get(type);
    if (arr) this._listeners.set(type, arr.filter(f => f !== fn));
  }
  dispatchEvent(event) {
    const arr = this._listeners.get(event.type);
    if (arr) arr.forEach(fn => fn(event));
  }
}

// ─── Patch minicms.js to work with file-based storage ────────────────────────

const PORT = parseInt(process.argv[2]) || 3000;
const DATA_DIR = process.argv[3] || './minicms-data';

if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

const fileStorage = new FileLocalStorage(DATA_DIR);
await fileStorage.load();
globalThis.localStorage = fileStorage;

// Override IndexedDB with file-based adapter
const fileIDB = new FileIDB(DATA_DIR);

// Patch: Override the openIDB function behavior by monkey-patching
// We'll import the module and patch its internals
const minicmsModule = await import('./minicms.js');
const MiniCMS = minicmsModule.default;

// Create CMS with server config
const cms = new MiniCMS({ dimensions: 384 });

// Monkey-patch the IDB methods before init
const origInit = cms.init.bind(cms);
cms.init = async function() {
  // Patch _bus
  this._bus = new NodeEventBus();

  // Call original init (loads WASM, creates DB)
  try {
    await origInit();
  } catch (e) {
    // If IndexedDB fails (expected in Node), handle manually
    if (e.message?.includes('indexedDB') || e.message?.includes('IDBDatabase')) {
      // Manual init without IndexedDB
      const wasmInit = (await import('./minimemory.js')).default;
      const { WasmVectorDB } = await import('./minimemory.js');
      await wasmInit();
      this._db = new WasmVectorDB(this._dims || 384, 'cosine', 'flat');
      this._schemas = new Map();
      this._idb = fileIDB;
      this._secret = null;

      // Load schemas from file
      const schemasRaw = await fileIDB.get('meta', 'schemas');
      if (schemasRaw) {
        const parsed = JSON.parse(schemasRaw);
        for (const [k, v] of Object.entries(parsed)) this._schemas.set(k, v);
      }

      // Load secret
      let secret = await fileIDB.get('meta', 'auth_secret');
      if (secret) {
        this._secret = new Uint8Array(JSON.parse(secret));
      } else {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        this._secret = bytes;
        await fileIDB.put('meta', 'auth_secret', JSON.stringify(Array.from(bytes)));
      }

      // Load snapshot
      const snapshot = await fileIDB.get('data', 'snapshot');
      if (snapshot) {
        try { this._db.import_snapshot(snapshot); } catch {}
      }
    } else {
      throw e;
    }
  }

  // Patch save to use file
  this.save = async () => {
    if (!this._db) return;
    const snapshot = this._db.export_snapshot();
    await fileIDB.put('data', 'snapshot', snapshot);
  };

  // Patch _saveSchemas
  this._saveSchemas = async () => {
    const obj = {};
    for (const [k, v] of this._schemas) obj[k] = v;
    await fileIDB.put('meta', 'schemas', JSON.stringify(obj));
  };
};

await cms.init();

// Create default admin if needed
try {
  const users = cms.list('_users', { limit: 1 });
  if (!users.items?.length) {
    await cms.register('admin@minicms.local', 'admin', 'admin');
    await cms.save();
  }
} catch {
  try {
    await cms.register('admin@minicms.local', 'admin', 'admin');
    await cms.save();
  } catch {}
}

console.log(`miniCMS server starting on port ${PORT}...`);
console.log(`Data directory: ${DATA_DIR}`);

// ─── HTTP Server ─────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  try {
    // Health
    if (path === '/' || path === '/api/health') {
      return json(res, { status: 'ok', version: '0.1.0', mode: 'server' });
    }

    // Collections
    if (path === '/api/collections' && method === 'GET') {
      return json(res, cms.listCollections().filter(c => !c.name.startsWith('_')));
    }
    if (path === '/api/collections' && method === 'POST') {
      const body = await readBody(req);
      const result = cms.createCollection(body.name, body.schema || { fields: body.fields || [] });
      await cms.save();
      return json(res, result, 201);
    }

    // Collection records: /api/collections/:name/records
    const colMatch = path.match(/^\/api\/collections\/([^/]+)\/records$/);
    if (colMatch) {
      const col = colMatch[1];
      if (method === 'GET') {
        const params = Object.fromEntries(url.searchParams);
        const page = cms.list(col, {
          orderBy: params.sort || '_created',
          desc: params.order === 'desc',
          limit: parseInt(params.limit) || 20,
          offset: parseInt(params.offset) || 0,
          filter: params.filter ? JSON.parse(params.filter) : undefined,
        });
        return json(res, page);
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const record = cms.create(col, body);
        await cms.save();
        return json(res, record, 201);
      }
    }

    // Single record: /api/collections/:name/records/:id
    const recMatch = path.match(/^\/api\/collections\/([^/]+)\/records\/([^/]+)$/);
    if (recMatch) {
      const [, col, id] = recMatch;
      if (method === 'GET') {
        const record = cms.getById(col, id);
        if (!record) return json(res, { error: 'not found' }, 404);
        return json(res, record);
      }
      if (method === 'PUT' || method === 'PATCH') {
        const body = await readBody(req);
        const updated = cms.update(col, id, body);
        await cms.save();
        return json(res, updated);
      }
      if (method === 'DELETE') {
        cms.delete(col, id);
        await cms.save();
        return json(res, { deleted: true });
      }
    }

    // Search: /api/collections/:name/search
    const searchMatch = path.match(/^\/api\/collections\/([^/]+)\/search$/);
    if (searchMatch && method === 'POST') {
      const col = searchMatch[1];
      const body = await readBody(req);
      if (body.vector) {
        const results = cms.vectorSearch(col, body.vector, body.limit || 10);
        return json(res, results);
      } else {
        const results = cms.search(col, body.query || '', body.limit || 10);
        return json(res, results);
      }
    }

    // Auth
    if (path === '/api/auth/register' && method === 'POST') {
      const body = await readBody(req);
      const user = await cms.register(body.email, body.password, body.role);
      await cms.save();
      return json(res, user, 201);
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const result = await cms.login(body.email, body.password);
      return json(res, result);
    }

    // Export/Import
    if (path === '/api/export' && method === 'GET') {
      return json(res, JSON.parse(cms.export()));
    }
    if (path === '/api/import' && method === 'POST') {
      const body = await readBody(req);
      await cms.import(JSON.stringify(body));
      await cms.save();
      return json(res, { ok: true });
    }

    // Static files (serve index.html, minicms.js, etc.)
    if (method === 'GET') {
      const file = path === '/' ? '/index.html' : path;
      const filePath = join(process.cwd(), file.slice(1));
      try {
        const content = await readFile(filePath);
        const ext = filePath.split('.').pop();
        const types = { html: 'text/html', js: 'application/javascript', css: 'text/css', wasm: 'application/wasm', json: 'application/json' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        return res.end(content);
      } catch {}
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    json(res, { error: e.message }, 400);
  }
});

server.listen(PORT, () => {
  console.log(`miniCMS server running at http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/health`);
  console.log(`Admin: http://localhost:${PORT}/`);
});
