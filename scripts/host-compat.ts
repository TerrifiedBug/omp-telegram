import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPackageContents, extractPackage, packPackage, smokeRegister } from "./package-smoke";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selector = process.argv[2];
if (!selector) throw new Error("usage: bun run check:host -- <exact-version|latest>");
if (selector !== "latest" && !/^\d+\.\d+\.\d+$/.test(selector)) {
  throw new Error(`host version must be an exact semver or latest, got: ${selector}`);
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${command.join(" ")} failed (${exitCode})${detail ? `:\n${detail}` : ""}`);
  }
}

const temporary = mkdtempSync(join(tmpdir(), `omp-telegram-host-${selector.replaceAll(".", "-")}-`));
try {
  const artifact = await packPackage(join(temporary, "artifacts"));
  assertPackageContents(artifact.files);
  const pluginDirectory = join(temporary, "plugin");
  await extractPackage(artifact.tarball, pluginDirectory);

  const rootPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
    overrides?: Record<string, string>;
  };
  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        scripts: { typecheck: "tsc -p tsconfig.json --noEmit" },
        devDependencies: {
          "@oh-my-pi/pi-coding-agent": selector,
          "@types/node": rootPackage.devDependencies["@types/node"],
          typescript: rootPackage.devDependencies.typescript,
        },
        overrides: rootPackage.overrides,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(temporary, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2024",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        include: ["plugin/src/**/*.ts"],
      },
      null,
      2,
    ),
  );

  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], temporary);
  const hostPackage = JSON.parse(
    readFileSync(join(temporary, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json"), "utf8"),
  ) as { version?: string };
  if (typeof hostPackage.version !== "string") throw new Error("installed omp host has no version");
  if (selector !== "latest" && hostPackage.version !== selector) {
    throw new Error(`requested omp ${selector}, but bun installed ${hostPackage.version}`);
  }

  await run([process.execPath, "run", "typecheck"], temporary);
  await smokeRegister(pluginDirectory, temporary);
  console.log(`omp host compatibility passed: requested ${selector}, resolved ${hostPackage.version}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
