# Vendored [threejs-vfx](https://github.com/majidmanzarpour/threejs-vfx)

Host-only GLSL ability pack used by `src/bridge/VfxBridge.ts`.

- **Not** a scene dependency. Creators never `npm install` this.
- Sandbox UI / HDR / models were stripped. Keep `src/abilities`, `src/config`, `src/effects`, `src/particles`, `src/materials`, `src/shaders`, `src/vfx`, `src/core`, `src/utils`, `src/assets`, `src/world`.
- Lazy-imported on the first `tjs.vfx:` tag. Official Explorer ignores those tags.

Refresh:

```bash
git clone --depth 1 https://github.com/majidmanzarpour/threejs-vfx.git /tmp/threejs-vfx
rsync -a --delete /tmp/threejs-vfx/src/ vendor/threejs-vfx/src/
rm -rf vendor/threejs-vfx/src/archive vendor/threejs-vfx/src/ui vendor/threejs-vfx/src/input \
  vendor/threejs-vfx/src/animation vendor/threejs-vfx/src/loaders vendor/threejs-vfx/src/postprocessing
```
