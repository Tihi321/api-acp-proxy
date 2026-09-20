import { getHealth, openai, PROXY_MODEL } from "./client.js";

async function main() {
  const health = await getHealth();
  console.log(`Health: ${health.status}`);

  const models = await openai.models.list();
  console.log(`Models: ${models.data.map((model) => model.id).join(", ")}`);

  const chat = await openai.chat.completions.create({
    model: PROXY_MODEL,
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
  });
  console.log(`Chat: ${chat.choices[0]?.message.content || ""}`);

  const response = await openai.responses.create({
    model: PROXY_MODEL,
    input: "Say hello in one short sentence.",
  });
  console.log(`Response: ${response.output_text}`);
}

main().catch((error) => {
  console.error(`Basic example failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
