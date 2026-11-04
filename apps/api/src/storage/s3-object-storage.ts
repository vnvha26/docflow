import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client, S3ServiceException,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { API_CONFIG, ApiConfig } from '../config';
import { ObjectNotFoundError, ObjectStorage } from './object-storage';

function status(error: unknown): number | undefined {
  return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

@Injectable()
export class S3ObjectStorage extends ObjectStorage implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly createBucket: boolean;
  private bucketReady: Promise<void> | null = null;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    super();
    const storage = config.storage;
    this.bucket = storage.bucket;
    this.createBucket = storage.createBucket;
    this.client = new S3Client({
      region: storage.region,
      endpoint: storage.endpoint,
      forcePathStyle: storage.forcePathStyle,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private ensureBucket(): Promise<void> {
    if (!this.createBucket) return Promise.resolve();
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        if (status(error) !== 404) throw error;
        try { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })); }
        catch (createError) { if (status(createError) !== 409) throw createError; }
      }
    })().catch((error: unknown) => { this.bucketReady = null; throw error; });
    return this.bucketReady;
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentLength: body.length, ContentType: 'application/octet-stream',
    }));
  }

  async get(key: string): Promise<Readable> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!(result.Body instanceof Readable)) throw new Error('Unexpected S3 body type.');
      return result.Body;
    } catch (error) {
      if (status(error) === 404) throw new ObjectNotFoundError();
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
