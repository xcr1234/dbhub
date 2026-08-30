/**
 * Locale dictionaries for the dbhub settings page. The Simplified
 * Chinese copy is the key-set source of truth; English mirrors it.
 * The framework-injected `t` seat binds the active locale and
 * returns the matching entry at call time, so language switches
 * are picked up without re-registering.
 *
 * @module @xcr1234/dsh-plugin-dbhub/client
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  nav: '数据库连接',
  title: '数据库连接',
  desc: '管理 DBHub 数据库连接。保存后通过 DBHub 自带的热更新机制立即生效；新增/修改/删除都无需重启。',
  contact: '联系开发者',
  port: 'HTTP 端口',
  portHint: 'DBHub 进程监听的本地 HTTP 端口；改端口需要重启进程。',
  enabled: '启用',
  'status.running': '运行中',
  'status.stopped': '已停止',
  'status.error': '错误',
  'list.add': '新增连接',
  'list.empty': '还没有配置任何数据库连接',
  'list.emptyHint': '点击「新增连接」开始；DSN 字符串直接写到 dbhub.toml。',
  'list.confirm.remove': '确定移除连接「{name}」吗？保存后生效。',
  'action.edit': '编辑',
  'action.remove': '移除',
  'action.cancel': '取消',
  'action.save': '保存',
  'form.new': '新增数据库连接',
  'form.edit': '编辑「{name}」',
  'form.id': '连接 ID',
  'form.idHint': '模型工具命名空间后缀；字母/数字/下划线/连字符，1-64 字符。',
  'form.dsn': 'DSN 连接字符串',
  'form.dsnHint':
    '形如 postgres://user:pass@host:5432/dbname。SQLite 用 sqlite:///abs/path.db。DSN 视为密钥，不会上传到日志。',
  'form.error.id': '请填写连接 ID。',
  'form.error.idInvalid': '连接 ID 只能包含字母、数字、下划线或连字符，不超过 64 字符。',
  'form.error.dsn': '请填写 DSN 字符串。',
  'form.error.dsnInvalid': 'DSN 必须以 postgres://、mysql://、mariadb://、sqlserver://、sqlite:// 或 oracle:// 开头。',
  'form.error.duplicateId': '连接 ID 已存在。',
  'footer.dirty': '有未保存的修改',
  'footer.saving': '保存中…',
  'footer.saved': '已保存并热更新',
  'footer.save': '保存',
  'footer.discard': '放弃修改',
  'error.load': '加载失败：{message}',
  'error.save': '保存失败：{message}',
  'toml.path': 'dbhub.toml 路径',
  'toml.edit': '直接编辑 TOML',
  'toml.hint': 'SSH 隧道、SSL、查询超时等高级选项不暴露在面板中，可以直接编辑该文件。',
}

/** English dictionary, checked complete against the zh key set. */
export const en: typeof zh = {
  nav: 'Database connections',
  title: 'Database connections',
  desc: 'Manage DBHub database connections. Saving hot-reloads immediately through DBHub\'s own config watcher; add, edit or remove without restarting.',
  contact: 'Contact developer',
  port: 'HTTP port',
  portHint: 'Local HTTP port the DBHub process binds; changing it restarts the process.',
  enabled: 'Enabled',
  'status.running': 'Running',
  'status.stopped': 'Stopped',
  'status.error': 'Error',
  'list.add': 'Add connection',
  'list.empty': 'No database connections configured yet',
  'list.emptyHint': 'Click "Add connection" to begin; the DSN string is written straight to dbhub.toml.',
  'list.confirm.remove': 'Remove connection "{name}"? Takes effect after you save.',
  'action.edit': 'Edit',
  'action.remove': 'Remove',
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'form.new': 'Add database connection',
  'form.edit': 'Edit "{name}"',
  'form.id': 'Connection ID',
  'form.idHint': 'Namespace suffix for the model-facing tool name; letters, digits, underscores, or hyphens, 1-64 chars.',
  'form.dsn': 'DSN connection string',
  'form.dsnHint':
    'Format: postgres://user:pass@host:5432/dbname. For SQLite, use sqlite:///abs/path.db. DSNs are treated as secrets and never logged in clear text.',
  'form.error.id': 'Please enter a connection ID.',
  'form.error.idInvalid': 'Connection ID may only contain letters, digits, underscores, or hyphens, up to 64 chars.',
  'form.error.dsn': 'Please enter a DSN string.',
  'form.error.dsnInvalid': 'DSN must start with one of postgres://, mysql://, mariadb://, sqlserver://, sqlite://, oracle://.',
  'form.error.duplicateId': 'Connection ID already exists.',
  'footer.dirty': 'Unsaved changes',
  'footer.saving': 'Saving…',
  'footer.saved': 'Saved and hot-reloaded',
  'footer.save': 'Save',
  'footer.discard': 'Discard',
  'error.load': 'Failed to load: {message}',
  'error.save': 'Failed to save: {message}',
  'toml.path': 'dbhub.toml path',
  'toml.edit': 'Edit TOML directly',
  'toml.hint': 'SSH tunnels, SSL, query timeouts and similar advanced options are not exposed here; edit the file directly to add them.',
}
