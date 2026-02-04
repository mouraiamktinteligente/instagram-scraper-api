-- Migration: Self-Healing System Tables
-- Creates tables for selector versioning, health monitoring, and page fingerprinting

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Table: selector_versions
-- Stores version history of discovered selectors
-- ============================================
CREATE TABLE IF NOT EXISTS selector_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    selector_name VARCHAR(100) NOT NULL,
    selector_context VARCHAR(50) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    primary_selector TEXT NOT NULL,
    fallback_selectors JSONB,
    discovered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    discovered_by VARCHAR(50), -- 'manual', 'ai_gpt4', 'ai_claude', 'vision', 'generic_fallback'
    confidence_score FLOAT,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    replaced_at TIMESTAMP WITH TIME ZONE,
    replaced_reason TEXT,
    page_fingerprint_hash VARCHAR(64),

    UNIQUE(selector_name, selector_context, version)
);

-- Index for fast queries on active selectors
CREATE INDEX IF NOT EXISTS idx_selector_versions_active
ON selector_versions(selector_name, selector_context, is_active);

-- Index for version history queries
CREATE INDEX IF NOT EXISTS idx_selector_versions_history
ON selector_versions(selector_name, selector_context, version DESC);

-- ============================================
-- Table: selector_health_metrics
-- Stores health metrics for selectors
-- ============================================
CREATE TABLE IF NOT EXISTS selector_health_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    selector_name VARCHAR(100) NOT NULL,
    selector_context VARCHAR(50) NOT NULL,
    total_attempts INTEGER DEFAULT 0,
    total_successes INTEGER DEFAULT 0,
    total_failures INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0,
    last_success_at TIMESTAMP WITH TIME ZONE,
    last_failure_at TIMESTAMP WITH TIME ZONE,
    last_used_selector TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(selector_name, selector_context)
);

-- Index for health monitoring queries
CREATE INDEX IF NOT EXISTS idx_selector_health_context
ON selector_health_metrics(selector_context);

-- ============================================
-- Table: page_fingerprints
-- Stores DOM structure fingerprints for change detection
-- ============================================
CREATE TABLE IF NOT EXISTS page_fingerprints (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    page_type VARCHAR(50) NOT NULL,
    fingerprint_hash VARCHAR(64) NOT NULL,
    structure_data JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_current BOOLEAN DEFAULT TRUE,
    previous_hash VARCHAR(64),
    captured_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for current fingerprints
CREATE INDEX IF NOT EXISTS idx_page_fingerprints_current
ON page_fingerprints(page_type, is_current);

-- Index for version history
CREATE INDEX IF NOT EXISTS idx_page_fingerprints_history
ON page_fingerprints(page_type, version DESC);

-- ============================================
-- Table: vision_analysis_logs
-- Stores results from vision AI analysis
-- ============================================
CREATE TABLE IF NOT EXISTS vision_analysis_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    element_name VARCHAR(100) NOT NULL,
    page_context VARCHAR(50) NOT NULL,
    screenshot_path TEXT,
    provider VARCHAR(20), -- 'claude', 'openai'
    element_found BOOLEAN,
    confidence FLOAT,
    suggested_selectors JSONB,
    analysis_result JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for analysis queries
CREATE INDEX IF NOT EXISTS idx_vision_analysis_element
ON vision_analysis_logs(element_name, page_context);

-- Index for recent analyses
CREATE INDEX IF NOT EXISTS idx_vision_analysis_recent
ON vision_analysis_logs(created_at DESC);

-- ============================================
-- Table: recovery_failures
-- Stores failed recovery attempts for debugging
-- ============================================
CREATE TABLE IF NOT EXISTS recovery_failures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    selector_name VARCHAR(100) NOT NULL,
    selector_context VARCHAR(50) NOT NULL,
    phases_attempted TEXT[],
    duration_ms INTEGER,
    error_details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for failure analysis
CREATE INDEX IF NOT EXISTS idx_recovery_failures_selector
ON recovery_failures(selector_name, selector_context);

-- Index for recent failures
CREATE INDEX IF NOT EXISTS idx_recovery_failures_recent
ON recovery_failures(created_at DESC);

-- ============================================
-- Add columns to existing selector_registry if needed
-- ============================================
DO $$
BEGIN
    -- Add needs_rediscovery column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'selector_registry' AND column_name = 'needs_rediscovery'
    ) THEN
        ALTER TABLE selector_registry ADD COLUMN needs_rediscovery BOOLEAN DEFAULT FALSE;
    END IF;

    -- Add invalidated_at column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'selector_registry' AND column_name = 'invalidated_at'
    ) THEN
        ALTER TABLE selector_registry ADD COLUMN invalidated_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- ============================================
-- Create view for selector health dashboard
-- ============================================
CREATE OR REPLACE VIEW selector_health_dashboard AS
SELECT
    shm.selector_name,
    shm.selector_context,
    shm.total_attempts,
    shm.total_successes,
    shm.total_failures,
    shm.consecutive_failures,
    CASE
        WHEN shm.total_attempts = 0 THEN 100
        ELSE ROUND((shm.total_successes::NUMERIC / shm.total_attempts) * 100, 1)
    END AS success_rate,
    CASE
        WHEN shm.total_attempts = 0 THEN 'unknown'
        WHEN (shm.total_successes::NUMERIC / shm.total_attempts) > 0.7 THEN 'healthy'
        WHEN (shm.total_successes::NUMERIC / shm.total_attempts) > 0.5 THEN 'degraded'
        ELSE 'critical'
    END AS status,
    shm.last_success_at,
    shm.last_failure_at,
    shm.last_used_selector,
    sv.version AS current_version,
    sv.discovered_by AS current_discovered_by
FROM selector_health_metrics shm
LEFT JOIN selector_versions sv ON
    sv.selector_name = shm.selector_name AND
    sv.selector_context = shm.selector_context AND
    sv.is_active = TRUE;

-- ============================================
-- Grant permissions (adjust as needed for your setup)
-- ============================================
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO your_app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO your_app_user;

COMMENT ON TABLE selector_versions IS 'Version history of CSS selectors discovered by the self-healing system';
COMMENT ON TABLE selector_health_metrics IS 'Health metrics tracking success/failure rates for selectors';
COMMENT ON TABLE page_fingerprints IS 'DOM structure fingerprints for detecting Instagram layout changes';
COMMENT ON TABLE vision_analysis_logs IS 'Results from Claude/GPT-4V vision analysis for selector recovery';
COMMENT ON TABLE recovery_failures IS 'Failed recovery attempts for debugging and analysis';
