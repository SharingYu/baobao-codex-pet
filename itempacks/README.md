# 道具包示例

这里的包是可独立交付的 `.itempack` 源目录，不会被打进桌宠运行器。

```powershell
node tools/itempack/cli.mjs validate itempacks/starter-play-kit
node tools/itempack/cli.mjs pack itempacks/starter-play-kit release/itempacks/starter-play-kit.itempack
```

`starter-play-kit` 提供五件真实可导入素材：三文鱼零食、奶香鸡肉粒、毛线球、逗猫棒和纸箱小屋，用于验证投喂、追逐、逗玩、躲藏、解锁以及“运行器 + 宠物包 + 道具包”分离交付。
