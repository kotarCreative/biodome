import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { emptyResource } from "@opentelemetry/resources"
import { Effect, Logger, Layer } from "effect"
import { BiodomeTelemetry } from "../../core/telemetry.js"
import { createFileEventStore } from "../../core/events.js"

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

describe("BiodomeTelemetry", () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir("telemetry-test")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("Effect.logInfo produces output through a custom logger", async () => {
    const messages: string[] = []
    const capturingLogger = Logger.make((options) => {
      messages.push(String(options.message[0]))
    })

    await Effect.runPromise(
      Effect.logInfo("hello from biodome").pipe(
        Effect.provide(Logger.layer([Effect.sync(() => capturingLogger)], { mergeWithExisting: false }))
      )
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe("hello from biodome")
  })

  it("Effect log levels Info and above produce correct level text", async () => {
    const levels: string[] = []
    const capturingLogger = Logger.make((options) => {
      levels.push(options.logLevel)
    })

    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logInfo("i")
        yield* Effect.logWarning("w")
        yield* Effect.logError("e")
        yield* Effect.logFatal("f")
      }).pipe(
        Effect.provide(Logger.layer([Effect.sync(() => capturingLogger)], { mergeWithExisting: false }))
      )
    )

    expect(levels).toEqual(["Info", "Warn", "Error", "Fatal"])
  })

  it("OTel SDK LoggerProvider can capture log records directly", async () => {
    const exporter = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider({
      resource: emptyResource(),
      processors: [new SimpleLogRecordProcessor({ exporter })],
    })
    const otelLogger = provider.getLogger("test")

    otelLogger.emit({
      body: "otel log record",
      severityText: "Info",
      severityNumber: SeverityNumber.INFO,
      timestamp: [0, 0],
      observedTimestamp: [0, 0],
      attributes: {},
    })

    const records = exporter.getFinishedLogRecords()
    expect(records).toHaveLength(1)
    expect(records[0].body).toBe("otel log record")
    expect(records[0].severityText).toBe("Info")
    expect(records[0].severityNumber).toBe(SeverityNumber.INFO)
  })

  it("bridges Effect logging through OTel in-memory exporter", async () => {
    const exporter = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider({
      resource: emptyResource(),
      processors: [new SimpleLogRecordProcessor({ exporter })],
    })
    const otelLogger = provider.getLogger("test")

    const bridgingLogger = Logger.make((options) => {
      otelLogger.emit({
        body: options.message.length === 1 ? options.message[0] : options.message,
        severityText: options.logLevel,
        severityNumber: SeverityNumber.INFO,
        timestamp: [0, 0],
        observedTimestamp: [0, 0],
        attributes: {},
      })
    })

    await Effect.runPromise(
      Effect.logInfo("bridged log").pipe(
        Effect.provide(Logger.layer([Effect.sync(() => bridgingLogger)], { mergeWithExisting: false }))
      )
    )

    const records = exporter.getFinishedLogRecords()
    expect(records).toHaveLength(1)
    expect(records[0].body).toBe("bridged log")
    expect(records[0].severityText).toBe("Info")
    expect(records[0].severityNumber).toBe(SeverityNumber.INFO)
  })

  it("captures EventStore.emit calls through bridged OTel logger", async () => {
    const exporter = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider({
      resource: emptyResource(),
      processors: [new SimpleLogRecordProcessor({ exporter })],
    })
    const otelLogger = provider.getLogger("test")

    const bridgingLogger = Logger.make((options) => {
      otelLogger.emit({
        body: options.message.length === 1 ? options.message[0] : options.message,
        severityText: options.logLevel,
        severityNumber: SeverityNumber.INFO,
        timestamp: [0, 0],
        observedTimestamp: [0, 0],
        attributes: {},
      })
    })

    const eventPath = join(dir, "events.jsonl")
    const store = createFileEventStore({ runId: "test-run", path: eventPath })

    await Effect.runPromise(
      Effect.gen(function*() {
        yield* store.emit("run.started", { command: "test", cwd: "/tmp" })
        yield* store.emit("plan.loaded", { project: "test", languages: [], services: [], processes: [] })
        yield* store.emit("run.completed", { command: "test", durationMs: 42 })
      }).pipe(
        Effect.provide(Logger.layer([Effect.sync(() => bridgingLogger)], { mergeWithExisting: false }))
      )
    )

    const records = exporter.getFinishedLogRecords()
    expect(records.length).toBeGreaterThanOrEqual(3)
    expect(records.map((r) => r.body)).toContain("event:run.started")
    expect(records.map((r) => r.body)).toContain("event:plan.loaded")
    expect(records.map((r) => r.body)).toContain("event:run.completed")

    expect(existsSync(eventPath)).toBe(true)
    const lines = readFileSync(eventPath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(3)
  })

  it("BiodomeTelemetry is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set", async () => {
    const prevEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT

    const messages: string[] = []
    const capturingLogger = Logger.make((options) => {
      messages.push(String(options.message[0]))
    })

    await Effect.runPromise(
      Effect.logInfo("no-otel log").pipe(
        Effect.provide(
          Logger.layer([Effect.sync(() => capturingLogger)], { mergeWithExisting: true })
        ),
        Effect.provide(BiodomeTelemetry)
      )
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe("no-otel log")

    if (prevEndpoint !== undefined) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prevEndpoint
    }
  })
})
