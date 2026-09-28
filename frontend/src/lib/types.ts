export type EmailStatus = 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface SenderSummary {
  id: string;
  name: string;
  email: string;
}

export interface Sender extends SenderSummary {
  smtpHost: string;
  createdAt: string;
  etherealLogin: string | null;
  sentThisHour?: number;
}

export interface SendersResponse {
  maxPerHour: number;
  items: Sender[];
}

export interface EmailListItem {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  error: string | null;
  attempts: number;
  rescheduleCount: number;
  previewUrl: string | null;
  campaignId: string;
  sender: SenderSummary;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SearchResponse {
  items: EmailListItem[];
  total: number;
  source: 'elasticsearch' | 'postgres';
}

export interface EmailDetail extends Omit<EmailListItem, 'sender'> {
  sequence: number;
  originalScheduledAt: string;
  messageId: string | null;
  createdAt: string;
  sender: SenderSummary;
  campaign: { id: string; startAt: string; delayMs: number; hourlyLimit: number; totalEmails: number };
}

export interface EmailStats {
  scheduled: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
  upcoming: number;
  delivered: number;
}

export interface ScheduleRequest {
  senderId: string;
  subject: string;
  body: string;
  recipients: string[];
  startAt?: string;
  delayMs: number;
  hourlyLimit?: number;
}

export interface ScheduleResponse {
  campaignId: string;
  scheduled: number;
  duplicatesRemoved: number;
  firstSendAt: string;
  lastSendAt: string;
  hourlyLimit: number;
  replayed: boolean;
}

export interface SlackStatus {
  configured: boolean;
  connected: boolean;
  teamName: string | null;
  channelName: string | null;
  connectedAt: string | null;
}

export interface Providers {
  /** Some Google sign-in flow is available. */
  google: boolean;
  /** Server-side authorization-code flow (server holds the client secret). */
  googleRedirect: boolean;
  /** Public client id for the Google Identity Services (ID token) flow. */
  googleClientId: string | null;
  slack: boolean;
}
