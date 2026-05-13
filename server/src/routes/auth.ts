import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { pool } from '../lib/db.js'
import { authMiddleware, signToken, type AuthRequest } from '../middleware/auth.js'

export const authRouter = Router()

authRouter.post('/register/recruiter', async (req, res) => {
  try {
    const { email, password, full_name, company } = req.body as {
      email?: string
      password?: string
      full_name?: string
      company?: string
    }
    if (!email || !password || !full_name) {
      res.status(400).json({ message: 'email, password, and full_name required' })
      return
    }

    const [existingRows] = await pool.query<any[]>('SELECT * FROM User WHERE email = ?', [email])
    if (existingRows.length > 0) {
      res.status(409).json({ message: 'Email already registered' })
      return
    }

    const hash = await bcrypt.hash(password, 10)
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()

    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()

      await connection.query(
        'INSERT INTO User (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
        [userId, email, hash, 'recruiter']
      )

      await connection.query(
        'INSERT INTO RecruiterProfile (id, user_id, full_name, company, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
        [profileId, userId, full_name, company ?? null]
      )

      await connection.commit()
    } catch (err) {
      await connection.rollback()
      throw err
    } finally {
      connection.release()
    }

    const token = signToken({
      userId,
      email,
      role: 'recruiter',
    })
    res.status(201).json({
      token,
      user: { id: userId, email, role: 'recruiter' },
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Registration failed' })
  }
})

authRouter.post('/register/job-seeker', async (req, res) => {
  try {
    const { email, password, full_name } = req.body as {
      email?: string
      password?: string
      full_name?: string
    }
    if (!email || !password || !full_name) {
      res.status(400).json({ message: 'email, password, and full_name required' })
      return
    }

    const [existingRows] = await pool.query<any[]>('SELECT * FROM User WHERE email = ?', [email])
    if (existingRows.length > 0) {
      res.status(409).json({ message: 'Email already registered' })
      return
    }

    const hash = await bcrypt.hash(password, 10)
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()

    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()

      await connection.query(
        'INSERT INTO User (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
        [userId, email, hash, 'job_seeker']
      )

      await connection.query(
        'INSERT INTO JobSeekerProfile (id, user_id, full_name, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
        [profileId, userId, full_name]
      )

      await connection.commit()
    } catch (err) {
      await connection.rollback()
      throw err
    } finally {
      connection.release()
    }

    const token = signToken({
      userId,
      email,
      role: 'job_seeker',
    })
    res.status(201).json({
      token,
      user: { id: userId, email, role: 'job_seeker' },
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Registration failed' })
  }
})

authRouter.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body as {
      email?: string
      password?: string
      role?: 'recruiter' | 'job_seeker'
    }
    if (!email || !password || !role) {
      res.status(400).json({ message: 'email, password, and role required' })
      return
    }

    const [rows] = await pool.query<any[]>('SELECT * FROM User WHERE email = ?', [email])
    const user = rows[0]

    if (!user || user.role !== role) {
      res.status(401).json({ message: 'Invalid credentials' })
      return
    }

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) {
      res.status(401).json({ message: 'Invalid credentials' })
      return
    }

    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role as 'recruiter' | 'job_seeker',
    })
    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Login failed' })
  }
})

function parseJsonArray(s: string | null): string[] | null {
  if (!s) return null
  try {
    const arr = JSON.parse(s) as unknown
    return Array.isArray(arr) ? (arr as string[]) : null
  } catch {
    return null
  }
}

function meResponse(user: any, recruiterProfile: any, jobSeekerProfile: any) {
  return {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      recruiterProfile: recruiterProfile
        ? {
            full_name: recruiterProfile.full_name,
            company: recruiterProfile.company,
          }
        : null,
      jobSeekerProfile: jobSeekerProfile
        ? {
            full_name: jobSeekerProfile.full_name,
            skills: parseJsonArray(jobSeekerProfile.skills),
            experience: jobSeekerProfile.experience,
            location: jobSeekerProfile.location,
            portfolio_urls: parseJsonArray(jobSeekerProfile.portfolio_urls),
          }
        : null,
    },
  }
}

authRouter.get('/me', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const [userRows] = await pool.query<any[]>('SELECT * FROM User WHERE id = ?', [u.userId])
    const user = userRows[0]

    if (!user) {
      res.status(404).json({ message: 'User not found' })
      return
    }

    let recruiterProfile = null
    let jobSeekerProfile = null

    if (user.role === 'recruiter') {
      const [rpRows] = await pool.query<any[]>('SELECT * FROM RecruiterProfile WHERE user_id = ?', [user.id])
      recruiterProfile = rpRows[0] || null
    } else if (user.role === 'job_seeker') {
      const [jspRows] = await pool.query<any[]>('SELECT * FROM JobSeekerProfile WHERE user_id = ?', [user.id])
      jobSeekerProfile = jspRows[0] || null
    }

    res.json(meResponse(user, recruiterProfile, jobSeekerProfile))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to fetch profile' })
  }
})

authRouter.patch('/me', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const u = req.user!
    const body = (req.body as Record<string, unknown>) ?? {}
    
    const [userRows] = await pool.query<any[]>('SELECT * FROM User WHERE id = ?', [u.userId])
    const user = userRows[0]

    if (!user) {
      res.status(404).json({ message: 'User not found' })
      return
    }

    if (user.role === 'recruiter') {
      const full_name = body.full_name as string | undefined
      const company = body.company as string | null | undefined
      
      const updates = []
      const values = []
      if (typeof full_name === 'string') {
        updates.push('full_name = ?')
        values.push(full_name)
      }
      if (company !== undefined) {
        updates.push('company = ?')
        values.push(company ?? null)
      }

      if (updates.length > 0) {
        updates.push('updated_at = NOW()')
        values.push(user.id)
        await pool.query(`UPDATE RecruiterProfile SET ${updates.join(', ')} WHERE user_id = ?`, values)
      }
    } else if (user.role === 'job_seeker') {
      const full_name = body.full_name as string | undefined
      const skills = body.skills as string | undefined
      const experience = body.experience as string | undefined
      const location = body.location as string | undefined
      const portfolio_urls = body.portfolio_urls as string | string[] | undefined
      
      const skillsJson =
        typeof skills === 'string'
          ? JSON.stringify(skills.split(',').map((s) => s.trim()).filter(Boolean))
          : undefined
          
      let portfolioJson: string | undefined
      if (Array.isArray(portfolio_urls)) {
        portfolioJson = JSON.stringify(portfolio_urls)
      } else if (typeof portfolio_urls === 'string') {
        portfolioJson = JSON.stringify(
          portfolio_urls.split(',').map((s) => s.trim()).filter(Boolean)
        )
      }

      const updates = []
      const values = []
      if (typeof full_name === 'string') { updates.push('full_name = ?'); values.push(full_name); }
      if (skillsJson !== undefined) { updates.push('skills = ?'); values.push(skillsJson); }
      if (typeof experience === 'string') { updates.push('experience = ?'); values.push(experience); }
      if (typeof location === 'string') { updates.push('location = ?'); values.push(location); }
      if (portfolioJson !== undefined) { updates.push('portfolio_urls = ?'); values.push(portfolioJson); }

      if (updates.length > 0) {
        updates.push('updated_at = NOW()')
        values.push(user.id)
        await pool.query(`UPDATE JobSeekerProfile SET ${updates.join(', ')} WHERE user_id = ?`, values)
      }
    }

    let recruiterProfile = null
    let jobSeekerProfile = null
    if (user.role === 'recruiter') {
      const [rpRows] = await pool.query<any[]>('SELECT * FROM RecruiterProfile WHERE user_id = ?', [user.id])
      recruiterProfile = rpRows[0] || null
    } else if (user.role === 'job_seeker') {
      const [jspRows] = await pool.query<any[]>('SELECT * FROM JobSeekerProfile WHERE user_id = ?', [user.id])
      jobSeekerProfile = jspRows[0] || null
    }

    res.json(meResponse(user, recruiterProfile, jobSeekerProfile))
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: 'Failed to update profile' })
  }
})
