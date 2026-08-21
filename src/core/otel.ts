import { NodeSdk } from "@effect/opentelemetry";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { Layer, Effect } from "effect";

// Loaded via dynamic import from ./telemetry.js so CLI commands that never
// export telemetry do not pay the OpenTelemetry SDK startup cost.
export const BiodomeTelemetry = Layer.unwrap(
  Effect.sync(() => {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) return Layer.empty;

    const logExporter = new OTLPLogExporter({
      url: endpoint.replace(/\/+$/, "") + "/v1/logs",
    });

    return NodeSdk.layer(() => ({
      resource: {
        serviceName: process.env.OTEL_SERVICE_NAME || "biodome",
        serviceVersion: "0.1.0",
      },
      logRecordProcessor: [new BatchLogRecordProcessor({ exporter: logExporter })],
      loggerMergeWithExisting: true,
    }));
  }),
);
