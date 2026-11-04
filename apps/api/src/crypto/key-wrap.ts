import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Kek } from '../config';

const FORMAT = 'w1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const DEK_BYTES = 32;

export interface KeyContext { copyId: string; userId: string }

export class KeyUnwrapError extends Error {
  constructor() { super('Không thể mở khóa dữ liệu của tệp.'); this.name = 'KeyUnwrapError'; }
}

function aad(kekId: string, context: KeyContext): Buffer {
  return Buffer.from(`docflow/dek/${FORMAT}/${kekId}/${context.userId}/${context.copyId}`, 'utf8');
}

export function newDataKey(): Buffer {
  return randomBytes(DEK_BYTES);
}

export function wrapDataKey(keks: readonly Kek[], dek: Buffer, context: KeyContext): string {
  if (dek.length !== DEK_BYTES) throw new Error('Data key must be 32 bytes.');
  const kek = keks[0];
  if (!kek) throw new Error('No active key-encryption key.');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(kek.id, context));
  const sealed = Buffer.concat([nonce, cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  return `${FORMAT}.${kek.id}.${sealed.toString('base64url')}`;
}

export function unwrapDataKey(keks: readonly Kek[], reference: string, context: KeyContext): Buffer {
  const [format, kekId, payload, extra] = reference.split('.');
  const kek = keks.find((candidate) => candidate.id === kekId);
  if (format !== FORMAT || !kek || payload === undefined || extra !== undefined) throw new KeyUnwrapError();
  const sealed = Buffer.from(payload, 'base64url');
  if (sealed.length !== NONCE_BYTES + DEK_BYTES + TAG_BYTES) throw new KeyUnwrapError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek.key, sealed.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(kek.id, context));
    decipher.setAuthTag(sealed.subarray(NONCE_BYTES + DEK_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, NONCE_BYTES + DEK_BYTES)), decipher.final()]);
  } catch {
    throw new KeyUnwrapError();
  }
}

export function wrappingKeyId(reference: string): string | null {
  const [format, kekId] = reference.split('.');
  return format === FORMAT && kekId ? kekId : null;
}
