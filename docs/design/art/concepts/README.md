# 概念图与审查意见（2026-11-19）

> 审查：Claude（Anthropic），对照 [art-bible.md](../art-bible.md) 与 [blueprints/](../blueprints/) 逐张检查，由 Jacky Yao 定稿。
> 这些图只用作建模和贴图的**参考**，不会直接进游戏。许可：CC BY-SA 3.0，见 [CREDITS.md](../../../../CREDITS.md)。

## 来源

| 项 | 记录 |
|---|---|
| 收到的文件 | `level0_game_assets-v2.zip`，共 20 张 PNG（13.9 MB），2026-11-19 由 Jacky Yao 提供 |
| 生成方式 | AI 生图，按 [prompts.md](../prompts.md) 的对应段落 |
| 工具、模型与生成日期 | **未记录，待补**。每张都要补上，用于日后申报 AI 内容；同时确认该服务的条款允许以 CC BY-SA 3.0 公开 |
| 仓库里的版本 | 统一转成 WebP（质量 90，3.4 MB），尺寸不变；PNG 原图由 Jacky 保留 |

## 结论一览

✅ 可直接作参考　⚠️ 可用，但建模时按备注修改　❌ 要重画，或建模时大幅偏离

| 资产 | 图 | 结论 | 备注 |
|---|---|---|---|
| **Howler** | [A 定调图](howler/A_hero.webp) | ✅ | 识别特征都对：线缆身体、无眼葫芦头、四片听觉褶、竖裂嘴里的铜线圈和启辉器、肩上的吸音板碎片、接线盒 |
| | [B 三视图](howler/B_turnaround.webp) | ⚠️ | ① 膝盖是正向的，设计要逆向膝（见比例图）；② 站姿太直，接近「直立高瘦黑影」——建模时把肩前探、头放低，拉开与已有作品的距离；③ 爪子统一做 3 根 |
| | [C 细节图](howler/C_detail.webp) | ✅ | 嘴的闭合和张开两态、启辉器、断口铜线、金属软管都可以直接参考。手画成了 4 爪，按 3 爪做（骨架是 `claw_01..03`） |
| | [D 击杀「短路」](howler/D_jumpscare_short_circuit.webp) | ✅ | 与分镜一致。电弧闪光要做「减少闪烁」版本 |
| **Smiler** | [A 定调图](smiler/A_hero.webp) | ⚠️ | 只取氛围：牙齿太钝，像人类门牙；身体太实，像有躯干的人形；笑嘴没有比头宽 |
| | [B 三视图](smiler/B_turnaround.webp) | ✅ | 建模主参考：身体、折叠的长臂、须、五种脸部状态。**所有状态的牙都按张嘴那格的针状尖牙做**。图上的英文标题仅作参考，不影响 |
| | [D 击杀「熄灯」](smiler/D_jumpscare_lights_out.webp) | ⚠️ | 构图和录像带撕裂都对；牙齿改成针状尖牙；彩色撕裂要有「减少闪烁」版本 |
| **Skin-Stealer** | [A 定调图](skin-stealer/A_hero.webp) | ⚠️ | 整体最贴近原著。① 人皮接缝的红色缝线改成成排吸盘（照 C 图）；② 补上隆起的右肩；③ **人皮脸请另外雕一张通用的脸**：AI 生成的写实人脸可能碰巧像某个真人 |
| | [B 三视图](skin-stealer/B_turnaround.webp) | ⚠️ | A-pose 比例可用，备注同 A |
| | [C 细节图](skin-stealer/C_detail.webp) | ✅ | 面具在位与下滑两态（对应 `mask_slip`）、凹陷白眼、黑洞嘴、吸盘皮肤、接缝黏液、三块材质样本 |
| | [D 击杀「穿上你」](skin-stealer/D_jumpscare_wear_you.webp) | ✅ | 与分镜一致：双手扒住画面边缘，面具剥落，黏液拉丝 |
| | [E 伪装展开](skin-stealer/E_reveal.webp) | ✅ | 直接作为 `reveal` 动画的关键帧参考，也确定了杏仁水瓶的造型 |
| **可拾取物** | [杏仁水、录像带、电池、弹药箱](props/pickups.webp) | ✅ | 都符合：无标签的灰色凹痕保温瓶、标签留白的录像带、带黄环的电池、没有字样的弹药箱 |
| **家具与门** | [桌子、躲藏桌、门、出口门](props/furniture_and_doors.webp) | ✅ | 门没有窗；出口门有推杆、锈迹、护笼信号灯和键盘 |
| **地标** | [售货机、饮水机、电视推车、霓虹灯](props/landmarks.webp) | ✅ | 饮水机和霓虹灯各有两个变体，各选一个。霓虹灯管做成抽象线条，文字由代码生成 |
| **吊顶灯盒** | [亮、半坏、全灭](props/troffer_states.webp) | ✅ | 双灯管 2×4 英尺，三个状态齐全 |
| **第一人称枪** | [手枪与手臂](viewmodel/pistol_and_hands.webp) | ❌ 枪 / ✅ 手 | 这把手枪的外形几乎就是一款知名商用手枪：套筒防滑纹、握把纹理、扳机护圈都很像，正是提示词要避开的。**枪要重画或改成通用造型**；手套、袖口和握姿可以用 |
| **墙纸** | [墙纸](textures/wallpaper.webp) | ⚠️ | 菱格花纹是原创的，可以用；左边缘有一道深色接缝，不能无缝平铺。正式贴图重做时按 3×3 平铺检查 |
| **地毯** | [地毯](textures/carpet.webp) | ⚠️ | 大块湿斑画进了底图，平铺会明显重复。底图去掉湿斑，湿斑改做贴花 |
| **吊顶** | [吊顶板](textures/ceiling.webp) | ❌ | 板子错位排成了砖墙那样；真实的吊顶龙骨是对齐的网格，要重画 |

## 下一步

1. **补来源**：在上面的「来源」表里补上工具、模型和日期，或者告诉我，我来填。
2. **重画两张**：
   - 枪：用 [prompts.md](../prompts.md) 第 8 节，在末尾加一句 `an original slide shape with irregular angled cuts, a smooth grip with a simple stippled panel, a squared trigger guard`。
   - 吊顶：用第 9 节，把第 (3) 项改成 `aligned 2x4 ft grid, every tile in straight rows and columns, no offset`。
3. **开始建模**：按设计圣经的建议先做 **Skin-Stealer**，用 B 三视图加 [blueprints/skin-stealer.svg](../blueprints/skin-stealer.svg) 作参考图。注意上表里的三条修改。
