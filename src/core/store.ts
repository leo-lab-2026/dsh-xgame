/** 落盘存储:每个会话一个目录,state.json 为游戏状态,truth.json 为真相(机密)。 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export function defaultStorageRoot(): string {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-xgame')
}

/** sessionId 形如 '--home-lifxu-src-dsh-xgame--',本身是安全的,这里再做一次防御。 */
export function safeSegment(value: string): string {
  if (value === '' || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`dsh-xgame:非法会话标识 ${JSON.stringify(value)}`)
  }
  return value
}

export function sessionDir(root: string, sessionId: string): string {
  return path.join(root, safeSegment(sessionId))
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}

export async function saveJson(root: string, sessionId: string, name: string, data: unknown): Promise<void> {
  const dir = sessionDir(root, sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeAtomic(path.join(dir, name), data)
}

export async function loadJson<T>(root: string, sessionId: string, name: string): Promise<T | null> {
  const file = path.join(sessionDir(root, sessionId), name)
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function dropSession(root: string, sessionId: string): Promise<void> {
  await rm(sessionDir(root, sessionId), { recursive: true, force: true })
}
