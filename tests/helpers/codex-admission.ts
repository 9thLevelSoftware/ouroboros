import { ownershipHash, ORDINARY_STARTUP_EFFECTS, STARTUP_SOURCES, STARTUP_SURFACES, startupTargetHash, type PhaseAdmission } from '../../src/qualification/codex-startup-authority.ts';

/** Simulated reviewed identities; these never qualify a real runtime. */
export const startupContext={node:{path:'C:\\trusted\\node.exe',version:'24.19.0' as const,sha256:'a'.repeat(64)},helper:{path:'C:\\trusted\\helper.exe',sha256:'b'.repeat(64)},controllerHash:'c'.repeat(64),protocolHash:'d'.repeat(64),adapterHash:'e'.repeat(64),verifierHash:'f'.repeat(64),osCapabilitiesHash:'1'.repeat(64),configHash:'2'.repeat(64),controlHash:'3'.repeat(64),budget:{activeMs:30000,outputBytes:262144,cleanupMs:15000}};
export function approval(request:any,phase:PhaseAdmission['phase']):PhaseAdmission{
  const intent=request.intent;const authorization=request.input?.authorization??{kind:'qualification',requestId:intent.requestId};
  return {schemaVersion:1,phase,intentHash:startupTargetHash(intent),owner:intent.owner,issuedAt:intent.issuedAt,expiresAt:intent.expiresAt,
    ordinaryEffects:[...ORDINARY_STARTUP_EFFECTS],budget:{...intent.budget},
    authorization:authorization.kind==='qualified'?{kind:'qualified',qualificationRef:authorization.qualificationRef}:{kind:'qualification',requestId:intent.requestId},
    controls:STARTUP_SURFACES.map(surface=>({surface,lifecycle:['bootstrap','thread-start','thread-resume'],sources:[...STARTUP_SOURCES],controlHash:intent.controlHash,
      ...(authorization.kind==='qualified'?{route:'supported-restriction' as const,evidenceHash:'4'.repeat(64),qualificationRef:authorization.qualificationRef,persistent:true}:{route:'contained-qualification' as const,containmentHash:'5'.repeat(64),hostAccessBounded:true,externalDestinationsBounded:true})})),
    ...(request.ownership?{ownershipHash:ownershipHash(request.ownership),observationHash:request.observationHash??request.observedFingerprint}:{})};
}
export const admittedStartup=async(request:any)=>({authorized:true,authorizationRef:'simulated-startup',admission:approval(request,'BOOTSTRAP')});
export const admittedPreThread=async(request:any)=>({authorized:true,authorizationRef:'simulated-pre-thread',admission:approval(request,'PRE_THREAD')});
export const admittedTurn=async(request:any)=>({authorized:true,authorizationRef:'simulated-turn',admission:approval(request,'TURN')});
