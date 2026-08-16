/**
 * Where installed dictionary packs live, and how a file becomes one.
 *
 * IndexedDB rather than `storage.local`, for two reasons that both bite at
 * this size: extension local storage is capped at a few megabytes, and it is
 * a key-value map with no index, so finding one head-word would mean reading
 * the whole dictionary into memory on every lookup. A pack is 36,000 entries
 * and about 5 MB; it needs a real index and a real quota.
 *
 * Definitions are stored as text rather than as offsets into the original
 * file. Keeping the blob would halve the storage and mean holding a five
 * megabyte buffer resident in a service worker that the browser tears down
 * every thirty seconds — the wrong side of that trade.
 *
 * Parsing runs in the settings page, where the file picker is; reading runs
 * in the service worker. Both are the same extension origin, so they see the
 * same database.
 */
import {
  languagePairFromName,
  parseDictdIndex,
  parseEntryText,
  parseStarDictIdx,
  parseStarDictIfo,
  parseTsv,
  type PackEntry,
  type PackFormat,
  type PackHit,
  type PackLookup,
  type PackMeta,
  type PackRecord,
} from '../core/packs.ts';

const DB_NAME = 'quick-lookup-packs';
const DB_VERSION = 1;
const PACKS = 'packs';
const ENTRIES = 'entries';

/** Rows per transaction while importing. Large enough to be fast, small
 * enough that the page stays responsive and progress means something. */
const CHUNK = 2000;

type EntryRow = {
  pack: string;
  /** Lower-cased head-word. The only thing looked up. */
  key: string;
  headword: string;
  text: string;
};

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PACKS)) {
        db.createObjectStore(PACKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ENTRIES)) {
        const store = db.createObjectStore(ENTRIES, { keyPath: ['pack', 'key'] });
        // Head-words are looked up across every installed pack at once, so
        // the index is on the word alone and not on the compound key.
        store.createIndex('key', 'key', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  });
  return database;
}

function promise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
  });
}

export async function listPacks(): Promise<PackMeta[]> {
  const db = await open();
  const rows = await promise(db.transaction(PACKS, 'readonly').objectStore(PACKS).getAll());
  return (rows as PackMeta[]).sort((a, b) => a.name.localeCompare(b.name));
}

export async function removePack(id: string): Promise<void> {
  const db = await open();
  const transaction = db.transaction([PACKS, ENTRIES], 'readwrite');
  transaction.objectStore(PACKS).delete(id);

  // A range over the compound key deletes one pack's rows without touching
  // another's, which `clear()` would. The upper bound is `[id, []]` because
  // IndexedDB sorts arrays after every string, so it is above any head-word;
  // a sentinel character would not be, and the entries past it would survive
  // the pack that owned them.
  transaction.objectStore(ENTRIES).delete(IDBKeyRange.bound([id], [id, []]));
  await finished(transaction);
}

/**
 * Reading side, handed to the lookup pipeline.
 *
 * The metadata list is read once and kept, because it is a handful of rows
 * and every lookup needs it to know which pack an entry came from. The
 * entries themselves are never cached here: the lookup cache upstream
 * already covers repeats, and a dictionary in memory is the thing this
 * module exists to avoid.
 */
export function packLookup(): PackLookup {
  let metaById: Promise<Map<string, PackMeta>> | undefined;

  const meta = () => {
    metaById ??= listPacks()
      .then((packs) => new Map(packs.map((pack) => [pack.id, pack])))
      .catch(() => new Map<string, PackMeta>());
    return metaById;
  };

  return {
    refresh() {
      metaById = undefined;
    },

    async signature(): Promise<string> {
      const known = await meta();
      if (known.size === 0) return '';
      // Entry count as well as id: re-importing a corrected copy keeps the
      // id, and the corrected answers would otherwise stay behind the cache.
      return [...known.values()]
        .map((pack) => `${pack.id}:${pack.entries}`)
        .sort()
        .join(',');
    },

    async entries(headword: string): Promise<PackHit[]> {
      const known = await meta();
      if (known.size === 0) return [];

      const db = await open();
      const store = db.transaction(ENTRIES, 'readonly').objectStore(ENTRIES);
      const rows = (await promise(store.index('key').getAll(headword))) as EntryRow[];

      const hits: PackHit[] = [];
      for (const row of rows) {
        const pack = known.get(row.pack);
        if (!pack) continue;
        hits.push({ pack, entry: parseEntryText(row.headword, row.text) });
      }
      return hits;
    },
  };
}

/** gzip, by its magic bytes rather than by the file name. A `.dict` that is
 * really compressed, or a `.dz` that is not, are both things people have. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * dictzip is gzip with an extra header field, so the browser's own
 * decompressor reads it. The extra field is what makes random access
 * possible; nothing here needs random access, so it is simply ignored.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type PackFiles = {
  format: PackFormat;
  /** `.index` for dictd, `.idx` for StarDict, the whole file for tsv. */
  index: File;
  /** `.dict` or `.dict.dz`. Absent for tsv, which carries its own text. */
  dict?: File;
  /** `.ifo`. StarDict only. */
  info?: File;
};

/**
 * Works out which file is which, or says what is missing.
 *
 * The reader has just unpacked an archive and is looking at three files with
 * the same stem, so asking them to say which is the index would be asking
 * them to read this code. Naming what is missing matters more than being
 * clever: "no .dict file" is actionable, "unsupported" is not.
 */
export function classifyFiles(files: File[]): PackFiles | string {
  const find = (test: (name: string) => boolean) =>
    files.find((file) => test(file.name.toLowerCase()));

  const info = find((name) => name.endsWith('.ifo'));
  const starIndex = find((name) => name.endsWith('.idx') || name.endsWith('.idx.gz'));
  const dictIndex = find((name) => name.endsWith('.index'));
  const dict = find((name) => name.endsWith('.dict') || name.endsWith('.dict.dz'));
  const tsv = find((name) => /\.(tsv|tab|txt)$/.test(name));

  if (info || starIndex) {
    if (!starIndex) return 'This looks like StarDict, but there is no .idx file.';
    if (!dict) return 'This looks like StarDict, but there is no .dict or .dict.dz file.';
    return { format: 'stardict', index: starIndex, dict, ...(info ? { info } : {}) };
  }
  if (dictIndex) {
    if (!dict) return 'This looks like a dictd dictionary, but there is no .dict or .dict.dz file.';
    return { format: 'dictd', index: dictIndex, dict };
  }
  if (tsv) return { format: 'tsv', index: tsv };

  return 'No dictionary recognised. Expected .index and .dict.dz, or .ifo with .idx and .dict.dz, or a tab-separated .tsv.';
}

async function bytesOf(file: File): Promise<Uint8Array> {
  return gunzip(new Uint8Array(await file.arrayBuffer()));
}

export type PackPreview = {
  files: PackFiles;
  /** Suggested, never assumed — the import form shows these to be corrected. */
  name: string;
  source: string;
  target: string;
  records: PackRecord[];
  blob: Uint8Array;
};

/**
 * Reads the files far enough to say what is in them, without writing
 * anything.
 *
 * Installing a wrong guess is expensive to undo and the languages cannot be
 * derived reliably, so parsing and installing are two steps with the reader
 * in between.
 */
export async function readPack(files: PackFiles): Promise<PackPreview> {
  const guess = languagePairFromName(files.index.name) ?? { source: 'en', target: 'en' };
  let name = files.index.name.replace(/\.(index|idx|ifo|tsv|tab|txt)(\.gz)?$/i, '');

  if (files.format === 'tsv') {
    const text = new TextDecoder().decode(await bytesOf(files.index));
    const { records, blob } = parseTsv(text);
    return { files, name, ...guess, records, blob: new TextEncoder().encode(blob) };
  }

  const blob = await bytesOf(files.dict as File);

  if (files.format === 'dictd') {
    const text = new TextDecoder().decode(await bytesOf(files.index));
    return { files, name, ...guess, records: parseDictdIndex(text), blob };
  }

  // StarDict keeps the offset width and the human-readable title in the
  // .ifo. Both are optional here: the width defaults to what nearly every
  // pack uses, and a missing title falls back to the file name.
  let offsetBits: 32 | 64 = 32;
  if (files.info) {
    const ifo = parseStarDictIfo(new TextDecoder().decode(await files.info.arrayBuffer()));
    if (ifo.idxoffsetbits === '64') offsetBits = 64;
    if (ifo.bookname) name = ifo.bookname;
  }
  const records = parseStarDictIdx(await bytesOf(files.index), offsetBits);
  return { files, name, ...guess, records, blob };
}

/**
 * Writes a parsed pack to storage, replacing any pack already under that id.
 *
 * The id comes from the name so that re-importing a corrected copy replaces
 * the old one instead of doubling every answer — the failure mode of a
 * content-addressed id would be a card that says everything twice.
 */
export async function installPack(
  preview: PackPreview,
  chosen: { name: string; source: string; target: string },
  onProgress?: (done: number, total: number) => void,
): Promise<PackMeta> {
  const id = chosen.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pack';
  await removePack(id);

  const decoder = new TextDecoder();

  // Rows are collected before any are written, because a head-word can
  // appear more than once — one spelling, several parts of speech — and the
  // store is keyed by it. Writing them one at a time would let the last
  // occurrence replace the rest, silently losing half of a common word's
  // entry. Merging first costs one pass over a file already in memory.
  const rows = new Map<string, EntryRow>();
  for (const record of preview.records) {
    const text = decoder
      .decode(preview.blob.subarray(record.offset, record.offset + record.length))
      .trim();
    const headword = record.headword.trim();
    const key = headword.toLowerCase();
    if (!text || !key) continue;

    const existing = rows.get(key);
    if (existing) existing.text += `\n${text}`;
    else rows.set(key, { pack: id, key, headword, text });
  }

  const db = await open();
  const all = [...rows.values()];
  for (let start = 0; start < all.length; start += CHUNK) {
    const transaction = db.transaction(ENTRIES, 'readwrite');
    const store = transaction.objectStore(ENTRIES);
    for (const row of all.slice(start, start + CHUNK)) store.put(row);
    await finished(transaction);
    onProgress?.(Math.min(start + CHUNK, all.length), all.length);
  }
  const written = all.length;

  const meta: PackMeta = {
    id,
    name: chosen.name,
    source: chosen.source,
    target: chosen.target,
    format: preview.files.format,
    entries: written,
    installedAt: Date.now(),
  };
  const transaction = db.transaction(PACKS, 'readwrite');
  transaction.objectStore(PACKS).put(meta);
  await finished(transaction);
  return meta;
}

/** Re-exported so the settings page has one import for the whole feature. */
export type { PackEntry, PackMeta };
