# Running NEXide on a local model

Local models cost nothing per token. Since cost is the heaviest term in `S_task` (weighted roughly 2� -  time), a subtask that a 7B model can do locally is a subtask that costs literally zero - which is the single strongest lever available. The trade is latency, and a local model is meaningfully worse at hard reasoning, so the point isn't to run everything locally. It's to run the *cheap, high-volume* work locally and keep the hosted models for planning, verification and tie-breaks.

NEXide talks to local models through [Ollama](https://ollama.com). No API key, no account.

---

## 1. Install and start Ollama

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# macOS
brew install ollama
```

Then start the server and leave it running:

```bash
ollama serve
```

It listens on `http://127.0.0.1:11434`. Check it's up:

```bash
curl http://127.0.0.1:11434/api/tags
```

A JSON object (even with an empty `models` list) means you're good. Connection refused means `ollama serve` isn't running.

## 2. Pull a model

Pull the one that matches your hardware - see the table below. If you're not sure, start here:

```bash
ollama pull qwen2.5-coder:7b
```

The tag must match the registry's `apiId` **exactly**. `qwen2.5-coder` and `qwen2.5-coder:7b` are different tags to Ollama, and NEXide asks for the exact one. If it's missing you get a clear error naming the pull command rather than a silent failure:

> `Ollama has no model "qwen2.5-coder:7b" pulled. Run: ollama pull qwen2.5-coder:7b`

### If you already installed `llama3:latest`

NEXide does not silently substitute the original Llama 3 tag. That tag is not
the registered agent model and does not provide the tool-calling template the
orchestrator needs. Pull the compatible replacement instead:

```bash
ollama pull llama3.1:8b
```

NEXide migrates the old saved model ID `ollama:llama3` to
`ollama:llama3.1-8b` when settings are loaded. The original `llama3:latest`
can remain installed, but it will not be selected for the tool-using agent
loop.

## 3. Enable it in NEXide

Open **Settings**:

1. Under **Ollama (local)**, confirm the host. It defaults to `http://127.0.0.1:11434` and you only need to change it if you're running Ollama on another machine or a non-default port.
2. Tick the model in the roster. It appears with `$0.00` pricing and a `local` tier.

That's it - no key. The router now has a zero-cost candidate and will reach for it on `simple_edit` and routine `codegen` work.

---

## Which model for which machine

The reference target for the PS is **16GB RAM / 8GB VRAM**. These sizes assume the default ~4-bit quantisation.

| Model | Total | Active | ≈RAM at Q4 | Fits the reference box? | Good for |
|---|---|---|---|---|---|
| `granite4:7b-a1b-h` | 7B | **1B** | ~4GB | Yes, comfortably - **even with no GPU** | Simple edits, verification |
| `qwen2.5-coder:7b` | 7B | dense | ~4.7GB | Yes - fits 8GB VRAM entirely | The default. Simple edits, codegen, verification |
| `gemma3:12b` | 12B | dense | ~8GB | Tight - partially on CPU | Analysis |
| `qwen2.5-coder:14b` | 14B | dense | ~9GB | Tight - spills to CPU, several� -  slower | Harder codegen, if you can wait |
| `qwen3-coder:30b` | 30B | **3B** | ~18GB | **No** - needs ~24GB | Best local coder *if* your box is bigger |

**Two things worth understanding here.**

*Active vs total parameters changes the speed, not the memory.* `granite4:7b-a1b-h` and `qwen3-coder:30b` are mixture-of-experts models: all the weights must be resident in memory, but only 1B and 3B respectively are used per token. So they're far faster than a dense model of the same footprint. `granite4:7b-a1b-h` is the one to reach for on a CPU-only machine, where a dense 7B would be painfully slow.

*Total parameters is still what decides eligibility.* All of the above are ≤80B total, so all are eligible. Don't reason from the active count - a 30B-A3B model is a 30B model as far as the rule is concerned. See the eligibility table in the [main README](../README.md#model-roster-and-eligibility).

## Context windows are set deliberately low

The registry's `contextWindow` for a local model is **not** the model's architectural maximum - `gemma3:12b` supports 128k, but the registry says 8192.

That's because the number is passed straight to Ollama as `num_ctx`, and the KV cache for the window has to fit in memory alongside the weights. A 128k window on a 12B model needs far more RAM than the reference box has.

This matters more than it sounds. Ollama does **not** error when a prompt overflows `num_ctx` - it silently drops the oldest tokens. For an agent, the oldest tokens are the system prompt and the tool definitions, so an overflow doesn't look like an error; it looks like the model mysteriously forgetting how to call tools and starting to reply in prose. Setting `num_ctx` honestly, and letting the router's context-fit filter reject an oversized subtask *before* dispatch, converts that into a visible routing rejection with a stated reason.

If you have more memory than the reference box, raising these is safe and useful - edit `contextWindow` on the relevant entry in `orchestrator/models.ts`.

## Adding a model that isn't in the registry

Add an entry to `MODEL_REGISTRY` in `orchestrator/models.ts`:

```ts
{
  id: "ollama:my-model-9b",
  apiId: "my-model:9b",        // must match `ollama pull` / `ollama list` exactly
  label: "My Model 9B (local)",
  provider: "ollama",
  paramsBTotal: 9,             // TOTAL, not active. null => treated as ineligible.
  contextWindow: 16384,        // becomes num_ctx - pick what your RAM can hold
  pricing: { inputPerM: 0, outputPerM: 0 },
  tier: "local",
  good_at: ["simple", "codegen"],
  speed: "medium",
  notes: "Why this model is here and what it's for.",
},
```

Two requirements that aren't optional:

- **The model must support tool calling.** The orchestrator drives every agent through tools (`read_file`, `propose_edit`, `run_command`, …). A model without tool support will return prose, and the run will fail confusingly. Check the model's Ollama page for a `tools` capability before adding it.
- **`paramsBTotal` must be the published total.** Leaving it `null` is not a shortcut - `checkEligibility` treats an unpublished count as ineligible on purpose, so the model simply won't appear in the roster.

Then confirm the tag really exists upstream:

```bash
npm run verify:models
```

## Troubleshooting

**`ECONNREFUSED` / provider failover fires immediately.** `ollama serve` isn't running, or the host in Settings is wrong. The dashboard's Interventions panel shows a `provider_failover` entry naming the provider.

**`Ollama has no model "<tag>" pulled`.** The tag in the registry and the tag you pulled differ. `ollama list` shows exactly what you have.

**It's extremely slow.** The model is spilling out of VRAM into system RAM. Drop to a smaller model, or to an MoE one (`granite4:7b-a1b-h`) which activates a fraction of its weights per token. `ollama ps` shows the CPU/GPU split for a loaded model.

**It stops calling tools partway through a long task.** Context overflow - the tool definitions have been pushed out. Lower `contextWindow` for that entry so the router's context-fit filter rejects oversized subtasks up front, or move that category of work to a hosted model.

**Everything routes to the local model, including planning.** That's the zero-cost bonus working as designed, but it isn't always what you want. Untick the local model for `analysis`-heavy work, or narrow its `good_at` list to `["simple"]` so the router stops offering it planning and verification work.
