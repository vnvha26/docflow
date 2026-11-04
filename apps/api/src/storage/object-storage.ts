import { Readable } from 'node:stream';

export abstract class ObjectStorage {
  abstract put(key: string, body: Buffer): Promise<void>;
  abstract get(key: string): Promise<Readable>;
  abstract delete(key: string): Promise<void>;
}

export class ObjectNotFoundError extends Error {
  constructor() { super('Stored object not found.'); this.name = 'ObjectNotFoundError'; }
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

export function storageKey(kind: 'web-source' | 'encrypted', userId: string, copyId: string): string {
  for (const part of [userId, copyId]) if (!SAFE_SEGMENT.test(part)) throw new Error('Unsafe storage key segment.');
  return `${kind}/${userId}/${copyId}`;
}
