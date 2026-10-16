import { randomUUID, createHash } from 'node:crypto';
import { open, link, unlink, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactMetadataSchema, type ArtifactMetadata, type ArtifactRef, type ArtifactCleanupObservation, type ArtifactCleanupOperation } from '../contracts/evidence.ts';
import { type Result } from '../contracts/common.ts';
import { storeError, type RunStore } from './database.ts';
export type { ArtifactMetadata, ArtifactRef } from '../contracts/evidence.ts';
export type ArtifactPublishResult = Result<ArtifactRef> & { cleanup?: ArtifactCleanupObservation };

// Keep an unfinished match across chunks; at truncation redact a partial match
// too, so a limit cannot expose the leading bytes of a known secret.
class SecretRedactor {
  #pending = Buffer.alloc(0);
  #secrets: Buffer[];
  applied = false;
  constructor(secrets: string[]) { this.#secrets = secrets.map(s => Buffer.from(s)).sort((a, b) => b.length - a.length); }
  push(chunk: Uint8Array, final = false): Buffer {
    const bytes = Buffer.concat([this.#pending, chunk]);
    const output: Buffer[] = [];
    let position = 0; let start = 0;
    while (position < bytes.length) {
      let matched = 0; let incomplete = false;
      for (const secret of this.#secrets) {
        const length = Math.min(secret.length, bytes.length - position);
        if (bytes.subarray(position, position + length).equals(secret.subarray(0, length))) {
          if (length === secret.length) { matched = length; break; }
          incomplete = true;
        }
      }
      if (incomplete && !matched && !final) break;
      if (matched || incomplete) {
        output.push(bytes.subarray(start, position), Buffer.from('[REDACTED]'));
        this.applied = true; position += matched || bytes.length - position; start = position;
      } else position++;
    }
    output.push(bytes.subarray(start, position));
    this.#pending = Buffer.from(bytes.subarray(position));
    return Buffer.concat(output);
  }
}

function excerptText(bytes: Buffer, limit: number): string {
  // Invalid UTF-8 remains diagnostic text only; keep its encoded size bounded.
  let text = bytes.toString('utf8');
  while (Buffer.byteLength(text) > limit) text = [...text].slice(0, -1).join('');
  return text;
}

export async function publishArtifact(store: RunStore, input: AsyncIterable<Uint8Array>, metadata: ArtifactMetadata): Promise<ArtifactPublishResult> {
  // Do not return schema messages containing secret inputs, nor serialize them.
  const parsed = ArtifactMetadataSchema.safeParse(metadata);
  if (!parsed.success) return storeError('INVALID_CONTRACT', 'Artifact metadata is invalid');
  const m = parsed.data;
  const preflight = store.reserveOutput(m.owner, m.actionId, 0);
  if (!preflight.ok) return preflight;
  const temporaryId = randomUUID();
  const temporary = join(store.root, 'temporary', temporaryId + '.partial');
  let file: FileHandle;
  try { file = await open(temporary, 'wx', 0o600); }
  catch { return storeError('ARTIFACT_IO_ERROR', 'Artifact temporary file could not be opened'); }
  const hash = createHash('sha256');
  const redactor = new SecretRedactor(m.secrets);
  const diagnosticBytes = preflight.value.diagnosticBytes;
  const headLimit = Math.ceil(diagnosticBytes / 2); const tailLimit = Math.floor(diagnosticBytes / 2);
  let rawBytes = 0; let storedBytes = 0; let head = Buffer.alloc(0); let tail = Buffer.alloc(0);
  let limit: ArtifactRef['limit'] = null;
  async function write(bytes: Buffer): Promise<void> {
    if (!bytes.length) return;
    await file.writeFile(bytes); hash.update(bytes);
    if (head.length < headLimit) head = Buffer.concat([head, bytes.subarray(0, headLimit - head.length)]);
    tail = Buffer.concat([tail, bytes]).subarray(-tailLimit || undefined);
    if (!tailLimit) tail = Buffer.alloc(0);
    storedBytes += bytes.length;
  }
  let closed = false;
  const result = await (async (): Promise<Result<ArtifactRef>> => {
  try {
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array)) return storeError('INVALID_OUTPUT', 'Artifact input must contain byte chunks');
      const reserved = store.reserveOutput(m.owner, m.actionId, chunk.byteLength);
      if (!reserved.ok) return reserved;
      rawBytes += chunk.byteLength;
      limit = reserved.value.limit;
      await write(redactor.push(chunk.subarray(0, reserved.value.acceptedBytes)));
      // for-await invokes return() on exhaustion, requesting producer stop. An
      // external process's drainage still requires independent supervisor proof.
      if (limit) break;
    }
    await write(redactor.push(Buffer.alloc(0), true));
    await file.sync(); await file.close(); closed = true;
    const sha256 = hash.digest('hex');
    if (m.expectedSha256 && m.expectedSha256 !== sha256) return storeError('HASH_MISMATCH', 'Artifact does not match expected redacted-content hash');
    const destination = join(store.root, 'artifacts', sha256);
    // A same-volume hard-link publishes the flushed file atomically without
    // overwriting a pre-existing hash, unlike rename on some platforms.
    try { await link(temporary, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(destination);
      if (existing.length !== storedBytes || createHash('sha256').update(existing).digest('hex') !== sha256) return storeError('ARTIFACT_COLLISION', 'Existing hash path has different bytes');
    }
    // POSIX namespace durability; Windows lacks directory fsync through Node.
    if (process.platform !== 'win32') { const directory = await open(join(store.root, 'artifacts'), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    const excerptTruncated = storedBytes > diagnosticBytes;
    const tailStart = Math.max(head.length, storedBytes - tail.length);
    const nonoverlapTail = tail.subarray(Math.max(0, head.length - (storedBytes - tail.length)));
    const artifact: ArtifactRef = { schemaVersion: 1, id: m.id, runId: m.owner.runId, actionId: m.actionId, sha256, mediaType: m.mediaType, rawBytes, storedBytes, truncated: limit !== null, limit, producerStopRequired: limit !== null, redactionApplied: redactor.applied, excerpt: { head: excerptText(head, headLimit), tail: excerptText(nonoverlapTail, tailLimit), headOffset: 0, tailOffset: tailStart, truncated: excerptTruncated } };
    return store.registerArtifact(m.owner, artifact);
  } catch {
    // Producer errors may carry secrets. Preserve a fixed safe boundary message.
    return storeError('ARTIFACT_IO_ERROR', 'Artifact capture or publication failed');
  }
  })();
  // Cleanup must never replace a committed reference's success, or throw raw
  // filesystem errors over a capture failure. Retain fixed pending operations.
  const operations: ArtifactCleanupOperation[] = [];
  if (!closed) { try { await file.close(); } catch { operations.push('CLOSE'); } }
  // Remove only this publication link; never scan or clean up crash leftovers.
  try { await unlink(temporary); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') operations.push('UNLINK'); }
  if (!operations.length) return result;
  const cleanup: ArtifactCleanupObservation = { schemaVersion: 1, temporaryId, operations, durable: false, evidenceId: null };
  try {
    const receipt = store.recordArtifactCleanup(m.owner, temporaryId, result.ok ? result.value.id : null, operations);
    if (receipt.ok) { cleanup.durable = true; cleanup.evidenceId = receipt.value.id; }
  } catch {
    // Even a failed receipt write cannot undo committed publication. The caller
    // receives an explicitly non-durable obligation, with no fabricated receipt.
  }
  if (!result.ok && cleanup.evidenceId) return { ok: false, error: { ...result.error, evidenceIds: [...result.error.evidenceIds, cleanup.evidenceId] }, cleanup };
  return { ...result, cleanup };
}
