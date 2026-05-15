import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../lib/db.js'
import { authMiddleware, requireRole, type AuthRequest } from '../middleware/auth.js'

export const jobsRouter = Router()

jobsRouter.use(authMiddleware)

function parseSkills(s: unknown): string[] {
  if (Array.isArray(s)) return s.filter((x) => typeof x === 'string')
  if (typeof s === 'string') {
    return s
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return []
}

jobsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const isRecruiter = u.role === 'recruiter'
    
    let query = 'SELECT * FROM Job'
    const values: any[] = []
    
    if (isRecruiter) {
      query += ' WHERE recruiter_id = ?'
      values.push(u.userId)
    } else {
      query += ' WHERE status = ?'
      values.push('live')
    }
    
    query += ' ORDER BY updated_at DESC'
    
    const [jobs] = await pool.query<any[]>(query, values)
    
    const list = jobs.map((j) => ({
      id: j.id,
      recruiter_id: j.recruiter_id,
      title: j.title,
      description: j.description,
      required_skills: parseJsonArray(j.required_skills),
      experience_level: j.experience_level,
      location: j.location,
      employment_type: j.employment_type,
      status: j.status,
      cutoff_score: j.cutoff_score,
      created_at: new Date(j.created_at).toISOString(),
      updated_at: new Date(j.updated_at).toISOString(),
    }))
    res.json(list)
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to list jobs' })
  }
})

jobsRouter.post('/', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const body = req.body as Record<string, unknown>
    const skills = parseSkills(body.required_skills ?? body.skills)
    
    const jobId = crypto.randomUUID()
    const cutoffScore = typeof body.cutoff_score === 'number' ? body.cutoff_score : 70
    const screeningConfig = JSON.stringify({
      duration_minutes: 45,
      cutoff: cutoffScore,
    })
    
    const jobData = {
      id: jobId,
      recruiterId: u.userId,
      title: String(body.title ?? ''),
      description: String(body.description ?? ''),
      requiredSkills: JSON.stringify(skills),
      experienceLevel: (body.experience_level as string) ?? 'mid',
      location: (body.location as string) || null,
      employmentType: (body.employment_type as string) ?? 'full_time',
      status: 'draft',
      cutoffScore: cutoffScore,
      screeningConfig: screeningConfig,
      createdAt: new Date(),
      updatedAt: new Date()
    }
    
    await pool.query(
      `INSERT INTO Job (id, recruiter_id, title, description, required_skills, experience_level, location, employment_type, status, cutoff_score, screening_config, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [jobData.id, jobData.recruiterId, jobData.title, jobData.description, jobData.requiredSkills, jobData.experienceLevel, jobData.location, jobData.employmentType, jobData.status, jobData.cutoffScore, jobData.screeningConfig]
    )
    
    const prelim = await createPreliminaryAssessment(jobData.id, jobData.cutoffScore)
    res.status(201).json(toJobJson(jobData, prelim))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to create job' })
  }
})

jobsRouter.get('/:id/applications', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const jobId = req.params.id
    const [jobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ? AND recruiter_id = ?', [jobId, req.user!.userId])
    const job = jobs[0]
    
    if (!job) {
      res.status(404).json({ message: 'Job not found' })
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
      WHERE a.job_id = ?
      ORDER BY a.resume_jd_match DESC, a.screening_score DESC
    `
    const [rows] = await pool.query<any[]>(query, [jobId])
    
    res.json(
      rows.map((a) => ({
        id: a.id,
        job_id: a.job_id,
        job_seeker_id: a.job_seeker_id,
        status: a.status,
        resume_jd_match: a.resume_jd_match,
        resume_parsed: a.resume_parsed ? (JSON.parse(a.resume_parsed) as unknown) : undefined,
        screening_score: a.screening_score,
        aptitude_score: a.aptitude_score,
        coding_score: a.coding_score,
        screening_at: a.screening_at ? new Date(a.screening_at).toISOString() : undefined,
        resume_submitted_at: a.resume_submitted_at ? new Date(a.resume_submitted_at).toISOString() : undefined,
        created_at: new Date(a.created_at).toISOString(),
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
      }))
    )
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to list applications' })
  }
})

jobsRouter.post('/:id/apply', async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    if (u.role !== 'job_seeker') {
      res.status(403).json({ message: 'Forbidden' })
      return
    }
    const jobId = req.params.id
    const [jobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ?', [jobId])
    const job = jobs[0]
    
    if (!job || job.status !== 'live') {
      res.status(404).json({ message: 'Job not found or not open' })
      return
    }
    
    const [existingApps] = await pool.query<any[]>('SELECT * FROM Application WHERE job_id = ? AND job_seeker_id = ?', [jobId, u.userId])
    if (existingApps.length > 0) {
      res.status(409).json({ message: 'Already applied' })
      return
    }
    
    const appId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO Application (id, job_id, job_seeker_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [appId, jobId, u.userId, 'screening']
    )
    
    const [assessments] = await pool.query<any[]>('SELECT * FROM Assessment WHERE job_id = ? AND type = "preliminary"', [jobId])
    const prelim = assessments[0]
    
    let questions = []
    if (prelim) {
      const [qRows] = await pool.query<any[]>('SELECT * FROM Question WHERE assessment_id = ? ORDER BY order_index ASC', [prelim.id])
      questions = qRows
    }
    
    const config = prelim?.config ? (JSON.parse(prelim.config) as { duration_minutes?: number; cutoff?: number }) : {}
    
    res.status(201).json({
      application_id: appId,
      screening: prelim
        ? {
          assessment_id: prelim.id,
          duration_minutes: config.duration_minutes ?? 45,
          cutoff: config.cutoff ?? 70,
          questions: questions.map((q) => ({
            id: q.id,
            type: q.type,
            content: q.content,
            options: q.options ? (JSON.parse(q.options) as unknown) : undefined,
            max_score: q.max_score,
            order_index: q.order_index,
          })),
        }
        : null,
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to apply' })
  }
})

jobsRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const jobId = req.params.id
    const [jobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ?', [jobId])
    const job = jobs[0]
    
    if (!job) {
      res.status(404).json({ message: 'Job not found' })
      return
    }
    
    const [assessments] = await pool.query<any[]>('SELECT * FROM Assessment WHERE job_id = ? AND type = "preliminary"', [jobId])
    let prelim = assessments[0]
    
    if (prelim) {
      const [questions] = await pool.query<any[]>('SELECT * FROM Question WHERE assessment_id = ? ORDER BY order_index ASC', [prelim.id])
      prelim.questions = questions
    }
    
    const formattedJob = {
      id: job.id, recruiterId: job.recruiter_id, title: job.title, description: job.description, requiredSkills: job.required_skills, experienceLevel: job.experience_level, location: job.location, employmentType: job.employment_type, status: job.status, cutoffScore: job.cutoff_score, createdAt: new Date(job.created_at), updatedAt: new Date(job.updated_at)
    }
    
    res.json(toJobJson(formattedJob, prelim))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to fetch job' })
  }
})

jobsRouter.patch('/:id', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const jobId = req.params.id
    const [jobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ? AND recruiter_id = ?', [jobId, req.user!.userId])
    const job = jobs[0]
    
    if (!job) {
      res.status(404).json({ message: 'Job not found' })
      return
    }
    const body = req.body as Record<string, unknown>
    const skills = body.required_skills !== undefined ? parseSkills(body.required_skills) : undefined
    
    const updates = []
    const values = []
    
    if (body.title != null) { updates.push('title = ?'); values.push(String(body.title)); }
    if (body.description != null) { updates.push('description = ?'); values.push(String(body.description)); }
    if (skills != null) { updates.push('required_skills = ?'); values.push(JSON.stringify(skills)); }
    if (body.experience_level != null) { updates.push('experience_level = ?'); values.push(String(body.experience_level)); }
    if (body.location != null) { updates.push('location = ?'); values.push(body.location || null); }
    if (body.employment_type != null) { updates.push('employment_type = ?'); values.push(String(body.employment_type)); }
    if (body.status != null) { updates.push('status = ?'); values.push(String(body.status)); }
    if (typeof body.cutoff_score === 'number') { updates.push('cutoff_score = ?'); values.push(body.cutoff_score); }
    
    if (updates.length > 0) {
      updates.push('updated_at = NOW()')
      values.push(jobId)
      await pool.query(`UPDATE Job SET ${updates.join(', ')} WHERE id = ?`, values)
    }
    
    const [updatedJobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ?', [jobId])
    const updatedJob = updatedJobs[0]
    
    const formattedJob = {
      id: updatedJob.id, recruiterId: updatedJob.recruiter_id, title: updatedJob.title, description: updatedJob.description, requiredSkills: updatedJob.required_skills, experienceLevel: updatedJob.experience_level, location: updatedJob.location, employmentType: updatedJob.employment_type, status: updatedJob.status, cutoffScore: updatedJob.cutoff_score, createdAt: new Date(updatedJob.created_at), updatedAt: new Date(updatedJob.updated_at)
    }

    const [assessments] = await pool.query<any[]>('SELECT * FROM Assessment WHERE job_id = ? AND type = "preliminary"', [jobId])
    let prelim = assessments[0]
    
    if (prelim) {
      const [questions] = await pool.query<any[]>('SELECT * FROM Question WHERE assessment_id = ? ORDER BY order_index ASC', [prelim.id])
      prelim.questions = questions
    }

    res.json(toJobJson(formattedJob, prelim))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to update job' })
  }
})

jobsRouter.delete('/:id', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const jobId = req.params.id
    const [jobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ? AND recruiter_id = ?', [jobId, req.user!.userId])
    const job = jobs[0]
    if (!job) {
      res.status(404).json({ message: 'Job not found' })
      return
    }
    await pool.query('DELETE q FROM Question q JOIN Assessment a ON q.assessment_id = a.id WHERE a.job_id = ?', [jobId])
    await pool.query('DELETE FROM Assessment WHERE job_id = ?', [jobId])
    await pool.query('DELETE sa FROM ScreeningAttempt sa JOIN Application app ON sa.application_id = app.id WHERE app.job_id = ?', [jobId])
    await pool.query('DELETE FROM Application WHERE job_id = ?', [jobId])
    await pool.query('DELETE FROM Job WHERE id = ?', [jobId])
    res.status(204).send()
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to delete job' })
  }
})

jobsRouter.post('/:id/publish', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const jobId = req.params.id
    const [jobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ? AND recruiter_id = ?', [jobId, req.user!.userId])
    const job = jobs[0]
    if (!job) {
      res.status(404).json({ message: 'Job not found' })
      return
    }
    await pool.query('UPDATE Job SET status = "live", updated_at = NOW() WHERE id = ?', [jobId])
    
    const [updatedJobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ?', [jobId])
    const updatedJob = updatedJobs[0]
    const formattedJob = {
      id: updatedJob.id, recruiterId: updatedJob.recruiter_id, title: updatedJob.title, description: updatedJob.description, requiredSkills: updatedJob.required_skills, experienceLevel: updatedJob.experience_level, location: updatedJob.location, employmentType: updatedJob.employment_type, status: updatedJob.status, cutoffScore: updatedJob.cutoff_score, createdAt: new Date(updatedJob.created_at), updatedAt: new Date(updatedJob.updated_at)
    }
    
    res.json(toJobJson(formattedJob))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to publish job' })
  }
})

jobsRouter.post('/:id/ai/generate-questions', requireRole('recruiter'), async (req: AuthRequest, res) => {
  try {
    const jobId = req.params.id
    const [jobs] = await pool.query<any[]>('SELECT * FROM Job WHERE id = ? AND recruiter_id = ?', [jobId, req.user!.userId])
    const job = jobs[0]
    if (!job) {
      res.status(404).json({ message: 'Job not found' })
      return
    }
    
    const [assessments] = await pool.query<any[]>('SELECT * FROM Assessment WHERE job_id = ? AND type = "preliminary"', [jobId])
    const prelim = assessments[0]
    if (!prelim) {
      res.status(400).json({ message: 'No preliminary assessment for this job' })
      return
    }
    
    await pool.query('DELETE FROM Question WHERE assessment_id = ?', [prelim.id])
    
    const mcqPool: { content: string; options: string[]; correct: number }[] = [
      { content: 'What is the time complexity of binary search on a sorted array?', options: ['O(n)', 'O(n²)', 'O(log n)', 'O(1)'], correct: 2 },
      { content: 'Which hook is used to perform side effects in React?', options: ['useState', 'useEffect', 'useContext', 'useMemo'], correct: 1 },
      { content: 'What does REST stand for?', options: ['Representational State Transfer', 'Remote State Transfer', 'Resource State Transfer', 'Representative State Transfer'], correct: 0 },
      { content: 'Which HTTP method is idempotent?', options: ['POST', 'PUT', 'PATCH', 'DELETE'], correct: 1 },
      { content: 'What is a primary key?', options: ['A unique identifier for a row', 'A foreign key', 'An index', 'A constraint'], correct: 0 },
      { content: 'Which is not a JavaScript data type?', options: ['undefined', 'symbol', 'integer', 'bigint'], correct: 2 },
      { content: 'What does CSS stand for?', options: ['Cascading Style Sheets', 'Computer Style Sheets', 'Creative Style Sheets', 'Color Style Sheets'], correct: 0 },
      { content: 'What is Git?', options: ['A version control system', 'A programming language', 'An OS', 'A database'], correct: 0 },
      { content: 'What is the default port for HTTPS?', options: ['80', '443', '8080', '8443'], correct: 1 },
      { content: 'Which structure ensures FIFO order?', options: ['Stack', 'Queue', 'Array', 'Hash map'], correct: 1 },
      { content: 'What does SQL stand for?', options: ['Structured Query Language', 'Simple Query Language', 'Standard Query Language', 'Sequential Query Language'], correct: 0 },
      { content: 'Which keyword declares a block-scoped variable in JS?', options: ['var', 'let', 'const', 'Both let and const'], correct: 3 },
    ]
    const codingPool: { content: string; solution: string }[] = [
      { content: 'Implement a function `fib(n)` that returns the n-th Fibonacci number. Assume n >= 0.', solution: 'function fib(n) { if (n <= 1) return n; return fib(n-1) + fib(n-2); }' },
      { content: 'Implement `isPrime(n)` returning true if n is prime, false otherwise. Assume n >= 2.', solution: 'function isPrime(n) { for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; }' },
    ]
    
    let orderIndex = 0
    for (let i = 0; i < 8; i++) {
      const m = mcqPool[i]!
      const options = m.options.map((text, idx) => ({ id: `opt-${idx}`, text, correct: idx === m.correct }))
      await pool.query(
        'INSERT INTO Question (id, assessment_id, type, content, options, max_score, order_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), prelim.id, 'mcq', m.content, JSON.stringify(options), 1, orderIndex++]
      )
    }
    for (let i = 0; i < 2; i++) {
      const c = codingPool[i]!
      await pool.query(
        'INSERT INTO Question (id, assessment_id, type, content, solution, max_score, order_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), prelim.id, 'coding', c.content, c.solution, 2, orderIndex++]
      )
    }
    const count = 10
    res.json({ count, message: `Generated ${count} screening questions (8 MCQ, 2 coding).` })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to generate questions' })
  }
})

async function createPreliminaryAssessment(jobId: string, cutoff: number) {
  const assessmentId = crypto.randomUUID()
  await pool.query(
    'INSERT INTO Assessment (id, job_id, type, title, config, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [assessmentId, jobId, 'preliminary', 'Preliminary Screening', JSON.stringify({ duration_minutes: 45, cutoff })]
  )
  
  const mcq = [
    { content: 'What is the time complexity of binary search on a sorted array?', options: ['O(n)', 'O(n²)', 'O(log n)', 'O(1)'], correct: 2 },
    { content: 'Which hook is used to perform side effects in React?', options: ['useState', 'useEffect', 'useContext', 'useMemo'], correct: 1 },
    { content: 'What does REST stand for?', options: ['Representational State Transfer', 'Remote State Transfer', 'Resource State Transfer', 'Representative State Transfer'], correct: 0 },
    { content: 'Which HTTP method is idempotent?', options: ['POST', 'PUT', 'PATCH', 'DELETE'], correct: 1 },
    { content: 'What is a primary key?', options: ['A unique identifier for a row', 'A foreign key', 'An index', 'A constraint'], correct: 0 },
    { content: 'Which is not a JavaScript data type?', options: ['undefined', 'symbol', 'integer', 'bigint'], correct: 2 },
    { content: 'What does CSS stand for?', options: ['Cascading Style Sheets', 'Computer Style Sheets', 'Creative Style Sheets', 'Color Style Sheets'], correct: 0 },
    { content: 'What is Git?', options: ['A version control system', 'A programming language', 'An OS', 'A database'], correct: 0 },
  ]
  
  for (let i = 0; i < mcq.length; i++) {
    const m = mcq[i]!
    const options = m.options.map((text, idx) => ({
      id: `opt-${idx}`,
      text,
      correct: idx === m.correct,
    }))
    await pool.query(
      'INSERT INTO Question (id, assessment_id, type, content, options, max_score, order_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), assessmentId, 'mcq', m.content, JSON.stringify(options), 1, i]
    )
  }
  await pool.query(
    'INSERT INTO Question (id, assessment_id, type, content, solution, max_score, order_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), assessmentId, 'coding', 'Implement a function `fib(n)` that returns the n-th Fibonacci number. Assume n >= 0.', 'function fib(n) { if (n <= 1) return n; return fib(n-1) + fib(n-2); }', 2, mcq.length]
  )
  
  const [assessments] = await pool.query<any[]>('SELECT * FROM Assessment WHERE id = ?', [assessmentId])
  const a = assessments[0]
  if (a) {
    const [questions] = await pool.query<any[]>('SELECT * FROM Question WHERE assessment_id = ? ORDER BY order_index ASC', [assessmentId])
    a.questions = questions
  }
  return a
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return []
  try {
    const a = JSON.parse(s)
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toJobJson(job: any, prelim?: any | null) {
  const config = prelim?.config ? (JSON.parse(prelim.config) as { duration_minutes?: number; cutoff?: number }) : {}
  const questions = (prelim?.questions ?? []).map((q: any) => ({
    id: q.id,
    assessment_id: prelim?.id ?? '',
    type: q.type,
    content: q.content,
    options: q.options ? (JSON.parse(q.options) as unknown) : undefined,
    solution: q.solution ?? undefined,
    max_score: q.max_score,
    order_index: q.order_index,
  }))
  return {
    id: job.id,
    recruiter_id: job.recruiterId,
    title: job.title,
    description: job.description,
    required_skills: parseJsonArray(job.requiredSkills),
    experience_level: job.experienceLevel,
    location: job.location,
    employment_type: job.employmentType,
    status: job.status,
    cutoff_score: job.cutoffScore,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
    screening: prelim
      ? {
        assessment_id: prelim.id,
        duration_minutes: config.duration_minutes ?? 45,
        cutoff: config.cutoff ?? 70,
        questions,
      }
      : undefined,
  }
}
