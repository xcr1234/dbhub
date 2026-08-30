/**
 * Theme-aware stylesheet for the dbhub settings page.
 *
 * Mirrors the shipped settings panels' `--dsw-alias-*` design tokens
 * so the page follows the active light/dark theme. Injected once by
 * the client plugin body via the same `data-plugin-css` mechanism
 * the official client bundles use.
 *
 * @module @xcr1234/dsh-plugin-dbhub/client
 */

/** Scoped class names referenced by the page components. */
export const C = {
  wrap: 'dshdb-wrap',
  desc: 'dshdb-desc',
  contact: 'dshdb-contact',
  card: 'dshdb-card',
  cardHead: 'dshdb-card-head',
  cardTitle: 'dshdb-card-title',
  cardSub: 'dshdb-card-sub',
  badge: 'dshdb-badge',
  badgeOk: 'dshdb-badge-ok',
  badgeOff: 'dshdb-badge-off',
  badgeError: 'dshdb-badge-error',
  badgeInfo: 'dshdb-badge-info',
  row: 'dshdb-row',
  rowMain: 'dshdb-row-main',
  name: 'dshdb-name',
  meta: 'dshdb-meta',
  toolsRow: 'dshdb-tools-row',
  toolChip: 'dshdb-tool-chip',
  toolChipReadonly: 'dshdb-tool-chip-readonly',
  toolChipSource: 'dshdb-tool-chip-source',
  toolsEmpty: 'dshdb-tools-empty',
  btn: 'dshdb-btn',
  btnPrimary: 'dshdb-btn-primary',
  btnDanger: 'dshdb-btn-danger',
  rowActions: 'dshdb-row-actions',
  field: 'dshdb-field',
  label: 'dshdb-label',
  hint: 'dshdb-hint',
  input: 'dshdb-input',
  select: 'dshdb-select',
  checkbox: 'dshdb-checkbox',
  error: 'dshdb-error',
  empty: 'dshdb-empty',
  editor: 'dshdb-editor',
  editorHeader: 'dshdb-editor-header',
  editorBody: 'dshdb-editor-body',
  editorFooter: 'dshdb-editor-footer',
  footer: 'dshdb-footer',
  notice: 'dshdb-notice',
  toml: 'dshdb-toml',
  tomlPath: 'dshdb-toml-path',
}

const css = `
.dshdb-wrap{display:flex;flex-direction:column;gap:10px;padding:4px 0}
.dshdb-desc{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:0}
.dshdb-contact{color:var(--dsw-alias-state-info-primary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;text-decoration:underline;margin-left:8px;cursor:pointer;white-space:nowrap}
.dshdb-contact:hover{text-decoration:underline;opacity:.8}
.dshdb-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dshdb-card-head{display:flex;align-items:center;gap:8px}
.dshdb-card-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;flex:1;min-width:0}
.dshdb-card-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dshdb-badge{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-caption);height:20px;border-radius:10px;flex:none;align-items:center;padding:0 6px;font-size:11px;line-height:20px;display:inline-flex}
.dshdb-badge-ok{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.dshdb-badge-off{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-caption)}
.dshdb-badge-error{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dshdb-badge-info{background:var(--dsw-alias-state-info-tertiary,var(--dsw-alias-button-ghost-active-fill));color:var(--dsw-alias-state-info-primary,var(--dsw-alias-label-caption))}
.dshdb-row{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:10px}
.dshdb-row-main{min-width:0;display:flex;flex-direction:column;gap:2px;flex:1}
.dshdb-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdb-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsh-font-mono,monospace)}
.dshdb-tools-row{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.dshdb-tool-chip{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;border-radius:9px;padding:0 8px;font-family:var(--dsh-font-mono,monospace);display:inline-flex;align-items:center;gap:4px}
.dshdb-tool-chip-readonly{background:var(--dsw-alias-state-info-tertiary,var(--dsw-alias-button-ghost-active-fill));color:var(--dsw-alias-state-info-primary,var(--dsw-alias-label-caption))}
.dshdb-tool-chip-source{color:var(--dsw-alias-label-tertiary);font-size:10px}
.dshdb-tools-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-style:italic}
.dshdb-btn{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;line-height:22px;cursor:pointer;background:0 0;border-radius:999px;flex:none;padding:0 10px}
.dshdb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshdb-btn:disabled{opacity:.4;cursor:default}
.dshdb-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-primary-dimmed)}
.dshdb-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshdb-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dshdb-row-actions{display:flex;align-items:center;gap:6px;flex:none}
.dshdb-field{display:flex;flex-direction:column;gap:4px}
.dshdb-label{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dshdb-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dshdb-input,.dshdb-select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;border-radius:7px;padding:5px 8px;width:100%;font-size:12px;line-height:18px}
.dshdb-input{font-family:var(--dsh-font-mono,monospace)}
.dshdb-checkbox{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshdb-checkbox input{accent-color:var(--dsw-alias-button-primary-fill)}
.dshdb-error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:8px;padding:6px 10px;font-size:11px;line-height:16px}
.dshdb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center;padding:28px 12px;display:flex;flex-direction:column;gap:4px;align-items:center}
.dshdb-editor{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;overflow:hidden}
.dshdb-editor-header{border-bottom:1px solid var(--dsw-alias-border-l2);padding:10px 12px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.dshdb-editor-body{display:flex;flex-direction:column;gap:10px;padding:12px}
.dshdb-editor-footer{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px;display:flex;justify-content:flex-end;gap:8px}
.dshdb-footer{display:flex;align-items:center;gap:8px;padding-top:4px}
.dshdb-notice{color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:16px;flex:1}
.dshdb-toml{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:flex;flex-direction:column;gap:2px}
.dshdb-toml-path{font-family:var(--dsh-font-mono,monospace);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

/** Inject the stylesheet once (idempotent). */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  const tagId = '@xcr1234/dsh-plugin-dbhub/panel.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@xcr1234/dsh-plugin-dbhub'
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}
