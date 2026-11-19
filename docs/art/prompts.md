# 生图提示词（交给 GPT / Midjourney / Stable Diffusion 等）

> 起草：Claude（Anthropic），按 Jacky Yao 的要求编写。设计依据见 [art-bible.md](art-bible.md)，比例依据见 [blueprints/](blueprints/)。

## 使用方法

1. **顺序**：每个资产先用 **[A] 定调图**出 2–4 张，选一张；之后的 **[B] 三视图**、**[C] 细节图**、**[D] 击杀关键帧**都要**把选中的图作为参考图**（图生图、编辑，或工具自带的角色参考功能），不要每次从零生成，否则会风格漂移。
2. **每条提示词都由三部分组成**：最前面加上 `STYLE`（共同风格），然后是该资产的段落，最后加上 `EXCLUDE`（排除项）。Stable Diffusion 一类有负面提示词框的工具，把 `EXCLUDE` 放进负面框。
3. **比例**：三视图用 3:2 或 16:9 横图；定调图用 4:5 竖图。
4. **把比例图一起给模型**：三视图时附上 `blueprints/*.svg` 导出的 PNG，说明 "match the proportions and heights of the attached blueprint"。
5. **记录**：每张选用的图都记进 [asset-manifest.json](asset-manifest.json) 的 `source` 字段（工具、日期、提示词），以便日后申报 AI 内容。本作的美术以 **CC BY-SA 3.0** 开放（见仓库的 `CREDITS.md`），所以用某个生图服务之前，先确认它的条款允许你把输出以这个许可公开。
6. **不要做的事**：
   - 不要在提示词里写任何已有作品、导演、游戏或在世画师的名字，包括 "like Kane Pixels"、"Escape the Backrooms style" 之类。点名会把结果拉向别人的设计，也会带来版权风险。
   - 生成图里的文字一律不用。标签、招牌上的字由游戏代码生成。

---

## 共同块

### STYLE（每条都放在最前面）

```
Production concept art for an original first-person horror game set in "Level 0": an endless, empty maze of
late-1990s commercial back rooms. Muted light-yellow wallpaper with a faint repeating pattern, damp brownish-beige
loop carpet, a low drop ceiling of stained acoustic tiles with rows of buzzing 2x4 fluorescent troffers, no windows.
Grounded realism, PBR-ready surfaces, slightly desaturated, warm yellow ambient light with a hint of haze, the look
of an early-2000s consumer camcorder still. Clean, readable silhouettes. Realistic proportions in metres.
```

### EXCLUDE（每条都放在最后，或放进负面提示词框）

```
No text, no letters, no numbers, no logos, no brand marks, no watermark, no signature, no UI, no frames or borders,
no cartoon or anime style, no cel shading, no outlines, no gore or exposed organs, no extra characters, no duplicate
objects, no cropped limbs, no busy background.
```

---

## 1. Howler（线缆嚎叫者）

**[A] 定调图**

```
ROLE: hero concept for the "Howler", a blind predator that hunts by sound.
SUBJECT: a creature that grew out of the ceiling cavity: its whole body is tightly twisted bundles of black and dark grey
electrical cable and flexible metal conduit, wound like sinew, with zip ties and small grey junction boxes at the joints
and broken pieces of stained acoustic ceiling tile stuck to its shoulders. It has NO eyes: the head is a gourd-shaped
knot of wire, with four ragged "listening frills" of cut wire ends and torn aluminium duct fanning out from its sides.
A vertical slit for a mouth splits the head from crown to chin; inside are rings of bare copper wire like teeth and a
cracked fluorescent starter glowing faintly. Long forearms ending in three hooked claws of bent stiff wire. Thin
reverse-knee legs with feet that splay like frayed broom ends. A loose tail of cables trails from its back.
POSE: half-crouched in a yellow corridor, head tilted toward a sound, frills raised, one claw resting on the carpet.
VIEW: three-quarter front, eye-level camera, 6 m away, partly lit by one fluorescent troffer.
GAME-SCALE READ: dark, spiky, linear silhouette against the yellow wall; the frilled eyeless head is the focal point.
TECHNICAL OUTPUT: portrait 4:5, scene background.
```

**[B] 三视图**（附上定调图和 `howler.svg`）

```
ROLE: modelling turnaround for the Howler shown in the reference image; keep identity, materials and proportions.
SUBJECT: the same cable-bundle creature in a neutral standing pose, upright, arms hanging (claws reach the knees).
Height 2.39 m to the top of the head, shoulders 0.55 m wide, hips 1.18 m high, arms 1.35 m from shoulder to claw tip.
VIEW: orthographic front, left side and back views side by side at identical scale, feet on one baseline, plus a small
fourth view of the chase pose: semi-quadrupedal lope, torso pitched forward about 40 degrees, knuckles of the long
forearms touching the floor, head low and forward.
TECHNICAL OUTPUT: landscape 16:9, flat neutral mid-grey background, even studio light, no cast shadows on the background.
LOCKS: cable-bundle anatomy, eyeless frilled head, vertical slit mouth, three wire claws, reverse-knee legs.
```

**[C] 细节图**

```
ROLE: detail sheet for texturing and modelling the Howler.
SUBJECT: close-ups of (1) the head from front and side with the vertical mouth closed and fully open, showing the copper
wire teeth rings and the cracked starter inside; (2) a hand with three hooked wire claws and zip ties; (3) a shoulder
with stuck ceiling-tile fragments; (4) a material swatch of the twisted black cable insulation with exposed copper at cut
ends.
VIEW: orthographic or three-quarter close-ups, consistent lighting.
TECHNICAL OUTPUT: landscape 3:2, neutral mid-grey background.
```

**[D] 击杀关键帧「短路」**

```
ROLE: storyboard keyframe for the first-person death scene.
SUBJECT: point of view of the victim pinned in a yellow corridor: the Howler's claws slammed into the walls at both
edges of the frame, its eyeless head hanging down into view from the top, the vertical mouth split wide open, rings of
copper wire teeth, a burst of electric sparks deep inside the mouth lighting the wire from within.
VIEW: first-person camera at 1.68 m, wide lens, the head 40 cm from the lens.
TECHNICAL OUTPUT: landscape 16:9, scene background, motion blur at the edges.
```

---

## 2. Smiler（微笑者）

**[A] 定调图**

```
ROLE: hero concept for the "Smiler", an entity you only ever see as a face in the dark.
SUBJECT: in a pitch-dark section of the yellow maze where the ceiling lights have died, a patch of darkness darker than
the dark: a soft-edged, barely visible column of black void hovering just above the carpet, dissolving into six smoky
tendrils at the bottom. At head height (about 1.95 m) two round, pupil-less, glowing white eyes and an impossibly wide
grin, wider than a human head, full of forty to sixty thin needle-like white teeth that gleam. The eyes sit slightly
deeper than the grin. Two extremely thin, many-jointed arms are folded behind it and only hinted at by faint rim light.
VIEW: eye-level, 8 m away, down a dark corridor, a single distant working troffer far behind it.
GAME-SCALE READ: almost nothing but the white eyes and grin; the body reads only as an absence.
TECHNICAL OUTPUT: portrait 4:5, scene background.
```

**[B] 三视图**（附上定调图和 `smiler.svg`）

```
ROLE: modelling turnaround for the Smiler in the reference image; keep the face design exactly.
SUBJECT: neutral hovering pose. Face centre at 1.95 m, eyes 9 cm across and 20 cm apart, grin 0.55 m wide, bottom of the
body 0.2 m above the floor, body column 0.6 m wide at the top tapering to tendrils. Show the hidden anatomy for modelling:
two arms of four long segments each, 1.6 m long, folded behind the body.
VIEW: orthographic front, left side and back views at identical scale on one baseline, plus a separate front view of
the face alone with the grin closed, wide, and wide-open, and a side view proving the eyes sit 5 cm behind the grin.
TECHNICAL OUTPUT: landscape 16:9, flat neutral mid-grey background (the body must stay readable: render it as very dark
grey with a soft rim light).
```

**[D] 击杀关键帧「熄灯」**

```
ROLE: storyboard keyframe for the first-person death scene.
SUBJECT: total darkness, the victim's own flashlight dead; filling the frame at arm's length, the Smiler's glowing white
eyes and a grin so wide it runs past both edges of the image, the teeth starting to part, the face torn by a horizontal
glitch like a damaged videotape.
VIEW: first-person camera at 1.68 m, the face 50 cm away.
TECHNICAL OUTPUT: landscape 16:9, near-black scene.
```

---

## 3. Skin-Stealer（窃皮者）

**[A] 定调图**

```
ROLE: hero concept for the "Skin-Stealer", a mimic that wears its victims.
SUBJECT: a tall (2.27 m), gaunt but heavy-shouldered humanoid whose own skin is pale yellow, almost the exact colour of
the wallpaper behind it, covered in tiny sucker-like bumps like the underside of an octopus arm. It wears pieces of
stolen human skin that do not fit: a human face worn as a mask slightly too low and rotated, so its eye holes do not line
up with the creature's own sunken white eyes behind them; a sleeve of human skin on one forearm; a patch on the chest.
The edges of the stolen skin are dried and darkened, held taut by rows of suckers along the seams, with clear, glossy,
transparent slime seeping from the joins. Behind the mask's mouth, a dark round hole. Long arms hanging to mid-thigh,
very long fingers. Its right shoulder is a raised hump. One arm still wears half a torn grey knitted cardigan sleeve.
POSE: standing very still at the end of a corridor, head tilted, mimicking the posture of the viewer.
VIEW: eye-level, 5 m away, lit by an overhead troffer.
GAME-SCALE READ: it nearly disappears into the wall colour; it reads by its wrong anatomy and the misaligned face.
TECHNICAL OUTPUT: portrait 4:5, scene background. Unsettling, implied horror, no blood (its blood is clear).
```

**[B] 三视图**（附上定调图和 `skin-stealer.svg`）

```
ROLE: modelling turnaround for the Skin-Stealer in the reference image; keep identity, colours and proportions.
SUBJECT: A-pose with arms 35 degrees from the body. Height 2.27 m, shoulders 0.62 m, hips 0.98 m, fingers 0.18 m.
Show clearly which areas are the creature's pale yellow sucker skin and which are stolen human skin (face mask, right
forearm sleeve, chest patch), and the slime along the seams.
VIEW: orthographic front, left side and back at identical scale on one baseline.
TECHNICAL OUTPUT: landscape 16:9, flat neutral mid-grey background, even light.
LOCKS: pale yellow skin with sucker texture, misaligned human face mask, sunken white eyes, dark mouth hole, raised right
shoulder, long fingers, clear slime.
```

**[C] 细节图**

```
ROLE: texturing detail sheet for the Skin-Stealer.
SUBJECT: (1) the head front and side with the mask in place and the mask slipped halfway down revealing the pale face,
sunken white eyes and dark mouth hole; (2) a hand with long fingers; (3) a close-up of a seam where stolen skin meets the
sucker skin, with clear slime; (4) flat material swatches: pale yellow sucker skin, stolen human skin, dried skin edge.
TECHNICAL OUTPUT: landscape 3:2, neutral mid-grey background.
```

**[D] 击杀关键帧「穿上你」**

```
ROLE: storyboard keyframe for the first-person death scene.
SUBJECT: two long pale yellow hands gripping both edges of the frame, the camera tilted; the Skin-Stealer's head inches
away, the stolen human face mask sliding down and peeling off to reveal the pale face, sunken white eyes and a dark round
mouth hole, clear strings of slime.
VIEW: first-person camera at 1.68 m, wide lens.
TECHNICAL OUTPUT: landscape 16:9, scene background.
```

**[E] 伪装成杏仁水**（用于 `reveal` 动画参考）

```
ROLE: animation keyframes for the disguise reveal.
SUBJECT: four frames left to right: (1) an ordinary grey metal thermos bottle standing on damp carpet, perfectly still,
a faint wet glint at its base seam; (2) the bottle split open along its seam like a shell; (3) a long pale yellow hand
and forearm unfolding out of it; (4) the full Skin-Stealer standing up to full height where the bottle stood.
VIEW: side view, same camera for all four frames.
TECHNICAL OUTPUT: landscape 16:9 strip, neutral background.
```

---

## 4. 可拾取物（一张图出一组）

```
ROLE: prop concept sheet for pickups in the yellow maze.
SUBJECT: four props, each shown front and three-quarter at true relative scale, laid out in a row:
(1) Almond Water: an unlabelled grey-painted steel thermos bottle, 41 cm tall with its cap, 20 cm wide, a screw cap with
a fold-down carry loop, two or three dents, paint chipped at the edges showing bare steel, no label at all;
(2) a VHS cassette, black plastic, clear window showing two tape reels, a blank paper label area, dusty;
(3) a chunky D-size battery, black with one bright yellow band, 18 cm tall;
(4) a small olive-drab steel ammunition can, 42 x 24 x 24 cm, side latch and folding handle, worn paint, no markings.
VIEW: orthographic-leaning product views, consistent studio light.
TECHNICAL OUTPUT: landscape 16:9, flat neutral mid-grey background.
```

## 5. 家具、门与出口门

```
ROLE: prop concept sheet for level furniture.
SUBJECT: (1) a 1990s steel office table, 1.15 x 0.72 m top at 0.78 m high, grey painted steel legs with rubber feet,
beige wood-grain laminate top with worn edges; (2) the same desk with a solid steel modesty panel across the front so a
person can hide underneath; (3) a commercial interior door, 1.3 x 2.3 m, beige painted, hollow-core, stainless kick plate,
lever handle, NO window, in a thin grey steel frame; (4) a heavy industrial steel exit door, 1.68 x 2.4 m in a dark steel
frame 2.0 x 2.55 m, push bar, rust streaks running down, a caged status beacon above the frame and a keypad box on the
left wall.
VIEW: front orthographic views at identical scale, plus one three-quarter view of each.
TECHNICAL OUTPUT: landscape 16:9, flat neutral mid-grey background.
```

## 6. 地标（四个象限各一）

```
ROLE: landmark concept sheet: four distinctive props, one per quadrant of the maze, each easy to recognise from 15 m.
SUBJECT: all late-1990s, worn, unbranded:
(1) a dark red drinks vending machine, 0.95 x 1.9 x 0.8 m, a large pale cyan glowing front panel showing blurry empty
bottle shapes, a keypad strip, a dark pickup slot;
(2) an off-white office water cooler, 1.0 m tall, with an upturned blue water bottle on top glowing faintly blue;
(3) a grey metal AV cart, 0.8 x 0.72 m, carrying a bulky CRT television whose screen glows green with static;
(4) a wall-mounted dark sign board 1.15 x 0.48 m with pink neon tubes (the tube shapes only, no readable letters).
VIEW: front and three-quarter views, each standing against a strip of yellow wallpaper with damp carpet.
TECHNICAL OUTPUT: landscape 16:9.
```

## 7. 吊顶灯盒

```
ROLE: prop concept for the ceiling light fixture, three states.
SUBJECT: a recessed 2x4 ft fluorescent troffer in an acoustic tile ceiling: white enamel frame, yellowed prismatic acrylic
lens, a few dead insects silhouetted inside. Three states side by side: fully lit, dimmed and flickering, dead and dark.
VIEW: from below, looking up, orthographic.
TECHNICAL OUTPUT: landscape 3:2.
```

## 8. 第一人称枪与手臂

```
ROLE: first-person viewmodel concept.
SUBJECT: a generic compact polymer-frame 9 mm pistol with no brand shapes or markings, a 15 cm cylindrical suppressor on a
threaded barrel, a small weapon light on the under-rail, three-dot green tritium sights; held in two hands wearing dark
work gloves, the cuffs of an olive field jacket visible at the wrists.
VIEW: (1) first-person hip view as the player sees it, lower right of frame; (2) orthographic left side view of the
pistol alone; (3) top view of the pistol alone.
TECHNICAL OUTPUT: landscape 16:9, neutral mid-grey background for (2) and (3).
```

## 9. 环境贴图参考

生成的平铺贴图一定会有接缝，只拿来当**参考**，正式贴图要在 Substance、Blender 或代码里重做，并按 3×3 平铺检查。

```
ROLE: texture reference, flat and evenly lit, seamless intent.
SUBJECT: (1) muted light-yellow wallpaper (#c4ac54 base) with an ORIGINAL faint repeating small lattice motif, low
contrast, slight water staining near the bottom; (2) damp brownish-beige loop carpet (#6e5c34) seen straight down, with
darker wet patches; (3) stained 2x4 ft fissured acoustic ceiling tiles in a grey grid (#c8c2a6 tiles, #7e7967 grid).
VIEW: straight-on, orthographic, no perspective, no lighting gradient.
TECHNICAL OUTPUT: square 1:1 for each.
```
