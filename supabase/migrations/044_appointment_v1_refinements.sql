-- ============================================================
-- 044_appointment_v1_refinements.sql — Appointment & Calendar V1 Refinements
--
-- Production foundations:
--   1. Explicit rescheduling columns on appointments (rescheduled_at, reschedule_reason)
--   2. Dedicated appointment_busy_periods table (separates external busy time from appointments)
--   3. Dedicated appointment_calendar_links table (clean, provider-neutral sync mapping)
--   4. Atomic rescheduling RPC function (reschedule_appointment_atomic)
--   5. Upgraded atomic booking RPC with "Any Provider" atomic assignment & service eligibility verification
--   6. Multi-tenant RLS policies
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. APPOINTMENTS TABLE REFINEMENTS
-- ============================================================
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reschedule_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_appointments_rescheduled_links
  ON appointments(rescheduled_from_id, rescheduled_to_id);

-- ============================================================
-- 2. APPOINTMENT BUSY PERIODS (External meetings, personal time, blocked shifts)
-- Separates non-appointment provider busy intervals from real customer appointments.
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_busy_periods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES appointment_staff(id) ON DELETE CASCADE,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL CHECK (end_at > start_at),
  title TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'external_calendar', 'internal')),
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_busy_periods_lookup
  ON appointment_busy_periods(account_id, staff_id, start_at, end_at);

ALTER TABLE appointment_busy_periods ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_appointment_busy_periods ON appointment_busy_periods;
CREATE TRIGGER set_updated_at_appointment_busy_periods
  BEFORE UPDATE ON appointment_busy_periods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 3. APPOINTMENT CALENDAR LINKS (Clean, provider-neutral two-way sync links)
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_calendar_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
  external_calendar_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'not_synced' CHECK (sync_status IN ('not_synced', 'synced', 'failed', 'pending')),
  last_synced_at TIMESTAMPTZ,
  sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_appointment_calendar_provider UNIQUE(appointment_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_appointment_calendar_links_lookup
  ON appointment_calendar_links(account_id, appointment_id, provider);

ALTER TABLE appointment_calendar_links ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_appointment_calendar_links ON appointment_calendar_links;
CREATE TRIGGER set_updated_at_appointment_calendar_links
  BEFORE UPDATE ON appointment_calendar_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 4. RLS POLICIES FOR NEW TABLES
-- ============================================================

-- ---- appointment_busy_periods -------------------------------
DROP POLICY IF EXISTS appointment_busy_periods_select ON appointment_busy_periods;
DROP POLICY IF EXISTS appointment_busy_periods_insert ON appointment_busy_periods;
DROP POLICY IF EXISTS appointment_busy_periods_update ON appointment_busy_periods;
DROP POLICY IF EXISTS appointment_busy_periods_delete ON appointment_busy_periods;

CREATE POLICY appointment_busy_periods_select ON appointment_busy_periods
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY appointment_busy_periods_insert ON appointment_busy_periods
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY appointment_busy_periods_update ON appointment_busy_periods
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY appointment_busy_periods_delete ON appointment_busy_periods
  FOR DELETE USING (is_account_member(account_id, 'agent'));

-- ---- appointment_calendar_links -----------------------------
DROP POLICY IF EXISTS appointment_calendar_links_select ON appointment_calendar_links;
DROP POLICY IF EXISTS appointment_calendar_links_insert ON appointment_calendar_links;
DROP POLICY IF EXISTS appointment_calendar_links_update ON appointment_calendar_links;
DROP POLICY IF EXISTS appointment_calendar_links_delete ON appointment_calendar_links;

CREATE POLICY appointment_calendar_links_select ON appointment_calendar_links
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY appointment_calendar_links_insert ON appointment_calendar_links
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY appointment_calendar_links_update ON appointment_calendar_links
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY appointment_calendar_links_delete ON appointment_calendar_links
  FOR DELETE USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- 5. UPGRADED ATOMIC BOOKING FUNCTION (RPC)
-- Supports specific staff or atomic "Any Provider" assignment + service eligibility verification.
-- ============================================================
CREATE OR REPLACE FUNCTION book_appointment_atomic(
  p_account_id UUID,
  p_service_id UUID,
  p_staff_id UUID,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_timezone TEXT DEFAULT 'Asia/Kolkata',
  p_contact_id UUID DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_source TEXT DEFAULT 'dashboard',
  p_status TEXT DEFAULT 'confirmed',
  p_created_by UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service_active BOOLEAN;
  v_staff_id UUID := p_staff_id;
  v_has_service_mappings BOOLEAN;
  v_is_staff_mapped BOOLEAN;
  v_staff_active BOOLEAN;
  v_conflict_count INTEGER;
  v_appointment RECORD;
  v_candidate RECORD;
BEGIN
  -- 1. Verify service exists and is active
  SELECT is_active INTO v_service_active
  FROM appointment_services
  WHERE id = p_service_id AND account_id = p_account_id;

  IF v_service_active IS NULL OR NOT v_service_active THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SERVICE_NOT_FOUND_OR_INACTIVE');
  END IF;

  -- Check if explicit staff-service mappings exist for this service
  SELECT EXISTS (
    SELECT 1 FROM appointment_staff_services WHERE service_id = p_service_id
  ) INTO v_has_service_mappings;

  -- 2. Handle "Any Provider" vs Specific Provider
  IF v_staff_id IS NULL THEN
    -- Find an eligible active staff member with no conflicting appointments or busy periods
    FOR v_candidate IN
      SELECT s.id
      FROM appointment_staff s
      WHERE s.account_id = p_account_id
        AND s.is_active = true
        AND (
          NOT v_has_service_mappings
          OR EXISTS (
            SELECT 1 FROM appointment_staff_services ss
            WHERE ss.staff_id = s.id AND ss.service_id = p_service_id
          )
        )
      ORDER BY s.name ASC
    LOOP
      -- Try to lock this candidate staff row
      PERFORM 1 FROM appointment_staff WHERE id = v_candidate.id FOR UPDATE;

      -- Check appointment conflicts
      SELECT COUNT(*) INTO v_conflict_count
      FROM appointments
      WHERE staff_id = v_candidate.id
        AND status IN ('pending', 'confirmed')
        AND tstzrange(start_at, end_at) && tstzrange(p_start_at, p_end_at);

      IF v_conflict_count = 0 THEN
        -- Also check busy periods
        SELECT COUNT(*) INTO v_conflict_count
        FROM appointment_busy_periods
        WHERE staff_id = v_candidate.id
          AND tstzrange(start_at, end_at) && tstzrange(p_start_at, p_end_at);
      END IF;

      IF v_conflict_count = 0 THEN
        v_staff_id := v_candidate.id;
        EXIT;
      END IF;
    END LOOP;

    IF v_staff_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SLOT_ALREADY_BOOKED');
    END IF;
  ELSE
    -- Specific staff requested: verify staff exists, is active, and is locked
    SELECT is_active INTO v_staff_active
    FROM appointment_staff
    WHERE id = v_staff_id AND account_id = p_account_id
    FOR UPDATE;

    IF v_staff_active IS NULL OR NOT v_staff_active THEN
      RETURN jsonb_build_object('ok', false, 'error', 'STAFF_NOT_FOUND_OR_INACTIVE');
    END IF;

    -- Verify staff eligibility for this service if mappings exist
    IF v_has_service_mappings THEN
      SELECT EXISTS (
        SELECT 1 FROM appointment_staff_services
        WHERE staff_id = v_staff_id AND service_id = p_service_id
      ) INTO v_is_staff_mapped;

      IF NOT v_is_staff_mapped THEN
        RETURN jsonb_build_object('ok', false, 'error', 'STAFF_NOT_ELIGIBLE_FOR_SERVICE');
      END IF;
    END IF;

    -- Check for conflicts against active appointments
    SELECT COUNT(*) INTO v_conflict_count
    FROM appointments
    WHERE staff_id = v_staff_id
      AND status IN ('pending', 'confirmed')
      AND tstzrange(start_at, end_at) && tstzrange(p_start_at, p_end_at);

    IF v_conflict_count > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SLOT_ALREADY_BOOKED');
    END IF;

    -- Check for conflicts against busy periods
    SELECT COUNT(*) INTO v_conflict_count
    FROM appointment_busy_periods
    WHERE staff_id = v_staff_id
      AND tstzrange(start_at, end_at) && tstzrange(p_start_at, p_end_at);

    IF v_conflict_count > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SLOT_ALREADY_BOOKED');
    END IF;
  END IF;

  -- 3. Insert appointment
  INSERT INTO appointments (
    account_id,
    contact_id,
    conversation_id,
    service_id,
    staff_id,
    start_at,
    end_at,
    timezone,
    status,
    source,
    customer_name,
    customer_phone,
    notes,
    created_by
  ) VALUES (
    p_account_id,
    p_contact_id,
    p_conversation_id,
    p_service_id,
    v_staff_id,
    p_start_at,
    p_end_at,
    COALESCE(p_timezone, 'Asia/Kolkata'),
    COALESCE(p_status, 'confirmed'),
    COALESCE(p_source, 'dashboard'),
    p_customer_name,
    p_customer_phone,
    p_notes,
    p_created_by
  )
  RETURNING * INTO v_appointment;

  RETURN jsonb_build_object(
    'ok', true,
    'appointment', to_jsonb(v_appointment)
  );
END;
$$;

ALTER FUNCTION book_appointment_atomic OWNER TO postgres;
GRANT EXECUTE ON FUNCTION book_appointment_atomic TO authenticated, service_role;

-- ============================================================
-- 6. ATOMIC RESCHEDULING FUNCTION (RPC)
-- Verifies availability, creates new appointment, and links old appointment atomically.
-- ============================================================
CREATE OR REPLACE FUNCTION reschedule_appointment_atomic(
  p_account_id UUID,
  p_appointment_id UUID,
  p_new_start_at TIMESTAMPTZ,
  p_new_end_at TIMESTAMPTZ,
  p_staff_id UUID DEFAULT NULL,
  p_reschedule_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old RECORD;
  v_target_staff_id UUID;
  v_conflict_count INTEGER;
  v_new_appointment RECORD;
  v_has_service_mappings BOOLEAN;
  v_candidate RECORD;
BEGIN
  -- 1. Fetch old appointment
  SELECT * INTO v_old
  FROM appointments
  WHERE id = p_appointment_id AND account_id = p_account_id;

  IF v_old IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'APPOINTMENT_NOT_FOUND');
  END IF;

  IF v_old.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'APPOINTMENT_NOT_RESCHEDULABLE',
      'detail', 'Only pending or confirmed appointments can be rescheduled'
    );
  END IF;

  v_target_staff_id := COALESCE(p_staff_id, v_old.staff_id);

  IF v_target_staff_id IS NULL THEN
    -- If no target staff specified or previously assigned, allocate an eligible active staff member
    SELECT EXISTS (
      SELECT 1 FROM appointment_staff_services WHERE service_id = v_old.service_id
    ) INTO v_has_service_mappings;

    FOR v_candidate IN
      SELECT s.id
      FROM appointment_staff s
      WHERE s.account_id = p_account_id
        AND s.is_active = true
        AND (
          NOT v_has_service_mappings
          OR EXISTS (
            SELECT 1 FROM appointment_staff_services ss
            WHERE ss.staff_id = s.id AND ss.service_id = v_old.service_id
          )
        )
      ORDER BY s.name ASC
    LOOP
      PERFORM 1 FROM appointment_staff WHERE id = v_candidate.id FOR UPDATE;

      SELECT COUNT(*) INTO v_conflict_count
      FROM appointments
      WHERE staff_id = v_candidate.id
        AND id != p_appointment_id
        AND status IN ('pending', 'confirmed')
        AND tstzrange(start_at, end_at) && tstzrange(p_new_start_at, p_new_end_at);

      IF v_conflict_count = 0 THEN
        SELECT COUNT(*) INTO v_conflict_count
        FROM appointment_busy_periods
        WHERE staff_id = v_candidate.id
          AND tstzrange(start_at, end_at) && tstzrange(p_new_start_at, p_new_end_at);
      END IF;

      IF v_conflict_count = 0 THEN
        v_target_staff_id := v_candidate.id;
        EXIT;
      END IF;
    END LOOP;

    IF v_target_staff_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SLOT_ALREADY_BOOKED');
    END IF;
  ELSE
    -- Specific target staff: lock and verify
    PERFORM 1
    FROM appointment_staff
    WHERE id = v_target_staff_id AND account_id = p_account_id AND is_active = true
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'STAFF_NOT_FOUND_OR_INACTIVE');
    END IF;

    -- Check for conflict on new slot (excluding current old appointment)
    SELECT COUNT(*) INTO v_conflict_count
    FROM appointments
    WHERE staff_id = v_target_staff_id
      AND id != p_appointment_id
      AND status IN ('pending', 'confirmed')
      AND tstzrange(start_at, end_at) && tstzrange(p_new_start_at, p_new_end_at);

    IF v_conflict_count > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SLOT_ALREADY_BOOKED');
    END IF;

    -- Check conflict on busy periods
    SELECT COUNT(*) INTO v_conflict_count
    FROM appointment_busy_periods
    WHERE staff_id = v_target_staff_id
      AND tstzrange(start_at, end_at) && tstzrange(p_new_start_at, p_new_end_at);

    IF v_conflict_count > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SLOT_ALREADY_BOOKED');
    END IF;
  END IF;

  -- 4. Insert new appointment linked to old
  INSERT INTO appointments (
    account_id,
    contact_id,
    conversation_id,
    service_id,
    staff_id,
    start_at,
    end_at,
    timezone,
    status,
    source,
    customer_name,
    customer_phone,
    notes,
    rescheduled_from_id,
    created_by
  ) VALUES (
    p_account_id,
    v_old.contact_id,
    v_old.conversation_id,
    v_old.service_id,
    v_target_staff_id,
    p_new_start_at,
    p_new_end_at,
    v_old.timezone,
    'confirmed',
    v_old.source,
    v_old.customer_name,
    v_old.customer_phone,
    v_old.notes,
    p_appointment_id,
    v_old.created_by
  )
  RETURNING * INTO v_new_appointment;

  -- 5. Mark old appointment as rescheduled with explicit rescheduling timestamps
  UPDATE appointments
  SET
    status = 'rescheduled',
    rescheduled_to_id = v_new_appointment.id,
    rescheduled_at = NOW(),
    reschedule_reason = p_reschedule_reason
  WHERE id = p_appointment_id AND account_id = p_account_id;

  RETURN jsonb_build_object(
    'ok', true,
    'appointment', to_jsonb(v_new_appointment)
  );
END;
$$;

ALTER FUNCTION reschedule_appointment_atomic OWNER TO postgres;
GRANT EXECUTE ON FUNCTION reschedule_appointment_atomic TO authenticated, service_role;
