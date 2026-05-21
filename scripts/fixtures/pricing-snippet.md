### Auto pricing

| Token type          | Price per 1M tokens |
| :------------------ | :------------------ |
| Input + Cache Write | $1.25               |
| Output              | $6.00               |
| Cache Read          | $0.25               |

### Model pricing

| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| ----- | -------- | ----- | ----------- | ---------- | ------ | ----- |
| [Claude 4.6 Sonnet](https://www.anthropic.com/claude/sonnet) | Anthropic | $3 | $3.75 | $0.3 | $15 | Requires Max Mode on request-based plans; Up to 1M tokens in Max Mode at the same per-token rates (no long-context surcharge) |
| [Claude 4 Sonnet 1M](https://www.anthropic.com/claude/sonnet) | Anthropic | $6 | $7.5 | $0.6 | $22.5 | The cost is 2x when the input exceeds 200k tokens |
| [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4) | OpenAI | $2.5 | - | $0.25 | $15 | 90% discount on cached input tokens; Fast mode is 15% faster with 2x pricing; Long context (Max Mode) supports up to 1M tokens with 2x input pricing |
| [Composer 2.5](https://cursor.com/blog/composer-2-5) | Cursor | $0.5 | - | $0.2 | $2.5 | - |
