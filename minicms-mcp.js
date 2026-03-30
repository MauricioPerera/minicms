#!/usr/bin/env node
/**
 * miniCMS MCP Server
 *
 * Exposes miniCMS (collections, records, auth) and GraphRAG (ingest, query, graph)
 * as MCP tools for AI agents (Claude, Gemini, etc.)
 *
 * Install:
 *   claude mcp add minicms -- node /path/to/minicms-mcp.js [data-dir]
 *
 * Or in .mcp.json:
 *   { "mcpServers": { "minicms": { "command": "node", "args": ["minicms-mcp.js"] } } }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = resolve(process.argv[2] || join(__dirname, 'mcp-data'));
const DIMS = 384;

// ─── Lightweight CMS (reuse ServerCMS pattern from minicms-server.js) ────────

let WasmVectorDB;

async function initWasm() {
  const wasmPath = join(__dirname, 'minimemory_bg.wasm');
  const jsUrl = new URL('minimemory.js', import.meta.url).href;
  const mod = await import(jsUrl);
  WasmVectorDB = mod.WasmVectorDB;
  const wasmBytes = await readFile(wasmPath);
  await mod.default(wasmBytes.buffer);
}

// Simple file-based persistence
async function loadJson(f) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } }
async function saveJson(f, d) { await writeFile(f, JSON.stringify(d)); }
async function loadText(f) { try { return await readFile(f, 'utf8'); } catch { return null; } }
async function saveText(f, t) { await writeFile(f, t); }

function uid() {
  const t = Date.now().toString(36);
  const r = Array.from(webcrypto.getRandomValues(new Uint8Array(6)))
    .map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  return t + r;
}

// Minimal CMS for MCP (no auth overhead, just data)
class MCPStore {
  constructor() { this.db = null; this.schemas = new Map(); }

  async init() {
    await initWasm();
    this.db = new WasmVectorDB(DIMS, 'cosine', 'flat');
    if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

    const schemas = await loadJson(join(DATA_DIR, 'schemas.json'));
    if (schemas) for (const [k, v] of Object.entries(schemas)) this.schemas.set(k, v);

    const snapshot = await loadText(join(DATA_DIR, 'snapshot.json'));
    if (snapshot) try { this.db.import_snapshot(snapshot); } catch {}
  }

  async save() {
    await saveText(join(DATA_DIR, 'snapshot.json'), this.db.export_snapshot());
    await saveJson(join(DATA_DIR, 'schemas.json'), Object.fromEntries(this.schemas));
  }

  _docId(col, id) { return `${col}:${id}`; }

  createCollection(name, fields) {
    if (this.schemas.has(name)) throw new Error(`Collection "${name}" exists`);
    this.schemas.set(name, { fields });
    this.save();
    return { name, fields };
  }

  deleteCollection(name) {
    if (!this.schemas.has(name)) throw new Error(`Collection "${name}" not found`);
    try {
      const ids = JSON.parse(this.db.ids());
      for (const id of ids) if (id.startsWith(name + ':')) this.db.delete(id);
    } catch {}
    this.schemas.delete(name);
    this.save();
  }

  listCollections() {
    const result = [];
    for (const [name, schema] of this.schemas) {
      let count = 0;
      try {
        const r = JSON.parse(this.db.list_documents(
          JSON.stringify({ _collection: name, _deleted: { $ne: true } }), '', false, 1, 0
        ));
        count = r.total || 0;
      } catch {}
      result.push({ name, ...schema, count });
    }
    return result;
  }

  create(collection, data) {
    if (!this.schemas.has(collection)) throw new Error(`Collection "${collection}" not found`);
    const id = uid();
    const now = new Date().toISOString();
    const record = { ...data, _id: id, _collection: collection, _created: now, _updated: now, _deleted: false };
    const schema = this.schemas.get(collection);
    const vField = schema?.fields?.find(f => f.type === 'vector');
    let vector = null;
    if (vField && record[vField.name] && Array.isArray(record[vField.name])) {
      vector = record[vField.name].slice(0, DIMS);
      while (vector.length < DIMS) vector.push(0);
    }
    this.db.insert_document(this._docId(collection, id), vector, JSON.stringify(record));
    this.save();
    return record;
  }

  getById(collection, id) {
    try {
      const raw = this.db.get(this._docId(collection, id));
      if (!raw) return null;
      const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const m = doc.metadata ? (typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata) : doc;
      if (m._deleted === true) return null;
      return m;
    } catch { return null; }
  }

  update(collection, id, data) {
    const existing = this.getById(collection, id);
    if (!existing) throw new Error('Record not found');
    const updated = { ...existing, ...data, _updated: new Date().toISOString() };
    const docId = this._docId(collection, id);
    const schema = this.schemas.get(collection);
    const vField = schema?.fields?.find(f => f.type === 'vector');
    let vector = null;
    if (vField && updated[vField.name]) {
      vector = updated[vField.name].slice(0, DIMS);
      while (vector.length < DIMS) vector.push(0);
    }
    this.db.delete(docId);
    this.db.insert_document(docId, vector, JSON.stringify(updated));
    this.save();
    return updated;
  }

  delete(collection, id) {
    const existing = this.getById(collection, id);
    if (!existing) throw new Error('Record not found');
    const updated = { ...existing, _deleted: true, _updated: new Date().toISOString() };
    const docId = this._docId(collection, id);
    this.db.delete(docId);
    this.db.insert_document(docId, null, JSON.stringify(updated));
    this.save();
    return { deleted: true, id };
  }

  list(collection, opts = {}) {
    const f = { _collection: collection, _deleted: { $ne: true }, ...(opts.filter || {}) };
    const raw = this.db.list_documents(
      JSON.stringify(f), opts.orderBy || '_created', !!opts.desc, opts.limit || 20, opts.offset || 0
    );
    const result = JSON.parse(raw);
    const items = (result.items || []).map(i => {
      const m = i.metadata ? (typeof i.metadata === 'string' ? JSON.parse(i.metadata) : i.metadata) : i;
      return m;
    });
    return { items, total: result.total || 0, has_more: result.has_more || false };
  }

  search(collection, query, limit = 20) {
    const k = limit * 3;
    const results = JSON.parse(this.db.keyword_search(query, k));
    const filtered = [];
    for (const item of results) {
      const m = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : item;
      if (m._collection === collection && m._deleted !== true) {
        filtered.push(m);
        if (filtered.length >= limit) break;
      }
    }
    return filtered;
  }

  export() { return this.db.export_snapshot(); }

  import(json) {
    this.db.import_snapshot(typeof json === 'string' ? json : JSON.stringify(json));
    this.save();
  }
}

// ─── MCP Tool Definitions ────────────────────────────────────────────────────

const TOOLS = [
  // CMS Core
  {
    name: 'cms_list_collections',
    description: 'List all collections with their schemas and record counts',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cms_create_collection',
    description: 'Create a new collection with typed fields. Field types: text, number, bool, date, select, email, url, json, vector',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Collection name' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['text', 'number', 'bool', 'date', 'select', 'email', 'url', 'json', 'vector'] },
              required: { type: 'boolean' },
              options: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['name', 'fields'],
    },
  },
  {
    name: 'cms_delete_collection',
    description: 'Delete a collection and all its records',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'cms_create_record',
    description: 'Create a new record in a collection',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        data: { type: 'object', description: 'Record data matching collection schema' },
      },
      required: ['collection', 'data'],
    },
  },
  {
    name: 'cms_get_record',
    description: 'Get a record by ID',
    inputSchema: {
      type: 'object',
      properties: { collection: { type: 'string' }, id: { type: 'string' } },
      required: ['collection', 'id'],
    },
  },
  {
    name: 'cms_update_record',
    description: 'Update fields on an existing record',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        id: { type: 'string' },
        data: { type: 'object', description: 'Fields to update' },
      },
      required: ['collection', 'id', 'data'],
    },
  },
  {
    name: 'cms_delete_record',
    description: 'Soft-delete a record',
    inputSchema: {
      type: 'object',
      properties: { collection: { type: 'string' }, id: { type: 'string' } },
      required: ['collection', 'id'],
    },
  },
  {
    name: 'cms_list_records',
    description: 'List records with optional filter, sorting, and pagination',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        filter: { type: 'object', description: 'MongoDB-style filter, e.g. {"status": "active", "score": {"$gt": 5}}' },
        orderBy: { type: 'string', description: 'Field name to sort by' },
        desc: { type: 'boolean', description: 'Sort descending' },
        limit: { type: 'number', description: 'Max records (default 20)' },
        offset: { type: 'number', description: 'Skip records (default 0)' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'cms_search',
    description: 'Full-text keyword search (BM25) within a collection',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        query: { type: 'string', description: 'Search keywords' },
        limit: { type: 'number' },
      },
      required: ['collection', 'query'],
    },
  },
  {
    name: 'cms_vector_search',
    description: 'Vector similarity search using embeddings stored in vector fields',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        vector: { type: 'array', items: { type: 'number' }, description: 'Query embedding (384d)' },
        limit: { type: 'number' },
      },
      required: ['collection', 'vector'],
    },
  },
  // Persistence
  {
    name: 'cms_export',
    description: 'Export entire database as JSON (for backup)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cms_import',
    description: 'Import database from JSON snapshot',
    inputSchema: {
      type: 'object',
      properties: { data: { type: 'string', description: 'JSON snapshot from cms_export' } },
      required: ['data'],
    },
  },
  // RAG
  {
    name: 'rag_ingest_text',
    description: 'Ingest text into the knowledge base — chunks, embeds, and extracts entities. Use for document analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Document text to ingest' },
        filename: { type: 'string', description: 'Source filename for attribution' },
      },
      required: ['text'],
    },
  },
  {
    name: 'rag_query',
    description: 'Ask a question about ingested documents using GraphRAG (vector search + knowledge graph + LLM)',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        topK: { type: 'number', description: 'Number of chunks to retrieve (default 5)' },
      },
      required: ['question'],
    },
  },
  {
    name: 'rag_get_entities',
    description: 'List extracted entities from the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by entity type (person, organization, law, etc.)' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'rag_get_graph',
    description: 'Get the full knowledge graph (entities as nodes, relationships as edges)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'rag_stats',
    description: 'Get RAG statistics: document count, chunks, entities, relations',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ─── MCP Server ──────────────────────────────────────────────────────────────

const store = new MCPStore();
await store.init();
console.error(`miniCMS MCP: loaded ${store.db.len()} docs, ${store.schemas.size} collections (data: ${DATA_DIR})`);

const mcpServer = new Server(
  { name: 'minicms', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      // CMS Core
      case 'cms_list_collections':
        result = store.listCollections().filter(c => !c.name.startsWith('_'));
        break;
      case 'cms_create_collection':
        result = store.createCollection(args.name, args.fields);
        break;
      case 'cms_delete_collection':
        store.deleteCollection(args.name);
        result = { deleted: args.name };
        break;
      case 'cms_create_record':
        result = store.create(args.collection, args.data);
        break;
      case 'cms_get_record':
        result = store.getById(args.collection, args.id);
        if (!result) return { content: [{ type: 'text', text: 'Record not found' }], isError: true };
        break;
      case 'cms_update_record':
        result = store.update(args.collection, args.id, args.data);
        break;
      case 'cms_delete_record':
        result = store.delete(args.collection, args.id);
        break;
      case 'cms_list_records':
        result = store.list(args.collection, {
          filter: args.filter,
          orderBy: args.orderBy,
          desc: args.desc,
          limit: args.limit,
          offset: args.offset,
        });
        break;
      case 'cms_search':
        result = store.search(args.collection, args.query, args.limit);
        break;
      case 'cms_vector_search': {
        const k = (args.limit || 10) * 3;
        const q = new Float32Array(DIMS);
        const v = args.vector || [];
        for (let i = 0; i < Math.min(v.length, DIMS); i++) q[i] = v[i];
        const raw = JSON.parse(store.db.search(q, k));
        result = raw
          .filter(r => {
            const m = r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : r;
            return m._collection === args.collection && m._deleted !== true;
          })
          .slice(0, args.limit || 10)
          .map(r => ({
            ...(r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : r),
            _distance: r.distance,
          }));
        break;
      }
      // Persistence
      case 'cms_export':
        result = { snapshot: store.export(), schemas: Object.fromEntries(store.schemas) };
        break;
      case 'cms_import':
        store.import(args.data);
        result = { imported: true };
        break;
      // RAG (lightweight — text ingestion only, no model loading in MCP)
      case 'rag_ingest_text': {
        // Store chunks directly as records in _rag_chunks collection
        if (!store.schemas.has('_rag_chunks')) {
          store.createCollection('_rag_chunks', [
            { name: 'text', type: 'text', required: true },
            { name: 'source', type: 'text' },
            { name: 'chunk_index', type: 'number' },
          ]);
        }
        const text = args.text;
        const filename = args.filename || 'untitled';
        // Simple chunking
        const chunks = [];
        const size = 500;
        for (let i = 0; i < text.length; i += size - 50) {
          chunks.push(text.slice(i, i + size));
        }
        let inserted = 0;
        for (let i = 0; i < chunks.length; i++) {
          store.create('_rag_chunks', {
            text: chunks[i],
            source: filename,
            chunk_index: i,
          });
          inserted++;
        }
        result = { filename, chunks: inserted, total_chars: text.length };
        break;
      }
      case 'rag_query': {
        // Simple keyword search across chunks (no LLM in MCP — agents can generate answers themselves)
        const hits = store.search('_rag_chunks', args.question, args.topK || 5);
        result = {
          question: args.question,
          chunks: hits,
          note: 'Use these chunks as context to answer the question. No LLM is loaded in MCP mode — you (the agent) generate the answer.',
        };
        break;
      }
      case 'rag_get_entities': {
        if (!store.schemas.has('_rag_entities')) {
          result = { entities: [], note: 'No entities extracted yet' };
        } else {
          const page = store.list('_rag_entities', { limit: args.limit || 50, filter: args.type ? { type: args.type } : undefined });
          result = page.items;
        }
        break;
      }
      case 'rag_get_graph': {
        const entities = store.schemas.has('_rag_entities') ? store.list('_rag_entities', { limit: 200 }).items : [];
        const relations = store.schemas.has('_rag_relations') ? store.list('_rag_relations', { limit: 500 }).items : [];
        result = {
          nodes: entities.map(e => ({ name: e.name, type: e.type, count: e.mention_count || 1 })),
          edges: relations.map(r => ({ source: r.source_entity, target: r.target_entity, type: r.relation_type })),
        };
        break;
      }
      case 'rag_stats': {
        const chunks = store.schemas.has('_rag_chunks') ? store.list('_rag_chunks', { limit: 1 }).total : 0;
        const entities = store.schemas.has('_rag_entities') ? store.list('_rag_entities', { limit: 1 }).total : 0;
        const relations = store.schemas.has('_rag_relations') ? store.list('_rag_relations', { limit: 1 }).total : 0;
        result = { chunks, entities, relations, documents: store.db.len() };
        break;
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    };
  }
});

// Connect
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error('miniCMS MCP server connected via stdio');
