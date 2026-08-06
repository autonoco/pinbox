// BUN-ONLY subprocess helpers shared by the spawn adapters (resume, openclaw) —
// never imported by router.ts (Workers-safety).

/**
 * Bun.which against the CURRENT process.env.PATH — Bun caches the startup environ for
 * bare-name spawn resolution and default child env, so both are passed explicitly
 * (measured: a runtime PATH prepend was ignored by Bun.which and Bun.spawn alike).
 */
export function resolveBinary(binary: string): string | null {
  return Bun.which(binary, { PATH: process.env["PATH"] ?? "" });
}

type PipedProc = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
};

/**
 * Await close, never exit (deep-dive §1.8b): drain both pipes to EOF, THEN await the
 * exit code — a probe lost 65,538 of 200,000 bytes awaiting exit alone.
 */
export async function drainToExit(proc: PipedProc): Promise<{ code: number; stderr: string }> {
  const [, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stderr: stderrText.trim() };
}
