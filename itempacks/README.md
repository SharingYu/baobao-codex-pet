# 道具包示例

这里的包是可独立交付的 `.itempack` 源目录，不会被打进桌宠运行器。

```powershell
node tools/itempack/cli.mjs validate itempacks/starter-play-kit
node tools/itempack/cli.mjs pack itempacks/starter-play-kit release/itempacks/starter-play-kit.itempack
```

`starter-play-kit` 提供一份真实可导入的食物、毛线球和纸箱小屋素材，用于验证“运行器 + 宠物包 + 道具包”分离交付。
