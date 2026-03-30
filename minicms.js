/**
 * MiniCMS - A complete CMS engine running 100% in the browser.
 * Uses minimemory WASM as the storage backend.
 * Zero dependencies beyond the minimemory WASM bindings.
 *
 * @module minicms
 */

import wasmInit, { WasmVectorDB } from './minimemory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid() {
  // 20-char base36 id with timestamp prefix for rough ordering
  const t = Date.now().toString(36);
  const r = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 20 - t.length);
  return t + r;
}

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Base64-url encoding (no atob/btoa -- works with arbitrary UTF-8 payloads)
// ---------------------------------------------------------------------------

function base64urlEncode(data) {
  // data: Uint8Array -> string
  let bin = '';
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
  // Manual base64
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i);
    const b = i + 1 < bin.length ? bin.charCodeAt(i + 1) : 0;
    const c = i + 2 < bin.length ? bin.charCodeAt(i + 2) : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bin.length ? chars[((b & 15) << 2) | (c >> 6)] : '';
    out += i + 2 < bin.length ? chars[c & 63] : '';
  }
  // base64 -> base64url
  return out.replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str) {
  // string -> Uint8Array
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // base64url -> base64
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  // pad
  while (s.length % 4) s += '=';
  const lookup = {};
  for (let i = 0; i < chars.length; i++) lookup[chars[i]] = i;
  const bytes = [];
  for (let i = 0; i < s.length; i += 4) {
    const a = lookup[s[i]] || 0;
    const b = lookup[s[i + 1]] || 0;
    const c = lookup[s[i + 2]] || 0;
    const d = lookup[s[i + 3]] || 0;
    bytes.push((a << 2) | (b >> 4));
    if (s[i + 2] !== '=') bytes.push(((b & 15) << 4) | (c >> 2));
    if (s[i + 3] !== '=') bytes.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(bytes);
}

function textEncode(str) {
  return new TextEncoder().encode(str);
}

function textDecode(buf) {
  return new TextDecoder().decode(buf);
}

// ---------------------------------------------------------------------------
// JWT helpers (HS256 via Web Crypto)
// ---------------------------------------------------------------------------

async function importHmacKey(secret) {
  // secret: Uint8Array
  return crypto.subtle.importKey(
    'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function jwtSign(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const segments = [
    base64urlEncode(textEncode(JSON.stringify(header))),
    base64urlEncode(textEncode(JSON.stringify(payload)))
  ];
  const signingInput = segments.join('.');
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, textEncode(signingInput));
  segments.push(base64urlEncode(new Uint8Array(sig)));
  return segments.join('.');
}

async function jwtVerify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const signingInput = parts[0] + '.' + parts[1];
  const sig = base64urlDecode(parts[2]);
  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, sig, textEncode(signingInput));
  if (!valid) return null;
  try {
    const payload = JSON.parse(textDecode(base64urlDecode(parts[1])));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PBKDF2 password hashing via Web Crypto
// ---------------------------------------------------------------------------

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', textEncode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hash = new Uint8Array(bits);
  return base64urlEncode(salt) + '.' + base64urlEncode(hash);
}

async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split('.');
  const salt = base64urlDecode(saltB64);
  const expectedHash = base64urlDecode(hashB64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', textEncode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hash = new Uint8Array(bits);
  if (hash.length !== expectedHash.length) return false;
  let ok = true;
  for (let i = 0; i < hash.length; i++) {
    if (hash[i] !== expectedHash[i]) ok = false; // constant-time-ish
  }
  return ok;
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

function openIDB(name, version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e) => onUpgrade(e.target.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const req = s.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const FIELD_TYPES = new Set([
  'text', 'number', 'bool', 'date', 'select', 'file', 'relation', 'json', 'email', 'url', 'vector'
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/;

function validateField(value, field) {
  const { name, type, required, options } = field;
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`Field "${name}" is required`);
    return undefined; // skip optional empty
  }
  switch (type) {
    case 'text':
      if (typeof value !== 'string') throw new Error(`Field "${name}" must be a string`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value))
        throw new Error(`Field "${name}" must be a number`);
      break;
    case 'bool':
      if (typeof value !== 'boolean') throw new Error(`Field "${name}" must be a boolean`);
      break;
    case 'date':
      if (typeof value === 'string' && !isNaN(Date.parse(value))) break;
      throw new Error(`Field "${name}" must be a valid date string`);
    case 'select':
      if (options && !options.includes(value))
        throw new Error(`Field "${name}" must be one of: ${options.join(', ')}`);
      break;
    case 'file':
      if (typeof value !== 'string') throw new Error(`Field "${name}" must be a file ID string`);
      break;
    case 'relation':
      if (typeof value !== 'string') throw new Error(`Field "${name}" must be a record ID string`);
      break;
    case 'json':
      // accept anything JSON-serialisable
      try { JSON.stringify(value); } catch {
        throw new Error(`Field "${name}" must be JSON-serialisable`);
      }
      break;
    case 'email':
      if (typeof value !== 'string' || !EMAIL_RE.test(value))
        throw new Error(`Field "${name}" must be a valid email`);
      break;
    case 'url':
      if (typeof value !== 'string' || !URL_RE.test(value))
        throw new Error(`Field "${name}" must be a valid URL`);
      break;
    case 'vector':
      if (!Array.isArray(value) || !value.every(v => typeof v === 'number'))
        throw new Error(`Field "${name}" must be an array of numbers`);
      break;
    default:
      throw new Error(`Unknown field type "${type}"`);
  }
  return value;
}

function validateRecord(data, schema, partial) {
  const clean = {};
  for (const field of schema.fields) {
    const val = data[field.name];
    if (partial && val === undefined) continue; // skip missing on update
    const validated = validateField(val, field);
    if (validated !== undefined) clean[field.name] = validated;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// MiniCMS
// ---------------------------------------------------------------------------

class MiniCMS {
  /**
   * @param {object} [config]
   * @param {number} [config.dimensions=384] Vector dimensions for embedding fields
   * @param {object} [config.storage] Custom storage adapter (for Node.js server mode)
   */
  constructor(config) {
    this._config = config || {};
    /** @type {WasmVectorDB|null} */
    this._db = null;
    /** @type {IDBDatabase|null} */
    this._idb = null;
    /** @type {Uint8Array|null} */
    this._secret = null;
    /** @type {Map<string, object>} */
    this._schemas = new Map(); // collection name -> schema
    /** @type {EventTarget} */
    this._bus = new EventTarget();
    /** @type {number|null} */
    this._saveTimer = null;

    this._TOKEN_KEY = 'minicms_token';
    this._TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
    this._SAVE_DEBOUNCE = 2000;
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  async init() {
    // 1. Init WASM
    await wasmInit();
    // Default 384 dims for vector fields (common embedding size)
    // Use flat index; switch to hnsw for >10K docs
    this._dims = this._config?.dimensions || 384;
    this._db = new WasmVectorDB(this._dims, 'cosine', 'flat');

    // 2. Open IndexedDB
    this._idb = await openIDB('minicms', 1, (db) => {
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    });

    // 3. Load auth secret (or generate)
    let secret = await idbGet(this._idb, 'meta', 'auth_secret');
    if (!secret) {
      secret = Array.from(crypto.getRandomValues(new Uint8Array(32)));
      await idbPut(this._idb, 'meta', 'auth_secret', secret);
    }
    this._secret = new Uint8Array(secret);

    // 4. Load collection schemas
    const schemasRaw = await idbGet(this._idb, 'meta', 'schemas');
    if (schemasRaw) {
      const parsed = JSON.parse(schemasRaw);
      for (const [k, v] of Object.entries(parsed)) {
        this._schemas.set(k, v);
      }
    }

    // 5. Load data snapshot
    const snapshot = await idbGet(this._idb, 'data', 'snapshot');
    if (snapshot) {
      this._db.import_snapshot(snapshot);
    }

    return this;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  _docId(collection, id) {
    return `${collection}:${id}`;
  }

  _splitDocId(docId) {
    const i = docId.indexOf(':');
    return [docId.slice(0, i), docId.slice(i + 1)];
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), this._SAVE_DEBOUNCE);
  }

  _emit(collection, action, record) {
    const detail = { collection, action, record };
    this._bus.dispatchEvent(new CustomEvent(`${collection}:${action}`, { detail }));
    this._bus.dispatchEvent(new CustomEvent(`${collection}:*`, { detail }));
  }

  _assertCollection(name) {
    if (!this._schemas.has(name)) {
      throw new Error(`Collection "${name}" does not exist`);
    }
  }

  async _saveSchemas() {
    const obj = {};
    for (const [k, v] of this._schemas) obj[k] = v;
    await idbPut(this._idb, 'meta', 'schemas', JSON.stringify(obj));
  }

  // -----------------------------------------------------------------------
  // Collections
  // -----------------------------------------------------------------------

  createCollection(name, schema) {
    if (this._schemas.has(name)) {
      throw new Error(`Collection "${name}" already exists`);
    }
    if (!schema || !Array.isArray(schema.fields)) {
      throw new Error('Schema must have a "fields" array');
    }
    for (const f of schema.fields) {
      if (!f.name || !FIELD_TYPES.has(f.type)) {
        throw new Error(`Invalid field: ${JSON.stringify(f)}`);
      }
    }
    this._schemas.set(name, schema);
    this._saveSchemas();
    this._scheduleSave();
    return { name, schema };
  }

  deleteCollection(name) {
    this._assertCollection(name);
    // Remove all docs in this collection from the DB
    const idsRaw = this._db.ids();
    const allIds = JSON.parse(idsRaw);
    const prefix = name + ':';
    for (const id of allIds) {
      if (id.startsWith(prefix)) {
        this._db.delete(id);
      }
    }
    this._schemas.delete(name);
    this._saveSchemas();
    this._scheduleSave();
  }

  getSchema(collection) {
    return this._schemas.get(collection) || null;
  }

  listCollections() {
    const result = [];
    for (const [name, schema] of this._schemas) {
      // Count non-deleted docs
      let count = 0;
      try {
        const res = JSON.parse(
          this._db.list_documents(
            JSON.stringify({ _collection: name, _deleted: { $ne: true } }),
            '', false, 1, 0
          )
        );
        count = res.total || 0;
      } catch {
        count = 0;
      }
      result.push({ name, schema, count });
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Records
  // -----------------------------------------------------------------------

  create(collection, data) {
    this._assertCollection(collection);
    const schema = this._schemas.get(collection);
    const clean = validateRecord(data, schema, false);
    const id = uid();
    const timestamp = now();
    const record = {
      ...clean,
      _id: id,
      _collection: collection,
      _created: timestamp,
      _updated: timestamp,
      _deleted: { $ne: true }
    };
    // Extract vector field (first vector-type field in schema)
    const vectorField = schema.fields.find(f => f.type === 'vector');
    let vector = null;
    if (vectorField && record[vectorField.name]) {
      vector = Array.from(record[vectorField.name]);
      // Pad or truncate to DB dimensions
      if (vector.length < this._dims) vector = vector.concat(Array.from({ length: this._dims - vector.length }, () => 0));
      if (vector.length > this._dims) vector = vector.slice(0, this._dims);
    }

    try {
      this._db.insert_document(
        this._docId(collection, id),
        vector,
        JSON.stringify(record),
      );
    } catch (e) {
      throw new Error(`Failed to insert record: ${e.message}`);
    }
    this._emit(collection, 'create', record);
    this._scheduleSave();
    return record;
  }

  getById(collection, id) {
    this._assertCollection(collection);
    const docId = this._docId(collection, id);
    const raw = this._db.get(docId);
    if (!raw) return null;
    try {
      const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const meta = doc.metadata
        ? (typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata)
        : doc;
      if (meta._deleted === true) return null;
      return meta;
    } catch {
      return null;
    }
  }

  update(collection, id, data) {
    this._assertCollection(collection);
    const existing = this.getById(collection, id);
    if (!existing) throw new Error(`Record "${id}" not found in "${collection}"`);
    const schema = this._schemas.get(collection);
    const clean = validateRecord(data, schema, true);
    const updated = {
      ...existing,
      ...clean,
      _updated: now()
    };
    // Extract vector field
    const vectorField = schema.fields.find(f => f.type === 'vector');
    let vector = null;
    if (vectorField && updated[vectorField.name]) {
      vector = Array.from(updated[vectorField.name]);
      if (vector.length < this._dims) vector = vector.concat(Array.from({ length: this._dims - vector.length }, () => 0));
      if (vector.length > this._dims) vector = vector.slice(0, this._dims);
    }

    // Delete old and re-insert (minimemory has no partial update for metadata)
    const docId = this._docId(collection, id);
    try {
      this._db.delete(docId);
      this._db.insert_document(docId, vector, JSON.stringify(updated));
    } catch (e) {
      throw new Error(`Failed to update record: ${e.message}`);
    }
    this._emit(collection, 'update', updated);
    this._scheduleSave();
    return updated;
  }

  delete(collection, id) {
    this._assertCollection(collection);
    const existing = this.getById(collection, id);
    if (!existing) throw new Error(`Record "${id}" not found in "${collection}"`);
    const updated = {
      ...existing,
      _deleted: true,
      _updated: now()
    };
    const docId = this._docId(collection, id);
    try {
      this._db.delete(docId);
      this._db.insert_document(docId, null, JSON.stringify(updated));
    } catch (e) {
      throw new Error(`Failed to delete record: ${e.message}`);
    }
    this._emit(collection, 'delete', updated);
    this._scheduleSave();
    return updated;
  }

  list(collection, { filter, orderBy, desc, limit, offset } = {}) {
    this._assertCollection(collection);
    const f = { _collection: collection, _deleted: { $ne: true }, ...(filter || {}) };
    const raw = this._db.list_documents(
      JSON.stringify(f),
      orderBy || '_created',
      !!desc,
      limit || 50,
      offset || 0
    );
    const result = JSON.parse(raw);
    // Normalise: items may be wrapped
    const items = (result.items || []).map(item => {
      const m = item.metadata || item;
      return m;
    });
    return {
      items,
      total: result.total || items.length,
      has_more: result.has_more || false,
      hasMore: result.has_more || false, // alias
    };
  }

  search(collection, query, limit) {
    this._assertCollection(collection);
    // BM25 keyword search across all docs, then filter by collection
    const k = (limit || 20) * 3; // fetch extra to filter
    const raw = this._db.keyword_search(query, k);
    const results = JSON.parse(raw);
    const filtered = [];
    for (const item of results) {
      const meta = item.metadata || item;
      if (meta._collection === collection && !meta._deleted) {
        filtered.push(meta);
        if (filtered.length >= (limit || 20)) break;
      }
    }
    return filtered;
  }

  /**
   * Vector similarity search — find records with similar embeddings.
   * @param {string} collection
   * @param {number[]} queryVector — embedding to search against
   * @param {number} [limit=10]
   * @returns {Array<{record: object, distance: number}>}
   */
  vectorSearch(collection, queryVector, limit) {
    this._assertCollection(collection);
    const k = (limit || 10) * 3;
    const query = new Float32Array(queryVector.length <= this._dims
      ? [...queryVector, ...new Array(Math.max(0, this._dims - queryVector.length)).fill(0)]
      : queryVector.slice(0, this._dims)
    );
    const raw = this._db.search(query, k);
    const results = JSON.parse(raw);
    const filtered = [];
    for (const item of results) {
      const meta = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : item;
      if (meta._collection === collection && !meta._deleted) {
        filtered.push({ record: meta, distance: item.distance });
        if (filtered.length >= (limit || 10)) break;
      }
    }
    return filtered;
  }

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  async register(email, password, role) {
    if (!email || !password) throw new Error('Email and password are required');
    role = role || 'user';

    // Ensure _users collection exists (internal)
    if (!this._schemas.has('_users')) {
      this._schemas.set('_users', {
        fields: [
          { name: 'email', type: 'email', required: true },
          { name: 'password', type: 'text', required: true },
          { name: 'role', type: 'text', required: true }
        ]
      });
      await this._saveSchemas();
    }

    // Check duplicate email
    try {
      const existing = JSON.parse(
        this._db.list_documents(
          JSON.stringify({ _collection: '_users', email, _deleted: { $ne: true } }),
          '', false, 1, 0
        )
      );
      if (existing.total > 0) throw new Error('Email already registered');
    } catch (e) {
      if (e.message === 'Email already registered') throw e;
      // If list_documents throws for other reasons, continue
    }

    const hashedPw = await hashPassword(password);
    const id = uid();
    const timestamp = now();
    const record = {
      _id: id,
      _collection: '_users',
      _created: timestamp,
      _updated: timestamp,
      _deleted: { $ne: true },
      email,
      password: hashedPw,
      role
    };
    this._db.insert_document(this._docId('_users', id), null, JSON.stringify(record));
    this._scheduleSave();

    // Return without password
    const { password: _, ...safe } = record;
    return safe;
  }

  async login(email, password) {
    if (!email || !password) throw new Error('Email and password are required');
    // Find user by email
    let user = null;
    try {
      const res = JSON.parse(
        this._db.list_documents(
          JSON.stringify({ _collection: '_users', email, _deleted: { $ne: true } }),
          '', false, 1, 0
        )
      );
      if (res.items && res.items.length > 0) {
        user = res.items[0].metadata || res.items[0];
      }
    } catch { /* ignore */ }
    if (!user) throw new Error('Invalid email or password');

    const valid = await verifyPassword(password, user.password);
    if (!valid) throw new Error('Invalid email or password');

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user._id,
      email: user.email,
      role: user.role,
      iat: nowSec,
      exp: nowSec + this._TOKEN_TTL
    };
    const token = await jwtSign(payload, this._secret);

    // Store in localStorage
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this._TOKEN_KEY, token);
    }

    const { password: _, ...safe } = user;
    return { token, user: safe };
  }

  async verifyToken(token) {
    if (!token) return null;
    return jwtVerify(token, this._secret);
  }

  async currentUser() {
    if (typeof localStorage === 'undefined') return null;
    const token = localStorage.getItem(this._TOKEN_KEY);
    if (!token) return null;
    const payload = await this.verifyToken(token);
    if (!payload) return null;
    // Fetch fresh user data
    const user = this.getById('_users', payload.sub);
    if (!user) return null;
    const { password: _, ...safe } = user;
    return safe;
  }

  logout() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(this._TOKEN_KEY);
    }
  }

  // -----------------------------------------------------------------------
  // Files (stored as base64 in IndexedDB)
  // -----------------------------------------------------------------------

  async uploadFile(file) {
    const id = uid();
    const arrayBuf = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    // Convert to base64
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    // Manual base64 encode (same as base64urlEncode but standard base64)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let b64 = '';
    for (let i = 0; i < binary.length; i += 3) {
      const a = binary.charCodeAt(i);
      const b = i + 1 < binary.length ? binary.charCodeAt(i + 1) : 0;
      const c = i + 2 < binary.length ? binary.charCodeAt(i + 2) : 0;
      b64 += chars[a >> 2];
      b64 += chars[((a & 3) << 4) | (b >> 4)];
      b64 += i + 1 < binary.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
      b64 += i + 2 < binary.length ? chars[c & 63] : '=';
    }

    const record = {
      id,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      data: b64,
      created: now()
    };
    await idbPut(this._idb, 'files', id, JSON.stringify(record));
    return id;
  }

  async getFileUrl(fileId) {
    const raw = await idbGet(this._idb, 'files', fileId);
    if (!raw) return null;
    const record = JSON.parse(raw);
    return `data:${record.type};base64,${record.data}`;
  }

  async deleteFile(fileId) {
    await idbDelete(this._idb, 'files', fileId);
  }

  // -----------------------------------------------------------------------
  // Realtime (pub/sub via EventTarget)
  // -----------------------------------------------------------------------

  subscribe(collection, event, callback) {
    const eventName = `${collection}:${event}`;
    const handler = (e) => callback(e.detail);
    this._bus.addEventListener(eventName, handler);
    // Return unsubscribe function
    return () => this._bus.removeEventListener(eventName, handler);
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  async save() {
    if (!this._db || !this._idb) return;
    const snapshot = this._db.export_snapshot();
    await idbPut(this._idb, 'data', 'snapshot', snapshot);
  }

  export() {
    const snapshot = this._db.export_snapshot(); // JSON string
    const schemas = {};
    for (const [k, v] of this._schemas) schemas[k] = v;
    return JSON.stringify({ snapshot, schemas });
  }

  async clear() {
    this._db.clear();
    this._schemas.clear();
    await this._saveSchemas();
    await this.save();
  }

  async import(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    // Restore schemas
    if (data.schemas) {
      this._schemas.clear();
      for (const [k, v] of Object.entries(data.schemas)) {
        this._schemas.set(k, v);
      }
      await this._saveSchemas();
    }
    // Restore snapshot
    if (data.snapshot) {
      // snapshot is already a JSON string (from export_snapshot)
      const snap = typeof data.snapshot === 'string' ? data.snapshot : JSON.stringify(data.snapshot);
      this._db.import_snapshot(snap);
    }
    await this.save();
  }
}

export default MiniCMS;
