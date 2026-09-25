-- ============================================================
-- 043_appointments.sql — Core WACRM Appointment / Calendar Engine
--
-- Adds the complete appointment booking architecture:
--   - Services (appointment_services)
--   - Staff / Providers (appointment_staff)
--   - Staff ↔ Service mapping (appointment_staff_services)
--   - Working hours / Weekly availability (appointment_availability)
--   - Holidays / Off-days / Exceptions (appointment_availability_exceptions)
--   - Appointments with double-booking prevention (appointments)
--   - Atomic booking function (book_appointment_atomic)
--   - Multi-tenant RLS policies scoped to account_id
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Enable btree_gist extension for PostgreSQL exclusion constraints (prevents double bookings)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================
-- 1. APPOINTMENT SERVICES
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  price NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_services_account ON appointment_services(account_id, is_active);

ALTER TABLE appointment_services ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_appointment_services ON appointment_services;
CREATE TRIGGER set_updated_at_appointment_services
  BEFORE UPDATE ON appointment_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. APPOINTMENT STAFF
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_staff (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_staff_account ON appointment_staff(account_id, is_active);

ALTER TABLE appointment_staff ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_appointment_staff ON appointment_staff;
CREATE TRIGGER set_updated_at_appointment_staff
  BEFORE UPDATE ON appointment_staff
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 3. STAFF ↔ SERVICE RELATIONSHIP
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_staff_services (
  staff_id UUID NOT NULL REFERENCES appointment_staff(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES appointment_services(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (staff_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_appointment_staff_services_service ON appointment_staff_services(service_id);

ALTER TABLE appointment_staff_services ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. APPOINTMENT AVAILABILITY (Working Hours)
-- Multiple intervals per day supported to allow lunch breaks.
-- day_of_week: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_availability (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES appointment_staff(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL CHECK (end_time > start_time),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_availability_lookup
  ON appointment_availability(account_id, staff_id, day_of_week);

ALTER TABLE appointment_availability ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_appointment_availability ON appointment_availability;
CREATE TRIGGER set_updated_at_appointment_availability
  BEFORE UPDATE ON appointment_availability
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 5. APPOINTMENT AVAILABILITY EXCEPTIONS (Holidays, Vacations, Modified Hours)
-- staff_id is nullable: NULL applies to entire account (e.g. Clinic Holiday)
-- ============================================================
CREATE TABLE IF NOT EXISTS appointment_availability_exceptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES appointment_staff(id) ON DELETE CASCADE,
  exception_date DATE NOT NULL,
  is_unavailable BOOLEAN NOT NULL DEFAULT true,
  start_time TIME,
  end_time TIME,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_exceptions_lookup
  ON appointment_availability_exceptions(account_id, staff_id, exception_date);

ALTER TABLE appointment_availability_exceptions ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_appointment_exceptions ON appointment_availability_exceptions;
CREATE TRIGGER set_updated_at_appointment_exceptions
  BEFORE UPDATE ON appointment_availability_exceptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 6. APPOINTMENTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  service_id UUID NOT NULL REFERENCES appointment_services(id) ON DELETE RESTRICT,
  staff_id UUID NOT NULL REFERENCES appointment_staff(id) ON DELETE RESTRICT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL CHECK (end_at > start_at),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled')),
  source TEXT NOT NULL DEFAULT 'dashboard'
    CHECK (source IN ('dashboard', 'whatsapp_flow', 'whatsapp_ai', 'api', 'manual')),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  notes TEXT,
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT,
  rescheduled_from_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  rescheduled_to_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  reminder_sent_24h BOOLEAN NOT NULL DEFAULT false,
  reminder_sent_2h BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_account_start ON appointments(account_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_staff_start ON appointments(staff_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id);
CREATE INDEX IF NOT EXISTS idx_appointments_conversation ON appointments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_reminders ON appointments(status, reminder_sent_24h, reminder_sent_2h, start_at);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_appointments ON appointments;
CREATE TRIGGER set_updated_at_appointments
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Prevent double bookings at database level via Postgres EXCLUSION CONSTRAINT
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'no_overlapping_staff_appointments'
  ) THEN
    ALTER TABLE appointments
    ADD CONSTRAINT no_overlapping_staff_appointments
    EXCLUDE USING gist (
      staff_id WITH =,
      tstzrange(start_at, end_at) WITH &&
    )
    WHERE (status IN ('pending', 'confirmed'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not create gist exclusion constraint (extension might be restricted in some environments): %', SQLERRM;
END $$;

-- ============================================================
-- 7. ATOMIC BOOKING FUNCTION (RPC)
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
  v_staff_active BOOLEAN;
  v_service_active BOOLEAN;
  v_conflict_count INTEGER;
  v_appointment_id UUID;
  v_appointment RECORD;
BEGIN
  -- 1. Verify service exists and is active
  SELECT is_active INTO v_service_active
  FROM appointment_services
  WHERE id = p_service_id AND account_id = p_account_id;

  IF v_service_active IS NULL OR NOT v_service_active THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SERVICE_NOT_FOUND_OR_INACTIVE');
  END IF;

  -- 2. Verify staff exists and is active, locking staff row
  SELECT is_active INTO v_staff_active
  FROM appointment_staff
  WHERE id = p_staff_id AND account_id = p_account_id
  FOR UPDATE;

  IF v_staff_active IS NULL OR NOT v_staff_active THEN
    RETURN jsonb_build_object('ok', false, 'error', 'STAFF_NOT_FOUND_OR_INACTIVE');
  END IF;

  -- 3. Check for conflicting active appointments
  SELECT COUNT(*) INTO v_conflict_count
  FROM appointments
  WHERE staff_id = p_staff_id
    AND status IN ('pending', 'confirmed')
    AND tstzrange(start_at, end_at) && tstzrange(p_start_at, p_end_at);

  IF v_conflict_count > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SLOT_ALREADY_BOOKED');
  END IF;

  -- 4. Insert appointment
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
    p_staff_id,
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
-- 8. ROW LEVEL SECURITY POLICIES
-- ============================================================

-- Drop old policies if any exist
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'appointment_services',
        'appointment_staff',
        'appointment_staff_services',
        'appointment_availability',
        'appointment_availability_exceptions',
        'appointments'
      ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- ---- appointment_services ---------------------------------------
CREATE POLICY appointment_services_select ON appointment_services
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY appointment_services_insert ON appointment_services
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_services_update ON appointment_services
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_services_delete ON appointment_services
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- appointment_staff ------------------------------------------
CREATE POLICY appointment_staff_select ON appointment_staff
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY appointment_staff_insert ON appointment_staff
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_staff_update ON appointment_staff
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_staff_delete ON appointment_staff
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- appointment_staff_services ---------------------------------
CREATE POLICY appointment_staff_services_select ON appointment_staff_services
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM appointment_staff s
      WHERE s.id = appointment_staff_services.staff_id
        AND is_account_member(s.account_id)
    )
  );
CREATE POLICY appointment_staff_services_insert ON appointment_staff_services
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM appointment_staff s
      WHERE s.id = appointment_staff_services.staff_id
        AND is_account_member(s.account_id, 'admin')
    )
  );
CREATE POLICY appointment_staff_services_delete ON appointment_staff_services
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM appointment_staff s
      WHERE s.id = appointment_staff_services.staff_id
        AND is_account_member(s.account_id, 'admin')
    )
  );

-- ---- appointment_availability ----------------------------------
CREATE POLICY appointment_availability_select ON appointment_availability
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY appointment_availability_insert ON appointment_availability
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_availability_update ON appointment_availability
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_availability_delete ON appointment_availability
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- appointment_availability_exceptions -----------------------
CREATE POLICY appointment_exceptions_select ON appointment_availability_exceptions
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY appointment_exceptions_insert ON appointment_availability_exceptions
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_exceptions_update ON appointment_availability_exceptions
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY appointment_exceptions_delete ON appointment_availability_exceptions
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- appointments ----------------------------------------------
CREATE POLICY appointments_select ON appointments
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY appointments_insert ON appointments
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY appointments_update ON appointments
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY appointments_delete ON appointments
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 9. FLOW NODES — widen node_type CHECK to allow 'book_appointment'
-- ============================================================
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end',
    'book_appointment'
  ));

