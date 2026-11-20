// SigLIP2 embeddings for media.search, run in a process of its own (one per call) so a crash, a
// hang or the memory the model takes never reaches the server. search.ts starts it with the path of
// a JSON file holding the job and reads `progress <fraction>` lines from stderr; vectors go to a file, unit length,
// float32, one row each, so nothing large crosses a pipe.
//
//   images: the JPEGs at `inputs` (a picture each), through the vision tower.
//   texts:  `texts`, through the text tower (padded to 64 tokens, as the model was trained).

import { readFileSync, writeFileSync } from 'node:fs';

type Job =
  | {
      mode: 'images';
      dir: string;
      model: string;
      inputs: string[];
      output: string;
      threads: number;
    }
  | { mode: 'texts'; dir: string; model: string; texts: string[]; output: string; threads: number };

const BATCH = 16;

function say(fraction: number): void {
  process.stderr.write(`progress ${Math.min(1, Math.max(0, fraction)).toFixed(4)}\n`);
}

function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

async function main(job: Job): Promise<void> {
  const t = await import('@huggingface/transformers');
  t.env.localModelPath = job.dir;
  t.env.allowLocalModels = true;
  t.env.allowRemoteModels = false;
  const backend = t.env.backends.onnx as { numThreads?: number };
  backend.numThreads = job.threads;
  const rows: Float32Array[] = [];
  if (job.mode === 'images') {
    const processor = await t.AutoProcessor.from_pretrained(job.model);
    const model = await t.SiglipVisionModel.from_pretrained(job.model, { dtype: 'fp32' });
    for (let i = 0; i < job.inputs.length; i += BATCH) {
      const images = await Promise.all(
        job.inputs.slice(i, i + BATCH).map((p) => t.RawImage.read(p)),
      );
      const { pooler_output } = await model(await processor(images));
      const data = pooler_output.data as Float32Array;
      const dims = data.length / images.length;
      for (let j = 0; j < images.length; j++) rows.push(unit(data.slice(j * dims, (j + 1) * dims)));
      say(Math.min(job.inputs.length, i + BATCH) / job.inputs.length);
    }
    await model.dispose();
  } else {
    const tokenizer = await t.AutoTokenizer.from_pretrained(job.model);
    // fp16 text tower: its int8 build moves embeddings too far (cosine as low as 0.77).
    const model = await t.SiglipTextModel.from_pretrained(job.model, { dtype: 'fp16' });
    for (const text of job.texts) {
      const { pooler_output } = await model(
        tokenizer([text], { padding: 'max_length', max_length: 64, truncation: true }),
      );
      const out = pooler_output.type === 'float32' ? pooler_output : pooler_output.to('float32');
      rows.push(unit(out.data as Float32Array));
    }
    await model.dispose();
  }
  const dims = rows[0]?.length ?? 0;
  const out = new Float32Array(rows.length * dims);
  for (const [i, r] of rows.entries()) out.set(r, i * dims);
  writeFileSync(job.output, Buffer.from(out.buffer));
}

main(JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as Job).catch((error: Error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
