const STYLE_ID = 'dcl-editor-styles'

export function injectEditorStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
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
.editor-workspace-panel {
  width: 300px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid #1f2937;
  padding: 12px;
  background: #0f172a;
}
.editor-workspace-canvas {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
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
.editor-sculpt-tabs, .editor-sculpt-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
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
  padding: 8px;
  border-radius: 10px;
  background: rgba(20, 40, 30, 0.45);
  border: 1px solid rgba(110, 231, 183, 0.18);
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