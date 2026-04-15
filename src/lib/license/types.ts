export type LicenseStatus = "active" | "paused" | "expired" | "revoked";

export interface LicenseKeyRow {
  id: string;
  key_string: string;
  is_admin?: boolean;
  status: LicenseStatus;
  device_id: string | null;
  valid_until: string;
  user_name: string | null;
  user_phone: string | null;
  user_email: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at?: string;
}

export interface LicenseSessionPayload {
  licenseId: string;
  keyString: string;
  deviceId: string;
  isAdmin: boolean;
  issuedAt: number;
}

export interface LicenseSessionView {
  id: string;
  keyString: string;
  status: LicenseStatus;
  isAdmin: boolean;
  validUntil: string;
  remainingMs: number;
  deviceId: string;
  userName: string | null;
  userPhone: string | null;
  userEmail: string | null;
  adminNotes: string | null;
}

export interface LicenseSummary {
  totalActive: number;
  expiringSoon: number;
  totalPaused: number;
  totalDevicesConnected: number;
}
