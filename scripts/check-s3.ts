// Checks, against whatever bucket the environment names, each thing the S3 blob store relies
// on that a store other than the one it was tested on (MinIO) may do differently. Run by hand
// against a new bucket before it carries anything:
//
//   node --env-file=/path/to/cuttingfloor.env scripts/check-s3.ts
//
// It reads CUTTINGFLOOR_S3_ENDPOINT, _REGION, _BUCKET, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY (and
// _PATH_STYLE), whatever CUTTINGFLOOR_BLOBS says. Every object it writes is under
// tmp/check-{random}/ and is deleted when it ends; it prints no key and no secret. Exit 0 when
// everything the store needs holds, 1 otherwise. Lines marked "note" change nothing the store
// depends on, and say which way it will go.
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { s3SettingsFromEnv } from '../packages/core/src/index.ts';

const settings = s3SettingsFromEnv({ ...process.env, CUTTINGFLOOR_BLOBS: 's3' });
if (!settings) throw new Error('No bucket named');
// The SDK is the blob store's own dependency: taken from where that package has it.
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const sdk = require('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3');
const { getSignedUrl } =
  require('@aws-sdk/s3-request-presigner') as typeof import('@aws-sdk/s3-request-presigner');
const client = new sdk.S3Client({
  endpoint: settings.endpoint,
  region: settings.region,
  credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  forcePathStyle: settings.pathStyle,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const Bucket = settings.bucket;
const prefix = `tmp/check-${randomBytes(6).toString('hex')}/`;
const MIB = 1024 ** 2;
let failed = 0;

const status = (e: unknown) =>
  (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const say = (kind: 'ok' | 'FAIL' | 'note', what: string, detail = '') =>
  process.stdout.write(`${kind.padEnd(4)} ${what}${detail ? `: ${detail}` : ''}\n`);
async function check(what: string, run: () => Promise<string | undefined>): Promise<void> {
  try {
    say('ok', what, (await run()) ?? '');
  } catch (error) {
    failed += 1;
    const e = error as Error;
    say('FAIL', what, `${e.name}: ${e.message}${status(e) ? ` (${status(e)})` : ''}`);
  }
}
const need = (truth: unknown, message: string) => {
  if (!truth) throw new Error(message);
};
const body = async (key: string, range?: string) => {
  const out = await client.send(
    new sdk.GetObjectCommand({ Bucket, Key: key, ...(range ? { Range: range } : {}) }),
  );
  return {
    out,
    bytes: Buffer.from(
      await (out.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray(),
    ),
  };
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

process.stdout.write(`Checking bucket ${Bucket} under ${prefix}\n`);
try {
  await check('the bucket answers with these settings', async () => {
    await client.send(new sdk.HeadBucketCommand({ Bucket }));
    return undefined;
  });

  const small = Buffer.from('cuttingfloor check');
  await check('put, head and get; metadata and content type are kept', async () => {
    await client.send(
      new sdk.PutObjectCommand({
        Bucket,
        Key: `${prefix}a.txt`,
        Body: small,
        ContentType: 'text/plain',
        Metadata: { sha256: sha(small) },
      }),
    );
    const head = await client.send(new sdk.HeadObjectCommand({ Bucket, Key: `${prefix}a.txt` }));
    need(head.ContentLength === small.length, 'size differs');
    need(head.Metadata?.sha256 === sha(small), 'x-amz-meta-sha256 was not returned');
    need(head.ContentType === 'text/plain', `content type came back as ${head.ContentType}`);
    need(head.ETag, 'no ETag');
    need((await body(`${prefix}a.txt`)).bytes.equals(small), 'bytes differ');
    return `ETag ${head.ETag} (${/^"[0-9a-f]{32}"$/.test(head.ETag ?? '') ? 'the MD5' : 'not a plain MD5'})`;
  });

  await check('a ranged get answers 206 with those bytes', async () => {
    const { out, bytes } = await body(`${prefix}a.txt`, 'bytes=5-9');
    need(out.$metadata.httpStatusCode === 206, `answered ${out.$metadata.httpStatusCode}`);
    need(bytes.equals(small.subarray(5, 10)), 'bytes differ');
    return out.ContentRange;
  });

  await check('a get with If-Match on a stale ETag is refused (412)', async () => {
    const refused = await client
      .send(new sdk.GetObjectCommand({ Bucket, Key: `${prefix}a.txt`, IfMatch: '"0"' }))
      .then(
        () => false,
        (e) => status(e) === 412,
      );
    need(refused, 'the read went through: a download in ranges could mix two writings');
    return undefined;
  });

  // Not needed (the store claims the name in its records where this is not honoured), but it
  // says which path a write that must not replace will take.
  try {
    const second = await client
      .send(
        new sdk.PutObjectCommand({ Bucket, Key: `${prefix}a.txt`, Body: 'x', IfNoneMatch: '*' }),
      )
      .then(
        () => 'ignored',
        (e) => (status(e) === 412 ? 'honoured' : `refused outright (${status(e)})`),
      );
    const fresh = await client
      .send(
        new sdk.PutObjectCommand({
          Bucket,
          Key: `${prefix}fresh.txt`,
          Body: 'x',
          IfNoneMatch: '*',
        }),
      )
      .then(
        () => 'taken',
        (e) => `refused (${status(e)})`,
      );
    say(
      'note',
      'put with If-None-Match: *',
      `over an existing object: ${second}; on a free key: ${fresh}. ${second === 'honoured' && fresh === 'taken' ? 'The bucket decides writes that must not replace.' : 'The store will claim such writes in its records instead.'}`,
    );
    if (second === 'ignored') {
      await client.send(new sdk.PutObjectCommand({ Bucket, Key: `${prefix}a.txt`, Body: small }));
    }
  } catch (error) {
    say('note', 'put with If-None-Match: *', `could not be tried: ${(error as Error).name}`);
  }

  await check('copy inside the bucket keeps metadata', async () => {
    await client.send(
      new sdk.PutObjectCommand({
        Bucket,
        Key: `${prefix}a.txt`,
        Body: small,
        ContentType: 'text/plain',
        Metadata: { sha256: sha(small) },
      }),
    );
    await client.send(
      new sdk.CopyObjectCommand({
        Bucket,
        Key: `${prefix}copy.txt`,
        CopySource: `${Bucket}/${prefix}a.txt`,
      }),
    );
    const head = await client.send(new sdk.HeadObjectCommand({ Bucket, Key: `${prefix}copy.txt` }));
    need(head.Metadata?.sha256 === sha(small), 'metadata was not copied');
    return undefined;
  });

  const big = randomBytes(11 * MIB + 3);
  let bigTag: string | undefined;
  await check(
    'an upload in parts: parts side by side, listed, completed; a small last part',
    async () => {
      const Key = `${prefix}big.bin`;
      const { UploadId } = await client.send(
        new sdk.CreateMultipartUploadCommand({ Bucket, Key, Metadata: { sha256: sha(big) } }),
      );
      const cuts = [0, 5 * MIB, 10 * MIB, big.length];
      const parts = await Promise.all(
        [1, 2, 3].map(async (n) => {
          const out = await client.send(
            new sdk.UploadPartCommand({
              Bucket,
              Key,
              UploadId,
              PartNumber: n,
              Body: big.subarray(cuts[n - 1], cuts[n]),
            }),
          );
          return { PartNumber: n, ETag: out.ETag };
        }),
      );
      // One part sent again replaces itself.
      const again = await client.send(
        new sdk.UploadPartCommand({
          Bucket,
          Key,
          UploadId,
          PartNumber: 2,
          Body: big.subarray(cuts[1], cuts[2]),
        }),
      );
      parts[1] = { PartNumber: 2, ETag: again.ETag };
      const listed = await client.send(new sdk.ListPartsCommand({ Bucket, Key, UploadId }));
      need(listed.Parts?.length === 3, `ListParts gave ${listed.Parts?.length} parts`);
      const done = await client.send(
        new sdk.CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
      bigTag = done.ETag;
      const head = await client.send(new sdk.HeadObjectCommand({ Bucket, Key }));
      need(head.ContentLength === big.length, 'size differs');
      need(head.Metadata?.sha256 === sha(big), 'metadata given at the start was not kept');
      need(sha((await body(Key)).bytes) === sha(big), 'bytes differ');
      return `ETag ${done.ETag}`;
    },
  );

  await check('a non-last part under 5 MiB is refused at completion', async () => {
    const Key = `${prefix}small-parts.bin`;
    const { UploadId } = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket, Key }));
    const parts = [];
    for (const n of [1, 2]) {
      const out = await client.send(
        new sdk.UploadPartCommand({
          Bucket,
          Key,
          UploadId,
          PartNumber: n,
          Body: Buffer.alloc(1000),
        }),
      );
      parts.push({ PartNumber: n, ETag: out.ETag });
    }
    const outcome = await client
      .send(
        new sdk.CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      )
      .then(
        () => 'accepted',
        (e) => `refused (${(e as Error).name})`,
      );
    await client
      .send(new sdk.AbortMultipartUploadCommand({ Bucket, Key, UploadId }))
      .catch(() => undefined);
    // Either way the store never asks for it (it gathers small parts itself): only told.
    return outcome;
  });

  await check(
    'aborting an upload that is not there is not an error the store cannot read',
    async () => {
      const outcome = await client
        .send(
          new sdk.AbortMultipartUploadCommand({
            Bucket,
            Key: `${prefix}none.bin`,
            UploadId: 'no-such-upload',
          }),
        )
        .then(
          () => 'accepted',
          (e) => {
            need(
              status(e) === 404 || (e as Error).name === 'NoSuchUpload',
              `answered ${(e as Error).name} (${status(e)})`,
            );
            return 'NoSuchUpload';
          },
        );
      return outcome;
    },
  );

  await check('a copy in parts (ranges of an object copied inside the bucket)', async () => {
    const Key = `${prefix}big-copy.bin`;
    const { UploadId } = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket, Key }));
    const ranges = [
      [0, 6 * MIB - 1],
      [6 * MIB, big.length - 1],
    ];
    const parts = await Promise.all(
      ranges.map(async ([start, end], i) => {
        const out = await client.send(
          new sdk.UploadPartCopyCommand({
            Bucket,
            Key,
            UploadId,
            PartNumber: i + 1,
            CopySource: `${Bucket}/${prefix}big.bin`,
            CopySourceRange: `bytes=${start}-${end}`,
            ...(bigTag ? { CopySourceIfMatch: bigTag } : {}),
          }),
        );
        return { PartNumber: i + 1, ETag: out.CopyPartResult?.ETag };
      }),
    );
    await client.send(
      new sdk.CompleteMultipartUploadCommand({
        Bucket,
        Key,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    need(sha((await body(Key)).bytes) === sha(big), 'bytes differ');
    return undefined;
  });

  await check('listing: by prefix, in pages, every key once', async () => {
    const names = Array.from(
      { length: 7 },
      (_, i) => `${prefix}list/${String(i).padStart(2, '0')}`,
    );
    await Promise.all(
      names.map((Key) => client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: 'x' }))),
    );
    const got: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket,
          Prefix: `${prefix}list/`,
          MaxKeys: 3,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      pages += 1;
      for (const o of page.Contents ?? []) {
        need(
          o.Key && o.Size !== undefined && o.LastModified && o.ETag,
          'an entry lacks key, size, time or ETag',
        );
        got.push(o.Key as string);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    need(pages === 3, `${pages} pages for 7 keys at 3 a page`);
    need([...got].sort().join() === names.join(), 'the keys listed are not the keys written');
    // The store sorts what it lists itself; this only says whether the bucket does.
    return `returned ${got.join() === names.join() ? 'in key order' : 'NOT in key order (the store sorts)'}`;
  });

  // The store aborts an owner's uploads through its own records; this listing is a backstop.
  try {
    const Key = `${prefix}open.bin`;
    const { UploadId } = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket, Key }));
    const open = await client.send(new sdk.ListMultipartUploadsCommand({ Bucket, Prefix: prefix }));
    const seen = (open.Uploads ?? []).some((u) => u.UploadId === UploadId);
    await client.send(new sdk.AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
    say(
      'note',
      'uploads in parts listed by prefix',
      seen
        ? 'yes'
        : 'no (only by exact key): an account deleted relies on its upload records alone',
    );
  } catch (error) {
    say(
      'note',
      'uploads in parts listed by prefix',
      `could not be tried: ${(error as Error).name}`,
    );
  }

  await check(
    'a signed link downloads under the name and type asked for, and takes a range',
    async () => {
      const link = await getSignedUrl(
        client,
        new sdk.GetObjectCommand({
          Bucket,
          Key: `${prefix}a.txt`,
          ResponseContentDisposition: `attachment; filename="clip one.mp4"; filename*=UTF-8''clip%20%C3%A9.mp4`,
          ResponseContentType: 'video/mp4',
        }),
        { expiresIn: 300 },
      );
      const res = await fetch(link);
      need(res.status === 200, `answered ${res.status}`);
      need(
        res.headers.get('content-disposition')?.startsWith('attachment; filename="clip one.mp4"'),
        `content-disposition came back as ${res.headers.get('content-disposition')}`,
      );
      need(
        res.headers.get('content-type') === 'video/mp4',
        `content-type came back as ${res.headers.get('content-type')}`,
      );
      need(Buffer.from(await res.arrayBuffer()).equals(small), 'bytes differ');
      const part = await fetch(link, { headers: { range: 'bytes=0-3' } });
      need(part.status === 206, `a range answered ${part.status}`);
      const inline = await getSignedUrl(
        client,
        new sdk.GetObjectCommand({
          Bucket,
          Key: `${prefix}a.txt`,
          ResponseContentDisposition: 'inline',
        }),
        { expiresIn: 300 },
      );
      need(
        (await fetch(inline)).headers.get('content-disposition') === 'inline',
        'inline was not honoured',
      );
      const unsigned = await fetch(link.split('?')[0] as string);
      need(
        unsigned.status === 403 || unsigned.status === 401,
        `the bucket answers ${unsigned.status} without a signature: it is not private`,
      );
      // What a page on another site (a view measuring an export's sound) needs of the bucket.
      const cors = await fetch(link, { headers: { origin: 'https://example.com' } });
      const allow = cors.headers.get('access-control-allow-origin');
      say(
        'note',
        'CORS on a signed GET from another origin',
        allow
          ? `allowed (${allow})`
          : 'NOT allowed: views that fetch a file (the editor’s sound lane) will fail; add GET and HEAD for * to the bucket’s CORS rule',
      );
      const head = await fetch(link, { method: 'HEAD' });
      return `HEAD on a GET link answers ${head.status} (the server answers HEAD itself)`;
    },
  );

  // Whether the bucket checks bytes against a hash sent with them, so a write it accepts is
  // known to hold what was sent. Notes only: the store works either way, and uses whichever the
  // bucket enforces (MinIO enforces both).
  const integrity = async (
    what: string,
    header: (bytes: Buffer, right: boolean) => Record<string, string>,
  ) => {
    const bytes = Buffer.from(`integrity ${what} ${randomBytes(8).toString('hex')}`);
    const put = (right: boolean) =>
      client
        .send(
          new sdk.PutObjectCommand({
            Bucket,
            Key: `${prefix}integrity-${what}-${right}.txt`,
            Body: bytes,
            ...header(bytes, right),
          } as never),
        )
        .then(
          () => 'taken',
          (e) => `refused (${status(e) ?? (e as Error).name})`,
        );
    const wrong = await put(false);
    const right = await put(true);
    say(
      'note',
      `a put with ${what}`,
      `a wrong one is ${wrong}, a right one is ${right}${wrong.startsWith('refused') && right === 'taken' ? ': ENFORCED' : ': not enforced'}`,
    );
  };
  await integrity('ChecksumSHA256', (bytes, right) => ({
    ChecksumSHA256: createHash('sha256')
      .update(right ? bytes : Buffer.from('other'))
      .digest('base64'),
  }));
  await integrity('Content-MD5', (bytes, right) => ({
    ContentMD5: createHash('md5')
      .update(right ? bytes : Buffer.from('other'))
      .digest('base64'),
  }));

  await check('delete: an object, and one that is not there', async () => {
    await client.send(new sdk.DeleteObjectCommand({ Bucket, Key: `${prefix}copy.txt` }));
    await client.send(new sdk.DeleteObjectCommand({ Bucket, Key: `${prefix}never-was.txt` }));
    const gone = await client
      .send(new sdk.HeadObjectCommand({ Bucket, Key: `${prefix}copy.txt` }))
      .then(
        () => false,
        (e) => status(e) === 404,
      );
    need(gone, 'a deleted object still answers');
    return undefined;
  });

  try {
    const rules = await client.send(new sdk.GetBucketLifecycleConfigurationCommand({ Bucket }));
    const abort = (rules.Rules ?? [])
      .map((r) => r.AbortIncompleteMultipartUpload?.DaysAfterInitiation)
      .filter(Boolean);
    say(
      'note',
      'lifecycle',
      `${rules.Rules?.length ?? 0} rules; uploads in parts aborted after ${abort.join(', ') || 'never'} days (an upload link works 7 days: under 8, an upload paused that long is lost and starts again)`,
    );
  } catch (error) {
    say('note', 'lifecycle', `could not be read: ${(error as Error).name}`);
  }
} finally {
  // Everything written, whatever happened above.
  let token: string | undefined;
  do {
    const page = await client
      .send(
        new sdk.ListObjectsV2Command({
          Bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      )
      .catch(() => undefined);
    for (const o of page?.Contents ?? []) {
      await client.send(new sdk.DeleteObjectCommand({ Bucket, Key: o.Key })).catch(() => undefined);
    }
    token = page?.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const open = await client
    .send(new sdk.ListMultipartUploadsCommand({ Bucket, Prefix: prefix }))
    .catch(() => undefined);
  for (const u of open?.Uploads ?? []) {
    await client
      .send(new sdk.AbortMultipartUploadCommand({ Bucket, Key: u.Key, UploadId: u.UploadId }))
      .catch(() => undefined);
  }
  const left = await client
    .send(new sdk.ListObjectsV2Command({ Bucket, Prefix: prefix }))
    .catch(() => undefined);
  process.stdout.write(
    `Removed what was written under ${prefix}${left?.Contents?.length ? ` (${left.Contents.length} objects could NOT be removed)` : ''}\n`,
  );
  client.destroy();
}
process.stdout.write(failed ? `${failed} checks FAILED\n` : 'Everything the store needs holds\n');
process.exit(failed ? 1 : 0);
