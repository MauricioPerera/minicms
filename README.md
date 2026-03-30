# miniCMS

A PocketBase-like CMS that runs 100% in the browser via WASM.

**Live demo:** [minicms.pages.dev](https://minicms.pages.dev)

## What is miniCMS?

miniCMS is a zero-backend content management system powered by [minimemory](https://www.npmjs.com/package/@rckflr/minimemory) WASM. Collections, CRUD, auth, full-text search, and persistence -- all running entirely in the browser in 573KB (80KB JS + 493KB WASM).

No server. No database. No Docker. Just open a file.

## Features

- **Dynamic collections** with typed schemas (text, number, bool, date, select, email, url, file, json, relation)
- **Full CRUD** with field validation, auto-timestamps (`_created`, `_updated`), and soft-delete
- **JWT authentication** via Web Crypto API (PBKDF2 password hashing + HS256 token signing, zero dependencies)
- **User roles**: admin, editor, viewer
- **BM25 keyword search** across collections
- **ORDER BY + pagination** on any field
- **MongoDB-style filters** (e.g. `{ status: "published", views: { $gte: 100 } }`)
- **Export/import** entire database to JSON for backup and restore
- **Auto-persist** to IndexedDB (debounced writes, survives page reload)
- **Realtime events** via EventTarget (subscribe to create/update/delete per collection)
- **File uploads** stored as base64 in IndexedDB
- **Admin dashboard** with dark Tailwind UI (collections, records, users, search, settings)

## Quick Start

miniCMS is a single HTML file + JS module + WASM binary. Serve it over HTTP (required for WASM):

```bash
# Any HTTP server works
npx serve .
# or
python -m http.server 8000
```

Then open `http://localhost:8000` in your browser. On first load, a default admin account is created:

- **Email:** `admin@minicms.local`
- **Password:** `admin`

## JavaScript API

All operations happen through the `MiniCMS` class:

```js
import MiniCMS from './minicms.js';

const cms = new MiniCMS();
await cms.init();
```

### Schema Definition

```js
cms.createCollection('posts', {
  fields: [
    { name: 'title',     type: 'text',   required: true },
    { name: 'body',      type: 'text',   required: true },
    { name: 'author',    type: 'email'  },
    { name: 'views',     type: 'number' },
    { name: 'published', type: 'bool'   },
    { name: 'category',  type: 'select', options: ['tech', 'design', 'business'] },
    { name: 'metadata',  type: 'json'   },
    { name: 'link',      type: 'url'    },
    { name: 'cover',     type: 'file'   },
    { name: 'createdAt', type: 'date'   },
  ]
});
```

### CRUD

```js
// Create
const post = cms.create('posts', {
  title: 'Hello World',
  body: 'First post!',
  published: true,
  views: 0,
});

// Read
const record = cms.getById('posts', post._id);

// Update
cms.update('posts', post._id, { views: 42 });

// Delete (soft-delete)
cms.delete('posts', post._id);

// List with filters, sorting, and pagination
const page = cms.list('posts', {
  filter: { published: true },
  orderBy: 'views',
  desc: true,
  limit: 20,
  offset: 0,
});
// -> { items: [...], total: 100, hasMore: true }

// Full-text search (BM25)
const results = cms.search('posts', 'hello world', 10);
```

### Auth Flow

```js
// Register a new user
await cms.register('user@example.com', 'securepassword', 'editor');

// Login (stores JWT in localStorage)
const { token, user } = await cms.login('user@example.com', 'securepassword');

// Get current user from stored token
const me = await cms.currentUser();
// -> { _id, email, role, _created, _updated }

// Logout
cms.logout();
```

### Realtime Events

```js
const unsubscribe = cms.subscribe('posts', 'create', (detail) => {
  console.log('New post:', detail.record);
});

// Subscribe to all events on a collection
cms.subscribe('posts', '*', (detail) => {
  console.log(detail.action, detail.record);
});

// Unsubscribe
unsubscribe();
```

### Files

```js
const fileId = await cms.uploadFile(fileInput.files[0]);
const dataUrl = await cms.getFileUrl(fileId);
await cms.deleteFile(fileId);
```

### Export / Import

```js
// Export everything to JSON string
const json = cms.export();

// Import from JSON (replaces current data)
await cms.import(json);

// Manual save to IndexedDB
await cms.save();

// Clear all data
await cms.clear();
```

### Collections Management

```js
cms.listCollections();
// -> [{ name: 'posts', schema: {...}, count: 42 }, ...]

cms.getSchema('posts');
// -> { fields: [...] }

cms.deleteCollection('posts');
```

## How It Works

| Layer | Technology |
|---|---|
| **Storage engine** | [minimemory](https://www.npmjs.com/package/@rckflr/minimemory) WASM -- document store with BM25 search, filters, and sorting |
| **Persistence** | IndexedDB -- auto-saves snapshots on every write (debounced 2s) |
| **Authentication** | Web Crypto API -- PBKDF2 (100k iterations, SHA-256) for passwords, HMAC-SHA256 for JWT tokens |
| **Admin UI** | Single HTML file with Tailwind CSS (loaded from CDN) |

The WASM engine holds all documents in memory for fast reads. On every mutation, a debounced save serializes the full snapshot to IndexedDB. On page load, the snapshot is restored from IndexedDB back into WASM memory.

## Size

| Component | Size |
|---|---|
| `minicms.js` | ~80KB |
| `minimemory_bg.wasm` | ~493KB |
| **Total** | **~573KB** |

## miniCMS vs PocketBase

| | miniCMS | PocketBase |
|---|---|---|
| Runs in | Browser (WASM) | Server (Go binary) |
| Storage | IndexedDB | SQLite |
| Auth | Web Crypto JWT | Go crypto JWT |
| Collections | Dynamic schemas | Dynamic schemas |
| Search | BM25 keyword search | SQLite FTS |
| API | JavaScript class | REST + SDK |
| Realtime | EventTarget | SSE |
| File storage | base64 in IndexedDB | Filesystem |
| Multi-user | Single browser tab | Multi-client |
| Deploy | Static hosting / open file | Server / VPS |
| Size | 573KB | ~18MB |

**Use miniCMS when** you want a local-first CMS, a prototype, a personal tool, or an offline-capable app with zero infrastructure.

**Use PocketBase when** you need a shared backend, multi-client access, or production-grade persistence.

## Powered By

**[@rckflr/minimemory](https://www.npmjs.com/package/@rckflr/minimemory)** -- A WASM vector database and document store for the browser.

- npm: [npmjs.com/package/@rckflr/minimemory](https://www.npmjs.com/package/@rckflr/minimemory)
- GitHub: [github.com/pereramauricio/minimemory](https://github.com/pereramauricio/minimemory)

## License

MIT

## Author

**Mauricio Perera**
