# Slack Podcast Transcript Bot (@Minion)

A Slack bot that transcribes podcasts on demand. Mention it with a URL and it handles the rest.

## Usage

```
@Minion can you transcribe this? https://example.com/podcast.mp3
```

The bot will confirm, run the transcription, and post the result as a JSON file in the channel.

## Architecture

The bot connects several services in a pipeline:

```d2
direction: right

user: 👤 Slack User
slack: Slack Platform
railway: 🚂 Railway (Bolt + TypeScript)

modal: Modal {
  vllm: ⚡ vLLM Inference\n(Qwen3-8B)
  transcribe: 🎙️ FastAPI Transcription Server
}

user -> slack: "1. @Minion <message>"
slack -> railway: "2. POST /slack/events"
railway -> modal.vllm: "3. Chat completion"
modal.vllm -> railway: "4. tool_call: create_transcript(url)"
railway -> modal.transcribe: "5. POST /api/transcribe/url"
modal.transcribe -> railway: "6. job_id"
railway -> modal.transcribe: "7. poll /api/status/:job_id"
modal.transcribe -> railway: "8. status: completed"
railway -> modal.transcribe: "9. GET /api/result/:job_id"
modal.transcribe -> railway: "10. transcript JSON"
railway -> slack: "11. files.uploadV2 (transcript)"
slack -> user: "12. 📄 transcript posted"
```

### What is Chat Completion? (Steps 3–4)

Chat completion is the core AI step. When the bot receives your message, it sends it to a large language model (LLM) — in this case Qwen3-8B running on Modal — along with a system prompt and a list of **tools** the model can call.

The model reads your message and decides what to do:
- If you're asking for a transcription and provide a URL, it returns a **tool call** — a structured instruction like `create_transcript("https://...")` rather than a plain text reply.
- If you're just chatting, it returns a plain text response.

This means the bot understands natural language instead of requiring a rigid command format. You don't need to type a specific command — the LLM figures out your intent and extracts the URL automatically.

The tool call result (step 4) is what triggers the actual transcription pipeline in steps 5–12.

## Running Locally

```bash
npm run dev
```

Requires a `.env` file with:
```
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
VLLM_API_KEY=
TRANSCRIPTION_API_KEY=
```

For local development, use [ngrok](https://ngrok.com) to expose port 3000 and set the URL in Slack's Event Subscriptions:
```
https://<your-ngrok-url>/slack/events
```

## Deployment

Deployed on [Railway](https://railway.app). Push to `main` to trigger a redeploy.

Set the same env vars in Railway's Variables tab, and point Slack's Event Subscriptions to:
```
https://<your-railway-url>/slack/events
```
