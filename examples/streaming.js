import { openai, PROXY_MODEL } from "./client.js";

async function main() {
  console.log("Chat stream:");
  const chatStream = await openai.chat.completions.create({
    model: PROXY_MODEL,
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
    stream: true,
  });
  for await (const chunk of chatStream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
  }
  process.stdout.write("\n");

  console.log("Responses stream:");
  const responseStream = await openai.responses.create({
    model: PROXY_MODEL,
    input: "Say hello in one short sentence.",
    stream: true,
  });
  for await (const event of responseStream) {
    if (event.type === "response.output_text.delta" && event.delta) process.stdout.write(event.delta);
  }
  process.stdout.write("\n");
}

main().catch((error) => {
  console.error(`Streaming example failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
