export type WorkflowStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type UserRole =
  | "proposer"
  | "leader"
  | "drafter"
  | "reviewer"
  | "admin"
  | "master_admin"
  | "module_manager"
  | "user";

export type DocumentStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "rejected"
  | "archived";

export interface MeUser {
  id: number;
  email: string;
  fullname?: string;
  role: string | string[];
  unit?: string;
}

export interface DocumentRecord {
  id: number;
  title: string;
  doc_type: string;
  reason?: string | null;
  proposal_summary?: string | null;
  proposer_id?: number | null;
  proposer_unit?: string | null;
  current_step: WorkflowStep;
  status: DocumentStatus | string;
  assigned_unit_id?: number | null;
  assigned_to_id?: number | null;
  assignment_deadline?: string | null;
  legal_basis?: string | null;
  scope?: string | null;
  applicable_subjects?: string | null;
  main_content?: string | null;
  execution_clause?: string | null;
  review_comment?: string | null;
  review_result?: string | null;
  review_at?: string | null;
  feedback_summary?: string | null;
  explain_receive?: string | null;
  submit_note?: string | null;
  signed_confirmed?: number | null;
  publish_date?: string | null;
  document_number?: string | null;
  archived_at?: string | null;
  expire_date?: string | null;
  remind_after_days?: number | null;
  deleted_at?: string | null;
  created_at?: string;
}

export interface Unit {
  id: number;
  code?: string;
  name: string;
  active?: number;
}

export interface Attachment {
  id: number;
  step: number;
  category?: string | null;
  original_name: string;
  file_path?: string;
  created_at?: string;
}

export interface FeedbackItem {
  id: number;
  author_id?: number;
  content: string;
  created_at?: string;
}

export interface HistoryItem {
  id: number;
  step: number;
  action: string;
  note?: string | null;
  actor_name?: string | null;
  created_at?: string;
}

export interface DocumentDetail extends DocumentRecord {
  attachments: Attachment[];
  feedback: FeedbackItem[];
  history: HistoryItem[];
}

export interface AdminStats {
  usersCount: number;
  processingCount: number;
  overdueCount: number;
  byMonth: Array<{ month: string; count: number }>;
  byType: Array<{ doc_type: string; count: number }>;
}

export interface AuditLogItem {
  id: number;
  user_id?: number | null;
  action: string;
  target_type?: string | null;
  target_id?: number | null;
  old_value?: string | null;
  new_value?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: string;
  user_email?: string | null;
  user_fullname?: string | null;
}
