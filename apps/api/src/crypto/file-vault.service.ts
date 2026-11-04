import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { API_CONFIG, ApiConfig, Kek } from '../config';
import { DecryptStream, encryptBuffer } from './file-encryption';
import { KeyContext, newDataKey, unwrapDataKey, wrapDataKey, wrappingKeyId } from './key-wrap';

@Injectable()
export class FileVault {
  private readonly keks: readonly Kek[];

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.keks = config.files.keks;
  }

  newKey(context: KeyContext): { dek: Buffer; keyRef: string } {
    const dek = newDataKey();
    return { dek, keyRef: wrapDataKey(this.keks, dek, context) };
  }

  async seal(dek: Buffer, context: KeyContext, plaintext: Buffer): Promise<{ data: Buffer; sha256: string }> {
    try {
      const data = await encryptBuffer(dek, context.copyId, plaintext);
      return { data, sha256: createHash('sha256').update(data).digest('hex') };
    } finally {
      dek.fill(0);
    }
  }

  get activeKekId(): string {
    return this.keks[0].id;
  }

  rewrap(keyRef: string, context: KeyContext): string | null {
    if (wrappingKeyId(keyRef) === this.activeKekId) return null;
    const dek = unwrapDataKey(this.keks, keyRef, context);
    try { return wrapDataKey(this.keks, dek, context); } finally { dek.fill(0); }
  }

  openStream(keyRef: string, context: KeyContext): DecryptStream {
    return new DecryptStream(unwrapDataKey(this.keks, keyRef, context), context.copyId);
  }
}
