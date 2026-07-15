# Example petpacks

- `baobao/` — 包包 Baobao, converted from the checked-in Codex v2 atlas.
- `feifei/` — 菲菲 Feifei, converted from the checked-in Codex v2 atlas.

Each directory is a valid unpacked `.petpack` v1 bundle. It contains only a
declarative `manifest.json` and the SHA-256-pinned WebP atlas. Previews are
optional in v1 and intentionally omitted here; a runtime can use the first
`idle` frame when it needs a thumbnail.

Validate or create a distributable archive from the repository root:

```powershell
node tools/petpack/cli.mjs validate petpacks/baobao
node tools/petpack/cli.mjs pack petpacks/baobao baobao.petpack
```
