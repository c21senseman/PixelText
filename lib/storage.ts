import { ChunkKey, SerializedChunk, SparseDocument } from "./document";
import { ImportedDocument, parseBookmarks } from "./io";
import { Bookmark, Camera, MAX_ZOOM, MIN_ZOOM } from "./types";

const DATABASE_NAME = "pixeltext-canvas";
const DATABASE_VERSION = 1;

type StoredChunk = SerializedChunk & { key: string };

type StoredMeta = {
  id: "current";
  camera: Camera;
  bookmarks: Bookmark[];
};

export type SaveSnapshot = {
  revisions: Map<ChunkKey, number>;
  chunks: Array<{ key: ChunkKey; value: StoredChunk | null }>;
  meta: StoredMeta;
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("저장 요청 실패"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("저장 트랜잭션 실패"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("저장 트랜잭션 중단"));
  });
}

export class IndexedDocumentStorage {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("chunks")) {
          database.createObjectStore("chunks", { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains("meta")) {
          database.createObjectStore("meta", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("저장소 열기 실패"));
    });
    return this.databasePromise;
  }

  async load(): Promise<ImportedDocument | null> {
    const database = await this.open();
    const transaction = database.transaction(["chunks", "meta"], "readonly");
    const chunksRequest = transaction.objectStore("chunks").getAll() as IDBRequest<
      StoredChunk[]
    >;
    const metaRequest = transaction.objectStore("meta").get("current") as IDBRequest<
      StoredMeta | undefined
    >;
    const [storedChunks, meta] = await Promise.all([
      requestResult(chunksRequest),
      requestResult(metaRequest),
      transactionDone(transaction),
    ]).then(([chunks, storedMeta]) => [chunks, storedMeta] as const);

    if (!meta && storedChunks.length === 0) return null;
    const document = SparseDocument.fromChunks(
      storedChunks.map(({ x, y, cells }) => ({ x, y, cells })),
    );
    const camera = isStoredCamera(meta?.camera)
      ? meta.camera
      : { x: 0, y: 0, zoom: 1 };
    const bookmarks = meta ? parseBookmarks(meta.bookmarks) : [];
    return { document, camera, bookmarks };
  }

  createSnapshot(
    document: SparseDocument,
    camera: Camera,
    bookmarks: Bookmark[],
  ): SaveSnapshot {
    const revisions = document.dirtySnapshot();
    const chunks = Array.from(revisions.keys()).map((key) => {
      const serialized = document.serializeChunk(key);
      return {
        key,
        value: serialized ? { key, ...serialized } : null,
      };
    });
    return {
      revisions,
      chunks,
      meta: {
        id: "current",
        camera: { ...camera },
        bookmarks: bookmarks.map((bookmark) => ({ ...bookmark })),
      },
    };
  }

  async save(snapshot: SaveSnapshot): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(["chunks", "meta"], "readwrite");
    const chunksStore = transaction.objectStore("chunks");
    for (const chunk of snapshot.chunks) {
      if (chunk.value) chunksStore.put(chunk.value);
      else chunksStore.delete(chunk.key);
    }
    transaction.objectStore("meta").put(snapshot.meta);
    await transactionDone(transaction);
  }
}

function isStoredCamera(camera: unknown): camera is Camera {
  if (typeof camera !== "object" || camera === null) return false;
  const value = camera as Record<string, unknown>;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.zoom === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.zoom) &&
    value.zoom >= MIN_ZOOM &&
    value.zoom <= MAX_ZOOM
  );
}
