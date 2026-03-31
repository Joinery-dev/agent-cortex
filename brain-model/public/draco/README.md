# Draco Decoder — Self-Hosting

This directory is reserved for the Draco WASM decoder files required to load
Draco-compressed glTF models via `@react-three/drei`'s `<DRACOLoader>`.

## Why self-host?

Drei's default Draco loader fetches decoder WASM from a Google CDN:
`https://www.gstatic.com/draco/versioned/decoders/...`

Self-hosting eliminates the external dependency, improves load reliability,
and allows pinning to a specific Draco version.

## Setup

Copy the Draco decoder files from the `three` package:

```bash
cp node_modules/three/examples/jsm/libs/draco/* public/draco/
```

Then configure DRACOLoader in your scene:

```tsx
<DRACOLoader decoderPath="/draco/" />
```

## Files expected here

- `draco_decoder.js`
- `draco_decoder.wasm`
- `draco_wasm_wrapper.js`
