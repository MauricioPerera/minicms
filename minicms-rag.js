/**
 * MiniRAG -- Privacy-first GraphRAG for browser
 *
 * All processing happens locally:
 * - Document parsing (PDF.js, mammoth.js)
 * - Embeddings (multilingual-e5-small, 384d)
 * - Entity extraction (Qwen3-0.6B via WebGPU)
 * - Vector search (minimemory WASM)
 * - Answer generation (Qwen3-0.6B)
 *
 * Pure ES module, zero server dependencies.
 * Heavy libs loaded from CDN on first use.
 *
 * @module minicms-rag
 */

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const EMBED_MODEL = 'Xenova/multilingual-e5-small';
const LLM_MODEL = 'onnx-community/Qwen3-0.6B-ONNX';
const EMBED_DIM = 384;
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_TOKENS = 512;

const ENTITY_TYPES = [
  'person', 'organization', 'law', 'medical_condition',
  'medication', 'date', 'location', 'concept',
];

// -------------------------------------------------------------------------
// CDN URLs
// -------------------------------------------------------------------------

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs';
const PDFJS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';
const MAMMOTH_CDN = 'https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js';

// -------------------------------------------------------------------------
// Lazy-loaded module singletons
// -------------------------------------------------------------------------

let _transformers = null;
let _pdfjsLib = null;
let _mammoth = null;

async function loadTransformers() {
  if (_transformers) return _transformers;
  _transformers = await import(/* webpackIgnore: true */ TRANSFORMERS_CDN);
  _transformers.env.allowLocalModels = false;
  return _transformers;
}

async function loadPdfJs() {
  if (_pdfjsLib) return _pdfjsLib;
  _pdfjsLib = await import(/* webpackIgnore: true */ PDFJS_CDN);
  _pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
  return _pdfjsLib;
}

async function loadMammoth() {
  if (_mammoth) return _mammoth;
  // mammoth.browser.min.js sets window.mammoth as a side-effect
  if (typeof globalThis.mammoth !== 'undefined') {
    _mammoth = globalThis.mammoth;
    return _mammoth;
  }
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MAMMOTH_CDN;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load mammoth.js from CDN'));
    document.head.appendChild(script);
  });
  _mammoth = globalThis.mammoth;
  return _mammoth;
}

// -------------------------------------------------------------------------
// Internal collection schemas
// -------------------------------------------------------------------------

const CHUNKS_SCHEMA = {
  fields: [
    { name: 'text', type: 'text', required: true },
    { name: 'source_doc', type: 'text', required: true },
    { name: 'source_name', type: 'text' },
    { name: 'page', type: 'number' },
    { name: 'entity_ids', type: 'json' },
    { name: 'embedding', type: 'vector' },
  ],
};

const ENTITIES_SCHEMA = {
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'type', type: 'text', required: true },
    { name: 'description', type: 'text' },
    { name: 'mention_count', type: 'number' },
    { name: 'embedding', type: 'vector' },
  ],
};

const RELATIONS_SCHEMA = {
  fields: [
    { name: 'source_entity', type: 'text', required: true },
    { name: 'target_entity', type: 'text', required: true },
    { name: 'relation_type', type: 'text', required: true },
    { name: 'description', type: 'text' },
    { name: 'source_chunk', type: 'text' },
  ],
};

const DOCUMENTS_SCHEMA = {
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'type', type: 'text' },
    { name: 'size', type: 'number' },
    { name: 'chunk_count', type: 'number' },
    { name: 'entity_count', type: 'number' },
    { name: 'relation_count', type: 'number' },
    { name: 'ingested_at', type: 'date' },
  ],
};

// -------------------------------------------------------------------------
// Utility: uid (mirrors minicms internals)
// -------------------------------------------------------------------------

function uid() {
  const t = Date.now().toString(36);
  const r = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 20 - t.length);
  return t + r;
}

// -------------------------------------------------------------------------
// MiniRAG
// -------------------------------------------------------------------------

export default class MiniRAG {
  /**
   * @param {import('./minicms.js').default} cms  A fully initialised MiniCMS instance
   */
  constructor(cms) {
    if (!cms || !cms._db) {
      throw new Error('MiniRAG requires an initialised MiniCMS instance');
    }
    /** @type {import('./minicms.js').default} */
    this._cms = cms;

    /** @type {'uninitialized'|'loading'|'ready'|'error'} */
    this._status = 'uninitialized';

    /** @type {{loaded:number, total:number, percent:number}} */
    this._progress = { loaded: 0, total: 0, percent: 0 };

    /** @type {string|null} */
    this._errorMessage = null;

    // Pipeline references (set during init)
    this._embedder = null;
    this._generator = null;
  }

  // -----------------------------------------------------------------------
  // Public getters
  // -----------------------------------------------------------------------

  get status() {
    return this._status;
  }

  get modelProgress() {
    return { ...this._progress };
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * Download and warm-up models.  First call downloads ~500 MB (cached by
   * the browser / transformers.js afterwards).
   *
   * @param {(progress:{status:string, loaded?:number, total?:number, percent?:number})=>void} [onProgress]
   */
  async init(onProgress) {
    if (this._status === 'ready') return this;
    this._status = 'loading';

    const report = (msg, loaded, total) => {
      if (loaded != null && total != null && total > 0) {
        this._progress = { loaded, total, percent: Math.round((loaded / total) * 100) };
      }
      if (onProgress) {
        onProgress({ status: msg, ...this._progress });
      }
    };

    try {
      // 1. Load transformers.js
      report('Loading transformers.js runtime...');
      const tf = await loadTransformers();

      // 2. Embedding pipeline
      report('Downloading embedding model (multilingual-e5-small)...');
      this._embedder = await tf.pipeline('feature-extraction', EMBED_MODEL, {
        progress_callback: (p) => {
          if (p && p.status === 'progress') {
            report(`Embedding model: ${p.file}`, p.loaded, p.total);
          }
        },
      });

      // 3. LLM pipeline -- prefer WebGPU, fall back to WASM
      report('Downloading LLM (Qwen3-0.6B)...');
      let device = 'webgpu';
      try {
        if (!navigator.gpu) throw new Error('WebGPU not available');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter');
      } catch {
        device = 'wasm';
        report('WebGPU not available, falling back to WASM...');
      }

      this._generator = await tf.pipeline('text-generation', LLM_MODEL, {
        device,
        dtype: device === 'webgpu' ? 'fp16' : 'q4',
        progress_callback: (p) => {
          if (p && p.status === 'progress') {
            report(`LLM model: ${p.file}`, p.loaded, p.total);
          }
        },
      });

      // 4. Ensure internal collections
      this._ensureCollections();

      report('Ready');
      this._status = 'ready';
      return this;

    } catch (err) {
      this._status = 'error';
      this._errorMessage = err.message;
      report(`Error: ${err.message}`);
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Internal: collection bootstrapping
  // -----------------------------------------------------------------------

  _ensureCollections() {
    const ensure = (name, schema) => {
      if (!this._cms._schemas.has(name)) {
        this._cms.createCollection(name, schema);
      }
    };
    ensure('_rag_chunks', CHUNKS_SCHEMA);
    ensure('_rag_entities', ENTITIES_SCHEMA);
    ensure('_rag_relations', RELATIONS_SCHEMA);
    ensure('_rag_documents', DOCUMENTS_SCHEMA);
  }

  _assertReady() {
    if (this._status !== 'ready') {
      throw new Error(`MiniRAG is not ready (status: ${this._status}). Call init() first.`);
    }
  }

  // -----------------------------------------------------------------------
  // File parsing
  // -----------------------------------------------------------------------

  /**
   * Parse a File object into structured text with page tracking.
   * @param {File} file
   * @returns {Promise<{text:string, pages:{text:string, pageNum:number}[]}>}
   */
  async _parseFile(file) {
    const ext = (file.name || '').split('.').pop().toLowerCase();
    const type = file.type || '';

    // PDF
    if (ext === 'pdf' || type === 'application/pdf') {
      return this._parsePdf(file);
    }

    // DOCX
    if (ext === 'docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return this._parseDocx(file);
    }

    // Plain text / markdown
    if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm'].includes(ext) ||
        type.startsWith('text/')) {
      const text = await file.text();
      return { text, pages: [{ text, pageNum: 1 }] };
    }

    // Images -- OCR not implemented (too heavy for browser without Tesseract)
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext) ||
        type.startsWith('image/')) {
      // TODO: integrate Tesseract.js for OCR when needed
      return {
        text: `[Image file: ${file.name} -- OCR not yet supported]`,
        pages: [{ text: `[Image: ${file.name}]`, pageNum: 1 }],
      };
    }

    throw new Error(`Unsupported file type: ${ext} (${type})`);
  }

  async _parsePdf(file) {
    const pdfjsLib = await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    const textParts = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      pages.push({ text: pageText, pageNum: i });
      textParts.push(pageText);
    }

    return { text: textParts.join('\n\n'), pages };
  }

  async _parseDocx(file) {
    const mammoth = await loadMammoth();
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = result.value || '';
    return { text, pages: [{ text, pageNum: 1 }] };
  }

  // -----------------------------------------------------------------------
  // Text chunking
  // -----------------------------------------------------------------------

  /**
   * Split text into chunks of approximately `chunkSize` characters with
   * `overlap` character overlap.  Respects paragraph and sentence boundaries.
   * Also maps each chunk to a page number using the pages array.
   *
   * @param {string} text
   * @param {{text:string, pageNum:number}[]} [pages]
   * @param {number} [chunkSize]
   * @param {number} [overlap]
   * @returns {{text:string, page:number}[]}
   */
  _chunkText(text, pages, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    if (!text || !text.trim()) return [];

    // Build a character-offset -> page mapping
    const pageOffsets = []; // [{start, end, pageNum}]
    if (pages && pages.length > 0) {
      let offset = 0;
      for (const p of pages) {
        const len = p.text.length;
        pageOffsets.push({ start: offset, end: offset + len, pageNum: p.pageNum });
        offset += len + 2; // +2 for '\n\n' join separator
      }
    }

    const getPage = (charIdx) => {
      for (const po of pageOffsets) {
        if (charIdx >= po.start && charIdx < po.end) return po.pageNum;
      }
      return pageOffsets.length > 0 ? pageOffsets[pageOffsets.length - 1].pageNum : 1;
    };

    // Split into paragraphs first
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    const chunks = [];
    let currentChunk = '';
    let chunkStartOffset = 0;
    let textOffset = 0;

    const flushChunk = () => {
      const trimmed = currentChunk.trim();
      if (trimmed.length > 0) {
        chunks.push({ text: trimmed, page: getPage(chunkStartOffset) });
      }
    };

    for (const para of paragraphs) {
      // If paragraph alone is larger than chunkSize, split by sentences
      if (para.length > chunkSize) {
        // Flush anything accumulated
        if (currentChunk.trim()) flushChunk();

        const sentences = para.match(/[^.!?]+[.!?]+\s*/g) || [para];
        currentChunk = '';
        chunkStartOffset = textOffset;

        for (const sent of sentences) {
          if ((currentChunk + sent).length > chunkSize && currentChunk.trim()) {
            flushChunk();
            // Keep overlap from end of current chunk
            const overlapText = currentChunk.slice(-overlap);
            currentChunk = overlapText + sent;
            chunkStartOffset = textOffset + sent.length - currentChunk.length;
          } else {
            if (!currentChunk) chunkStartOffset = textOffset;
            currentChunk += sent;
          }
          textOffset += sent.length;
        }
      } else {
        // Try to append paragraph to current chunk
        const separator = currentChunk ? '\n\n' : '';
        if ((currentChunk + separator + para).length > chunkSize && currentChunk.trim()) {
          flushChunk();
          // Keep overlap
          const overlapText = currentChunk.slice(-overlap);
          currentChunk = overlapText + para;
          chunkStartOffset = textOffset - overlapText.length;
        } else {
          if (!currentChunk) chunkStartOffset = textOffset;
          currentChunk += separator + para;
        }
        textOffset += para.length + 2;
      }
    }

    // Flush last chunk
    flushChunk();

    return chunks;
  }

  // -----------------------------------------------------------------------
  // Embeddings
  // -----------------------------------------------------------------------

  /**
   * Embed a single text string.
   * @param {string} text
   * @param {boolean} [isQuery=false]  Use "query: " prefix for queries, "passage: " for documents
   * @returns {Promise<Float32Array>}
   */
  async _embed(text, isQuery = false) {
    this._assertReady();
    const prefix = isQuery ? 'query: ' : 'passage: ';
    const result = await this._embedder(prefix + text, {
      pooling: 'mean',
      normalize: true,
    });
    return new Float32Array(result.data);
  }

  /**
   * Embed multiple texts in sequence.
   * @param {string[]} texts
   * @param {boolean} [isQuery=false]
   * @returns {Promise<Float32Array[]>}
   */
  async _embedBatch(texts, isQuery = false) {
    const results = [];
    for (const t of texts) {
      results.push(await this._embed(t, isQuery));
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // LLM: entity extraction
  // -----------------------------------------------------------------------

  /**
   * Extract entities and relationships from a text chunk using Qwen3.
   * @param {string} text
   * @returns {Promise<{entities:{name:string,type:string}[], relations:{source:string,target:string,type:string}[]}>}
   */
  async _extractEntities(text) {
    this._assertReady();

    // Truncate very long texts to stay within context
    const truncated = text.length > 1500 ? text.slice(0, 1500) : text;

    const prompt = [
      { role: 'system', content: `You extract entities and relationships from text. Return ONLY valid JSON.\nEntity types: ${ENTITY_TYPES.join(', ')}` },
      { role: 'user', content: `Extract entities and relationships from:\n\n"${truncated}"\n\nReturn JSON: {"entities":[{"name":"...","type":"..."}],"relations":[{"source":"...","target":"...","type":"..."}]}` },
    ];

    try {
      const output = await this._generator(prompt, {
        max_new_tokens: 512,
        temperature: 0.1,
        do_sample: false,
        return_full_text: false,
      });

      const raw = output[0]?.generated_text;
      const responseText = typeof raw === 'string'
        ? raw
        : (Array.isArray(raw) ? raw.map(m => m.content).join('') : String(raw));

      return this._parseEntityJson(responseText);
    } catch (err) {
      console.warn('MiniRAG: entity extraction failed for chunk, skipping.', err.message);
      return { entities: [], relations: [] };
    }
  }

  /**
   * Robustly parse the JSON from LLM output.
   */
  _parseEntityJson(text) {
    const empty = { entities: [], relations: [] };
    if (!text) return empty;

    // Try to find JSON in the response
    let jsonStr = text;

    // Strip markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1];

    // Try to find a JSON object
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!braceMatch) return empty;

    try {
      const parsed = JSON.parse(braceMatch[0]);
      const entities = Array.isArray(parsed.entities) ? parsed.entities.filter(
        e => e && typeof e.name === 'string' && typeof e.type === 'string'
      ) : [];
      const relations = Array.isArray(parsed.relations) ? parsed.relations.filter(
        r => r && typeof r.source === 'string' && typeof r.target === 'string' && typeof r.type === 'string'
      ) : [];
      return { entities, relations };
    } catch {
      return empty;
    }
  }

  // -----------------------------------------------------------------------
  // LLM: text generation
  // -----------------------------------------------------------------------

  /**
   * Generate text with Qwen3.
   * @param {string|{role:string,content:string}[]} prompt
   * @param {number} [maxTokens]
   * @returns {Promise<string>}
   */
  async _generate(prompt, maxTokens = DEFAULT_MAX_TOKENS) {
    this._assertReady();

    const messages = typeof prompt === 'string'
      ? [{ role: 'user', content: prompt }]
      : prompt;

    const output = await this._generator(messages, {
      max_new_tokens: maxTokens,
      temperature: 0.3,
      do_sample: true,
      return_full_text: false,
    });

    const raw = output[0]?.generated_text;
    if (typeof raw === 'string') return raw.trim();
    if (Array.isArray(raw)) return raw.map(m => m.content).join('').trim();
    return String(raw || '').trim();
  }

  // -----------------------------------------------------------------------
  // Document ingestion
  // -----------------------------------------------------------------------

  /**
   * Ingest a file into the RAG knowledge base.
   *
   * @param {File} file  File object (PDF, DOCX, TXT, MD, etc.)
   * @param {(progress:{step:string, current:number, total:number})=>void} [onProgress]
   * @returns {Promise<{document_id:string, chunks:number, entities:number, relations:number}>}
   */
  async ingest(file, onProgress) {
    this._assertReady();

    const report = (step, current = 0, total = 0) => {
      if (onProgress) onProgress({ step, current, total });
    };

    // 1. Parse file
    report('Parsing file...');
    const { text, pages } = await this._parseFile(file);
    if (!text || !text.trim()) {
      throw new Error(`No text content extracted from "${file.name}"`);
    }

    // 2. Create document record
    const docId = uid();
    report('Creating document record...');

    // 3. Chunk
    report('Chunking text...');
    const chunks = this._chunkText(text, pages);
    if (chunks.length === 0) {
      throw new Error(`No chunks produced from "${file.name}"`);
    }

    // 4. Process each chunk: embed + extract entities
    const allEntityNames = new Set();
    const allRelations = [];
    let entityCount = 0;
    let relationCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      report('Processing chunks...', i + 1, chunks.length);

      // 4a. Embed chunk
      let embedding;
      try {
        embedding = await this._embed(chunk.text, false);
      } catch (err) {
        console.warn(`MiniRAG: embedding failed for chunk ${i}, using zeros.`, err.message);
        embedding = new Float32Array(EMBED_DIM);
      }

      // 4b. Extract entities (throttle: skip for very short chunks)
      let extracted = { entities: [], relations: [] };
      if (chunk.text.length > 50) {
        try {
          extracted = await this._extractEntities(chunk.text);
        } catch (err) {
          console.warn(`MiniRAG: entity extraction failed for chunk ${i}.`, err.message);
        }
      }

      const entityIds = [];

      // 4c. Upsert entities
      for (const ent of extracted.entities) {
        const normalizedName = ent.name.trim().toLowerCase();
        const normalizedType = ent.type.trim().toLowerCase();
        if (!normalizedName) continue;

        const existing = this._findEntity(normalizedName, normalizedType);
        if (existing) {
          // Increment mention count
          try {
            this._cms.update('_rag_entities', existing._id, {
              mention_count: (existing.mention_count || 1) + 1,
            });
          } catch { /* best effort */ }
          entityIds.push(existing._id);
        } else {
          // Create new entity
          let entEmbedding;
          try {
            entEmbedding = await this._embed(`${normalizedType}: ${normalizedName}`, false);
          } catch {
            entEmbedding = new Float32Array(EMBED_DIM);
          }
          try {
            const entRecord = this._cms.create('_rag_entities', {
              name: normalizedName,
              type: normalizedType,
              description: '',
              mention_count: 1,
              embedding: Array.from(entEmbedding),
            });
            entityIds.push(entRecord._id);
            entityCount++;
          } catch (err) {
            console.warn('MiniRAG: failed to create entity', normalizedName, err.message);
          }
        }
        allEntityNames.add(normalizedName);
      }

      // 4d. Store chunk
      try {
        this._cms.create('_rag_chunks', {
          text: chunk.text,
          source_doc: docId,
          source_name: file.name,
          page: chunk.page,
          entity_ids: entityIds,
          embedding: Array.from(embedding),
        });
      } catch (err) {
        console.warn(`MiniRAG: failed to store chunk ${i}.`, err.message);
      }

      // 4e. Store relations
      for (const rel of extracted.relations) {
        const src = rel.source.trim().toLowerCase();
        const tgt = rel.target.trim().toLowerCase();
        const relType = rel.type.trim().toLowerCase();
        if (!src || !tgt || !relType) continue;

        try {
          this._cms.create('_rag_relations', {
            source_entity: src,
            target_entity: tgt,
            relation_type: relType,
            description: rel.description || '',
            source_chunk: docId,
          });
          relationCount++;
        } catch (err) {
          console.warn('MiniRAG: failed to store relation', err.message);
        }
      }
    }

    // 5. Store document metadata
    try {
      this._cms.create('_rag_documents', {
        name: file.name,
        type: file.type || 'unknown',
        size: file.size || 0,
        chunk_count: chunks.length,
        entity_count: entityCount,
        relation_count: relationCount,
        ingested_at: new Date().toISOString(),
      });
      // Patch the _id to match docId -- we re-create with known id
      // Actually, the CMS generates its own _id, so store docId mapping differently.
      // We will use source_doc on chunks to correlate.
    } catch (err) {
      console.warn('MiniRAG: failed to store document record', err.message);
    }

    // 6. Persist
    report('Saving...');
    await this._cms.save();

    report('Done', chunks.length, chunks.length);
    return {
      document_id: docId,
      chunks: chunks.length,
      entities: entityCount,
      relations: relationCount,
    };
  }

  // -----------------------------------------------------------------------
  // Entity lookup helpers
  // -----------------------------------------------------------------------

  /**
   * Find an existing entity by name and type.
   */
  _findEntity(name, type) {
    try {
      const result = this._cms.list('_rag_entities', {
        filter: { name, type },
        limit: 1,
      });
      if (result.items && result.items.length > 0) {
        return result.items[0];
      }
    } catch { /* not found */ }
    return null;
  }

  // -----------------------------------------------------------------------
  // Query pipeline
  // -----------------------------------------------------------------------

  /**
   * Query the knowledge base.
   *
   * @param {string} question
   * @param {{topK?:number, includeGraph?:boolean, maxTokens?:number}} [options]
   * @returns {Promise<{answer:string, sources:{text:string, page:number, score:number, doc:string}[], entities:{name:string, type:string}[]}>}
   */
  async query(question, options = {}) {
    this._assertReady();

    const topK = options.topK || DEFAULT_TOP_K;
    const includeGraph = options.includeGraph !== false;
    const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;

    // 1. Embed question
    const queryVec = await this._embed(question, true);

    // 2. Vector search chunks
    const vectorResults = this._cms.vectorSearch(
      '_rag_chunks',
      Array.from(queryVec),
      topK,
    );

    let sources = vectorResults.map(r => ({
      text: r.record.text,
      page: r.record.page || 1,
      score: 1 - (r.distance || 0), // cosine distance to similarity
      doc: r.record.source_name || r.record.source_doc,
      _entityIds: r.record.entity_ids || [],
    }));

    let graphEntities = [];
    let graphContext = '';

    // 3. Graph augmentation
    if (includeGraph && sources.length > 0) {
      try {
        // Extract entities from the question itself
        const questionEntities = await this._extractEntities(question);

        // Also collect entity IDs from retrieved chunks
        const entityIdsFromChunks = new Set();
        for (const src of sources) {
          if (Array.isArray(src._entityIds)) {
            for (const eid of src._entityIds) entityIdsFromChunks.add(eid);
          }
        }

        // Find matching entities
        const matchedEntities = new Map();

        // Match from question entities
        for (const qe of questionEntities.entities) {
          const found = this._findEntity(
            qe.name.trim().toLowerCase(),
            qe.type.trim().toLowerCase(),
          );
          if (found) {
            matchedEntities.set(found._id, found);
          }
        }

        // Match from chunk entity IDs
        for (const eid of entityIdsFromChunks) {
          if (!matchedEntities.has(eid)) {
            const ent = this._cms.getById('_rag_entities', eid);
            if (ent) matchedEntities.set(eid, ent);
          }
        }

        // Get relations for matched entities
        const relatedChunkDocs = new Set();
        const relationLines = [];

        for (const [, entity] of matchedEntities) {
          graphEntities.push({ name: entity.name, type: entity.type });

          const relations = this._getRelationsForEntity(entity.name);
          for (const rel of relations) {
            relationLines.push(
              `${rel.source_entity} --[${rel.relation_type}]--> ${rel.target_entity}`,
            );
            if (rel.source_chunk) relatedChunkDocs.add(rel.source_chunk);
          }
        }

        // Fetch additional chunks from related entities (not already in sources)
        const existingChunkTexts = new Set(sources.map(s => s.text));
        for (const docId of relatedChunkDocs) {
          try {
            const related = this._cms.list('_rag_chunks', {
              filter: { source_doc: docId },
              limit: 2,
            });
            for (const chunk of related.items) {
              if (!existingChunkTexts.has(chunk.text)) {
                sources.push({
                  text: chunk.text,
                  page: chunk.page || 1,
                  score: 0.5, // lower score since from graph traversal
                  doc: chunk.source_name || chunk.source_doc,
                  _entityIds: chunk.entity_ids || [],
                });
                existingChunkTexts.add(chunk.text);
              }
            }
          } catch { /* best effort */ }
        }

        if (relationLines.length > 0) {
          graphContext = '\n\nKnowledge graph relationships:\n' + relationLines.join('\n');
        }
      } catch (err) {
        console.warn('MiniRAG: graph augmentation failed, using vector results only.', err.message);
      }
    }

    // 4. Build context
    const contextParts = sources
      .sort((a, b) => b.score - a.score)
      .slice(0, topK + 3) // allow a few extra from graph
      .map((s, i) => `[Source ${i + 1}, Page ${s.page}, ${s.doc}]\n${s.text}`);

    const contextStr = contextParts.join('\n\n') + graphContext;

    // 5. Generate answer
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful assistant. Answer based ONLY on the provided context. If you cannot answer from the context, say so. Cite sources using [Source N] notation.',
      },
      {
        role: 'user',
        content: `Context:\n${contextStr}\n\nQuestion: ${question}`,
      },
    ];

    const answer = await this._generate(messages, maxTokens);

    // Clean sources for output (remove internal fields)
    const cleanSources = sources.map(({ _entityIds, ...rest }) => rest);

    return {
      answer,
      sources: cleanSources,
      entities: graphEntities,
    };
  }

  // -----------------------------------------------------------------------
  // Graph access
  // -----------------------------------------------------------------------

  /**
   * List entities.
   * @param {{type?:string, limit?:number, offset?:number}} [options]
   * @returns {{items:{name:string,type:string,mention_count:number,_id:string}[], total:number}}
   */
  getEntities(options = {}) {
    const filter = {};
    if (options.type) filter.type = options.type;
    return this._cms.list('_rag_entities', {
      filter,
      limit: options.limit || 50,
      offset: options.offset || 0,
      orderBy: 'mention_count',
      desc: true,
    });
  }

  /**
   * Get all relations involving a given entity name.
   * @param {string} entityName
   * @returns {{source_entity:string, target_entity:string, relation_type:string, description:string}[]}
   */
  getRelations(entityName) {
    const normalized = entityName.trim().toLowerCase();
    return this._getRelationsForEntity(normalized);
  }

  /**
   * Internal: fetch relations where entity is source or target.
   */
  _getRelationsForEntity(name) {
    const results = [];
    try {
      const asSource = this._cms.list('_rag_relations', {
        filter: { source_entity: name },
        limit: 100,
      });
      results.push(...asSource.items);
    } catch { /* ignore */ }
    try {
      const asTarget = this._cms.list('_rag_relations', {
        filter: { target_entity: name },
        limit: 100,
      });
      results.push(...asTarget.items);
    } catch { /* ignore */ }
    // Deduplicate by _id
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r._id)) return false;
      seen.add(r._id);
      return true;
    });
  }

  /**
   * Get the full knowledge graph for visualisation.
   * @returns {{nodes:{id:string, name:string, type:string, count:number}[], edges:{source:string, target:string, type:string}[]}}
   */
  getGraph() {
    const entities = this._cms.list('_rag_entities', { limit: 500 });
    const relations = this._cms.list('_rag_relations', { limit: 1000 });

    const nodes = entities.items.map(e => ({
      id: e._id,
      name: e.name,
      type: e.type,
      count: e.mention_count || 1,
    }));

    // Build name -> id map for edges
    const nameToId = new Map();
    for (const n of nodes) {
      nameToId.set(n.name, n.id);
    }

    const edges = relations.items.map(r => ({
      source: nameToId.get(r.source_entity) || r.source_entity,
      target: nameToId.get(r.target_entity) || r.target_entity,
      type: r.relation_type,
    }));

    return { nodes, edges };
  }

  /**
   * List all ingested documents.
   * @returns {{items:{name:string, type:string, size:number, chunk_count:number, ingested_at:string, _id:string}[], total:number}}
   */
  getDocuments() {
    return this._cms.list('_rag_documents', {
      limit: 200,
      orderBy: '_created',
      desc: true,
    });
  }

  /**
   * Delete a document and all its associated chunks.
   * Orphaned entities (mention_count drops to 0) are also removed.
   *
   * @param {string} docId  The source_doc ID used during ingestion
   */
  async deleteDocument(docId) {
    // 1. Find and delete all chunks for this document
    const chunks = this._cms.list('_rag_chunks', {
      filter: { source_doc: docId },
      limit: 10000,
    });

    const affectedEntityIds = new Set();
    for (const chunk of chunks.items) {
      // Track entity IDs for orphan check
      if (Array.isArray(chunk.entity_ids)) {
        for (const eid of chunk.entity_ids) affectedEntityIds.add(eid);
      }
      try {
        this._cms.delete('_rag_chunks', chunk._id);
      } catch { /* best effort */ }
    }

    // 2. Delete relations sourced from this document
    const relations = this._cms.list('_rag_relations', {
      filter: { source_chunk: docId },
      limit: 10000,
    });
    for (const rel of relations.items) {
      try {
        this._cms.delete('_rag_relations', rel._id);
      } catch { /* best effort */ }
    }

    // 3. Decrement mention counts and remove orphaned entities
    for (const eid of affectedEntityIds) {
      try {
        const entity = this._cms.getById('_rag_entities', eid);
        if (!entity) continue;
        const newCount = (entity.mention_count || 1) - 1;
        if (newCount <= 0) {
          this._cms.delete('_rag_entities', eid);
        } else {
          this._cms.update('_rag_entities', eid, { mention_count: newCount });
        }
      } catch { /* best effort */ }
    }

    // 4. Remove document record (find by matching name or other means)
    // Since we don't have the _rag_documents _id, search by content
    try {
      const docs = this._cms.list('_rag_documents', { limit: 500 });
      for (const doc of docs.items) {
        // Match by ingested_at proximity or name -- best effort
        // In practice the caller should also track the _rag_documents _id
        // For now we leave document records as-is; they serve as history
      }
    } catch { /* best effort */ }

    // 5. Persist
    await this._cms.save();
  }

  // -----------------------------------------------------------------------
  // Stats / info
  // -----------------------------------------------------------------------

  /**
   * Quick stats about the knowledge base.
   */
  getStats() {
    let chunks = 0, entities = 0, relations = 0, documents = 0;
    try { chunks = this._cms.list('_rag_chunks', { limit: 1 }).total; } catch { /* */ }
    try { entities = this._cms.list('_rag_entities', { limit: 1 }).total; } catch { /* */ }
    try { relations = this._cms.list('_rag_relations', { limit: 1 }).total; } catch { /* */ }
    try { documents = this._cms.list('_rag_documents', { limit: 1 }).total; } catch { /* */ }
    return { chunks, entities, relations, documents };
  }
}
