import { openStore } from '../../src/store/database.ts';
import { claimRun } from '../../src/store/ownership.ts';
import { recordIntent, markDispatched } from '../../src/store/actions.ts';
import { publishArtifact } from '../../src/store/artifacts.ts';
import { randomUUID } from 'node:crypto';
const [mode, root, repoId, runId, actionId] = process.argv.slice(2) as string[];
const store = openStore(root!);
const claimed = claimRun(store, repoId!, runId!);
if (!claimed.ok) throw Error(claimed.error.message);
const owner = claimed.value;
if (mode === 'claim') process.exit(0);
if (mode === 'after_intent_before_dispatch' || mode === 'after_dispatch_before_ack') {
  const intent = recordIntent(store, owner, { schemaVersion: 1, id: actionId!, runId: runId!, kind: 'VERIFY', payload: {} });
  if (!intent.ok) throw Error(intent.error.message);
  if (mode === 'after_dispatch_before_ack') { const dispatched = markDispatched(store, owner, actionId!); if (!dispatched.ok) throw Error(dispatched.error.message); }
  process.exit(91);
}
if (mode === 'after_publish_before_reference') store.registerArtifact = () => process.exit(91);
async function* input() { yield Buffer.from('durable fixture bytes'); if (mode === 'before_publish') process.exit(91); }
const artifact = await publishArtifact(store, input(), { schemaVersion: 1, id: randomUUID(), owner, actionId: null, mediaType: 'text/plain', secrets: [] });
if (!artifact.ok) throw Error(artifact.error.message);
process.exit(0);
