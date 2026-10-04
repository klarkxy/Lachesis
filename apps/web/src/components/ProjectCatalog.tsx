import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { projectsApi } from '@/api/client'
import { useQuery } from '@/api/hooks'
import type { Project } from '@/api/types'

interface ProjectCatalogValue {
  projects: Project[]
  loading: boolean
  error: unknown
  refetch: () => void
}

const ProjectCatalogContext = createContext<ProjectCatalogValue | null>(null)

export function ProjectCatalogProvider({ children }: { children: ReactNode }) {
  const query = useQuery(() => projectsApi.list(), [])
  const value = useMemo<ProjectCatalogValue>(
    () => ({
      projects: query.data?.items ?? [],
      loading: query.loading,
      error: query.error,
      refetch: query.refetch,
    }),
    [query.data, query.loading, query.error, query.refetch],
  )
  return <ProjectCatalogContext.Provider value={value}>{children}</ProjectCatalogContext.Provider>
}

export function useProjectCatalog(): ProjectCatalogValue {
  const value = useContext(ProjectCatalogContext)
  if (!value) throw new Error('项目列表尚未准备好')
  return value
}
