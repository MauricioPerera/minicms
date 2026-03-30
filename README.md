# miniCMS

A PocketBase-like CMS with built-in GraphRAG. Runs in the browser via WASM **and** on Node.js as a server.

**Live demo:** [minicms.pages.dev](https://minicms.pages.dev)

## What is miniCMS?

miniCMS is a content management system powered by [minimemory](https://www.npmjs.com/package/@rckflr/minimemory) WASM. Collections, CRUD, auth, search, **and privacy-first AI document analysis** — running in the browser (573KB + models) or as a Node.js server.

**Three modes:**
- **Browser** — Zero backend. Open index.html, everything runs client-side.
- **Server** — `node minicms-server.js` — REST API + admin UI.
- **GraphRAG** — Upload PDFs/DOCX, ask questions, get answers with citations. All AI runs locally.

## GraphRAG — Privacy-First Document AI

Upload legal or medical documents and query them with AI — **no data ever leaves your device.**

**Stack (100% in-browser):**

| Component | Model | Size | Purpose |
|-----------|-------|------|---------|
| LLM | Qwen3-0.6B | ~400MB | Entity extraction + answer generation |
| Embeddings | multilingual-e5-small | ~130MB | 384d semantic vectors |
| Parsing | PDF.js + mammoth.js | CDN | PDF, DOCX, TXT |
| Storage | minimemory WASM | 493KB | Vector search + document store |

**Pipeline:**
1. **Ingest** — Upload PDF/DOCX/TXT → parse → chunk (500 chars) → embed → extract entities → build graph
2. **Query** — Question → embed → vector search → graph traversal → generate answer with citations
3. **Graph** — Browse entities (person, organization, law, medication, etc.) and their relations

**Use cases:**
- Legal document review (contracts, court filings, regulations)
- Medical records analysis (patient histories, drug interactions)
- Compliance audits (policy documents, SOPs)
- Any scenario where data must stay on-device

### GraphRAG API

```js
import MiniRAG from './minicms-rag.js';

const rag = new MiniRAG(cms);
await rag.init(); // downloads models (~500MB, cached after first load)

// Ingest a document
await rag.ingest(pdfFile);

// Ask a question
const result = await rag.query("What are the key obligations in this contract?");
// { answer: "...", sources: [{text, page, score}], entities: [{name, type}] }

// Browse the knowledge graph
const graph = rag.getGraph();
// { nodes: [{name, type, count}], edges: [{source, target, type}] }
```

## Features

### CMS Core
- **Dynamic collections** with typed schemas (text, number, bool, date, select, email, url, file, json, relation, **vector**)
- **Full CRUD** with validation, auto-timestamps, soft-delete
- **JWT auth** via Web Crypto API (PBKDF2 + HS256, zero deps)
- **User roles**: admin, editor, viewer
- **BM25 keyword search** + **vector similarity search**
- **ORDER BY + pagination** on any field
- **MongoDB-style filters**
- **Export/import** to JSON
- **Auto-persist** to IndexedDB (browser) or filesystem (server)

### GraphRAG
- **Document parsing**: PDF (PDF.js), DOCX (mammoth.js), TXT/MD
- **Entity extraction**: person, organization, law, medical_condition, medication, date, location, concept
- **Relation building**: source → type → target with deduplication
- **Vector + graph search**: combines semantic similarity with knowledge graph traversal
- **Answer generation**: Qwen3-0.6B with source citations
- **WebGPU acceleration** with WASM fallback

## Quick Start

### Browser (with GraphRAG)

```bash
npx serve .
# open http://localhost:3000
# Go to "Documents" tab → upload a PDF → go to "Chat" tab → ask questions
```

### Server mode

```bash
node minicms-server.js 3000 ./data
```

Default admin: `admin@minicms.local` / `admin`

## Admin Dashboard

| Tab | Purpose |
|-----|---------|
| **Collections** | Create/manage dynamic collections with schemas |
| **Records** | CRUD with table view, pagination, ORDER BY |
| **Users** | Register users, manage roles |
| **Search** | BM25 keyword search across collections |
| **Documents** | Upload PDF/DOCX/TXT for GraphRAG processing |
| **Chat** | Ask questions about uploaded documents |
| **Graph** | Browse extracted entities and relationships |
| **Settings** | Export/import, clear data |

## Server REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/collections` | List collections |
| POST | `/api/collections` | Create collection |
| GET/POST | `/api/collections/:name/records` | List/create records |
| GET/PUT/DELETE | `/api/collections/:name/records/:id` | CRUD by ID |
| POST | `/api/collections/:name/search` | Keyword or vector search |
| POST | `/api/auth/register` | Register user |
| POST | `/api/auth/login` | Login (JWT) |
| GET/POST | `/api/export` / `/api/import` | Backup/restore |

## Size

| Component | Size |
|-----------|------|
| `minicms.js` | ~80KB |
| `minicms-rag.js` | ~40KB |
| `minicms-server.js` | ~12KB |
| `minimemory_bg.wasm` | ~493KB |
| AI models (cached) | ~530MB |
| **App total (no models)** | **~625KB** |

## System Requirements

### Browser mode (GraphRAG)
- **Chrome 113+** or **Edge 113+** (WebGPU support)
- **4GB+ RAM** free (models load ~2GB into memory)
- **~530MB** disk for cached models (first load only)
- Falls back to WASM if WebGPU unavailable (slower, works everywhere)

### Server mode
- **Node.js 18+** with ESM support
- No GPU required (WASM inference)

## Technical Details

The GraphRAG engine uses [transformers.js v3](https://huggingface.co/docs/transformers.js) with:
- `AutoTokenizer` + `AutoModelForCausalLM` for Qwen3 (not `pipeline('text-generation')`)
- `pipeline('feature-extraction')` for e5-small embeddings
- `dtype: 'q4f16'` quantization for WebGPU, WASM fallback
- Chat template applied via `tokenizer.apply_chat_template()`
- All heavy dependencies (transformers.js, PDF.js, mammoth.js) loaded dynamically from CDN

## Privacy Guarantee

When using GraphRAG in the browser:
- Models download once from Hugging Face, then cached locally
- **All AI inference runs in your browser** (WebGPU/WASM)
- **Zero API calls** after model download
- Documents never leave your device
- No telemetry, no analytics, no tracking

## Powered By

- [@rckflr/minimemory](https://www.npmjs.com/package/@rckflr/minimemory) — Embedded vector database (WASM)
- [Qwen3-0.6B](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX) — Language model (ONNX)
- [multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small) — Embeddings (ONNX)
- [transformers.js](https://huggingface.co/docs/transformers.js) — ML inference in browser
- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF parsing
- [mammoth.js](https://github.com/mwilliamson/mammoth.js) — DOCX parsing

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera)
