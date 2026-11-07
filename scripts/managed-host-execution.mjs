/**
 * Opt-in local-trusted operator worker. The approval carries an identity,
 * never a command. Run under a dedicated OS identity for untrusted projects.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs, writeSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const kind = "paperclip.managed-host-execution.v1";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const artifactTypes = { ".json": "application/json", ".png": "image/png", ".zip": "application/zip", ".txt": "text/plain" };
const maxArtifactBytes = 8 * 1024 * 1024;
const validArtifact = (name) => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name)
  && Object.hasOwn(artifactTypes, path.extname(name)) && name !== "receipt.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function recipeIdentity(recipe) {
  return sha(JSON.stringify([
    recipe.companyId, recipe.projectId, recipe.requesterAgentId, recipe.reviewerAgentId,
    recipe.cwd, recipe.executable, recipe.executableSha256, recipe.args, recipe.timeoutMs,
    recipe.preflightArgs ?? null, recipe.artifacts ?? [],
    ...(recipe.autoAssignReviewer === true ? ["auto-assign-reviewer"] : []),
    ...(recipe.recoveryAgentId ? ["recovery-agent", recipe.recoveryAgentId] : []),
  ]));
}

export function approvedExecution(approval, issues, recipe) {
  const p = approval.payload;
  const issue = issues[0];
  return approval.status === "approved"
    && approval.type === "request_board_approval"
    && uuid.test(approval.id)
    && approval.companyId === recipe.companyId
    && approval.requestedByAgentId === recipe.requesterAgentId
    && p?.kind === kind && p?.recipeHash === recipeIdentity(recipe)
    && issues.length === 1 && issue?.id === p.issueId && uuid.test(issue.id)
    && issue.companyId === recipe.companyId && issue.projectId === recipe.projectId
    && (issue.assigneeAgentId === recipe.reviewerAgentId ||
      (recipe.autoAssignReviewer === true && issue.assigneeAgentId === recipe.requesterAgentId
        && issue.status === "in_review" && !issue.executionRunId && !issue.checkoutRunId
        && !issue.assigneeUserId && Number.isInteger(issue.statusVersion)))
    && !["done", "cancelled"].includes(issue.status);
}

async function save(dir, record) {
  const temp = path.join(dir, randomUUID() + ".tmp");
  await fs.writeFile(temp, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(temp, path.join(dir, "receipt.json"));
}

async function execute(recipe, dir, phase = "execution") {
  const log = await fs.open(path.join(dir, phase + ".log"), "wx", 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(recipe.executable, recipe.args, {
        cwd: recipe.cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: dir, TMPDIR: dir, CI: "1", NEXT_TELEMETRY_DISABLED: "1", PAPERCLIP_ARTIFACT_DIR: path.join(dir, "artifacts") },
      });
      let timedOut = false;
      let logBytes = 0;
      let logTruncated = false;
      const capture = (chunk) => {
        const length = Math.min(chunk.length, 1024 * 1024 - logBytes);
        if (length) {
          // Bound file size even when a child emits an unlimited stream.
          logBytes += writeSync(log.fd, chunk, 0, length);
        }
        logTruncated ||= length < chunk.length;
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const kill = () => {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, recipe.timeoutMs);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        kill();
        resolve({ status: timedOut ? "timed_out" : exitCode === 0 ? "succeeded" : "failed", exitCode, signal, logTruncated });
      });
    });
  } finally { await log.close(); }
}

export async function processApproval({ approval, issues, recipe, state, run = execute, publish, report = async () => {} }) {
  if (!approvedExecution(approval, issues, recipe)) return { status: "ineligible" };
  const dir = path.join(state, approval.id);
  try { await fs.mkdir(dir, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // An interrupted or concurrent claim never causes a second execution.
    const previous = await fs.readFile(path.join(dir, "receipt.json"), "utf8").then(JSON.parse, (e) => {
      if (e.code !== "ENOENT") throw e;
      return { status: "needs_reconciliation" };
    });
    if (previous.recipeHash === recipeIdentity(recipe) && previous.issueId === issues[0].id
      && ["succeeded", "failed", "timed_out", "preflight_failed"].includes(previous.status)
      && !previous.deliveredAt) {
      await publish(previous, dir);
    }
    return previous.status === "running" ? { ...previous, status: "needs_reconciliation" } : previous;
  }

  const record = { executionId: approval.id, issueId: issues[0].id, recipeHash: recipeIdentity(recipe),
    status: "running", startedAt: new Date().toISOString() };
  await save(dir, record);
  await fs.mkdir(path.join(dir, "artifacts"), { mode: 0o700 });
  try {
    // Recipes and executables must be in operator-controlled locations.
    if (await fs.realpath(recipe.cwd) !== recipe.cwd || !(await fs.stat(recipe.cwd)).isDirectory()
      || await fs.realpath(recipe.executable) !== recipe.executable
      || !(await fs.stat(recipe.executable)).isFile()
      || sha(await fs.readFile(recipe.executable)) !== recipe.executableSha256) {
      throw new Error("Registered working directory or executable changed");
    }
    await fs.access(recipe.executable, 1);
  } catch {
    Object.assign(record, { status: "preflight_failed", reason: "registered_path_or_hash_mismatch" });
  }
  if (record.status === "running" && recipe.preflightArgs) {
    try {
      await report(record, "preflight");
      const probe = await run({ ...recipe, args: recipe.preflightArgs, timeoutMs: Math.min(recipe.timeoutMs, 30_000) }, dir, "preflight");
      record.preflight = probe;
      if (probe.status !== "succeeded") Object.assign(record, { status: "preflight_failed", reason: "registered_probe_failed" });
    } catch { Object.assign(record, { status: "preflight_failed", reason: "probe_or_progress_failed" }); }
  }
  if (record.status === "running") {
    try {
      await report(record, "execution");
      Object.assign(record, await run(recipe, dir));
    } catch { Object.assign(record, { status: "failed", reason: "spawn_or_progress_failed" }); }
  }
  record.artifacts = [];
  record.missingArtifacts = [];
  for (const name of recipe.artifacts ?? []) {
    try {
      if (!validArtifact(name)) throw new Error("invalid artifact name");
      const bytes = await readArtifact(dir, name);
      record.artifacts.push({ name, byteSize: bytes.length, sha256: sha(bytes) });
    } catch { record.missingArtifacts.push(name); }
  }
  record.finishedAt = new Date().toISOString();
  await save(dir, record);
  await publish(record, dir);
  return record;
}

async function readArtifact(dir, name) {
  const root = path.join(await fs.realpath(dir), "artifacts");
  if (await fs.realpath(root) !== root) throw new Error("Artifact directory changed");
  const file = path.join(root, name);
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxArtifactBytes) throw new Error("Invalid artifact");
    const data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, info.size, 0);
    if (bytesRead !== info.size) throw new Error("Artifact changed while reading");
    return data;
  } finally { await handle.close(); }
}

async function api(route, data, method = data === undefined ? "GET" : "POST") {
  // Deliberately local only: this worker relies on Paperclip local-trusted board access.
  const response = await fetch("http://127.0.0.1:3100/api" + route, {
    method,
    ...(data instanceof FormData ? { body: data } : {
      headers: { "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Paperclip request failed: ${response.status} ${route}`);
  return response.json();
}

export async function publishResult(record, dir, recipe, request = api) {
  const marker = `Managed host execution ${record.executionId}`;
  let issue = await request(`/issues/${record.issueId}`);
  if (issue.companyId !== recipe.companyId || issue.projectId !== recipe.projectId) {
    throw new Error("Original task no longer matches the registered project");
  }
  const comments = await request(`/issues/${record.issueId}/comments`);
  const attachments = await request(`/issues/${record.issueId}/attachments`);
  const links = [];
  for (const artifact of record.artifacts ?? []) {
    if (!validArtifact(artifact.name) || !recipe.artifacts?.includes(artifact.name)) throw new Error("Unregistered artifact");
    const bytes = await readArtifact(dir, artifact.name);
    if (bytes.length !== artifact.byteSize || sha(bytes) !== artifact.sha256) throw new Error("Artifact changed after execution");
    const filename = `${record.executionId}-${artifact.name}`;
    let attachment = attachments.find((a) => a.originalFilename === filename && a.sha256 === artifact.sha256);
    if (!attachment) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: artifactTypes[path.extname(artifact.name)] }), filename);
      attachment = await request(`/companies/${recipe.companyId}/issues/${record.issueId}/attachments`, form);
    }
    if (!uuid.test(attachment.id) || attachment.sha256 !== artifact.sha256) throw new Error("Attachment receipt mismatch");
    links.push(`- [${artifact.name}](/api/attachments/${attachment.id}/content) · SHA-256 \`${artifact.sha256}\``);
  }
  if (!comments.some((comment) => !comment.authorAgentId && comment.body.startsWith(marker + ":"))) {
    const missing = record.missingArtifacts?.length ? ` Missing registered artifacts: ${record.missingArtifacts.join(", ")}.` : "";
    await request(`/issues/${record.issueId}/comments`, {
      notifyAgents: false,
      body: `${marker}: ${record.status}. Exit: ${record.exitCode ?? "not available"}. Recipe SHA-256: \`${record.recipeHash}\`.${missing} QA must verify the evidence before signing off.\n\n${links.join("\n")}`,
    });
  }
  if (recipe.autoAssignReviewer === true && issue.assigneeAgentId === recipe.requesterAgentId
      && issue.status === "in_review" && !issue.executionRunId && !issue.checkoutRunId
      && !issue.assigneeUserId && Number.isInteger(issue.statusVersion)) {
    try {
      issue = await request(`/issues/${record.issueId}`, {
        assigneeAgentId: recipe.reviewerAgentId,
        status: "todo",
        expectedReviewHandoff: { projectId: recipe.projectId, fromAgentId: recipe.requesterAgentId, statusVersion: issue.statusVersion },
      }, "PATCH");
      if (issue.assigneeAgentId !== recipe.reviewerAgentId) throw new Error("Review assignment not confirmed");
    } catch (error) {
      // A transport error may follow a committed update. Reconcile ownership
      // on the next delivery pass, never rerun the approved command.
      const message = `${marker} QA assignment could not be confirmed. The worker will check the current assignment before retrying delivery; the host command will not be repeated.`;
      if (!comments.some((comment) => !comment.authorAgentId && comment.body === message)) {
        await request(`/issues/${record.issueId}/comments`, { body: message, notifyAgents: false });
      }
      throw error;
    }
  }
  if (issue.assigneeAgentId === recipe.reviewerAgentId && !["done", "cancelled"].includes(issue.status)) {
    const wake = await request(`/agents/${recipe.reviewerAgentId}/wakeup`, {
      source: "on_demand", reason: "managed_host_execution_finished",
      payload: { issueId: record.issueId }, idempotencyKey: `managed-host-result:${record.executionId}`,
    });
    record.reviewerWakeup = wake.status === "skipped" ? "skipped" : wake.id ? "accepted" : "not_confirmed";
    if (record.reviewerWakeup === "skipped") {
      const live = await request(`/issues/${record.issueId}/live-runs`);
      const existing = live.find((run) => run.agentId === recipe.reviewerAgentId
        && ["queued", "running"].includes(run.status)
        && Date.parse(run.createdAt) >= Date.parse(record.finishedAt));
      if (existing) {
        record.reviewerWakeup = "already_scheduled";
        record.reviewerRunId = existing.id;
      }
    }
  } else record.reviewerWakeup = "not_requested";
  if (!["accepted", "already_scheduled"].includes(record.reviewerWakeup)) {
    const message = `${marker} QA handoff: ${record.reviewerWakeup}. This wake request did not confirm a QA run. Check the linked task before retrying; the host command will not be repeated.`;
    if (!comments.some((comment) => comment.body === message)) {
      await request(`/issues/${record.issueId}/comments`, { body: message, notifyAgents: false });
    }
  }
  if (recipe.recoveryAgentId && (record.status !== "succeeded" || record.missingArtifacts?.length
    || !["accepted", "already_scheduled"].includes(record.reviewerWakeup))) {
    const recovery = await request(`/companies/${recipe.companyId}/issues`, {
      projectId: recipe.projectId, assigneeAgentId: recipe.recoveryAgentId, status: "todo",
      title: "Restore managed execution or review delivery",
      description: `Restore the specific gap for /issues/${record.issueId}. Execution ${record.executionId} is ${record.status}; missing artifacts: ${(record.missingArtifacts ?? []).join(", ") || "none"}; review handoff: ${record.reviewerWakeup}. Inspect existing receipts and originals first. Do not replay the approved command or clear unrelated holds. Return evidence to the original task and resume its original reviewer under normal task permissions. Escalate only a concrete authority gap with an actionable approval link.`,
      idempotencyKey: `managed-host-recovery:${record.executionId}`,
    });
    if (!uuid.test(recovery.id) || recovery.companyId !== recipe.companyId || recovery.projectId !== recipe.projectId) throw new Error("Recovery assignment not confirmed");
    record.recoveryIssueId = recovery.id;
  }
  record.deliveredAt = new Date().toISOString();
  await save(dir, record);
}

async function main() {
  const [recipeFile, state, option] = process.argv.slice(2);
  if (!recipeFile || !state || (option && option !== "--watch" && option !== "--print-identity")) {
    throw new Error("Usage: node scripts/managed-host-execution.mjs <operator-recipe.json> <state-dir> [--watch|--print-identity]");
  }
  const recipe = JSON.parse(await fs.readFile(recipeFile, "utf8"));
  if (![recipe.companyId, recipe.projectId, recipe.requesterAgentId, recipe.reviewerAgentId].every((id) => uuid.test(id))
    || ![recipe.cwd, recipe.executable, state, recipeFile].every((p) => typeof p === "string" && path.isAbsolute(p))
    || !/^[a-f0-9]{64}$/.test(recipe.executableSha256)
    || !Array.isArray(recipe.args) || !recipe.args.every((arg) => typeof arg === "string")
    || (recipe.preflightArgs != null && (!Array.isArray(recipe.preflightArgs) || !recipe.preflightArgs.every((arg) => typeof arg === "string")))
    || (recipe.artifacts != null && (!Array.isArray(recipe.artifacts) || recipe.artifacts.length > 10
      || new Set(recipe.artifacts).size !== recipe.artifacts.length || !recipe.artifacts.every(validArtifact)))
    || (recipe.recoveryAgentId != null && !uuid.test(recipe.recoveryAgentId))
    || (recipe.autoAssignReviewer != null && typeof recipe.autoAssignReviewer !== "boolean")
    || !Number.isInteger(recipe.timeoutMs) || recipe.timeoutMs < 100 || recipe.timeoutMs > 1_200_000) {
    throw new Error("Invalid operator recipe");
  }
  const identity = recipeIdentity(recipe);
  if (option === "--print-identity") { console.log(JSON.stringify({ kind, recipeHash: identity })); return; }
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(state);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) throw new Error("State directory must be private and owned by the worker");
  do {
    try {
      const approvals = await api(`/companies/${recipe.companyId}/approvals?status=approved`);
      for (const approval of approvals) {
        if (!uuid.test(approval.id) || approval.payload?.kind !== kind || approval.payload.recipeHash !== identity) continue;
        try {
          const linked = await api(`/approvals/${approval.id}/issues`);
          if (linked.length !== 1 || !uuid.test(linked[0].id)) continue;
          const issue = await api(`/issues/${linked[0].id}`);
          const current = await api(`/approvals/${approval.id}`);
          const result = await processApproval({ approval: current, issues: [issue], recipe, state,
            report: (record, phase) => api(`/issues/${record.issueId}/comments`, {
              notifyAgents: false,
              body: `Managed host execution ${record.executionId} · ${phase === "preflight" ? "Checking execution environment" : "Running approved command"}.`,
            }),
            publish: (record, dir) => publishResult(record, dir, recipe) });
          console.log(approval.id, result.status);
        } catch (error) { console.error(approval.id, error.message); }
      }
    } catch (error) {
      if (option !== "--watch") throw error;
      console.error(error.message);
    }
    if (option === "--watch") await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (option === "--watch");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
