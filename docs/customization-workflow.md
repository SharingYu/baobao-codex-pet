# 可售卖定制宠物交付闭环

交付分成三件互不绑定的商品：通用运行器、`.petpack` 宠物包、`.itempack` 道具包。包包和菲菲用于验证宠物制作闭环；起步道具盒用于验证互动与养成闭环。客户可以只购买宠物，也可以后续加购主题道具。

## 1. 客户素材与角色包

建议收集 5–10 张清晰照片和 1–3 段短视频：正脸、左右侧脸、全身、尾巴、典型花纹、常戴饰品，以及走路、回头、趴下、吃东西、被摸头/背/尾巴、扑玩具等动作。

原始素材只进入私有制作目录。公开仓库和最终 `.petpack` 只包含重绘后的透明动画资源及 manifest，不包含照片、视频、EXIF 或社交平台水印。

推荐动作基线：待机、左右移动、开心、摸头、摸背、摸尾、进食、追球/扑逗玩、等待与 16 个注视方向。每个动作应有足够帧数，并在固定单格尺寸、脚底基线和透明边界上通过视觉 QA。

```powershell
node tools/petpack/convert-codex.mjs --input pets/my-cat --output petpacks/my-cat
node tools/petpack/cli.mjs validate petpacks/my-cat
node tools/petpack/cli.mjs pack petpacks/my-cat release/petpacks/my-cat.petpack
```

运行器仍兼容标准 Codex v2 的 `192 × 208` 单格、`8 × 11` 图集，也支持 manifest 完整声明尺寸、行列、帧时长、触摸区域和动画格位的扩展图集。声明与实际图片不一致会明确拒绝，不会悄悄显示错帧。

## 2. 道具包与解锁等级

道具包可按节日、房间主题、食物偏好或联名单独销售。每件道具必须指定受限行为和 1–5 级 `unlockLevel`：

- `treat`：投放后当前宠物靠近、嗅闻并接受；
- `ball`：带重力与弹跳，宠物追逐、扑击；
- `wand`：跟随指针，宠物短距离扑玩；
- `hideout`：可进入的纸箱/小屋类藏身处。

```powershell
node tools/itempack/cli.mjs validate itempacks/starter-play-kit
node tools/itempack/cli.mjs pack itempacks/starter-play-kit release/itempacks/starter-play-kit.itempack
node tools/itempack/cli.mjs validate release/itempacks/starter-play-kit.itempack
```

运行器只解释白名单行为；道具包不能自带脚本、HTML、SVG、二进制程序或任意网络逻辑。

## 3. 客户安装与验收

1. 安装并启动 **Pet Desktop Companion**；程序为空壳，会提示导入内容包。
2. 导入客户的 `.petpack`，再导入已购买的 `.itempack`。
3. 打开“宠物”，选择显示的宠物并设置当前互动宠物。
4. 进入手掌模式，分别摸头、背、尾巴和身体，确认不同反馈。
5. 投喂一次并测试手动收起；启动每类玩具并测试替换、手动收起和自动超时。
6. 把宠物拖到普通窗口顶边，确认自动吸附、行走、跟随窗口和平台消失后的安全落下。
7. 完成亲密度加分与等级解锁；退出并重启，确认选择、位置、亲密度和开关恢复。

包 ID 不会静默覆盖。当前 Alpha 在同 ID 已安装时要求用户先显式移除旧包；移除宠物包时会保留该宠物的进度，重新导入后恢复。

## 4. 首轮验收清单

- [ ] 空壳安装器与便携版内不包含包包、菲菲或道具资源。
- [ ] 包包、菲菲 `.petpack` 可分别验证、打包、导入、选择显示和指定当前宠物。
- [ ] 起步 `.itempack` 可验证、打包、导入，锁定道具会按亲密等级解锁。
- [ ] 分部位摸摸、投喂、玩具、取消、替换和自动超时全部可用。
- [ ] 窗口顶边平台能被动吸附、行走、跟随和安全落下；关闭开关后不扫描。
- [ ] 亲密度按宠物独立保存，每日上限、冷却和等级阈值正确。
- [ ] 空白区域持续点击穿透，托盘可显示、隐藏、唤醒和退出，退出后无残留进程。
- [ ] 导入器拒绝路径穿越、符号链接、可执行内容、哈希不匹配和未声明文件。

## 5. 售后与隐私

每单保留交付清单、manifest 哈希和制作版本；不长期保留原始照片。客户确认交付或退款后 24 小时内删除活动存储中的源素材，备份最迟 30 天清除。返工只替换相应宠物包或道具包，不要求客户重装运行器，也不应清除已有位置和亲密度。

窗口平台 watcher 只处理几何矩形和进程编号；不读取标题、正文、DOM、截图、键盘输入、OCR 或 UI Automation 数据。
