# `.petpack` v1 manifest

`.petpack` is a data-only desktop-pet bundle. A bundle is either:

- a directory containing `manifest.json` and its declared assets, or
- a ZIP archive with the `.petpack` extension and the same internal layout.

The archive never contains executable code. Version 1 deliberately permits only
PNG and WebP assets. Every asset is declared with its byte size and SHA-256
digest; undeclared files, symbolic links, traversal paths, and executable file
types are rejected before import.

The authoritative contract is [petpack.v1.schema.json](./petpack.v1.schema.json).
JSON Schema covers the portable shape. The companion validator in
`tools/petpack` additionally checks cross-field references, atlas geometry,
actual image dimensions, hashes, file counts, and archive safety.

## Bundle limits

| Limit | v1 value |
| --- | ---: |
| Manifest | 256 KiB |
| Files (including manifest) | 128 |
| One file | 16 MiB |
| Total uncompressed bytes | 64 MiB |
| Image width or height | 8192 px |

`renderer.animations` is a named set of grid-atlas clips. `interactions.eventMap`
maps runtime events such as `idle`, `move-left`, or `greet` to those clips. A
runtime can ignore unknown events and fall back to `idle`; a pet bundle cannot
run scripts or request host permissions.
