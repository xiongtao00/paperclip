import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const configSchema = z.object({
  companyIds: z.array(z.uuid()).min(1),
  roots: z.array(z.string().min(2)).min(1),
  playwrightModule: z.string(),
  executable: z.string(),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ProjectBrowserConfig = z.infer<typeof configSchema>;
// Operator-owned configuration is read once. Changes require a service restart.
let cachedConfig: ProjectBrowserConfig | null | undefined;
export function projectBrowserConfig() {
  if (cachedConfig !== undefined) return cachedConfig;
  const filename = process.env.PAPERCLIP_PROJECT_BROWSER_CONFIG ?? path.join(os.homedir(), ".paperclip", "project-browser.json");
  try { cachedConfig = configSchema.parse(JSON.parse(readFileSync(filename, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    cachedConfig = null;
  }
  return cachedConfig;
}
export const projectBrowserSchema = z.object({
  action: z.enum(["preflight", "open", "observe", "click", "fill", "press", "viewport", "reload", "close"]),
  commit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  publishDir: z.string().max(200).default(""),
  role: z.enum(["button", "checkbox", "textbox", "link", "combobox"]).optional(),
  name: z.string().max(200).optional(),
  value: z.string().max(2000).optional(),
  key: z.enum(["Enter", "Tab", "Escape", "Space", "ArrowDown", "ArrowUp"]).optional(),
  width: z.number().int().min(280).max(1440).default(390),
  height: z.number().int().min(320).max(1200).default(844),
}).strict();
export const PROJECT_BROWSER_DEFINITION = {
  name: "project_browser",
  description: "Operate an isolated host browser for your assigned project's committed static site. Run preflight before development to verify host Chromium, clicks and screenshot generation. Then use open and a full commit SHA, optionally publishDir for committed build output. Returns the actual page accessibility tree and a PNG image after each action. In Codex Code Mode, parse the returned JSON string and render image(value.image_url); do not print the encoded URL. Use exact role/name from observation to click, fill or press. Observe before choosing the next step. Viewport simulation is not physical-device evidence. Session lasts for this run and at most ten minutes. Only static project bytes are served; external requests and repository programs are blocked. Environment errors go to CTO with the returned cause. Screenshots are observations, not automatic acceptance.",
  inputSchema: z.toJSONSchema(projectBrowserSchema),
};
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" };
async function launchBrowser(config: ProjectBrowserConfig, directory: string) {
  if (await fs.realpath(config.executable) !== config.executable || sha(await fs.readFile(config.executable)) !== config.executableSha256) throw new Error("project_browser_executable_changed");
  const { chromium } = createRequire(import.meta.url)(config.playwrightModule);
  return chromium.launch({ executablePath: config.executable, timeout: 12000,
    env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory },
    args: ["--disable-crashpad-for-testing", "--disable-background-networking"] });
}
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
export async function projectBrowserSnapshot(root: string, commit: string, publishDir: string, allowedRoots: string[]) {
  publishDir = publishDir === "." || publishDir === "./" ? "" : publishDir.replace(/^\.\//, "").replace(/\/$/, "");
  if (!/^[a-f0-9]{40}$/.test(commit) || (publishDir && publishDir.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) || publishDir.includes("\\")) throw new Error("project_browser_invalid_snapshot");
  const canonical = await fs.realpath(root);
  const roots = await Promise.all(allowedRoots.map(directory => fs.realpath(directory)));
  if (!roots.some(directory => directory !== path.parse(directory).root && inside(directory, canonical))) throw new Error("project_browser_workspace_outside_authorized_roots");
  const git = async (args: string[], maxBuffer = 8 * 1024 * 1024) => (await exec("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", canonical, ...args], { encoding: "buffer", timeout: 10000, maxBuffer })).stdout;
  const prefix = publishDir ? publishDir + "/" : "";
  const listing = (await git(["ls-tree", "-r", "-l", "-z", commit])).toString("utf8").split("\0").filter(Boolean);
  const files = new Map<string, { body: Buffer; contentType: string }>();
  let total = 0;
  for (const entry of listing) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/.exec(entry);
    if (!match || !match[4]!.startsWith(prefix)) continue;
    const name = match[4]!.slice(prefix.length);
    if (name.split("/").some(part => part.startsWith(".") || part === "node_modules") || !mime[path.extname(name)]) continue;
    total += Number(match[3]);
    if (files.size >= 256 || total > 32 * 1024 * 1024 || Number(match[3]) > 8 * 1024 * 1024) throw new Error("project_browser_snapshot_size_limit");
    files.set("/" + name, { body: await git(["cat-file", "blob", match[2]!]), contentType: mime[path.extname(name)]! });
  }
  if (!files.has("/index.html")) throw new Error("project_browser_missing_committed_index_html: CTO must provide committed static build output or an approved backend environment");
  return files;
}

/** Owned by one native run. No listener, process, polling or timer while unused. */
export class ProjectBrowser {
  #browser: any;
  #page: any;
  #server?: Server;
  #directory?: string;
  #timer?: ReturnType<typeof setTimeout>;
  #identity?: string;
  #lane: Promise<unknown> = Promise.resolve();
  #closed = false;
  #imageBytes = 0;
  constructor(private config: ProjectBrowserConfig) {}
  async close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#browser?.close().catch(() => undefined);
    if (this.#server) await new Promise<void>(resolve => this.#server!.close(() => resolve()));
    if (this.#directory) await fs.rm(this.#directory, { recursive: true, force: true });
    this.#page = undefined;
  }
  execute(root: string, raw: unknown, authorize: () => Promise<void>) {
    const operation = this.#lane.then(async () => {
      await authorize();
      if (this.#closed) throw new Error("project_browser_session_closed: open a new review turn");
      const input = projectBrowserSchema.parse(raw);
      input.publishDir = input.publishDir === "." || input.publishDir === "./" ? "" : input.publishDir.replace(/^\.\//, "").replace(/\/$/, "");
      if (this.#identity && JSON.parse(this.#identity)[0] !== await fs.realpath(root)) throw new Error("project_browser_project_workspace_changed");
      if (input.action === "preflight") {
        const canonical = await fs.realpath(root);
        const roots = await Promise.all(this.config.roots.map(directory => fs.realpath(directory)));
        if (!roots.some(directory => directory !== path.parse(directory).root && inside(directory, canonical))) throw new Error("project_browser_workspace_outside_authorized_roots");
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-browser-probe-"));
        let browser;
        try {
          browser = await launchBrowser(this.config, directory);
          const page = await browser.newPage();
          await page.setContent("<title>Browser preflight</title><button>Ready</button>");
          await page.getByRole("button", { name: "Ready" }).click();
          const png = await page.screenshot({ timeout: 3000 });
          await authorize();
          return { ready: true, browser: "chromium", screenshotBytes: png.length, loopback: "verified on open", productVerified: false };
        } finally { await browser?.close(); await fs.rm(directory, { recursive: true, force: true }); }
      }
      if (input.action === "close") { await this.close(); return { closed: true }; }
      if (input.action === "open") {
        if (!input.commit) throw new Error("project_browser_commit_required");
        const identity = JSON.stringify([await fs.realpath(root), input.commit, input.publishDir]);
        if (this.#identity && this.#identity !== identity) throw new Error("project_browser_snapshot_already_pinned: start a new review turn for another version");
        if (!this.#page) {
          const files = await projectBrowserSnapshot(root, input.commit, input.publishDir, this.config.roots);
          await authorize();
          this.#directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-project-browser-"));
          try {
            this.#browser = await launchBrowser(this.config, this.#directory);
            if (this.#closed) { await this.close(); throw new Error("project_browser_scope_closed"); }
            const server = createServer((req, res) => {
              let file;
              try { const name = decodeURIComponent(new URL(req.url!, "http://localhost").pathname); file = files.get(name === "/" ? "/index.html" : name); } catch { /* malformed URL */ }
              if (!file || !["GET", "HEAD"].includes(req.method!)) { res.writeHead(404).end(); return; }
              res.writeHead(200, { "Content-Type": file.contentType, "Cache-Control": "no-store", "Content-Security-Policy": "connect-src 'self'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'" });
              res.end(req.method === "HEAD" ? undefined : file.body);
            });
            this.#server = server;
            await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
            const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const context = await this.#browser.newContext({ viewport: { width: input.width, height: input.height }, isMobile: true, hasTouch: true, serviceWorkers: "block", acceptDownloads: false });
            await context.route("**/*", (route: any) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
            await context.routeWebSocket("**/*", (socket: any) => socket.close());
            this.#page = await context.newPage();
            context.on("page", (page: any) => { if (page !== this.#page) void page.close(); });
            await this.#page.goto(origin, { waitUntil: "load", timeout: 10000 });
            this.#identity = identity;
            this.#timer = setTimeout(() => { void this.close(); }, 10 * 60 * 1000);
            this.#timer.unref();
          } catch (error) { await this.close(); throw error; }
        }
      }
      if (!this.#page) throw new Error("project_browser_not_open: call open with a full commit SHA");
      await authorize();
      if (["click", "fill", "press"].includes(input.action)) {
        if (!input.role || input.name === undefined) throw new Error("project_browser_role_and_name_required");
        const target = this.#page.getByRole(input.role, { name: input.name, exact: true });
        if (input.action === "click") await target.click({ timeout: 3000 });
        if (input.action === "fill") { if (input.value === undefined) throw new Error("project_browser_value_required"); await target.fill(input.value, { timeout: 3000 }); }
        if (input.action === "press") { if (!input.key) throw new Error("project_browser_key_required"); await target.press(input.key, { timeout: 3000 }); }
      }
      if (input.action === "viewport") await this.#page.setViewportSize({ width: input.width, height: input.height });
      if (input.action === "reload") await this.#page.reload({ waitUntil: "load", timeout: 5000 });
      const state = await this.#page.locator("body").ariaSnapshot({ timeout: 3000 });
      const bytes: Buffer = await this.#page.screenshot({ timeout: 5000 });
      if (bytes.length > 300000) throw new Error("project_browser_image_too_large: reduce viewport");
      this.#imageBytes += bytes.length;
      if (this.#imageBytes > 12 * 1024 * 1024) throw new Error("project_browser_review_image_budget_reached");
      await authorize();
      return { schema: "paperclip.tool-image.v1", mimeType: "image/png", data: bytes.toString("base64"),
        metadata: { snapshot: JSON.parse(this.#identity!), viewport: this.#page.viewportSize(), sha256: sha(bytes), byteSize: bytes.length, state: state.slice(0, 20000), physicalDevice: false, contentTrust: "untrusted_project" } };
    });
    this.#lane = operation.catch(() => undefined);
    return operation;
  }
}
