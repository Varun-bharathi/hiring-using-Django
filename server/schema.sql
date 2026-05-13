CREATE DATABASE IF NOT EXISTS hireflow;
USE hireflow;

CREATE TABLE User (
    id VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE RecruiterProfile (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    company VARCHAR(255),
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE
);

CREATE TABLE JobSeekerProfile (
    id VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    resume_url TEXT,
    resume_parsed TEXT,
    skills TEXT,
    experience TEXT,
    location VARCHAR(255),
    portfolio_urls TEXT,
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE
);

CREATE TABLE Job (
    id VARCHAR(255) PRIMARY KEY,
    recruiter_id VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    required_skills TEXT,
    experience_level VARCHAR(255),
    location VARCHAR(255),
    employment_type VARCHAR(255),
    status VARCHAR(50) DEFAULT 'draft',
    cutoff_score INT,
    screening_config TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (recruiter_id) REFERENCES User(id) ON DELETE CASCADE
);

CREATE TABLE Assessment (
    id VARCHAR(255) PRIMARY KEY,
    job_id VARCHAR(255),
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255),
    config TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES Job(id) ON DELETE CASCADE
);

CREATE TABLE Question (
    id VARCHAR(255) PRIMARY KEY,
    assessment_id VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    options TEXT,
    solution TEXT,
    max_score INT DEFAULT 1,
    order_index INT DEFAULT 0,
    FOREIGN KEY (assessment_id) REFERENCES Assessment(id) ON DELETE CASCADE
);

CREATE TABLE Application (
    id VARCHAR(255) PRIMARY KEY,
    job_id VARCHAR(255) NOT NULL,
    job_seeker_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'screening',
    resume_url TEXT,
    resume_parsed TEXT,
    resume_jd_match FLOAT,
    screening_score FLOAT,
    aptitude_score FLOAT,
    coding_score FLOAT,
    screening_at DATETIME,
    resume_submitted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES Job(id) ON DELETE CASCADE,
    FOREIGN KEY (job_seeker_id) REFERENCES User(id) ON DELETE CASCADE,
    UNIQUE (job_id, job_seeker_id)
);

CREATE TABLE ScreeningAttempt (
    id VARCHAR(255) PRIMARY KEY,
    application_id VARCHAR(255) NOT NULL,
    type VARCHAR(50) DEFAULT 'screening',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paused_at DATETIME,
    submitted_at DATETIME,
    score FLOAT,
    answers TEXT,
    time_spent_sec INT,
    FOREIGN KEY (application_id) REFERENCES Application(id) ON DELETE CASCADE
);
