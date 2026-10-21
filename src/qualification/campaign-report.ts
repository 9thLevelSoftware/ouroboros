import type { RunStore } from '../store/database.ts';
import { QualificationCampaign } from './campaign.ts';
import { evaluateStartupBlockers, evaluateStartupSupportingRequirements, loadStartupEvidence, type StartupEvidenceOptions } from './startup-evidence.ts';

/** Passive evidence query. The recorded target is displayed explicitly; this is
 * neither dispatch permission nor an assertion that installed inputs still match. */
export function reportCampaignQualification(store: RunStore, campaignId: string, acceptance: StartupEvidenceOptions = {}) {
 const campaign = new QualificationCampaign(store, { authorizeCurrent: () => false });
 const state = campaign.snapshot(campaignId);
 if (!state.ok) return state;
 const catalog = campaign.aggregate(campaignId);
 if (!catalog.ok) return catalog;
 const evidence = loadStartupEvidence(store, state.value.target, acceptance);
 const blockers = evaluateStartupBlockers(state.value.target, evidence);
 const supporting = evaluateStartupSupportingRequirements(state.value.target, evidence);
 const recovery = store.reconcileEvidence(state.value.identity.owner.runId);
 if (!recovery.ok) return recovery;
 const reconciled = recovery.value.allowsReady && !state.value.fenced && !state.value.superseded &&
  !state.value.reconciliationRequired && !state.value.accountingPending && !state.value.correctionRequired && state.value.reserved.actions === 0;
 const complete = reconciled && evidence.issues.length === 0 && blockers.every(value => value.state === 'CLOSED') &&
  supporting.every(value => value.state === 'CLOSED') && catalog.value.length === 32 && catalog.value.every(value => value.status === 'PASS');
 return { ok: true as const, value: { schemaVersion: 1 as const, campaignId, scope: 'recorded-target-only' as const,
  target: state.value.target, targetHash: state.value.targetHash, currentInstallationRevalidated: false as const,
  acceptedEvidenceComplete: complete, blockers, supporting, probes: catalog.value,
  evidenceIssues: [...evidence.issues], reconciled, consumed: state.value.consumed, reserved: state.value.reserved,
  remaining: state.value.remaining, correctionUsage: state.value.correctionUsage, unsuccessfulCorrections: state.value.unsuccessfulCorrections } };
}
