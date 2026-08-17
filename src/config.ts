/** 插件配置解析(cordis.patch.yml 中的 config)。 */

export interface XgameConfig {
  /** 落盘根目录;空 = $DSH_HOME/storages/dsh-xgame。 */
  storageDir: string
  language: string
}

export function resolveConfig(config: unknown): XgameConfig {
  const raw = (config ?? {}) as Record<string, unknown>
  const storageDir = typeof raw.storageDir === 'string' ? raw.storageDir : ''
  const language = typeof raw.language === 'string' && raw.language.trim() !== '' ? raw.language : 'zh-CN'
  const unknown = Object.keys(raw).filter((key) => key !== 'storageDir' && key !== 'language')
  if (unknown.length > 0) {
    throw new Error(`dsh-xgame:未知配置项 ${unknown.join(', ')} — 支持 { storageDir, language }`)
  }
  return { storageDir, language }
}
