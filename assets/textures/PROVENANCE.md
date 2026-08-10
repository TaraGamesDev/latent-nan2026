# Texture provenance — `public/textures/steel-roughness.png`

Source record for the submission's **외부 에셋 / 오픈소스 출처** section. Every number below
was measured off the files on disk on 2026-08-10; nothing here is estimated.

---

## 1. What actually ships

| | |
|---|---|
| Path | `public/textures/steel-roughness.png` |
| Size | **55,185 bytes (53.9 KiB)** |
| Format | PNG, colour type **0 — 8-bit greyscale, single channel**, non-interlaced, no ancillary chunks |
| Dimensions | 512 × 512 |
| Distinct values | 13 (quantisation step of 4 grey levels) |
| sha256 | `08b7c95b9b72486834c2b0c420a03b713c16e7140c94ddc1a6212f0ccd1ba08a` |
| Role | `roughnessMap` for the brushed-steel plate materials |

It is the **only** texture in the shipped payload. `public/textures/` contains nothing else.
(`public/models/*.glb` also sits under `public/` but is a separate deliverable, outside this record.)

PNG is already deflate-compressed, so this is the wire cost: gzipping it produces 55,243 bytes,
i.e. it does not compress further. For scale, the built bundle in `docs/assets/` is 167,240 B of
JS + 2,513 B of CSS gzipped, so this file is **+32.5 % of transfer** — which is why it had to be
one file and not four.

---

## 2. Source image — Comfy Cloud generation

Generated **2026-08-10, 08:26 UTC** on **Comfy Cloud** (`cloud.comfy.org`), driven through the
Comfy MCP `run_template` tool. No paid partner image API was involved — the run was billed as
"GPU Hours", i.e. an open-weights checkpoint executed on Comfy Cloud GPU.

**Template:** `image_z_image_turbo_int8` — the "Text to Image (Z-Image-Turbo)" workflow.

**Weights** (read out of the ComfyUI `prompt` / `workflow` chunks embedded in the render itself,
preserved at `assets/textures/steel-roughness.comfy-source.png` — not reconstructed from notes):

| Role | Checkpoint | Origin |
|---|---|---|
| Diffusion model | `z_image_turbo_int8_convrot.safetensors` | `Comfy-Org/z_image_turbo` on Hugging Face |
| Text encoder | `qwen_3_4b_fp8_mixed.safetensors` (type `lumina2`) | same repo, `split_files/text_encoders/` |
| VAE | `ae.safetensors` | same repo, `split_files/vae/` |

**Sampling:** `KSampler`, sampler `res_multistep`, scheduler `simple`, **steps 8**, **cfg 1.0**,
denoise 1.0, `ModelSamplingAuraFlow` shift 3.0, latent `EmptySD3LatentImage` 1024 × 1024.
Negative conditioning is `ConditioningZeroOut` — **no negative prompt**; this model family does
not take one.

**Seed: 771144.** Comfy `prompt_id` `48d9e9fc-f434-40df-bc27-d502257026f1`,
output `z-image-turbo_00024_.png`, 1024 × 1024 RGB.

A second seed, **20260810** (`prompt_id` `8c96790a-4127-4acb-aeff-cb622128af2c`), was generated and
**rejected**: it carried a hard vertical light band, and its brush detail measured weaker
(mean |dI/dx| 0.78 against 1.11 for seed 771144).

### Prompt, verbatim

> Extreme top-down flat macro photograph of a brushed stainless steel sheet, the metal surface
> completely fills the frame edge to edge. Fine dense horizontal brushed grain running perfectly
> straight from left to right, thousands of fine parallel satin brush lines, scattered faint
> micro-scratches, neutral mid-grey metal, uniform matte satin finish. Perfectly flat even diffuse
> studio lighting, uniform brightness across the entire image, no bright highlights, no dark
> corners, no vignetting, no glare, no reflections, no cast shadows. Perfectly perpendicular
> flat-on view with zero perspective and zero depth. A featureless continuous uniform material
> field with no panel edges, no bevels, no rivets, no bolts, no holes, no logos, no text, no
> watermark, no border. Repeating seamless tileable material swatch, PBR albedo base colour map,
> flat lit texture scan.

---

## 3. Local post-processing

All local work is first-party Python in this repository — numpy 2.2.6 and Pillow 12.0.0 under
Python 3.10. No third-party texture tool, no stock asset, no scraped texture library, no
image-editing application. Both stages are deterministic (no RNG).

### Stage 1 — `assets/textures/steel-roughness.stage1.py`

Run in the previous round (as `final_steel.py`); preserved here verbatim. It turns the raw render
into a usable, tiling signal. The raw generation was neither flat-lit nor tileable, measured rather
than assumed: **54.9 grey levels** of low-frequency lighting gradient across the frame, and a
left/right edge mismatch of **26.5** against an interior pixel step of **1.1** (≈ 24× ordinary
detail).

1. High-pass (3-pass box blur, r = 40) removes the baked lighting gradient and vignette —
   residual falls from 54.9 to 0.62 levels.
2. Centre 512 crop, **not** a downscale, so the brush lines keep their native 1–2 px crispness.
3. Grain amplified ×2.67 to std 6.5, tanh soft-limited so nothing hard-clips.
4. Made seamless by **offset-and-heal**: roll by half (tiling a rolled image is equivalent to
   tiling the original), which moves the discontinuity to the middle while the new border becomes
   content that genuinely was adjacent. The interior cross is healed against a donor field rolled
   by N/3 and local-mean matched, under a weight that is exactly 1.0 on a ±5 px plateau over the
   seam and cosine-feathers to 0 at 40 px.
5. The blend is variance-preserving (÷ √(w² + (1−w)²)), which removes the ~15 % grain-amplitude
   dip that a naive lerp of two decorrelated fields leaves ringing the seam.
6. A second high-pass with **wrap** boundaries (r = 28) flattens the residual low-frequency offset
   the heal leaves behind — legitimate because a translation-invariant filter on a torus preserves
   seamlessness.
7. Roughness derived from the de-lit luminance, z-scored and mapped through
   `0.42 − 0.12·tanh(z/1.5)`, so brighter brush lines read smoother.

Output preserved as `assets/textures/steel-roughness.zimage-source.png`
(512 × 512 L, 170,557 B, min 77 / max 137 / mean 107.15 / std 15.81,
sha256 `e9116593869553230ea479699bc188a64dc96dfbac3a8e4e8928e236e3a308c7`).

### Stage 2 — `assets/textures/steel-roughness.build.py`

Written and run in this round. It does three things and nothing else — no step invents detail:

1. **Brush-aligned low-pass.** 7 px box blur along **x only**, wrap-addressed with `np.roll`.
   Brushed steel is anisotropic by definition — the abrasive runs left to right, so variation
   *along* the brush is physically small and what the sampler put there is noise, not surface.
   This is also where most of the byte saving comes from: at a fixed quantisation step of 4,
   the blur takes the file from 97 KB to 54 KB. (The quantisation does the rest: at a fixed
   blur radius of 3, step 1 → step 4 takes it from 103 KB to 54 KB. Unblurred and unquantised
   it is 150 KB.)
2. **Re-level to the map it replaces.** `src/ui/scene.ts` builds `brushedRoughness()` on a canvas
   at runtime (fill 138, 5000 alpha-0.3 streaks at 138 ± 55). That algorithm re-implemented in
   numpy and measured — a simulation, not a browser-canvas decode — gives min 104, max 172,
   mean 138.6, std 10.9. This file is re-levelled to **mean 138.0, std 11.0** so it is a drop-in: three.js
   multiplies `roughnessMap` by `material.roughness`, so the steel material's authored 0.46 lands
   on the same effective roughness it does today. Centring the file at a "true" brushed-steel 0.42
   would silently drop the plates to 0.19 and read as chrome.
3. **Quantise** to a step of 4 grey levels (13 levels across the band) and write 8-bit greyscale.

Both operations are wrap-safe — a pointwise map cannot create a seam, and the blur is circular —
so Stage 1's verified seamlessness is *preserved*, not re-established.

`python3 assets/textures/steel-roughness.build.py` rebuilds the shipped PNG bit-for-bit.

---

## 4. Verification

**Roughness band** (the point of a metal roughness map is a narrow band; a 0–255 swing renders as
tinfoil):

| | 8-bit | as a three.js multiplier on `steel` (`roughness 0.46`) |
|---|---|---|
| min | 112 | 0.202 |
| max | 160 | 0.289 |
| mean | 138.01 | 0.249 |
| std | 11.06 | 0.020 |

The band spans 48 of 255 levels — a 19 % swing, roughly −2.4 σ … +2.0 σ — entirely inside plausible
brushed steel. For reference the runtime canvas map it replaces measures min 104 / max 172 /
mean 138.6 / std 10.9, so the swap is level-neutral by construction and changes only the grain.

**Seamlessness** — measured as the mean pixel step across the wrap against the step between
ordinary interior neighbours (1.00× means the join is indistinguishable from normal detail):

- x: wrap 1.297 vs interior 1.410 → **0.92×**
- y: wrap 10.047 vs interior 13.878 → **0.72×**

Both *below* interior variation. Confirmed visually, not just numerically: a 2 × 2 composite
(`assets/textures/steel-roughness.tile2x2.png`) and a 100 % crop centred on the four-way join,
contrast-stretched 2.2× so a seam hiding under normal contrast would show
(`assets/textures/steel-roughness.join-boost.png`). Grain runs straight through both joins; no
line, no vignette, no repeating blob.

---

## 5. What was cut, and why

The previous round produced four texture files totalling **839,675 bytes**. Three were deleted from
`public/textures/` before integration; the remaining one was rebuilt from 170,557 B to 55,185 B.
Net reduction **784,490 bytes, 93.4 %**.

| File | Was | Cut because |
|---|---|---|
| `steel-normal.png` | 402,515 B | The largest file in the set, and the set as a whole did not pay for itself: rendered under the game's exact lighting at true phone scale (390 × 780 CSS px at DPR 2), the full three-map material differed from the runtime canvas roughness map by RMSE 6.44/255 — 2.5 % of full range. On a brightness-invariant local-contrast measure the ten lines of canvas already deliver ~92 % of the surface break-up the full set achieves. |
| `steel-basecolor.png` | 130,446 B | In three.js `map` **multiplies** `material.color`. The plates are tinted `0x767f8e`; dropping a 150-grey base map on them darkens the wall ~45 % unless the material colour is also rewritten. It buys a tint problem, not a look. |
| `anodised-detail.png` | 136,157 B | A screw-head detail map. Genuinely nice at macro range, but the screws are small on a phone, and it needs a compensating `color.multiplyScalar(1/0.7369)` on every one of the 8 anodised materials to avoid desaturating the colour that **is** the game mechanic. Not worth the risk or the bytes. Exactly reproducible from `anodised-detail.build.py` + `anodised-detail.chips.npz` if that decision is ever revisited. |
| `steel-roughness.png` | 170,557 B → 55,185 B | Kept. Roughness is the one map that earns its place: at metalness 0.86 under a dim IBL (`environmentIntensity 0.34`) there is almost no diffuse response, so essentially all visible shading is the blurred environment reflection — and breaking that up is precisely what a roughness map does. |

A competing brushed-steel set generated from **Flux.2 Dev** (template `image_flux2_text_to_image`,
seed 880417) was evaluated and **not used**: it was made tileable by mirror cross-fade, which leaves
visible reflection symmetry axes through the middle of the tile, and its roughness swung the full
7–255 range. Its files stay in this directory as the working record
(`steel-albedo.png`, `steel-rough.png`, `steel-normal.png`).

The same Flux.2 Dev template (seed 71042) produced `anodised-detail.comfy-source.png`, which was
used only as a *shape library* — 66 chip silhouettes harvested by high-pass + threshold +
connected-component labelling — and never as pixels. That lineage is recorded in
`anodised-detail.build.py`.

---

## 6. Working record kept in this directory

`assets/` is not part of the shipped build. These files exist so the chain above can be audited or
re-run:

| File | What it is |
|---|---|
| `steel-roughness.comfy-source.png` | The raw 1024 × 1024 Z-Image-Turbo render, seed 771144, **with the ComfyUI workflow still embedded in its PNG metadata**. sha256 `a52435731cdfac24c6d2066c973917a9a07dbdbf92153c3ef29f72733589d6af` |
| `steel-roughness.zimage-source.png` | Stage 1 output — de-lit, seamless, pre-quantisation |
| `steel-roughness.stage1.py` | Stage 1 script (de-light, crop, offset-and-heal, roughness derivation) |
| `steel-roughness.build.py` | Stage 2 script — rebuilds the shipped PNG bit-for-bit |
| `steel-roughness.tile2x2.png`, `.join.png`, `.join-boost.png` | Seam evidence |
| `steel-basecolor.cut.png`, `steel-normal.zimage.cut.png` | The two cut Z-Image maps, archived rather than destroyed |
| `steel-albedo.png`, `steel-rough.png`, `steel-normal.png` | The rejected Flux.2 Dev set |
| `anodised-detail.*` | The cut screw-head map, its Flux.2 Dev source, and its build script |
| `compare.html`, `compare-phone.html`, `evidence-*.png` | The phone-scale comparison harness from the previous round |

---

## 7. Third-party position

- **No stock, purchased, scraped or third-party photographic texture is used anywhere in this
  project.** The single shipped bitmap derives from an image generated by an open-weights model on
  Comfy Cloud, from a prompt written for this project, and every subsequent transform is
  first-party code in this repository.
- Open-weights models used: **Z-Image-Turbo** (int8) with a **Qwen3-4B** text encoder, distributed
  via `Comfy-Org/z_image_turbo` on Hugging Face — this produced the shipped signal. **Flux.2 Dev**
  produced two source images that were evaluated and cut. Model weights themselves are not
  redistributed in this repository; only images generated from them.
- Runtime open-source dependency of the shipped build: **three.js** (`three` ^0.185.1). Build-time
  only: Vite, TypeScript, tsx.

---

## 부록 — 제출용 요약 (외부 에셋 / 오픈소스 출처)

- **배포에 포함된 외부 에셋: 이미지 1개.** `public/textures/steel-roughness.png` (512×512, 8비트
  그레이스케일 단일 채널 PNG, 55,185바이트). 3D 모델·폰트·사운드·스톡 이미지는 사용하지 않았습니다.
- **생성 경로:** Comfy Cloud에서 오픈 웨이트 모델 **Z-Image-Turbo(int8)** + **Qwen3-4B** 텍스트
  인코더로 생성(템플릿 `image_z_image_turbo_int8`, 1024×1024, 8스텝, cfg 1.0, 시드 771144,
  네거티브 프롬프트 없음). 프롬프트 전문과 `prompt_id`는 위 2절에 기록되어 있습니다. 유료 상용
  이미지 API는 사용하지 않았습니다.
- **후처리:** 조명 기울기 제거 → 512 중앙 크롭 → offset-and-heal 방식의 심리스 처리 → 브러시
  방향(가로) 저역 통과 → 8비트 13단계 양자화. 전 과정이 이 저장소의 자체 Python(numpy/Pillow)
  코드이며, `assets/textures/steel-roughness.build.py`로 동일 바이트 재생성이 가능합니다.
- **검증:** 타일 이음매 x 0.92배 / y 0.72배(내부 픽셀 변화량 대비 1.00배 미만이면 이음매 없음),
  거칠기 값 범위 112–160(평균 138.0)의 좁은 금속 대역.
- **삭제한 에셋:** 노멀맵·베이스컬러·나사머리 디테일맵 3종(총 669,118바이트)을 배포에서 제외.
  이미지 에셋 총량을 839,675바이트에서 55,185바이트로 **93.4 % 감축**했습니다.
- **런타임 오픈소스:** three.js (MIT).
