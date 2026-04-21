import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TRANSCRIPTION_API_BASE = process.env.TRANSCRIPTION_API_BASE ?? "";
const TRANSCRIPTION_API_KEY = process.env.TRANSCRIPTION_API_KEY ?? "";
const MCP_CALLBACK_URL = process.env.MCP_CALLBACK_URL ?? "";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

function createServer() {
  const server = new Server(
    { name: "transcription-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "create_transcript",
        description:
          "Submit a podcast URL for transcription. Returns a job_id immediately; the result is delivered via webhook when complete.",
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
      body: JSON.stringify({ url, callback_url: MCP_CALLBACK_URL }),
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

    const job = (await submitRes.json()) as { job_id: string };
    console.error(`[mcp-server] Job submitted — id: ${job.job_id}`);

    return {
      isError: false,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ job_id: job.job_id }),
        },
      ],
    };
  });

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("[mcp-server] Error handling request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
  );
});

app.delete("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
  );
});

app.listen(PORT, () => console.error(`[mcp-server] Listening on port ${PORT}`));
