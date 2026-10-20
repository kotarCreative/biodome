export default ctx => ctx.addAction({
  command: ["node", "qa.mjs"],
  intent: "Verify the frontend facade handles the selected API behavior",
  outputs: ["results/qa.json"], timeout: "30s", cleanup: "never",
});
