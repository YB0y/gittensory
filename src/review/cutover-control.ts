import { computeParityReadiness, isParityAuditEnabled, type ParityReadinessRow } from "./parity-wire";
import { isConvergenceRepoAllowed } from "./cutover-gate";
import { nowIso } from "../utils/json";

export type CutoverStage = "shadow" | "live";

export interface ReviewCutoverControl {
  repoFullName: string;
  stage: CutoverStage;
  freezeVerifiedAt: string | null;
  freezeVerifiedBy: string | null;
  rollbackDryRunAt: string | null;
  rollbackDryRunBy: string | null;
  lastLiveAt: string | null;
  lastRollbackAt: string | null;
  updatedAt: string | null;
}

export interface ReviewCutoverStatus extends ReviewCutoverControl {
  envAllowlisted: boolean;
  parityAuditEnabled: boolean;
  parity: ParityReadinessRow | null;
  blockers: string[];
  readyForLive: boolean;
  liveAllowed: boolean;
  sequenceIndex: number | null;
}

export class CutoverTransitionError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super("cutover_transition_blocked");
    this.name = "CutoverTransitionError";
    this.blockers = blockers;
  }
}

const CUTOVER_SEQUENCE = ["JSONbored/awesome-claude", "JSONbored/gittensory", "JSONbored/metagraphed"] as const;

function normalizeRepo(repoFullName: string): string {
  return repoFullName.trim();
}

function defaultControl(repoFullName: string): ReviewCutoverControl {
  return {
    repoFullName,
    stage: "shadow",
    freezeVerifiedAt: null,
    freezeVerifiedBy: null,
    rollbackDryRunAt: null,
    rollbackDryRunBy: null,
    lastLiveAt: null,
    lastRollbackAt: null,
    updatedAt: null,
  };
}

function toControl(row: Record<string, unknown> | null | undefined, repoFullName: string): ReviewCutoverControl {
  if (!row) return defaultControl(repoFullName);
  return {
    repoFullName,
    stage: row.stage === "live" ? "live" : "shadow",
    freezeVerifiedAt: typeof row.freeze_verified_at === "string" ? row.freeze_verified_at : null,
    freezeVerifiedBy: typeof row.freeze_verified_by === "string" ? row.freeze_verified_by : null,
    rollbackDryRunAt: typeof row.rollback_dry_run_at === "string" ? row.rollback_dry_run_at : null,
    rollbackDryRunBy: typeof row.rollback_dry_run_by === "string" ? row.rollback_dry_run_by : null,
    lastLiveAt: typeof row.last_live_at === "string" ? row.last_live_at : null,
    lastRollbackAt: typeof row.last_rollback_at === "string" ? row.last_rollback_at : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

async function rawFirst(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown> | null> {
  return await (env.DB as unknown as { prepare: (statement: string) => { bind: (...values: unknown[]) => { first: <T>() => Promise<T | null> } } })
    .prepare(sql)
    .bind(...binds)
    .first<Record<string, unknown>>();
}

async function rawAll(env: Env, sql: string, ...binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await (env.DB as unknown as { prepare: (statement: string) => { bind: (...values: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } } })
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return res.results;
}

async function rawRun(env: Env, sql: string, ...binds: unknown[]): Promise<void> {
  await (env.DB as unknown as { prepare: (statement: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare(sql)
    .bind(...binds)
    .run();
}

export async function getReviewCutoverControl(env: Env, repoFullName: string): Promise<ReviewCutoverControl> {
  const repo = normalizeRepo(repoFullName);
  const row = await rawFirst(env, "SELECT * FROM review_cutover_controls WHERE lower(repo_full_name) = lower(?) LIMIT 1", repo);
  return toControl(row, repo);
}

export async function listReviewCutoverControls(env: Env): Promise<ReviewCutoverControl[]> {
  const rows = await rawAll(env, "SELECT * FROM review_cutover_controls ORDER BY repo_full_name");
  return rows.map((row) => toControl(row, typeof row.repo_full_name === "string" ? row.repo_full_name : ""));
}

export async function markReviewCutoverFreezeVerified(env: Env, repoFullName: string, actor: string | null = null): Promise<ReviewCutoverControl> {
  const repo = normalizeRepo(repoFullName);
  const at = nowIso();
  await rawRun(
    env,
    `INSERT INTO review_cutover_controls (repo_full_name, stage, freeze_verified_at, freeze_verified_by, updated_at)
     VALUES (?, 'shadow', ?, ?, ?)
     ON CONFLICT(repo_full_name) DO UPDATE SET freeze_verified_at = excluded.freeze_verified_at, freeze_verified_by = excluded.freeze_verified_by, updated_at = excluded.updated_at`,
    repo,
    at,
    actor,
    at,
  );
  return getReviewCutoverControl(env, repo);
}

export async function markReviewCutoverRollbackDryRun(env: Env, repoFullName: string, actor: string | null = null): Promise<ReviewCutoverControl> {
  const repo = normalizeRepo(repoFullName);
  const at = nowIso();
  await rawRun(
    env,
    `INSERT INTO review_cutover_controls (repo_full_name, stage, rollback_dry_run_at, rollback_dry_run_by, updated_at)
     VALUES (?, 'shadow', ?, ?, ?)
     ON CONFLICT(repo_full_name) DO UPDATE SET rollback_dry_run_at = excluded.rollback_dry_run_at, rollback_dry_run_by = excluded.rollback_dry_run_by, updated_at = excluded.updated_at`,
    repo,
    at,
    actor,
    at,
  );
  return getReviewCutoverControl(env, repo);
}

function sequenceIndex(repoFullName: string): number | null {
  const index = CUTOVER_SEQUENCE.findIndex((entry) => entry.toLowerCase() === repoFullName.toLowerCase());
  return index >= 0 ? index : null;
}

export async function getReviewCutoverStatus(env: Env, repoFullName: string): Promise<ReviewCutoverStatus> {
  const repo = normalizeRepo(repoFullName);
  const control = await getReviewCutoverControl(env, repo);
  const parityAuditEnabled = isParityAuditEnabled(env);
  const parityReport = parityAuditEnabled ? await computeParityReadiness(env, { project: repo }) : null;
  const parity = parityReport?.rows.find((row) => row.project.toLowerCase() === repo.toLowerCase()) ?? null;
  const blockers: string[] = [];
  if (!isConvergenceRepoAllowed(env, repo)) blockers.push("explicit_signal_required");
  if (!parityAuditEnabled) blockers.push("parity_audit_disabled");
  else if (!parity?.cutoverReady) blockers.push("parity_not_ready");
  if (!control.freezeVerifiedAt) blockers.push("freeze_not_verified");
  if (!control.rollbackDryRunAt) blockers.push("rollback_dry_run_not_passed");
  const repoSequenceIndex = sequenceIndex(repo);
  if (repoSequenceIndex !== null) {
    for (const priorRepo of CUTOVER_SEQUENCE.slice(0, repoSequenceIndex)) {
      const prior = await getReviewCutoverControl(env, priorRepo);
      if (prior.stage !== "live") {
        blockers.push(`prior_repo_not_live:${priorRepo}`);
        break;
      }
    }
  }
  const liveAllowed =
    isConvergenceRepoAllowed(env, repo) &&
    control.stage === "live" &&
    Boolean(control.freezeVerifiedAt) &&
    Boolean(control.rollbackDryRunAt);
  return {
    ...control,
    envAllowlisted: isConvergenceRepoAllowed(env, repo),
    parityAuditEnabled,
    parity,
    blockers,
    readyForLive: blockers.length === 0,
    liveAllowed,
    sequenceIndex: repoSequenceIndex,
  };
}

export async function listReviewCutoverStatuses(env: Env): Promise<ReviewCutoverStatus[]> {
  const repos = new Set<string>(CUTOVER_SEQUENCE);
  for (const repo of (env.GITTENSORY_REVIEW_REPOS ?? "").split(",")) {
    const normalized = normalizeRepo(repo);
    if (normalized) repos.add(normalized);
  }
  for (const control of await listReviewCutoverControls(env)) {
    if (control.repoFullName) repos.add(control.repoFullName);
  }
  const statuses = await Promise.all([...repos].sort((left, right) => left.localeCompare(right)).map((repo) => getReviewCutoverStatus(env, repo)));
  return statuses;
}

export async function activateReviewCutoverLive(env: Env, repoFullName: string): Promise<ReviewCutoverStatus> {
  const repo = normalizeRepo(repoFullName);
  const status = await getReviewCutoverStatus(env, repo);
  if (!status.readyForLive) throw new CutoverTransitionError(status.blockers);
  const at = nowIso();
  await rawRun(
    env,
    `INSERT INTO review_cutover_controls (repo_full_name, stage, freeze_verified_at, freeze_verified_by, rollback_dry_run_at, rollback_dry_run_by, last_live_at, updated_at)
     VALUES (?, 'live', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_full_name) DO UPDATE SET stage = 'live', last_live_at = excluded.last_live_at, updated_at = excluded.updated_at`,
    repo,
    status.freezeVerifiedAt,
    status.freezeVerifiedBy,
    status.rollbackDryRunAt,
    status.rollbackDryRunBy,
    at,
    at,
  );
  return getReviewCutoverStatus(env, repo);
}

export async function rollbackReviewCutoverToShadow(env: Env, repoFullName: string): Promise<ReviewCutoverStatus> {
  const repo = normalizeRepo(repoFullName);
  const at = nowIso();
  await rawRun(
    env,
    `INSERT INTO review_cutover_controls (repo_full_name, stage, last_rollback_at, updated_at)
     VALUES (?, 'shadow', ?, ?)
     ON CONFLICT(repo_full_name) DO UPDATE SET stage = 'shadow', freeze_verified_at = NULL, freeze_verified_by = NULL, last_rollback_at = excluded.last_rollback_at, updated_at = excluded.updated_at`,
    repo,
    at,
    at,
  );
  return getReviewCutoverStatus(env, repo);
}

export async function isConvergenceRepoLive(env: Env, repoFullName: string): Promise<boolean> {
  try {
    return (await getReviewCutoverStatus(env, repoFullName)).liveAllowed;
  } catch {
    return false;
  }
}
