/** Fetch and parse docs/TASKS.yaml for the dev progress panel. */

import { parse as parseYaml } from 'yaml'
import { TASKS_FALLBACK } from './tasksFallback'

export type TaskStatus = 'open' | 'in_progress' | 'partial' | 'done' | 'blocked'

export type RegistryTask = {
  id: string
  title: string
  status: TaskStatus
  owner?: string
  track?: string
  phase?: number | string
  complexity?: string
  priority?: string
  dependencies?: string[]
  blocks?: string[]
  files?: string[]
  acceptance_criteria?: string[]
  ai_context_links?: string[]
  test_scenes?: string[]
  do_not_touch?: string[]
  notes?: string
  maintainer_only?: boolean
}

export type TasksRegistry = {
  schema_version?: number
  updated?: string
  tasks: RegistryTask[]
}

const GITHUB_RAW =
  'https://raw.githubusercontent.com/lastraum/ThreejsClient'
const DEFAULT_BRANCH = 'redo/threejs-projection-arch'

/**
 * Private repo — raw.githubusercontent.com 404s without auth. Use bundled tasksFallback.ts
 * until the public cut (see docs/REPO_MANAGEMENT.md). Enable with ?tasksGithubFetch=1 or
 * VITE_TASKS_GITHUB_FETCH=true after the repo is public.
 */
export function tasksGithubFetchEnabled(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('tasksGithubFetch') === '1') return true
  try {
    if (localStorage.getItem('tasksGithubFetch') === '1') return true
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_TASKS_GITHUB_FETCH === 'true'
}

export type TasksLoadSource = 'github' | 'fallback'

export type TasksLoadResult = {
  registry: TasksRegistry
  source: TasksLoadSource
  branch: string
  fetchedAt: number
}

export function resolveTasksBranch(): string {
  if (typeof window === 'undefined') return DEFAULT_BRANCH
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('tasksBranch')
  if (fromQuery) return fromQuery
  try {
    const stored = localStorage.getItem('tasksBranch')
    if (stored) return stored
  } catch {
    /* ignore */
  }
  return DEFAULT_BRANCH
}

export function tasksYamlUrl(branch = resolveTasksBranch()): string {
  return `${GITHUB_RAW}/${branch}/docs/TASKS.yaml`
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === 'open' ||
    value === 'in_progress' ||
    value === 'partial' ||
    value === 'done' ||
    value === 'blocked'
  )
}

function normalizeRegistry(raw: unknown): TasksRegistry {
  if (!raw || typeof raw !== 'object') throw new Error('TASKS.yaml: expected mapping root')
  const obj = raw as Record<string, unknown>
  const tasksRaw = obj.tasks
  if (!Array.isArray(tasksRaw)) throw new Error('TASKS.yaml: missing tasks array')

  const tasks: RegistryTask[] = []
  for (const entry of tasksRaw) {
    if (!entry || typeof entry !== 'object') continue
    const t = entry as Record<string, unknown>
    const id = typeof t.id === 'string' ? t.id : ''
    const title = typeof t.title === 'string' ? t.title : id
    const status = isTaskStatus(t.status) ? t.status : 'open'
    if (!id) continue
    tasks.push({
      id,
      title,
      status,
      owner: typeof t.owner === 'string' ? t.owner : undefined,
      track: typeof t.track === 'string' ? t.track : undefined,
      phase: typeof t.phase === 'number' || typeof t.phase === 'string' ? t.phase : undefined,
      complexity: typeof t.complexity === 'string' ? t.complexity : undefined,
      priority: typeof t.priority === 'string' ? t.priority : undefined,
      dependencies: Array.isArray(t.dependencies) ? (t.dependencies as string[]) : undefined,
      blocks: Array.isArray(t.blocks) ? (t.blocks as string[]) : undefined,
      files: Array.isArray(t.files) ? (t.files as string[]) : undefined,
      acceptance_criteria: Array.isArray(t.acceptance_criteria)
        ? (t.acceptance_criteria as string[])
        : undefined,
      ai_context_links: Array.isArray(t.ai_context_links) ? (t.ai_context_links as string[]) : undefined,
      test_scenes: Array.isArray(t.test_scenes) ? (t.test_scenes as string[]) : undefined,
      do_not_touch: Array.isArray(t.do_not_touch) ? (t.do_not_touch as string[]) : undefined,
      notes: typeof t.notes === 'string' ? t.notes : undefined,
      maintainer_only: t.maintainer_only === true
    })
  }

  return {
    schema_version: typeof obj.schema_version === 'number' ? obj.schema_version : undefined,
    updated: typeof obj.updated === 'string' ? obj.updated : undefined,
    tasks
  }
}

export function parseTasksYaml(text: string): TasksRegistry {
  return normalizeRegistry(parseYaml(text))
}

let cached: TasksLoadResult | null = null
let inflight: Promise<TasksLoadResult> | null = null

/** Load tasks from GitHub raw YAML; fallback to bundled snapshot on failure. */
export async function loadTasksRegistry(force = false): Promise<TasksLoadResult> {
  if (!force && cached) return cached
  if (!force && inflight) return inflight

  const branch = resolveTasksBranch()

  const useFallback = (): TasksLoadResult => {
    const result: TasksLoadResult = {
      registry: TASKS_FALLBACK,
      source: 'fallback',
      branch,
      fetchedAt: Date.now()
    }
    cached = result
    return result
  }

  if (!tasksGithubFetchEnabled()) {
    return Promise.resolve(useFallback())
  }

  inflight = (async (): Promise<TasksLoadResult> => {
    try {
      const res = await fetch(tasksYamlUrl(branch), { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const registry = parseTasksYaml(text)
      const result: TasksLoadResult = {
        registry,
        source: 'github',
        branch,
        fetchedAt: Date.now()
      }
      cached = result
      return result
    } catch {
      return useFallback()
    } finally {
      inflight = null
    }
  })()

  return inflight
}

export function countTasksByStatus(tasks: RegistryTask[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    open: 0,
    in_progress: 0,
    partial: 0,
    done: 0,
    blocked: 0
  }
  for (const t of tasks) counts[t.status]++
  return counts
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  done: '🟢 Done',
  in_progress: '🟡 In progress',
  partial: '🟡 Partial',
  open: '⬜ Open',
  blocked: '🔴 Blocked'
}

/** Panel grouping — maps registry status to roadmap sections. */
export const ROADMAP_GROUPS: { title: string; statuses: TaskStatus[] }[] = [
  { title: 'In progress', statuses: ['in_progress', 'partial'] },
  { title: 'Open / blocked', statuses: ['open', 'blocked'] },
  { title: 'Shipped', statuses: ['done'] }
]
