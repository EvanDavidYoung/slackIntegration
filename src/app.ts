import { App, ExpressReceiver } from "@slack/bolt";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";

const MODEL = "Qwen/Qwen3-VL-8B-Instruct";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const llm = new OpenAI({
  baseURL: process.env.VLLM_BASE_URL,
  apiKey: process.env.VLLM_API_KEY ?? "",
});

// ---------- MCP client ----------

let mcpClient: Client;
let mcpTools: OpenAI.Chat.ChatCompletionTool[] = [];

async function initMcp() {
  const mcpServerUrl = process.env.MCP_SERVER_URL;
  if (!mcpServerUrl) throw new Error("MCP_SERVER_URL environment variable is required");

  const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl));

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

// ---------- Pending jobs (job_id → Slack context) ----------

interface SlackContext {
  channelId: string;
  threadTs: string;
  userId: string;
}

const pendingJobs = new Map<string, SlackContext>();

// ---------- Agent ----------

type AgentResult =
  | { type: "text"; content: string }
  | { type: "submitted"; jobId: string }
  | { type: "error"; message: string };

const TERMINAL_TOOLS = new Set(["create_transcript", "create_transcript_from_rss"]);
const MAX_AGENT_ITER = 10;

async function runAgent(message: string): Promise<AgentResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are a podcast assistant. You have three tools: (1) search_podcast — search for a podcast by name and get its RSS feed URL; (2) create_transcript_from_rss — transcribe an episode from an RSS feed URL; (3) create_transcript — transcribe a direct audio URL. If the user names a podcast without providing a URL, call search_podcast first, pick the best match, then call create_transcript_from_rss with the feedUrl. If the user provides a direct audio URL, call create_transcript. Otherwise, reply helpfully in plain text. /no_think",
    },
    { role: "user", content: message },
  ];

  for (let iter = 0; iter < MAX_AGENT_ITER; iter++) {
    const completion = await llm.chat.completions.create({
      model: MODEL,
      tools: mcpTools,
      tool_choice: "auto",
      messages,
    });

    const msg = completion.choices[0].message;

    if (!msg.tool_calls?.length) {
      return { type: "text", content: msg.content ?? "I'm not sure how to help with that." };
    }

    const toolCall = msg.tool_calls[0] as { id: string; function: { name: string; arguments: string } };
    const toolName = toolCall.function.name;
    const toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

    const result = await mcpClient.callTool({ name: toolName, arguments: toolArgs });
    const content = result.content as Array<{ type: string; text?: string }>;
    const resultText = content[0]?.type === "text" ? (content[0].text ?? "") : "";

    if (result.isError) {
      return { type: "error", message: resultText };
    }

    if (TERMINAL_TOOLS.has(toolName)) {
      const { job_id } = JSON.parse(resultText) as { job_id: string };
      return { type: "submitted", jobId: job_id };
    }

    messages.push(msg);
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: resultText,
    });
  }

  return { type: "error", message: "Agent reached maximum iterations without completing." };
}

// ---------- Slack ----------

const socketMode = process.env.SOCKET_MODE === "true";

let app: App;

if (socketMode) {
  app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });
} else {
  const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  });

  receiver.router.post(
    "/webhook/transcript",
    express.json(),
    async (req: express.Request, res: express.Response) => {
      const { job_id, transcript, error } = req.body as {
        job_id: string;
        transcript?: unknown;
        error?: string;
      };
      res.sendStatus(200);

      const ctx = pendingJobs.get(job_id);
      if (!ctx) {
        console.error(`[webhook] Unknown job_id: ${job_id}`);
        return;
      }
      pendingJobs.delete(job_id);

      if (error) {
        await app.client.chat.postMessage({
          channel: ctx.channelId,
          thread_ts: ctx.threadTs,
          text: `Sorry <@${ctx.userId}>, transcription failed: ${error}`,
        });
      } else {
        await app.client.files.uploadV2({
          channel_id: ctx.channelId,
          content: JSON.stringify(transcript, null, 2),
          filename: `transcript-${job_id}.json`,
          initial_comment: `Transcription complete! <@${ctx.userId}>`,
        });
      }
    }
  );

  app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver,
  });
}

app.event("app_mention", async ({ event, say }) => {
  console.log(`[request] app_mention user=${event.user} channel=${event.channel} ts=${event.ts}`);
  const userId = event.user ?? "unknown";

  const result = await runAgent(event.text);

  if (result.type === "text") {
    await say(`<@${userId}> ${result.content}`);
  } else if (result.type === "submitted") {
    pendingJobs.set(result.jobId, {
      channelId: event.channel,
      threadTs: event.ts,
      userId,
    });
    await say(`Got it! I'll notify you when the transcription is complete. <@${userId}>`);
  } else {
    await say(`Sorry <@${userId}>, something went wrong: ${result.message}`);
  }
});

// ---------- Boot ----------

async function initMcpWithRetry(maxRetries = 5, delayMs = 10000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await initMcp();
      return;
    } catch (err) {
      console.error(`[boot] MCP init attempt ${attempt}/${maxRetries} failed:`, err);
      if (attempt === maxRetries) {
        console.error("[boot] Max retries reached, exiting.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

(async () => {
  await initMcpWithRetry();
  if (socketMode) {
    await app.start();
    console.log("Bot is running in Socket Mode (dev)");
  } else {
    await app.start(PORT);
    console.log(`Bot is running on port ${PORT}!`);
  }
})();
