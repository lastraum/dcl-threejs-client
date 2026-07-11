/**
 * Offline TASKS.yaml snapshot for the dev panel when GitHub fetch is disabled.
 * Bundled at build/dev time via Vite `?raw` — does not rewrite this file on `npm run build`.
 */
import { parse as parseYaml } from 'yaml'
import tasksYaml from '../../../docs/TASKS.yaml?raw'
import type { TasksRegistry } from './tasksRegistry'

export const TASKS_FALLBACK: TasksRegistry = parseYaml(tasksYaml) as TasksRegistry
