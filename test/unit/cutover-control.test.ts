import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import {
  activateReviewCutoverLive,
  getReviewCutoverStatus,
  isConvergenceRepoLive,
  markReviewCutoverFreezeVerified,
  markReviewCutoverRollbackDryRun,
  rollbackReviewCutoverToShadow,
} from "../../src/review/cutover-control";
import { recordNativeGateDecision } from "../../src/review/parity-wire";
import { createTestEnv } from "../helpers/d1";

async function seedReviewbotDecision(env: Env, project: string, pr: number, headSha: string, decision: string, summary: string): Promise<void> {
  await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary, created_at)
       VALUES (?, ?, ?, 'gate_decision', ?, 'reviewbot', ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(`gate:reviewbot:${project}#${pr}@${headSha}`, project, `${project}#${pr}`, decision, headSha, summary)
    .run();
}

async function seedPerfectParity(env: Env, repoFullName: string, count = 35): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    const sha = `${repoFullName}-sha-${i}`;
    await seedReviewbotDecision(env, repoFullName, i, sha, i % 2 === 0 ? "merge" : "hold", "gate_reason");
    await recordNativeGateDecision(env, {
      project: repoFullName,
      pullNumber: i,
      headSha: sha,
      conclusion: i % 2 === 0 ? "success" : "failure",
      reasonCode: "gate_reason",
    });
  }
}

describe("review cutover control", () => {
  it("keeps converged review OFF until a repo is explicitly promoted live", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    expect(await isConvergenceRepoLive(env, "JSONbored/gittensory")).toBe(false);
    const status = await getReviewCutoverStatus(env, "JSONbored/gittensory");
    expect(status.stage).toBe("shadow");
    expect(status.liveAllowed).toBe(false);
  });

  it("activates a non-sequenced repo only after parity, freeze verification, and rollback dry-run", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    await seedPerfectParity(env, "acme/widgets");
    await markReviewCutoverFreezeVerified(env, "acme/widgets", "jsonbored");
    await markReviewCutoverRollbackDryRun(env, "acme/widgets", "jsonbored");
    const status = await activateReviewCutoverLive(env, "acme/widgets");
    expect(status.stage).toBe("live");
    expect(status.liveAllowed).toBe(true);
    expect(await isConvergenceRepoLive(env, "acme/widgets")).toBe(true);
  });

  it("enforces the repo sequence for the tracked three-repo rollout", async () => {
    const env = createTestEnv({
      GITTENSORY_REVIEW_PARITY_AUDIT: "true",
      GITTENSORY_REVIEW_REPOS: "JSONbored/awesome-claude,JSONbored/gittensory",
    });
    await seedPerfectParity(env, "JSONbored/gittensory");
    await markReviewCutoverFreezeVerified(env, "JSONbored/gittensory", "jsonbored");
    await markReviewCutoverRollbackDryRun(env, "JSONbored/gittensory", "jsonbored");
    const status = await getReviewCutoverStatus(env, "JSONbored/gittensory");
    expect(status.readyForLive).toBe(false);
    expect(status.blockers).toContain("prior_repo_not_live:JSONbored/awesome-claude");
  });

  it("rollback returns a live repo to shadow and clears freeze verification", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    await seedPerfectParity(env, "acme/widgets");
    await markReviewCutoverFreezeVerified(env, "acme/widgets", "jsonbored");
    await markReviewCutoverRollbackDryRun(env, "acme/widgets", "jsonbored");
    await activateReviewCutoverLive(env, "acme/widgets");
    const rolledBack = await rollbackReviewCutoverToShadow(env, "acme/widgets");
    expect(rolledBack.stage).toBe("shadow");
    expect(rolledBack.freezeVerifiedAt).toBeNull();
    expect(rolledBack.liveAllowed).toBe(false);
    expect(await isConvergenceRepoLive(env, "acme/widgets")).toBe(false);
  });
});

describe("internal cutover routes", () => {
  const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" });

  it("requires internal auth", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/v1/internal/cutover", {}, env)).status).toBe(401);
  });

  it("returns 409 when activation is attempted before the hard gates pass", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    const res = await app.request(
      "/v1/internal/cutover/repos/acme/widgets",
      { method: "POST", headers: bearer(env), body: JSON.stringify({ action: "activate_live" }) },
      env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; blockers: string[] };
    expect(body.error).toBe("cutover_transition_blocked");
    expect(body.blockers).toContain("parity_not_ready");
    expect(body.blockers).toContain("freeze_not_verified");
    expect(body.blockers).toContain("rollback_dry_run_not_passed");
  });

  it("promotes a repo live through the internal route once all hard gates pass", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_PARITY_AUDIT: "true" });
    await seedPerfectParity(env, "acme/widgets");
    await app.request(
      "/v1/internal/cutover/repos/acme/widgets",
      { method: "POST", headers: bearer(env), body: JSON.stringify({ action: "verify_freeze", actor: "jsonbored" }) },
      env,
    );
    await app.request(
      "/v1/internal/cutover/repos/acme/widgets",
      { method: "POST", headers: bearer(env), body: JSON.stringify({ action: "record_rollback_dry_run", actor: "jsonbored" }) },
      env,
    );
    const res = await app.request(
      "/v1/internal/cutover/repos/acme/widgets",
      { method: "POST", headers: bearer(env), body: JSON.stringify({ action: "activate_live" }) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage: string; liveAllowed: boolean };
    expect(body.stage).toBe("live");
    expect(body.liveAllowed).toBe(true);
  });
});
