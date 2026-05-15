import { api } from './client'
import type { ApplicationListItem } from './jobs'

export const applicationsApi = {
  list: () => api.get<ApplicationListItem[]>('/applications'),
  get: (id: string) => api.get<ApplicationListItem>(`/applications/${id}`),

  accept: (id: string) => api.patch<ApplicationListItem>(`/applications/${id}/accept`),
  reject: (id: string) => api.patch<ApplicationListItem>(`/applications/${id}/reject`),
  startScreening: (id: string) => api.post<{ attemptId: string; questions: unknown[] }>(`/applications/${id}/screening/start`),
  sendAssessment: (id: string) => api.patch<ApplicationListItem>(`/applications/${id}/assessment/send`),
  startAssessment: (id: string) => api.post<{ attemptId: string; questions: any[]; duration_minutes: number }>(`/applications/${id}/assessment/start`),
  submitAssessment: (id: string, answers: Record<string, number>) => api.post<{ message: string }>(`/applications/${id}/assessment/submit`, { answers }),

  // Coding Assessment
  sendCodingAssessment: (id: string) => api.patch<ApplicationListItem>(`/applications/${id}/coding-assessment/send`),
  startCodingAssessment: (id: string) => api.post<{ attemptId: string; questions: any[]; duration_minutes: number }>(`/applications/${id}/coding-assessment/start`),
  submitCodingAssessment: (id: string, answers: Record<string, string>, language: string) =>
    api.post<{ message: string }>(`/applications/${id}/coding-assessment/submit`, { answers, language }),
  runCodeWithDetails: (id: string, payload: { questionId: string; code: string; language: string; type?: string }) =>
    api.post<{ results: { input: string; expected: string; output: string; passed: boolean }[] }>(`/applications/${id}/screening/run-code`, payload),
}
