import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.ts';

// File bytes are kept outside the database. Keys always start with the community id, and every
// download goes through the API, which checks access first; the container itself is private.
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

class LocalStorage implements Storage {
  constructor(private root: string) {}
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + '/')) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { flag: 'wx' });
  }
  async get(key: string) { return readFile(this.path(key)); }
}

class AzureBlobStorage implements Storage {
  private container: Promise<import('@azure/storage-blob').ContainerClient>;
  constructor(account: string, containerName: string) {
    this.container = (async () => {
      const { BlobServiceClient } = await import('@azure/storage-blob');
      const { DefaultAzureCredential } = await import('@azure/identity');
      // The Container App signs in with its managed identity; no storage keys exist in config.
      const svc = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
      return svc.getContainerClient(containerName);
    })();
  }
  async put(key: string, body: Buffer, contentType: string) {
    const c = await this.container;
    await c.getBlockBlobClient(key).uploadData(body, {
      blobHTTPHeaders: { blobContentType: contentType }, conditions: { ifNoneMatch: '*' } });
  }
  async get(key: string) {
    const c = await this.container;
    return c.getBlobClient(key).downloadToBuffer();
  }
}

export function createStorage(): Storage {
  return config.storage.driver === 'azure'
    ? new AzureBlobStorage(config.storage.azureAccount, config.storage.azureContainer)
    : new LocalStorage(join(process.cwd(), config.storage.localDir));
}
