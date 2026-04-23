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
            language: { type: "string", description: "BCP-47 language code of the audio (e.g. 'zh' for Mandarin/Chinese, 'en' for English, 'ja' for Japanese). Infer from context if not stated." },
          },
          required: ["url"],
        },
      },
      {
        name: "search_podcast",
        description:
          "Search for podcasts by name using the iTunes Search API. Returns a list of matches with title, author, rss_url, and podcast_id. Use podcast_id with list_episodes to browse episodes, or rss_url with create_transcript_from_rss for the latest episode.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Podcast name or keywords to search for" },
            limit: { type: "number", description: "Max results to return (default 5, max 20)" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_episodes",
        description:
          "Fetch up to 50 episodes from a podcast via iTunes by podcast_id. Returns index, title, date, and audio_url per episode. Use offset=50, 100 for older episodes.",
        inputSchema: {
          type: "object",
          properties: {
            podcast_id: { type: "number", description: "iTunes collection ID from search_podcast" },
            offset: { type: "number", description: "Pagination offset (0, 50, 100). Default 0." },
          },
          required: ["podcast_id"],
        },
      },
      {
        name: "create_transcript_from_rss",
        description:
          "Transcribe an episode by position from an RSS feed. episode_index 0 = latest, 1 = second-latest, etc. Reliable for the last 20 episodes only — for older episodes use list_episodes + create_transcript instead. Returns a job_id immediately; result delivered via webhook when complete.",
        inputSchema: {
          type: "object",
          properties: {
            rss_url: { type: "string", description: "RSS feed URL of the podcast" },
            episode_index: { type: "number", description: "Episode index (0 = latest, 1 = second-latest, etc.)." },
            language: { type: "string", description: "BCP-47 language code (e.g. 'zh', 'en', 'ja'). Infer from context." },
          },
          required: ["rss_url"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    console.log(`[mcp-server] tool=${request.params.name} args=${JSON.stringify(request.params.arguments)}`);

    if (request.params.name === "create_transcript") {
      const { url, language } = request.params.arguments as { url: string; language?: string };
      const body = JSON.stringify({ url, language, callback_url: MCP_CALLBACK_URL });
      console.log(`[mcp-server] POST /api/transcribe/url body=${body}`);

      const submitRes = await fetch(`${TRANSCRIPTION_API_BASE}/api/transcribe/url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TRANSCRIPTION_API_KEY}`,
        },
        body,
      });

      if (!submitRes.ok) {
        const errorBody = await submitRes.text();
        console.error(`[mcp-server] /api/transcribe/url failed ${submitRes.status}: ${errorBody}`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed to submit job: ${submitRes.status} ${submitRes.statusText} — ${errorBody}` }],
        };
      }

      const job = (await submitRes.json()) as { job_id: string };
      console.log(`[mcp-server] Job submitted — id: ${job.job_id}`);
      return {
        isError: false,
        content: [{ type: "text" as const, text: JSON.stringify({ job_id: job.job_id }) }],
      };

    } else if (request.params.name === "search_podcast") {
      const { query, limit } = request.params.arguments as { query: string; limit?: number };
      const effectiveLimit = Math.min(limit ?? 5, 20);
      const searchUrl = `https://itunes.apple.com/search?media=podcast&entity=podcast&term=${encodeURIComponent(query)}&limit=${effectiveLimit}`;
      console.log(`[mcp-server] iTunes search: ${searchUrl}`);

      const searchRes = await fetch(searchUrl);
      if (!searchRes.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `iTunes search failed: ${searchRes.status} ${searchRes.statusText}` }],
        };
      }

      const data = (await searchRes.json()) as {
        results: Array<{ collectionId: number; collectionName: string; artistName: string; feedUrl?: string }>;
      };
      const podcasts = data.results
        .filter((r) => r.feedUrl)
        .map((r) => ({ title: r.collectionName, author: r.artistName, rss_url: r.feedUrl, podcast_id: r.collectionId }));

      console.log(`[mcp-server] search_podcast results: ${JSON.stringify(podcasts)}`);
      return {
        isError: false,
        content: [{ type: "text" as const, text: JSON.stringify(podcasts) }],
      };

    } else if (request.params.name === "list_episodes") {
      const { podcast_id, offset } = request.params.arguments as { podcast_id: number; offset?: number };
      const effectiveOffset = offset ?? 0;
      const lookupUrl = `https://itunes.apple.com/lookup?id=${podcast_id}&entity=podcastEpisode&limit=50&offset=${effectiveOffset}`;
      console.log(`[mcp-server] iTunes episode lookup: ${lookupUrl}`);

      const lookupRes = await fetch(lookupUrl);
      if (!lookupRes.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `iTunes lookup failed: ${lookupRes.status} ${lookupRes.statusText}` }],
        };
      }

      const data = (await lookupRes.json()) as {
        results: Array<{ wrapperType: string; trackName?: string; releaseDate?: string; episodeUrl?: string }>;
      };
      const episodes = data.results
        .filter((r) => r.wrapperType === "podcastEpisode")
        .map((r, i) => ({
          index: effectiveOffset + i,
          title: r.trackName ?? "",
          date: r.releaseDate ?? "",
          audio_url: r.episodeUrl ?? "",
        }));

      console.log(`[mcp-server] list_episodes offset=${effectiveOffset} count=${episodes.length}`);
      return {
        isError: false,
        content: [{ type: "text" as const, text: JSON.stringify(episodes) }],
      };

    } else if (request.params.name === "create_transcript_from_rss") {
      const { rss_url, episode_index, language } = request.params.arguments as { rss_url: string; episode_index?: number; language?: string };
      const body = JSON.stringify({ rss_url, episode_index: episode_index ?? 0, language, callback_url: MCP_CALLBACK_URL });
      console.log(`[mcp-server] POST /api/transcribe/rss body=${body}`);

      const submitRes = await fetch(`${TRANSCRIPTION_API_BASE}/api/transcribe/rss`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TRANSCRIPTION_API_KEY}`,
        },
        body,
      });

      if (!submitRes.ok) {
        const errorBody = await submitRes.text();
        console.error(`[mcp-server] /api/transcribe/rss failed ${submitRes.status}: ${errorBody}`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed to submit RSS job: ${submitRes.status} ${submitRes.statusText} — ${errorBody}` }],
        };
      }

      const job = (await submitRes.json()) as { job_id: string };
      console.log(`[mcp-server] RSS job submitted — id: ${job.job_id}`);
      return {
        isError: false,
        content: [{ type: "text" as const, text: JSON.stringify({ job_id: job.job_id }) }],
      };

    } else {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
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

app.listen(PORT, () => console.log(`[mcp-server] Listening on port ${PORT}`));
