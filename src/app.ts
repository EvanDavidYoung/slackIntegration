import { App } from "@slack/bolt";
import OpenAI from "openai";

const TRANSCRIPTION_API_BASE = "TRANSCRIPTION_API_BASE_PLACEHOLDER";
const TRANSCRIPTION_API_KEY = process.env.TRANSCRIPTION_API_KEY ?? "";

const llm = new OpenAI({
  baseURL: "VLLM_BASE_URL_PLACEHOLDER",
  apiKey: process.env.VLLM_API_KEY ?? "",
});

const MODEL = "Qwen/Qwen3-8B";

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_transcript",
      description: "Transcribe a podcast from a URL",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Direct audio URL to transcribe" },
        },
        required: ["url"],
      },
    },
  },
];

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

async function runTranscription(
  url: string,
  userId: string,
  channel: string,
  say: (msg: string) => Promise<unknown>,
  client: App["client"]
) {
  await say(`Got it! Starting the transcription for that podcast. This may take a few minutes. <@${userId}>`);

  const response = await fetch(`${TRANSCRIPTION_API_BASE}/api/transcribe/url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TRANSCRIPTION_API_KEY}`,
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    console.error(`Transcription API error: ${response.status} ${response.statusText}`);
    await say(`Sorry <@${userId}>, I couldn't start the transcription. Please try again.`);
    return;
  }

  const job = await response.json() as { job_id: string; status: string };
  console.log(`Job submitted — id: ${job.job_id}, status: ${job.status}`);

  const POLL_INTERVAL_MS = 15_000;
  const MAX_POLLS = 40; // 10 minutes max

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const statusRes = await fetch(`${TRANSCRIPTION_API_BASE}/api/status/${job.job_id}`, {
      headers: { Authorization: `Bearer ${TRANSCRIPTION_API_KEY}` },
    });
    const { status, error } = await statusRes.json() as { status: string; error?: string };
    console.log(`Poll ${i + 1}: ${status}`);

    if (status === "error") {
      await say(`Sorry <@${userId}>, the transcription failed: ${error ?? "unknown error"}`);
      return;
    }

    if (status === "completed") {
      const resultRes = await fetch(`${TRANSCRIPTION_API_BASE}/api/result/${job.job_id}`, {
        headers: { Authorization: `Bearer ${TRANSCRIPTION_API_KEY}` },
      });
      const result = await resultRes.json();
      await client.files.uploadV2({
        channel_id: channel,
        content: JSON.stringify(result, null, 2),
        filename: `transcript-${job.job_id}.json`,
        initial_comment: `Transcription complete! <@${userId}>`,
      });
      return;
    }
  }

  await say(`Sorry <@${userId}>, the transcription timed out. Try again later.`);
}

app.event("app_mention", async ({ event, say, client }) => {
  const completion = await llm.chat.completions.create({
    model: MODEL,
    tools: TOOLS,
    tool_choice: "auto",
    messages: [
      {
        role: "system",
        content: "You are a podcast assistant. If the user provides a URL and asks for a transcript, call the create_transcript tool. Otherwise, reply helpfully in plain text.",
      },
      { role: "user", content: event.text },
    ],
  });

  const message = completion.choices[0].message;

  // LLM wants to call a tool
  if (message.tool_calls?.length) {
    const toolCall = message.tool_calls[0];
    if (toolCall.type === "function" && toolCall.function.name === "create_transcript") {
      const { url } = JSON.parse(toolCall.function.arguments) as { url: string };
      await runTranscription(url, event.user ?? "unknown", event.channel, say, client);
      return;
    }
  }

  // Plain text reply
  const reply = message.content ?? "I'm not sure how to help with that.";
  await say(`<@${event.user}> ${reply}`);
});

(async () => {
  await app.start(PORT);
  console.log(`Bot is running on port ${PORT}!`);
})();
