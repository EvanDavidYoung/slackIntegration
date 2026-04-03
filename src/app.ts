import { App } from "@slack/bolt";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";

const MODEL = "Qwen/Qwen3-8B";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const llm = new OpenAI({
  baseURL: "VLLM_BASE_URL_PLACEHOLDER",
  apiKey: process.env.VLLM_API_KEY ?? "",
});

// ---------- MCP client ----------

let mcpClient: Client;
let mcpTools: OpenAI.Chat.ChatCompletionTool[] = [];

async function initMcp() {
  const serverScript = path.resolve(__dirname, "..", "mcp-server", "server.ts");
  const tsNode = path.resolve(__dirname, "..", "node_modules", ".bin", "ts-node");

  const transport = new StdioClientTransport({
    command: tsNode,
    args: [serverScript],
    env: { ...process.env } as Record<string, string>,
  });

  mcpClient = new Client({ name: "slack-bot", version: "1.0.0" });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();
  mcpTools = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema as Record<string, unknown>,
    },
  })) as OpenAI.Chat.ChatCompletionTool[];

  console.log(`MCP ready — tools: ${tools.map((t) => t.name).join(", ")}`);
}

// ---------- Agent ----------

type AgentResult =
  | { type: "text"; content: string }
  | { type: "transcript"; jobId: string; data: unknown }
  | { type: "error"; message: string };

async function runAgent(
  message: string,
  onToolCall?: (toolName: string) => void
): Promise<AgentResult> {
  const completion = await llm.chat.completions.create({
    model: MODEL,
    tools: mcpTools,
    tool_choice: "auto",
    messages: [
      {
        role: "system",
        content:
          "You are a podcast assistant. If the user provides a URL and asks for a transcript, call the create_transcript tool. Otherwise, reply helpfully in plain text.",
      },
      { role: "user", content: message },
    ],
  });

  const msg = completion.choices[0].message;

  if (!msg.tool_calls?.length) {
    return { type: "text", content: msg.content ?? "I'm not sure how to help with that." };
  }

  const toolCall = msg.tool_calls[0] as {
    function: { name: string; arguments: string };
  };
  const toolName = toolCall.function.name;
  const toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

  onToolCall?.(toolName);

  const result = await mcpClient.callTool({ name: toolName, arguments: toolArgs });
  const content = result.content as Array<{ type: string; text?: string }>;
  const resultText = content[0]?.type === "text" ? (content[0].text ?? "") : "";

  if (result.isError) {
    return { type: "error", message: resultText };
  }

  if (toolName === "create_transcript") {
    const { job_id, transcript } = JSON.parse(resultText) as {
      job_id: string;
      transcript: unknown;
    };
    return { type: "transcript", jobId: job_id, data: transcript };
  }

  return { type: "text", content: resultText };
}

// ---------- Slack ----------

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

app.event("app_mention", async ({ event, say, client }) => {
  const userId = event.user ?? "unknown";

  const result = await runAgent(event.text, (toolName) => {
    if (toolName === "create_transcript") {
      say(`Got it! Starting the transcription. This may take a few minutes. <@${userId}>`);
    }
  });

  if (result.type === "text") {
    await say(`<@${userId}> ${result.content}`);
  } else if (result.type === "transcript") {
    await client.files.uploadV2({
      channel_id: event.channel,
      content: JSON.stringify(result.data, null, 2),
      filename: `transcript-${result.jobId}.json`,
      initial_comment: `Transcription complete! <@${userId}>`,
    });
  } else {
    await say(`Sorry <@${userId}>, something went wrong: ${result.message}`);
  }
});

// ---------- Boot ----------

(async () => {
  await initMcp();
  await app.start(PORT);
  console.log(`Bot is running on port ${PORT}!`);
})();
