import { useQuery } from '@/api/hooks'
import { issuesApi } from '@/api/client'
import type { Issue } from '@/api/types'

/** 读取同一项目里的任务，供依赖选择显示标题。编号仍是接口使用的 id。 */
export function useProjectTasks(projectId: string): { tasks: Issue[]; loading: boolean; failed: boolean } {
  const query = useQuery(async () => {
      const all: Issue[] = []
      if (!projectId) return all
      let cursor: string | null = null
      for (let page = 0; page < 8; page += 1) {
        const result = await issuesApi.list({ projectId, cursor })
        all.push(...result.items)
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      return all
  }, [projectId])

  return { tasks: query.data ?? [], loading: Boolean(projectId) && query.loading, failed: Boolean(query.error) }
}
