import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TRANSCRIPTION_API_BASE = process.env.TRANSCRIPTION_API_BASE ?? "";
const TRANSCRIPTION_API_KEY = process.env.TRANSCRIPTION_API_KEY ?? "";

const POLL_INTERVAL_MS = 15_000;
const MAX_POLLS = 40; // 10 minutes max

const server = new Server(
  { name: "transcription-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_transcript",
      description:
        "Transcribe a podcast from a URL. Polls until complete and returns the full transcript.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Direct audio URL to transcribe" },
        },
        required: ["url"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "create_transcript") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { url } = request.params.arguments as { url: string };

  const submitRes = await fetch(`${TRANSCRIPTION_API_BASE}/api/transcribe/url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TRANSCRIPTION_API_KEY}`,
    },
    body: JSON.stringify({ url }),
  });

  if (!submitRes.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to submit job: ${submitRes.status} ${submitRes.statusText}`,
        },
      ],
    };
  }

  const job = (await submitRes.json()) as { job_id: string; status: string };
  console.error(`[mcp-server] Job submitted — id: ${job.job_id}`);

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await fetch(
      `${TRANSCRIPTION_API_BASE}/api/status/${job.job_id}`,
      { headers: { Authorization: `Bearer ${TRANSCRIPTION_API_KEY}` } }
    );
    const { status, error } = (await statusRes.json()) as {
      status: string;
      error?: string;
    };
    console.error(`[mcp-server] Poll ${i + 1}: ${status}`);

    if (status === "error") {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Transcription failed: ${error ?? "unknown error"}`,
          },
        ],
      };
    }

    if (status === "completed") {
      const resultRes = await fetch(
        `${TRANSCRIPTION_API_BASE}/api/result/${job.job_id}`,
        { headers: { Authorization: `Bearer ${TRANSCRIPTION_API_KEY}` } }
      );
      const transcript = await resultRes.json();
      return {
        isError: false,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ job_id: job.job_id, transcript }),
          },
        ],
      };
    }
  }

  return {
    isError: true,
    content: [{ type: "text" as const, text: "Transcription timed out" }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-server] Ready");
}

main().catch(console.error);
