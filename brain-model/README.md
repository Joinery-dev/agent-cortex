# Brain Model

An interactive 3D brain model built with React, Three.js, and React Three Fiber.

## Audience

General — designed for anyone curious about brain anatomy and function.

## What it does

Renders a navigable 3D brain where each region is selectable and reveals
descriptive content about its function. Clean, modern, purposeful.

## Tech stack

- [Vite](https://vitejs.dev/) — build tool and dev server
- [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Three.js](https://threejs.org/) — 3D rendering
- [@react-three/fiber](https://docs.pmnd.rs/react-three-fiber) — React renderer for Three.js
- [@react-three/drei](https://github.com/pmndrs/drei) — R3F helpers and abstractions

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Build

```bash
npm run build   # production build (gzip compressed)
npm run preview # preview production build locally
```

## Architecture

See [`src/REGIONS_REGISTRY.ts`](src/REGIONS_REGISTRY.ts) for the canonical
brain region data contract — this is the interface all region data implements.
