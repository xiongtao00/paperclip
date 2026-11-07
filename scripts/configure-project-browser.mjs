#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: {
  "company-id": { type: "string", multiple: true }, root: { type: "string", multiple: true },
  playwright: { type: "string" }, chromium: { type: "string" }, config: { type: "string" }, apply: { type: "boolean" },
} });
if (!values["company-id"]?.length || !values.root?.length || !values.playwright || !values.chromium
  || values["company-id"].some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
  throw new Error("Required: --company-id <UUID> --root <authorized-project-parent> --playwright <absolute-module-path> --chromium <absolute-executable> [--apply]");
}
const roots = await Promise.all(values.root.map(root => fs.realpath(root)));
if (roots.some(root => root === path.parse(root).root)) throw new Error("Filesystem root cannot be authorized");
const executable = await fs.realpath(values.chromium);
const config = {
  companyIds: values["company-id"], roots, playwrightModule: await fs.realpath(values.playwright), executable,
  executableSha256: createHash("sha256").update(await fs.readFile(executable)).digest("hex"),
};
const filename = path.resolve(values.config ?? path.join(os.homedir(), ".paperclip", "project-browser.json"));
if (values.apply) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  // A second installation must not silently overwrite another company's grant.
  const existing = await fs.readFile(filename, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing && JSON.stringify(JSON.parse(existing)) !== JSON.stringify(config)) throw new Error("Existing authorization differs. Review the operator configuration before replacing it.");
  const temporary = filename + "." + randomUUID();
  await fs.writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, filename);
}
console.log(JSON.stringify({ filename, applied: values.apply === true, config }, null, 2));
