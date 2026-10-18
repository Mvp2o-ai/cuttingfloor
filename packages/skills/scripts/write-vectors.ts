import { loadEmbedder, loadLibrary, vectorsFile, writeVectors } from '@cuttingfloor/skills';

// Writes every skill's vector (name + description) to packages/skills/vectors.json, so the
// server embeds only the query. The image build runs it once the model and skills/ are in place;
// it fails without the model, so an image never ships without its vectors.
//   node packages/skills/scripts/write-vectors.ts [file]

const file = process.argv[2] ?? vectorsFile();
const loaded = await loadEmbedder();
if (!loaded.embedder) {
  console.error(loaded.reason);
  process.exit(1);
}
const count = await writeVectors(loadLibrary().skills, loaded.embedder, file);
console.log(`${count} skill vectors written to ${file}`);
