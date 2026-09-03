# AIPass Bridge — Hermes Agent Integration

Native Image Generation Plugin and Skill for [Hermes Agent](https://hermes-agent.nousresearch.com).

This integration connects Hermes Agent directly to AIPass Bridge, enabling high-quality image generation across multiple frontier models (Nano Banana Pro / Gemini 3 Pro Image, GPT Image 2, Seedream 4.0/5.0, Gemini 2.5 Flash Image) with zero friction.

---

## 🌟 Key Features

1. **Dual-Path Generation Pipeline:**
   - **Primary Path (Direct CLI):** Executes `node chat.mjs` directly with optimized arguments (`--ratio`, `--out`), providing maximum reliability and instantaneous disk file saving.
   - **Secondary Path (OpenAI Images API):** Calls `POST /v1/images/generations` or `POST /v1/images/edits` on the local bridge (`http://127.0.0.1:8787`).
   - **Fallback Path (Chat Completions):** Automatically parses markdown / base64 image outputs from standard chat endpoints.
2. **Automatic Model Failover:**
   - If the primary model hits credit quota (`429`) or errors, the plugin automatically cycles through fallback candidates (`gemini-3-pro-image` ➔ `seedream-4.0` ➔ `gemini-2.5-flash-image` ➔ `gpt-image-2`).
3. **Smart Aspect Ratio Handling:**
   - Supports `square` (1:1), `portrait` (3:4 / 1024x1792), and `landscape` (4:3 / 1792x1024).
4. **Hermes Native Tool & Skill:**
   - Integrates seamlessly with Hermes's `image_generate` tool.
   - Includes custom skill `aipass-image-generation` for automatic prompt expansion and visual design aesthetics.

---

## 📦 Directory Structure

```
integrations/hermes/
├── README.md
├── plugins/
│   └── image_gen/
│       └── aipass/
│           ├── plugin.yaml       # Plugin metadata definition
│           └── __init__.py       # AIPassImageGenProvider implementation
└── skills/
    └── aipass-image-generation/
        └── SKILL.md              # Skill & system prompt directive
```

---

## 🚀 Installation & Setup

### 1. Copy Files to Hermes Directory

Copy the plugin and skill to your active Hermes installation:

```bash
# 1. Install Plugin
mkdir -p ~/.hermes/hermes-agent/plugins/image_gen/aipass
cp -r integrations/hermes/plugins/image_gen/aipass/* ~/.hermes/hermes-agent/plugins/image_gen/aipass/

# 2. Install Skill
mkdir -p ~/.hermes/hermes-agent/skills/creative/aipass-image-generation
cp -r integrations/hermes/skills/aipass-image-generation/* ~/.hermes/hermes-agent/skills/creative/aipass-image-generation/
```

*(If using a specific profile, you can also place the skill in `~/.hermes/profiles/<profile_name>/skills/creative/aipass-image-generation/`)*

### 2. Configure `config.yaml`

In your `~/.hermes/config.yaml` (or profile `config.yaml`), set the image generation provider to `aipass`:

```yaml
image_gen:
  provider: aipass
  model: gemini-3-pro-image       # Options: gemini-3-pro-image, seedream-4.0, gpt-image-2, seedream-5.0-lite, gemini-2.5-flash-image
  aipass:
    base_url: http://127.0.0.1:8787/v1
    api_key: sk-dummy
```

### 3. Profile Directive (`SOUL.md`)

Add the following rule to your profile's `SOUL.md` to ensure the agent invokes `image_generate` whenever visual assets are requested:

```markdown
## Image Generation Directive
When the user asks to create, draw, generate an image/photo, or design visual cards (menu cards, posters, logos), you MUST invoke the `image_generate` tool immediately. Do not answer with text explanations or recipes when an image is requested.
```

---

## 🧪 Testing

Test the image generation tool directly in Hermes or via CLI:

```bash
# Test via chat.mjs CLI directly
node aipass-bridge/chat.mjs --new --model gemini-3-pro-image --ratio 3:4 --out ~/.hermes/image_cache -- "Vintage Lanna restaurant menu design"
```
