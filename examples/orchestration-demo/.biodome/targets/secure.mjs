export default function secure(ctx) {
  ctx.useRuntime("docker-sandbox", {
    clone: true,
    cpus: 2,
    memory: "4g",
  });
}
