# Example petpacks

- `baobao/` — 包包 Baobao, converted from the checked-in Codex v2 atlas.
- `feifei/` — 菲菲 Feifei, converted from the checked-in Codex v2 atlas.

Each directory is a valid unpacked `.petpack` v1 bundle. It contains only a
declarative `manifest.json` and the SHA-256-pinned WebP atlas. Previews are
optional in v1 and intentionally omitted here; a runtime can use the first
`idle` frame when it needs a thumbnail.

The desktop examples use an extended `8 x 15` atlas: the original `8 x 11`
Codex-compatible rows remain intact, while four additional 8-frame rows add
head/back/tail petting and eating. A single petpack must keep one visual style,
identity, proportions, lighting, and framing across every row.

Validate or create a distributable archive from the repository root:

```powershell
node tools/petpack/cli.mjs validate petpacks/baobao
node tools/petpack/cli.mjs pack petpacks/baobao baobao.petpack
```
