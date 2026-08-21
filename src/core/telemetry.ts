import { Effect } from "effect";

// Telemetry is active only when an OTLP endpoint is configured. The
// OpenTelemetry SDK modules are large, so they are loaded through a dynamic
// import and only when the endpoint is present; every other CLI invocation
// skips the SDK entirely.
export const provideTelemetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
    return effect;
  }
  return Effect.flatMap(
    Effect.promise(() => import("./otel.js")),
    ({ BiodomeTelemetry }) => Effect.provide(effect, BiodomeTelemetry),
  );
};
