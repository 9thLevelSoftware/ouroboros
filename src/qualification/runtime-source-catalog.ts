import {createHash} from 'node:crypto';
import {z} from 'zod';
import {HashSchema} from '../contracts/common.ts';
import {QualificationTargetSchema,type QualificationTarget} from './ledger.ts';
import {fingerprint} from './probes.ts';
import {STARTUP_SOURCES} from './codex-startup-authority.ts';
import {StartupCoverageManifestSchema,STARTUP_MONITOR_PATHS,buildStartupCoverageManifest,validateStartupLocalScope,type StartupSessionProof,type StartupLocalScope,type StartupArtifactRef} from './startup-evidence.ts';

const commit=z.string().regex(/^[a-f0-9]{40}$/);
const ref=StartupCoverageManifestSchema.shape.managedConflict.unwrap();
const source=StartupCoverageManifestSchema.shape.routes.element.shape.sourceEvidence.element;
const official=z.string().url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&['github.com','api.github.com','raw.githubusercontent.com','release-assets.githubusercontent.com'].includes(u.hostname);},'Official OpenAI GitHub release source required');
export const RuntimeArchiveObservationSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('official-release-executable-comparison'),
 releaseTag:z.string(),assetName:z.string().min(1).max(256),assetUrl:official,archiveSha256:HashSchema,archiveBytes:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 entry:z.string().min(1).max(1024),executableBytes:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),executableSha256:HashSchema,installedExecutableSha256:HashSchema,installedMatches:z.literal(true),
});
/** Immutable evidence input, never an implicit download or release-label allowlist. */
export const RuntimeSourceCatalogSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('runtime-startup-source-catalog'),
 runtime:QualificationTargetSchema.shape.runtime,observedVersion:z.string().min(1).max(256),upstreamCommit:commit,
 provenance:z.strictObject({repository:z.literal('https://github.com/openai/codex'),releaseTag:z.string().regex(/^rust-v[0-9]+\.[0-9]+\.[0-9]+$/),
  releaseUrl:official,tagUrl:official,releaseEvidence:ref,tagEvidence:ref,archiveEvidence:ref,archiveExecutableHash:HashSchema,versionEvidence:ref}),
 sources:z.array(source).min(1).max(256),
 routes:StartupCoverageManifestSchema.shape.routes,
 requirementsSources:StartupCoverageManifestSchema.shape.requirementsSources.unwrap(),
 interpretations:z.array(z.strictObject({path:z.enum(STARTUP_MONITOR_PATHS),semantics:z.string().min(16).max(8192),sources:z.array(source).min(1).max(32)})).length(13),
});
export type RuntimeSourceCatalog=z.infer<typeof RuntimeSourceCatalogSchema>;
export const RuntimeSourceCatalogAcceptanceSchema=z.strictObject({schemaVersion:z.literal(1),kind:z.literal('accepted-runtime-source-catalog'),catalogHash:HashSchema,reviewDigest:HashSchema,accepted:z.literal(true)});
export type RuntimeSourceCatalogAcceptance=z.infer<typeof RuntimeSourceCatalogAcceptanceSchema>;

/** Caller supplies a trusted acceptance resolver. A candidate's own accepted
 * flag cannot confer authority. Every referenced byte is rechecked at use. */
export function validateRuntimeSourceCatalog(input:{catalog:RuntimeSourceCatalog;target:QualificationTarget;acceptance:RuntimeSourceCatalogAcceptance;
 readArtifact(ref:StartupArtifactRef):Uint8Array;authorizeReview(receipt:Readonly<RuntimeSourceCatalogAcceptance>):boolean}):RuntimeSourceCatalog{
 const c=RuntimeSourceCatalogSchema.parse(structuredClone(input.catalog)),t=QualificationTargetSchema.parse(input.target),a=RuntimeSourceCatalogAcceptanceSchema.parse(input.acceptance);
 if(fingerprint(c.runtime)!==fingerprint(t.runtime)||c.observedVersion!==t.runtime.version||c.provenance.archiveExecutableHash!==t.runtime.sha256||a.catalogHash!==fingerprint(c)||input.authorizeReview(Object.freeze({...a}))!==true)throw Error('RUNTIME_SOURCE_CATALOG_NOT_ACCEPTED');
 const bytes=(r:StartupArtifactRef)=>{const value=input.readArtifact(r);if(createHash('sha256').update(value).digest('hex')!==r.sha256)throw Error('RUNTIME_SOURCE_BYTES_CHANGED');return value;};
 for(const r of [c.provenance.releaseEvidence,c.provenance.tagEvidence,c.provenance.archiveEvidence,c.provenance.versionEvidence])bytes(r);
 const release=JSON.parse(Buffer.from(bytes(c.provenance.releaseEvidence)).toString('utf8')) as {tag_name?:unknown;html_url?:unknown;assets?:Array<{name?:unknown;digest?:unknown;size?:unknown;browser_download_url?:unknown}>};
 const tag=JSON.parse(Buffer.from(bytes(c.provenance.tagEvidence)).toString('utf8')) as {object?:{type?:unknown;sha?:unknown}};
 if(c.provenance.releaseTag!==`rust-v${c.observedVersion}`||c.provenance.releaseUrl!==`https://github.com/openai/codex/releases/tag/${c.provenance.releaseTag}`||!c.provenance.tagUrl.startsWith('https://api.github.com/repos/openai/codex/git/tags/')||release.tag_name!==c.provenance.releaseTag||release.html_url!==c.provenance.releaseUrl||tag.object?.type!=='commit'||tag.object.sha!==c.upstreamCommit)throw Error('RUNTIME_RELEASE_PROVENANCE_UNPROVEN');
 const archive=RuntimeArchiveObservationSchema.parse(JSON.parse(Buffer.from(bytes(c.provenance.archiveEvidence)).toString('utf8'))),assets=release.assets?.filter(asset=>asset.name===archive.assetName);
 if(archive.releaseTag!==c.provenance.releaseTag||archive.assetUrl!==`https://github.com/openai/codex/releases/download/${c.provenance.releaseTag}/${archive.assetName}`||assets?.length!==1||assets[0]!.digest!==`sha256:${archive.archiveSha256}`||assets[0]!.size!==archive.archiveBytes||assets[0]!.browser_download_url!==archive.assetUrl||archive.executableSha256!==c.runtime.sha256||archive.installedExecutableSha256!==c.runtime.sha256||archive.executableSha256!==c.provenance.archiveExecutableHash||archive.entry.split(/[\\/]/).some(part=>part==='..'||part==='.')||!archive.entry.endsWith('.exe'))throw Error('RUNTIME_ARCHIVE_COMPARISON_UNPROVEN');
 const version=Buffer.from(bytes(c.provenance.versionEvidence)).toString('utf8').trim();
 if(version!==c.observedVersion&&version!==`codex-cli ${c.observedVersion}`)throw Error('RUNTIME_VERSION_OBSERVATION_UNPROVEN');
 const pins=new Map(c.sources.map(s=>[`${s.path}:${s.consumer}`,s]));
 if(pins.size!==c.sources.length)throw Error('SOURCE_CATALOG_DUPLICATE');
 const verify=(s:z.infer<typeof source>)=>{if(s.path.split('/').some(part=>part==='..'||part==='.')||s.commit!==c.upstreamCommit||s.blobHash!==s.artifact.sha256||fingerprint(pins.get(`${s.path}:${s.consumer}`))!==fingerprint(s))throw Error('SOURCE_CATALOG_BINDING_CHANGED');bytes(s.artifact);};
 for(const s of c.sources)verify(s);
 const keys=c.routes.map(r=>`${r.path}:${r.source}:${r.lifecycle}`);
 if(new Set(keys).size!==keys.length||STARTUP_MONITOR_PATHS.some(p=>STARTUP_SOURCES.some(s=>(['bootstrap','thread-start'] as const).some(l=>!keys.includes(`${p}:${s}:${l}`))))||new Set(c.interpretations.map(i=>i.path)).size!==13||c.requirementsSources.length!==8||new Set(c.requirementsSources.map(s=>s.source)).size!==8)throw Error('SOURCE_ROUTES_INCOMPLETE');
 for(const route of [...c.routes,...c.requirementsSources])for(const s of route.sourceEvidence)verify(s);
 for(const i of c.interpretations){if(/UNREVIEWED/.test(i.semantics))throw Error('SOURCE_INTERPRETATION_UNREVIEWED');for(const s of i.sources)verify(s);}
 return c;
}

export function buildRuntimeStartupSourceMap(input:Parameters<typeof validateRuntimeSourceCatalog>[0]&{proof:StartupSessionProof;fixtureHash:string;scope:StartupLocalScope;scopeEvidence:StartupArtifactRef;managedConflict?:StartupArtifactRef;boundaryEvidence?:StartupArtifactRef[]}){
 const catalog=validateRuntimeSourceCatalog(input);
 const manifest=buildStartupCoverageManifest({...input,routes:catalog.routes,requirementsSources:catalog.requirementsSources,sourceCatalog:catalog.sources});
 const scope=validateStartupLocalScope(input.scope,input.proof,manifest.targetHash,input.fixtureHash),config=scope.configuration;
 if(scope.client.dynamicTools!=='none'||scope.client.selectedCapabilityRoots!=='none'||scope.client.remoteEnvironments!=='none')throw Error('HEADLESS_LOCAL_SCOPE_UNPROVEN');
 if(!config.appsDisabled||!config.hooksDisabled||!config.notifyDisabled||!config.webDisabled||!config.mcpDisabled||config.optionalConflict||['plugins','browser','browserExternal','browserCdp','computer'].some(key=>config.states[key as keyof typeof config.states]!=='disabled')||config.selectedPermissionsHash!==input.proof.policy!.permissionsHash||config.shellEnvironmentPolicyHash!==input.proof.policy!.shellEnvironmentPolicyHash)throw Error('OBSERVED_RESTRICTIONS_UNPROVEN');
 return {catalog,manifest,scope};
}
