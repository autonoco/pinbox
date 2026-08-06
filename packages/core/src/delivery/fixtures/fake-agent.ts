#!/usr/bin/env bun
// Test fixture — a fake resumable agent CLI (resume.test.ts; e2e reuses the shape).
// Appends one JSON line {argv, cwd} to $PINBOX_FAKE_AGENT_LOG on every invocation.
// $PINBOX_FAKE_AGENT_EXIT forces that exit code (the resume-refused case).
// --hang spawns a sleeping grandchild (pid written to $PINBOX_FAKE_AGENT_GRANDCHILD)
// and never exits — the process-group kill(-pid) proof target (deep-dive §1.8a).
const logPath = process.env["PINBOX_FAKE_AGENT_LOG"];
if (logPath === undefined) {
  console.error("fake-agent: PINBOX_FAKE_AGENT_LOG not set");
  process.exit(70);
}

const argv = process.argv.slice(2);
const line = `${JSON.stringify({ argv, cwd: process.cwd() })}\n`;
const log = Bun.file(logPath);
const previous = (await log.exists()) ? await log.text() : "";
await Bun.write(log, previous + line);

const forcedExit = process.env["PINBOX_FAKE_AGENT_EXIT"];
if (forcedExit !== undefined) process.exit(Number.parseInt(forcedExit, 10));

if (argv.includes("--hang")) {
  const grandchild = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
  const pidPath = process.env["PINBOX_FAKE_AGENT_GRANDCHILD"];
  if (pidPath !== undefined) await Bun.write(pidPath, String(grandchild.pid));
  await grandchild.exited; // never within the test window — the hang
}

export {}; // top-level await requires module scope
