import { Context, Effect, Schema } from "effect";
import { StringDecoder } from "node:string_decoder";
import type { EventScope, EventStore } from "./events.js";
import { redactString } from "./redaction.js";
import { validateArtifactPath } from "./plan.js";

export const ACTION_EVENT_PREFIX = "BIODOME_EVENT ";
export const OUTPUT_EVENT_LIMIT = 1024 * 1024;
const LINE_LIMIT = 8192;

const ReportSchema = Schema.Struct({
  type: Schema.Literals(["progress", "check", "artifact"]),
  message: Schema.String.check(Schema.isMaxLength(4096)),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  status: Schema.optional(Schema.Literals(["passed", "failed", "blocked", "skipped"])),
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type ActionReport = typeof ReportSchema.Type;
export type OutputStream = "stdout" | "stderr";

export interface ProcessOutput {
  write(stream: OutputStream, chunk: Uint8Array): Effect.Effect<void>;
  end(stream: OutputStream): Effect.Effect<void>;
  flush(): Effect.Effect<void>;
}
export const ProcessOutput = Context.Service<ProcessOutput>("@biodome/ProcessOutput");

/** Framed, bounded and best-effort redacted output; child reports are never authority. */
export function createProcessOutput(
  store: EventStore,
  scope: EventScope,
  operation: string,
  options: { limit?: number; secrets?: readonly string[] } = {},
): ProcessOutput {
  const secrets =
    options.secrets ??
    Object.entries(process.env)
      .filter(
        ([key, value]) =>
          /password|token|secret|api.?key|credential|private.?key|access.?key|auth/i.test(key) &&
          value &&
          value.length >= 4,
      )
      .map(([, value]) => value ?? "");
  const longestSecret = Math.max(0, ...secrets.map((value) => value.length));
  const limit = options.limit ?? OUTPUT_EVENT_LIMIT;
  const state = () => ({ decoder: new StringDecoder("utf8"), pending: "", bytes: 0, dropped: 0 });
  const streams = { stdout: state(), stderr: state() };
  const redact = (text: string) =>
    redactString(
      secrets.reduce(
        (result, secret) => (secret ? result.split(secret).join("***REDACTED***") : result),
        text,
      ),
    );

  const line = (stream: OutputStream, text: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = streams[stream];
      const safe = redact(text);
      // Charge the newline too so an empty-line flood cannot bypass the cap.
      const bytes = Buffer.byteLength(safe) + 1;
      if (current.bytes + bytes > limit) {
        current.dropped += bytes;
        return;
      }
      current.bytes += bytes;
      yield* store.emit("runtime.output", { operation, stream, text: safe }, scope);
      if ((operation === "exec" || operation === "job") && safe.startsWith(ACTION_EVENT_PREFIX)) {
        try {
          const report = Schema.decodeUnknownSync(ReportSchema)(
            JSON.parse(safe.slice(ACTION_EVENT_PREFIX.length)),
          );
          if (report.path !== undefined) validateArtifactPath(report.path);
          yield* store.emit("action.report", { operation, reported: true, report }, scope);
        } catch {
          yield* store.emit(
            "action.report.invalid",
            { operation, reason: "Invalid bounded BIODOME_EVENT report" },
            scope,
          );
        }
      }
    });

  const drain = (stream: OutputStream, final: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = streams[stream];
      let newline: number;
      while ((newline = current.pending.indexOf("\n")) >= 0) {
        const value = current.pending.slice(0, newline).replace(/\r$/, "");
        current.pending = current.pending.slice(newline + 1);
        // Keep individual records bounded even for a single enormous line.
        const safe = redact(value);
        for (let i = 0; i < Math.max(1, safe.length); i += LINE_LIMIT)
          yield* line(stream, safe.slice(i, i + LINE_LIMIT));
      }
      // Retain enough lookahead not to split a known secret over output frames.
      while (current.pending.length > LINE_LIMIT + longestSecret) {
        current.pending = redact(current.pending);
        yield* line(stream, current.pending.slice(0, LINE_LIMIT));
        current.pending = current.pending.slice(LINE_LIMIT);
      }
      if (final && current.pending.length > 0) {
        const safe = redact(current.pending);
        for (let i = 0; i < safe.length; i += LINE_LIMIT)
          yield* line(stream, safe.slice(i, i + LINE_LIMIT));
        current.pending = "";
      }
    });

  return {
    write: (stream, chunk) =>
      Effect.gen(function* () {
        const current = streams[stream];
        if (current.bytes >= limit) {
          current.dropped += chunk.byteLength;
          return;
        }
        current.pending += current.decoder.write(Buffer.from(chunk));
        yield* drain(stream, false);
      }),
    end: (stream) =>
      Effect.gen(function* () {
        streams[stream].pending += streams[stream].decoder.end();
        yield* drain(stream, true);
      }),
    flush: () =>
      Effect.gen(function* () {
        for (const stream of ["stdout", "stderr"] as const) {
          yield* drain(stream, true);
          if (streams[stream].dropped > 0) {
            yield* store.emit(
              "runtime.output.truncated",
              { operation, stream, limitBytes: limit, droppedBytes: streams[stream].dropped },
              scope,
            );
            streams[stream].dropped = 0;
          }
        }
      }),
  };
}
