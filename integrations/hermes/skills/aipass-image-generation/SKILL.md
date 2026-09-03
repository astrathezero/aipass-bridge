---
name: aipass-image-generation
description: "Generate images, illustrations, menu cards, posters, and visual artworks via AIPass Bridge image generation."
version: 1.0.0
author: Astra Prime
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [image-generation, creative, aipass, visual-design, art]
---

# AIPass Bridge Image Generation Directive

This skill instructs Hermes on how to generate high-quality images, photos, illustrations, menu cards, posters, and artwork using the `image_generate` tool connected to AIPass Bridge (`http://127.0.0.1:8787`).

## Trigger Conditions
Use this skill and immediately invoke `image_generate` whenever the user requests:
- Creating, generating, drawing, or rendering an image or photo (เช่น "สร้างรูป", "วาดภาพ", "เจนรูป", "draw...", "generate image of...")
- Designing visual assets like food menus, posters, wallpapers, logos, character sheets (เช่น "ทำใบเมนูอาหาร", "ออกแบบโปสเตอร์", "ทำรูปป้ายร้าน")
- Editing or modifying an existing image with a reference image.

## Execution Rules
1. **TOOL FIRST**: Never respond with plain text explanations, markdown lists, recipes, or ASCII art when an image is requested. You MUST invoke `image_generate` in the first turn.
2. **PROMPT EXPANSION**: Convert the user's intent into a rich, descriptive English prompt including:
   - Subject & Core Details (e.g., "Authentic Northern Thai food menu card for 'มาเหนือ' restaurant featuring Khao Soi, Nam Ngiao, Sai Oua")
   - Art Style & Medium (e.g., "vintage Lanna rustic aesthetic, warm earthy tones, mulberry paper texture, elegant typography layout")
   - Lighting & Atmosphere (e.g., "soft natural morning light, warm cozy ambiance, high detail, 8k resolution, professional food photography")
3. **ASPECT RATIO SELECTION**:
   - `square` (1:1) for social avatars, icons, standard square cards.
   - `portrait` (3:4) for posters, vertical menu cards, mobile wallpapers, portraits.
   - `landscape` (4:3) for wide banners, desktop wallpapers, landscape scenes.
4. **RESULT DELIVERY**:
   - The tool outputs the image path / URL.
   - Reference the image in your final response so Telegram / UI delivers the photo directly to the user.
