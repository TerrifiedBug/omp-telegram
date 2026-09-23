import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type PackResult = {
  filename: string;
  files: Array<{ path: string }>;
};

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  return stdout;
}

function productionSources(root: string): string[] {
  const sourceRoot = join(root, "src");
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        entry.name !== "lock-race-fixture.ts"
      ) {
        found.push(relative(root, absolute).replaceAll("\\", "/"));
      }
    }
  };
  visit(sourceRoot);
  return found.sort();
}

export async function packPackage(destination: string): Promise<{ tarball: string; files: string[] }> {
  mkdirSync(destination, { recursive: true });
  const stdout = await run(
    ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    REPO_ROOT,
  );
  let results: PackResult[];
  try {
    results = JSON.parse(stdout) as PackResult[];
  } catch {
    throw new Error(`npm pack did not return JSON: ${stdout.trim()}`);
  }
  const result = results[0];
  if (results.length !== 1 || !result?.filename || !Array.isArray(result.files)) {
    throw new Error("npm pack returned an unexpected artifact description");
  }
  return {
    tarball: join(destination, result.filename),
    files: result.files.map((file) => file.path.replaceAll("\\", "/")).sort(),
  };
}

export function assertPackageContents(files: string[]): void {
  const included = new Set(files);
  for (const source of productionSources(REPO_ROOT)) {
    if (!included.has(source)) throw new Error(`npm package is missing production source: ${source}`);
  }
  const forbidden = files.filter(
    (path) => path.endsWith(".test.ts") || path === "src/lock-race-fixture.ts",
  );
  if (forbidden.length > 0) throw new Error(`npm package contains source-only files: ${forbidden.join(", ")}`);
  if (!included.has("package.json")) throw new Error("npm package is missing package.json");
  if (!included.has("src/index.ts")) throw new Error("npm package is missing its extension entry point");
}

export async function extractPackage(tarball: string, destination: string): Promise<void> {
  mkdirSync(destination, { recursive: true });
  await run(["tar", "-xzf", tarball, "-C", destination, "--strip-components=1"], REPO_ROOT);
}

export async function smokeRegister(pluginDirectory: string, workspace: string): Promise<void> {
  const loader = join(workspace, "register-smoke.mjs");
  const stateDirectory = join(workspace, "state");
  const homeDirectory = join(workspace, "home");
  mkdirSync(homeDirectory, { recursive: true });
  writeFileSync(
    loader,
    `import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

globalThis.fetch = async () => { throw new Error("package smoke attempted network access"); };
const pluginDirectory = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(resolve(pluginDirectory, "package.json"), "utf8"));
const entries = manifest?.omp?.extensions;
if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0] !== "string") {
  throw new Error("packed package has no single omp extension entry");
}
// The entry comes from the packed plugin manifest, so it cannot be a static import.
const module = await import(pathToFileURL(resolve(pluginDirectory, entries[0])).href);
if (typeof module.default !== "function") throw new Error("packed extension has no default registrar");
const registered = { label: "", flags: [], tools: [], commands: [], events: [] };
const Type = new Proxy({}, { get: () => (..._args) => ({}) });
const noop = () => {};
module.default({
  typebox: { Type },
  logger: { debug: noop, info: noop, warn: noop, error: noop },
  setLabel: (label) => { registered.label = label; },
  registerFlag: (name) => { registered.flags.push(name); },
  registerTool: (tool) => { registered.tools.push(tool?.name); },
  registerCommand: (name) => { registered.commands.push(name); },
  on: (event) => { registered.events.push(event); },
  getFlag: () => false,
  getActiveTools: () => [],
  setActiveTools: async () => {},
  setModel: async () => false,
  setThinkingLevel: noop,
  getThinkingLevel: () => "off",
  sendUserMessage: noop,
});
if (registered.label !== "Telegram") throw new Error("packed extension did not set its label");
if (!registered.flags.includes("telegram")) throw new Error("packed extension did not register its flag");
if (!registered.tools.includes("telegram_send")) throw new Error("packed extension did not register telegram_send");
if (!registered.commands.includes("telegram")) throw new Error("packed extension did not register /telegram");
if (registered.events.length === 0) throw new Error("packed extension did not register lifecycle handlers");
`,
  );

  const env = {
    ...process.env,
    HOME: homeDirectory,
    XDG_CONFIG_HOME: join(homeDirectory, ".config"),
    OMP_TELEGRAM_STATE_DIR: stateDirectory,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
  };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.HERDR_ENV;
  delete env.HERDR_BIN_PATH;
  await run([process.execPath, loader, pluginDirectory], workspace, env);
}

async function main(): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), "omp-telegram-package-"));
  try {
    const artifact = await packPackage(join(temporary, "artifacts"));
    assertPackageContents(artifact.files);
    const pluginDirectory = join(temporary, "plugin");
    await extractPackage(artifact.tarball, pluginDirectory);
    await smokeRegister(pluginDirectory, temporary);
    console.log("npm package artifact loaded and registered successfully");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
