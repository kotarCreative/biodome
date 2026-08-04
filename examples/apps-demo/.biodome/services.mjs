export default function services(ctx) {
  ctx.addService("postgres", { port: 5432 });
}
