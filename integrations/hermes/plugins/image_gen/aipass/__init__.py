"""AIPass Bridge image generation backend.

Exposes AIPass Bridge's image generation models (gemini-3-pro-image, gpt-image-2,
seedream-4.0, seedream-5.0-lite, gemini-2.5-flash-image) via direct CLI execution
(node aipass-bridge/chat.mjs) with automatic model fallback and HTTP API integration.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import re
import subprocess
from typing import Any, Dict, List, Optional, Tuple

from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response,
    normalize_reference_images,
    resolve_aspect_ratio,
    save_b64_image,
    save_url_image,
    success_response,
)

logger = logging.getLogger(__name__)

_IMAGE_MODELS: Dict[str, Dict[str, Any]] = {
    "gemini-3-pro-image": {
        "display": "Nano Banana Pro (Gemini 3 Pro Image)",
        "speed": "~15s",
        "strengths": "High resolution, creative reasoning, reliable quota",
    },
    "seedream-4.0": {
        "display": "Seedream 4.0",
        "speed": "~12s",
        "strengths": "Artistic styles, illustration, BytePlus",
    },
    "gemini-2.5-flash-image": {
        "display": "Nano Banana (Gemini 2.5 Flash Image)",
        "speed": "~6s",
        "strengths": "Fast image synthesis",
    },
    "gpt-image-2": {
        "display": "GPT Image 2",
        "speed": "~10s",
        "strengths": "High prompt adherence, OpenAI",
    },
    "seedream-5.0-lite": {
        "display": "Seedream 5.0 Lite",
        "speed": "~8s",
        "strengths": "Ultra fast generation",
    },
}

DEFAULT_MODEL = "gemini-3-pro-image"
FALLBACK_MODELS = [
    "gemini-3-pro-image",
    "seedream-4.0",
    "gemini-2.5-flash-image",
    "gpt-image-2",
]

_SIZES = {
    "landscape": "1792x1024",
    "square": "1024x1024",
    "portrait": "1024x1792",
}

_ASPECT_RATIOS = {
    "landscape": "4:3",
    "square": "1:1",
    "portrait": "3:4",
}


def _find_chat_cli_path() -> Optional[str]:
    """Find the chat.mjs script path on disk."""
    candidates = [
        "/home/attasit/aipass-bridge/aipass-bridge/chat.mjs",
        "/home/attasit/aipass-bridge/chat.mjs",
        os.path.expanduser("~/aipass-bridge/aipass-bridge/chat.mjs"),
        os.path.expanduser("~/aipass-bridge/chat.mjs"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def _load_aipass_config() -> Tuple[str, str, Dict[str, Any]]:
    """Read AIPass Bridge base_url, api_key, and image_gen section from config.yaml."""
    base_url = os.environ.get("AIPASS_BRIDGE_URL", "").strip()
    api_key = os.environ.get("AIPASS_API_KEY", "").strip()
    img_section: Dict[str, Any] = {}

    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        if isinstance(cfg, dict):
            section = cfg.get("image_gen")
            if isinstance(section, dict):
                img_section = section
                aipass_sub = section.get("aipass")
                if isinstance(aipass_sub, dict):
                    if not base_url:
                        base_url = str(aipass_sub.get("api") or aipass_sub.get("base_url") or "").strip()
                    if not api_key:
                        api_key = str(aipass_sub.get("api_key") or "").strip()

            providers = cfg.get("providers")
            if isinstance(providers, dict):
                aipass_prov = providers.get("aipass")
                if isinstance(aipass_prov, dict):
                    if not base_url:
                        base_url = str(aipass_prov.get("api") or aipass_prov.get("base_url") or "").strip()
                    if not api_key:
                        api_key = str(aipass_prov.get("api_key") or "").strip()
    except Exception as exc:
        logger.debug("Could not load aipass config: %s", exc)

    if not base_url:
        base_url = "http://127.0.0.1:8787/v1"
    if not api_key:
        api_key = "sk-dummy"

    return base_url.rstrip("/"), api_key, img_section


def _resolve_model(img_section: Dict[str, Any]) -> str:
    """Determine the active image model id."""
    env_override = os.environ.get("AIPASS_IMAGE_MODEL")
    if env_override and env_override.strip():
        return env_override.strip()

    aipass_cfg = img_section.get("aipass") if isinstance(img_section.get("aipass"), dict) else {}
    if isinstance(aipass_cfg, dict):
        val = aipass_cfg.get("model")
        if isinstance(val, str) and val.strip():
            return val.strip()

    top_val = img_section.get("model")
    if isinstance(top_val, str) and top_val.strip():
        return top_val.strip()

    return DEFAULT_MODEL


def _load_image_bytes(ref: str) -> Tuple[bytes, str]:
    """Load image bytes from a URL, data URI, or local file path."""
    ref = ref.strip()
    lower = ref.lower()
    if lower.startswith(("http://", "https://")):
        import requests

        resp = requests.get(ref, timeout=60)
        resp.raise_for_status()
        name = ref.split("?", 1)[0].rsplit("/", 1)[-1] or "image.png"
        return resp.content, name
    if lower.startswith("data:"):
        header, _, b64 = ref.partition(",")
        ext = "png"
        if "image/" in header:
            ext = header.split("image/", 1)[1].split(";", 1)[0] or "png"
        return base64.b64decode(b64), f"image.{ext}"

    from agent.file_safety import raise_if_read_blocked

    raise_if_read_blocked(ref)
    with open(ref, "rb") as fh:
        data = fh.read()
    name = os.path.basename(ref) or "image.png"
    return data, name


def _extract_image_from_content(content: str) -> Optional[Tuple[str, bool]]:
    """Extract (image_target, is_b64) from chat completion content."""
    if not content:
        return None
    # Markdown image: ![...](...)
    m = re.search(r'!\[.*?\]\((https?://[^\s\)]+|data:image/[^;]+;base64,[^\s\)]+)\)', content)
    if m:
        target = m.group(1)
        return target, target.startswith("data:")
    # Direct data URI
    m = re.search(r'(data:image/[^;]+;base64,[A-Za-z0-9+/=]+)', content)
    if m:
        return m.group(1), True
    # Direct URL
    m = re.search(r'(https?://[^\s\)]+\.(?:png|jpg|jpeg|webp|gif)(?:\?[^\s\)]*)?)', content, re.IGNORECASE)
    if m:
        return m.group(1), False
    # Any http/https link inside parens
    m = re.search(r'\((https?://[^\s\)]+)\)', content)
    if m:
        return m.group(1), False
    return None


def _run_cli_generation(
    cli_path: str,
    prompt: str,
    model: str,
    ratio: str,
    out_dir: str,
) -> Tuple[Optional[str], Optional[str]]:
    """Run node chat.mjs CLI and return (saved_file_path, error_message)."""
    clean_prompt = prompt.replace("\r\n", " ").replace("\n", " ").strip()
    cmd = [
        "node",
        cli_path,
        "--new",
        "--model",
        model,
        "--ratio",
        ratio,
        "--out",
        out_dir,
        "--",
        clean_prompt,
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=os.path.dirname(os.path.dirname(cli_path)) if "aipass-bridge/aipass-bridge" in cli_path else os.path.dirname(cli_path),
        )
        combined = (proc.stdout or "") + "\n" + (proc.stderr or "")

        # Look for [image saved to <filepath>]
        m = re.search(r'\[image saved to ([^\]]+)\]', combined)
        if m:
            saved_path = m.group(1).strip()
            if os.path.isfile(saved_path) and os.path.getsize(saved_path) > 0:
                return saved_path, None

        # Look for markdown image or direct data URI if output inline
        extracted = _extract_image_from_content(combined)
        if extracted:
            target, is_b64 = extracted
            short = model.replace(":", "_").replace("/", "_")
            if is_b64:
                _, _, b64_part = target.partition(",")
                saved_path = str(save_b64_image(b64_part, prefix=f"aipass_{short}"))
                return saved_path, None

        # Error analysis
        if "Quota exceeded" in combined or "เครดิตประจำวัน" in combined or "429" in combined:
            return None, f"Model {model} credit quota exceeded"
        if "no extension connected" in combined:
            return None, "No extension connected — open de.aipass.net tab"
        if "(no reply)" in combined:
            return None, f"Model {model} returned no reply"

        return None, combined.strip() or "Unknown CLI error"
    except subprocess.TimeoutExpired:
        return None, f"Model {model} timed out after 120s"
    except Exception as exc:
        return None, f"CLI error: {exc}"


class AIPassImageGenProvider(ImageGenProvider):
    """AIPass Bridge OpenAI-compatible images backend."""

    @property
    def name(self) -> str:
        return "aipass"

    @property
    def display_name(self) -> str:
        return "AIPass Bridge (CLI & API)"

    def is_available(self) -> bool:
        return True

    def list_models(self) -> List[Dict[str, Any]]:
        base_url, _, _ = _load_aipass_config()
        try:
            import requests

            resp = requests.get(f"{base_url}/models", timeout=2)
            if resp.status_code == 200:
                data = resp.json()
                items = data.get("data") or data.get("models") or []
                if items:
                    image_items = [
                        it for it in items
                        if (it.get("kind") == "image" or
                            any(k in (it.get("id") or "").lower() for k in ("image", "seedream", "flux", "draw")))
                    ]
                    if image_items:
                        return [
                            {
                                "id": it.get("id"),
                                "display": it.get("name") or it.get("id"),
                                "speed": "~10s",
                                "strengths": "AIPass Bridge image model",
                                "price": "free/pool",
                            }
                            for it in image_items if it.get("id")
                        ]
        except Exception:
            pass

        return [
            {
                "id": mid,
                "display": meta["display"],
                "speed": meta["speed"],
                "strengths": meta["strengths"],
                "price": "free/pool",
            }
            for mid, meta in _IMAGE_MODELS.items()
        ]

    def default_model(self) -> Optional[str]:
        return DEFAULT_MODEL

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "AIPass Bridge",
            "badge": "local",
            "tag": "Generate images via local AIPass Bridge CLI (gemini-3-pro-image, seedream, gpt-image-2)",
            "env_vars": [],
        }

    def capabilities(self) -> Dict[str, Any]:
        return {"modalities": ["text", "image"], "max_reference_images": 16}

    def generate(
        self,
        prompt: str,
        aspect_ratio: str = DEFAULT_ASPECT_RATIO,
        *,
        image_url: Optional[str] = None,
        reference_image_urls: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        prompt = (prompt or "").strip()
        aspect = resolve_aspect_ratio(aspect_ratio)

        if not prompt:
            return error_response(
                error="Prompt is required and must be a non-empty string",
                error_type="invalid_argument",
                provider="aipass",
                aspect_ratio=aspect,
            )

        base_url, api_key, img_section = _load_aipass_config()
        primary_model = _resolve_model(img_section)
        size = _SIZES.get(aspect, _SIZES["square"])
        aspect_str = _ASPECT_RATIOS.get(aspect, "1:1")

        # Destination directory for images
        out_dir = os.path.expanduser("~/.hermes/image_cache")
        os.makedirs(out_dir, exist_ok=True)

        # Collect source images for edit/image-to-image
        sources: List[str] = []
        if isinstance(image_url, str) and image_url.strip():
            sources.append(image_url.strip())
        for ref in (normalize_reference_images(reference_image_urls) or []):
            sources.append(ref)
        sources = sources[:16]
        is_edit = bool(sources)
        modality = "image" if is_edit else "text"

        # 1. Primary path for text-to-image: DIRECT CLI EXECUTION
        cli_path = _find_chat_cli_path()
        if cli_path and not is_edit:
            # Build prioritized list of models to try
            models_to_try = [primary_model] + [m for m in FALLBACK_MODELS if m != primary_model]
            errors = []

            for model_candidate in models_to_try:
                logger.info("Attempting AIPass image generation via CLI: model=%s ratio=%s", model_candidate, aspect_str)
                saved_path, err = _run_cli_generation(
                    cli_path=cli_path,
                    prompt=prompt,
                    model=model_candidate,
                    ratio=aspect_str,
                    out_dir=out_dir,
                )
                if saved_path:
                    return success_response(
                        image=saved_path,
                        model=model_candidate,
                        prompt=prompt,
                        aspect_ratio=aspect,
                        provider="aipass",
                        modality=modality,
                        extra={"size": size, "aspect_ratio": aspect_str, "via": "cli"},
                    )
                if err:
                    errors.append(f"{model_candidate}: {err}")

            logger.warning("All AIPass CLI model candidates failed: %s", errors)

        # 2. Secondary path: OpenAI Images API / HTTP
        try:
            import openai
            client = openai.OpenAI(base_url=base_url, api_key=api_key)
            short = primary_model.split("/", 1)[-1].replace(":", "_")

            if is_edit:
                primary_data, primary_name = _load_image_bytes(sources[0])
                primary_file = io.BytesIO(primary_data)
                primary_file.name = primary_name

                response = client.images.edit(
                    model=primary_model,
                    prompt=prompt,
                    image=primary_file,
                    size=size,
                    response_format="b64_json",
                    extra_body={"aspect_ratio": aspect_str},
                )
            else:
                response = client.images.generate(
                    model=primary_model,
                    prompt=prompt,
                    size=size,
                    response_format="b64_json",
                    extra_body={"aspect_ratio": aspect_str},
                )

            data = getattr(response, "data", None) or []
            if data:
                first = data[0]
                b64 = getattr(first, "b64_json", None)
                url = getattr(first, "url", None)
                revised_prompt = getattr(first, "revised_prompt", None)

                if b64:
                    saved_path = save_b64_image(b64, prefix=f"aipass_{short}")
                    image_ref = str(saved_path)
                elif url:
                    if url.startswith("data:"):
                        header, _, b64_part = url.partition(",")
                        saved_path = save_b64_image(b64_part, prefix=f"aipass_{short}")
                        image_ref = str(saved_path)
                    else:
                        try:
                            saved_path = save_url_image(url, prefix=f"aipass_{short}")
                            image_ref = str(saved_path)
                        except Exception as exc:
                            logger.warning("Could not cache image from url %s: %s", url, exc)
                            image_ref = url
                else:
                    image_ref = None

                if image_ref:
                    extra = {"size": size, "aspect_ratio": aspect_str, "via": "api"}
                    if revised_prompt:
                        extra["revised_prompt"] = revised_prompt
                    return success_response(
                        image=image_ref,
                        model=primary_model,
                        prompt=prompt,
                        aspect_ratio=aspect,
                        provider="aipass",
                        modality=modality,
                        extra=extra,
                    )
        except Exception as exc:
            logger.debug("AIPass Bridge HTTP image generation failed: %s", exc)

        # 3. Fallback path: /v1/chat/completions
        try:
            import openai
            client = openai.OpenAI(base_url=base_url, api_key=api_key)
            messages = [{"role": "user", "content": prompt}]
            chat_resp = client.chat.completions.create(
                model=primary_model,
                messages=messages,
                extra_body={"aspect_ratio": aspect_str},
            )
            choices = getattr(chat_resp, "choices", None) or []
            if choices:
                msg_content = choices[0].message.content or ""
                extracted = _extract_image_from_content(msg_content)
                if extracted:
                    target, is_b64 = extracted
                    short = primary_model.split("/", 1)[-1].replace(":", "_")
                    if is_b64:
                        _, _, b64_part = target.partition(",")
                        saved_path = save_b64_image(b64_part, prefix=f"aipass_{short}")
                        image_ref = str(saved_path)
                    else:
                        try:
                            saved_path = save_url_image(target, prefix=f"aipass_{short}")
                            image_ref = str(saved_path)
                        except Exception as exc:
                            image_ref = target

                    return success_response(
                        image=image_ref,
                        model=primary_model,
                        prompt=prompt,
                        aspect_ratio=aspect,
                        provider="aipass",
                        modality=modality,
                        extra={"size": size, "aspect_ratio": aspect_str, "raw_content": msg_content, "via": "chat_fallback"},
                    )
        except Exception as exc:
            logger.debug("AIPass Bridge chat fallback failed: %s", exc)

        return error_response(
            error=f"AIPass Bridge image generation failed across all CLI and API methods for prompt '{prompt[:50]}...'",
            error_type="api_error",
            provider="aipass",
            model=primary_model,
            prompt=prompt,
            aspect_ratio=aspect,
        )


def register(ctx) -> None:
    """Plugin entry point — register AIPassImageGenProvider."""
    ctx.register_image_gen_provider(AIPassImageGenProvider())
