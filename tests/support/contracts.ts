export const id = '00000000-0000-4000-8000-000000000001';
export const hash = 'a'.repeat(64);
export const validTask = { schemaVersion: 1, id, repository: { id, path: 'D:/fixture' }, text: 'Fix scoped behavior', nonGoals: [], allowedPaths: ['src/**'], protectedPaths: ['.git/**'], provider: 'codex', environment: 'windows', model: 'gpt-6.1-sol', effort: 'high', acceptanceIds: [id], verificationPlanRef: id, inclusionManifest: [{ path: 'src/main.ts', sha256: hash, bytes: 1 }], limits: { activeMs: 1800000, verificationMs: 300000, maxRepairs: 2, maxFrameBytes: 1048576, maxActionOutputBytes: 10485760, maxRunOutputBytes: 104857600, maxDiagnosticBytes: 16384, maxLessonBytes: 32768, maxSnapshotBytes: 1073741824 } };

