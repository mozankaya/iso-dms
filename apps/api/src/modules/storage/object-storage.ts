import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface ObjectStorageOptions {
  endpoint: string;
  port: number;
  useSsl: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

interface S3ErrorLike {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

function isNotFound(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as S3ErrorLike;
  return name === 'NotFound' || name === 'NoSuchKey' || name === 'NoSuchBucket' || $metadata?.httpStatusCode === 404;
}

/**
 * Thin wrapper over an S3-compatible bucket (RustFS). Has no Nest dependencies so scripts such as
 * the seed can use it too. Application code must go through StorageService (modules/storage).
 */
export class ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketReady: Promise<void> | undefined;

  constructor(options: ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: 'us-east-1',
      endpoint: `${options.useSsl ? 'https' : 'http'}://${options.endpoint}:${options.port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      // S3-compatible servers do not all support the optional checksum trailers newer SDKs add
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Creates the bucket when it does not exist yet. Safe to call repeatedly. */
  ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      }
    })().catch((error) => {
      this.bucketReady = undefined; // retry on the next call
      throw error;
    });
    return this.bucketReady;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureBucket();
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async getStream(key: string): Promise<Readable> {
    await this.ensureBucket();
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return response.Body as Readable;
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: `${this.bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
      }),
    );
  }

  /**
   * Only meant for cleaning up an object whose database record could not be written.
   * Stored document revisions are never deleted (ISO 9001 record control).
   */
  async delete(key: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function objectStorageOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStorageOptions {
  return {
    endpoint: requireEnv(env, 'S3_ENDPOINT'),
    port: Number(env.S3_PORT ?? 9000),
    useSsl: env.S3_USE_SSL === 'true',
    accessKey: requireEnv(env, 'S3_ACCESS_KEY'),
    secretKey: requireEnv(env, 'S3_SECRET_KEY'),
    bucket: requireEnv(env, 'S3_BUCKET'),
  };
}
