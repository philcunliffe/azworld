# LLM Providers

This project supports multiple providers behind a unified interface.

## Ollama
- Configure `LLM_PROVIDER=ollama`
- Set `OLLAMA_HOST` and `OLLAMA_MODEL`
- Uses Ollama `/api/chat`
- JSON mode is requested via `format: "json"` when structured output is needed.

## OpenAI
- Configure `LLM_PROVIDER=openai`
- Set `OPENAI_API_KEY` and `OPENAI_MODEL`
- Uses OpenAI Responses API
- Prefers JSON schema / structured output when available.

## Anthropic
- Configure `LLM_PROVIDER=anthropic`
- Set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`
- Uses Anthropic Messages API with `anthropic-version`
- Uses tool-use or JSON-only prompts for structured output.
