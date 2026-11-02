CREATE TABLE IF NOT EXISTS progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE cascade,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE cascade,
  last_test_id uuid REFERENCES tests(id) ON DELETE set null,
  status text DEFAULT 'not_started' NOT NULL,
  completion_percent integer DEFAULT 0 NOT NULL,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT progress_user_course_unique UNIQUE (user_id, course_id)
);
