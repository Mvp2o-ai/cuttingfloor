import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

// A bucket whose objects anyone can read at a stable address (the sound library's files): the
// server writes and deletes them; nothing else of the blob store applies (no records, no expiry).

export interface PublicFiles {
  /** Puts the file at `key` and answers its public url. */
  put(key: string, file: string, type: string): Promise<string>;
  delete(key: string): Promise<void>;
  /** The public url of `key`. */
  url(key: string): string;
}

export interface PublicBucketOptions {
  endpoint: string;
  region: string;
  bucket: string;
  /** Secrets: never logged, never in an error. */
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  /** Where its objects are read: `<files>/<key>`. */
  files: string;
}

export class PublicBucket implements PublicFiles {
  readonly #o: PublicBucketOptions;
  #client: Promise<{ sdk: typeof import('@aws-sdk/client-s3'); client: unknown }> | undefined;

  constructor(options: PublicBucketOptions) {
    this.#o = { ...options, files: options.files.replace(/\/+$/, '') };
  }

  async #s3() {
    this.#client ??= (async () => {
      const sdk = await import('@aws-sdk/client-s3');
      const client = new sdk.S3Client({
        endpoint: this.#o.endpoint,
        region: this.#o.region,
        credentials: {
          accessKeyId: this.#o.accessKeyId,
          secretAccessKey: this.#o.secretAccessKey,
        },
        forcePathStyle: this.#o.pathStyle,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 4,
      });
      return { sdk, client };
    })();
    const { sdk, client } = await this.#client;
    return { sdk, client: client as import('@aws-sdk/client-s3').S3Client };
  }

  url(key: string): string {
    return `${this.#o.files}/${key}`;
  }

  async put(key: string, file: string, type: string): Promise<string> {
    const { sdk, client } = await this.#s3();
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.#o.bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: (await stat(file)).size,
        ContentType: type,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return this.url(key);
  }

  async delete(key: string): Promise<void> {
    const { sdk, client } = await this.#s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.#o.bucket, Key: key }));
  }
}
