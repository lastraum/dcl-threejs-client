const STYLE_ID = 'dcl-editor-styles'

export function injectEditorStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.editor-hub, .editor-workspace {
  width: 100%;
  height: 100%;
  overflow: auto;
  background: #0a0a0f;
  color: #e2e8f0;
  font-family: system-ui, sans-serif;
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
}
.editor-workspace-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  background: #0a1624;
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
`
  document.head.appendChild(style)
}