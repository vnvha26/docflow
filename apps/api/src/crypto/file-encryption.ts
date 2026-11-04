import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, TransformCallback } from 'node:stream';

const MAGIC = Buffer.from('DFE1', 'ascii');
const VERSION = 1;
export const HEADER_BYTES = 16;
export const TAG_BYTES = 16;
export const DEFAULT_SEGMENT_BYTES = 64 * 1024;
const MIN_SEGMENT_BYTES = 1024;
const MAX_SEGMENT_BYTES = 1024 * 1024;
const MAX_SEGMENTS = 0xffffffff;

export class DecryptionError extends Error {
  constructor() { super('Tệp đã lưu không giải mã được hoặc đã bị thay đổi.'); this.name = 'DecryptionError'; }
}

function header(segmentBytes: number, prefix: Buffer): Buffer {
  const value = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(value, 0);
  value.writeUInt8(VERSION, 4);
  value.writeUInt32BE(segmentBytes, 5);
  prefix.copy(value, 9);
  return value;
}

function nonce(prefix: Buffer, index: number, last: boolean): Buffer {
  if (index > MAX_SEGMENTS) throw new Error('File has too many segments.');
  const value = Buffer.alloc(12);
  prefix.copy(value, 0);
  value.writeUInt32BE(index, 7);
  value.writeUInt8(last ? 1 : 0, 11);
  return value;
}

function sealSegment(dek: Buffer, prefix: Buffer, aad: Buffer, index: number, last: boolean, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', dek, nonce(prefix, index, last), { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function openSegment(dek: Buffer, prefix: Buffer, aad: Buffer, index: number, last: boolean, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new DecryptionError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, nonce(prefix, index, last), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

export function encryptedSize(plaintextBytes: number, segmentBytes = DEFAULT_SEGMENT_BYTES): number {
  const segments = Math.max(1, Math.ceil(plaintextBytes / segmentBytes));
  return HEADER_BYTES + plaintextBytes + segments * TAG_BYTES;
}

function checkKey(dek: Buffer) {
  if (dek.length !== 32) throw new Error('Data key must be 32 bytes.');
}

export class EncryptStream extends Transform {
  readonly #dek: Buffer;
  readonly #prefix = randomBytes(7);
  readonly #header: Buffer;
  readonly #aad: Buffer;
  readonly #segmentBytes: number;
  #pending = Buffer.alloc(0);
  #index = 0;

  constructor(dek: Buffer, copyId: string, segmentBytes = DEFAULT_SEGMENT_BYTES) {
    super();
    checkKey(dek);
    if (!Number.isInteger(segmentBytes) || segmentBytes < MIN_SEGMENT_BYTES || segmentBytes > MAX_SEGMENT_BYTES) {
      throw new Error('Unsupported segment size.');
    }
    this.#dek = dek;
    this.#segmentBytes = segmentBytes;
    this.#header = header(segmentBytes, this.#prefix);
    this.#aad = Buffer.concat([this.#header, Buffer.from(copyId, 'utf8')]);
    this.push(this.#header);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      while (this.#pending.length > this.#segmentBytes) {
        this.push(sealSegment(this.#dek, this.#prefix, this.#aad, this.#index++, false, this.#pending.subarray(0, this.#segmentBytes)));
        this.#pending = this.#pending.subarray(this.#segmentBytes);
      }
      done();
    } catch (error) { done(error as Error); }
  }

  override _flush(done: TransformCallback): void {
    try {
      this.push(sealSegment(this.#dek, this.#prefix, this.#aad, this.#index++, true, this.#pending));
      this.#pending = Buffer.alloc(0);
      done();
    } catch (error) { done(error as Error); }
  }
}

export class DecryptStream extends Transform {
  readonly #dek: Buffer;
  readonly #copyId: Buffer;
  #pending = Buffer.alloc(0);
  #state: { prefix: Buffer; aad: Buffer; sealedBytes: number } | null = null;
  #index = 0;

  constructor(dek: Buffer, copyId: string) {
    super();
    checkKey(dek);
    this.#dek = dek;
    this.#copyId = Buffer.from(copyId, 'utf8');
  }

  #readHeader(): boolean {
    if (this.#pending.length < HEADER_BYTES) return false;
    const value = this.#pending.subarray(0, HEADER_BYTES);
    const segmentBytes = value.readUInt32BE(5);
    if (!value.subarray(0, 4).equals(MAGIC) || value.readUInt8(4) !== VERSION
      || segmentBytes < MIN_SEGMENT_BYTES || segmentBytes > MAX_SEGMENT_BYTES) throw new DecryptionError();
    this.#state = {
      prefix: Buffer.from(value.subarray(9, 16)),
      aad: Buffer.concat([value, this.#copyId]),
      sealedBytes: segmentBytes + TAG_BYTES,
    };
    this.#pending = this.#pending.subarray(HEADER_BYTES);
    return true;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      if (!this.#state && !this.#readHeader()) return done();
      const state = this.#state!;
      while (this.#pending.length > state.sealedBytes) {
        this.push(openSegment(this.#dek, state.prefix, state.aad, this.#index++, false, this.#pending.subarray(0, state.sealedBytes)));
        this.#pending = this.#pending.subarray(state.sealedBytes);
      }
      done();
    } catch (error) { done(error as Error); }
  }

  override _flush(done: TransformCallback): void {
    try {
      if (!this.#state && !this.#readHeader()) throw new DecryptionError();
      this.push(openSegment(this.#dek, this.#state!.prefix, this.#state!.aad, this.#index++, true, this.#pending));
      this.#pending = Buffer.alloc(0);
      done();
    } catch (error) { done(error as Error); }
  }
}

async function collect(stream: Transform, input: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => { stream.once('end', resolve); stream.once('error', reject); });
  stream.end(input);
  await finished;
  return Buffer.concat(chunks);
}

export function encryptBuffer(dek: Buffer, copyId: string, plaintext: Buffer, segmentBytes = DEFAULT_SEGMENT_BYTES): Promise<Buffer> {
  return collect(new EncryptStream(dek, copyId, segmentBytes), plaintext);
}

export function decryptBuffer(dek: Buffer, copyId: string, ciphertext: Buffer): Promise<Buffer> {
  return collect(new DecryptStream(dek, copyId), ciphertext);
}
