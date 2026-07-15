# Petpack tools

Dependency-free Node.js tools for `.petpack` v1. Node 20 or newer is required;
no root dependencies or install step are needed.

```powershell
# Validate a source directory or packaged archive
node tools/petpack/cli.mjs validate petpacks/baobao
node tools/petpack/cli.mjs validate dist/baobao.petpack

# Create a deterministic, store-only ZIP archive
node tools/petpack/cli.mjs pack petpacks/baobao dist/baobao.petpack

# Validate first, then import atomically into a new directory
node tools/petpack/cli.mjs import dist/baobao.petpack "$env:LOCALAPPDATA\BaoFeifei\pets\baobao"

# Convert an existing validated Codex v2 atlas
node tools/petpack/convert-codex.mjs --input pets/baobao --output petpacks/baobao

# Run security and round-trip tests
cd tools/petpack
npm test
```

The importer never evaluates bundle content. It accepts only declared PNG/WebP
assets, verifies byte sizes and SHA-256 hashes, rejects active-content file
extensions, rejects symlinks and traversal paths (including ZIP entries), applies
strict file/size/image limits, and refuses to overwrite an existing destination.

Archives use ordinary ZIP container records with a `.petpack` extension. The
reader accepts stored or deflated entries, but the packer emits deterministic
stored entries so that the implementation remains dependency-free and auditable.
