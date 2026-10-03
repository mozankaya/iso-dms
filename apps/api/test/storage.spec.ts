import { randomUUID } from 'node:crypto';
import { ObjectStorage, objectStorageOptionsFromEnv } from '../src/modules/storage/object-storage';
import { buildRevisionKey, FILE_TYPE_INFO } from '../src/modules/storage/storage-keys';

const storage = new ObjectStorage(objectStorageOptionsFromEnv());
const prefix = `storage-test/${randomUUID()}`;
const createdKeys: string[] = [];

async function put(name: string, content: string): Promise<string> {
  const key = `${prefix}/${name}`;
  await storage.put(key, Buffer.from(content), 'text/plain');
  createdKeys.push(key);
  return key;
}

afterAll(async () => {
  // Test cleanup only
  await Promise.all(createdKeys.map((key) => storage.delete(key)));
});

describe('ObjectStorage', () => {
  it('stores and reads back an object', async () => {
    const key = await put('hello.txt', 'merhaba dünya');
    expect((await storage.getBuffer(key)).toString('utf8')).toBe('merhaba dünya');
  });

  it('stores binary content unchanged', async () => {
    const key = `${prefix}/binary.bin`;
    const content = Buffer.from([0, 1, 2, 255, 254, 80, 75, 3, 4]);
    await storage.put(key, content, 'application/octet-stream');
    createdKeys.push(key);

    expect((await storage.getBuffer(key)).equals(content)).toBe(true);
  });

  it('reports whether an object exists', async () => {
    const key = await put('exists.txt', 'x');
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.exists(`${prefix}/missing.txt`)).toBe(false);
  });

  it('copies an object', async () => {
    const source = await put('source.txt', 'copy me');
    const destination = `${prefix}/copy of source.txt`;
    await storage.copy(source, destination);
    createdKeys.push(destination);

    expect((await storage.getBuffer(destination)).toString()).toBe('copy me');
  });

  it('deletes an object', async () => {
    const key = await put('to-delete.txt', 'x');
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it('fails when reading an object that does not exist', async () => {
    await expect(storage.getBuffer(`${prefix}/missing.txt`)).rejects.toThrow();
  });
});

describe('buildRevisionKey', () => {
  it('follows {organizationId}/{documentId}/{revisionNo}/{uuid}.{ext}', () => {
    const key = buildRevisionKey({ organizationId: 'org', documentId: 'doc', revisionNo: 0, fileType: 'XLSX' });
    expect(key).toMatch(/^org\/doc\/0\/[0-9a-f-]{36}\.xlsx$/);
  });

  it('never repeats a key', () => {
    const params = { organizationId: 'org', documentId: 'doc', revisionNo: 1, fileType: 'DOCX' as const };
    expect(buildRevisionKey(params)).not.toBe(buildRevisionKey(params));
  });

  it('uses the right extension and MIME type per file type', () => {
    expect(FILE_TYPE_INFO.DOCX.extension).toBe('docx');
    expect(FILE_TYPE_INFO.XLSX.mimeType).toContain('spreadsheetml');
  });
});
