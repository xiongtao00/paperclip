import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { processApproval, publishResult, recipeIdentity } from "./managed-host-execution.mjs";

async function fixture(t) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-host-"));
  t.after(() => fs.rm(state, { force: true, recursive: true }));
  const cwd = await fs.realpath(state);
  const executable = await fs.realpath(process.execPath);
  const recipe = { companyId: randomUUID(), projectId: randomUUID(), requesterAgentId: randomUUID(),
    reviewerAgentId: randomUUID(), cwd, executable, args: ["-e", "console.log('synthetic smoke')"], timeoutMs: 10000,
    executableSha256: createHash("sha256").update(await fs.readFile(executable)).digest("hex") };
  const issue = { id: randomUUID(), companyId: recipe.companyId, projectId: recipe.projectId,
    assigneeAgentId: recipe.reviewerAgentId, status: "in_review" };
  const approval = { id: randomUUID(), status: "approved", type: "request_board_approval",
    companyId: recipe.companyId, requestedByAgentId: recipe.requesterAgentId,
    payload: { kind: "paperclip.managed-host-execution.v1", recipeHash: recipeIdentity(recipe), issueId: issue.id } };
  return { state, recipe, approval, issues: [issue] };
}

test("approval binds the exact reviewed recipe and linked project before any process starts", async (t) => {
  const f = await fixture(t);
  const forbidden = () => assert.fail("must not run or publish");
  for (const change of [
    { approval: { ...f.approval, status: "pending" } },
    { approval: { ...f.approval, requestedByAgentId: randomUUID() } },
    { approval: { ...f.approval, id: "../escape" } },
    { recipe: { ...f.recipe, args: ["-e", "process.exit(1)"] } },
    { recipe: { ...f.recipe, cwd: "/" } },
    { issues: [{ ...f.issues[0], projectId: randomUUID() }] },
    { issues: [{ ...f.issues[0], status: "done" }] },
    { issues: [...f.issues, f.issues[0]] },
  ]) {
    assert.equal((await processApproval({ ...f, ...change, run: forbidden, publish: forbidden })).status, "ineligible");
  }
  assert.deepEqual(await fs.readdir(f.state), []);
});

test("approved smoke runs once and a restart can redeliver the receipt without rerunning", async (t) => {
  const f = await fixture(t);
  const offline = async () => { throw Error("Paperclip temporarily unavailable"); };
  await assert.rejects(processApproval({ ...f, publish: offline }), /temporarily unavailable/);
  const dir = path.join(f.state, f.approval.id);
  assert.match(await fs.readFile(path.join(dir, "execution.log"), "utf8"), /synthetic smoke/);
  let received;
  const result = await processApproval({ ...f, run: () => assert.fail("must not run again"),
    publish: async (record) => { received = record; } });
  assert.equal(result.status, "succeeded");
  assert.equal(received.executionId, f.approval.id);
});

test("a changed executable fails preflight and an interrupted claim is not retried", async (t) => {
  const f = await fixture(t);
  f.recipe.executableSha256 = "0".repeat(64);
  f.approval.payload.recipeHash = recipeIdentity(f.recipe);
  const res = await processApproval({ ...f, run: () => assert.fail("unsafe command"),
    publish: async () => {} });
  assert.equal(res.status, "preflight_failed");
  f.approval.id = randomUUID();
  await fs.mkdir(path.join(f.state, f.approval.id));
  assert.equal((await processApproval({ ...f, run: () => assert.fail("must not retry"),
    publish: () => assert.fail("no verified receipt") })).status, "needs_reconciliation");
});

test("failed preflight reports the phase and never dispatches the main command", async (t) => {
  const f = await fixture(t);
  f.recipe.preflightArgs = ["-e", "process.exit(42)"];
  f.approval.payload.recipeHash = recipeIdentity(f.recipe);
  const phases = [];
  const record = await processApproval({ ...f, report: async (_record, phase) => phases.push(phase), publish: async () => {} });
  assert.deepEqual(phases, ["preflight"]);
  assert.equal(record.status, "preflight_failed");
  assert.equal(record.preflight.exitCode, 42);
  await assert.rejects(fs.stat(path.join(f.state, f.approval.id, "execution.log")), { code: "ENOENT" });
});

test("returns verified attachments to the original task, recovers delivery, and exposes a skipped QA wake", async (t) => {
  const f = await fixture(t);
  f.recipe.artifacts = ["results.json", "missing.png"];
  f.recipe.args = ["-e", `require("node:fs").writeFileSync(process.env.PAPERCLIP_ARTIFACT_DIR+"/results.json", '{"passed":1}')`];
  f.approval.payload.recipeHash = recipeIdentity(f.recipe);
  const attachments = [], comments = [], wakeups = [];
  let offline = true;
  const request = async (route, data) => {
    if (route === `/issues/${f.issues[0].id}`) return f.issues[0];
    if (route.endsWith("/attachments") && data === undefined) return attachments;
    if (route.endsWith("/attachments")) {
      const file = data.get("file");
      const bytes = Buffer.from(await file.arrayBuffer());
      assert.equal(bytes.toString(), '{"passed":1}');
      const attachment = { id: randomUUID(), originalFilename: file.name, sha256: createHash("sha256").update(bytes).digest("hex") };
      attachments.push(attachment);
      return attachment;
    }
    if (route.endsWith("/comments") && !data) return comments;
    if (route.endsWith("/comments")) { comments.push(data); return data; }
    if (route.endsWith("/live-runs")) return [];
    if (route.endsWith("/wakeup")) {
      wakeups.push(data.idempotencyKey);
      if (offline) throw Error("wakeup temporarily unavailable");
      return { status: "skipped" };
    }
    assert.fail(route);
  };
  const publish = (record, dir) => publishResult(record, dir, f.recipe, request);
  await assert.rejects(processApproval({ ...f, publish }), /temporarily unavailable/);
  offline = false;
  await processApproval({ ...f, run: () => assert.fail("no repeat"), publish });
  await processApproval({ ...f, run: () => assert.fail("no repeat"), publish });
  assert.equal(attachments.length, 1);
  assert.equal(comments.length, 2);
  assert.match(comments[0].body, /Missing registered artifacts: missing.png/);
  assert.ok(comments[0].body.includes(`/api/attachments/${attachments[0].id}/content`));
  assert.match(comments[1].body, /QA handoff: skipped/);
  assert.equal(new Set(wakeups).size, 1);
});

test("artifact symlink is not handed back even if it has a registered name", async (t) => {
  const f = await fixture(t);
  f.recipe.artifacts = ["results.json"];
  f.approval.payload.recipeHash = recipeIdentity(f.recipe);
  const record = await processApproval({ ...f, run: async (_recipe, dir) => {
    await fs.symlink("/etc/hosts", path.join(dir, "artifacts", "results.json"));
    return { status: "succeeded", exitCode: 0 };
  }, publish: async () => {} });
  assert.deepEqual(record.artifacts, []);
  assert.deepEqual(record.missingArtifacts, ["results.json"]);
});

test("opt-in approval hands off after evidence, and a lost assignment response never assigns or runs twice", async (t) => {
  const f = await fixture(t);
  f.recipe.autoAssignReviewer = true;
  f.approval.payload.recipeHash = recipeIdentity(f.recipe);
  Object.assign(f.issues[0], { assigneeAgentId: f.recipe.requesterAgentId, statusVersion: 3 });
  const comments = [];
  let assignments = 0, wakes = 0;
  const request = async (route, data, method) => {
    if (route.endsWith("/attachments")) return [];
    if (route.endsWith("/comments")) {
      if (!data) return comments;
      comments.push(data); return data;
    }
    if (route.endsWith("/wakeup")) { wakes++; return { id: randomUUID() }; }
    if (method === "PATCH") {
      assignments++;
      assert.equal(data.status, "todo");
      assert.equal(comments.length, 1, "evidence is visible before assignment");
      assert.deepEqual(data.expectedReviewHandoff, {
        projectId: f.recipe.projectId, fromAgentId: f.recipe.requesterAgentId, statusVersion: 3,
      });
      f.issues[0].assigneeAgentId = data.assigneeAgentId;
      throw Error("lost assignment response");
    }
    return f.issues[0];
  };
  const publish = (record, dir) => publishResult(record, dir, f.recipe, request);
  await assert.rejects(processApproval({ ...f, publish }), /lost assignment response/);
  const result = await processApproval({ ...f, run: () => assert.fail("cannot rerun"), publish });
  assert.equal(result.reviewerWakeup, "accepted");
  assert.equal(assignments, 1);
  assert.equal(wakes, 1);
});

test("does not report a blocked handoff if QA was already scheduled by assignment", async (t) => {
  const f = await fixture(t);
  const comments = [];
  const runId = randomUUID();
  const request = async (route, data) => {
    if (route.endsWith("/attachments")) return [];
    if (route.endsWith("/comments")) {
      if (data) comments.push(data);
      return comments;
    }
    if (route.endsWith("/wakeup")) return { status: "skipped" };
    if (route.endsWith("/live-runs")) return [{ id: runId, agentId: f.recipe.reviewerAgentId, status: "running", createdAt: new Date().toISOString() }];
    return f.issues[0];
  };
  const record = await processApproval({ ...f, publish: (r, dir) => publishResult(r, dir, f.recipe, request) });
  assert.equal(record.reviewerWakeup, "already_scheduled");
  assert.equal(record.reviewerRunId, runId);
  assert.equal(comments.length, 1);
});

test("a timed-out host process leaves a terminal receipt and is not executed again", async (t) => {
  const f = await fixture(t);
  f.recipe.args = ["-e", "setInterval(() => {}, 1000)"];
  f.recipe.timeoutMs = 150;
  f.approval.payload.recipeHash = recipeIdentity(f.recipe);
  const record = await processApproval({ ...f, publish: async () => {} });
  assert.equal(record.status, "timed_out");
  assert.equal(record.signal, "SIGKILL");
  const recovered = await processApproval({ ...f, run: () => assert.fail("must not repeat"), publish: async () => {} });
  assert.equal(recovered.status, "timed_out");
});

test("failed execution or missing reviewer gets a company-scoped idempotent recovery owner", async (t) => {
  const f = await fixture(t);
  const oldHash = recipeIdentity(f.recipe);
  f.recipe.recoveryAgentId = randomUUID();
  assert.notEqual(recipeIdentity(f.recipe), oldHash, "old approval cannot acquire recovery assignment authority");
  f.approval.payload.recipeHash = recipeIdentity(f.recipe);
  const recoveryId = randomUUID();
  const requests = [];
  const request = async (route, data) => {
    if (route.endsWith("/attachments") || route.endsWith("/live-runs")) return [];
    if (route.endsWith("/comments")) return data ?? [];
    if (route.endsWith("/wakeup")) return { status: "skipped" };
    if (route === `/companies/${f.recipe.companyId}/issues`) {
      requests.push(data);
      assert.equal(data.assigneeAgentId, f.recipe.recoveryAgentId);
      assert.equal(data.projectId, f.recipe.projectId);
      assert.equal(data.idempotencyKey, `managed-host-recovery:${f.approval.id}`);
      return { id: recoveryId, companyId: f.recipe.companyId, projectId: f.recipe.projectId };
    }
    return f.issues[0];
  };
  const record = await processApproval({ ...f, publish: (r, dir) => publishResult(r, dir, f.recipe, request) });
  assert.equal(record.recoveryIssueId, recoveryId);
  await processApproval({ ...f, run: () => assert.fail("must not repeat"), publish: () => assert.fail("already delivered") });
  assert.equal(requests.length, 1);
});
