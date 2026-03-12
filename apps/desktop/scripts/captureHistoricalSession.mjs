import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const [, , sessionKeyArg, outputPathArg] = process.argv;

if (!sessionKeyArg || !outputPathArg) {
  console.error(
    "Usage: npm run capture:reopen-session -- <sessionKey> <outputPath>"
  );
  process.exit(1);
}

const sanitize = (value) =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

const fileName = `reopened-session-${sanitize(sessionKeyArg)}.json`;
const tempArtifactPath = join(tmpdir(), "codex-session-monitor-debug", fileName);
const outputPath = resolve(outputPathArg);

if (existsSync(tempArtifactPath)) {
  rmSync(tempArtifactPath, { force: true });
}
if (existsSync(outputPath)) {
  rmSync(outputPath, { force: true });
}

const child = spawn("npm", ["run", "tauri", "--", "dev"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_REOPEN_CAPTURE_SESSION_KEY: sessionKeyArg,
    VITE_REOPEN_CAPTURE_FILE_NAME: fileName
  }
});

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error(`Timed out waiting for transcript capture at ${tempArtifactPath}`);
  process.exit(1);
}, 120_000);

const poll = setInterval(() => {
  if (!existsSync(tempArtifactPath)) {
    return;
  }

  const contents = readFileSync(tempArtifactPath, "utf8");
  clearInterval(poll);
  clearTimeout(timeout);
  child.kill("SIGTERM");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
  console.log(`Captured reopened-session transcript artifact at ${outputPath}`);
  process.exit(0);
}, 500);

child.on("exit", (code) => {
  clearInterval(poll);
  clearTimeout(timeout);
  if (existsSync(tempArtifactPath)) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, readFileSync(tempArtifactPath, "utf8"));
    console.log(`Captured reopened-session transcript artifact at ${outputPath}`);
    process.exit(0);
  }
  process.exit(code ?? 1);
});
