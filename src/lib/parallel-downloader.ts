import { get, set, del } from 'idb-keyval';

/**
 * ParallelDownloader
 * ───────────────────────────────────────────────────────────────
 * A high-performance downloader that uses parallel 'Range' requests
 * to saturate bandwidth, and IndexedDB to persist models.
 * 
 * Equivalent to 'OkHttp + WorkManager' strategy for the Web.
 * ───────────────────────────────────────────────────────────────
 */
export class ParallelDownloader {
  private static STORAGE_PREFIX = 'nexus-model-';
  private static CHUNK_SIZE_MB = 10; // Smaller blocks for better resume granularity

  /**
   * Downloads a file in parallel chunks with block-level resume support.
   */
  public static async download(
    url: string,
    modelKey: string,
    concurrency = 4,
    onProgress?: (pct: number, loaded: number, total: number) => void
  ): Promise<Blob> {
    const storageKey = this.STORAGE_PREFIX + modelKey;

    // 1. Check if complete model already exists
    const cached = await get(storageKey);
    if (cached instanceof Blob) {
      console.log(`[Neural-LFS] ${modelKey} active in local storage.`);
      onProgress?.(100, cached.size, cached.size);
      return cached;
    }

    console.log(`[Neural-LFS] Initiating resilient pipe for ${modelKey}`);

    // 2. Get file size and range support via a small GET request (more reliable than HEAD)
    console.log(`[Neural-LFS] Probing model endpoint: ${url}`);
    let head: Response;
    const probeController = new AbortController();
    const probeId = setTimeout(() => probeController.abort(), 20000); // Increased to 20s for slow HF LFS mirrors

    try {
      head = await fetch(url, { 
        headers: { Range: 'bytes=0-0' },
        signal: probeController.signal
      });
    } catch (e) {
      console.warn(`[Neural-LFS] Probe failed or timed out for ${modelKey}. Fallback to single pipe.`, e);
      return this.downloadSinglePipe(url, storageKey, onProgress);
    } finally {
      clearTimeout(probeId);
    }

    const contentRange = head.headers.get('content-range');
    const totalSizeMatch = contentRange?.match(/\/(\d+)$/);
    const totalSize = totalSizeMatch ? parseInt(totalSizeMatch[1], 10) : 0;
    
    // Check if range is actually supported (status should be 206)
    const rangeSupported = head.status === 206 && totalSize > 0;

    if (!rangeSupported) {
      console.log(`[Neural-LFS] Ranges not supported or size unknown. Using single pipe.`);
      return this.downloadSinglePipe(url, storageKey, onProgress);
    }

    console.log(`[Neural-LFS] Target size: ${Math.round(totalSize / 1024 / 1024)} MB. Block-resume ready.`);

    // 3. Plan chunks
    const blockSize = this.CHUNK_SIZE_MB * 1024 * 1024;
    const totalBlocks = Math.ceil(totalSize / blockSize);
    const blocks: Uint8Array[] = new Array(totalBlocks);
    const completedBlocks = new Set<number>();

    // Check for partially downloaded blocks in IndexedDB
    for (let i = 0; i < totalBlocks; i++) {
      const partKey = `${storageKey}-part-${i}`;
      const part = await get(partKey);
      if (part instanceof Uint8Array) {
        blocks[i] = part;
        completedBlocks.add(i);
      }
    }

    const initialLoaded = Array.from(completedBlocks).length * blockSize;
    console.log(`[Neural-LFS] Resuming from block ${completedBlocks.size}/${totalBlocks} (${Math.round(initialLoaded/1024/1024)} MB already local)`);

    // 4. Download missing blocks
    const queue = Array.from({ length: totalBlocks }, (_, i) => i).filter(i => !completedBlocks.has(i));
    
    const updateOverallProgress = () => {
      let currentLoaded = 0;
      for (const b of blocks) {
        if (b) currentLoaded += b.length;
      }
      const pct = Math.round((currentLoaded / totalSize) * 100);
      onProgress?.(pct, currentLoaded, totalSize);
    };

    const downloadBlock = async (index: number) => {
      const start = index * blockSize;
      const end = Math.min(start + blockSize - 1, totalSize - 1);
      
      let retries = 3;
      while (retries > 0) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s block timeout

        try {
          console.log(`[Neural-LFS] Block ${index} starting (${start}-${end})`);
          const res = await fetch(url, { 
            headers: { Range: `bytes=${start}-${end}` },
            signal: controller.signal
          });
          if (res.status !== 206) throw new Error('Range not supported');
          
          const buffer = await res.arrayBuffer();
          const data = new Uint8Array(buffer);
          
          if (data.length === 0) throw new Error('Empty block received');

          // Persist block immediately
          await set(`${storageKey}-part-${index}`, data);
          blocks[index] = data;
          
          console.log(`[Neural-LFS] Block ${index} acquired.`);
          updateOverallProgress();
          return;
        } catch (e) {
          retries--;
          console.warn(`[Neural-LFS] Block ${index} failed (${(e as Error).name}). Retries left: ${retries}`);
          if (retries === 0) {
            console.error(`[Neural-LFS] Critical failure on block ${index}. Aborting parallel stream.`);
            throw e;
          }
          await new Promise(r => setTimeout(r, 1000 * (4 - retries)));
        } finally {
          clearTimeout(timeoutId);
        }
      }
    };

    // Parallel execution with pool
    const active = new Set();
    for (const index of queue) {
      if (active.size >= concurrency) {
        await Promise.race(active);
      }
      const p = downloadBlock(index).then(() => active.delete(p));
      active.add(p);
    }
    await Promise.all(active);

    // 5. Assemble and Persist
    console.log(`[Neural-LFS] Assembling ${totalBlocks} neural blocks...`);
    const finalBlob = new Blob(blocks, { type: 'application/octet-stream' });
    
    try {
      await set(storageKey, finalBlob);
      // Cleanup parts
      console.log(`[Neural-LFS] Persisted to IndexedDB. Cleaning up ${totalBlocks} part blocks...`);
      for (let i = 0; i < totalBlocks; i++) {
        await del(`${storageKey}-part-${i}`);
      }
    } catch (e) {
      console.warn('[Neural-LFS] Storage saturated or restricted. Brain will run from RAM session.', e);
    }

    return finalBlob;
  }

  /** Helper for single-pipe download with progress tracking */
  private static async downloadSinglePipe(
    url: string,
    storageKey: string,
    onProgress?: (pct: number, loaded: number, total: number) => void
  ): Promise<Blob> {
    console.log(`[Neural-LFS] Single pipe fallback engaged for ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      const errorMsg = `Download failed: ${response.status} ${response.statusText || '(No status text)'}`;
      console.error(`[Neural-LFS] Single-pipe fetch failed:`, errorMsg);
      throw new Error(errorMsg);
    }
    
    const contentLength = response.headers.get('content-length');
    const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
    
    console.log(`[Neural-LFS] Single pipe stream started. Total size: ${Math.round(totalSize / 1024 / 1024)} MB`);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('ReadableStream not supported');

    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (totalSize > 0) {
        onProgress?.(Math.round((loaded / totalSize) * 100), loaded, totalSize);
      } else {
        // Fallback progress if size is unknown
        onProgress?.(1, loaded, 0); 
      }
    }

    console.log(`[Neural-LFS] Single pipe stream complete. Assembling...`);
    const finalBlob = new Blob(chunks, { type: 'application/octet-stream' });
    await set(storageKey, finalBlob);
    return finalBlob;
  }

  /** Clear a specific model from cache */
  public static async clearCache(modelKey: string) {
    await set(this.STORAGE_PREFIX + modelKey, null);
  }
}
