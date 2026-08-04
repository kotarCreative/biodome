export default function services(ctx) {
  ctx.addService("redis", { port: 6379 });
}
