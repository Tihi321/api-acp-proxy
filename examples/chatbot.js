import readline from "node:readline";
import { openai, PROXY_MODEL } from "./client.js";

async function main() {
  const history = [];
  const input = process.stdin;
  const output = process.stdout;
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = readline.createInterface({ input, output, terminal });
  const prompt = () => {
    if (terminal) {
      rl.setPrompt("You: ");
      rl.prompt();
    }
  };

  console.log("Chatbot ready. Type /clear to clear history, or /exit to quit.");
  prompt();
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        console.log("Please enter a message.");
        prompt();
        continue;
      }
      if (line === "/exit" || line === "/quit") break;
      if (line === "/clear") {
        history.length = 0;
        console.log("Conversation cleared.");
        prompt();
        continue;
      }

      const messages = [...history, { role: "user", content: line }];
      try {
        const completion = await openai.chat.completions.create({ model: PROXY_MODEL, messages });
        const answer = completion.choices[0]?.message.content;
        if (!answer) throw new Error("The proxy returned an empty assistant response.");
        history.push({ role: "user", content: line }, { role: "assistant", content: answer });
        console.log(`Assistant: ${answer}`);
        prompt();
      } catch (error) {
        console.error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        prompt();
      }
    }
  } finally {
    rl.close();
  }
  console.log("Goodbye.");
}

main().catch((error) => {
  console.error(`Chatbot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
