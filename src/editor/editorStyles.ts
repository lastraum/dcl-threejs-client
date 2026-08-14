const STYLE_ID = 'dcl-editor-styles'

export function injectEditorStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
/*
 * Subtle transparent scrollbars on editor chrome — thin ghost track so users
 * still see “there’s more below,” without the heavy native bar.
 * Hover / active brightens the thumb; wheel / trackpad / touch still work.
 */
.editor-hub-page,
.editor-hub,
.editor-workspace,
.editor-float-flyout,
.editor-sculpt-panel,
.editor-env-box,
.editor-env-water,
.editor-space-panel,
.editor-desert-panel,
.editor-land-panel,
.editor-mountains-panel,
.editor-sculpt-viewport-box,
.editor-sculpt-shading-box,
.editor-camera-controls-popover,
.editor-hub-modal {
  scrollbar-width: thin; /* Firefox */
  scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
}
.editor-hub-page:hover,
.editor-hub:hover,
.editor-workspace:hover,
.editor-float-flyout:hover,
.editor-sculpt-panel:hover,
.editor-hub-modal:hover {
  scrollbar-color: rgba(110, 231, 183, 0.45) rgba(15, 23, 42, 0.2);
}
/* Nested scrollables inside flyouts / panels */
.editor-float-flyout *,
.editor-sculpt-panel *,
.editor-hub-modal * {
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.28) transparent;
}
.editor-float-flyout *:hover,
.editor-sculpt-panel *:hover,
.editor-hub-modal *:hover {
  scrollbar-color: rgba(110, 231, 183, 0.45) rgba(15, 23, 42, 0.2);
}
/* WebKit / Chromium */
.editor-hub-page::-webkit-scrollbar,
.editor-hub::-webkit-scrollbar,
.editor-workspace::-webkit-scrollbar,
.editor-float-flyout::-webkit-scrollbar,
.editor-sculpt-panel::-webkit-scrollbar,
.editor-env-box::-webkit-scrollbar,
.editor-env-water::-webkit-scrollbar,
.editor-space-panel::-webkit-scrollbar,
.editor-desert-panel::-webkit-scrollbar,
.editor-land-panel::-webkit-scrollbar,
.editor-mountains-panel::-webkit-scrollbar,
.editor-sculpt-viewport-box::-webkit-scrollbar,
.editor-sculpt-shading-box::-webkit-scrollbar,
.editor-camera-controls-popover::-webkit-scrollbar,
.editor-hub-modal::-webkit-scrollbar,
.editor-float-flyout *::-webkit-scrollbar,
.editor-sculpt-panel *::-webkit-scrollbar,
.editor-hub-modal *::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.editor-hub-page::-webkit-scrollbar-track,
.editor-hub::-webkit-scrollbar-track,
.editor-workspace::-webkit-scrollbar-track,
.editor-float-flyout::-webkit-scrollbar-track,
.editor-sculpt-panel::-webkit-scrollbar-track,
.editor-env-box::-webkit-scrollbar-track,
.editor-env-water::-webkit-scrollbar-track,
.editor-space-panel::-webkit-scrollbar-track,
.editor-desert-panel::-webkit-scrollbar-track,
.editor-land-panel::-webkit-scrollbar-track,
.editor-mountains-panel::-webkit-scrollbar-track,
.editor-sculpt-viewport-box::-webkit-scrollbar-track,
.editor-sculpt-shading-box::-webkit-scrollbar-track,
.editor-camera-controls-popover::-webkit-scrollbar-track,
.editor-hub-modal::-webkit-scrollbar-track,
.editor-float-flyout *::-webkit-scrollbar-track,
.editor-sculpt-panel *::-webkit-scrollbar-track,
.editor-hub-modal *::-webkit-scrollbar-track {
  background: transparent;
}
.editor-hub-page::-webkit-scrollbar-thumb,
.editor-hub::-webkit-scrollbar-thumb,
.editor-workspace::-webkit-scrollbar-thumb,
.editor-float-flyout::-webkit-scrollbar-thumb,
.editor-sculpt-panel::-webkit-scrollbar-thumb,
.editor-env-box::-webkit-scrollbar-thumb,
.editor-env-water::-webkit-scrollbar-thumb,
.editor-space-panel::-webkit-scrollbar-thumb,
.editor-desert-panel::-webkit-scrollbar-thumb,
.editor-land-panel::-webkit-scrollbar-thumb,
.editor-mountains-panel::-webkit-scrollbar-thumb,
.editor-sculpt-viewport-box::-webkit-scrollbar-thumb,
.editor-sculpt-shading-box::-webkit-scrollbar-thumb,
.editor-camera-controls-popover::-webkit-scrollbar-thumb,
.editor-hub-modal::-webkit-scrollbar-thumb,
.editor-float-flyout *::-webkit-scrollbar-thumb,
.editor-sculpt-panel *::-webkit-scrollbar-thumb,
.editor-hub-modal *::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.28);
  border-radius: 999px;
  border: 1px solid transparent;
  background-clip: padding-box;
}
.editor-hub-page:hover::-webkit-scrollbar-thumb,
.editor-hub:hover::-webkit-scrollbar-thumb,
.editor-workspace:hover::-webkit-scrollbar-thumb,
.editor-float-flyout:hover::-webkit-scrollbar-thumb,
.editor-sculpt-panel:hover::-webkit-scrollbar-thumb,
.editor-hub-modal:hover::-webkit-scrollbar-thumb,
.editor-float-flyout *:hover::-webkit-scrollbar-thumb,
.editor-sculpt-panel *:hover::-webkit-scrollbar-thumb,
.editor-hub-modal *:hover::-webkit-scrollbar-thumb {
  background: rgba(110, 231, 183, 0.5);
}
.editor-float-flyout::-webkit-scrollbar-thumb:active,
.editor-sculpt-panel::-webkit-scrollbar-thumb:active,
.editor-hub::-webkit-scrollbar-thumb:active,
.editor-hub-modal::-webkit-scrollbar-thumb:active {
  background: rgba(110, 231, 183, 0.7);
}
.editor-hub-page::-webkit-scrollbar-corner,
.editor-hub::-webkit-scrollbar-corner,
.editor-workspace::-webkit-scrollbar-corner,
.editor-float-flyout::-webkit-scrollbar-corner,
.editor-sculpt-panel::-webkit-scrollbar-corner,
.editor-hub-modal::-webkit-scrollbar-corner {
  background: transparent;
}
.editor-hub-page {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* Same site-wide DCL backdrop as Explore / landing (see index.html :root) */
  background-color: var(--dcl-bg-deep, #0c0b0f);
  background-image: var(--dcl-site-bg-image);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-attachment: fixed;
  color: #e2e8f0;
  font-family: system-ui, sans-serif;
}
.editor-hub-page .editor-hub {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: auto;
  background: transparent;
}
.editor-hub, .editor-workspace {
  width: 100%;
  height: 100%;
  overflow: auto;
  background-color: var(--dcl-bg-deep, #0c0b0f);
  background-image: var(--dcl-site-bg-image);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-attachment: fixed;
  color: #e2e8f0;
  font-family: system-ui, sans-serif;
}
.editor-hub-page .editor-hub {
  background: transparent;
  background-image: none;
}
.editor-hub-header {
  padding: 32px 40px 16px;
  max-width: 1100px;
  margin: 0 auto;
}
.editor-hub-header h1 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
}
.editor-hub-header p {
  color: #94a3b8;
  margin-bottom: 20px;
  line-height: 1.5;
}
.editor-hub-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.editor-hub-add--primary {
  background: #065f46;
  border-color: #10b981;
  font-weight: 600;
}
.editor-hub-local-dev-link,
.editor-hub-inline-link {
  color: #6ee7b7;
  text-decoration: none;
}
.editor-hub-local-dev-link {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
}
.editor-hub-local-dev-link:hover,
.editor-hub-inline-link:hover {
  text-decoration: underline;
}
.editor-hub-path-hint {
  font-size: 12px;
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.5;
  word-break: break-all;
}
.editor-hub-path-hint code, .editor-hub-empty code {
  color: #94a3b8;
}
.editor-hub-status {
  max-width: 1100px;
  margin: 0 auto 12px;
  padding: 0 40px;
  font-size: 13px;
  color: #6ee7b7;
}
.editor-hub-bridge-banner {
  background: #064e3b;
  border: 1px solid #10b981;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  color: #a7f3d0;
  margin-bottom: 16px;
  line-height: 1.4;
  word-break: break-all;
}
.editor-hub-card--creator-hub {
  border-color: #065f46;
}
.editor-hub-card--dev-bridge {
  box-shadow: inset 0 0 0 1px #10b98133;
}
.editor-hub-card--pending {
  border-style: dashed;
  border-color: #475569;
}
.editor-hub-card-path {
  font-size: 11px;
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.4;
  word-break: break-all;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.editor-hub-add, .editor-hub-card-actions button, .editor-sculpt-btn, .editor-sculpt-tab {
  background: #1e293b;
  border: 1px solid #334155;
  color: #e2e8f0;
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.editor-hub-add:hover, .editor-hub-card-actions button:hover, .editor-sculpt-btn:hover {
  background: #334155;
}
.editor-hub-error {
  max-width: 1100px;
  margin: 0 auto 16px;
  padding: 12px 40px;
  color: #fca5a5;
}
.editor-hub-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  padding: 8px 40px 40px;
  max-width: 1100px;
  margin: 0 auto;
}
.editor-hub-dropzone--active {
  outline: 2px dashed #10b981;
  outline-offset: 6px;
  border-radius: 12px;
}
.editor-hub-empty {
  grid-column: 1 / -1;
  color: #64748b;
  padding: 40px 0;
}
.editor-hub-card {
  background: #111827;
  border: 1px solid #1f2937;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}
.editor-hub-card-thumb {
  margin: -16px -16px 0;
  height: 140px;
  background: linear-gradient(145deg, #1e293b 0%, #0f172a 55%, #134e4a 100%);
  border-bottom: 1px solid #1f2937;
  overflow: hidden;
  flex-shrink: 0;
}
.editor-hub-card-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.editor-hub-card-thumb--has-image {
  background: #0b1220;
}
.editor-hub-card h2 {
  font-size: 16px;
  font-weight: 600;
}
.editor-hub-card-meta {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.4;
}
.editor-hub-card-warn {
  font-size: 12px;
  color: #fbbf24;
}
.editor-hub-card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: auto;
}
.editor-hub-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10050;
  background: rgba(2, 6, 23, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.editor-hub-modal {
  width: min(420px, 100%);
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 14px;
  padding: 20px 22px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: #e2e8f0;
}
.editor-hub-modal h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
.editor-hub-modal-blurb,
.editor-hub-modal-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: #94a3b8;
}
.editor-hub-modal-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: #cbd5e1;
}
.editor-hub-modal-input {
  background: #111827;
  border: 1px solid #334155;
  border-radius: 8px;
  color: #f1f5f9;
  padding: 8px 10px;
  font-size: 14px;
}
.editor-hub-modal-size-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.editor-hub-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.editor-workspace {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.editor-workspace-topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid #1f2937;
  flex-shrink: 0;
}
.editor-workspace-title {
  font-weight: 600;
}
.editor-workspace-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.editor-workspace-canvas {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
}
.editor-float-ui {
  position: absolute;
  inset: 0;
  z-index: 15;
  pointer-events: none;
}
.editor-float-ui .editor-viewport-dock,
.editor-float-ui .editor-float-flyout,
.editor-float-ui .editor-float-status {
  pointer-events: auto;
}
/*
 * Second icon rail: sits to the RIGHT of the main vertical dock (not on top of it).
 * left/top set in JS from main dock bounds so it never overlaps.
 */
.editor-viewport-dock--sub {
  left: 74px; /* fallback before first measure */
  z-index: 19;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    visibility 0.15s ease,
    left 0.12s ease;
}
.editor-viewport-dock--sub-hidden {
  opacity: 0;
  pointer-events: none !important;
  transform: translateY(-50%) translateX(-6px);
  visibility: hidden;
}
/* Flyout left measured in JS past the secondary rail; fallback clears main+sub docks */
.editor-float-ui--settings-open .editor-float-flyout {
  left: 160px;
}
/* Biome rail is taller; tips on sub-dock should not cover the flyout */
.editor-viewport-dock--sub .editor-viewport-dock-btn::after,
.editor-viewport-dock--sub .editor-viewport-dock-btn::before {
  /* tips still to the right, but flyout sits further out so they clear */
  z-index: 21;
}
/* Main dock hover tips would cover the sub-rail — hide them while settings is open */
.editor-float-ui--settings-open .editor-viewport-dock:not(.editor-viewport-dock--sub)
  .editor-viewport-dock-btn:hover::after,
.editor-float-ui--settings-open .editor-viewport-dock:not(.editor-viewport-dock--sub)
  .editor-viewport-dock-btn:hover::before {
  opacity: 0;
  pointer-events: none;
}
.editor-float-flyout {
  position: absolute;
  left: 68px;
  top: 50%;
  z-index: 16;
  width: min(300px, calc(100% - 88px));
  max-height: min(78vh, 720px);
  overflow-x: hidden;
  overflow-y: auto;
  /* thin transparent scrollbar via shared editor rules above */
  padding: 12px;
  border-radius: 14px;
  background: rgba(12, 18, 22, 0.92);
  border: 1px solid rgba(110, 231, 183, 0.28);
  backdrop-filter: blur(12px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 10px;
  transform: translateY(-50%) translateX(0);
  opacity: 1;
  transition:
    opacity 0.16s ease,
    transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
    left 0.16s ease;
}
.editor-float-flyout--hidden {
  opacity: 0;
  pointer-events: none !important;
  transform: translateY(-50%) translateX(-8px);
  visibility: hidden;
}
.editor-float-flyout-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.editor-float-flyout-close {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: transparent;
  color: #e2e8f0;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.editor-float-flyout-close:hover {
  border-color: #f87171;
  color: #fca5a5;
}
.editor-float-brush {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.15);
}
.editor-float-status {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 16;
  max-width: min(520px, 90%);
  padding: 8px 14px;
  border-radius: 10px;
  background: rgba(12, 18, 22, 0.82);
  border: 1px solid rgba(148, 163, 184, 0.25);
  color: #94a3b8;
  font-size: 12px;
  text-align: center;
  pointer-events: none;
}
.editor-viewport-compass {
  position: absolute;
  left: 14px;
  top: 14px;
  z-index: 4;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  user-select: none;
}
.editor-terrain-height-hud {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 4;
  pointer-events: none;
  user-select: none;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #e2e8f0;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 8px;
  padding: 6px 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
.editor-camera-reset-wrap {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.editor-camera-controls-wrap {
  position: relative;
  display: flex;
  justify-content: flex-end;
}
.editor-camera-controls-btn {
  width: 38px;
  box-sizing: border-box;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.35);
  color: #e2e8f0;
  border-radius: 8px;
  padding: 4px 0;
  min-height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
.editor-camera-controls-btn:hover,
.editor-camera-controls-btn.editor-camera-controls-btn--open {
  background: rgba(30, 41, 59, 0.92);
  border-color: rgba(148, 163, 184, 0.55);
}
.editor-camera-controls-icon {
  width: 22px;
  height: 22px;
  display: block;
}
.editor-camera-controls-popover {
  position: absolute;
  right: calc(100% + 8px);
  bottom: 0;
  min-width: 196px;
  display: none;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(15, 23, 42, 0.94);
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
}
.editor-camera-controls-popover--open {
  display: flex;
}
.editor-camera-controls-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #94a3b8;
}
.editor-camera-controls-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.editor-camera-controls-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: #e2e8f0;
}
.editor-camera-controls-keys {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #cbd5e1;
  white-space: nowrap;
}
.editor-camera-controls-label {
  color: #94a3b8;
  text-align: right;
}
.editor-camera-zoom-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.editor-camera-zoom-btn {
  width: 38px;
  box-sizing: border-box;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.35);
  color: #e2e8f0;
  border-radius: 8px;
  padding: 2px 0;
  min-height: 30px;
  font-size: 18px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
.editor-camera-zoom-btn:hover {
  background: rgba(30, 41, 59, 0.92);
  border-color: rgba(148, 163, 184, 0.55);
}
.editor-camera-reset-btn {
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.35);
  color: #e2e8f0;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
.editor-camera-reset-btn:hover {
  background: rgba(30, 41, 59, 0.92);
  border-color: rgba(148, 163, 184, 0.55);
}
.editor-compass-ring {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 1px solid rgba(148, 163, 184, 0.45);
  background: rgba(15, 23, 42, 0.72);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
.editor-compass-label {
  position: absolute;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #e2e8f0;
}
.editor-compass-n { top: 4px; left: 50%; transform: translateX(-50%); color: #93c5fd; }
.editor-compass-s { bottom: 4px; left: 50%; transform: translateX(-50%); color: #94a3b8; }
.editor-compass-e { right: 6px; top: 50%; transform: translateY(-50%); color: #fca5a5; }
.editor-compass-w { left: 6px; top: 50%; transform: translateY(-50%); color: #94a3b8; }
.editor-compass-axes {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 9px;
  color: #94a3b8;
  background: rgba(15, 23, 42, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 6px;
  padding: 4px 8px;
  line-height: 1.35;
}
.editor-compass-axes i {
  font-style: normal;
  font-weight: 700;
  margin-right: 4px;
}
.editor-compass-axis-x { color: #f87171; }
.editor-compass-axis-y { color: #4ade80; }
.editor-compass-axis-z { color: #60a5fa; }
.editor-workspace-canvas canvas {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.editor-workspace-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  background: rgba(12, 11, 15, 0.55);
  backdrop-filter: blur(2px);
}
.editor-sculpt-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.editor-sculpt-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #6ee7b7;
}
.editor-sculpt-hint {
  font-size: 11px;
  color: #64748b;
  line-height: 1.4;
}
.editor-sculpt-hint--compact {
  font-size: 10px;
  opacity: 0.9;
}
.editor-env-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* No nested card — flyout chrome is enough */
  padding: 0;
  background: transparent;
  border: 0;
}
.editor-env-water {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(148, 163, 184, 0.15);
}
.editor-env-water--hidden {
  display: none !important;
}
.editor-env-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #cbd5e1;
}
.editor-env-field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #6ee7b7;
}
.editor-env-select {
  width: 100%;
  background: #0f172a;
  color: #e2e8f0;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
}
.editor-viewport-dock {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 6px;
  border-radius: 16px;
  background: rgba(12, 18, 22, 0.82);
  border: 1px solid rgba(110, 231, 183, 0.28);
  backdrop-filter: blur(12px);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}
.editor-viewport-dock-sep {
  width: 22px;
  height: 1px;
  margin: 4px 0;
  background: rgba(148, 163, 184, 0.28);
}
.editor-viewport-dock-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.editor-viewport-dock-group--hidden {
  display: none !important;
}
/* Biome sub-panels sit on the flyout — no extra tinted card per menu */
.editor-space-panel,
.editor-desert-panel,
.editor-land-panel,
.editor-forest-panel,
.editor-mountains-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  border-radius: 0;
  background: transparent;
  border: 0;
}
.editor-space-panel.editor-sculpt-tools--hidden,
.editor-desert-panel.editor-sculpt-tools--hidden,
.editor-land-panel.editor-sculpt-tools--hidden,
.editor-forest-panel.editor-sculpt-tools--hidden,
.editor-mountains-panel.editor-sculpt-tools--hidden {
  display: none !important;
}
.editor-viewport-dock-btn {
  position: relative;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: rgba(30, 41, 59, 0.55);
  color: #e2e8f0;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition:
    background 0.12s ease,
    border-color 0.12s ease,
    transform 0.12s ease,
    box-shadow 0.12s ease;
}
.editor-viewport-dock-icon {
  pointer-events: none;
  user-select: none;
  text-align: center;
  font-size: 18px;
  line-height: 1;
}
/* Instant custom tip to the right — no native title delay */
.editor-viewport-dock-btn::after {
  content: attr(data-tip);
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%) translateX(-4px);
  white-space: nowrap;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.96);
  border: 1px solid rgba(110, 231, 183, 0.35);
  color: #e2e8f0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.1s ease,
    transform 0.12s ease;
  z-index: 30;
}
.editor-viewport-dock-btn::before {
  content: '';
  position: absolute;
  left: calc(100% + 4px);
  top: 50%;
  width: 8px;
  height: 8px;
  margin-top: -4px;
  background: rgba(15, 23, 42, 0.96);
  border-left: 1px solid rgba(110, 231, 183, 0.35);
  border-bottom: 1px solid rgba(110, 231, 183, 0.35);
  transform: rotate(45deg);
  opacity: 0;
  transition: opacity 0.1s ease;
  z-index: 30;
}
.editor-viewport-dock-btn:hover {
  border-color: rgba(110, 231, 183, 0.45);
  background: rgba(15, 60, 48, 0.75);
  transform: scale(1.06);
}
.editor-viewport-dock-btn:hover::after,
.editor-viewport-dock-btn:hover::before {
  opacity: 1;
}
.editor-viewport-dock-btn:hover::after {
  transform: translateY(-50%) translateX(0);
}
.editor-viewport-dock-btn:active {
  transform: scale(0.96);
}
.editor-viewport-dock-btn--active {
  background: #065f46;
  border-color: #10b981;
  box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.35);
}
.editor-viewport-dock-btn--on {
  background: rgba(14, 116, 144, 0.55);
  border-color: rgba(34, 211, 238, 0.55);
  box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.25);
}
.editor-viewport-dock-btn--active:hover,
.editor-viewport-dock-btn--on:hover {
  filter: brightness(1.08);
}
.editor-workspace-canvas {
  position: relative;
}
.editor-sculpt-tabs, .editor-sculpt-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.editor-sculpt-tabs {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 6px 0 4px;
  background: linear-gradient(180deg, rgba(12, 18, 14, 0.96) 70%, rgba(12, 18, 14, 0));
}
.editor-sculpt-tabs .editor-sculpt-tab {
  flex: 1 1 auto;
  min-width: 4.5rem;
  font-weight: 600;
}
.editor-sculpt-tools--hidden {
  display: none !important;
}
.editor-sculpt-btn--active, .editor-sculpt-tab.editor-sculpt-btn--active {
  background: #065f46;
  border-color: #10b981;
}
.editor-sculpt-btn--primary {
  background: #047857;
  border-color: #10b981;
  font-weight: 600;
}
.editor-sculpt-slider {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: #94a3b8;
}
.editor-sculpt-slider input[type=range] {
  width: 100%;
}
.editor-sculpt-status {
  font-size: 11px;
  color: #94a3b8;
  min-height: 2.5em;
  line-height: 1.4;
}
.editor-sculpt-check {
  font-size: 12px;
  color: #cbd5e1;
}
.editor-sculpt-swatch-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.editor-sculpt-swatch {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 2px solid rgba(255, 255, 255, 0.25);
  cursor: pointer;
  padding: 0;
  box-sizing: border-box;
}
.editor-sculpt-swatch--active {
  border-color: #ecfdf5;
  border-width: 3px;
  box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.55);
}
.editor-sculpt-tab--active {
  background: rgba(34, 197, 94, 0.35);
  border-color: rgba(74, 222, 128, 0.6);
}
.editor-sculpt-viewport-box,
.editor-sculpt-shading-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  border-radius: 0;
  background: transparent;
  border: 0;
}
.editor-sculpt-shading-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #6ee7b7;
}
.editor-sculpt-shading-note {
  font-size: 10px;
  color: #64748b;
  line-height: 1.35;
}
.editor-sculpt-shading-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
  font-size: 10px;
  color: #94a3b8;
  line-height: 1.5;
}
.editor-sculpt-legend-chip {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  color: #0f172a;
  font-weight: 600;
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.editor-sculpt-shading-biome {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid rgba(110, 231, 183, 0.12);
}
.editor-sculpt-shading-biome:first-of-type {
  border-top: none;
  padding-top: 0;
}
.editor-sculpt-shading-biome-title {
  font-size: 30px;
  font-weight: 700;
  color: #e2e8f0;
  letter-spacing: 0.02em;
  line-height: 1.1;
}
.editor-sculpt-shading-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #94a3b8;
}
.editor-sculpt-shading-row label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.editor-sculpt-shading-from-to {
  gap: 12px;
  flex-wrap: wrap;
}
.editor-sculpt-shading-row input[type=number],
.editor-sculpt-shading-row .editor-sculpt-shading-number,
.editor-sculpt-shading-row .editor-sculpt-select {
  width: 72px;
  min-width: 72px;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(15, 23, 42, 0.65);
  color: #e2e8f0;
  font-size: 11px;
}
.editor-sculpt-shading-row .editor-sculpt-select {
  width: auto;
  min-width: 168px;
  flex: 1;
}
.editor-sculpt-color-input {
  width: 40px;
  height: 28px;
  padding: 2px;
  border-radius: 6px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(15, 23, 42, 0.65);
  cursor: pointer;
}
.editor-sculpt-color-input::-webkit-color-swatch-wrapper {
  padding: 0;
}
.editor-sculpt-color-input::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}
`
  document.head.appendChild(style)
}