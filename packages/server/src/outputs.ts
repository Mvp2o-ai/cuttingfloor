import { type BlobKey, OUTPUTS, type OutputRecord, type Workspace } from '@cuttingfloor/core';

/**
 * What jobs and previews leave for download: a job's one output file (`j_…`), or frames kept
 * for their links (`f_…`). Each has a record naming its file, and the file is a blob that the
 * signed `/outputs/…` link serves.
 */
export class Outputs {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    this.#ws = ws;
  }

  key(owner: string, id: string, name: string): BlobKey {
    return this.#ws.blobs.keys.output(owner, id, name);
  }

  /** The output's file on this node, to read. */
  local(owner: string, id: string, name: string): Promise<string> {
    return this.#ws.scratch.materialize(this.key(owner, id, name));
  }

  /** A local path for an engine to write the output's file at; `publish` then stores it. */
  reserve(owner: string, id: string, name: string): Promise<string> {
    return this.#ws.scratch.reserve(this.key(owner, id, name));
  }

  /** Stores a file written at a reserved path and records it as the output's file. */
  async publish(
    owner: string,
    id: string,
    name: string,
    localPath: string,
    kind: OutputRecord['kind'],
  ): Promise<void> {
    await this.#ws.scratch.publish(localPath, this.key(owner, id, name));
    await this.#record(owner, id, name, kind);
  }

  /** Stores bytes as the output's file and records it. */
  async write(
    owner: string,
    id: string,
    name: string,
    bytes: Uint8Array | string,
    kind: OutputRecord['kind'],
  ): Promise<void> {
    await this.#ws.blobs.put(this.key(owner, id, name), {
      bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes,
    });
    await this.#record(owner, id, name, kind);
  }

  async #record(
    owner: string,
    id: string,
    name: string,
    kind: OutputRecord['kind'],
  ): Promise<void> {
    await this.#ws.records
      .collection(OUTPUTS, { owner })
      .put(id, { id, kind, file: name, created_at: new Date().toISOString() });
  }

  /**
   * The name of the output's file while it is held: the one its record names, or, for an output
   * made before outputs had records, the first file it holds whose name passes `named`.
   */
  async file(
    owner: string,
    id: string,
    named: (name: string) => boolean = () => true,
  ): Promise<string | undefined> {
    const { records, blobs } = this.#ws;
    const record = await records.collection(OUTPUTS, { owner }).get(id);
    if (record && (await blobs.head(this.key(owner, id, record.file)))) return record.file;
    const prefix = `${this.key(owner, id, '')}`;
    for (const { key } of await blobs.list(prefix)) {
      const name = key.slice(prefix.length);
      if (!name.includes('/') && named(name)) return name;
    }
    return undefined;
  }

  /** Forgets the records of outputs that have gone (`ids` as the sweep removed them). */
  async forget(owner: string, ids: string[]): Promise<void> {
    for (const id of ids) await this.#ws.records.collection(OUTPUTS, { owner }).delete(id);
  }
}
