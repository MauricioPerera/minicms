#!/usr/bin/env node
/**
 * miniCMS Server — Node.js HTTP server
 *
 * Runs miniCMS with file-based persistence instead of IndexedDB.
 * No monkey-patching — uses minimemory WASM directly.
 *
 * Usage: node minicms-server.js [port] [data-dir]
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

// Polyfill browser globals
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// WASM setup — load from file system
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const wasmPath = join(__dirname, 'minimemory_bg.wasm');

let WasmVectorDB;

async function initWasm() {
  const mod = await import('./minimemory.js');
  WasmVectorDB = mod.WasmVectorDB;
  const wasmBytes = await readFile(wasmPath);
  await mod.default(wasmBytes.buffer);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.argv[2]) || 3000;
const DATA_DIR = resolve(process.argv[3] || './minicms-data');
const DIMS = 384;
const SAVE_DEBOUNCE = 2000;

// ─── File-based persistence ──────────────────────────────────────────────────

async function loadJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function saveJson(file, data) {
  await writeFile(file, JSON.stringify(data));
}

async function loadText(file) {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

async function saveText(file, text) {
  await writeFile(file, text);
}

// ─── Auth helpers (pure Node.js crypto) ──────────────────────────────────────

function uid() {
  const t = Date.now().toString(36);
  const r = Array.from(webcrypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 20 - t.length);
  return t + r;
}

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function base64urlDecode(str) {
  return new Uint8Array(Buffer.from(str, 'base64url'));
}

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return base64urlEncode(salt) + '.' + base64urlEncode(new Uint8Array(hash));
}

async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split('.');
  if (!saltB64 || !hashB64) return false;
  const salt = base64urlDecode(saltB64);
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return base64urlEncode(new Uint8Array(hash)) === hashB64;
}

async function jwtSign(payload, secret) {
  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const data = new TextEncoder().encode(`${header}.${body}`);
  const key = await webcrypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = base64urlEncode(new Uint8Array(await webcrypto.subtle.sign('HMAC', key, data)));
  return `${header}.${body}.${sig}`;
}

async function jwtVerify(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const data = new TextEncoder().encode(`${header}.${body}`);
    const key = await webcrypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await webcrypto.subtle.verify('HMAC', key, base64urlDecode(sig), data);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ─── Server CMS ──────────────────────────────────────────────────────────────

class ServerCMS {
  constructor() {
    this.db = null;
    this.schemas = new Map();
    this.secret = null;
    this.bus = new EventEmitter();
    this._saveTimer = null;
  }

  async init() {
    await initWasm();
    this.db = new WasmVectorDB(DIMS, 'cosine', 'flat');

    if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

    // Load schemas
    const schemas = await loadJson(join(DATA_DIR, 'schemas.json'));
    if (schemas) {
      for (const [k, v] of Object.entries(schemas)) this.schemas.set(k, v);
    }

    // Load secret
    const secretData = await loadJson(join(DATA_DIR, 'secret.json'));
    if (secretData) {
      this.secret = new Uint8Array(secretData);
    } else {
      this.secret = webcrypto.getRandomValues(new Uint8Array(32));
      await saveJson(join(DATA_DIR, 'secret.json'), Array.from(this.secret));
    }

    // Load snapshot
    const snapshot = await loadText(join(DATA_DIR, 'snapshot.json'));
    if (snapshot) {
      try { this.db.import_snapshot(snapshot); } catch (e) {
        console.warn('Failed to restore snapshot:', e.message);
      }
    }

    console.log(`Loaded ${this.db.len()} documents, ${this.schemas.size} collections`);
  }

  async save() {
    const snapshot = this.db.export_snapshot();
    await saveText(join(DATA_DIR, 'snapshot.json'), snapshot);
    const obj = {};
    for (const [k, v] of this.schemas) obj[k] = v;
    await saveJson(join(DATA_DIR, 'schemas.json'), obj);
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save().catch(e => console.error('Save failed:', e)), SAVE_DEBOUNCE);
  }

  _docId(col, id) { return `${col}:${id}`; }

  // Collections
  createCollection(name, schema) {
    if (this.schemas.has(name)) throw new Error(`Collection "${name}" already exists`);
    this.schemas.set(name, schema);
    this.scheduleSave();
    return { name, schema };
  }

  deleteCollection(name) {
    if (!this.schemas.has(name)) throw new Error(`Collection "${name}" not found`);
    // Delete all docs in collection
    try {
      const ids = JSON.parse(this.db.ids());
      for (const id of ids) {
        if (id.startsWith(name + ':')) this.db.delete(id);
      }
    } catch {}
    this.schemas.delete(name);
    this.scheduleSave();
  }

  listCollections() {
    const result = [];
    for (const [name, schema] of this.schemas) {
      let count = 0;
      try {
        const res = JSON.parse(this.db.list_documents(
          JSON.stringify({ _collection: name, _deleted: { $ne: true } }),
          '', false, 1, 0
        ));
        count = res.total || 0;
      } catch {}
      result.push({ name, schema, count });
    }
    return result;
  }

  // Records
  create(collection, data) {
    if (!this.schemas.has(collection)) throw new Error(`Collection "${collection}" not found`);
    const id = uid();
    const now = new Date().toISOString();
    const record = { ...data, _id: id, _collection: collection, _created: now, _updated: now, _deleted: false };

    // Extract vector
    const schema = this.schemas.get(collection);
    const vField = schema?.fields?.find(f => f.type === 'vector');
    let vector = null;
    if (vField && record[vField.name] && Array.isArray(record[vField.name])) {
      vector = record[vField.name].slice(0, DIMS);
      while (vector.length < DIMS) vector.push(0);
    }

    try {
      this.db.insert_document(this._docId(collection, id), vector, JSON.stringify(record));
    } catch (e) {
      throw new Error(`Insert failed: ${e.message}`);
    }
    this.bus.emit('change', { collection, action: 'create', record });
    this.scheduleSave();
    return record;
  }

  getById(collection, id) {
    try {
      const raw = this.db.get(this._docId(collection, id));
      if (!raw) return null;
      const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const meta = doc.metadata ? (typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata) : doc;
      if (meta._deleted === true) return null;
      return meta;
    } catch { return null; }
  }

  update(collection, id, data) {
    const existing = this.getById(collection, id);
    if (!existing) throw new Error(`Record not found`);
    const now = new Date().toISOString();
    const updated = { ...existing, ...data, _updated: now };

    const schema = this.schemas.get(collection);
    const vField = schema?.fields?.find(f => f.type === 'vector');
    let vector = null;
    if (vField && updated[vField.name] && Array.isArray(updated[vField.name])) {
      vector = updated[vField.name].slice(0, DIMS);
      while (vector.length < DIMS) vector.push(0);
    }

    const docId = this._docId(collection, id);
    try {
      this.db.delete(docId);
      this.db.insert_document(docId, vector, JSON.stringify(updated));
    } catch (e) {
      throw new Error(`Update failed: ${e.message}`);
    }
    this.bus.emit('change', { collection, action: 'update', record: updated });
    this.scheduleSave();
    return updated;
  }

  delete(collection, id) {
    const existing = this.getById(collection, id);
    if (!existing) throw new Error(`Record not found`);
    const updated = { ...existing, _deleted: true, _updated: new Date().toISOString() };
    const docId = this._docId(collection, id);
    try {
      this.db.delete(docId);
      this.db.insert_document(docId, null, JSON.stringify(updated));
    } catch (e) {
      throw new Error(`Delete failed: ${e.message}`);
    }
    this.bus.emit('change', { collection, action: 'delete', record: updated });
    this.scheduleSave();
    return updated;
  }

  list(collection, { filter, orderBy, desc, limit, offset } = {}) {
    const f = { _collection: collection, _deleted: { $ne: true }, ...(filter || {}) };
    const raw = this.db.list_documents(
      JSON.stringify(f), orderBy || '_created', !!desc, limit || 50, offset || 0
    );
    const result = JSON.parse(raw);
    const items = (result.items || []).map(item => {
      const m = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : item;
      return m;
    });
    return { items, total: result.total || 0, has_more: result.has_more || false };
  }

  search(collection, query, limit) {
    const k = (limit || 20) * 3;
    const results = JSON.parse(this.db.keyword_search(query, k));
    const filtered = [];
    for (const item of results) {
      const meta = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : item;
      if (meta._collection === collection && meta._deleted !== true) {
        filtered.push(meta);
        if (filtered.length >= (limit || 20)) break;
      }
    }
    return filtered;
  }

  vectorSearch(collection, queryVector, limit) {
    const k = (limit || 10) * 3;
    const query = new Float32Array(DIMS);
    for (let i = 0; i < Math.min(queryVector.length, DIMS); i++) query[i] = queryVector[i];
    const results = JSON.parse(this.db.search(query, k));
    const filtered = [];
    for (const item of results) {
      const meta = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : item;
      if (meta._collection === collection && meta._deleted !== true) {
        filtered.push({ record: meta, distance: item.distance });
        if (filtered.length >= (limit || 10)) break;
      }
    }
    return filtered;
  }

  // Auth
  async register(email, password, role) {
    if (!email || !password) throw new Error('Email and password required');
    if (!this.schemas.has('_users')) {
      this.schemas.set('_users', { fields: [
        { name: 'email', type: 'email', required: true },
        { name: 'password', type: 'text', required: true },
        { name: 'role', type: 'text', required: true },
      ]});
    }
    const hash = await hashPassword(password);
    const id = uid();
    const now = new Date().toISOString();
    const record = { email, password: hash, role: role || 'viewer', _id: id, _collection: '_users', _created: now, _updated: now, _deleted: false };
    this.db.insert_document(this._docId('_users', id), null, JSON.stringify(record));
    this.scheduleSave();
    const { password: _, ...safe } = record;
    return safe;
  }

  async login(email, password) {
    const page = this.list('_users', { filter: { email }, limit: 1 });
    if (!page.items.length) throw new Error('Invalid credentials');
    const user = page.items[0];
    const valid = await verifyPassword(password, user.password);
    if (!valid) throw new Error('Invalid credentials');
    const payload = { sub: user._id, email: user.email, role: user.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 86400 };
    const token = await jwtSign(payload, this.secret);
    const { password: _, ...safe } = user;
    return { token, user: safe };
  }

  async verifyToken(token) {
    return jwtVerify(token, this.secret);
  }

  export() {
    return JSON.stringify({
      snapshot: this.db.export_snapshot(),
      schemas: Object.fromEntries(this.schemas),
    });
  }

  async import(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (data.schemas) {
      this.schemas.clear();
      for (const [k, v] of Object.entries(data.schemas)) this.schemas.set(k, v);
    }
    if (data.snapshot) {
      const snap = typeof data.snapshot === 'string' ? data.snapshot : JSON.stringify(data.snapshot);
      this.db.import_snapshot(snap);
    }
    await this.save();
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const cms = new ServerCMS();
await cms.init();

// Create default admin
try {
  const users = cms.list('_users', { limit: 1 });
  if (!users.items.length) {
    await cms.register('admin@minicms.local', 'admin', 'admin');
    await cms.save();
    console.log('Created default admin: admin@minicms.local / admin');
  }
} catch {
  try {
    await cms.register('admin@minicms.local', 'admin', 'admin');
    await cms.save();
    console.log('Created default admin: admin@minicms.local / admin');
  } catch {}
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' });
    return res.end();
  }

  try {
    if (path === '/api/health') return json(res, { status: 'ok', mode: 'server', docs: cms.db.len(), collections: cms.schemas.size });

    if (path === '/api/collections' && method === 'GET') return json(res, cms.listCollections().filter(c => !c.name.startsWith('_')));
    if (path === '/api/collections' && method === 'POST') { const b = await readBody(req); return json(res, cms.createCollection(b.name, { fields: b.fields || [] }), 201); }

    const colRec = path.match(/^\/api\/collections\/([^/]+)\/records$/);
    if (colRec) {
      const col = colRec[1];
      if (method === 'GET') {
        const p = Object.fromEntries(url.searchParams);
        return json(res, cms.list(col, { orderBy: p.sort, desc: p.order === 'desc', limit: +p.limit || 20, offset: +p.offset || 0, filter: p.filter ? JSON.parse(p.filter) : undefined }));
      }
      if (method === 'POST') { const b = await readBody(req); return json(res, cms.create(col, b), 201); }
    }

    const rec = path.match(/^\/api\/collections\/([^/]+)\/records\/([^/]+)$/);
    if (rec) {
      const [, col, id] = rec;
      if (method === 'GET') { const r = cms.getById(col, id); return r ? json(res, r) : json(res, { error: 'not found' }, 404); }
      if (method === 'PUT' || method === 'PATCH') { const b = await readBody(req); return json(res, cms.update(col, id, b)); }
      if (method === 'DELETE') return json(res, cms.delete(col, id));
    }

    const search = path.match(/^\/api\/collections\/([^/]+)\/search$/);
    if (search && method === 'POST') {
      const b = await readBody(req);
      return json(res, b.vector ? cms.vectorSearch(search[1], b.vector, b.limit) : cms.search(search[1], b.query || '', b.limit));
    }

    if (path === '/api/auth/register' && method === 'POST') { const b = await readBody(req); return json(res, await cms.register(b.email, b.password, b.role), 201); }
    if (path === '/api/auth/login' && method === 'POST') { const b = await readBody(req); return json(res, await cms.login(b.email, b.password)); }
    if (path === '/api/export' && method === 'GET') return json(res, JSON.parse(cms.export()));
    if (path === '/api/import' && method === 'POST') { const b = await readBody(req); await cms.import(JSON.stringify(b)); return json(res, { ok: true }); }

    // Static files (with path traversal protection)
    if (method === 'GET') {
      const file = path === '/' ? '/index.html' : path;
      const filePath = resolve(__dirname, file.slice(1));
      if (!filePath.startsWith(__dirname)) return json(res, { error: 'forbidden' }, 403);
      try {
        const content = await readFile(filePath);
        const ext = filePath.split('.').pop();
        const types = { html: 'text/html', js: 'application/javascript', css: 'text/css', wasm: 'application/wasm', json: 'application/json', png: 'image/png', svg: 'image/svg+xml' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        return res.end(content);
      } catch { /* fall through to 404 */ }
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    json(res, { error: e.message }, 400);
  }
});

server.listen(PORT, () => {
  console.log(`\nminiCMS server running at http://localhost:${PORT}`);
  console.log(`API:   http://localhost:${PORT}/api/health`);
  console.log(`Admin: http://localhost:${PORT}/`);
  console.log(`Data:  ${DATA_DIR}\n`);
});
