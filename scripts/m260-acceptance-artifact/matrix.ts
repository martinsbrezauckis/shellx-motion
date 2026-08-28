/** Source-only lifecycle and proof projection for the repository C1 artifact. */
import {
  compareCodeUnits,
  listRendererCapabilityCards,
  type RendererCapabilityCard
} from "../../packages/core/src/index.js";

export const CAPABILITY_EVIDENCE_SOURCE_INVENTORY_REFERENCE =
  "packages/core/src/capability-cards.ts#RENDERER_CAPABILITY_CARDS";

export const CAPABILITY_LIFECYCLE_STAGES = [
  "create", "inspect", "edit", "save", "reopen", "preview", "render", "final", "receipt", "refusal"
] as const;

export const CAPABILITY_PROOF_LEVELS = [
  "source", "package-reopen", "installed", "native", "hardware", "final-media", "human-reviewed"
] as const;

export type CapabilityLifecycleStage = typeof CAPABILITY_LIFECYCLE_STAGES[number];
export type CapabilityProofLevel = typeof CAPABILITY_PROOF_LEVELS[number];
export type CapabilityLifecycleStatus = "source-accepted" | "evidence-accepted" | "planned" | "refused";
export type CapabilityProofStatus = "not-captured" | "captured" | "not-applicable";

export interface CapabilityLifecycleTag {
  stage: CapabilityLifecycleStage;
  status: CapabilityLifecycleStatus;
  note?: string;
}

export interface CapabilityProofTag {
  level: CapabilityProofLevel;
  status: CapabilityProofStatus;
  evidenceRef?: string;
  note?: string;
}

export interface CapabilityEvidenceSemanticTag {
  rendererCapabilityId: string;
  lifecycle: readonly CapabilityLifecycleTag[];
  proof: readonly CapabilityProofTag[];
}

export interface CapabilityEvidenceMatrixLifecycleCell {
  stage: CapabilityLifecycleStage;
  status: CapabilityLifecycleStatus;
  note?: string;
}

export interface CapabilityEvidenceMatrixProofCell {
  level: CapabilityProofLevel;
  status: CapabilityProofStatus;
  evidenceRef?: string;
  note?: string;
}

export interface CapabilityEvidenceMatrixRow {
  capabilityId: string;
  description: string;
  contractRef: string;
  laneRefs: readonly string[];
  limitRefs: readonly string[];
  lifecycle: readonly CapabilityEvidenceMatrixLifecycleCell[];
  proof: readonly CapabilityEvidenceMatrixProofCell[];
}

export interface CapabilityEvidenceMatrix {
  schema: "shellx-motion/capability-evidence-matrix@1";
  rows: readonly CapabilityEvidenceMatrixRow[];
}

const SOURCE_ONLY_STAGES: ReadonlySet<CapabilityLifecycleStage> = new Set(["create", "inspect", "edit", "refusal"]);
const EVIDENCE_PROOF_REQUIREMENTS: Readonly<Partial<Record<CapabilityLifecycleStage, readonly CapabilityProofLevel[]>>> = Object.freeze({
  create: ["source"],
  inspect: ["source"],
  edit: ["source"],
  save: ["source", "package-reopen"],
  reopen: ["source", "package-reopen"],
  preview: ["source", "installed", "native", "hardware"],
  render: ["source", "installed", "native", "hardware"],
  final: ["source", "installed", "native", "hardware", "final-media"],
  receipt: ["source", "installed", "native", "hardware", "final-media", "human-reviewed"],
  refusal: ["source"]
});

/** The production card reader remains the only renderer-card authority. */
export function sourceCapabilityEvidenceSemanticInventory(): readonly CapabilityEvidenceSemanticTag[] {
  return Object.freeze(listRendererCapabilityCards().map((card) => Object.freeze({
    rendererCapabilityId: card.id,
    lifecycle: Object.freeze(CAPABILITY_LIFECYCLE_STAGES.map((stage) => Object.freeze({
      stage,
      status: "planned" as const,
      note: "Canonical card source is not lifecycle acceptance evidence."
    }))),
    proof: Object.freeze(CAPABILITY_PROOF_LEVELS.map((level) => level === "source"
      ? Object.freeze({ level, status: "captured" as const, evidenceRef: rendererCardSourceLocator(card.id) })
      : Object.freeze({ level, status: "not-captured" as const })))
  })));
}

export function generateCapabilityEvidenceMatrix(
  tags: readonly CapabilityEvidenceSemanticTag[],
  rendererCards: readonly RendererCapabilityCard[] = listRendererCapabilityCards()
): CapabilityEvidenceMatrix {
  const cardsById = canonicalCardsById(rendererCards);
  const taggedIds = new Set<string>();
  const rows = tags.map((tag) => {
    const card = cardsById.get(tag.rendererCapabilityId);
    if (!card) throw new Error(`Capability evidence tag is not registered by a canonical renderer card: ${tag.rendererCapabilityId}`);
    if (taggedIds.has(tag.rendererCapabilityId)) throw new Error(`Capability evidence matrix has duplicate rendererCapabilityId: ${tag.rendererCapabilityId}`);
    taggedIds.add(tag.rendererCapabilityId);
    assertLifecycleCoverage(tag);
    assertProofCoverage(tag);
    assertStageSafeAcceptance(tag);
    return Object.freeze({
      capabilityId: card.id,
      description: `Evidence lifecycle for canonical renderer capability card ${card.id}; renderer support remains defined by that card.`,
      contractRef: `renderer-capability-card:${card.id}`,
      laneRefs: Object.freeze([card.id]),
      limitRefs: Object.freeze([`renderer-capability-card:${card.id}:weaknesses`]),
      lifecycle: Object.freeze(CAPABILITY_LIFECYCLE_STAGES.map((stage) => {
        const cell = lifecycleCellFor(tag, stage);
        return Object.freeze({ stage, status: cell.status, ...(cell.note ? { note: cell.note } : {}) });
      })),
      proof: Object.freeze(CAPABILITY_PROOF_LEVELS.map((level) => {
        const cell = proofCellFor(tag, level);
        return Object.freeze({
          level,
          status: cell.status,
          ...(cell.evidenceRef ? { evidenceRef: cell.evidenceRef } : {}),
          ...(cell.note ? { note: cell.note } : {})
        });
      }))
    });
  }).sort((left, right) => compareCodeUnits(left.capabilityId, right.capabilityId));
  return Object.freeze({ schema: "shellx-motion/capability-evidence-matrix@1", rows: Object.freeze(rows) });
}

export function generateSourceCapabilityEvidenceMatrix(): CapabilityEvidenceMatrix {
  return generateCapabilityEvidenceMatrix(sourceCapabilityEvidenceSemanticInventory());
}

function rendererCardSourceLocator(cardId: string): string {
  return `${CAPABILITY_EVIDENCE_SOURCE_INVENTORY_REFERENCE}:${cardId}`;
}

function canonicalCardsById(rendererCards: readonly RendererCapabilityCard[]): ReadonlyMap<string, RendererCapabilityCard> {
  const cards = new Map<string, RendererCapabilityCard>();
  for (const card of rendererCards) {
    assertText(card.id, "renderer card id");
    if (cards.has(card.id)) throw new Error(`Canonical renderer cards have duplicate id: ${card.id}`);
    cards.set(card.id, card);
  }
  return cards;
}

function assertLifecycleCoverage(tag: CapabilityEvidenceSemanticTag): void {
  const seen = new Set<CapabilityLifecycleStage>();
  for (const cell of tag.lifecycle) {
    if (!CAPABILITY_LIFECYCLE_STAGES.includes(cell.stage)) throw new Error(`${tag.rendererCapabilityId}.lifecycle has an unknown stage: ${String(cell.stage)}`);
    if (seen.has(cell.stage)) throw new Error(`${tag.rendererCapabilityId}.lifecycle has duplicate stage: ${cell.stage}`);
    seen.add(cell.stage);
    if (cell.note !== undefined) assertText(cell.note, `${tag.rendererCapabilityId}.lifecycle.${cell.stage}.note`);
  }
  assertComplete(CAPABILITY_LIFECYCLE_STAGES, seen, `${tag.rendererCapabilityId}.lifecycle`);
}

function assertProofCoverage(tag: CapabilityEvidenceSemanticTag): void {
  const seen = new Set<CapabilityProofLevel>();
  for (const cell of tag.proof) {
    if (!CAPABILITY_PROOF_LEVELS.includes(cell.level)) throw new Error(`${tag.rendererCapabilityId}.proof has an unknown level: ${String(cell.level)}`);
    if (seen.has(cell.level)) throw new Error(`${tag.rendererCapabilityId}.proof has duplicate level: ${cell.level}`);
    seen.add(cell.level);
    const location = `${tag.rendererCapabilityId}.proof.${cell.level}`;
    if (cell.status === "captured") assertText(cell.evidenceRef ?? "", `${location}.evidenceRef`);
    else if (cell.evidenceRef !== undefined) throw new Error(`${location}.evidenceRef is only allowed when proof is captured`);
    if (cell.status === "not-applicable") assertText(cell.note ?? "", `${location}.note`);
    else if (cell.note !== undefined) assertText(cell.note, `${location}.note`);
  }
  assertComplete(CAPABILITY_PROOF_LEVELS, seen, `${tag.rendererCapabilityId}.proof`);
}

function assertStageSafeAcceptance(tag: CapabilityEvidenceSemanticTag): void {
  for (const lifecycle of tag.lifecycle) {
    const location = `${tag.rendererCapabilityId}.lifecycle.${lifecycle.stage}`;
    if (lifecycle.status === "source-accepted") {
      if (!SOURCE_ONLY_STAGES.has(lifecycle.stage)) throw new Error(`${location} cannot be source-accepted; runtime stages require evidence-accepted proof`);
      assertCapturedProof(tag, ["source"], location);
    }
    if (lifecycle.status === "evidence-accepted") assertCapturedProof(tag, EVIDENCE_PROOF_REQUIREMENTS[lifecycle.stage] ?? [], location);
  }
}

function assertCapturedProof(tag: CapabilityEvidenceSemanticTag, required: readonly CapabilityProofLevel[], location: string): void {
  const missing = required.filter((level) => proofCellFor(tag, level).status !== "captured");
  if (missing.length > 0) throw new Error(`${location} is missing captured proof: ${missing.join(", ")}`);
}

function assertComplete<T extends string>(required: readonly T[], seen: ReadonlySet<T>, location: string): void {
  const missing = required.filter((entry) => !seen.has(entry));
  if (missing.length > 0) throw new Error(`${location} is missing: ${missing.join(", ")}`);
}

function assertText(value: string, location: string): void {
  if (value.trim().length === 0) throw new Error(`${location} must be non-empty`);
}

function lifecycleCellFor(tag: CapabilityEvidenceSemanticTag, stage: CapabilityLifecycleStage): CapabilityLifecycleTag {
  const cell = tag.lifecycle.find((candidate) => candidate.stage === stage);
  if (!cell) throw new Error(`${tag.rendererCapabilityId}.lifecycle is missing: ${stage}`);
  return cell;
}

function proofCellFor(tag: CapabilityEvidenceSemanticTag, level: CapabilityProofLevel): CapabilityProofTag {
  const cell = tag.proof.find((candidate) => candidate.level === level);
  if (!cell) throw new Error(`${tag.rendererCapabilityId}.proof is missing: ${level}`);
  return cell;
}
