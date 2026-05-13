import type { Request } from 'express'
import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import multer from 'multer'
import crypto from 'crypto'
import { pool } from '../lib/db.js'
import { authMiddleware, requireRole, type AuthRequest } from '../middleware/auth.js'
import { QUESTION_POOL, type QuestionTemplate } from '../lib/questionBank.js'
import { APTITUDE_POOL } from '../lib/aptitudeQuestions.js'
import { CODING_POOL } from '../lib/codingQuestions.js'

export const applicationsRouter = Router()

const uploadsDir = path.join(process.cwd(), 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

interface MulterFile {
  originalname: string
  mimetype: string
}

const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: (
      _req: Request,
      _file: MulterFile,
      cb: (e: Error | null, d: string) => void
    ) => cb(null, uploadsDir),
    filename: (req: Request, file: MulterFile, cb: (e: Error | null, n: string) => void) => {
      const ext = path.extname(file.originalname) || '.pdf'
      const id = (req.params as { id?: string }).id ?? 'unknown'
      cb(null, `resume-${id}-${Date.now()}${ext}`)
    },
  }),
  fileFilter: (
    _req: Request,
    file: MulterFile,
    cb: (e: Error | null, accept?: boolean) => void
  ) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]
    if (allowed.includes(file.mimetype)) cb(null, true)
    else cb(new Error('Only PDF and DOC/DOCX are allowed'))
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
})

applicationsRouter.use(authMiddleware)

function parseJsonArray(s: string | null): string[] {
  if (!s) return []
  try {
    const a = JSON.parse(s)
    return Array.isArray(a) ? a.filter((x: unknown) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function appToJson(a: any, role?: string) {
  const isRecruiter = role === 'recruiter'

  return {
    id: a.id,
    job_id: a.job_id,
    job_seeker_id: a.job_seeker_id,
    status: a.status,
    resume_url: a.resume_url,
    resume_parsed: a.resume_parsed ? (JSON.parse(a.resume_parsed) as unknown) : undefined,
    resume_jd_match: a.resume_jd_match,
    screening_score: isRecruiter ? a.screening_score : undefined,
    aptitude_score: isRecruiter ? a.aptitude_score : undefined,
    coding_score: isRecruiter ? a.coding_score : undefined,
    screening_at: a.screening_at ? new Date(a.screening_at).toISOString() : undefined,
    resume_submitted_at: a.resume_submitted_at ? new Date(a.resume_submitted_at).toISOString() : undefined,
    created_at: new Date(a.created_at).toISOString(),
    updated_at: new Date(a.updated_at).toISOString(),
    job: {
      id: a.job_id,
      title: a.job_title,
      location: a.job_location,
      employment_type: a.job_employment_type,
      required_skills: parseJsonArray(a.job_required_skills),
    },
    job_seeker: {
      full_name: a.seeker_full_name ?? a.seeker_email,
      email: a.seeker_email,
    }
  }
}

applicationsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    if (u.role !== 'job_seeker') {
      res.status(403).json({ message: 'Forbidden' })
      return
    }
    const query = `
      SELECT 
        a.*,
        j.title as job_title, j.location as job_location, j.employment_type as job_employment_type, j.required_skills as job_required_skills,
        u.email as seeker_email,
        p.full_name as seeker_full_name
      FROM Application a
      JOIN Job j ON a.job_id = j.id
      JOIN User u ON a.job_seeker_id = u.id
      LEFT JOIN JobSeekerProfile p ON u.id = p.user_id
      WHERE a.job_seeker_id = ?
      ORDER BY a.updated_at DESC
    `
    const [rows] = await pool.query<any[]>(query, [u.userId])
    res.json(rows.map((a) => appToJson(a, u.role)))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to list applications' })
  }
})

applicationsRouter.post(
  '/:id/resume',
  requireRole('job_seeker'),
  resumeUpload.single('resume'),
  async (req: AuthRequest, res) => {
    try {
      const u = req.user!
      const { id } = req.params
      const file = (req as unknown as { file?: { path: string; filename: string; mimetype: string; originalname: string } }).file
      if (!file) {
        res.status(400).json({ message: 'Resume file (PDF/DOC/DOCX) required' })
        return
      }

      const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [id])
      const app = apps[0]

      if (!app || app.job_seeker_id !== u.userId) {
        res.status(404).json({ message: 'Application not found' })
        return
      }
      if (app.status !== 'passed_screening' && app.status !== 'accepted') {
        res.status(400).json({ message: 'Resume upload only allowed after passing screening or being accepted' })
        return
      }
      const resumeUrl = `/api/uploads/${file.filename}`

      let matchScore = 0
      let resumeSummary = 'Parsed via Python Service'

      try {
        const [jobs] = await pool.query<any[]>('SELECT description FROM Job WHERE id = ?', [app.job_id])
        const jobDesc = jobs[0]?.description || ''

        const fileBuffer = fs.readFileSync(path.join(uploadsDir, file.filename))
        const blob = new Blob([fileBuffer], { type: file.mimetype })

        const formData = new FormData()
        formData.append('resume', blob, file.originalname)
        formData.append('job_description', jobDesc)

        const pyRes = await fetch('http://localhost:5001/parse-resume', {
          method: 'POST',
          body: formData
        })

        if (pyRes.ok) {
          const pyData = await pyRes.json() as any
          matchScore = pyData.resume_score ?? 0
          if (pyData.extracted_text_preview) {
            resumeSummary = pyData.extracted_text_preview
          }
        }
      } catch (err) {
        console.error('Failed to call Resume Parser API:', err)
      }

      const resumeParsed = JSON.stringify({
        skills: [],
        experience: 'Analyzed by AI',
        summary: resumeSummary,
      })

      await pool.query(
        'UPDATE Application SET resume_url = ?, resume_parsed = ?, resume_jd_match = ?, status = ?, resume_submitted_at = NOW(), updated_at = NOW() WHERE id = ?',
        [resumeUrl, resumeParsed, matchScore, 'resume_submitted', id]
      )

      const [updatedApps] = await pool.query<any[]>(`
        SELECT 
          a.*,
          j.title as job_title, j.location as job_location, j.employment_type as job_employment_type, j.required_skills as job_required_skills,
          u.email as seeker_email,
          p.full_name as seeker_full_name
        FROM Application a
        JOIN Job j ON a.job_id = j.id
        JOIN User u ON a.job_seeker_id = u.id
        LEFT JOIN JobSeekerProfile p ON u.id = p.user_id
        WHERE a.id = ?
      `, [id])

      res.json(appToJson(updatedApps[0]))
    } catch (e) {
      console.error(e)
      res.status(500).json({ message: e instanceof Error ? e.message : 'Failed to upload resume' })
    }
  }
)

applicationsRouter.patch('/:id/accept', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { id } = req.params

    const [rows] = await pool.query<any[]>(`
      SELECT a.*, j.recruiter_id 
      FROM Application a 
      JOIN Job j ON a.job_id = j.id 
      WHERE a.id = ?
    `, [id])
    const app = rows[0]

    if (!app || app.recruiter_id !== u.userId) {
      res.status(404).json({ message: 'Application not found' })
      return
    }

    const newStatus =
      app.status === 'screening' || app.status === 'screening_submitted'
        ? 'passed_screening'
        : app.status === 'resume_submitted'
          ? 'shortlisted'
          : app.status === 'assessment_completed'
            ? 'passed_aptitude'
            : app.status === 'coding_completed'
              ? 'passed_coding'
              : app.status === 'passed_coding'
                ? 'interview_scheduled'
                : 'accepted'

    await pool.query('UPDATE Application SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, id])

    const [updatedApps] = await pool.query<any[]>(`
      SELECT 
        a.*,
        j.title as job_title, j.location as job_location, j.employment_type as job_employment_type, j.required_skills as job_required_skills,
        u.email as seeker_email,
        p.full_name as seeker_full_name
      FROM Application a
      JOIN Job j ON a.job_id = j.id
      JOIN User u ON a.job_seeker_id = u.id
      LEFT JOIN JobSeekerProfile p ON u.id = p.user_id
      WHERE a.id = ?
    `, [id])

    res.json(appToJson(updatedApps[0]))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to accept' })
  }
})

applicationsRouter.patch('/:id/reject', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { id } = req.params

    const [rows] = await pool.query<any[]>(`
      SELECT a.*, j.recruiter_id 
      FROM Application a 
      JOIN Job j ON a.job_id = j.id 
      WHERE a.id = ?
    `, [id])
    const app = rows[0]

    if (!app || app.recruiter_id !== u.userId) {
      res.status(404).json({ message: 'Application not found' })
      return
    }

    await pool.query('UPDATE Application SET status = "rejected", updated_at = NOW() WHERE id = ?', [id])

    const [updatedApps] = await pool.query<any[]>(`
      SELECT 
        a.*,
        j.title as job_title, j.location as job_location, j.employment_type as job_employment_type, j.required_skills as job_required_skills,
        u.email as seeker_email,
        p.full_name as seeker_full_name
      FROM Application a
      JOIN Job j ON a.job_id = j.id
      JOIN User u ON a.job_seeker_id = u.id
      LEFT JOIN JobSeekerProfile p ON u.id = p.user_id
      WHERE a.id = ?
    `, [id])

    res.json(appToJson(updatedApps[0]))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to reject' })
  }
})

applicationsRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const [rows] = await pool.query<any[]>(`
      SELECT 
        a.*,
        j.recruiter_id, j.title as job_title, j.location as job_location, j.employment_type as job_employment_type, j.required_skills as job_required_skills,
        u.email as seeker_email,
        p.full_name as seeker_full_name
      FROM Application a
      JOIN Job j ON a.job_id = j.id
      JOIN User u ON a.job_seeker_id = u.id
      LEFT JOIN JobSeekerProfile p ON u.id = p.user_id
      WHERE a.id = ?
    `, [req.params.id])

    const app = rows[0]

    if (!app) {
      res.status(404).json({ message: 'Application not found' })
      return
    }
    const canAccess =
      u.role === 'job_seeker'
        ? app.job_seeker_id === u.userId
        : u.role === 'recruiter' && app.recruiter_id === u.userId
    if (!canAccess) {
      res.status(403).json({ message: 'Forbidden' })
      return
    }
    res.json(appToJson(app, u.role))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to fetch application' })
  }
})

function getRandomQuestions(): QuestionTemplate[] {
  const categories = ['Data Structures', 'DBMS', 'Software Testing', 'Debugging', 'Cloud Computing', 'Leetcode'] as const
  const selected: QuestionTemplate[] = []

  categories.forEach((cat) => {
    const pool = QUESTION_POOL.filter((q) => q.category === cat)
    const shuffled = pool.sort(() => 0.5 - Math.random())
    selected.push(...shuffled.slice(0, 2))
  })

  return selected
}

applicationsRouter.patch('/:id/assessment/send', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { id } = req.params
    const [rows] = await pool.query<any[]>('SELECT a.*, j.recruiter_id FROM Application a JOIN Job j ON a.job_id = j.id WHERE a.id = ?', [id])
    const app = rows[0]

    if (!app || app.recruiter_id !== u.userId) {
      res.status(404).json({ message: 'Application not found' })
      return
    }
    await pool.query('UPDATE Application SET status = "assessment_sent", updated_at = NOW() WHERE id = ?', [id])

    const [updatedApps] = await pool.query<any[]>(`
      SELECT 
        a.*,
        j.title as job_title, j.location as job_location, j.employment_type as job_employment_type, j.required_skills as job_required_skills,
        u.email as seeker_email,
        p.full_name as seeker_full_name
      FROM Application a
      JOIN Job j ON a.job_id = j.id
      JOIN User u ON a.job_seeker_id = u.id
      LEFT JOIN JobSeekerProfile p ON u.id = p.user_id
      WHERE a.id = ?
    `, [id])

    res.json(appToJson(updatedApps[0]))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to send assessment' })
  }
})

applicationsRouter.post('/:id/assessment/start', requireRole('job_seeker'), async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { id } = req.params
    const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [id])
    const app = apps[0]
    if (!app || app.job_seeker_id !== u.userId) {
      res.status(404).json({ message: 'Application not found' })
      return
    }

    const [attempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE application_id = ? AND type = "aptitude"', [id])
    let attempt = attempts[0]

    if (!attempt) {
      const verbal = APTITUDE_POOL.filter(q => q.category === 'Verbal').sort(() => 0.5 - Math.random()).slice(0, 3)
      const quant = APTITUDE_POOL.filter(q => q.category === 'Quantitative').sort(() => 0.5 - Math.random()).slice(0, 4)
      const reasoning = APTITUDE_POOL.filter(q => q.category === 'Logical Reasoning').sort(() => 0.5 - Math.random()).slice(0, 3)
      const questions = [...verbal, ...quant, ...reasoning]

      const attemptId = crypto.randomUUID()
      await pool.query(
        'INSERT INTO ScreeningAttempt (id, application_id, type, answers, started_at) VALUES (?, ?, ?, ?, NOW())',
        [attemptId, id, 'aptitude', JSON.stringify({ questions, userAnswers: {} })]
      )

      const [newAttempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE id = ?', [attemptId])
      attempt = newAttempts[0]
    }

    const data = attempt.answers ? JSON.parse(attempt.answers) : {}
    const questions = data.questions || []

    res.json({
      attemptId: attempt.id,
      questions: questions.map((q: QuestionTemplate, idx: number) => ({
        id: `q-${idx}`,
        content: q.content,
        options: q.options?.map((text, i) => ({ id: i.toString(), text })),
        type: q.type,
        category: q.category
      })),
      duration_minutes: 60,
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to start assessment' })
  }
})

applicationsRouter.post('/:id/assessment/submit', requireRole('job_seeker'), async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { id } = req.params
    const { answers } = req.body

    const [attempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE application_id = ? AND type = "aptitude"', [id])
    const attempt = attempts[0]
    if (!attempt) {
      res.status(404).json({ message: 'Assessment not found' })
      return
    }
    const data = JSON.parse(attempt.answers as string)
    const questions = data.questions as QuestionTemplate[]

    let score = 0
    questions.forEach((q, idx) => {
      const userAns = answers[idx.toString()]
      if (userAns !== undefined && userAns === q.correctIndex) {
        score += 1
      }
    })

    await pool.query(
      'UPDATE ScreeningAttempt SET submitted_at = NOW(), score = ?, answers = ? WHERE id = ?',
      [score, JSON.stringify({ ...data, userAnswers: answers }), attempt.id]
    )

    await pool.query(
      'UPDATE Application SET aptitude_score = ?, status = "assessment_completed", updated_at = NOW() WHERE id = ?',
      [score, id]
    )

    res.json({ message: 'Assessment submitted successfully' })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to submit' })
  }
})

applicationsRouter.post(
  '/:id/screening/start',
  requireRole('job_seeker'),
  async (req: AuthRequest, res) => {
    try {
      const u = req.user!
      const { id } = req.params

      const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [id])
      const app = apps[0]
      if (!app || app.job_seeker_id !== u.userId) {
        res.status(404).json({ message: 'Application not found' })
        return
      }

      const [attempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE application_id = ? AND type = "screening"', [id])
      let attempt = attempts[0]

      if (!attempt) {
        const questions = getRandomQuestions()
        const initialData = {
          questions,
          userAnswers: {}
        }

        const attemptId = crypto.randomUUID()
        await pool.query(
          'INSERT INTO ScreeningAttempt (id, application_id, type, answers, started_at) VALUES (?, ?, ?, ?, NOW())',
          [attemptId, id, 'screening', JSON.stringify(initialData)]
        )
        const [newAttempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE id = ?', [attemptId])
        attempt = newAttempts[0]
      }

      const data = attempt.answers ? JSON.parse(attempt.answers) : {}
      const questions = data.questions || []

      res.json({
        attemptId: attempt.id,
        questions: questions.map((q: QuestionTemplate, idx: number) => ({
          id: `q-${idx}`,
          ...q,
          solution: undefined,
          correctIndex: undefined,
          options: q.options?.map((text, i) => ({ id: i.toString(), text })),
        })),
        duration_minutes: 45,
        cutoff: 70,
      })

    } catch (e) {
      console.error(e)
      res.status(500).json({ message: 'Failed to start screening' })
    }
  }
)

export function prepareSource(lang: string, userCode: string, input: string, funcName: string): string {
  if (lang === 'javascript') {
    return `${userCode}\ntry {\n  const result = ${funcName}(${input});\n  console.log(JSON.stringify(result));\n} catch(e) { console.error(e.message); }`
  }
  if (lang === 'python') {
    let pyInput = input.replace(/true/g, 'True').replace(/false/g, 'False').replace(/null/g, 'None')
    return `${userCode}\nimport json\ntry:\n    result = ${funcName}(${pyInput})\n    print(json.dumps(result))\nexcept Exception as e:\n    print(str(e))`
  }
  return userCode
}

export function getFuncName(content: string): string {
  if (content.includes('Two Sum')) return 'twoSum'
  if (content.includes('Palindrome')) return 'isPalindrome'
  if (content.includes('Reverse String')) return 'reverseString'
  if (content.includes('FizzBuzz')) return 'fizzBuzz'
  if (content.includes('Subarray Sum Equals K')) return 'subarraySum'
  if (content.includes('Subarray Sums Divisible by K')) return 'subarraysDivByK'
  if (content.includes('Maximum Average Subarray I')) return 'findMaxAverage'
  if (content.includes('Find Subarrays With Equal Sum')) return 'findSubarrays'
  return 'solution'
}

applicationsRouter.post(
  '/:id/screening/run-code',
  requireRole('job_seeker'),
  async (req: AuthRequest, res) => {
    try {
      const { id } = req.params
      const { questionId, code, language, type } = req.body as { questionId: string; code: string; language: string; type?: string }

      let query = 'SELECT * FROM ScreeningAttempt WHERE application_id = ?'
      const values: any[] = [id]
      if (type) {
        query += ' AND type = ?'
        values.push(type)
      }
      query += ' ORDER BY started_at DESC LIMIT 1'

      const [attempts] = await pool.query<any[]>(query, values)
      const attempt = attempts[0]

      if (!attempt || !attempt.answers) {
        res.status(404).json({ message: 'Assessment not found' })
        return
      }

      const data = JSON.parse(attempt.answers)
      const qIndex = parseInt(questionId.replace('q-', ''), 10)
      const question = data.questions[qIndex] as QuestionTemplate

      if (!question || !question.testCases) {
        res.status(400).json({ message: 'Question does not have test cases' })
        return
      }

      const results = []
      const funcName = getFuncName(question.content)
      const pistonLang = language === 'javascript' ? 'javascript' : language === 'python' ? 'python' : language

      for (const tc of question.testCases) {
        const source = prepareSource(language, code, tc.input, funcName)

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

          if (!runRes.ok) throw new Error('Piston error')

          const runData = await runRes.json()
          const output = (runData as any).run?.stdout?.trim() ?? ''
          const error = (runData as any).run?.stderr?.trim() ?? ''

          const passed = !error && (output === tc.expected || output === JSON.stringify(JSON.parse(tc.expected)))

          results.push({ input: tc.input, expected: tc.expected, output: error || output, passed })
        } catch (err) {
          results.push({ input: tc.input, expected: tc.expected, output: 'Error executing code', passed: false })
        }
      }

      res.json({ results })
    } catch (e) {
      console.error(e)
      res.status(500).json({ message: 'Failed to run code' })
    }
  }
)

applicationsRouter.patch('/:id/coding-assessment/send', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { id } = req.params
    const [rows] = await pool.query<any[]>('SELECT a.*, j.recruiter_id FROM Application a JOIN Job j ON a.job_id = j.id WHERE a.id = ?', [id])
    const app = rows[0]

    if (!app || app.recruiter_id !== u.userId) {
      res.status(404).json({ message: 'Application not found' })
      return
    }
    await pool.query('UPDATE Application SET status = "coding_sent", updated_at = NOW() WHERE id = ?', [id])

    const [updatedApps] = await pool.query<any[]>(`
      SELECT 
        a.*,
        j.title as job_title, j.location as job_location, j.employment_type as job_employment_type, j.required_skills as job_required_skills,
        u.email as seeker_email,
        p.full_name as seeker_full_name
      FROM Application a
      JOIN Job j ON a.job_id = j.id
      JOIN User u ON a.job_seeker_id = u.id
      LEFT JOIN JobSeekerProfile p ON u.id = p.user_id
      WHERE a.id = ?
    `, [id])

    res.json(appToJson(updatedApps[0]))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to send coding assessment' })
  }
})

applicationsRouter.post('/:id/coding-assessment/start', requireRole('job_seeker'), async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const { id } = req.params
    const [apps] = await pool.query<any[]>('SELECT * FROM Application WHERE id = ?', [id])
    const app = apps[0]
    if (!app || app.job_seeker_id !== u.userId) {
      res.status(404).json({ message: 'Application not found' })
      return
    }

    const [attempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE application_id = ? AND type = "coding"', [id])
    let attempt = attempts[0]

    if (!attempt) {
      const shuffled = CODING_POOL.sort(() => 0.5 - Math.random())
      const questions = shuffled.slice(0, 2)

      const attemptId = crypto.randomUUID()
      await pool.query(
        'INSERT INTO ScreeningAttempt (id, application_id, type, answers, started_at) VALUES (?, ?, ?, ?, NOW())',
        [attemptId, id, 'coding', JSON.stringify({ questions, userAnswers: {} })]
      )
      const [newAttempts] = await pool.query<any[]>('SELECT * FROM ScreeningAttempt WHERE id = ?', [attemptId])
      attempt = newAttempts[0]
    }

    const data = attempt.answers ? JSON.parse(attempt.answers) : {}
    const questions = data.questions || []

    res.json({
      attemptId: attempt.id,
      questions: questions.map((q: QuestionTemplate, idx: number) => ({
        id: `q-${idx}`,
        content: q.content,
        type: 'coding',
      })),
      duration_minutes: 60,
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to start coding assessment' })
  }
})
