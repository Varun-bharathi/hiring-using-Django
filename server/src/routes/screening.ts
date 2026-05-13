import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../lib/db.js'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { getFuncName, prepareSource } from './applications.js'
import type { QuestionTemplate } from '../lib/questionBank.js'

export const screeningRouter = Router()

screeningRouter.use(authMiddleware)

function parseJson<T>(s: string | null): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

interface McqOption {
  id: string
  text: string
  correct: boolean
}

function scoreMcq(questionId: string, questions: { id: string; options: string | null }[], answers: Record<string, string>): number {
  const q = questions.find((x) => x.id === questionId)
  if (!q?.options) return 0
  const opts = parseJson<McqOption[]>(q.options)
  if (!opts) return 0
  const selected = answers[questionId]
  const correct = opts.find((o) => o.correct)
  return correct && selected === correct.id ? 1 : 0
}

screeningRouter.get('/:applicationId', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { applicationId } = req.params
    const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [applicationId])
    const app = apps[0]
    
    if (!app || app.job_seeker_id !== u.userId) {
      res.status(404).json({ message: 'Not found' })
      return
    }
    
    const [assessments] = await pool.query<any[]>('SELECT * FROM Assessment WHERE job_id = ? AND type = "preliminary"', [app.job_id])
    const prelim = assessments[0]
    
    if (!prelim) {
      res.status(404).json({ message: 'No screening configured' })
      return
    }
    
    const [questions] = await pool.query<any[]>('SELECT * FROM Question WHERE assessment_id = ? ORDER BY order_index ASC', [prelim.id])
    
    const config = parseJson<{ duration_minutes?: number; cutoff?: number }>(prelim.config) ?? {}
    res.json({
      assessment_id: prelim.id,
      duration_minutes: config.duration_minutes ?? 45,
      cutoff: config.cutoff ?? 70,
      questions: questions.map((q) => ({
        id: q.id,
        type: q.type,
        content: q.content,
        options: q.options ? (parseJson(q.options) as McqOption[]) : undefined,
        max_score: q.max_score,
        order_index: q.order_index,
      })),
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to fetch screening' })
  }
})

screeningRouter.post('/:applicationId/start', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { applicationId } = req.params
    const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [applicationId])
    const app = apps[0]
    
    if (!app || app.job_seeker_id !== u.userId) {
      res.status(404).json({ message: 'Not found' })
      return
    }
    
    const [attempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE application_id = ?', [applicationId])
    let attempt = attempts[0]
    
    if (!attempt) {
      const attemptId = crypto.randomUUID()
      await pool.query(
        'INSERT INTO ScreeningAttempt (id, application_id, type, started_at) VALUES (?, ?, ?, NOW())',
        [attemptId, applicationId, 'screening']
      )
      const [newAttempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE id = ?', [attemptId])
      attempt = newAttempts[0]
    }
    
    res.json({
      attempt_id: attempt.id,
      started_at: new Date(attempt.started_at).toISOString(),
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to start screening' })
  }
})

screeningRouter.post('/:applicationId/pause', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { applicationId } = req.params
    const body = (req.body as { answers?: Record<string, string>; time_spent_sec?: number }) ?? {}
    
    const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [applicationId])
    const app = apps[0]
    
    if (!app || app.job_seeker_id !== u.userId) {
      res.status(404).json({ message: 'Not found' })
      return
    }
    
    const [attempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE application_id = ?', [applicationId])
    const attempt = attempts[0]
    
    if (!attempt) {
      res.status(400).json({ message: 'No active attempt' })
      return
    }
    
    const newAnswers = body.answers ? JSON.stringify(body.answers) : attempt.answers
    const newTimeSpent = body.time_spent_sec ?? attempt.time_spent_sec
    
    await pool.query(
      'UPDATE ScreeningAttempt SET paused_at = NOW(), answers = ?, time_spent_sec = ? WHERE id = ?',
      [newAnswers, newTimeSpent, attempt.id]
    )
    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to pause' })
  }
})

screeningRouter.post('/:applicationId/resume', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { applicationId } = req.params
    const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [applicationId])
    const app = apps[0]
    
    if (!app || app.job_seeker_id !== u.userId) {
      res.status(404).json({ message: 'Not found' })
      return
    }
    
    const [attempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE application_id = ?', [applicationId])
    const attempt = attempts[0]
    
    if (!attempt) {
      res.status(400).json({ message: 'No attempt' })
      return
    }
    
    await pool.query('UPDATE ScreeningAttempt SET paused_at = NULL WHERE id = ?', [attempt.id])
    res.json({ ok: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to resume' })
  }
})

screeningRouter.post('/:applicationId/submit', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { applicationId } = req.params
    const body = (req.body as { answers: Record<string, string>; time_spent_sec?: number }) ?? {}
    const { answers: userAnswers, time_spent_sec } = body

    if (!userAnswers || typeof userAnswers !== 'object') {
      res.status(400).json({ message: 'answers required' })
      return
    }

    const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [applicationId])
    const app = apps[0]

    if (!app || app.job_seeker_id !== u.userId) {
      res.status(404).json({ message: 'Not found' })
      return
    }

    const [attempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE application_id = ?', [applicationId])
    const attempt = attempts[0]
    
    if (!attempt || !attempt.answers) {
      res.status(400).json({ message: 'No active screening found' })
      return
    }

    const savedData = JSON.parse(attempt.answers) as { questions: QuestionTemplate[] }
    const questions = savedData.questions || []

    let totalScore = 0
    let maxPossibleScore = 0

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const ans = userAnswers[`q-${i}`]

      if (q.type === 'mcq') {
        maxPossibleScore += 1
        const selectedIdx = parseInt(ans, 10)
        if (!isNaN(selectedIdx) && selectedIdx === q.correctIndex) {
          totalScore += 1
        }
      } else if (q.type === 'coding') {
        maxPossibleScore += 10
        if (!ans || !ans.trim()) continue
        if (!q.testCases || q.testCases.length === 0) continue

        const funcName = getFuncName(q.content)
        const lang = ans.includes('def ') || ans.includes('import ') ? 'python' : 'javascript'
        const pistonLang = lang === 'javascript' ? 'javascript' : 'python'

        let allPassed = true
        for (const tc of q.testCases) {
          const source = prepareSource(lang, ans, tc.input, funcName)
          try {
            const runRes = await fetch('https://emkc.org/api/v2/piston/execute', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                language: pistonLang,
                version: '*',
                files: [{ content: source }]
              })
            })
            if (!runRes.ok) { allPassed = false; break; }
            const runData = await runRes.json()
            const output = (runData as any).run?.stdout?.trim() ?? ''
            const error = (runData as any).run?.stderr?.trim() ?? ''
            const passed = !error && (output === tc.expected || output === JSON.stringify(JSON.parse(tc.expected || 'null')))
            if (!passed) {
              allPassed = false
              break
            }
          } catch (e) {
            allPassed = false
            break
          }
        }

        if (allPassed) {
          totalScore += 10
        }
      }
    }

    const pct = maxPossibleScore > 0 ? Math.round((totalScore / maxPossibleScore) * 100) : 0
    const passed = pct >= 70

    await pool.query(
      'UPDATE ScreeningAttempt SET submitted_at = NOW(), score = ?, answers = ?, time_spent_sec = ? WHERE id = ?',
      [pct, JSON.stringify(userAnswers), time_spent_sec, attempt.id]
    )

    await pool.query(
      'UPDATE Application SET screening_at = NOW(), screening_score = ?, status = "screening_submitted" WHERE id = ?',
      [pct, applicationId]
    )

    res.json({
      score: pct,
      passed,
      status: 'screening_submitted',
    })

  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to submit screening' })
  }
})
