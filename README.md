# miniCMS

A PocketBase-like CMS that runs in the browser via WASM **and** on Node.js as a server.

**Live demo:** [minicms.pages.dev](https://minicms.pages.dev)

## What is miniCMS?

miniCMS is a content management system powered by [minimemory](https://www.npmjs.com/package/@rckflr/minimemory) WASM. Collections, CRUD, auth, full-text search, vector search, and persistence — running in the browser (573KB) or as a Node.js server.

**Two modes:**
- **Browser** — Zero backend. Open index.html, everything runs client-side with IndexedDB persistence.
- **Server** — `node minicms-server.js` — REST API + admin UI, file-based persistence. Deploy anywhere.

## Features

- **Dynamic collections** with typed schemas (text, number, bool, date, select, email, url, file, json, relation, **vector**)
- **Vector field type** — store embeddings, search by similarity
- **Full CRUD** with field validation, auto-timestamps, soft-delete
- **JWT authentication** via Web Crypto API (PBKDF2 + HS256, zero deps)
- **User roles**: admin, editor, viewer
- **BM25 keyword search** + **vector similarity search**
- **ORDER BY + pagination** on any field
- **MongoDB-style filters** (`{ status: "published", views: { $gte: 100 } }`)
- **Export/import** entire database to JSON
- **Auto-persist** to IndexedDB (browser) or filesystem (server)
- **Realtime events** (subscribe to create/update/delete)
- **File uploads** (base64)
- **Admin dashboard** (dark Tailwind UI)

## Quick Start

### Browser mode

```bash
npx serve .
# open http://localhost:3000
```

### Server mode

```bash
node minicms-server.js 3000 ./data
# miniCMS server running at http://localhost:3000
# API: http://localhost:3000/api/health
# Admin: http://localhost:3000/
```

Default admin: `admin@minicms.local` / `admin`

## JavaScript API

```js
import MiniCMS from './minicms.js';

const cms = new MiniCMS({ dimensions: 384 }); // vector dimensions
await cms.init();
```

### Schema with Vector Field

```js
cms.createCollection('articles', {
  fields: [
    { name: 'title',     type: 'text',   required: true },
    { name: 'content',   type: 'text' },
    { name: 'category',  type: 'select', options: ['tech', 'science', 'news'] },
    { name: 'embedding', type: 'vector' },  // embedding field
  ]
});
```

### CRUD

```js
// Create (with embedding)
const article = cms.create('articles', {
  title: 'About Vector Databases',
  content: 'Vector databases store embeddings...',
  category: 'tech',
  embedding: [0.1, 0.2, 0.3, ...], // 384d array
});

// Read
const record = cms.getById('articles', article._id);

// Update
cms.update('articles', article._id, { category: 'science' });

// Delete (soft-delete)
cms.delete('articles', article._id);

// List with ORDER BY + pagination
const page = cms.list('articles', {
  filter: { category: 'tech' },
  orderBy: '_created',
  desc: true,
  limit: 20,
  offset: 0,
});
// { items: [...], total: 100, has_more: true }
```

### Search

```js
// Keyword search (BM25)
const results = cms.search('articles', 'vector database', 10);

// Vector similarity search
const similar = cms.vectorSearch('articles', queryEmbedding, 10);
// [{ record: {...}, distance: 0.05 }, ...]
```

### Auth

```js
await cms.register('user@example.com', 'password', 'editor');
const { token, user } = await cms.login('user@example.com', 'password');
const me = await cms.currentUser();
cms.logout();
```

### Persistence

```js
const json = cms.export();       // export to JSON
await cms.import(json);          // import from JSON
await cms.save();                // manual save
await cms.clear();               // clear all data
```

## Server REST API

When running with `node minicms-server.js`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/collections` | List collections |
| POST | `/api/collections` | Create collection |
| GET | `/api/collections/:name/records` | List records (with ?sort, ?order, ?limit, ?offset, ?filter) |
| POST | `/api/collections/:name/records` | Create record |
| GET | `/api/collections/:name/records/:id` | Get record |
| PUT | `/api/collections/:name/records/:id` | Update record |
| DELETE | `/api/collections/:name/records/:id` | Delete record |
| POST | `/api/collections/:name/search` | Search (keyword or vector) |
| POST | `/api/auth/register` | Register user |
| POST | `/api/auth/login` | Login (returns JWT) |
| GET | `/api/export` | Export database |
| POST | `/api/import` | Import database |

## miniCMS vs PocketBase

| | miniCMS | PocketBase |
|---|---|---|
| Runs in | Browser + Node.js | Server (Go) |
| Storage | WASM in-memory + IndexedDB/files | SQLite |
| Vector search | Built-in (minimemory) | No |
| Auth | Web Crypto JWT | Go crypto JWT |
| Collections | Dynamic schemas | Dynamic schemas |
| Search | BM25 + vector similarity | SQLite FTS |
| Realtime | EventTarget / EventEmitter | SSE |
| Size | 573KB | ~18MB |
| Deploy | Static hosting or `node server.js` | Server / VPS |

**Use miniCMS when:** local-first, prototypes, offline apps, vector search needed, zero infrastructure.

**Use PocketBase when:** shared backend, multi-client, production persistence.

## How It Works

| Layer | Browser | Server |
|---|---|---|
| Storage engine | minimemory WASM | minimemory WASM |
| Persistence | IndexedDB | Filesystem (JSON) |
| Auth crypto | Web Crypto API | Node.js crypto |
| Events | EventTarget | EventEmitter-like |
| Token storage | localStorage | File-backed |

## Size

| Component | Size |
|---|---|
| `minicms.js` | ~80KB |
| `minicms-server.js` | ~8KB |
| `minimemory_bg.wasm` | ~493KB |
| **Total** | **~573KB** |

## Powered By

[@rckflr/minimemory](https://www.npmjs.com/package/@rckflr/minimemory) — Embedded vector database for JS/TS via WASM.

- [npm](https://www.npmjs.com/package/@rckflr/minimemory) | [crates.io](https://crates.io/crates/minimemory) | [GitHub](https://github.com/MauricioPerera/minimemory)

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera)
